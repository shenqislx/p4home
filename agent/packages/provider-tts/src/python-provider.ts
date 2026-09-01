import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  TTS_CHANNELS,
  TTS_MAX_PCM_BYTES,
  TTS_MAX_TEXT_CHARS,
  TTS_MODEL_REVISION,
  TTS_PROVIDER_VERSION,
  TTS_ROLE_VOICES,
  TTS_SAMPLE_BITS,
  TTS_SAMPLE_RATE_HZ,
  TtsProviderError,
  type TtsSynthesisOptions,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "./types.ts";

const MAX_WORKER_OUTPUT_BYTES = 3 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MODEL_REVISION = /^[0-9a-f]{40}$/;
const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface PythonTtsProviderOptions {
  readonly python_executable: string;
  readonly worker_script: string;
  readonly model_path: string;
  readonly model_revision: string;
  readonly provider_version: typeof TTS_PROVIDER_VERSION;
  readonly timeout_ms?: number;
  readonly spawn_process?: typeof spawn;
}

interface WorkerResponse {
  readonly schema_version?: unknown;
  readonly status?: unknown;
  readonly interaction_id?: unknown;
  readonly assignment_id?: unknown;
  readonly segment_index?: unknown;
  readonly role_id?: unknown;
  readonly voice?: unknown;
  readonly pcm_base64?: unknown;
  readonly sample_rate_hz?: unknown;
  readonly channels?: unknown;
  readonly sample_bits?: unknown;
  readonly samples?: unknown;
  readonly duration_ms?: unknown;
  readonly python_version?: unknown;
  readonly error_code?: unknown;
}

function validateRequest(request: TtsSynthesisRequest): void {
  if (!CONTRACT_ID.test(request.interaction_id) || !CONTRACT_ID.test(request.assignment_id)) {
    throw new TypeError("TTS interaction and assignment ids are invalid");
  }
  if (!Number.isInteger(request.segment_index) || request.segment_index < 0 || request.segment_index > 63) {
    throw new TypeError("TTS segment_index must be an integer between 0 and 63");
  }
  if (request.role_id !== "human" && request.role_id !== "robot") {
    throw new TypeError("TTS role_id is invalid");
  }
  if (request.voice !== TTS_ROLE_VOICES[request.role_id]) {
    throw new TypeError("TTS voice must match the frozen role voice");
  }
  if (request.language !== "zh" || request.sample_rate_hz !== TTS_SAMPLE_RATE_HZ
      || request.channels !== TTS_CHANNELS || request.sample_bits !== TTS_SAMPLE_BITS) {
    throw new TypeError("TTS request must use frozen zh 16 kHz mono PCM16 geometry");
  }
  if (typeof request.text !== "string" || request.text.trim() !== request.text
      || request.text.length === 0 || request.text.length > TTS_MAX_TEXT_CHARS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(request.text)) {
    throw new TypeError("TTS text must be non-empty, trimmed, bounded and free of controls");
  }
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, "utf8") + chunk.byteLength > MAX_WORKER_OUTPUT_BYTES) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker output exceeded 3 MiB");
  }
  return current + chunk.toString("utf8");
}

function validateWorkerResponse(
  value: unknown,
  request: TtsSynthesisRequest,
): TtsSynthesisResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker response must be an object");
  }
  const response = value as WorkerResponse;
  if (response.status === "error") {
    if (response.schema_version !== 1
        || response.interaction_id !== request.interaction_id
        || response.assignment_id !== request.assignment_id
        || response.segment_index !== request.segment_index
        || response.role_id !== request.role_id
        || response.voice !== request.voice) {
      throw new TtsProviderError("INVALID_RESPONSE", "TTS worker error identity does not match the request");
    }
    const code = response.error_code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROCESS_ERROR";
    throw new TtsProviderError(code, "TTS worker reported a bounded provider error", {
      retryable: code === "PROCESS_ERROR",
    });
  }
  if (response.schema_version !== 1 || response.status !== "completed"
      || response.interaction_id !== request.interaction_id
      || response.assignment_id !== request.assignment_id
      || response.segment_index !== request.segment_index
      || response.role_id !== request.role_id || response.voice !== request.voice
      || response.sample_rate_hz !== TTS_SAMPLE_RATE_HZ
      || response.channels !== TTS_CHANNELS || response.sample_bits !== TTS_SAMPLE_BITS
      || typeof response.samples !== "number" || !Number.isInteger(response.samples)
      || response.samples < 1 || response.samples > TTS_MAX_PCM_BYTES / 2
      || typeof response.duration_ms !== "number" || !Number.isFinite(response.duration_ms)
      || response.duration_ms < 0 || response.duration_ms > MAX_TIMEOUT_MS
      || typeof response.python_version !== "string" || !response.python_version.startsWith("3.12.")
      || typeof response.pcm_base64 !== "string") {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker response violates the frozen contract");
  }
  const pcm = Buffer.from(response.pcm_base64, "base64");
  if (pcm.byteLength !== response.samples * 2 || pcm.byteLength > TTS_MAX_PCM_BYTES
      || pcm.byteLength === 0 || pcm.toString("base64") !== response.pcm_base64) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker PCM is malformed or outside bounds");
  }
  const expectedDurationMs = response.samples / TTS_SAMPLE_RATE_HZ * 1_000;
  if (Math.abs(response.duration_ms - expectedDurationMs) > 0.00051) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker duration does not match its PCM samples");
  }
  return {
    schema_version: 1,
    kind: "final_pcm",
    interaction_id: request.interaction_id,
    assignment_id: request.assignment_id,
    segment_index: request.segment_index,
    role_id: request.role_id,
    voice: request.voice,
    pcm,
    sample_rate_hz: TTS_SAMPLE_RATE_HZ,
    channels: TTS_CHANNELS,
    sample_bits: TTS_SAMPLE_BITS,
    samples: response.samples,
    duration_ms: response.duration_ms,
  };
}

