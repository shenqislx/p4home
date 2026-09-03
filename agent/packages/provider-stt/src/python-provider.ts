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

const WORKER_SCHEMA_VERSION = 2;
const MAX_WORKER_LINE_BYTES = 16 * 1024;
const MAX_QUEUED_OUTPUT_BYTES = 64 * 1024;
const MAX_WORKER_REQUEST_BYTES = 900_000;
const MAX_QUEUED_REQUESTS = 16;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const MIN_IDLE_TIMEOUT_MS = 100;
const MAX_IDLE_TIMEOUT_MS = 600_000;
const MODEL_REVISION = /^[0-9a-f]{40}$/;
const READY_KEYS = [
  "schema_version", "status", "provider_version", "model_revision", "python_version",
] as const;
const COMPLETED_KEYS = [
  "schema_version", "status", "session_id", "stream_id", "epoch", "text", "language",
  "duration_ms", "python_version",
] as const;
const ERROR_KEYS = [
  "schema_version", "status", "session_id", "stream_id", "epoch", "error_code",
] as const;
const STARTUP_ERROR_KEYS = ["schema_version", "status", "error_code"] as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface PythonSttProviderOptions {
  readonly python_executable: string;
  readonly worker_script: string;
  readonly model_path: string;
  readonly model_revision: string;
  readonly provider_version: typeof STT_PROVIDER_VERSION;
  readonly timeout_ms?: number;
  /** Retire an unused resident model. Defaults to two minutes and is capped at ten minutes. */
  readonly idle_timeout_ms?: number;
  readonly spawn_process?: typeof spawn;
}

type WorkerObject = Readonly<Record<string, unknown>>;

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

function workerObject(value: unknown): WorkerObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker response must be an object");
  }
  return value as WorkerObject;
}

function exactKeys(value: WorkerObject, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker response has unexpected fields");
  }
}

function validPythonVersion(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("3.12.");
}

function validateWorkerReady(value: unknown): void {
  const response = workerObject(value);
  if (response.status === "startup_error") {
    exactKeys(response, STARTUP_ERROR_KEYS);
    if (response.schema_version !== WORKER_SCHEMA_VERSION
        || (response.error_code !== "MODEL_UNAVAILABLE"
          && response.error_code !== "PROCESS_ERROR")) {
      throw new SttProviderError("INVALID_RESPONSE", "STT worker startup error is invalid");
    }
    const code = response.error_code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROCESS_ERROR";
    throw new SttProviderError(code, "STT worker failed closed during startup", {
      retryable: code === "PROCESS_ERROR",
    });
  }
  exactKeys(response, READY_KEYS);
  if (response.schema_version !== WORKER_SCHEMA_VERSION || response.status !== "ready"
      || response.provider_version !== STT_PROVIDER_VERSION
      || response.model_revision !== STT_MODEL_REVISION
      || !validPythonVersion(response.python_version)) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker readiness violates the pinned contract");
  }
}

