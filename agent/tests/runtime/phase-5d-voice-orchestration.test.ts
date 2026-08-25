import assert from "node:assert/strict";
import test from "node:test";

import type { DecodedVoiceFrame } from "@p4home/contracts";
import type { SttFinalTranscript, SttProvider } from "@p4home/provider-stt";
import {
  TTS_ROLE_VOICES,
  type TtsProvider,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "@p4home/provider-tts";
import {
  RoleAwareTtsPipeline,
  LowPriorityCatRunRegistry,
  UnifiedVoiceRuntime,
  VoiceSttPipeline,
  VoiceInteractionCoordinator,
  bindVoiceInteractionCoordinator,
  type ComposedRoleResponse,
  type RunRoleInteractionResult,
  type UserTextInteraction,
  type VoiceCaptureSummary,
  type VoiceDispatchContext,
  type VoicePlaybackSummary,
} from "@p4home/runtime";

const DEVICE_ID = "p4-voice-coordinator";

function context(epoch: number): VoiceDispatchContext {
  return {
    device_id: DEVICE_ID,
    session_id: epoch.toString(16).padStart(32, "0"),
    stream_id: epoch,
    epoch,
  };
}

function summary(epoch: number): VoiceCaptureSummary {
  return {
    ...context(epoch),
    status: "active",
    frames: 0,
    bytes: 0,
    dropped_frames: 0,
    peak_abs: 0,
    eos: false,
  };
}

function voiceFrame(epoch: number, sequence: number, amplitude: number): DecodedVoiceFrame {
  const identity = context(epoch);
  const payload = new Uint8Array(640);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, amplitude, true);
  }
  return {
    header: {
      kind: "capture_pcm",
      flags: 0,
      sessionId: Buffer.from(identity.session_id, "hex"),
      streamId: identity.stream_id,
      epoch,
      sequence,
      captureTimeUs: BigInt(sequence * 20_000),
      payloadBytes: 640,
      sampleRateHz: 16_000,
      frameSamples: 320,
      channels: 1,
      bitsPerSample: 16,
    },
    payload,
  };
}

function interaction(epoch: number): UserTextInteraction {
  return {
    schema_version: 1,
    interaction_id: `voice:coordinator:${epoch}`,
    kind: "user_text",
    text: "请先回答，然后打开书房灯。",
    locale: "zh-CN",
    source: "voice",
    received_at_ms: 1_000 + epoch,
  };
}

function mixedResponse(): ComposedRoleResponse {
  return {
    schema_version: 1,
    status: "completed",
    text: "Human：\"好的。\"\nRobot：\"书房灯已打开。\"",
    parts: [{
      assignment_id: "assignment:human:1",
      role_id: "human",
      source_span: { start: 0, end: 4 },
      status: "completed",
      outcome: "response",
      text: "好的。",
      error_code: null,
      tool_results: [],
    }, {
      assignment_id: "assignment:robot:2",
      role_id: "robot",
      source_span: { start: 4, end: 12 },
      status: "completed",
      outcome: "response",
      text: "书房灯已打开。",
      error_code: null,
      tool_results: [{
        schema_version: 2,
        tool_call_id: "tool:robot:1",
        name: "home.turn_on",
        status: "success",
        result: { state_changed: true },
        error: null,
      }],
    }],
  };
}

function roleResult(response = mixedResponse()): RunRoleInteractionResult {
  return {
    response,
    composition_audit_status: "persisted",
  } as unknown as RunRoleInteractionResult;
}

function unknownRobotResponse(): ComposedRoleResponse {
  const base = mixedResponse();
  return {
    ...base,
    parts: [{
      ...base.parts[1]!,
      text: "设备已成功打开。",
      tool_results: [{
        schema_version: 2,
        tool_call_id: "tool:unknown",
        name: "home.turn_on",
        status: "error",
        result: null,
        error: {
          code: "HA_OUTCOME_UNKNOWN",
          message: "outcome unknown",
          retryable: false,
        },
      }],
    }],
  };
}

