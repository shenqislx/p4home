import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeVoiceFrame,
  validateVoiceControlMessage,
  VOICE_FLAG_END_OF_STREAM,
  type VoiceControlMessage,
} from "@p4home/contracts";
import {
  VoicePlaybackSender,
  VoiceWebSocketServer,
  type VoicePlaybackIdentity,
  type VoicePlaybackWire,
} from "@p4home/runtime";
import WebSocket from "ws";

const IDENTITY: VoicePlaybackIdentity = {
  session_id: "00112233445566778899aabbccddeeff",
  session_id_bytes: Uint8Array.from([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]),
  stream_id: 7,
  epoch: 9,
};

function control(type: string, extra: Record<string, unknown>): VoiceControlMessage {
  return validateVoiceControlMessage({
    protocol_version: 1,
    type,
    session_id: IDENTITY.session_id,
    stream_id: IDENTITY.stream_id,
    epoch: IDENTITY.epoch,
    ...extra,
  });
}

class FakeWire implements VoicePlaybackWire {
  readonly controls: VoiceControlMessage[] = [];
  readonly binaries: Uint8Array[] = [];
  onControl: ((message: VoiceControlMessage) => void) | null = null;

  sendControl(message: VoiceControlMessage): void {
    this.controls.push(structuredClone(message));
    this.onControl?.(message);
  }

  sendBinary(message: Uint8Array): void {
    this.binaries.push(message.slice());
  }
}

function sender(pcm: Uint8Array, wire: VoicePlaybackWire): VoicePlaybackSender {
  return new VoicePlaybackSender({
    device_id: "p4-lab",
    identity: IDENTITY,
    pcm,
    wire,
    timeout_ms: 5_000,
  });
}

class SocketInbox {
  readonly #messages: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  readonly #waiters: Array<(message: { data: WebSocket.RawData; binary: boolean }) => void> = [];

  public constructor(socket: WebSocket) {
    socket.on("message", (data, binary) => {
      const message = { data, binary };
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#messages.push(message);
      else waiter(message);
    });
  }

  public async next(): Promise<{ data: WebSocket.RawData; binary: boolean }> {
    const message = this.#messages.shift();
    if (message !== undefined) return message;
    return await new Promise((resolve) => this.#waiters.push(resolve));
  }

  public async control(): Promise<VoiceControlMessage> {
    const message = await this.next();
    assert.equal(message.binary, false);
    return validateVoiceControlMessage(JSON.parse(message.data.toString()));
  }
}

async function connectPlaybackTestServer(server: VoiceWebSocketServer): Promise<{
  socket: WebSocket;
  inbox: SocketInbox;
}> {
  const address = await server.start();
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: "Bearer phase-5d-test-token-0123456789abcdef",
      "X-P4-Device-ID": "p4-playback-test",
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, inbox: new SocketInbox(socket) };
}

function reply(open: VoiceControlMessage, type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({
    protocol_version: 1,
    type,
    session_id: open.session_id,
    stream_id: open.stream_id,
    epoch: open.epoch,
    ...extra,
  });
}

test("playback sender opens, obeys credit, emits exact EOS PCM and waits for terminal", async () => {
  const wire = new FakeWire();
  const pcm = new Uint8Array(1_280);
  pcm.fill(0x5a);
  const playback = sender(pcm, wire);
  const pending = playback.start();
  assert.equal(wire.controls[0]?.type, "session.open");
  assert.equal(wire.controls[0]?.direction, "playback");

  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  assert.equal(wire.binaries.length, 1);
  assert.equal(wire.controls.length, 1);
  const first = decodeVoiceFrame(wire.binaries[0]!);
  assert.equal(first.header.kind, "playback_pcm");
  assert.equal(first.header.sequence, 0);
  assert.equal(first.header.flags, 0);
  assert.deepEqual(first.payload, pcm.subarray(0, 640));

  playback.handleControl(control("credit", { ack_sequence: 0, grant_frames: 1 }));
  assert.equal(wire.binaries.length, 2);
  const second = decodeVoiceFrame(wire.binaries[1]!);
  assert.equal(second.header.sequence, 1);
  assert.equal(second.header.flags, VOICE_FLAG_END_OF_STREAM);
  assert.equal(wire.controls.at(-1)?.type, "session.eos");
  assert.equal(wire.controls.at(-1)?.final_sequence, 1);

  playback.handleControl(control("session.closed", { status: "completed", dropped_frames: 0 }));
  assert.deepEqual(await pending, {
    schema_version: 1,
    device_id: "p4-lab",
    session_id: IDENTITY.session_id,
    stream_id: 7,
    epoch: 9,
    status: "completed",
    frames: 2,
    bytes: 1_280,
    dropped_frames: 0,
  });
});

