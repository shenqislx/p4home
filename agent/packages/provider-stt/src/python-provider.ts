import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  STT_CHANNELS,
  STT_MAX_PCM_BYTES,
  STT_MODEL_REVISION,
  STT_PROVIDER_VERSION,
  STT_SAMPLE_BITS,
  STT_SAMPLE_RATE_HZ,
  SttProviderError,
  type SttFinalTranscript,
  type SttProvider,
  type SttTranscriptionOptions,
  type SttTranscriptionRequest,
} from "./types.ts";

const MAX_WORKER_OUTPUT_BYTES = 16 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MODEL_REVISION = /^[0-9a-f]{40}$/;

export interface PythonSttProviderOptions {
  readonly python_executable: string;
  readonly worker_script: string;
  readonly model_path: string;
  readonly model_revision: string;
  readonly provider_version: typeof STT_PROVIDER_VERSION;
  readonly timeout_ms?: number;
  readonly spawn_process?: typeof spawn;
}

interface WorkerResponse {
  readonly schema_version: 1;
  readonly status: "completed" | "error";
  readonly session_id?: unknown;
  readonly stream_id?: unknown;
  readonly epoch?: unknown;
  readonly text?: unknown;
  readonly language?: unknown;
  readonly duration_ms?: unknown;
  readonly python_version?: unknown;
  readonly error_code?: unknown;
}

function assertSafeIdentity(request: SttTranscriptionRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.session_id)) {
    throw new TypeError("STT session_id is invalid");
  }
  if (!Number.isInteger(request.stream_id) || request.stream_id < 0 || request.stream_id > 0xffff_ffff
      || !Number.isInteger(request.epoch) || request.epoch < 0 || request.epoch > 0xffff_ffff) {
    throw new TypeError("STT stream_id and epoch must be uint32 values");
  }
}

function validateRequest(request: SttTranscriptionRequest): void {
  assertSafeIdentity(request);
  if (
    request.sample_rate_hz !== STT_SAMPLE_RATE_HZ
    || request.channels !== STT_CHANNELS
    || request.sample_bits !== STT_SAMPLE_BITS
    || request.language !== "zh"
  ) {
    throw new TypeError("STT request must use frozen 16 kHz mono PCM16 zh geometry");
  }
  if (
    !(request.pcm instanceof Uint8Array)
    || request.pcm.byteLength === 0
    || request.pcm.byteLength > STT_MAX_PCM_BYTES
    || request.pcm.byteLength % 2 !== 0
  ) {
    throw new TypeError("STT PCM must be non-empty, even-sized and bounded");
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, "utf8") + chunk.byteLength > MAX_WORKER_OUTPUT_BYTES) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker output exceeded 16 KiB");
  }
  return current + chunk.toString("utf8");
}

function validateWorkerResponse(value: unknown, request: SttTranscriptionRequest): SttFinalTranscript {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker response must be an object");
  }
  const response = value as WorkerResponse;
  if (response.status === "error") {
    const code = response.error_code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROCESS_ERROR";
    throw new SttProviderError(code, "STT worker reported a bounded provider error", {
      retryable: code === "PROCESS_ERROR",
    });
  }
  if (
    response.schema_version !== 1
    || response.status !== "completed"
    || response.session_id !== request.session_id
    || response.stream_id !== request.stream_id
    || response.epoch !== request.epoch
    || response.language !== "zh"
    || typeof response.text !== "string"
    || response.text.length > 1_024
    || typeof response.duration_ms !== "number"
    || !Number.isFinite(response.duration_ms)
    || response.duration_ms < 0
    || response.duration_ms > MAX_TIMEOUT_MS
    || typeof response.python_version !== "string"
    || !response.python_version.startsWith("3.12.")
  ) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker response violates the frozen contract");
  }
  return {
    schema_version: 1,
    kind: "final",
    session_id: request.session_id,
    stream_id: request.stream_id,
    epoch: request.epoch,
    text: response.text,
    language: "zh",
    duration_ms: response.duration_ms,
  };
}

export class PythonSttProvider implements SttProvider {
  readonly #options: PythonSttProviderOptions;
  readonly #timeoutMs: number;