let playbackSequence = 10;
function playbackSummary(deviceId: string, status: VoicePlaybackSummary["status"] = "completed"):
VoicePlaybackSummary {
  const identity = playbackSequence++;
  return {
    schema_version: 1,
    device_id: deviceId,
    session_id: identity.toString(16).padStart(32, "0"),
    stream_id: identity,
    epoch: identity,
    status,
    frames: 1,
    bytes: 640,
    dropped_frames: 0,
  };
}

class FakeTtsProvider implements TtsProvider {
  readonly requests: TtsSynthesisRequest[] = [];
  readonly generated: Uint8Array[] = [];

  public async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    this.requests.push(structuredClone(request));
    const pcm = new Uint8Array(640);
    pcm.fill(request.role_id === "human" ? 1 : 2);
    this.generated.push(pcm);
    return {
      schema_version: 1,
      kind: "final_pcm",
      interaction_id: request.interaction_id,
      assignment_id: request.assignment_id,
      segment_index: request.segment_index,
      role_id: request.role_id,
      voice: request.voice,
      pcm,
      sample_rate_hz: 16_000,
      channels: 1,
      sample_bits: 16,
      samples: 320,
      duration_ms: 20,
    };
  }
}

test("unified voice result renders and plays Human then Robot without retaining PCM", async () => {
  const provider = new FakeTtsProvider();
  const played: { roleByte: number; deviceId: string }[] = [];
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    render_tts: async (id, response, signal) => (
      await new RoleAwareTtsPipeline(provider).render(id, response, signal)
    ),
    playback: async (deviceId, pcm) => {
      played.push({ roleByte: pcm[0] ?? 0, deviceId });
      return playbackSummary(deviceId);
    },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(1));
  const result = await coordinator.run(interaction(1), new AbortController().signal, context(1));

  assert.equal(result.outcome, "completed");
  assert.deepEqual(played, [
    { roleByte: 1, deviceId: DEVICE_ID },
    { roleByte: 2, deviceId: DEVICE_ID },
  ]);
  assert.deepEqual(result.playback_segments.map((segment) => ({
    role_id: segment.role_id,
    voice: segment.voice,
  })), [
    { role_id: "human", voice: TTS_ROLE_VOICES.human },
    { role_id: "robot", voice: TTS_ROLE_VOICES.robot },
  ]);
  assert.equal(result.role_response?.parts[1]?.tool_results[0]?.status, "success");
  assert.equal(result.raw_audio_retained, false);
  assert.ok(provider.generated.every((pcm) => pcm.every((sample) => sample === 0)));
  assert.equal(coordinator.active_count, 0);
});

test("speakerless product mode completes only after role execution and Conversation UI delivery", async () => {
  const updates: unknown[] = [];
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    ui_output: "required",
    audio_output: "disabled",
    present_ui: async (deviceId, update) => {
      updates.push(structuredClone(update));
      return {
        schema_version: 1,
        device_id: deviceId,
        session_id: update.session_id,
        stream_id: update.stream_id,
        epoch: update.epoch,
        revision: update.revision,
        status: "completed",
      };
    },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(22));
  const result = await coordinator.run(
    interaction(22), new AbortController().signal, context(22),
  );

  assert.equal(result.outcome, "completed");
  assert.equal(result.role_execution, "completed");
  assert.equal(result.ui_delivery, "completed");
  assert.equal(result.audio_delivery, "deferred");
  assert.equal(result.tts_pcm_bytes, 0);
  assert.equal(result.playback_segments.length, 0);
  assert.deepEqual(updates, [{
    ui_protocol_version: 1,
    type: "ui.update",
    session_id: context(22).session_id,
    stream_id: 22,
    epoch: 22,
    revision: 1,
    stage: "completed",
    user_text: interaction(22).text,
    response_text: mixedResponse().text,
    response_role: "mixed",
    execution_status: "completed",
  }]);
});

test("Conversation UI delivery failure does not rewrite a completed Robot result", async () => {
  const response = mixedResponse();
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(response),
    ui_output: "required",
    audio_output: "disabled",
    present_ui: async () => { throw new Error("display offline"); },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(23));
  const result = await coordinator.run(
    interaction(23), new AbortController().signal, context(23),
  );
  assert.equal(result.outcome, "ui_failed");
  assert.equal(result.role_execution, "completed");
  assert.equal(result.ui_delivery, "failed");
  assert.equal(result.audio_delivery, "deferred");
  assert.equal(result.role_response?.parts[1]?.tool_results[0]?.status, "success");
});

