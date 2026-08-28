import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import {
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_FLAG_END_OF_STREAM,
  VOICE_FRAME_PAYLOAD_BYTES,
  VOICE_FRAME_SAMPLES,
  VOICE_SAMPLE_RATE_HZ,
  type DecodedVoiceFrame,
} from "@p4home/contracts";
import {
  SttProviderError,
  type SttProvider,
  type SttTranscriptionRequest,
  type SttTranscriptionOptions,
} from "@p4home/provider-stt";
import {
  AggregateVoiceCaptureSink,
  VoiceInteractionCoordinator,
  VoiceSttPipeline,
  VoiceWebSocketServer,
  bindVoiceInteractionCoordinator,
  type ComposedRoleResponse,
  type RunRoleInteractionResult,
  type VoiceCaptureSink,
  type VoiceCaptureSummary,
} from "@p4home/runtime";

const DEVICE_ID = "p4-phase5e-process";
const DEVICE_TOKEN = "phase5e-process-token-0123456789abcdef";
const SOAK_SESSIONS = 1_000;

function emit(value: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function context(epoch: number) {
  return {
    device_id: DEVICE_ID,
    session_id: epoch.toString(16).padStart(32, "0"),
    stream_id: epoch,
    epoch,
  };
}

function summary(
  epoch: number,
  status: VoiceCaptureSummary["status"] = "active",
  eos = false,
): VoiceCaptureSummary {
  return {
    ...context(epoch),
    status,
    frames: status === "active" ? 0 : 1,
    bytes: status === "active" ? 0 : VOICE_FRAME_PAYLOAD_BYTES,
    dropped_frames: 0,
    peak_abs: 1_200,
    eos,
  };
}

function frame(epoch: number): DecodedVoiceFrame {
  const payload = new Uint8Array(VOICE_FRAME_PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, 1_200, true);
  }
  return {
    header: {
      kind: "capture_pcm",
      flags: VOICE_FLAG_END_OF_STREAM,
      sessionId: Buffer.from(context(epoch).session_id, "hex"),
      streamId: epoch,
      epoch,
      sequence: 0,
      captureTimeUs: 0n,
      payloadBytes: payload.byteLength,
      sampleRateHz: VOICE_SAMPLE_RATE_HZ,
      frameSamples: VOICE_FRAME_SAMPLES,
      channels: VOICE_CHANNELS,
      bitsPerSample: VOICE_BITS_PER_SAMPLE,
    },
    payload,
  };
}

function roleResult(): RunRoleInteractionResult {
  const assignment = {
    assignment_id: "assignment:human:soak",
    role_id: "human" as const,
    source_span: { start: 0, end: 4 },
    mode: "respond" as const,
  };
  const run = {
    run_id: "run:human:soak",
    role_id: "human" as const,
    status: "completed" as const,
    final_text: "已收到。",
    model_turns: 1 as const,
    capability_available: true,
    outcome: "response" as const,
    tool_results: [],
    error: null,
  };
  const response: ComposedRoleResponse = {
    schema_version: 1,
    status: "completed",
    text: "Human：\"已收到。\"",
    parts: [{
      assignment_id: assignment.assignment_id,
      role_id: assignment.role_id,
      source_span: assignment.source_span,
      status: "completed",
      outcome: "response",
      text: "已收到。",
      error_code: null,
      tool_results: [],
    }],
  };
  return {
    routing: { model_output_accepted: true, fallback_error_code: null },
    runs: [{ assignment, run }],
    run,
    response,
    composition_audit_status: "persisted",
  } as unknown as RunRoleInteractionResult;
}

