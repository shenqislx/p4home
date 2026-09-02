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
  type StreamingTtsProvider,
  type TtsPcmChunk,
  type TtsSynthesisOptions,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "./types.ts";

const WORKER_SCHEMA_VERSION = 2;
const MAX_WORKER_LINE_BYTES = 32 * 1024;
const MAX_QUEUED_OUTPUT_BYTES = 256 * 1024;
const PAUSE_QUEUED_OUTPUT_BYTES = 32 * 1024;
const RESUME_QUEUED_OUTPUT_BYTES = 16 * 1024;
const MAX_STREAM_PCM_CHUNK_BYTES = 16 * 1024;
const MAX_QUEUED_REQUESTS = 16;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MODEL_REVISION = /^[0-9a-f]{40}$/;
const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const READY_KEYS = [
  "schema_version", "status", "provider_version", "model_revision", "python_version",
] as const;
const CHUNK_KEYS = [
  "schema_version", "status", "interaction_id", "assignment_id", "segment_index",
  "role_id", "voice", "chunk_index", "pcm_base64", "sample_rate_hz", "channels",
  "sample_bits", "samples", "duration_ms", "final",
] as const;
const COMPLETED_KEYS = [
  "schema_version", "status", "interaction_id", "assignment_id", "segment_index",
  "role_id", "voice", "chunk_count", "pcm_bytes", "sample_rate_hz", "channels",
  "sample_bits", "samples", "duration_ms", "python_version",
] as const;
const ERROR_KEYS = [
  "schema_version", "status", "interaction_id", "assignment_id", "segment_index",
  "role_id", "voice", "error_code",
] as const;
const STARTUP_ERROR_KEYS = ["schema_version", "status", "error_code"] as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface PythonTtsProviderOptions {
  readonly python_executable: string;
  readonly worker_script: string;
  readonly model_path: string;
  readonly model_revision: string;
  readonly provider_version: typeof TTS_PROVIDER_VERSION;
  readonly timeout_ms?: number;
  readonly spawn_process?: typeof spawn;
}

type WorkerObject = Readonly<Record<string, unknown>>;

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

function workerObject(value: unknown): WorkerObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker response must be an object");
  }
  return value as WorkerObject;
}

function exactKeys(value: WorkerObject, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker response has unexpected fields");
  }
}

function identityMatches(value: WorkerObject, request: TtsSynthesisRequest): boolean {
  return value.interaction_id === request.interaction_id
    && value.assignment_id === request.assignment_id
    && value.segment_index === request.segment_index
    && value.role_id === request.role_id
    && value.voice === request.voice;
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
      throw new TtsProviderError("INVALID_RESPONSE", "TTS worker startup error is invalid");
    }
    const code = response.error_code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROCESS_ERROR";
    throw new TtsProviderError(code, "TTS worker failed closed during startup", {
      retryable: code === "PROCESS_ERROR",
    });
  }
  exactKeys(response, READY_KEYS);
  if (response.schema_version !== WORKER_SCHEMA_VERSION || response.status !== "ready"
      || response.provider_version !== TTS_PROVIDER_VERSION
      || response.model_revision !== TTS_MODEL_REVISION
      || !validPythonVersion(response.python_version)) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker readiness violates the pinned contract");
  }
}

function validateWorkerChunk(
  value: unknown,
  request: TtsSynthesisRequest,
  expectedIndex: number,
): TtsPcmChunk {
  const response = workerObject(value);
  exactKeys(response, CHUNK_KEYS);
  if (response.schema_version !== WORKER_SCHEMA_VERSION || response.status !== "chunk"
      || !identityMatches(response, request) || response.chunk_index !== expectedIndex
      || response.sample_rate_hz !== TTS_SAMPLE_RATE_HZ
      || response.channels !== TTS_CHANNELS || response.sample_bits !== TTS_SAMPLE_BITS
      || response.final !== false || typeof response.pcm_base64 !== "string"
      || typeof response.samples !== "number" || !Number.isSafeInteger(response.samples)
      || response.samples < 1 || response.samples > MAX_STREAM_PCM_CHUNK_BYTES / 2
      || typeof response.duration_ms !== "number" || !Number.isFinite(response.duration_ms)
      || response.duration_ms <= 0) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker PCM chunk violates the stream contract");
  }
  const pcm = Buffer.from(response.pcm_base64, "base64");
  const expectedDurationMs = response.samples / TTS_SAMPLE_RATE_HZ * 1_000;
  if (pcm.byteLength !== response.samples * 2 || pcm.byteLength < 2
      || pcm.byteLength > MAX_STREAM_PCM_CHUNK_BYTES
      || pcm.toString("base64") !== response.pcm_base64
      || Math.abs(response.duration_ms - expectedDurationMs) > 0.000_51) {
    pcm.fill(0);
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker PCM chunk is malformed");
  }
  return {
    schema_version: 1,
    kind: "pcm_chunk",
    interaction_id: request.interaction_id,
    assignment_id: request.assignment_id,
    segment_index: request.segment_index,
    role_id: request.role_id,
    voice: request.voice,
    chunk_index: expectedIndex,
    pcm,
    sample_rate_hz: TTS_SAMPLE_RATE_HZ,
    channels: TTS_CHANNELS,
    sample_bits: TTS_SAMPLE_BITS,
    samples: response.samples,
    duration_ms: response.duration_ms,
    final: false,
  };
}