test("new capture atomically cancels old voice work and low-priority Cat before late TTS can play", async () => {
  let resolveTts: ((value: Awaited<ReturnType<RoleAwareTtsPipeline["render"]>>) => void) | null = null;
  const provider = new FakeTtsProvider();
  const rendered = await new RoleAwareTtsPipeline(provider).render(
    interaction(1).interaction_id, mixedResponse(),
  );
  let playbackCalls = 0;
  const catCancels: number[] = [];
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    render_tts: async () => await new Promise((resolve) => { resolveTts = resolve; }),
    playback: async (deviceId) => {
      playbackCalls++;
      return playbackSummary(deviceId);
    },
    cancel_low_priority_cat: (_reason, value) => { catCancels.push(value.epoch); },
  });
  coordinator.onCaptureOpen(summary(1));
  const pending = coordinator.run(interaction(1), new AbortController().signal, context(1));
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.onCaptureOpen(summary(2));
  assert.notEqual(resolveTts, null);
  const completeTts = resolveTts as unknown as (value: typeof rendered) => void;
  completeTts(rendered);
  const result = await pending;

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.role_execution, "completed");
  assert.equal(result.audio_delivery, "cancelled");
  assert.equal(playbackCalls, 0);
  assert.deepEqual(catCancels, [1, 2]);
  assert.ok(rendered.segments.every((segment) => segment.pcm.every((sample) => sample === 0)));
});

test("cancellation during Conversation UI delivery preserves completed Role truth", async () => {
  let uiStarted = false;
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    ui_output: "required",
    audio_output: "disabled",
    present_ui: async (_deviceId, _update, signal) => {
      uiStarted = true;
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
          once: true,
        }));
      }
      throw signal.reason;
    },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(24));
  const pending = coordinator.run(
    interaction(24), new AbortController().signal, context(24),
  );
  while (!uiStarted) await new Promise((resolve) => setImmediate(resolve));
  coordinator.onCaptureOpen(summary(25));
  const result = await pending;

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.role_execution, "completed");
  assert.equal(result.ui_delivery, "cancelled");
  assert.equal(result.audio_delivery, "deferred");
});

test("Robot unknown truth survives playback failure and cannot be rewritten by model prose", async () => {
  const provider = new FakeTtsProvider();
  const unknown = unknownRobotResponse();
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(unknown),
    render_tts: async (id, response, signal) => (
      await new RoleAwareTtsPipeline(provider).render(id, response, signal)
    ),
    playback: async () => { throw new Error("injected disconnect"); },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(3));
  const result = await coordinator.run(interaction(3), new AbortController().signal, context(3));

  assert.equal(result.outcome, "playback_failed");
  assert.equal(provider.requests[0]?.text, "设备操作结果尚不确定。");
  assert.equal(result.role_response?.parts[0]?.tool_results[0]?.status, "error");
  assert.equal(result.role_response?.parts[0]?.tool_results[0]?.error?.code, "HA_OUTCOME_UNKNOWN");
});

test("barge-in waits for dispatched Robot unknown truth but never renders the old response", async () => {
  let roleStarted = false;
  let ttsCalls = 0;
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async (_interaction, signal) => {
      roleStarted = true;
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
          once: true,
        }));
      }
      return roleResult(unknownRobotResponse());
    },
    render_tts: async () => {
      ttsCalls++;
      throw new Error("cancelled Robot response must not render");
    },
    playback: async () => { throw new Error("cancelled Robot response must not play"); },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(8));
  const pending = coordinator.run(interaction(8), new AbortController().signal, context(8));
  while (!roleStarted) await new Promise((resolve) => setImmediate(resolve));
  coordinator.onCaptureOpen(summary(9));
  const result = await pending;

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.role_execution, "completed");
  assert.equal(ttsCalls, 0);
  assert.equal(result.role_response?.parts[0]?.tool_results[0]?.error?.code, "HA_OUTCOME_UNKNOWN");
});