test("P4 barge-in terminal stops further frames and preserves cancelled truth", async () => {
  const wire = new FakeWire();
  const playback = sender(new Uint8Array(1_920), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  assert.equal(wire.binaries.length, 1);
  playback.handleControl(control("session.cancel", { reason: "barge_in" }));
  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.frames, 1);
  assert.equal(result.bytes, 640);
  assert.equal(wire.binaries.length, 1);
});

test("P4 speaker shutdown failure uses one coherent failed terminal", async () => {
  const wire = new FakeWire();
  const playback = sender(new Uint8Array(640), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  playback.handleControl(control("error", { code: "UNAVAILABLE" }));
  playback.handleControl(control("session.closed", { status: "failed", dropped_frames: 0 }));

  const summary = await pending;
  assert.equal(summary.status, "failed");
  assert.equal(summary.frames, 1);
  assert.equal(summary.bytes, 640);
});

test("abort during session.open synchronously emits one bounded cancel", async () => {
  const controller = new AbortController();
  const wire = new FakeWire();
  wire.onControl = (message) => {
    if (message.type === "session.open") controller.abort(new Error("barge in"));
  };
  const playback = sender(new Uint8Array(640), wire);
  const pending = playback.start(controller.signal);
  assert.deepEqual(wire.controls.map((message) => message.type), ["session.open", "session.cancel"]);
  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  assert.equal((await pending).status, "cancelled");
});

test("playback input and concurrent sender count are bounded before any wire output", () => {
  assert.throws(() => sender(new Uint8Array(1), new FakeWire()), /even/);
  assert.throws(() => sender(new Uint8Array(1_920_002), new FakeWire()), /1,920,000/);
});

test("playback timeout keeps its identity alive long enough to absorb P4 terminal", async () => {
  const wire = new FakeWire();
  const playback = new VoicePlaybackSender({
    device_id: "p4-lab",
    identity: IDENTITY,
    pcm: new Uint8Array(640),
    wire,
    timeout_ms: 1_000,
  });
  const pending = playback.start();
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(wire.controls.at(-1)?.type, "session.cancel");
  playback.handleControl(control("session.cancel", { reason: "timeout" }));
  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  await assert.rejects(pending, (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "TIMEOUT"
  ));
});

test("real WebSocket playback is bounded, credit-driven and closes without retaining a sender", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { "p4-playback-test": "phase-5d-test-token-0123456789abcdef" },
    allow_insecure_loopback_test: true,
  });
  const { socket, inbox } = await connectPlaybackTestServer(server);
  t.after(async () => { socket.terminate(); await server.close(); });

  const pending = server.playback("p4-playback-test", new Uint8Array(640));
  const open = await inbox.control();
  assert.equal(open.type, "session.open");
  assert.equal(open.direction, "playback");
  await assert.rejects(server.playback("p4-playback-test", new Uint8Array(640)), /already active/);

  socket.send(reply(open, "session.ready", { initial_credit_frames: 1 }));
  const frame = await inbox.next();
  assert.equal(frame.binary, true);
  assert.equal(decodeVoiceFrame(new Uint8Array(frame.data as Buffer)).header.kind, "playback_pcm");
  const eos = await inbox.control();
  assert.equal(eos.type, "session.eos");
  socket.send(reply(open, "session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).status, "completed");
  assert.equal(server.playback_count, 0);
});

test("WakeNet capture open sends playback barge-in before capture ready", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { "p4-playback-test": "phase-5d-test-token-0123456789abcdef" },
    allow_insecure_loopback_test: true,
  });
  const { socket, inbox } = await connectPlaybackTestServer(server);
  t.after(async () => { socket.terminate(); await server.close(); });

  const pending = server.playback("p4-playback-test", new Uint8Array(1_280));
  const playbackOpen = await inbox.control();
  socket.send(reply(playbackOpen, "session.ready", { initial_credit_frames: 1 }));
  assert.equal((await inbox.next()).binary, true);
  socket.send(JSON.stringify({
    protocol_version: 1,
    type: "session.open",
    session_id: "11112222333344445555666677778888",
    stream_id: 11,
    epoch: 1,
    direction: "capture",
    format: {
      encoding: "pcm_s16le", sample_rate_hz: 16000, channels: 1,
      bits_per_sample: 16, frame_samples: 320,
    },
    max_inflight_frames: 8,
  }));
  const cancel = await inbox.control();
  const ready = await inbox.control();
  assert.equal(cancel.type, "session.cancel");
  assert.equal(cancel.reason, "barge_in");
  assert.equal(ready.type, "session.ready");
  socket.send(reply(playbackOpen, "session.cancel", { reason: "barge_in" }));
  socket.send(reply(playbackOpen, "session.closed", { status: "cancelled", dropped_frames: 0 }));
  assert.equal((await pending).status, "cancelled");
});