export class PythonTtsProvider {
  readonly #options: PythonTtsProviderOptions;
  readonly #timeoutMs: number;
  #warmupPromise: Promise<void> | null = null;

  public constructor(options: PythonTtsProviderOptions) {
    if (!isAbsolute(options.python_executable) || !isAbsolute(options.worker_script)
        || !isAbsolute(options.model_path)) {
      throw new TypeError("TTS Python executable, worker and model paths must be absolute");
    }
    if (!MODEL_REVISION.test(options.model_revision)
        || options.model_revision !== TTS_MODEL_REVISION
        || options.provider_version !== TTS_PROVIDER_VERSION) {
      throw new TypeError("TTS provider version and model revision must be pinned");
    }
    const timeoutMs = options.timeout_ms ?? 45_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError("TTS timeout must be an integer between 1000 and 120000 ms");
    }
    this.#options = { ...options };
    this.#timeoutMs = timeoutMs;
  }

  public async synthesize(
    request: TtsSynthesisRequest,
    options: TtsSynthesisOptions = {},
  ): Promise<TtsSynthesisResult> {
    validateRequest(request);
    if (options.signal?.aborted === true) {
      throw new TtsProviderError("CANCELLED", "TTS request was cancelled");
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
            P4HOME_TTS_PROVIDER_VERSION: this.#options.provider_version,
            P4HOME_TTS_MODEL_REVISION: this.#options.model_revision,
            PYTHONNOUSERSITE: "1",
          },
        },
      );
    } catch (error) {
      throw new TtsProviderError("PROCESS_ERROR", "failed to start TTS worker", {
        retryable: true,
        cause: error,
      });
    }

    return await new Promise<TtsSynthesisResult>((resolve, reject) => {
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
      const fail = (error: TtsProviderError): void => finish(() => {
        if (!child.killed) child.kill("SIGKILL");
        reject(error);
      });
      const onAbort = (): void => fail(new TtsProviderError("CANCELLED", "TTS request was cancelled"));
      const timer = setTimeout(() => {
        fail(new TtsProviderError("TIMEOUT", "TTS request exceeded its deadline", { retryable: true }));
      }, this.#timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) {
        onAbort();
      }
      child.stdout.on("data", (chunk: Buffer) => {
        try { stdout = appendBounded(stdout, chunk); } catch (error) { fail(error as TtsProviderError); }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try { stderr = appendBounded(stderr, chunk); } catch (error) { fail(error as TtsProviderError); }
      });
      child.stdin.on("error", (error) => fail(new TtsProviderError(
        "PROCESS_ERROR", "failed to send the bounded TTS request", { retryable: true, cause: error },
      )));
      child.on("error", (error) => fail(new TtsProviderError(
        "PROCESS_ERROR", "TTS worker process failed", { retryable: true, cause: error },
      )));
      child.on("close", (code) => {
        if (settled) return;
        try {
          const lines = stdout.trim().split("\n");
          if (lines.length !== 1) throw new Error("worker must emit exactly one JSON line");
          const result = validateWorkerResponse(JSON.parse(lines[0] as string), request);
          if (code !== 0) {
            fail(new TtsProviderError(
              "PROCESS_ERROR",
              stderr.length === 0 ? "TTS worker exited unsuccessfully" : "TTS worker emitted a bounded error",
              { retryable: true },
            ));
            return;
          }
          finish(() => resolve(result));
        } catch (error) {
          if (error instanceof TtsProviderError) {
            fail(error);
            return;
          }
          fail(new TtsProviderError(
            code === 0 ? "INVALID_RESPONSE" : "PROCESS_ERROR",
            code === 0 ? "TTS worker returned invalid JSON" : "TTS worker exited unsuccessfully",
            { retryable: code !== 0, cause: error },
          ));
        }
      });
      try {
        child.stdin.end(`${JSON.stringify({
          schema_version: 1,
          interaction_id: request.interaction_id,
          assignment_id: request.assignment_id,
          segment_index: request.segment_index,
          role_id: request.role_id,
          text: request.text,
          voice: request.voice,
          language: request.language,
          sample_rate_hz: request.sample_rate_hz,
          channels: request.channels,
          sample_bits: request.sample_bits,
        })}\n`);
      } catch (error) {
        fail(new TtsProviderError(
          "PROCESS_ERROR", "failed to send the bounded TTS request", { retryable: true, cause: error },
        ));
      }
    });
  }

  /**
   * Prime the one-shot Python/MLX path before the first user response. The
   * fixed text is non-user data and the generated PCM is immediately zeroed;
   * no worker or model allocation remains resident after this call.
   */
  public warmup(options: TtsSynthesisOptions = {}): Promise<void> {
    this.#warmupPromise ??= this.#runWarmup(options);
    return this.#warmupPromise;
  }

  async #runWarmup(options: TtsSynthesisOptions): Promise<void> {
    const result = await this.synthesize({
      interaction_id: "p4home-tts-warmup",
      assignment_id: "p4home-tts-warmup-human",
      segment_index: 0,
      role_id: "human",
      text: "准备就绪。",
      voice: TTS_ROLE_VOICES.human,
      language: "zh",
      sample_rate_hz: TTS_SAMPLE_RATE_HZ,
      channels: TTS_CHANNELS,
      sample_bits: TTS_SAMPLE_BITS,
    }, options);
    result.pcm.fill(0);
  }
}

export const pythonTtsProviderInternals = { validateRequest, validateWorkerResponse };