test("device disconnect aborts current playback and prevents later role segments", async () => {
  const provider = new FakeTtsProvider();
  let releasePlayback: (() => void) | null = null;
  let calls = 0;
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    render_tts: async (id, response, signal) => (
      await new RoleAwareTtsPipeline(provider).render(id, response, signal)
    ),
    playback: async (deviceId) => {
      calls++;
      await new Promise<void>((resolve) => { releasePlayback = resolve; });
      return playbackSummary(deviceId);
    },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(4));
  const pending = coordinator.run(interaction(4), new AbortController().signal, context(4));
  while (releasePlayback === null) await new Promise((resolve) => setImmediate(resolve));
  coordinator.onDeviceDisconnect(DEVICE_ID);
  (releasePlayback as () => void)();
  const result = await pending;

  assert.equal(result.outcome, "cancelled");
  assert.equal(calls, 1);
  assert.equal(result.playback_segments.length, 1);
  assert.equal(coordinator.active_count, 0);
});

test("stale epochs never enter Role/TTS/playback and result history stays bounded", async () => {
  let roleCalls = 0;
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => { roleCalls++; return roleResult(); },
    render_tts: async () => { throw new Error("must not render"); },
    playback: async () => { throw new Error("must not play"); },
    cancel_low_priority_cat: () => undefined,
    max_results: 1,
  });
  coordinator.onCaptureOpen(summary(7));
  const stale = await coordinator.run(interaction(6), new AbortController().signal, context(6));
  const current = await coordinator.run(interaction(7), new AbortController().signal, context(7));
  const duplicate = await coordinator.run(interaction(7), new AbortController().signal, context(7));

  assert.equal(stale.outcome, "stale");
  assert.equal(current.outcome, "tts_failed");
  assert.equal(duplicate.outcome, "stale");
  assert.equal(roleCalls, 1);
  assert.equal(coordinator.results.length, 1);
  assert.equal(coordinator.results[0]?.epoch, 7);
  assert.equal(coordinator.results[0]?.outcome, "stale");
});

test("barge-in cancellation registry aborts all active low-priority Cat runs", () => {
  const registry = new LowPriorityCatRunRegistry(2);
  const first = registry.begin("cat:run:1");
  const second = registry.begin("cat:run:2");
  assert.equal(registry.active_count, 2);

  assert.equal(registry.cancelAll("barge_in"), 2);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal((first.signal.reason as DOMException).message, "barge_in");
  assert.equal(registry.active_count, 2, "terminating leases must block duplicate run_id reuse");
  assert.throws(() => registry.begin("cat:run:1"), /already active/);
  first.release();
  second.release();
  assert.equal(registry.active_count, 0);
  registry.close();
  assert.throws(() => registry.begin("cat:run:3"), /closed/);
});

test("P4 cancelled playback remains cancelled even before the next capture callback", async () => {
  const provider = new FakeTtsProvider();
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult({ ...mixedResponse(), parts: [mixedResponse().parts[0]!] }),
    render_tts: async (id, response, signal) => (
      await new RoleAwareTtsPipeline(provider).render(id, response, signal)
    ),
    playback: async (deviceId) => playbackSummary(deviceId, "cancelled"),
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(10));
  const result = await coordinator.run(interaction(10), new AbortController().signal, context(10));
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.playback_segments[0]?.playback.status, "cancelled");
});

test("remote playback cancel remains a dispatched STT interaction through the real binding", async () => {
  const response = { ...mixedResponse(), parts: [mixedResponse().parts[0]!] };
  const tts = new FakeTtsProvider();
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(response),
    render_tts: async (id, value, signal) => (
      await new RoleAwareTtsPipeline(tts).render(id, value, signal)
    ),
    playback: async (deviceId) => playbackSummary(deviceId, "cancelled"),
    cancel_low_priority_cat: () => undefined,
  });
  const bindings = bindVoiceInteractionCoordinator(coordinator);
  const stt: SttProvider = {
    async transcribe(request): Promise<SttFinalTranscript> {
      return {
        schema_version: 1,
        kind: "final",
        session_id: request.session_id,
        stream_id: request.stream_id,
        epoch: request.epoch,
        text: "你好",
        language: "zh",
        duration_ms: 300,
      };
    },
  };
  const pipeline = new VoiceSttPipeline({
    provider: stt,
    on_capture_open: bindings.on_capture_open,
    dispatch_final: bindings.dispatch_final,
  });
  const active = summary(20);
  pipeline.onSessionOpen(active);
  let sequence = 0;
  for (; sequence < 15; sequence++) pipeline.onFrame(active, voiceFrame(20, sequence, 1_200));
  for (let silence = 0; silence < 40; silence++, sequence++) {
    pipeline.onFrame(active, voiceFrame(20, sequence, 0));
  }
  pipeline.onSessionClosed({ ...active, status: "completed", eos: true });
  await pipeline.drain();

  assert.equal(pipeline.results[0]?.outcome, "dispatched");
  assert.equal(coordinator.results[0]?.outcome, "cancelled");
});

