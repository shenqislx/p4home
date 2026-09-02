import { randomBytes } from "node:crypto";

import {
  encodeVoiceFrameHeader,
  validateVoiceControlMessage,
  VoiceProtocolError,
  VoiceSessionFlowTracker,
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_FLAG_END_OF_STREAM,
  VOICE_FRAME_PAYLOAD_BYTES,
  VOICE_FRAME_SAMPLES,
  VOICE_HEADER_BYTES,
  VOICE_SAMPLE_RATE_HZ,
  type VoiceControlMessage,
  type VoiceFrameHeader,
} from "@p4home/contracts";

const PLAYBACK_MAX_PCM_BYTES = 1_920_000;
const PLAYBACK_MAX_INFLIGHT_FRAMES = 8;
const PLAYBACK_DEFAULT_TIMEOUT_MS = 70_000;
const PLAYBACK_MAX_TIMEOUT_MS = 90_000;
const PLAYBACK_TERMINAL_GRACE_MS = 2_000;

export interface VoicePlaybackIdentity {
  readonly session_id: string;
  readonly session_id_bytes: Uint8Array;
  readonly stream_id: number;
  readonly epoch: number;
}

export interface VoicePlaybackWire {
  sendControl(message: VoiceControlMessage): void;
  /** Takes ownership of message and must clear it after the transport send settles. */
  sendBinary(message: Uint8Array): void;
}

interface VoicePlaybackSenderCommonOptions {
  readonly device_id: string;
  readonly identity: VoicePlaybackIdentity;
  readonly wire: VoicePlaybackWire;
  readonly max_inflight_frames?: number;
  readonly timeout_ms?: number;
}

type VoicePlaybackSenderOptions = VoicePlaybackSenderCommonOptions & (
  | { readonly pcm: Uint8Array; readonly pcm_stream?: never }
  | { readonly pcm?: never; readonly pcm_stream: AsyncIterable<Uint8Array> }
);

export interface VoicePlaybackSummary {
  readonly schema_version: 1;
  readonly device_id: string;
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
  readonly status: "completed" | "cancelled" | "failed";
  readonly frames: number;
  readonly bytes: number;
  readonly dropped_frames: number;
}

export type VoicePlaybackErrorCode =
  | "CANCELLED"
  | "DISCONNECTED"
  | "INVALID_CONTROL"
  | "LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export class VoicePlaybackError extends Error {
  public constructor(
    public readonly code: VoicePlaybackErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VoicePlaybackError";
  }
}

function positiveRandomUint32(): number {
  const value = randomBytes(4).readUInt32LE(0);
  return value === 0 ? 1 : value;
}

export function createVoicePlaybackIdentity(): VoicePlaybackIdentity {
  const bytes = randomBytes(16);
  if (bytes.every((value) => value === 0)) bytes[0] = 1;
  return {
    session_id: bytes.toString("hex"),
    session_id_bytes: Uint8Array.from(bytes),
    stream_id: positiveRandomUint32(),
    epoch: positiveRandomUint32(),
  };
}