async function runServer(): Promise<void> {
  const port = Number(process.env.P4HOME_PHASE5E_PROCESS_PORT ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("P4HOME_PHASE5E_PROCESS_PORT is invalid");
  }
  const aggregate = new AggregateVoiceCaptureSink(8);
  const sink: VoiceCaptureSink = {
    onSessionOpen(value) { aggregate.onSessionOpen(value); },
    onFrame(value, valueFrame) { aggregate.onFrame(value, valueFrame); },
    onSessionClosed(value) {
      aggregate.onSessionClosed(value);
      emit({ type: "session", summary: aggregate.completed.at(-1) });
    },
  };
  const server = new VoiceWebSocketServer({
    host: "127.0.0.1",
    port,
    device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    allow_insecure_loopback_test: true,
    sink,
  });
  const address = await server.start();
  emit({ type: "ready", address });
  await new Promise<void>((resolve, reject) => {
    const shutdown = (): void => {
      process.off("SIGTERM", shutdown);
      process.off("SIGINT", shutdown);
      void server.close().then(resolve, reject);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
  emit({
    type: "closed",
    connection_count: server.connection_count,
    playback_count: server.playback_count,
    pending_conversation_ui_count: server.pending_conversation_ui_count,
  });
}

async function runSoak(): Promise<void> {
  let providerMode: "healthy" | "error" | "hang" = "healthy";
  const retainedPcm: Uint8Array[] = [];
  const providerSignals: AbortSignal[] = [];
  const provider: SttProvider = {
    async transcribe(
      request: SttTranscriptionRequest,
      options: SttTranscriptionOptions = {},
    ) {
      const mode = providerMode;
      retainedPcm.push(request.pcm);
      if (options.signal !== undefined) providerSignals.push(options.signal);
      if (mode === "hang") {
        return await new Promise(() => undefined);
      }
      if (mode === "error") {
        throw new SttProviderError("MODEL_UNAVAILABLE", "deterministic soak fault");
      }
      return {
        schema_version: 1,
        kind: "final",
        session_id: request.session_id,
        stream_id: request.stream_id,
        epoch: request.epoch,
        text: "本地长跑请求",
        language: "zh",
        duration_ms: 20,
      };
    },
  };
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    cancel_low_priority_cat: () => undefined,
    audio_output: "disabled",
    max_results: 19,
  });
  const bindings = bindVoiceInteractionCoordinator(coordinator);
  const pipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: bindings.dispatch_final,
    on_capture_open: bindings.on_capture_open,
    min_speech_ms: 20,
    end_silence_ms: 20,
    max_utterance_ms: 40,
    stt_timeout_ms: 1_000,
    max_results: 23,
  });

  let maximumEventLoopLagMs = 0;
  let expectedTick = performance.now() + 10;
  const lagTimer = setInterval(() => {
    const now = performance.now();
    maximumEventLoopLagMs = Math.max(maximumEventLoopLagMs, now - expectedTick);
    expectedTick = now + 10;
  }, 10);
  const heapUsedBefore = process.memoryUsage().heapUsed;

  const runSession = (epoch: number, status: "completed" | "cancelled"): void => {
    pipeline.onSessionOpen(summary(epoch));
    pipeline.onFrame(summary(epoch), frame(epoch));
    pipeline.onSessionClosed(summary(epoch, status, status === "completed"));
  };

  try {
    for (let epoch = 1; epoch <= SOAK_SESSIONS; epoch++) {
      providerMode = epoch % 37 === 0 ? "error" : "healthy";
      runSession(epoch, epoch % 11 === 0 ? "cancelled" : "completed");
      await pipeline.drain();
      if (epoch % 25 === 0) await yieldImmediate();
    }

    providerMode = "hang";
    runSession(SOAK_SESSIONS + 1, "completed");
    await pipeline.drain();
    assert.equal(pipeline.results.at(-1)?.outcome, "timed_out");

    providerMode = "healthy";
    runSession(SOAK_SESSIONS + 2, "completed");
    await pipeline.drain();
    assert.equal(pipeline.results.at(-1)?.outcome, "dispatched");

    providerMode = "hang";
    runSession(SOAK_SESSIONS + 3, "completed");
    providerMode = "healthy";
    runSession(SOAK_SESSIONS + 4, "completed");
    await pipeline.drain();
    assert.deepEqual(
      pipeline.results.slice(-2).map((result) => result.outcome),
      ["stale", "dispatched"],
    );
  } finally {
    clearInterval(lagTimer);
  }

  assert.equal(pipeline.results.length, 23);
  assert.equal(coordinator.results.length, 19);
  assert.equal(pipeline.active_count, 0);
  assert.equal(pipeline.inflight_count, 0);
  assert.equal(pipeline.pending_count, 0);
  assert.equal(pipeline.known_device_count, 1);
  assert.equal(coordinator.active_count, 0);
  assert.equal(coordinator.known_device_count, 1);
  assert.ok(retainedPcm.length > 900);
  assert.ok(retainedPcm.every((pcm) => pcm.every((byte) => byte === 0)));
  assert.ok(providerSignals.every((signal) => getEventListeners(signal, "abort").length === 0));

  pipeline.close();
  coordinator.close();
  assert.equal(pipeline.active_count, 0);
  assert.equal(pipeline.inflight_count, 0);
  assert.equal(pipeline.pending_count, 0);
  assert.equal(pipeline.known_device_count, 0);
  assert.equal(coordinator.active_count, 0);
  assert.equal(coordinator.known_device_count, 0);
  await yieldImmediate();

  emit({
    type: "soak",
    sessions: SOAK_SESSIONS,
    pipeline_results: pipeline.results.length,
    coordinator_results: coordinator.results.length,
    pcm_buffers_wiped: retainedPcm.length,
    abort_listeners_remaining: providerSignals.reduce(
      (total, signal) => total + getEventListeners(signal, "abort").length, 0,
    ),
    maximum_event_loop_lag_ms: Math.ceil(maximumEventLoopLagMs),
    heap_growth_bytes: Math.max(0, process.memoryUsage().heapUsed - heapUsedBefore),
    active_resources: process.getActiveResourcesInfo(),
  });
}

const mode = process.env.P4HOME_PHASE5E_GATE_MODE;
if (mode === "server") {
  await runServer();
} else if (mode === "soak") {
  await runSoak();
} else {
  throw new Error("P4HOME_PHASE5E_GATE_MODE must be server or soak");
}
