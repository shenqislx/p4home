import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";

import WebSocket, { WebSocketServer } from "ws";

import {
  decodeVoiceFrame,
  validateVoiceControlMessage,
  VoiceProtocolError,
  VoiceSessionFlowTracker,
  VOICE_FLAG_END_OF_STREAM,
  VOICE_FRAME_PAYLOAD_BYTES,
  VOICE_HEADER_BYTES,
  type DecodedVoiceFrame,
  type VoiceControlMessage,
} from "@p4home/contracts";
import {
  createVoicePlaybackIdentity,
  VoicePlaybackError,
  VoicePlaybackSender,
  type VoicePlaybackSummary,
} from "./voice-playback-sender.ts";

const VOICE_WEBSOCKET_PATH = "/v1/voice";
const VOICE_TOKEN_MIN_BYTES = 32;
const VOICE_TOKEN_MAX_BYTES = 255;
const VOICE_MAX_CONTROL_BYTES = 4096;
const VOICE_MAX_BINARY_BYTES = VOICE_HEADER_BYTES + VOICE_FRAME_PAYLOAD_BYTES;
const VOICE_MAX_SESSION_FRAMES = 1500;
const VOICE_INITIAL_CREDIT_FRAMES = 8;
const VOICE_MAX_FRAME_RATE_PER_SECOND = 100;
const VOICE_DEFAULT_SESSION_TIMEOUT_MS = 45_000;
const VOICE_MAX_SESSION_TIMEOUT_MS = 60_000;
const VOICE_MAX_COMPLETED_SUMMARIES = 4_096;
const VOICE_MAX_SESSION_OPENS_PER_MINUTE = 60;
const VOICE_MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024;
const VOICE_DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const VOICE_MAX_HANDSHAKE_TIMEOUT_MS = 10_000;

type VoiceWireErrorCode = "INVALID_MESSAGE" | "INVALID_FRAME" | "LIMIT_EXCEEDED" | "STALE_EPOCH" | "UNAVAILABLE";

export interface VoiceWebSocketServerTlsOptions {
  readonly key: HttpsServerOptions["key"];
  readonly cert: HttpsServerOptions["cert"];
}

export interface VoiceCaptureSummary {
  readonly device_id: string;
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  readonly frames: number;
  readonly bytes: number;
  readonly dropped_frames: number;
  readonly peak_abs: number;
  readonly eos: boolean;
}

export interface VoiceCaptureSink {
  onSessionOpen(summary: VoiceCaptureSummary): void;
  onFrame(summary: VoiceCaptureSummary, frame: DecodedVoiceFrame): void;
  onSessionClosed(summary: VoiceCaptureSummary): void;
  onDeviceDisconnect?(deviceId: string): void;
}

export interface VoiceDispatchContext {
  readonly device_id: string;
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
}

export class AggregateVoiceCaptureSink implements VoiceCaptureSink {
  readonly #completed: VoiceCaptureSummary[] = [];
  readonly #active = new Map<string, VoiceCaptureSummary>();
  readonly #maxCompleted: number;

  public constructor(maxCompleted = 256) {
    if (!Number.isInteger(maxCompleted) || maxCompleted < 0
        || maxCompleted > VOICE_MAX_COMPLETED_SUMMARIES) {
      throw new RangeError("max completed voice summaries must be bounded");
    }
    this.#maxCompleted = maxCompleted;
  }