test("upstream disconnect cancellation remains stale through the real binding", async () => {
  let roleStarted = false;
  let ttsCalls = 0;
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async (_value, signal) => {
      roleStarted = true;
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
          once: true,
        }));
      }
      return roleResult();
    },
    render_tts: async () => { ttsCalls++; throw new Error("must not render"); },
    playback: async () => { throw new Error("must not play"); },
    cancel_low_priority_cat: () => undefined,
  });
  const bindings = bindVoiceInteractionCoordinator(coordinator);
  const stt: SttProvider = {
    async transcribe(request): Promise<SttFinalTranscript> {
      return {
        schema_version: 1,
        kind: "final",
        session_id: request.session_id,
        stream_id: request.stream_id,
        epoch: request.epoch,
        text: "你好",
        language: "zh",
        duration_ms: 300,
      };
    },
  };
  const pipeline = new VoiceSttPipeline({
    provider: stt,
    on_capture_open: bindings.on_capture_open,
    dispatch_final: bindings.dispatch_final,
  });
  const active = summary(22);
  pipeline.onSessionOpen(active);
  let sequence = 0;
  for (; sequence < 15; sequence++) pipeline.onFrame(active, voiceFrame(22, sequence, 1_200));
  for (let silence = 0; silence < 40; silence++, sequence++) {
    pipeline.onFrame(active, voiceFrame(22, sequence, 0));
  }
  pipeline.onSessionClosed({ ...active, status: "completed", eos: true });
  while (!roleStarted) await new Promise((resolve) => setImmediate(resolve));
  pipeline.onDeviceDisconnect(DEVICE_ID);
  coordinator.onDeviceDisconnect(DEVICE_ID);
  await pipeline.drain();

  assert.equal(pipeline.results[0]?.outcome, "stale");
  assert.equal(coordinator.results[0]?.outcome, "cancelled");
  assert.equal(ttsCalls, 0);
});

test("coordinator rejects malformed TTS order and foreign playback identity, then wipes PCM", async () => {
  const provider = new FakeTtsProvider();
  const malformed = await new RoleAwareTtsPipeline(provider).render(
    interaction(11).interaction_id, mixedResponse(),
  );
  (malformed.segments[0] as { segment_index: number }).segment_index = 7;
  const malformedCoordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    render_tts: async () => malformed,
    playback: async (deviceId) => playbackSummary(deviceId),
    cancel_low_priority_cat: () => undefined,
  });
  malformedCoordinator.onCaptureOpen(summary(11));
  const malformedResult = await malformedCoordinator.run(
    interaction(11), new AbortController().signal, context(11),
  );
  assert.equal(malformedResult.outcome, "tts_failed");
  assert.ok(malformed.segments.every((segment) => segment.pcm.every((sample) => sample === 0)));

  const foreignProvider = new FakeTtsProvider();
  const foreignCoordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult({ ...mixedResponse(), parts: [mixedResponse().parts[0]!] }),
    render_tts: async (id, response, signal) => (
      await new RoleAwareTtsPipeline(foreignProvider).render(id, response, signal)
    ),
    playback: async () => playbackSummary("foreign-p4"),
    cancel_low_priority_cat: () => undefined,
  });
  foreignCoordinator.onCaptureOpen(summary(12));
  const foreignResult = await foreignCoordinator.run(
    interaction(12), new AbortController().signal, context(12),
  );
  assert.equal(foreignResult.outcome, "playback_failed");
  assert.equal(foreignResult.playback_segments.length, 0);
  assert.ok(foreignProvider.generated.every((pcm) => pcm.every((sample) => sample === 0)));

  const invalidCountersProvider = new FakeTtsProvider();
  const invalidCountersCoordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult({ ...mixedResponse(), parts: [mixedResponse().parts[0]!] }),
    render_tts: async (id, response, signal) => (
      await new RoleAwareTtsPipeline(invalidCountersProvider).render(id, response, signal)
    ),
    playback: async (deviceId) => ({
      ...playbackSummary(deviceId, "cancelled"), frames: 0, bytes: 640,
    }),
    cancel_low_priority_cat: () => undefined,
  });
  invalidCountersCoordinator.onCaptureOpen(summary(16));
  const invalidCountersResult = await invalidCountersCoordinator.run(
    interaction(16), new AbortController().signal, context(16),
  );
  assert.equal(invalidCountersResult.outcome, "playback_failed");
  assert.equal(invalidCountersResult.playback_segments.length, 0);
});

