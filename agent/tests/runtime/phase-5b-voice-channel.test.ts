import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  encodeVoiceFrameHeader,
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_FLAG_END_OF_STREAM,
  VOICE_FRAME_PAYLOAD_BYTES,
  VOICE_FRAME_SAMPLES,
  VOICE_HEADER_BYTES,
  VOICE_SAMPLE_RATE_HZ,
  type VoiceControlMessage,
} from "@p4home/contracts";
import {
  AggregateVoiceCaptureSink,
  VoiceWebSocketServer,
} from "@p4home/runtime";
import WebSocket from "ws";

const DEVICE_ID = "p4-phase-5b-test";
const DEVICE_TOKEN = "phase-5b-test-token-0123456789abcdef";
const SESSION_ID = "0102030405060708090a0b0c0d0e0f10";
const TLS_KEY = readFileSync(new URL("../fixtures/voice-test-key.pem", import.meta.url));
const TLS_CERT = readFileSync(new URL("../fixtures/voice-test-cert.pem", import.meta.url));

function control(type: string, extra: Record<string, unknown> = {}, epoch = 1): string {
  return JSON.stringify({
    protocol_version: 1,
    type,
    session_id: SESSION_ID,
    stream_id: 7,
    epoch,
    ...extra,
  });
}

function pcmFrame(sequence: number, flags = 0, sample = 1200, epoch = 1): Uint8Array {
  const payload = new Uint8Array(VOICE_FRAME_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, sample, true);
  }
  const header = encodeVoiceFrameHeader({
    kind: "capture_pcm",
    flags,
    sessionId: Uint8Array.from(SESSION_ID.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)),
    streamId: 7,
    epoch,
    sequence,
    captureTimeUs: BigInt(sequence * 20_000),
    payloadBytes: payload.byteLength,
    sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    frameSamples: VOICE_FRAME_SAMPLES,
    channels: VOICE_CHANNELS,
    bitsPerSample: VOICE_BITS_PER_SAMPLE,
  });
  const frame = new Uint8Array(header.byteLength + payload.byteLength);
  frame.set(header);
  frame.set(payload, header.byteLength);
  return frame;
}

async function connect(address: { host: string; port: number; path: string }): Promise<WebSocket> {
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": DEVICE_ID,
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => (
    error === undefined ? resolve() : reject(error)
  )));
  return address.port;
}

async function nextControl(socket: WebSocket): Promise<VoiceControlMessage> {
  return await new Promise<VoiceControlMessage>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      try {
        assert.equal(isBinary, false);
        cleanup();
        resolve(JSON.parse(data.toString("utf8")) as VoiceControlMessage);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`socket closed before control message: ${code}`));
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function waitClosed(socket: WebSocket): Promise<number> {
  return await new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function nextControls(socket: WebSocket, count: number): Promise<readonly VoiceControlMessage[]> {
  return await new Promise<readonly VoiceControlMessage[]>((resolve, reject) => {
    const messages: VoiceControlMessage[] = [];
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      try {
        assert.equal(isBinary, false);
        messages.push(JSON.parse(data.toString("utf8")) as VoiceControlMessage);
        if (messages.length === count) {
          cleanup();
          resolve(messages);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`socket closed after ${messages.length}/${count} controls: ${code}`));
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

test("independent voice channel authenticates and aggregates bounded PCM without retaining payload", async (t) => {
  const sink = new AggregateVoiceCaptureSink();
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    initial_credit_frames: 2,
    sink,
  });
  const address = await server.start();
  t.after(async () => server.close());

  const rejected = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: { "X-P4-Device-ID": DEVICE_ID },
  });
  await new Promise<void>((resolve, reject) => {
    rejected.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        rejected.terminate();
      }
    });
    rejected.once("open", () => reject(new Error("unauthenticated voice socket opened")));
    rejected.once("error", () => undefined);
  });

  const socket = await connect(address);
  t.after(() => socket.terminate());
  socket.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le",
      sample_rate_hz: 16_000,
      channels: 1,
      bits_per_sample: 16,
      frame_samples: 320,
    },
    max_inflight_frames: 4,
  }));
  const ready = await nextControl(socket);
  assert.equal(ready.type, "session.ready");
  assert.equal(ready.initial_credit_frames, 2);

  socket.send(pcmFrame(0));
  const credit = await nextControl(socket);
  assert.equal(credit.type, "credit");
  assert.equal(credit.ack_sequence, 0);
  assert.equal(credit.grant_frames, 1);

  socket.send(pcmFrame(1, VOICE_FLAG_END_OF_STREAM, -32768));
  socket.send(control("session.eos", { final_sequence: 1, reason: "vad_end" }));
  const closed = await nextControl(socket);
  assert.equal(closed.type, "session.closed");
  assert.equal(closed.status, "completed");
  assert.equal(closed.dropped_frames, 0);
  assert.deepEqual(sink.active, []);
  assert.deepEqual(sink.completed, [{
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    stream_id: 7,
    epoch: 1,
    status: "completed",
    frames: 2,
    bytes: 2 * VOICE_FRAME_PAYLOAD_BYTES,
    dropped_frames: 0,
    peak_abs: 32768,
    eos: true,
  }]);
  assert.equal("payload" in sink.completed[0]!, false);
});

