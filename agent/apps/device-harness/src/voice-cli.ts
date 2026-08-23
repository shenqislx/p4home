import { readFile, writeFile } from "node:fs/promises";

import {
  AggregateVoiceCaptureSink,
  VoiceWebSocketServer,
} from "@p4home/runtime";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function positivePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_agent_port");
  return port;
}

async function waitUntilOrAbort(
  predicate: () => boolean,
  timeoutMs: number,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (signal.aborted) throw new Error("voice_harness_stopped");
    if (performance.now() >= deadline) throw new Error(reason);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 20);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("voice_harness_stopped"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function main(): Promise<void> {
  if (requiredEnvironment("P4HOME_HARDWARE_PROFILE") !== "phase5b_voice") {
    throw new Error("unsupported_hardware_profile");
  }
  const deviceId = requiredEnvironment("P4HOME_AGENT_DEVICE_ID");
  const deviceToken = (await readFile(
    requiredEnvironment("P4HOME_AGENT_DEVICE_TOKEN_FILE"), "utf8",
  )).trim();
  const key = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_KEY_FILE"));
  const cert = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_CERT_FILE"));
  const readyFile = requiredEnvironment("P4HOME_HARNESS_READY_FILE");
  const resultFile = requiredEnvironment("P4HOME_HARNESS_RESULT_FILE");
  const sink = new AggregateVoiceCaptureSink();
  const server = new VoiceWebSocketServer({
    host: "0.0.0.0",
    port: positivePort(requiredEnvironment("P4HOME_AGENT_PORT")),
    tls: { key, cert },
    device_tokens: { [deviceId]: deviceToken },
    max_connections: 1,
    max_session_frames: 1_500,
    initial_credit_frames: 8,
    sink,
  });
  const shutdown = new AbortController();
  const requestShutdown = (): void => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  let started = false;
  let closePromise: Promise<void> | null = null;
  const closeServer = async (): Promise<void> => {
    if (!started) return;
    closePromise ??= server.close();
    await closePromise;
  };
  try {
    await server.start();
    started = true;
    if (shutdown.signal.aborted) throw new Error("voice_harness_stopped");
    await writeFile(readyFile, "ready\n", { mode: 0o600 });
    process.stdout.write("HARNESS:voice_server:READY raw_audio_retained=false\n");
    await waitUntilOrAbort(
      () => sink.completed.length > 0,
      180_000,
      "voice_capture_timeout",
      shutdown.signal,
    );
    const summary = sink.completed.at(-1)!;
    if (summary.status !== "completed" || !summary.eos || summary.frames < 1
        || summary.bytes < 2 || summary.peak_abs < 1 || summary.dropped_frames !== 0) {
      process.stdout.write(
        `DIAG:phase5b:voice_capture_summary status=${summary.status} eos=${summary.eos} `
        + `frames=${summary.frames} bytes=${summary.bytes} `
        + `dropped=${summary.dropped_frames} peak=${summary.peak_abs}\n`,
      );
      throw new Error("voice_capture_summary_invalid");
    }
    const result = {
      schema_version: 1,
      device_id: summary.device_id,
      session_id: summary.session_id,
      stream_id: summary.stream_id,
      epoch: summary.epoch,
      status: summary.status,
      frames: summary.frames,
      bytes: summary.bytes,
      dropped_frames: summary.dropped_frames,
      peak_abs: summary.peak_abs,
      eos: summary.eos,
      raw_audio_retained: false,
    };
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `VERIFY:phase5b:agent_voice_sink:PASS epoch=${summary.epoch} frames=${summary.frames} `
      + `bytes=${summary.bytes} dropped=${summary.dropped_frames} peak=${summary.peak_abs} `
      + "raw_audio_retained=false\n",
    );
  } finally {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
    await closeServer();
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown_error";
  if (reason === "voice_harness_stopped") {
    process.stdout.write("HARNESS:voice_server:STOPPED\n");
    return;
  }
  process.stdout.write(`VERIFY:phase5b:agent_voice_sink:FAIL reason=${reason}\n`);
  process.exitCode = 1;
});