function validateWorkerResponse(value: unknown, request: SttTranscriptionRequest): SttFinalTranscript {
  const response = workerObject(value);
  if (response.status === "error") {
    exactKeys(response, ERROR_KEYS);
    if (response.schema_version !== WORKER_SCHEMA_VERSION
        || response.session_id !== request.session_id
        || response.stream_id !== request.stream_id
        || response.epoch !== request.epoch
        || (response.error_code !== "MODEL_UNAVAILABLE"
          && response.error_code !== "PROCESS_ERROR")) {
      throw new SttProviderError("INVALID_RESPONSE", "STT worker error identity is invalid");
    }
    const code = response.error_code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROCESS_ERROR";
    throw new SttProviderError(code, "STT worker reported a bounded provider error", {
      retryable: code === "PROCESS_ERROR",
    });
  }
  exactKeys(response, COMPLETED_KEYS);
  if (
    response.schema_version !== WORKER_SCHEMA_VERSION
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
    || !validPythonVersion(response.python_version)
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

interface LineWaiter {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

class BoundedNdjsonReader {
  readonly #stream: ChildProcessWithoutNullStreams["stdout"];
  readonly #onFault: (error: SttProviderError) => void;
  #partial = Buffer.alloc(0);
  #lines: { readonly value: string; readonly bytes: number }[] = [];
  #queuedBytes = 0;
  #waiters: LineWaiter[] = [];
  #failure: Error | null = null;

  public constructor(
    stream: ChildProcessWithoutNullStreams["stdout"],
    onFault: (error: SttProviderError) => void,
  ) {
    this.#stream = stream;
    this.#onFault = onFault;
    stream.on("data", (chunk: Buffer) => this.#accept(chunk));
    stream.on("error", (error) => this.fail(new SttProviderError(
      "PROCESS_ERROR", "STT worker stdout failed", { retryable: true, cause: error },
    )));
  }

  public get hasBufferedData(): boolean {
    return this.#partial.byteLength > 0 || this.#lines.length > 0;
  }

  public async read(signal?: AbortSignal): Promise<string> {
    if (this.#lines.length > 0) {
      const line = this.#lines.shift()!;
      this.#queuedBytes -= line.bytes;
      return line.value;
    }
    if (this.#failure !== null) throw this.#failure;
    if (signal?.aborted === true) throw signal.reason ?? new DOMException("aborted", "AbortError");
    return await new Promise<string>((resolve, reject) => {
      const waiter: LineWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : {
          signal,
          onAbort: () => {
            const index = this.#waiters.indexOf(waiter);
            if (index >= 0) this.#waiters.splice(index, 1);
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          },
        }),
      };
      this.#waiters.push(waiter);
      waiter.signal?.addEventListener("abort", waiter.onAbort!, { once: true });
      if (waiter.signal?.aborted === true) waiter.onAbort!();
    });
  }

  public fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    this.#partial.fill(0);
    this.#partial = Buffer.alloc(0);
    this.#lines = [];
    this.#queuedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.reject(error);
    }
  }

  #accept(chunk: Buffer): void {
    if (this.#failure !== null) return;
    let combined = Buffer.alloc(0);
    try {
      if (this.#partial.byteLength + chunk.byteLength > MAX_QUEUED_OUTPUT_BYTES) {
        throw new SttProviderError("INVALID_RESPONSE", "STT worker output buffer exceeded its bound");
      }
      combined = Buffer.concat([this.#partial, chunk]);
      chunk.fill(0);
      this.#partial.fill(0);
      this.#partial = Buffer.alloc(0);
      let start = 0;
      for (let index = 0; index < combined.byteLength; index++) {
        if (combined[index] !== 0x0a) continue;
        const length = index - start;
        if (length < 2 || length > MAX_WORKER_LINE_BYTES) {
          throw new SttProviderError("INVALID_RESPONSE", "STT worker NDJSON line is outside bounds");
        }
        const line = UTF8_DECODER.decode(combined.subarray(start, index));
        if (Buffer.byteLength(line, "utf8") !== length) {
          throw new SttProviderError("INVALID_RESPONSE", "STT worker NDJSON is not canonical UTF-8");
        }
        this.#deliver(line, length + 1);
        start = index + 1;
      }
      const remainder = combined.subarray(start);
      if (remainder.byteLength > MAX_WORKER_LINE_BYTES) {
        throw new SttProviderError("INVALID_RESPONSE", "STT worker partial NDJSON line exceeds its bound");
      }
      this.#partial = Buffer.from(remainder);
      combined.fill(0);
    } catch (error) {
      chunk.fill(0);
      combined.fill(0);
      const failure = error instanceof SttProviderError ? error : new SttProviderError(
        "INVALID_RESPONSE", "STT worker NDJSON framing is invalid", { cause: error },
      );
      this.fail(failure);
      this.#onFault(failure);
    }
  }

  #deliver(value: string, bytes: number): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.resolve(value);
      return;
    }
    if (this.#queuedBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
      throw new SttProviderError("INVALID_RESPONSE", "STT worker queued output exceeded its bound");
    }
    this.#lines.push({ value, bytes });
    this.#queuedBytes += bytes;
  }
}

interface MutexWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

class BoundedAsyncMutex {
  #locked = false;
  #waiters: MutexWaiter[] = [];
  #closed = false;

  public async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.#closed) throw new SttProviderError("PROCESS_ERROR", "STT provider is closed");
    if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    if (!this.#locked) {
      this.#locked = true;
      return this.#release;
    }
    if (this.#waiters.length >= MAX_QUEUED_REQUESTS) {
      throw new SttProviderError("PROCESS_ERROR", "STT request queue exceeded its bound", {
        retryable: true,
      });
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: MutexWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        },
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new SttProviderError("PROCESS_ERROR", "STT provider is closed");
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  readonly #release = (): void => {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#locked = false;
      return;
    }
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(this.#release);
  };
}

function parseWorkerLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new SttProviderError("INVALID_RESPONSE", "STT worker returned invalid NDJSON", {
      cause: error,
    });
  }
}

function requestLine(request: SttTranscriptionRequest): string {
  const pcm = Buffer.from(request.pcm);
  try {
    const line = `${JSON.stringify({
      schema_version: WORKER_SCHEMA_VERSION,
      session_id: request.session_id,
      stream_id: request.stream_id,
      epoch: request.epoch,
      sample_rate_hz: request.sample_rate_hz,
      channels: request.channels,
      sample_bits: request.sample_bits,
      language: request.language,
      pcm_base64: pcm.toString("base64"),
    })}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_WORKER_REQUEST_BYTES) {
      throw new SttProviderError("PROCESS_ERROR", "bounded STT request exceeded 900 KiB");
    }
    return line;
  } finally {
    pcm.fill(0);
  }
}

export class PythonSttProvider implements SttProvider {
  readonly #options: PythonSttProviderOptions;
  readonly #timeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #mutex = new BoundedAsyncMutex();
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: BoundedNdjsonReader | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #warmupPromise: Promise<void> | null = null;
  #refreshWarmupPromise: Promise<void> | null = null;
  #closed = false;

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
    const idleTimeoutMs = options.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isInteger(idleTimeoutMs)
        || idleTimeoutMs < MIN_IDLE_TIMEOUT_MS || idleTimeoutMs > MAX_IDLE_TIMEOUT_MS) {
      throw new RangeError("STT idle timeout must be an integer between 100 and 600000 ms");
    }
    this.#options = { ...options };
    this.#timeoutMs = timeoutMs;
    this.#idleTimeoutMs = idleTimeoutMs;
  }

  public async transcribe(
    request: SttTranscriptionRequest,
    options: SttTranscriptionOptions = {},
  ): Promise<SttFinalTranscript> {
    validateRequest(request);
    if (this.#closed) throw new SttProviderError("PROCESS_ERROR", "STT provider is closed");
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("STT request timed out", "TimeoutError"));
    }, this.#timeoutMs);
    timer.unref();
    let release: (() => void) | null = null;
    let requestSent = false;
    let completed = false;
    try {
      release = await this.#mutex.acquire(controller.signal);
      this.#clearIdleTimer();
      const { child, reader } = await this.#ensureWorker(controller.signal);
      if (reader.hasBufferedData) {
        throw new SttProviderError("INVALID_RESPONSE", "STT worker emitted data outside a request");
      }
      await this.#writeRequest(child, requestLine(request), controller.signal);
      requestSent = true;
      const result = validateWorkerResponse(parseWorkerLine(await reader.read(controller.signal)), request);
      if (reader.hasBufferedData) {
        throw new SttProviderError("INVALID_RESPONSE", "STT worker emitted duplicate request output");
      }
      completed = true;
      this.#scheduleIdleRetirement();
      return result;
    } catch (error) {
      // Cancellation while queued must not kill the worker serving the active request.
      if (release !== null && (requestSent || this.#child !== null)) this.#discardWorker();
      if (timedOut) {
        throw new SttProviderError("TIMEOUT", "STT request exceeded its deadline", { retryable: true });
      }
      if (options.signal?.aborted === true) {
        throw new SttProviderError("CANCELLED", "STT request was cancelled");
      }
      if (error instanceof SttProviderError) throw error;
      throw new SttProviderError("PROCESS_ERROR", "STT worker request failed", {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!completed && requestSent) this.#discardWorker();
      release?.();
    }
  }

  /** Load, verify and retain the pinned model before accepting live microphone audio. */
  public warmup(options: SttTranscriptionOptions = {}): Promise<void> {
    this.#warmupPromise ??= this.#prepareWorker(options.signal);
    return this.#warmupPromise;
  }

  /** Refresh the finite resident window without submitting a synthetic transcript request. */
  public async refreshWarmup(signal?: AbortSignal): Promise<void> {
    if (this.#refreshWarmupPromise !== null) return await this.#refreshWarmupPromise;
    const operation = this.#prepareWorker(signal);
    this.#refreshWarmupPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#refreshWarmupPromise === operation) this.#refreshWarmupPromise = null;
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#mutex.close();
    this.#discardWorker();
  }

  async #prepareWorker(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new SttProviderError("PROCESS_ERROR", "STT provider is closed");
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("STT warmup timed out", "TimeoutError"));
    }, this.#timeoutMs);
    timer.unref();
    let release: (() => void) | null = null;
    let completed = false;
    try {
      release = await this.#mutex.acquire(controller.signal);
      this.#clearIdleTimer();
      const { reader } = await this.#ensureWorker(controller.signal);
      if (reader.hasBufferedData) {
        throw new SttProviderError("INVALID_RESPONSE", "STT worker emitted data outside a request");
      }
      completed = true;
      this.#scheduleIdleRetirement();
    } catch (error) {
      if (release !== null && this.#child !== null) this.#discardWorker();
      if (timedOut) {
        throw new SttProviderError("TIMEOUT", "STT warmup exceeded its deadline", { retryable: true });
      }
      if (signal?.aborted === true) {
        throw new SttProviderError("CANCELLED", "STT warmup was cancelled");
      }
      if (error instanceof SttProviderError) throw error;
      throw new SttProviderError("PROCESS_ERROR", "STT worker warmup failed", {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!completed && release !== null) this.#discardWorker();
      release?.();
    }
  }

  async #ensureWorker(signal: AbortSignal): Promise<{
    readonly child: ChildProcessWithoutNullStreams;
    readonly reader: BoundedNdjsonReader;
  }> {
    if (this.#closed) throw new SttProviderError("PROCESS_ERROR", "STT provider is closed");
    if (this.#child !== null && this.#reader !== null && this.#child.exitCode === null
        && !this.#child.killed) {
      return { child: this.#child, reader: this.#reader };
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
    const reader = new BoundedNdjsonReader(child.stdout, () => {
      if (this.#child === child && !child.killed) child.kill("SIGKILL");
    });
    this.#child = child;
    this.#reader = reader;
    child.stderr.on("data", (_chunk: Buffer) => {
      // Drain without retaining model diagnostics or request-derived data.
    });
    child.stdin.on("error", (error) => reader.fail(new SttProviderError(
      "PROCESS_ERROR", "STT worker stdin failed", { retryable: true, cause: error },
    )));
    child.on("error", (error) => reader.fail(new SttProviderError(
      "PROCESS_ERROR", "STT worker process failed", { retryable: true, cause: error },
    )));
    child.on("close", () => {
      reader.fail(new SttProviderError("PROCESS_ERROR", "STT worker exited", { retryable: true }));
      if (this.#child === child) {
        this.#child = null;
        this.#reader = null;
        this.#clearIdleTimer();
      }
    });
    try {
      validateWorkerReady(parseWorkerLine(await reader.read(signal)));
      if (reader.hasBufferedData) {
        throw new SttProviderError("INVALID_RESPONSE", "STT worker emitted data after readiness");
      }
      return { child, reader };
    } catch (error) {
      this.#discardWorker();
      throw error;
    }
  }

  async #writeRequest(
    child: ChildProcessWithoutNullStreams,
    line: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > MAX_WORKER_REQUEST_BYTES || signal.aborted) {
      if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      throw new SttProviderError("PROCESS_ERROR", "bounded STT request exceeded 900 KiB");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.write(line, "utf8", (error) => {
          signal.removeEventListener("abort", onAbort);
          if (error) reject(new SttProviderError(
            "PROCESS_ERROR", "failed to send the bounded STT request", {
              retryable: true,
              cause: error,
            },
          ));
          else resolve();
        });
      } catch (error) {
        signal.removeEventListener("abort", onAbort);
        reject(new SttProviderError(
          "PROCESS_ERROR", "failed to send the bounded STT request", {
            retryable: true,
            cause: error,
          },
        ));
      }
    });
  }

  #scheduleIdleRetirement(): void {
    this.#clearIdleTimer();
    const child = this.#child;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#child === child) this.#discardWorker();
    }, this.#idleTimeoutMs);
    this.#idleTimer.unref();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer === null) return;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #discardWorker(): void {
    this.#clearIdleTimer();
    const child = this.#child;
    const reader = this.#reader;
    this.#child = null;
    this.#reader = null;
    reader?.fail(new SttProviderError("PROCESS_ERROR", "STT worker was discarded", {
      retryable: true,
    }));
    if (child !== null && !child.killed) child.kill("SIGKILL");
  }
}

export const pythonSttProviderInternals = {
  validateRequest,
  validateWorkerReady,
  validateWorkerResponse,
};
