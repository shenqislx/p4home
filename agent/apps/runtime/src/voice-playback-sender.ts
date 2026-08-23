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
  sendBinary(message: Uint8Array): void;
}

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
  readonly #pcm: Uint8Array;
  readonly #wire: VoicePlaybackWire;
  readonly #flow = new VoiceSessionFlowTracker();
  readonly #timeoutMs: number;
  readonly #maxInflightFrames: number;
  #sequence = 0;
  #offset = 0;
  #frames = 0;
  #settled = false;
  #started = false;
  #terminalStatus: VoicePlaybackSummary["status"] | null = null;
  #pendingError: VoicePlaybackError | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #resolve: ((summary: VoicePlaybackSummary) => void) | null = null;
  #reject: ((error: VoicePlaybackError) => void) | null = null;

  public constructor(options: {
    readonly device_id: string;
    readonly identity: VoicePlaybackIdentity;
    readonly pcm: Uint8Array;
    readonly wire: VoicePlaybackWire;
    readonly max_inflight_frames?: number;
    readonly timeout_ms?: number;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.device_id)) {
      throw new TypeError("playback device_id is invalid");
    }
    if (!(options.pcm instanceof Uint8Array) || options.pcm.byteLength < 2
        || options.pcm.byteLength > PLAYBACK_MAX_PCM_BYTES || options.pcm.byteLength % 2 !== 0) {
      throw new RangeError("playback PCM must be non-empty, even and at most 1,920,000 bytes");
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
    this.#pcm = options.pcm.slice();
    this.#wire = options.wire;
    this.#maxInflightFrames = maxInflight;
    this.#timeoutMs = timeout;
  }

  public get identity(): VoicePlaybackIdentity {
    return { ...this.#identity, session_id_bytes: this.#identity.session_id_bytes.slice() };
  }

  public get retained_pcm_bytes(): number {
    return this.#pcm.some((value) => value !== 0) ? this.#pcm.byteLength : 0;
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
      this.#pcm.fill(0);
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
        this.#pump();
        return;
      }
      if (message.type === "session.cancel") {
        this.#terminalStatus = "cancelled";
        return;
      }
      if (message.type === "error") {
        this.#terminalStatus = "failed";
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

  #pump(): void {
    while (!this.#settled && this.#flow.state === "ready" && this.#flow.availableCredit > 0
           && this.#offset < this.#pcm.byteLength) {
      const remaining = this.#pcm.byteLength - this.#offset;
      const payloadBytes = Math.min(remaining, VOICE_FRAME_PAYLOAD_BYTES);
      const frameSamples = payloadBytes / 2;
      const eos = this.#offset + payloadBytes === this.#pcm.byteLength;
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
      message.set(this.#pcm.subarray(this.#offset, this.#offset + payloadBytes), VOICE_HEADER_BYTES);
      this.#flow.recordFrameSent(header);
      try {
        this.#wire.sendBinary(message);
      } catch (error) {
        message.fill(0);
        throw error;
      }
      this.#offset += payloadBytes;
      this.#frames++;
      this.#sequence++;
      if (eos) break;
    }
    this.#sendEosWhenPriorFramesAreAcknowledged();
  }

  #sendEosWhenPriorFramesAreAcknowledged(): void {
    if (this.#flow.state !== "ready" || this.#offset !== this.#pcm.byteLength
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
    this.#pcm.fill(0);
    this.#resolve?.({
      schema_version: 1,
      device_id: this.#deviceId,
      session_id: this.#identity.session_id,
      stream_id: this.#identity.stream_id,
      epoch: this.#identity.epoch,
      status,
      frames: this.#frames,
      bytes: this.#offset,
      dropped_frames: droppedFrames,
    });
    this.#resolve = null;
    this.#reject = null;
  }

  #fail(error: VoicePlaybackError): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#clearTimer();
    this.#pcm.fill(0);
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

  #beginProtocolFailure(error: VoicePlaybackError): void {
    if (this.#settled || this.#pendingError !== null) return;
    this.#pendingError = error;
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
    this.#pcm.fill(0);
    this.#reject?.(error);
    this.#resolve = null;
    this.#reject = null;
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