function base(identity: VoicePlaybackIdentity): Record<string, unknown> {
  return {
    protocol_version: 1,
    session_id: identity.session_id,
    stream_id: identity.stream_id,
    epoch: identity.epoch,
  };
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class VoicePlaybackSender {
  readonly #deviceId: string;
  readonly #identity: VoicePlaybackIdentity;
  readonly #source: AsyncIterator<Uint8Array>;
  readonly #wire: VoicePlaybackWire;
  readonly #flow = new VoiceSessionFlowTracker();
  readonly #timeoutMs: number;
  readonly #maxInflightFrames: number;
  readonly #framePcm = new Uint8Array(VOICE_FRAME_PAYLOAD_BYTES);
  #ownedInput: Uint8Array | null = null;
  #sourceChunk: Uint8Array | null = null;
  #sourceChunkOffset = 0;
  #frameBytes = 0;
  #sourceBytes = 0;
  #sourceDone = false;
  #sourceStopped = false;
  #pumpRunning = false;
  #pumpRequested = false;
  #eosFrameSent = false;
  #sequence = 0;
  #bytes = 0;
  #frames = 0;
  #settled = false;
  #started = false;
  #terminalStatus: VoicePlaybackSummary["status"] | null = null;
  #pendingError: VoicePlaybackError | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #resolve: ((summary: VoicePlaybackSummary) => void) | null = null;
  #reject: ((error: VoicePlaybackError) => void) | null = null;

  public constructor(options: VoicePlaybackSenderOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.device_id)) {
      throw new TypeError("playback device_id is invalid");
    }
    const staticPcm = options.pcm;
    if (staticPcm !== undefined && (!(staticPcm instanceof Uint8Array) || staticPcm.byteLength < 2
        || staticPcm.byteLength > PLAYBACK_MAX_PCM_BYTES || staticPcm.byteLength % 2 !== 0)) {
      throw new RangeError("playback PCM must be non-empty, even and at most 1,920,000 bytes");
    }
    if (staticPcm === undefined
        && (options.pcm_stream === null || options.pcm_stream === undefined
          || typeof options.pcm_stream[Symbol.asyncIterator] !== "function")) {
      throw new TypeError("playback PCM stream must be an AsyncIterable");
    }
    if (!/^[0-9a-f]{32}$/.test(options.identity.session_id)
        || options.identity.session_id === "0".repeat(32)
        || options.identity.session_id_bytes.byteLength !== 16
        || Buffer.from(options.identity.session_id_bytes).toString("hex") !== options.identity.session_id
        || !Number.isInteger(options.identity.stream_id) || options.identity.stream_id < 1
        || options.identity.stream_id > 0xffff_ffff
        || !Number.isInteger(options.identity.epoch) || options.identity.epoch < 1
        || options.identity.epoch > 0xffff_ffff) {
      throw new TypeError("playback identity is invalid");
    }
    const maxInflight = options.max_inflight_frames ?? PLAYBACK_MAX_INFLIGHT_FRAMES;
    const timeout = options.timeout_ms ?? PLAYBACK_DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 64
        || !Number.isInteger(timeout) || timeout < 1_000 || timeout > PLAYBACK_MAX_TIMEOUT_MS) {
      throw new RangeError("playback flow and timeout bounds are invalid");
    }
    this.#deviceId = options.device_id;
    this.#identity = {
      ...options.identity,
      session_id_bytes: options.identity.session_id_bytes.slice(),
    };
    if (staticPcm !== undefined) {
      this.#ownedInput = Uint8Array.from(staticPcm);
      const ownedInput = this.#ownedInput;
      this.#source = (async function* (): AsyncGenerator<Uint8Array> {
        yield ownedInput;
      })();
    } else {
      this.#source = options.pcm_stream[Symbol.asyncIterator]();
    }
    this.#wire = options.wire;
    this.#maxInflightFrames = maxInflight;
    this.#timeoutMs = timeout;
  }

  public get identity(): VoicePlaybackIdentity {
    return { ...this.#identity, session_id_bytes: this.#identity.session_id_bytes.slice() };
  }

  public get retained_pcm_bytes(): number {
    let retained = 0;
    if (this.#ownedInput?.some((value) => value !== 0) === true) {
      retained += this.#ownedInput.byteLength;
    }
    if (this.#sourceChunk?.some((value) => value !== 0) === true) {
      retained += this.#sourceChunk.byteLength - this.#sourceChunkOffset;
    }
    if (this.#framePcm.some((value) => value !== 0)) retained += this.#frameBytes;
    return retained;
  }

  public matches(message: VoiceControlMessage): boolean {
    return message.session_id === this.#identity.session_id
      && message.stream_id === this.#identity.stream_id
      && message.epoch === this.#identity.epoch;
  }

  public start(signal?: AbortSignal): Promise<VoicePlaybackSummary> {
    if (this.#started) throw new VoicePlaybackError("INVALID_CONTROL", "playback sender can start only once");
    this.#started = true;
    if (signalAborted(signal)) {
      this.#settled = true;
      this.#stopSource();
      return Promise.reject(new VoicePlaybackError("CANCELLED", "playback was cancelled before open"));
    }
    const result = new Promise<VoicePlaybackSummary>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    const onAbort = (): void => { this.cancel("user"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#timer = setTimeout(() => {
      this.#beginTimedFailure(
        new VoicePlaybackError("TIMEOUT", "playback session exceeded its deadline"),
      );
    }, this.#timeoutMs);
    this.#timer.unref();
    try {
      const open = validateVoiceControlMessage({
        ...base(this.#identity),
        type: "session.open",
        direction: "playback",
        format: {
          encoding: "pcm_s16le",
          sample_rate_hz: VOICE_SAMPLE_RATE_HZ,
          channels: VOICE_CHANNELS,
          bits_per_sample: VOICE_BITS_PER_SAMPLE,
          frame_samples: VOICE_FRAME_SAMPLES,
        },
        max_inflight_frames: this.#maxInflightFrames,
      });
      this.#flow.acceptControl(open);
      this.#wire.sendControl(open);
      if (signalAborted(signal)) onAbort();
    } catch (error) {
      this.#fail(new VoicePlaybackError("UNAVAILABLE", "failed to open playback session", { cause: error }));
    }
    void result.finally(() => signal?.removeEventListener("abort", onAbort)).catch(() => undefined);
    return result;
  }

  public handleControl(message: VoiceControlMessage): void {
    if (this.#settled || !this.matches(message)) {
      throw new VoicePlaybackError("INVALID_CONTROL", "playback control identity is stale");
    }
    try {
      if (message.type === "session.cancel" && this.#flow.state === "cancelled") {
        this.#terminalStatus = "cancelled";
        return;
      }
      if (message.type === "error" && this.#flow.state === "error") {
        this.#terminalStatus = "failed";
        return;
      }
      this.#flow.acceptControl(message);
      if (message.type === "session.ready" || message.type === "credit") {
        this.#requestPump();
        return;
      }
      if (message.type === "session.cancel") {
        this.#terminalStatus = "cancelled";
        this.#stopSource();
        return;
      }
      if (message.type === "error") {
        this.#terminalStatus = "failed";
        this.#stopSource();
        return;
      }
      if (message.type === "session.closed") {
        const status = message.status as VoicePlaybackSummary["status"];
        if (this.#terminalStatus !== null && status !== this.#terminalStatus) {
          throw new VoiceProtocolError("INVALID_TERMINAL", "playback terminal status changed");
        }
        if (this.#pendingError !== null) {
          this.#rejectPendingError();
        } else {
          this.#settle(status, Number(message.dropped_frames));
        }
        return;
      }
      throw new VoiceProtocolError("INVALID_CONTROL", `device cannot send ${message.type} to playback sender`);
    } catch (error) {
      this.#beginProtocolFailure(new VoicePlaybackError(
        "INVALID_CONTROL", "playback control violated protocol", {
        cause: error,
      }));
    }
  }

  public cancel(reason: "barge_in" | "timeout" | "disconnect" | "provider_error" | "user"): void {
    if (this.#settled) return;
    this.#stopSource();
    const state = this.#flow.state;
    if (state === "cancelled" && this.#terminalStatus === "cancelled") return;
    if (state === "opened" || state === "ready" || state === "eos") {
      try {
        const cancel = validateVoiceControlMessage({
          ...base(this.#identity), type: "session.cancel", reason,
        });
        this.#flow.acceptControl(cancel);
        this.#terminalStatus = "cancelled";
        this.#wire.sendControl(cancel);
        return;
      } catch (error) {
        this.#fail(new VoicePlaybackError("UNAVAILABLE", "failed to cancel playback", { cause: error }));
        return;
      }
    }
    this.#fail(new VoicePlaybackError("CANCELLED", "playback was cancelled"));
  }

  public disconnect(): void {
    this.#fail(new VoicePlaybackError("DISCONNECTED", "playback transport disconnected"));
  }

  #requestPump(): void {
    if (this.#pumpRunning) {
      this.#pumpRequested = true;
      return;
    }
    this.#pumpRunning = true;
    void this.#pump().catch((error: unknown) => {
      this.#beginSourceFailure(new VoicePlaybackError(
        "UNAVAILABLE", "playback PCM source failed", { cause: error },
      ));
    }).finally(() => {
      this.#pumpRunning = false;
      if (this.#pumpRequested && !this.#settled) {
        this.#pumpRequested = false;
        this.#requestPump();
      }
    });
  }

  async #pump(): Promise<void> {
    while (!this.#settled && !this.#sourceStopped && this.#flow.state === "ready"
           && this.#flow.availableCredit > 0 && !this.#eosFrameSent) {
      const prepared = await this.#prepareFrame();
      if (prepared === null || this.#settled || this.#sourceStopped
          || this.#flow.state !== "ready" || this.#flow.availableCredit <= 0) {
        return;
      }
      const { payloadBytes, eos } = prepared;
      const frameSamples = payloadBytes / 2;
      const header: VoiceFrameHeader = {
        kind: "playback_pcm",
        flags: eos ? VOICE_FLAG_END_OF_STREAM : 0,
        sessionId: this.#identity.session_id_bytes,
        streamId: this.#identity.stream_id,
        epoch: this.#identity.epoch,
        sequence: this.#sequence,
        captureTimeUs: 0n,
        payloadBytes,
        sampleRateHz: VOICE_SAMPLE_RATE_HZ,
        frameSamples,
        channels: VOICE_CHANNELS,
        bitsPerSample: VOICE_BITS_PER_SAMPLE,
      };
      const message = new Uint8Array(VOICE_HEADER_BYTES + payloadBytes);
      message.set(encodeVoiceFrameHeader(header));
      message.set(this.#framePcm.subarray(0, payloadBytes), VOICE_HEADER_BYTES);
      this.#flow.recordFrameSent(header);
      try {
        this.#wire.sendBinary(message);
      } catch (error) {
        message.fill(0);
        throw error;
      }
      this.#framePcm.fill(0, 0, payloadBytes);
      this.#frameBytes = 0;
      this.#bytes += payloadBytes;
      this.#frames++;
      this.#sequence++;
      if (eos) {
        this.#eosFrameSent = true;
        break;
      }
    }
    this.#sendEosWhenPriorFramesAreAcknowledged();
  }

  async #prepareFrame(): Promise<{ readonly payloadBytes: number; readonly eos: boolean } | null> {
    while (!this.#settled && !this.#sourceStopped) {
      while (this.#frameBytes < VOICE_FRAME_PAYLOAD_BYTES && this.#sourceChunk !== null) {
        const available = this.#sourceChunk.byteLength - this.#sourceChunkOffset;
        const copied = Math.min(VOICE_FRAME_PAYLOAD_BYTES - this.#frameBytes, available);
        this.#framePcm.set(
          this.#sourceChunk.subarray(this.#sourceChunkOffset, this.#sourceChunkOffset + copied),
          this.#frameBytes,
        );
        this.#sourceChunk.fill(0, this.#sourceChunkOffset, this.#sourceChunkOffset + copied);
        this.#sourceChunkOffset += copied;
        this.#frameBytes += copied;
        if (this.#sourceChunkOffset === this.#sourceChunk.byteLength) {
          this.#sourceChunk.fill(0);
          this.#sourceChunk = null;
          this.#sourceChunkOffset = 0;
        }
      }

      if (this.#frameBytes === VOICE_FRAME_PAYLOAD_BYTES && this.#sourceChunk !== null) {
        return { payloadBytes: this.#frameBytes, eos: false };
      }
      if (this.#sourceDone) {
        if (this.#frameBytes === 0) {
          if (this.#sourceBytes === 0) {
            this.#beginSourceFailure(new VoicePlaybackError(
              "UNAVAILABLE", "playback PCM stream ended without audio",
            ));
          }
          return null;
        }
        if (this.#frameBytes % 2 !== 0) {
          this.#beginSourceFailure(new VoicePlaybackError(
            "LIMIT_EXCEEDED", "playback PCM stream has an odd final byte count",
          ));
          return null;
        }
        return { payloadBytes: this.#frameBytes, eos: true };
      }

      const loaded = await this.#loadSourceChunk();
      if (!loaded && !this.#sourceDone) return null;
      if (this.#frameBytes === VOICE_FRAME_PAYLOAD_BYTES && this.#sourceChunk !== null) {
        return { payloadBytes: this.#frameBytes, eos: false };
      }
    }
    return null;
  }

  async #loadSourceChunk(): Promise<boolean> {
    let item: IteratorResult<Uint8Array>;
    try {
      item = await this.#source.next();
    } catch (error) {
      if (!this.#sourceStopped && !this.#settled) {
        this.#beginSourceFailure(new VoicePlaybackError(
          "UNAVAILABLE", "playback PCM source failed", { cause: error },
        ));
      }
      return false;
    }
    if (item.done === true) {
      this.#sourceDone = true;
      return false;
    }
    const chunk: unknown = item.value;
    if (!(chunk instanceof Uint8Array)) {
      this.#beginSourceFailure(new VoicePlaybackError(
        "UNAVAILABLE", "playback PCM source yielded a non-Uint8Array chunk",
      ));
      return false;
    }
    let retained: Uint8Array | null = null;
    try {
      if (chunk.byteLength === 0) {
        this.#beginSourceFailure(new VoicePlaybackError(
          "UNAVAILABLE", "playback PCM source yielded an empty chunk",
        ));
        return false;
      }
      if (this.#sourceBytes + chunk.byteLength > PLAYBACK_MAX_PCM_BYTES) {
        this.#beginSourceFailure(new VoicePlaybackError(
          "LIMIT_EXCEEDED", "playback PCM stream exceeded 1,920,000 bytes",
        ));
        return false;
      }
      retained = Uint8Array.from(chunk);
      this.#sourceBytes += retained.byteLength;
    } finally {
      try {
        chunk.fill(0);
      } catch (error) {
        retained?.fill(0);
        throw error;
      }
    }
    if (this.#sourceStopped || this.#settled) {
      retained?.fill(0);
      return false;
    }
    this.#sourceChunk = retained;
    this.#sourceChunkOffset = 0;
    return true;
  }

  #sendEosWhenPriorFramesAreAcknowledged(): void {
    if (this.#flow.state !== "ready" || !this.#eosFrameSent
        || this.#flow.outstandingFrames > 1) return;
    const eosControl = validateVoiceControlMessage({
      ...base(this.#identity),
      type: "session.eos",
      final_sequence: this.#sequence - 1,
      reason: "source_complete",
    });
    this.#flow.acceptControl(eosControl);
    this.#wire.sendControl(eosControl);
  }

  #settle(status: VoicePlaybackSummary["status"], droppedFrames: number): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimer();
    this.#stopSource();
    this.#resolve?.({
      schema_version: 1,
      device_id: this.#deviceId,
      session_id: this.#identity.session_id,
      stream_id: this.#identity.stream_id,
      epoch: this.#identity.epoch,
      status,
      frames: this.#frames,
      bytes: this.#bytes,
      dropped_frames: droppedFrames,
    });
    this.#resolve = null;
    this.#reject = null;
  }

  #fail(error: VoicePlaybackError): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimer();
    this.#stopSource();
    this.#reject?.(error);
    this.#resolve = null;
    this.#reject = null;
  }

  #beginTimedFailure(error: VoicePlaybackError): void {
    if (this.#settled || this.#pendingError !== null) return;
    this.#pendingError = error;
    try {
      this.cancel("timeout");
    } catch {
      this.#rejectPendingError();
      return;
    }
    if (this.#settled) return;
    this.#scheduleTerminalGrace();
  }

  #beginSourceFailure(error: VoicePlaybackError): void {
    if (this.#settled || this.#pendingError !== null || this.#sourceStopped) return;
    this.#pendingError = error;
    this.#stopSource();
    try {
      this.cancel("provider_error");
    } catch {
      this.#rejectPendingError();
      return;
    }
    if (this.#settled) return;
    this.#scheduleTerminalGrace();
  }

  #beginProtocolFailure(error: VoicePlaybackError): void {
    if (this.#settled || this.#pendingError !== null) return;
    this.#pendingError = error;
    this.#stopSource();
    try {
      if (this.#flow.state === "cancelled" || this.#flow.state === "error") {
        this.#scheduleTerminalGrace();
        return;
      }
      const wireError = validateVoiceControlMessage({
        ...base(this.#identity), type: "error", code: "INVALID_MESSAGE",
      });
      this.#flow.acceptControl(wireError);
      this.#terminalStatus = "failed";
      this.#wire.sendControl(wireError);
      this.#scheduleTerminalGrace();
    } catch {
      this.#rejectPendingError();
    }
  }

  #scheduleTerminalGrace(): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => this.#rejectPendingError(), PLAYBACK_TERMINAL_GRACE_MS);
    this.#timer.unref();
  }

  #rejectPendingError(): void {
    if (this.#settled || this.#pendingError === null) return;
    const error = this.#pendingError;
    this.#pendingError = null;
    this.#settled = true;
    this.#clearTimer();
    this.#stopSource();
    this.#reject?.(error);
    this.#resolve = null;
    this.#reject = null;
  }

  #stopSource(): void {
    if (!this.#sourceStopped) {
      this.#sourceStopped = true;
      try {
        const close = this.#source.return;
        if (typeof close === "function") {
          void Promise.resolve(close.call(this.#source)).catch(() => undefined);
        }
      } catch {
        // Source cleanup is best-effort; owned PCM is still synchronously wiped below.
      }
    }
    this.#ownedInput?.fill(0);
    this.#sourceChunk?.fill(0);
    this.#sourceChunk = null;
    this.#sourceChunkOffset = 0;
    this.#framePcm.fill(0);
    this.#frameBytes = 0;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

export const voicePlaybackSenderInternals = {
  PLAYBACK_MAX_PCM_BYTES,
  PLAYBACK_MAX_INFLIGHT_FRAMES,
};
