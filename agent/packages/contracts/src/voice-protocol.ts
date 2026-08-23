import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CONTROL_SCHEMA_PATH = `${REPOSITORY_ROOT}contracts/voice/v1/control-message.schema.json`;

export const VOICE_PROTOCOL_VERSION = 1 as const;
export const VOICE_HEADER_BYTES = 56;
export const VOICE_SAMPLE_RATE_HZ = 16_000;
export const VOICE_CHANNELS = 1;
export const VOICE_BITS_PER_SAMPLE = 16;
export const VOICE_FRAME_SAMPLES = 320;
export const VOICE_FRAME_PAYLOAD_BYTES = 640;
export const VOICE_FLAG_END_OF_STREAM = 1;
export const VOICE_FLAG_DISCONTINUITY = 2;

export type VoiceFrameKind = "capture_pcm" | "playback_pcm";

export interface VoiceFrameHeader {
  readonly kind: VoiceFrameKind;
  readonly flags: number;
  readonly sessionId: Uint8Array;
  readonly streamId: number;
  readonly epoch: number;
  readonly sequence: number;
  readonly captureTimeUs: bigint;
  readonly payloadBytes: number;
  readonly sampleRateHz: number;
  readonly frameSamples: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

export interface DecodedVoiceFrame {
  readonly header: VoiceFrameHeader;
  readonly payload: Uint8Array;
}

export type VoiceControlMessage = Readonly<Record<string, unknown>> & {
  readonly protocol_version: 1;
  readonly type: string;
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
};

export class VoiceProtocolError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VoiceProtocolError";
  }
}

let controlValidator: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (controlValidator === undefined) {
    controlValidator = new Ajv2020({ allErrors: true, strict: true }).compile(
      JSON.parse(readFileSync(CONTROL_SCHEMA_PATH, "utf8")) as AnySchema,
    );
  }
  return controlValidator;
}

function uint32(value: number, label: string, positive = false): void {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0) || value > 0xffff_ffff) {
    throw new VoiceProtocolError("INVALID_HEADER", `${label} is outside uint32 range`);
  }
}

function validateHeader(header: VoiceFrameHeader): void {
  if (!(header.sessionId instanceof Uint8Array) || header.sessionId.byteLength !== 16 ||
      header.sessionId.every((value) => value === 0)) {
    throw new VoiceProtocolError("INVALID_SESSION", "session id must be 16 non-zero bytes");
  }
  if (header.kind !== "capture_pcm" && header.kind !== "playback_pcm") {
    throw new VoiceProtocolError("INVALID_KIND", "unsupported frame kind");
  }
  if (!Number.isInteger(header.flags) || header.flags < 0 || header.flags > 3 ||
      (header.flags & ~(VOICE_FLAG_END_OF_STREAM | VOICE_FLAG_DISCONTINUITY)) !== 0) {
    throw new VoiceProtocolError("INVALID_FLAGS", "unsupported frame flags");
  }
  uint32(header.streamId, "stream id", true);
  uint32(header.epoch, "epoch", true);
  uint32(header.sequence, "sequence");
  if (header.sequence === 0xffff_ffff && (header.flags & VOICE_FLAG_END_OF_STREAM) === 0) {
    throw new VoiceProtocolError("INVALID_HEADER", "maximum sequence must terminate the stream");
  }
  if (header.captureTimeUs < 0n || header.captureTimeUs > 0xffff_ffff_ffff_ffffn) {
    throw new VoiceProtocolError("INVALID_HEADER", "timestamp is outside uint64 range");
  }
  if (header.sampleRateHz !== VOICE_SAMPLE_RATE_HZ || header.channels !== VOICE_CHANNELS ||
      header.bitsPerSample !== VOICE_BITS_PER_SAMPLE || header.frameSamples < 1 ||
      header.frameSamples > VOICE_FRAME_SAMPLES ||
      ((header.flags & VOICE_FLAG_END_OF_STREAM) === 0 && header.frameSamples !== VOICE_FRAME_SAMPLES)) {
    throw new VoiceProtocolError("INVALID_GEOMETRY", "PCM geometry does not match Voice Protocol v1");
  }
  const expected = header.frameSamples * header.channels * header.bitsPerSample / 8;
  if (header.payloadBytes !== expected) {
    throw new VoiceProtocolError("INVALID_PAYLOAD", "payload length does not match PCM geometry");
  }
}

