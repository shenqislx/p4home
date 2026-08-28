import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import test from "node:test";

import {
  encodeVoiceFrameHeader,
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_FLAG_END_OF_STREAM,
  VOICE_FRAME_PAYLOAD_BYTES,
  VOICE_FRAME_SAMPLES,
  VOICE_SAMPLE_RATE_HZ,
  type VoiceControlMessage,
} from "@p4home/contracts";
import WebSocket from "ws";

const DEVICE_ID = "p4-phase5e-process";
const DEVICE_TOKEN = "phase5e-process-token-0123456789abcdef";
const WORKER = new URL("../fixtures/phase5e-process-soak-worker.ts", import.meta.url).pathname;
const AGENT_ROOT = new URL("../../", import.meta.url).pathname;

interface ChildMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

class ChildMessages {
  readonly #child: ChildProcess;
  readonly #events = new EventEmitter();
  readonly #messages: ChildMessage[] = [];
  readonly #reader: ReadLineInterface;
  #stderr = "";

  public constructor(child: ChildProcess) {
    this.#child = child;
    assert(child.stdout !== null);
    assert(child.stderr !== null);
    this.#reader = createInterface({ input: child.stdout });
    this.#reader.on("line", (line) => {
      try {
        this.#messages.push(JSON.parse(line) as ChildMessage);
        this.#events.emit("message");
      } catch (error) {
        this.#events.emit("parse_error", error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { this.#stderr += chunk.toString("utf8"); });
  }

  public async take(type: string, timeoutMs = 5_000): Promise<ChildMessage> {
    const takeExisting = (): ChildMessage | null => {
      const index = this.#messages.findIndex((message) => message.type === type);
      if (index < 0) return null;
      return this.#messages.splice(index, 1)[0] ?? null;
    };
    const existing = takeExisting();
    if (existing !== null) return existing;
    return await new Promise<ChildMessage>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#events.off("message", onMessage);
        this.#events.off("parse_error", onParseError);
        this.#child.off("exit", onExit);
        this.#child.off("error", onError);
      };
      const onMessage = (): void => {
        const message = takeExisting();
        if (message === null) return;
        cleanup();
        resolve(message);
      };
      const onParseError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(
          `Phase 5E worker exited before ${type}: code=${code} signal=${signal} stderr=${this.#stderr}`,
        ));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for Phase 5E worker ${type}; stderr=${this.#stderr}`));
      }, timeoutMs);
      this.#events.on("message", onMessage);
      this.#events.once("parse_error", onParseError);
      this.#child.once("exit", onExit);
      this.#child.once("error", onError);
    });
  }

  public close(): void { this.#reader.close(); }
}

function startWorker(mode: "server" | "soak", port = 0): {
  readonly child: ChildProcess;
  readonly messages: ChildMessages;
} {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
    cwd: AGENT_ROOT,
    env: {
      ...process.env,
      P4HOME_PHASE5E_GATE_MODE: mode,
      P4HOME_PHASE5E_PROCESS_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, messages: new ChildMessages(child) };
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<ExitResult>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Phase 5E worker did not exit within its bounded deadline"));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function control(type: string, epoch: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocol_version: 1,
    type,
    session_id: epoch.toString(16).padStart(32, "0"),
    stream_id: epoch,
    epoch,
    ...extra,
  });
}