  static #key(summary: VoiceCaptureSummary): string {
    return `${summary.device_id}\u0000${summary.session_id}\u0000${summary.stream_id}\u0000${summary.epoch}`;
  }

  public onSessionOpen(summary: VoiceCaptureSummary): void {
    this.#active.set(AggregateVoiceCaptureSink.#key(summary), structuredClone(summary));
  }

  public onFrame(summary: VoiceCaptureSummary, _frame: DecodedVoiceFrame): void {
    this.#active.set(AggregateVoiceCaptureSink.#key(summary), structuredClone(summary));
  }

  public onSessionClosed(summary: VoiceCaptureSummary): void {
    this.#active.delete(AggregateVoiceCaptureSink.#key(summary));
    if (this.#maxCompleted > 0) {
      this.#completed.push(structuredClone(summary));
      if (this.#completed.length > this.#maxCompleted) this.#completed.shift();
    }
  }

  public get active(): readonly VoiceCaptureSummary[] {
    return structuredClone([...this.#active.values()]);
  }

  public get completed(): readonly VoiceCaptureSummary[] {
    return structuredClone(this.#completed);
  }
}

export interface VoiceWebSocketServerOptions {
  readonly host: string;
  readonly port: number;
  readonly device_tokens: Readonly<Record<string, string>>;
  readonly tls?: VoiceWebSocketServerTlsOptions;
  readonly allow_insecure_loopback_test?: boolean;
  readonly path?: string;
  readonly max_connections?: number;
  readonly max_session_frames?: number;
  readonly initial_credit_frames?: number;
  readonly max_frame_rate_per_second?: number;
  readonly session_timeout_ms?: number;
  readonly max_session_opens_per_minute?: number;
  readonly max_buffered_response_bytes?: number;
  readonly handshake_timeout_ms?: number;
  readonly sink?: VoiceCaptureSink;
  readonly on_device_disconnect?: (deviceId: string) => void;
}

export interface VoiceWebSocketServerAddress {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly path: string;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function fixedTimeTokenMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
}

function rawDataBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function parseControl(data: WebSocket.RawData): VoiceControlMessage {
  const bytes = rawDataBuffer(data);
  if (bytes.byteLength > VOICE_MAX_CONTROL_BYTES) {
    throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice control frame exceeds 4 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new VoiceProtocolError("INVALID_CONTROL", "voice control frame is not valid JSON");
  }
  return validateVoiceControlMessage(value);
}

function controlBase(message: VoiceControlMessage): Record<string, unknown> {
  return {
    protocol_version: 1,
    session_id: message.session_id,
    stream_id: message.stream_id,
    epoch: message.epoch,
  };
}

function pcmPeak(payload: Uint8Array): number {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let peak = 0;
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

class VoiceCaptureReceiver {
  readonly #deviceId: string;
  readonly #sink: VoiceCaptureSink;
  readonly #maxSessionFrames: number;
  readonly #initialCreditFrames: number;
  readonly #acceptEpoch: (epoch: number) => boolean;
  readonly #sessionTimeoutMs: number;
  readonly #onSessionTimeout: (receiver: VoiceCaptureReceiver) => void;
  readonly #maxFrameRatePerSecond: number;
  #flow: VoiceSessionFlowTracker | null = null;
  #identity: VoiceControlMessage | null = null;
  #summary: VoiceCaptureSummary | null = null;
  #nextSequence = 0;
  #rateWindowStartedMs = Date.now();
  #rateWindowFrames = 0;
  #sessionDeadline: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    deviceId: string,
    sink: VoiceCaptureSink,
    maxSessionFrames: number,
    initialCreditFrames: number,
    maxFrameRatePerSecond: number,
    sessionTimeoutMs: number,
    acceptEpoch: (epoch: number) => boolean,
    onSessionTimeout: (receiver: VoiceCaptureReceiver) => void,
  ) {
    this.#deviceId = deviceId;
    this.#sink = sink;
    this.#maxSessionFrames = maxSessionFrames;
    this.#initialCreditFrames = initialCreditFrames;
    this.#maxFrameRatePerSecond = maxFrameRatePerSecond;
    this.#sessionTimeoutMs = sessionTimeoutMs;
    this.#acceptEpoch = acceptEpoch;
    this.#onSessionTimeout = onSessionTimeout;
  }

  public handleControl(message: VoiceControlMessage): readonly VoiceControlMessage[] {
    if (message.type === "session.open") {
      if (this.#flow !== null || message.direction !== "capture" || !this.#acceptEpoch(message.epoch)) {
        throw new VoiceProtocolError("STALE_EPOCH", "voice session is duplicate, stale or not capture");
      }
      const flow = new VoiceSessionFlowTracker();
      flow.acceptControl(message);
      const requestedWindow = Number(message.max_inflight_frames);
      const initialCredit = Math.min(this.#initialCreditFrames, requestedWindow);
      const ready = validateVoiceControlMessage({
        ...controlBase(message),
        type: "session.ready",
        initial_credit_frames: initialCredit,
      });
      flow.acceptControl(ready);
      this.#flow = flow;
      this.#identity = message;
      this.#nextSequence = 0;
      this.#rateWindowStartedMs = Date.now();
      this.#rateWindowFrames = 0;
      this.#summary = {
        device_id: this.#deviceId,
        session_id: message.session_id,
        stream_id: message.stream_id,
        epoch: message.epoch,
        status: "active",
        frames: 0,
        bytes: 0,
        dropped_frames: 0,
        peak_abs: 0,
        eos: false,
      };
      this.#sink.onSessionOpen(this.#summary);
      this.#sessionDeadline = setTimeout(
        () => this.#onSessionTimeout(this), this.#sessionTimeoutMs,
      );
      this.#sessionDeadline.unref();
      return [ready];
    }
    const flow = this.#requireActive(message);
    if (message.type === "session.eos") {
      flow.acceptControl(message);
      return [this.#close("completed")];
    }
    if (message.type === "session.cancel") {
      flow.acceptControl(message);
      return [this.#close("cancelled")];
    }
    if (message.type === "error") {
      flow.acceptControl(message);
      return [this.#close("failed")];
    }
    throw new VoiceProtocolError("INVALID_CONTROL", `device cannot send ${message.type} on capture channel`);
  }

  public handleFrame(bytes: Uint8Array): readonly VoiceControlMessage[] {
    const flow = this.#flow;
    const identity = this.#identity;
    const summary = this.#summary;
    if (flow === null || identity === null || summary === null) {
      throw new VoiceProtocolError("INVALID_STATE", "audio arrived before session.open/ready");
    }
    if (summary.frames >= this.#maxSessionFrames) {
      throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice capture session exceeded frame limit");
    }
    const now = Date.now();
    if (now - this.#rateWindowStartedMs >= 1_000) {
      this.#rateWindowStartedMs = now;
      this.#rateWindowFrames = 0;
    }
    if (this.#rateWindowFrames >= this.#maxFrameRatePerSecond) {
      throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice capture frame rate exceeded limit");
    }
    this.#rateWindowFrames++;
    const frame = decodeVoiceFrame(bytes);
    flow.recordFrameSent(frame.header);
    const dropped = frame.header.sequence > this.#nextSequence
      ? frame.header.sequence - this.#nextSequence
      : 0;
    this.#nextSequence = frame.header.sequence === 0xffff_ffff
      ? 0xffff_ffff
      : frame.header.sequence + 1;
    this.#summary = {
      ...summary,
      frames: summary.frames + 1,
      bytes: summary.bytes + frame.payload.byteLength,
      dropped_frames: summary.dropped_frames + dropped,
      peak_abs: Math.max(summary.peak_abs, pcmPeak(frame.payload)),
      eos: (frame.header.flags & VOICE_FLAG_END_OF_STREAM) !== 0,
    };
    this.#sink.onFrame(this.#summary, frame);
    if (this.#summary.eos) return [];
    const credit = validateVoiceControlMessage({
      ...controlBase(identity),
      type: "credit",
      ack_sequence: frame.header.sequence,
      grant_frames: 1,
    });
    flow.acceptControl(credit);
    return [credit];
  }

  public disconnect(): void {
    this.#clearDeadline();
    if (this.#summary !== null && this.#summary.status === "active") {
      this.#summary = { ...this.#summary, status: "cancelled" };
      this.#sink.onSessionClosed(this.#summary);
    }
    this.#flow = null;
    this.#identity = null;
    this.#summary = null;
  }

  public fail(code: VoiceWireErrorCode): readonly VoiceControlMessage[] {
    const flow = this.#flow;
    const identity = this.#identity;
    if (flow === null || identity === null || this.#summary === null) return [];
    const error = validateVoiceControlMessage({
      ...controlBase(identity),
      type: "error",
      code,
    });
    flow.acceptControl(error);
    return [error, this.#close("failed")];
  }

  #requireActive(message: VoiceControlMessage): VoiceSessionFlowTracker {
    if (this.#flow === null || this.#identity === null || this.#summary === null) {
      throw new VoiceProtocolError("INVALID_STATE", "voice control arrived without an active session");
    }
    return this.#flow;
  }

  #close(status: "completed" | "cancelled" | "failed"): VoiceControlMessage {
    const flow = this.#flow;
    const identity = this.#identity;
    const summary = this.#summary;
    if (flow === null || identity === null || summary === null) {
      throw new VoiceProtocolError("INVALID_STATE", "voice session cannot close without identity");
    }
    this.#summary = { ...summary, status };
    const closed = validateVoiceControlMessage({
      ...controlBase(identity),
      type: "session.closed",
      status,
      dropped_frames: this.#summary.dropped_frames,
    });
    flow.acceptControl(closed);
    this.#sink.onSessionClosed(this.#summary);
    this.#clearDeadline();
    this.#flow = null;
    this.#identity = null;
    this.#summary = null;
    return closed;
  }

  #clearDeadline(): void {
    if (this.#sessionDeadline !== null) {
      clearTimeout(this.#sessionDeadline);
      this.#sessionDeadline = null;
    }
  }
}

export class VoiceWebSocketServer {
  readonly #options: VoiceWebSocketServerOptions;
  readonly #deviceTokens: ReadonlyMap<string, string>;
  readonly #path: string;
  readonly #maxConnections: number;
  readonly #maxSessionFrames: number;
  readonly #initialCreditFrames: number;
  readonly #maxFrameRatePerSecond: number;
  readonly #sessionTimeoutMs: number;
  readonly #maxSessionOpensPerMinute: number;
  readonly #maxBufferedResponseBytes: number;
  readonly #handshakeTimeoutMs: number;
  readonly #sink: VoiceCaptureSink;
  readonly #connections = new Map<string, WebSocket>();
  readonly #playbacks = new Map<string, VoicePlaybackSender>();
  readonly #pendingSockets = new Map<Socket, ReturnType<typeof setTimeout>>();
  readonly #highestEpoch = new Map<string, number>();
  readonly #sessionOpenRates = new Map<string, { started_ms: number; count: number }>();
  readonly #webSocketServer: WebSocketServer;
  #server: HttpServer | HttpsServer | null = null;
  #address: VoiceWebSocketServerAddress | null = null;

  public constructor(options: VoiceWebSocketServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError("port must be an integer between 0 and 65535");
    }
    if (options.tls === undefined
        && !(options.allow_insecure_loopback_test === true && isLoopbackHost(options.host))) {
      throw new TypeError("Voice WebSocket requires TLS outside explicit loopback tests");
    }
    const entries = Object.entries(options.device_tokens);
    if (entries.length === 0) throw new TypeError("at least one paired device token is required");
    for (const [deviceId, token] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
        throw new TypeError(`invalid paired device_id ${deviceId}`);
      }
      const bytes = typeof token === "string" ? Buffer.byteLength(token, "utf8") : 0;
      if (bytes < VOICE_TOKEN_MIN_BYTES || bytes > VOICE_TOKEN_MAX_BYTES) {
        throw new TypeError(`device token for ${deviceId} must contain 32 to 255 bytes`);
      }
    }
    this.#options = options;
    this.#deviceTokens = new Map(entries);
    this.#path = options.path ?? VOICE_WEBSOCKET_PATH;
    if (this.#path !== VOICE_WEBSOCKET_PATH) {
      throw new TypeError(`Voice WebSocket path is frozen at ${VOICE_WEBSOCKET_PATH}`);
    }
    this.#maxConnections = options.max_connections ?? entries.length;
    this.#maxSessionFrames = options.max_session_frames ?? VOICE_MAX_SESSION_FRAMES;
    this.#initialCreditFrames = options.initial_credit_frames ?? VOICE_INITIAL_CREDIT_FRAMES;
    this.#maxFrameRatePerSecond = options.max_frame_rate_per_second
      ?? VOICE_MAX_FRAME_RATE_PER_SECOND;
    this.#sessionTimeoutMs = options.session_timeout_ms ?? VOICE_DEFAULT_SESSION_TIMEOUT_MS;
    this.#maxSessionOpensPerMinute = options.max_session_opens_per_minute
      ?? VOICE_MAX_SESSION_OPENS_PER_MINUTE;
    this.#maxBufferedResponseBytes = options.max_buffered_response_bytes
      ?? VOICE_MAX_BUFFERED_RESPONSE_BYTES;
    this.#handshakeTimeoutMs = options.handshake_timeout_ms
      ?? VOICE_DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isInteger(this.#maxConnections) || this.#maxConnections < 1
        || this.#maxConnections > entries.length
        || !Number.isInteger(this.#maxSessionFrames) || this.#maxSessionFrames < 1
        || this.#maxSessionFrames > VOICE_MAX_SESSION_FRAMES
        || !Number.isInteger(this.#initialCreditFrames) || this.#initialCreditFrames < 1
        || this.#initialCreditFrames > 64
        || !Number.isInteger(this.#maxFrameRatePerSecond) || this.#maxFrameRatePerSecond < 1
        || this.#maxFrameRatePerSecond > VOICE_MAX_FRAME_RATE_PER_SECOND
        || !Number.isInteger(this.#sessionTimeoutMs) || this.#sessionTimeoutMs < 10
        || this.#sessionTimeoutMs > VOICE_MAX_SESSION_TIMEOUT_MS
        || !Number.isInteger(this.#maxSessionOpensPerMinute)
        || this.#maxSessionOpensPerMinute < 1
        || this.#maxSessionOpensPerMinute > VOICE_MAX_SESSION_OPENS_PER_MINUTE
        || !Number.isInteger(this.#maxBufferedResponseBytes)
        || this.#maxBufferedResponseBytes < 1
        || this.#maxBufferedResponseBytes > VOICE_MAX_BUFFERED_RESPONSE_BYTES
        || !Number.isInteger(this.#handshakeTimeoutMs) || this.#handshakeTimeoutMs < 10
        || this.#handshakeTimeoutMs > VOICE_MAX_HANDSHAKE_TIMEOUT_MS) {
      throw new RangeError("voice connection, session and credit limits must be positive and bounded");
    }
    this.#sink = options.sink ?? new AggregateVoiceCaptureSink();
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: VOICE_MAX_CONTROL_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  public get address(): VoiceWebSocketServerAddress | null { return this.#address; }
  public get connection_count(): number { return this.#connections.size; }
  public get playback_count(): number { return this.#playbacks.size; }

  public async playback(
    deviceId: string,
    pcm: Uint8Array,
    signal?: AbortSignal,
  ): Promise<VoicePlaybackSummary> {
    const webSocket = this.#connections.get(deviceId);
    if (webSocket === undefined || webSocket.readyState !== WebSocket.OPEN) {
      throw new VoicePlaybackError("UNAVAILABLE", "paired P4 voice socket is unavailable");
    }
    if (this.#playbacks.has(deviceId)) {
      throw new VoicePlaybackError("LIMIT_EXCEEDED", "one playback is already active for this P4");
    }
    let sender: VoicePlaybackSender;
    sender = new VoicePlaybackSender({
      device_id: deviceId,
      identity: createVoicePlaybackIdentity(),
      pcm,
      wire: {
        sendControl: (message) => {
          const text = JSON.stringify(message);
          if (webSocket.readyState !== WebSocket.OPEN
              || webSocket.bufferedAmount + Buffer.byteLength(text, "utf8")
                > this.#maxBufferedResponseBytes) {
            throw new VoicePlaybackError("LIMIT_EXCEEDED", "playback control backpressure limit exceeded");
          }
          webSocket.send(text, { binary: false }, (error) => {
            if (error) sender.disconnect();
          });
        },
        sendBinary: (message) => {
          try {
            if (webSocket.readyState !== WebSocket.OPEN
                || webSocket.bufferedAmount + message.byteLength > this.#maxBufferedResponseBytes) {
              throw new VoicePlaybackError(
                "LIMIT_EXCEEDED", "playback binary backpressure limit exceeded",
              );
            }
            webSocket.send(message, { binary: true }, (error) => {
              message.fill(0);
              if (error) sender.disconnect();
            });
          } catch (error) {
            message.fill(0);
            throw error;
          }
        },
      },
    });
    this.#playbacks.set(deviceId, sender);
    try {
      return await sender.start(signal);
    } finally {
      if (this.#playbacks.get(deviceId) === sender) this.#playbacks.delete(deviceId);
    }
  }

  public async start(): Promise<VoiceWebSocketServerAddress> {
    if (this.#server !== null) throw new Error("Voice WebSocket server is already started");
    const handler = (_request: unknown, response: { writeHead(status: number): void; end(): void }): void => {
      response.writeHead(404);
      response.end();
    };
    const server = this.#options.tls === undefined
      ? createHttpServer(handler)
      : createHttpsServer({
          ...this.#options.tls,
          minVersion: "TLSv1.2",
          handshakeTimeout: this.#handshakeTimeoutMs,
        }, handler);
    this.#server = server;
    server.maxConnections = this.#maxConnections * 2;
    server.headersTimeout = this.#handshakeTimeoutMs;
    server.requestTimeout = this.#handshakeTimeoutMs;
    server.keepAliveTimeout = Math.min(2_000, this.#handshakeTimeoutMs);
    server.on("connection", (socket: Socket) => {
      if (this.#pendingSockets.size >= this.#maxConnections) {
        socket.destroy();
        return;
      }
      this.#trackPendingSocket(socket);
    });
    if (this.#options.tls !== undefined) {
      (server as HttpsServer).on("secureConnection", (tlsSocket: TLSSocket) => {
        const rawSocket = [...this.#pendingSockets.keys()].find((candidate) => (
          candidate !== tlsSocket
          && candidate.remoteAddress === tlsSocket.remoteAddress
          && candidate.remotePort === tlsSocket.remotePort
          && candidate.localAddress === tlsSocket.localAddress
          && candidate.localPort === tlsSocket.localPort
        ));
        if (rawSocket === undefined) {
          tlsSocket.destroy();
          return;
        }
        this.#untrackPendingSocket(rawSocket);
        this.#trackPendingSocket(tlsSocket);
      });
    }
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== this.#path) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const header = request.headers["x-p4-device-id"];
      const deviceId = Array.isArray(header) ? header[0] : header;
      const expected = deviceId === undefined ? undefined : this.#deviceTokens.get(deviceId);
      const authorization = request.headers.authorization;
      const bearer = authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length)
        : null;
      if (deviceId === undefined || expected === undefined || bearer === null
          || !fixedTimeTokenMatch(bearer, expected)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      if (!this.#connections.has(deviceId) && this.#connections.size >= this.#maxConnections) {
        rejectUpgrade(socket, 409, "Conflict");
        return;
      }
      this.#untrackPendingSocket(request.socket);
      this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const previous = this.#connections.get(deviceId);
        if (previous !== undefined && previous.readyState !== WebSocket.CLOSED) {
          this.#playbacks.get(deviceId)?.disconnect();
          this.#sink.onDeviceDisconnect?.(deviceId);
          this.#options.on_device_disconnect?.(deviceId);
          previous.terminate();
        }
        this.#connections.set(deviceId, webSocket);
        const trySendControls = (messages: readonly VoiceControlMessage[]): boolean => {
          try {
            for (const message of messages) {
              const text = JSON.stringify(message);
              if (webSocket.readyState !== WebSocket.OPEN
                  || webSocket.bufferedAmount + Buffer.byteLength(text, "utf8")
                    > this.#maxBufferedResponseBytes) {
                return false;
              }
              webSocket.send(text, { binary: false }, (error) => {
                if (error) webSocket.terminate();
              });
            }
            return true;
          } catch {
            return false;
          }
        };
        const receiver = new VoiceCaptureReceiver(
          deviceId,
          this.#sink,
          this.#maxSessionFrames,
          this.#initialCreditFrames,
          this.#maxFrameRatePerSecond,
          this.#sessionTimeoutMs,
          (epoch) => {
            const now = Date.now();
            let rate = this.#sessionOpenRates.get(deviceId);
            if (rate === undefined || now - rate.started_ms >= 60_000) {
              rate = { started_ms: now, count: 0 };
            }
            if (rate.count >= this.#maxSessionOpensPerMinute) {
              throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice session open rate exceeded limit");
            }
            rate.count++;
            this.#sessionOpenRates.set(deviceId, rate);
            const previousEpoch = this.#highestEpoch.get(deviceId) ?? 0;
            if (epoch <= previousEpoch) return false;
            this.#highestEpoch.set(deviceId, epoch);
            return true;
          },
          (timedOutReceiver) => {
            if (this.#connections.get(deviceId) !== webSocket) return;
            const sent = trySendControls(timedOutReceiver.fail("UNAVAILABLE"));
            timedOutReceiver.disconnect();
            if (sent && webSocket.readyState === WebSocket.OPEN) {
              webSocket.close(1008, "UNAVAILABLE");
            } else {
              webSocket.terminate();
            }
          },
        );
        webSocket.on("message", (data, isBinary) => {
          if (this.#connections.get(deviceId) !== webSocket) return;
          try {
            if (isBinary) {
              const bytes = rawDataBuffer(data);
              if (bytes.byteLength > VOICE_MAX_BINARY_BYTES) {
                throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice binary frame exceeds v1 maximum");
              }
              if (!trySendControls(receiver.handleFrame(bytes))) {
                throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice response backpressure limit exceeded");
              }
            } else {
              const message = parseControl(data);
              const playback = this.#playbacks.get(deviceId);
              if (playback !== undefined && playback.matches(message)
                  && message.type !== "session.open") {
                playback.handleControl(message);
              } else {
                if (playback !== undefined && message.type === "session.open"
                    && message.direction === "capture") {
                  playback.cancel("barge_in");
                }
                if (!trySendControls(receiver.handleControl(message))) {
                  throw new VoiceProtocolError("LIMIT_EXCEEDED", "voice response backpressure limit exceeded");
                }
              }
            }
          } catch (error) {
            const reason: VoiceWireErrorCode = error instanceof VoiceProtocolError
              ? error.code === "LIMIT_EXCEEDED" ? "LIMIT_EXCEEDED"
                : error.code === "STALE_EPOCH" ? "STALE_EPOCH"
                  : isBinary ? "INVALID_FRAME" : "INVALID_MESSAGE"
              : "INVALID_MESSAGE";
            let sent = false;
            try {
              sent = trySendControls(receiver.fail(reason));
            } catch {
              sent = false;
            }
            receiver.disconnect();
            if (sent && webSocket.readyState === WebSocket.OPEN) {
              webSocket.close(1008, reason);
            } else {
              webSocket.terminate();
            }
          }
        });
        webSocket.once("close", () => {
          receiver.disconnect();
          if (this.#connections.get(deviceId) === webSocket) {
            this.#playbacks.get(deviceId)?.disconnect();
            this.#sink.onDeviceDisconnect?.(deviceId);
            this.#options.on_device_disconnect?.(deviceId);
            this.#connections.delete(deviceId);
          }
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#options.port, this.#options.host);
      });
    } catch (error) {
      this.#server = null;
      throw error;
    }
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("Voice WebSocket server did not bind a TCP address");
    }
    this.#address = {
      host: this.#options.host,
      port: bound.port,
      secure: this.#options.tls !== undefined,
      path: this.#path,
    };
    return this.#address;
  }

  public async close(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    for (const socket of this.#pendingSockets.keys()) socket.destroy();
    for (const timer of this.#pendingSockets.values()) clearTimeout(timer);
    this.#pendingSockets.clear();
    for (const [deviceId, connection] of this.#connections) {
      this.#sink.onDeviceDisconnect?.(deviceId);
      this.#options.on_device_disconnect?.(deviceId);
      connection.terminate();
    }
    for (const playback of this.#playbacks.values()) playback.disconnect();
    this.#playbacks.clear();
    this.#connections.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.#server = null;
    this.#address = null;
  }

  #trackPendingSocket(socket: Socket): void {
    const timer = setTimeout(() => socket.destroy(), this.#handshakeTimeoutMs);
    timer.unref();
    this.#pendingSockets.set(socket, timer);
    socket.once("close", () => this.#untrackPendingSocket(socket));
  }

  #untrackPendingSocket(socket: Socket): void {
    const timer = this.#pendingSockets.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.#pendingSockets.delete(socket);
  }
}
