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
    message.fill(0);
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

function streamSender(
  pcmStream: AsyncIterable<Uint8Array>,
  wire: VoicePlaybackWire,
): VoicePlaybackSender {
  return new VoicePlaybackSender({
    device_id: "p4-lab",
    identity: IDENTITY,
    pcm_stream: pcmStream,
    wire,
    timeout_ms: 5_000,
  });
}

async function settlePlaybackPump(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 1);
  assert.equal(wire.controls.length, 1);
  const first = decodeVoiceFrame(wire.binaries[0]!);
  assert.equal(first.header.kind, "playback_pcm");
  assert.equal(first.header.sequence, 0);
  assert.equal(first.header.flags, 0);
  assert.deepEqual(first.payload, pcm.subarray(0, 640));

  playback.handleControl(control("credit", { ack_sequence: 0, grant_frames: 1 }));
  await settlePlaybackPump();
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
  assert.equal(playback.retained_pcm_bytes, 0);
});

test("playback sender accepts in-flight credits before emitting EOS control", async () => {
  const wire = new FakeWire();
  const playback = sender(new Uint8Array(6_400), wire);
  const pending = playback.start();

  playback.handleControl(control("session.ready", { initial_credit_frames: 8 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 8);
  playback.handleControl(control("credit", { ack_sequence: 0, grant_frames: 1 }));
  playback.handleControl(control("credit", { ack_sequence: 1, grant_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 10);
  assert.equal(decodeVoiceFrame(wire.binaries.at(-1)!).header.flags, VOICE_FLAG_END_OF_STREAM);
  assert.equal(wire.controls.some((message) => message.type === "session.eos"), false);

  for (let sequence = 2; sequence <= 8; sequence++) {
    playback.handleControl(control("credit", { ack_sequence: sequence, grant_frames: 1 }));
  }
  await settlePlaybackPump();
  assert.equal(wire.controls.at(-1)?.type, "session.eos");
  assert.equal(wire.controls.at(-1)?.final_sequence, 9);

  playback.handleControl(control("session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).status, "completed");
});

test("playback sender emits EOS control when a cumulative credit acknowledges the EOS frame", async () => {
  const wire = new FakeWire();
  const playback = sender(new Uint8Array(6_400), wire);
  const pending = playback.start();

  playback.handleControl(control("session.ready", { initial_credit_frames: 8 }));
  await settlePlaybackPump();
  playback.handleControl(control("credit", { ack_sequence: 0, grant_frames: 1 }));
  playback.handleControl(control("credit", { ack_sequence: 1, grant_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.controls.some((message) => message.type === "session.eos"), false);

  playback.handleControl(control("credit", { ack_sequence: 9, grant_frames: 1 }));
  assert.equal(wire.controls.at(-1)?.type, "session.eos");
  assert.equal(wire.controls.at(-1)?.final_sequence, 9);

  playback.handleControl(control("session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).status, "completed");
});

test("P4 barge-in terminal stops further frames and preserves cancelled truth", async () => {
  const wire = new FakeWire();
  const playback = sender(new Uint8Array(1_920), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 1);
  assert.equal(playback.retained_pcm_bytes, 0);
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
  await settlePlaybackPump();
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

test("pre-aborted playback wipes its private PCM clone before rejecting", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  const playback = sender(Uint8Array.from({ length: 640 }, () => 9), new FakeWire());
  await assert.rejects(playback.start(controller.signal), /cancelled before open/);
  assert.equal(playback.retained_pcm_bytes, 0);
});

test("a synchronous binary wire failure wipes the temporary PCM frame", async () => {
  let retainedFrame: Uint8Array | null = null;
  const wire: VoicePlaybackWire = {
    sendControl: () => undefined,
    sendBinary: (message) => {
      retainedFrame = message;
      throw new Error("injected synchronous send failure");
    },
  };
  const playback = sender(Uint8Array.from({ length: 640 }, () => 5), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  await settlePlaybackPump();
  assert.notEqual(retainedFrame, null);
  assert.ok((retainedFrame as unknown as Uint8Array).every((value) => value === 0));
  playback.disconnect();
  await assert.rejects(pending);
  assert.equal(playback.retained_pcm_bytes, 0);
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

test("streaming playback reassembles arbitrary chunks into exact credit-driven frames", async () => {
  const wire = new FakeWire();
  const chunks = [
    Uint8Array.from({ length: 100 }, (_, index) => index % 251),
    Uint8Array.from({ length: 700 }, (_, index) => (index + 17) % 251),
    Uint8Array.from({ length: 480 }, (_, index) => (index + 31) % 251),
  ];
  const expected = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const playback = streamSender(source(), wire);
  const pending = playback.start();

  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 1);
  assert.equal(decodeVoiceFrame(wire.binaries[0]!).header.flags, 0);
  assert.ok(chunks[0]!.every((value) => value === 0));
  assert.ok(chunks[1]!.every((value) => value === 0));
  assert.ok(chunks[2]!.some((value) => value !== 0));

  playback.handleControl(control("credit", { ack_sequence: 0, grant_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 2);
  const frames = wire.binaries.map((message) => decodeVoiceFrame(message));
  assert.equal(frames[1]!.header.flags, VOICE_FLAG_END_OF_STREAM);
  assert.equal(frames[1]!.header.payloadBytes, 640);
  assert.deepEqual(Buffer.concat(frames.map((frame) => Buffer.from(frame.payload))), expected);
  assert.ok(chunks.every((chunk) => chunk.every((value) => value === 0)));
  assert.equal(wire.controls.at(-1)?.type, "session.eos");

  playback.handleControl(control("session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).bytes, 1_280);
  assert.equal(playback.retained_pcm_bytes, 0);
});

test("streaming playback permits only the final PCM frame to be short", async () => {
  const wire = new FakeWire();
  const chunks = [new Uint8Array(300).fill(3), new Uint8Array(400).fill(7)];
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }
  const playback = streamSender(source(), wire);
  const pending = playback.start();

  playback.handleControl(control("session.ready", { initial_credit_frames: 2 }));
  await settlePlaybackPump();
  const frames = wire.binaries.map((message) => decodeVoiceFrame(message));
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.header.payloadBytes, 640);
  assert.equal(frames[0]!.header.flags, 0);
  assert.equal(frames[1]!.header.payloadBytes, 60);
  assert.equal(frames[1]!.header.frameSamples, 30);
  assert.equal(frames[1]!.header.flags, VOICE_FLAG_END_OF_STREAM);
  assert.ok(chunks.every((chunk) => chunk.every((value) => value === 0)));

  playback.handleControl(control("credit", { ack_sequence: 0, grant_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.controls.at(-1)?.type, "session.eos");
  playback.handleControl(control("session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).bytes, 700);
});

test("barge-in while awaiting source lookahead stops output and clears late chunks", async () => {
  const wire = new FakeWire();
  const first = new Uint8Array(640).fill(4);
  const second = new Uint8Array(640).fill(8);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  async function* source(): AsyncGenerator<Uint8Array> {
    yield first;
    await blocked;
    yield second;
  }
  const playback = streamSender(source(), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 0);
  assert.ok(first.every((value) => value === 0));

  playback.handleControl(control("session.cancel", { reason: "barge_in" }));
  release();
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 0);
  assert.ok(second.every((value) => value === 0));
  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  assert.equal((await pending).status, "cancelled");
  assert.equal(playback.retained_pcm_bytes, 0);
});

test("stream source failure sends bounded provider cancellation and rejects after terminal", async () => {
  const wire = new FakeWire();
  const chunk = new Uint8Array(700).fill(6);
  async function* source(): AsyncGenerator<Uint8Array> {
    yield chunk;
    throw new Error("injected source failure");
  }
  const playback = streamSender(source(), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 2 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 1);
  assert.equal(wire.controls.at(-1)?.type, "session.cancel");
  assert.equal(wire.controls.at(-1)?.reason, "provider_error");
  assert.ok(chunk.every((value) => value === 0));

  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  await assert.rejects(pending, (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "UNAVAILABLE"
  ));
  assert.equal(playback.retained_pcm_bytes, 0);
});

test("stream total-byte overflow clears the rejected chunk and fails closed", async () => {
  const wire = new FakeWire();
  const oversized = new Uint8Array(1_920_001).fill(5);
  async function* source(): AsyncGenerator<Uint8Array> { yield oversized; }
  const playback = streamSender(source(), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 0);
  assert.equal(wire.controls.at(-1)?.type, "session.cancel");
  assert.ok(oversized.every((value) => value === 0));

  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  await assert.rejects(pending, (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "LIMIT_EXCEEDED"
  ));
});

test("stream rejects an odd final PCM byte without emitting a short invalid frame", async () => {
  const wire = new FakeWire();
  const odd = new Uint8Array(639).fill(11);
  async function* source(): AsyncGenerator<Uint8Array> { yield odd; }
  const playback = streamSender(source(), wire);
  const pending = playback.start();
  playback.handleControl(control("session.ready", { initial_credit_frames: 1 }));
  await settlePlaybackPump();
  assert.equal(wire.binaries.length, 0);
  assert.equal(wire.controls.at(-1)?.type, "session.cancel");
  assert.ok(odd.every((value) => value === 0));

  playback.handleControl(control("session.closed", { status: "cancelled", dropped_frames: 0 }));
  await assert.rejects(pending, (error: unknown) => (
    error instanceof Error && "code" in error && error.code === "LIMIT_EXCEEDED"
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

test("real WebSocket playbackStream incrementally emits reassembled PCM", async (t) => {
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    device_tokens: { "p4-playback-test": "phase-5d-test-token-0123456789abcdef" },
    allow_insecure_loopback_test: true,
  });
  const { socket, inbox } = await connectPlaybackTestServer(server);
  t.after(async () => { socket.terminate(); await server.close(); });
  const chunks = [new Uint8Array(333).fill(2), new Uint8Array(367).fill(9)];
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }

  const pending = server.playbackStream("p4-playback-test", source());
  const open = await inbox.control();
  socket.send(reply(open, "session.ready", { initial_credit_frames: 2 }));
  const first = decodeVoiceFrame(new Uint8Array((await inbox.next()).data as Buffer));
  const final = decodeVoiceFrame(new Uint8Array((await inbox.next()).data as Buffer));
  assert.equal(first.header.payloadBytes, 640);
  assert.equal(first.header.flags, 0);
  assert.equal(final.header.payloadBytes, 60);
  assert.equal(final.header.flags, VOICE_FLAG_END_OF_STREAM);
  assert.ok(chunks.every((chunk) => chunk.every((value) => value === 0)));

  socket.send(reply(open, "credit", { ack_sequence: 0, grant_frames: 1 }));
  assert.equal((await inbox.control()).type, "session.eos");
  socket.send(reply(open, "session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).bytes, 700);
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

test("same-device reconnect notifies once and stale socket close cannot cancel new playback", async (t) => {
  const disconnected: string[] = [];
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    allow_insecure_loopback_test: true,
    device_tokens: { "p4-playback-test": "phase-5d-test-token-0123456789abcdef" },
    on_device_disconnect: (deviceId) => { disconnected.push(deviceId); },
  });
  t.after(async () => { await server.close(); });
  const first = await connectPlaybackTestServer(server);
  const address = server.address!;
  const secondSocket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: "Bearer phase-5d-test-token-0123456789abcdef",
      "X-P4-Device-ID": "p4-playback-test",
    },
  });
  await new Promise<void>((resolve, reject) => {
    secondSocket.once("open", resolve);
    secondSocket.once("error", reject);
  });
  const second = { socket: secondSocket, inbox: new SocketInbox(secondSocket) };
  t.after(() => second.socket.terminate());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(disconnected, ["p4-playback-test"]);

  const pending = server.playback("p4-playback-test", new Uint8Array(640));
  const open = await second.inbox.control();
  second.socket.send(reply(open, "session.ready", { initial_credit_frames: 1 }));
  assert.equal((await second.inbox.next()).binary, true);
  assert.equal((await second.inbox.control()).type, "session.eos");
  second.socket.send(reply(open, "session.closed", { status: "completed", dropped_frames: 0 }));
  assert.equal((await pending).status, "completed");
  first.socket.terminate();
});