  public constructor(options: PythonSttProviderOptions) {
    if (!isAbsolute(options.python_executable) || !isAbsolute(options.worker_script)
        || !isAbsolute(options.model_path)) {
      throw new TypeError("STT Python executable, worker and model paths must be absolute");
    }
    if (!MODEL_REVISION.test(options.model_revision)
        || options.model_revision !== STT_MODEL_REVISION
        || options.provider_version !== STT_PROVIDER_VERSION) {
      throw new TypeError("STT provider version and model revision must be pinned");
    }
    const timeoutMs = options.timeout_ms ?? 45_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError("STT timeout must be an integer between 1000 and 120000 ms");
    }
    this.#options = { ...options };
    this.#timeoutMs = timeoutMs;
  }

  public async transcribe(
    request: SttTranscriptionRequest,
    options: SttTranscriptionOptions = {},
  ): Promise<SttFinalTranscript> {
    validateRequest(request);
    if (options.signal?.aborted === true) {
      throw new SttProviderError("CANCELLED", "STT request was cancelled");
    }
    const spawnProcess = this.#options.spawn_process ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(
        this.#options.python_executable,
        ["-I", "-u", this.#options.worker_script, "--model", this.#options.model_path],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            P4HOME_STT_PROVIDER_VERSION: this.#options.provider_version,
            P4HOME_STT_MODEL_REVISION: this.#options.model_revision,
            PYTHONNOUSERSITE: "1",
          },
        },
      );
    } catch (error) {
      throw new SttProviderError("PROCESS_ERROR", "failed to start STT worker", {
        retryable: true,
        cause: error,
      });
    }

    return await new Promise<SttFinalTranscript>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const fail = (error: SttProviderError): void => finish(() => {
        if (!child.killed) child.kill("SIGKILL");
        reject(error);
      });
      const onAbort = (): void => fail(new SttProviderError("CANCELLED", "STT request was cancelled"));
      const timer = setTimeout(() => {
        fail(new SttProviderError("TIMEOUT", "STT request exceeded its deadline", { retryable: true }));
      }, this.#timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
      }
      child.stdout.on("data", (chunk: Buffer) => {
        try { stdout = appendBounded(stdout, chunk); } catch (error) {
          fail(error as SttProviderError);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try { stderr = appendBounded(stderr, chunk); } catch (error) {
          fail(error as SttProviderError);
        }
      });
      child.stdin.on("error", (error) => fail(new SttProviderError(
        "PROCESS_ERROR", "failed to send the bounded STT request", { retryable: true, cause: error },
      )));
      child.on("error", (error) => fail(new SttProviderError(
        "PROCESS_ERROR", "STT worker process failed", { retryable: true, cause: error },
      )));
      child.on("close", (code) => {
        if (settled) return;
        try {
          const lines = stdout.trim().split("\n");
          if (lines.length !== 1) throw new Error("worker must emit exactly one JSON line");
          const result = validateWorkerResponse(JSON.parse(lines[0] as string), request);
          if (code !== 0) {
            fail(new SttProviderError(
              "PROCESS_ERROR",
              stderr.length === 0
                ? "STT worker exited unsuccessfully"
                : "STT worker emitted a bounded error",
              { retryable: true },
            ));
            return;
          }
          finish(() => resolve(result));
        } catch (error) {
          if (error instanceof SttProviderError) {
            fail(error);
            return;
          }
          fail(new SttProviderError(
            code === 0 ? "INVALID_RESPONSE" : "PROCESS_ERROR",
            code === 0 ? "STT worker returned invalid JSON" : "STT worker exited unsuccessfully",
            { retryable: code !== 0, cause: error },
          ));
        }
      });
      try {
        child.stdin.end(`${JSON.stringify({
          schema_version: 1,
          session_id: request.session_id,
          stream_id: request.stream_id,
          epoch: request.epoch,
          sample_rate_hz: request.sample_rate_hz,
          channels: request.channels,
          sample_bits: request.sample_bits,
          language: request.language,
          pcm_base64: Buffer.from(request.pcm).toString("base64"),
        })}\n`);
      } catch (error) {
        fail(new SttProviderError(
          "PROCESS_ERROR", "failed to send the bounded STT request", { retryable: true, cause: error },
        ));
      }
    });
  }
}

export const pythonSttProviderInternals = { validateRequest, validateWorkerResponse };