test("voice reconnect requires a higher persisted epoch and invalidates the old socket", async (t) => {
  const sink = new AggregateVoiceCaptureSink();
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    max_connections: 1,
    sink,
  });
  const address = await server.start();
  t.after(async () => server.close());

  const first = await connect(address);
  t.after(() => first.terminate());
  first.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 4));
  assert.equal((await nextControl(first)).type, "session.ready");

  const firstClosed = waitClosed(first);
  const replacement = await connect(address);
  t.after(() => replacement.terminate());
  assert.equal(await firstClosed, 1006);
  assert.equal(server.connection_count, 1);
  assert.equal(sink.completed[0]?.status, "cancelled");

  replacement.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 5));
  assert.equal((await nextControl(replacement)).type, "session.ready");
  replacement.send(control("session.cancel", { reason: "user" }, 5));
  assert.equal((await nextControl(replacement)).type, "session.closed");

  replacement.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 5));
  const staleClosed = waitClosed(replacement);
  assert.equal(await staleClosed, 1008);
});

test("voice channel fails closed on frame flood, oversized binary and non-capture sessions", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    max_session_frames: 1,
  });
  const address = await server.start();
  t.after(async () => server.close());

  const playback = await connect(address);
  playback.send(control("session.open", {
    direction: "playback",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 1));
  assert.equal(await waitClosed(playback), 1008);

  const flood = await connect(address);
  flood.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 2));
  assert.equal((await nextControl(flood)).type, "session.ready");
  flood.send(pcmFrame(0, 0, 100, 2));
  assert.equal((await nextControl(flood)).type, "credit");
  const floodClosed = waitClosed(flood);
  flood.send(pcmFrame(1, 0, 100, 2));
  assert.equal(await floodClosed, 1008);

  const oversized = await connect(address);
  oversized.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 3));
  assert.equal((await nextControl(oversized)).type, "session.ready");
  const oversizedClosed = waitClosed(oversized);
  oversized.send(new Uint8Array(VOICE_HEADER_BYTES + VOICE_FRAME_PAYLOAD_BYTES + 1));
  assert.equal(await oversizedClosed, 1008);
});

test("voice channel rejects cross-session control and EOS without a final EOS frame", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
  });
  const address = await server.start();
  t.after(async () => server.close());

  const wrongIdentity = await connect(address);
  wrongIdentity.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 10));
  assert.equal((await nextControl(wrongIdentity)).type, "session.ready");
  const wrongIdentityClosed = waitClosed(wrongIdentity);
  const wrongIdentityTerminal = nextControls(wrongIdentity, 2);
  wrongIdentity.send(control("session.cancel", { reason: "user" }, 11));
  const [identityError, identityClosed] = await wrongIdentityTerminal;
  assert.equal(identityError?.type, "error");
  assert.equal(identityError?.code, "STALE_EPOCH");
  assert.equal(identityClosed?.type, "session.closed");
  assert.equal(identityClosed?.status, "failed");
  assert.equal(await wrongIdentityClosed, 1008);

  const missingEos = await connect(address);
  missingEos.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 12));
  assert.equal((await nextControl(missingEos)).type, "session.ready");
  missingEos.send(pcmFrame(0, 0, 100, 12));
  assert.equal((await nextControl(missingEos)).type, "credit");
  const missingEosClosed = waitClosed(missingEos);
  missingEos.send(control("session.eos", { final_sequence: 0, reason: "vad_end" }, 12));
  assert.equal(await missingEosClosed, 1008);
});