export function encodeVoiceFrameHeader(header: VoiceFrameHeader): Uint8Array {
  validateHeader(header);
  const bytes = new Uint8Array(VOICE_HEADER_BYTES);
  bytes.set([0x50, 0x34, 0x56, 0x31], 0);
  bytes[4] = VOICE_PROTOCOL_VERSION;
  bytes[5] = VOICE_HEADER_BYTES;
  bytes[6] = header.kind === "capture_pcm" ? 1 : 2;
  bytes[7] = header.flags;
  bytes.set(header.sessionId, 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(24, header.streamId, true);
  view.setUint32(28, header.epoch, true);
  view.setUint32(32, header.sequence, true);
  view.setBigUint64(36, header.captureTimeUs, true);
  view.setUint32(44, header.payloadBytes, true);
  view.setUint32(48, header.sampleRateHz, true);
  view.setUint16(52, header.frameSamples, true);
  bytes[54] = header.channels;
  bytes[55] = header.bitsPerSample;
  return bytes;
}

export function decodeVoiceFrameHeader(input: Uint8Array): VoiceFrameHeader {
  if (input.byteLength < VOICE_HEADER_BYTES) {
    throw new VoiceProtocolError("INVALID_HEADER", "binary frame is shorter than the fixed header");
  }
  if (input[0] !== 0x50 || input[1] !== 0x34 || input[2] !== 0x56 || input[3] !== 0x31) {
    throw new VoiceProtocolError("INVALID_MAGIC", "binary frame magic is invalid");
  }
  if (input[4] !== VOICE_PROTOCOL_VERSION) {
    throw new VoiceProtocolError("UNSUPPORTED_VERSION", "binary frame version is unsupported");
  }
  if (input[5] !== VOICE_HEADER_BYTES) {
    throw new VoiceProtocolError("INVALID_HEADER", "binary frame header size is invalid");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const kindByte = input[6];
  const header: VoiceFrameHeader = {
    kind: kindByte === 1 ? "capture_pcm" : kindByte === 2 ? "playback_pcm" : ("invalid" as VoiceFrameKind),
    flags: input[7] ?? 0,
    sessionId: input.slice(8, 24),
    streamId: view.getUint32(24, true),
    epoch: view.getUint32(28, true),
    sequence: view.getUint32(32, true),
    captureTimeUs: view.getBigUint64(36, true),
    payloadBytes: view.getUint32(44, true),
    sampleRateHz: view.getUint32(48, true),
    frameSamples: view.getUint16(52, true),
    channels: input[54] ?? 0,
    bitsPerSample: input[55] ?? 0,
  };
  validateHeader(header);
  return header;
}

export function decodeVoiceFrame(input: Uint8Array): DecodedVoiceFrame {
  const header = decodeVoiceFrameHeader(input);
  const expectedBytes = VOICE_HEADER_BYTES + header.payloadBytes;
  if (input.byteLength !== expectedBytes) {
    throw new VoiceProtocolError(
      "INVALID_PAYLOAD",
      `binary frame length ${input.byteLength} does not match ${expectedBytes}`,
    );
  }
  return { header, payload: input.slice(VOICE_HEADER_BYTES) };
}

export function validateVoiceControlMessage(value: unknown): VoiceControlMessage {
  const validate = validator();
  if (!validate(value)) {
    const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new VoiceProtocolError("INVALID_CONTROL", detail ?? "invalid voice control message");
  }
  return structuredClone(value) as VoiceControlMessage;
}

export class VoiceFrameTracker {
  readonly #sessionId: Uint8Array;
  readonly #streamId: number;
  readonly #epoch: number;
  #nextSequence = 0;
  #droppedFrames = 0;
  #ended = false;

  public constructor(sessionId: Uint8Array, streamId: number, epoch: number) {
    validateHeader({
      kind: "capture_pcm", flags: 0, sessionId, streamId, epoch, sequence: 0,
      captureTimeUs: 0n, payloadBytes: VOICE_FRAME_PAYLOAD_BYTES,
      sampleRateHz: VOICE_SAMPLE_RATE_HZ, frameSamples: VOICE_FRAME_SAMPLES,
      channels: VOICE_CHANNELS, bitsPerSample: VOICE_BITS_PER_SAMPLE,
    });
    this.#sessionId = sessionId.slice();
    this.#streamId = streamId;
    this.#epoch = epoch;
  }

  public accept(header: VoiceFrameHeader): void {
    validateHeader(header);
    if (!this.#sessionId.every((value, index) => value === header.sessionId[index]) ||
        this.#streamId !== header.streamId || this.#epoch !== header.epoch) {
      throw new VoiceProtocolError("STALE_FRAME", "frame belongs to another session, stream or epoch");
    }
    if (this.#ended) throw new VoiceProtocolError("AFTER_EOS", "frame arrived after EOS");
    if (header.sequence < this.#nextSequence) throw new VoiceProtocolError("STALE_FRAME", "frame is duplicate or old");
    if (header.sequence > this.#nextSequence) {
      if ((header.flags & VOICE_FLAG_DISCONTINUITY) === 0) {
        throw new VoiceProtocolError("SEQUENCE_GAP", "sequence gap lacks discontinuity flag");
      }
      this.#droppedFrames += header.sequence - this.#nextSequence;
    } else if ((header.flags & VOICE_FLAG_DISCONTINUITY) !== 0) {
      throw new VoiceProtocolError("INVALID_FLAGS", "discontinuity flag does not describe a gap");
    }
    this.#nextSequence = header.sequence === 0xffff_ffff ? 0xffff_ffff : header.sequence + 1;
    this.#ended = (header.flags & VOICE_FLAG_END_OF_STREAM) !== 0;
  }

  public get nextSequence(): number { return this.#nextSequence; }
  public get droppedFrames(): number { return this.#droppedFrames; }
  public get ended(): boolean { return this.#ended; }
}

type VoiceFlowState = "idle" | "opened" | "ready" | "eos" | "cancelled" | "error" | "closed";

function sessionIdBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export class VoiceSessionFlowTracker {
  #state: VoiceFlowState = "idle";
  #sessionId = "";
  #streamId = 0;
  #epoch = 0;
  #maxInflightFrames = 0;
  #frameKind: VoiceFrameKind = "capture_pcm";
  #availableCredit = 0;
  #lastAckSequence = -1;
  #lastSentSequence = -1;
  #outstandingSequences: number[] = [];
  #frames: VoiceFrameTracker | undefined;
  #lastFrameWasEos = false;

  public acceptControl(value: unknown): VoiceControlMessage {
    const message = validateVoiceControlMessage(value);
    const type = message.type;
    if (type === "session.open") {
      if (this.#state !== "idle") this.#fail("INVALID_STATE", "session.open is only valid once");
      this.#sessionId = message.session_id;
      this.#streamId = message.stream_id;
      this.#epoch = message.epoch;
      this.#maxInflightFrames = Number(message.max_inflight_frames);
      this.#frameKind = message.direction === "playback" ? "playback_pcm" : "capture_pcm";
      this.#frames = new VoiceFrameTracker(sessionIdBytes(this.#sessionId), this.#streamId, this.#epoch);
      this.#state = "opened";
      return message;
    }
    this.#requireIdentity(message);
    if (type === "session.ready") {
      if (this.#state !== "opened") this.#fail("INVALID_STATE", "session.ready must follow session.open");
      const initialCredit = Number(message.initial_credit_frames);
      if (initialCredit > this.#maxInflightFrames) {
        this.#fail("LIMIT_EXCEEDED", "initial credit exceeds negotiated window");
      }
      this.#availableCredit = initialCredit;
      this.#state = "ready";
    } else if (type === "credit") {
      if (this.#state !== "ready") this.#fail("INVALID_STATE", "credit requires an active ready session");
      const ackSequence = Number(message.ack_sequence);
      const acknowledgedIndex = this.#outstandingSequences.indexOf(ackSequence);
      if (ackSequence <= this.#lastAckSequence || acknowledgedIndex < 0) {
        this.#fail("INVALID_ACK", "credit ack is stale, unknown or ahead of sent frames");
      }
      const remaining = this.#outstandingSequences.length - acknowledgedIndex - 1;
      const available = this.#availableCredit + Number(message.grant_frames);
      if (available + remaining > this.#maxInflightFrames) {
        this.#fail("LIMIT_EXCEEDED", "credit would exceed negotiated window");
      }
      this.#lastAckSequence = ackSequence;
      this.#outstandingSequences.splice(0, acknowledgedIndex + 1);
      this.#availableCredit = available;
    } else if (type === "session.eos") {
      if (this.#state !== "ready" || !this.#lastFrameWasEos ||
          Number(message.final_sequence) !== this.#lastSentSequence) {
        this.#fail("INVALID_STATE", "session.eos must match the final EOS frame");
      }
      this.#state = "eos";
    } else if (type === "session.cancel") {
      if (this.#state !== "opened" && this.#state !== "ready" && this.#state !== "eos") {
        this.#fail("INVALID_STATE", "session.cancel arrived after a terminal state");
      }
      this.#state = "cancelled";
    } else if (type === "error") {
      if (this.#state !== "opened" && this.#state !== "ready" && this.#state !== "eos") {
        this.#fail("INVALID_STATE", "error arrived after a terminal state");
      }
      this.#state = "error";
    } else if (type === "session.closed") {
      if (this.#state !== "eos" && this.#state !== "cancelled" && this.#state !== "error") {
        this.#fail("INVALID_STATE", "session.closed requires eos, cancel or error");
      }
      const expectedStatus = this.#state === "eos" ? "completed" :
        this.#state === "cancelled" ? "cancelled" : "failed";
      if (message.status !== expectedStatus ||
          Number(message.dropped_frames) !== this.#frames?.droppedFrames) {
        this.#fail("INVALID_TERMINAL", "closed status or dropped-frame count contradicts the session");
      }
      this.#state = "closed";
    }
    return message;
  }

  public recordFrameSent(header: VoiceFrameHeader): void {
    if (this.#state !== "ready" || this.#frames === undefined) {
      this.#fail("INVALID_STATE", "audio frame requires an active ready session");
    }
    if (this.#availableCredit <= 0) this.#fail("CREDIT_EXHAUSTED", "no frame credit remains");
    if (header.kind !== this.#frameKind) {
      this.#fail("INVALID_KIND", "frame direction contradicts session.open");
    }
    this.#frames.accept(header);
    this.#availableCredit--;
    this.#lastSentSequence = header.sequence;
    this.#outstandingSequences.push(header.sequence);
    this.#lastFrameWasEos = (header.flags & VOICE_FLAG_END_OF_STREAM) !== 0;
  }

  public get state(): VoiceFlowState { return this.#state; }
  public get availableCredit(): number { return this.#availableCredit; }
  public get outstandingFrames(): number { return this.#outstandingSequences.length; }

  #requireIdentity(message: VoiceControlMessage): void {
    if (this.#state === "idle" || message.session_id !== this.#sessionId ||
        message.stream_id !== this.#streamId || message.epoch !== this.#epoch) {
      this.#fail("STALE_EPOCH", "control message belongs to another session, stream or epoch");
    }
  }

  #fail(code: string, message: string): never {
    throw new VoiceProtocolError(code, message);
  }
}