test("paired-device maps are bounded and close clears their high-water state", () => {
  const coordinator = new VoiceInteractionCoordinator({
    device_ids: [DEVICE_ID],
    dispatch_role: async () => roleResult(),
    render_tts: async () => { throw new Error("unused"); },
    playback: async () => { throw new Error("unused"); },
    cancel_low_priority_cat: () => undefined,
  });
  coordinator.onCaptureOpen(summary(13));
  assert.equal(coordinator.known_device_count, 1);
  assert.throws(() => coordinator.onCaptureOpen({ ...summary(14), device_id: "foreign-p4" }), /paired/);
  coordinator.close();
  assert.equal(coordinator.known_device_count, 0);
});

test("real unified runtime assembly shares the Cat lease cancellation fence", async () => {
  const registry = new LowPriorityCatRunRegistry();
  const lease = registry.begin("cat:assembly:1");
  const runtime = new UnifiedVoiceRuntime({
    server: {
      host: "127.0.0.1",
      port: 0,
      allow_insecure_loopback_test: true,
    },
    device_tokens: { [DEVICE_ID]: "phase-5d-assembly-token-0123456789abcdef" },
    stt: {
      provider: { async transcribe() { throw new Error("unused"); } },
    },
    interaction: {
      dispatch_role: async () => roleResult(),
      render_tts: async () => { throw new Error("unused"); },
    },
    cat_run_registry: registry,
  });
  runtime.pipeline.onSessionOpen(summary(15));
  assert.equal(lease.signal.aborted, true);
  assert.equal(registry.active_count, 1);
  assert.throws(() => registry.begin("cat:assembly:1"), /already active/);
  lease.release();
  assert.equal(registry.active_count, 0);
  await runtime.close();
});

test("unified runtime shutdown aborts work first and still cleans up after server close failure", async () => {
  const registry = new LowPriorityCatRunRegistry();
  const lease = registry.begin("cat:shutdown:1");
  const runtime = new UnifiedVoiceRuntime({
    server: { host: "127.0.0.1", port: 0, allow_insecure_loopback_test: true },
    device_tokens: { [DEVICE_ID]: "phase-5d-shutdown-token-0123456789abcdef" },
    stt: { provider: { async transcribe() { throw new Error("unused"); } } },
    interaction: {
      dispatch_role: async () => roleResult(),
      render_tts: async () => { throw new Error("unused"); },
    },
    cat_run_registry: registry,
  });
  const server = runtime.server as unknown as { close(): Promise<void> };
  const originalClose = server.close.bind(runtime.server);
  let closeCalls = 0;
  server.close = async () => {
    closeCalls++;
    assert.equal(lease.signal.aborted, true);
    throw new Error("injected server close failure");
  };
  await assert.rejects(runtime.close(), /cleanup failed/);
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => runtime.pipeline.onSessionOpen(summary(21)), /closed/);
  await assert.rejects(runtime.start(), /closed/);
  server.close = async () => { closeCalls++; await originalClose(); };
  await runtime.close();
  assert.equal(closeCalls, 2);
  lease.release();
});