test("voice channel enforces an independent frame-rate limit", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    max_frame_rate_per_second: 1,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const socket = await connect(address);
  socket.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 20));
  assert.equal((await nextControl(socket)).type, "session.ready");
  socket.send(pcmFrame(0, 0, 100, 20));
  assert.equal((await nextControl(socket)).type, "credit");
  const closed = waitClosed(socket);
  socket.send(pcmFrame(1, 0, 100, 20));
  assert.equal(await closed, 1008);
});

test("voice session deadline emits error and failed terminal while releasing the sink", async (t) => {
  const sink = new AggregateVoiceCaptureSink();
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    session_timeout_ms: 20,
    sink,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const socket = await connect(address);
  socket.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 21));
  assert.equal((await nextControl(socket)).type, "session.ready");
  const closed = waitClosed(socket);
  const [error, terminal] = await nextControls(socket, 2);
  assert.equal(error?.type, "error");
  assert.equal(error?.code, "UNAVAILABLE");
  assert.equal(terminal?.type, "session.closed");
  assert.equal(terminal?.status, "failed");
  assert.equal(await closed, 1008);
  assert.deepEqual(sink.active, []);
  assert.equal(sink.completed.at(-1)?.status, "failed");
});

test("voice response backpressure fails the sink and terminates without an uncaught error", async (t) => {
  const sink = new AggregateVoiceCaptureSink();
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    max_buffered_response_bytes: 1,
    sink,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const socket = await connect(address);
  const closed = waitClosed(socket);
  socket.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 22));
  assert.equal(await closed, 1006);
  assert.deepEqual(sink.active, []);
  assert.equal(sink.completed.at(-1)?.status, "failed");
});

test("unauthenticated slow connections are bounded and timed out", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    handshake_timeout_ms: 20,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const slow = createConnection({ host: address.host, port: address.port });
  await new Promise<void>((resolve, reject) => {
    slow.once("connect", resolve);
    slow.once("error", reject);
  });
  await new Promise<void>((resolve) => slow.once("close", () => resolve()));

  const replacement = await connect(address);
  replacement.terminate();
});

test("authenticated TLS voice socket survives beyond the handshake timeout", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    tls: { key: TLS_KEY, cert: TLS_CERT },
    handshake_timeout_ms: 20,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const socket = new WebSocket(`wss://${address.host}:${address.port}${address.path}`, {
    rejectUnauthorized: false,
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": DEVICE_ID,
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(server.connection_count, 1);
  socket.terminate();
});

test("pending socket capacity rejects max plus one and close does not wait for timeout", async () => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    handshake_timeout_ms: 1_000,
  });
  const address = await server.start();
  const first = createConnection({ host: address.host, port: address.port });
  await new Promise<void>((resolve, reject) => {
    first.once("connect", resolve);
    first.once("error", reject);
  });
  const overflow = createConnection({ host: address.host, port: address.port });
  overflow.once("error", () => undefined);
  await new Promise<void>((resolve) => overflow.once("close", () => resolve()));
  const firstClosed = new Promise<void>((resolve) => first.once("close", () => resolve()));
  await Promise.race([
    server.close(),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("server close waited for pending handshake timeout")), 200,
    )),
  ]);
  await firstClosed;
  assert.equal(first.destroyed, true);
});