function validateWorkerTerminal(
  value: unknown,
  request: TtsSynthesisRequest,
  totals: { readonly chunks: number; readonly bytes: number; readonly samples: number },
): void {
  const response = workerObject(value);
  if (response.status === "error") {
    exactKeys(response, ERROR_KEYS);
    if (response.schema_version !== WORKER_SCHEMA_VERSION || !identityMatches(response, request)
        || (response.error_code !== "MODEL_UNAVAILABLE"
          && response.error_code !== "PROCESS_ERROR")) {
      throw new TtsProviderError("INVALID_RESPONSE", "TTS worker error identity does not match the request");
    }
    const code = response.error_code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "PROCESS_ERROR";
    throw new TtsProviderError(code, "TTS worker reported a bounded provider error", {
      retryable: code === "PROCESS_ERROR",
    });
  }
  exactKeys(response, COMPLETED_KEYS);
  const expectedDurationMs = totals.samples / TTS_SAMPLE_RATE_HZ * 1_000;
  if (response.schema_version !== WORKER_SCHEMA_VERSION || response.status !== "completed"
      || !identityMatches(response, request) || response.chunk_count !== totals.chunks
      || response.pcm_bytes !== totals.bytes || response.samples !== totals.samples
      || response.sample_rate_hz !== TTS_SAMPLE_RATE_HZ
      || response.channels !== TTS_CHANNELS || response.sample_bits !== TTS_SAMPLE_BITS
      || !validPythonVersion(response.python_version)
      || typeof response.duration_ms !== "number" || !Number.isFinite(response.duration_ms)
      || Math.abs(response.duration_ms - expectedDurationMs) > 0.000_51) {
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker terminal totals violate the stream contract");
  }
}

interface LineWaiter {
  readonly resolve: (line: string) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

class BoundedNdjsonReader {
  readonly #stream: ChildProcessWithoutNullStreams["stdout"];
  readonly #onFault: (error: TtsProviderError) => void;
  #partial = Buffer.alloc(0);
  #lines: { readonly value: string; readonly bytes: number }[] = [];
  #queuedBytes = 0;
  #waiters: LineWaiter[] = [];
  #failure: Error | null = null;
  #paused = false;