function pcmFrame(epoch: number, eos: boolean): Uint8Array {
  const payload = new Uint8Array(VOICE_FRAME_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, 1_200, true);
  }
  const header = encodeVoiceFrameHeader({
    kind: "capture_pcm",
    flags: eos ? VOICE_FLAG_END_OF_STREAM : 0,
    sessionId: Buffer.from(epoch.toString(16).padStart(32, "0"), "hex"),
    streamId: epoch,
    epoch,
    sequence: 0,
    captureTimeUs: 0n,
    payloadBytes: payload.byteLength,
    sampleRateHz: VOICE_SAMPLE_RATE_HZ,
    frameSamples: VOICE_FRAME_SAMPLES,
    channels: VOICE_CHANNELS,
    bitsPerSample: VOICE_BITS_PER_SAMPLE,
  });
  const result = new Uint8Array(header.byteLength + payload.byteLength);
  result.set(header);
  result.set(payload, header.byteLength);
  return result;
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/voice`, {
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
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (code: number): void => {
      cleanup();
      reject(new Error(`voice socket closed before control: ${code}`));
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function waitForSocketClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return 1006;
  return await new Promise<number>((resolve) => socket.once("close", resolve));
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

test("Phase 5E process crash releases its port and a restarted worker accepts the next interaction", {
  timeout: 20_000,
}, async (t) => {
  const workers: Array<{ readonly child: ChildProcess; readonly messages: ChildMessages }> = [];
  t.after(async () => {
    for (const worker of workers) {
      worker.messages.close();
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
        await waitForExit(worker.child, 2_000).catch(() => undefined);
      }
    }
  });

  const first = startWorker("server");
  workers.push(first);
  const firstReady = await first.messages.take("ready");
  const firstAddress = firstReady.address as { readonly port: number };
  assert.ok(Number.isInteger(firstAddress.port) && firstAddress.port > 0);

  const interruptedSocket = await connect(firstAddress.port);
  interruptedSocket.send(control("session.open", 1, {
    direction: "capture",
    format: {
      encoding: "pcm_s16le",
      sample_rate_hz: VOICE_SAMPLE_RATE_HZ,
      channels: VOICE_CHANNELS,
      bits_per_sample: VOICE_BITS_PER_SAMPLE,
      frame_samples: VOICE_FRAME_SAMPLES,
    },
    max_inflight_frames: 8,
  }));
  assert.equal((await nextControl(interruptedSocket)).type, "session.ready");
  interruptedSocket.send(pcmFrame(1, false));
  assert.equal((await nextControl(interruptedSocket)).type, "credit");
  const interruptedClosed = waitForSocketClose(interruptedSocket);
  assert.equal(first.child.kill("SIGKILL"), true);
  const [closeCode, crashed] = await Promise.all([
    interruptedClosed,
    waitForExit(first.child),
  ]);
  assert.equal(closeCode, 1006);
  assert.equal(crashed.code, null);
  assert.equal(crashed.signal, "SIGKILL");
  first.messages.close();

  const restarted = startWorker("server", firstAddress.port);
  workers.push(restarted);
  const restartedReady = await restarted.messages.take("ready");
  assert.equal((restartedReady.address as { readonly port: number }).port, firstAddress.port);
  const healthySocket = await connect(firstAddress.port);
  healthySocket.send(control("session.open", 2, {
    direction: "capture",
    format: {
      encoding: "pcm_s16le",
      sample_rate_hz: VOICE_SAMPLE_RATE_HZ,
      channels: VOICE_CHANNELS,
      bits_per_sample: VOICE_BITS_PER_SAMPLE,
      frame_samples: VOICE_FRAME_SAMPLES,
    },
    max_inflight_frames: 8,
  }));
  assert.equal((await nextControl(healthySocket)).type, "session.ready");
  healthySocket.send(pcmFrame(2, true));
  healthySocket.send(control("session.eos", 2, { final_sequence: 0, reason: "vad_end" }));
  const terminal = await nextControl(healthySocket);
  assert.equal(terminal.type, "session.closed");
  assert.equal(terminal.status, "completed");
  const session = await restarted.messages.take("session");
  const completed = session.summary as {
    readonly status: string;
    readonly frames: number;
    readonly bytes: number;
    readonly eos: boolean;
  };
  assert.deepEqual(
    [completed.status, completed.frames, completed.bytes, completed.eos],
    ["completed", 1, VOICE_FRAME_PAYLOAD_BYTES, true],
  );

  const healthyClosed = waitForSocketClose(healthySocket);
  healthySocket.close(1000, "test complete");
  assert.equal(await healthyClosed, 1000);
  assert.equal(restarted.child.kill("SIGTERM"), true);
  const closed = await restarted.messages.take("closed");
  assert.deepEqual(
    [closed.connection_count, closed.playback_count, closed.pending_conversation_ui_count],
    [0, 0, 0],
  );
  assert.deepEqual(await waitForExit(restarted.child), { code: 0, signal: null });
  restarted.messages.close();
  await assertPortCanBind(firstAddress.port);
});

test("Phase 5E deterministic thousand-session soak bounds state and recovers after faults", {
  timeout: 20_000,
}, async (t) => {
  const soak = startWorker("soak");
  t.after(async () => {
    soak.messages.close();
    if (soak.child.exitCode === null && soak.child.signalCode === null) {
      soak.child.kill("SIGKILL");
      await waitForExit(soak.child, 2_000).catch(() => undefined);
    }
  });
  const report = await soak.messages.take("soak", 15_000);
  assert.equal(report.sessions, 1_000);
  assert.equal(report.pipeline_results, 23);
  assert.equal(report.coordinator_results, 19);
  assert.ok(Number(report.pcm_buffers_wiped) > 900);
  assert.equal(report.abort_listeners_remaining, 0);
  assert.ok(Number(report.maximum_event_loop_lag_ms) < 500);
  assert.ok(Number(report.heap_growth_bytes) < 64 * 1024 * 1024);
  const resources = report.active_resources as readonly string[];
  assert.equal(resources.includes("Timeout"), false);
  assert.equal(resources.includes("TCPServerWrap"), false);
  assert.equal(resources.includes("TCPSocketWrap"), false);
  assert.deepEqual(await waitForExit(soak.child, 3_000), { code: 0, signal: null });
  soak.messages.close();
});