test("voice harness exits promptly when signalled before capture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "p4voice-harness-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, "token");
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  const readyPath = join(directory, "ready");
  const resultPath = join(directory, "result.json");
  await Promise.all([
    writeFile(tokenPath, DEVICE_TOKEN),
    writeFile(keyPath, TLS_KEY),
    writeFile(certPath, TLS_CERT),
  ]);
  const port = await freePort();
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/device-harness/src/voice-cli.ts",
  ], {
    cwd: new URL("../../", import.meta.url),
    env: {
      ...process.env,
      P4HOME_HARDWARE_PROFILE: "phase5b_voice",
      P4HOME_AGENT_DEVICE_ID: DEVICE_ID,
      P4HOME_AGENT_DEVICE_TOKEN_FILE: tokenPath,
      P4HOME_AGENT_TLS_KEY_FILE: keyPath,
      P4HOME_AGENT_TLS_CERT_FILE: certPath,
      P4HOME_HARNESS_READY_FILE: readyPath,
      P4HOME_HARNESS_RESULT_FILE: resultPath,
      P4HOME_AGENT_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("voice harness did not become ready")), 5_000);
    const inspect = (chunk: string): void => {
      if (chunk.includes("HARNESS:voice_server:READY")) {
        clearTimeout(timeout);
        child.stdout.off("data", inspect);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code) => reject(new Error(`voice harness exited early: ${code}`)));
  });
  child.kill("SIGTERM");
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("voice harness did not exit promptly after SIGTERM")), 1_000,
    )),
  ]);
  assert.equal(exitCode, 0);
  assert.match(output, /HARNESS:voice_server:STOPPED/);
  assert.doesNotMatch(output, /VERIFY:phase5b:agent_voice_sink:FAIL/);
});

test("aggregate voice sink retains only its configured summary bound", () => {
  const sink = new AggregateVoiceCaptureSink(2);
  for (let epoch = 1; epoch <= 3; epoch++) {
    sink.onSessionClosed({
      device_id: DEVICE_ID,
      session_id: SESSION_ID,
      stream_id: 7,
      epoch,
      status: "cancelled",
      frames: 0,
      bytes: 0,
      dropped_frames: 0,
      peak_abs: 0,
      eos: false,
    });
  }
  assert.deepEqual(sink.completed.map((summary) => summary.epoch), [2, 3]);
  assert.throws(() => new AggregateVoiceCaptureSink(4_097), /bounded/);
});

test("voice session-open churn is bounded across authenticated reconnects", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    max_session_opens_per_minute: 2,
  });
  const address = await server.start();
  t.after(async () => server.close());

  for (const epoch of [40, 41]) {
    const socket = await connect(address);
    socket.send(control("session.open", {
      direction: "capture",
      format: {
        encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
        bits_per_sample: 16, frame_samples: 320,
      },
      max_inflight_frames: 8,
    }, epoch));
    assert.equal((await nextControl(socket)).type, "session.ready");
    socket.send(control("session.cancel", { reason: "user" }, epoch));
    assert.equal((await nextControl(socket)).type, "session.closed");
    socket.terminate();
  }

  const limited = await connect(address);
  const limitedClosed = waitClosed(limited);
  limited.send(control("session.open", {
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }, 42));
  assert.equal(await limitedClosed, 1008);
});

test("sequential sessions on one authenticated socket reset sequence and rate state", async (t) => {
  const sink = new AggregateVoiceCaptureSink();
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    max_frame_rate_per_second: 1,
    sink,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const socket = await connect(address);
  t.after(() => socket.terminate());

  for (const epoch of [30, 31]) {
    socket.send(control("session.open", {
      direction: "capture",
      format: {
        encoding: "pcm_s16le", sample_rate_hz: 16_000, channels: 1,
        bits_per_sample: 16, frame_samples: 320,
      },
      max_inflight_frames: 8,
    }, epoch));
    assert.equal((await nextControl(socket)).type, "session.ready");
    socket.send(pcmFrame(0, VOICE_FLAG_END_OF_STREAM, 100, epoch));
    socket.send(control("session.eos", { final_sequence: 0, reason: "vad_end" }, epoch));
    assert.equal((await nextControl(socket)).type, "session.closed");
  }
  assert.deepEqual(sink.completed.map((summary) => summary.dropped_frames), [0, 0]);
});

test("voice channel plaintext and limit configuration is fail-closed", () => {
  assert.throws(() => new VoiceWebSocketServer({
    host: "0.0.0.0",
    port: 8444,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
  }), /requires TLS/);
  assert.throws(() => new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/v1/device",
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
  }), /path is frozen/);
  assert.throws(() => new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    initial_credit_frames: 65,
    allow_insecure_loopback_test: true,
  }), /positive and bounded/);
  assert.throws(() => new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    max_session_frames: 1_501,
    allow_insecure_loopback_test: true,
  }), /positive and bounded/);
  assert.throws(() => new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    handshake_timeout_ms: 10_001,
    allow_insecure_loopback_test: true,
  }), /positive and bounded/);
});