  public constructor(
    stream: ChildProcessWithoutNullStreams["stdout"],
    onFault: (error: TtsProviderError) => void,
  ) {
    this.#stream = stream;
    this.#onFault = onFault;
    stream.on("data", (chunk: Buffer) => this.#accept(chunk));
    stream.on("error", (error) => this.fail(new TtsProviderError(
      "PROCESS_ERROR", "TTS worker stdout failed", { retryable: true, cause: error },
    )));
  }

  public get hasBufferedData(): boolean {
    return this.#partial.byteLength > 0 || this.#lines.length > 0;
  }

  public async read(signal?: AbortSignal): Promise<string> {
    if (this.#lines.length > 0) {
      const line = this.#lines.shift()!;
      this.#queuedBytes -= line.bytes;
      this.#resumeIfNeeded();
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
    if (this.#paused) {
      this.#paused = false;
      this.#stream.resume();
    }
  }

  #accept(chunk: Buffer): void {
    if (this.#failure !== null) return;
    let combined = Buffer.alloc(0);
    try {
      if (this.#partial.byteLength + chunk.byteLength > MAX_QUEUED_OUTPUT_BYTES) {
        throw new TtsProviderError("INVALID_RESPONSE", "TTS worker output buffer exceeded its bound");
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
          throw new TtsProviderError("INVALID_RESPONSE", "TTS worker NDJSON line is outside bounds");
        }
        const line = UTF8_DECODER.decode(combined.subarray(start, index));
        if (Buffer.byteLength(line, "utf8") !== length) {
          throw new TtsProviderError("INVALID_RESPONSE", "TTS worker NDJSON is not canonical UTF-8");
        }
        this.#deliver(line, length + 1);
        start = index + 1;
      }
      const remainder = combined.subarray(start);
      if (remainder.byteLength > MAX_WORKER_LINE_BYTES) {
        throw new TtsProviderError("INVALID_RESPONSE", "TTS worker partial NDJSON line exceeds its bound");
      }
      this.#partial = Buffer.from(remainder);
      combined.fill(0);
      if (this.#queuedBytes >= PAUSE_QUEUED_OUTPUT_BYTES && !this.#paused) {
        this.#paused = true;
        this.#stream.pause();
      }
    } catch (error) {
      chunk.fill(0);
      combined.fill(0);
      const failure = error instanceof TtsProviderError ? error : new TtsProviderError(
        "INVALID_RESPONSE", "TTS worker NDJSON framing is invalid", { cause: error },
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
      throw new TtsProviderError("INVALID_RESPONSE", "TTS worker queued output exceeded its bound");
    }
    this.#lines.push({ value, bytes });
    this.#queuedBytes += bytes;
  }

  #resumeIfNeeded(): void {
    if (this.#paused && this.#queuedBytes <= RESUME_QUEUED_OUTPUT_BYTES) {
      this.#paused = false;
      this.#stream.resume();
    }
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
    if (this.#closed) throw new TtsProviderError("PROCESS_ERROR", "TTS provider is closed");
    if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    if (!this.#locked) {
      this.#locked = true;
      return this.#release;
    }
    if (this.#waiters.length >= MAX_QUEUED_REQUESTS) {
      throw new TtsProviderError("PROCESS_ERROR", "TTS request queue exceeded its bound", {
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
    const error = new TtsProviderError("PROCESS_ERROR", "TTS provider is closed");
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
    throw new TtsProviderError("INVALID_RESPONSE", "TTS worker returned invalid NDJSON", {
      cause: error,
    });
  }
}

function requestLine(request: TtsSynthesisRequest): string {
  return `${JSON.stringify({
    schema_version: WORKER_SCHEMA_VERSION,
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
  })}\n`;
}

export class PythonTtsProvider implements StreamingTtsProvider {
  readonly #options: PythonTtsProviderOptions;
  readonly #timeoutMs: number;
  readonly #mutex = new BoundedAsyncMutex();
  #child: ChildProcessWithoutNullStreams | null = null;
  #reader: BoundedNdjsonReader | null = null;
  #warmupPromise: Promise<void> | null = null;
  #closed = false;

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

  public stream(
    request: TtsSynthesisRequest,
    options: TtsSynthesisOptions = {},
  ): AsyncIterable<TtsPcmChunk> {
    validateRequest(request);
    return this.#stream(request, options);
  }

  async *#stream(
    request: TtsSynthesisRequest,
    options: TtsSynthesisOptions,
  ): AsyncGenerator<TtsPcmChunk, void, void> {
    if (this.#closed) throw new TtsProviderError("PROCESS_ERROR", "TTS provider is closed");
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("TTS request timed out", "TimeoutError"));
    }, this.#timeoutMs);
    timer.unref();
    let release: (() => void) | null = null;
    let requestSent = false;
    let completed = false;
    try {
      release = await this.#mutex.acquire(controller.signal);
      const { child, reader } = await this.#ensureWorker(controller.signal);
      if (reader.hasBufferedData) {
        throw new TtsProviderError("INVALID_RESPONSE", "TTS worker emitted data outside a request");
      }
      await this.#writeRequest(child, requestLine(request), controller.signal);
      requestSent = true;
      let chunks = 0;
      let bytes = 0;
      let samples = 0;
      for (;;) {
        const value = parseWorkerLine(await reader.read(controller.signal));
        const status = (value as { readonly status?: unknown } | null)?.status;
        if (status === "chunk") {
          const chunk = validateWorkerChunk(value, request, chunks);
          if (!Number.isSafeInteger(bytes + chunk.pcm.byteLength)
              || bytes + chunk.pcm.byteLength > TTS_MAX_PCM_BYTES) {
            chunk.pcm.fill(0);
            throw new TtsProviderError("INVALID_RESPONSE", "TTS worker stream exceeded the PCM bound");
          }
          chunks++;
          bytes += chunk.pcm.byteLength;
          samples += chunk.samples;
          yield chunk;
          continue;
        }
        validateWorkerTerminal(value, request, { chunks, bytes, samples });
        if (chunks < 1 || bytes < 2 || samples !== bytes / 2 || reader.hasBufferedData) {
          throw new TtsProviderError("INVALID_RESPONSE", "TTS worker stream terminal is incomplete or duplicated");
        }
        completed = true;
        return;
      }
    } catch (error) {
      // A request cancelled while waiting for the mutex must not kill the
      // resident worker currently serving an earlier request.
      if (release !== null && (requestSent || this.#child !== null)) this.#discardWorker();
      if (timedOut) {
        throw new TtsProviderError("TIMEOUT", "TTS request exceeded its deadline", {
          retryable: true,
        });
      }
      if (options.signal?.aborted === true) {
        throw new TtsProviderError("CANCELLED", "TTS request was cancelled");
      }
      if (error instanceof TtsProviderError) throw error;
      throw new TtsProviderError("PROCESS_ERROR", "TTS worker request failed", {
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

  public async synthesize(
    request: TtsSynthesisRequest,
    options: TtsSynthesisOptions = {},
  ): Promise<TtsSynthesisResult> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for await (const chunk of this.stream(request, options)) {
        chunks.push(chunk.pcm);
        totalBytes += chunk.pcm.byteLength;
      }
      const pcm = Buffer.alloc(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.byteLength;
        chunk.fill(0);
      }
      const samples = pcm.byteLength / 2;
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
        samples,
        duration_ms: samples / TTS_SAMPLE_RATE_HZ * 1_000,
      };
    } catch (error) {
      for (const chunk of chunks) chunk.fill(0);
      throw error;
    }
  }

  /** Load and retain the pinned model, then verify one non-user synthesis. */
  public warmup(options: TtsSynthesisOptions = {}): Promise<void> {
    this.#warmupPromise ??= this.#runWarmup(options);
    return this.#warmupPromise;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#mutex.close();
    this.#discardWorker();
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

  async #ensureWorker(signal: AbortSignal): Promise<{
    readonly child: ChildProcessWithoutNullStreams;
    readonly reader: BoundedNdjsonReader;
  }> {
    if (this.#closed) throw new TtsProviderError("PROCESS_ERROR", "TTS provider is closed");
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
    let reader: BoundedNdjsonReader;
    reader = new BoundedNdjsonReader(child.stdout, () => {
      if (this.#child === child && !child.killed) child.kill("SIGKILL");
    });
    this.#child = child;
    this.#reader = reader;
    child.stderr.on("data", (_chunk: Buffer) => {
      // Drain without retaining model diagnostics or request-derived data.
    });
    child.stdin.on("error", (error) => reader.fail(new TtsProviderError(
      "PROCESS_ERROR", "TTS worker stdin failed", { retryable: true, cause: error },
    )));
    child.on("error", (error) => reader.fail(new TtsProviderError(
      "PROCESS_ERROR", "TTS worker process failed", { retryable: true, cause: error },
    )));
    child.on("close", () => {
      reader.fail(new TtsProviderError("PROCESS_ERROR", "TTS worker exited", { retryable: true }));
      if (this.#child === child) {
        this.#child = null;
        this.#reader = null;
      }
    });
    try {
      validateWorkerReady(parseWorkerLine(await reader.read(signal)));
      if (reader.hasBufferedData) {
        throw new TtsProviderError("INVALID_RESPONSE", "TTS worker emitted data after readiness");
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
    if (Buffer.byteLength(line, "utf8") > 8_192 || signal.aborted) {
      if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      throw new TtsProviderError("PROCESS_ERROR", "bounded TTS request exceeded 8 KiB");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.write(line, "utf8", (error) => {
          signal.removeEventListener("abort", onAbort);
          if (error) reject(new TtsProviderError(
            "PROCESS_ERROR", "failed to send the bounded TTS request", {
              retryable: true,
              cause: error,
            },
          ));
          else resolve();
        });
      } catch (error) {
        signal.removeEventListener("abort", onAbort);
        reject(new TtsProviderError(
          "PROCESS_ERROR", "failed to send the bounded TTS request", {
            retryable: true,
            cause: error,
          },
        ));
      }
    });
  }

  #discardWorker(): void {
    const child = this.#child;
    const reader = this.#reader;
    this.#child = null;
    this.#reader = null;
    reader?.fail(new TtsProviderError("PROCESS_ERROR", "TTS worker was discarded", {
      retryable: true,
    }));
    if (child !== null && !child.killed) child.kill("SIGKILL");
  }
}

export const pythonTtsProviderInternals = {
  validateRequest,
  validateWorkerReady,
  validateWorkerChunk,
  validateWorkerTerminal,
};
