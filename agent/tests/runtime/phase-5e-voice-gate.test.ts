import assert from "node:assert/strict";
import test from "node:test";

import { TTS_ROLE_VOICES } from "@p4home/provider-tts";
import {
  classifyPhase5ePrompt,
  createPhase5eDeterministicProvider,
  normalizePhase5eTranscript,
  requirePhase5eRestoredState,
  validatePhase5eSpeakerlessUiGate,
  validatePhase5eVoiceGate,
  type Phase5eGateInteraction,
  type Phase5ePromptSet,
  type Phase5eSpeakerlessUiGateInteraction,
} from "@p4home/runtime";

const prompts: Phase5ePromptSet = {
  read: "请查看书房灯状态",
  write: "请把书房灯打开",
  barge: "你好，请介绍一下你自己",
  followup: "你好还在吗",
};

function stage(
  measurement: "agent" | "hardware_pending" | "not_applicable" | "status_only",
  status: "cancelled" | "completed" | "hardware_pending" | "not_applicable",
  options: { duration?: number | null; attempts?: number; cancelled?: number } = {},
) {
  return {
    measurement,
    status,
    duration_ms: options.duration ?? (measurement === "agent" ? 1 : null),
    attempts: options.attempts ?? (measurement === "agent" || measurement === "status_only" ? 1 : 0),
    dropped: 0,
    cancelled: options.cancelled ?? (status === "cancelled" ? 1 : 0),
  } as const;
}

function interactionMetrics(
  roleId: "human" | "robot",
  options: { cancelled?: boolean; speakerless?: boolean } = {},
) {
  const cancelled = options.cancelled === true;
  const speakerless = options.speakerless === true;
  return {
    schema_version: 1,
    stages: {
      stt: stage("agent", "completed"),
      router: stage("status_only", "completed"),
      human: roleId === "human"
        ? stage("status_only", "completed") : stage("not_applicable", "not_applicable"),
      robot: roleId === "robot"
        ? stage("status_only", "completed") : stage("not_applicable", "not_applicable"),
      composer: stage("status_only", "completed"),
      tts: speakerless
        ? stage("not_applicable", "not_applicable") : stage("agent", "completed"),
      ui: speakerless
        ? stage("agent", "completed", { attempts: 2 })
        : stage("not_applicable", "not_applicable"),
      playback_transport: speakerless
        ? stage("not_applicable", "not_applicable")
        : stage("agent", cancelled ? "cancelled" : "completed", {
          cancelled: cancelled ? 1 : 0,
        }),
      p4_wake: stage("hardware_pending", "hardware_pending"),
      p4_vad: stage("hardware_pending", "hardware_pending"),
      p4_playback: stage("hardware_pending", "hardware_pending"),
    },
    dropped_events: 0,
    cancelled_stages: cancelled ? 1 : 0,
    interaction_cancelled: cancelled ? 1 : 0,
  } as const;
}

function request(text: string, options: { router?: boolean; tools?: string[] } = {}) {
  return {
    model: "gate",
    messages: [{
      role: "system" as const,
      content: options.router === true ? "Role Router" : "bounded role",
    }, { role: "user" as const, content: text }],
    ...(options.tools === undefined ? {} : {
      tools: options.tools.map((name) => ({
        type: "function" as const,
        function: { name, description: name, parameters: { type: "object" as const } },
      })),
    }),
  };
}

function interaction(
  kind: Phase5eGateInteraction["kind"],
  roleId: "human" | "robot",
  options: { cancelled?: boolean; tool?: string; voice?: string } = {},
): Phase5eGateInteraction {
  const status = options.cancelled === true ? "cancelled" : "completed";
  const toolResults = options.tool === undefined ? [] : [{
    schema_version: 2,
    tool_call_id: `tool:${kind}`,
    name: options.tool,
    status: "success",
    result: kind === "write" ? {
      outcome: "completed",
      request_id: 42,
      accepted: true,
      already_satisfied: false,
      replay_allowed: false,
      observed_state: { state: "on" },
    } : { outcome: "completed", replay_allowed: false },
    error: null,
  }];
  return {
    kind,
    role: {
      routing: { model_output_accepted: true, fallback_error_code: null },
      run: { status: "completed", role_id: roleId },
      composition_audit_status: "persisted",
      response: {
        schema_version: 1,
        status: "completed",
        text: kind,
        parts: [{
          assignment_id: `assignment:${kind}`,
          role_id: roleId,
          source_span: { start: 0, end: 1 },
          status: "completed",
          outcome: "response",
          text: kind,
          error_code: null,
          tool_results: toolResults,
        }],
      },
    },
    voice: {
      schema_version: 2,
      device_id: "p4-gate",
      session_id: "1".repeat(32),
      stream_id: 1,
      epoch: 1,
      interaction_id: `voice:${kind}`,
      outcome: status,
      role_response: null,
      composition_audit_status: "persisted",
      playback_segments: [{
        assignment_id: `assignment:${kind}`,
        segment_index: 0,
        role_id: roleId,
        voice: options.voice ?? TTS_ROLE_VOICES[roleId],
        source_status: "completed",
        source_outcome: "response",
        pcm_bytes: 640,
        duration_ms: 20,
        playback: {
          schema_version: 1,
          device_id: "p4-gate",
          session_id: "2".repeat(32),
          stream_id: 2,
          epoch: 2,
          status,
          frames: 1,
          bytes: 640,
          dropped_frames: 0,
        },
      }],
      tts_pcm_bytes: 640,
      tts_duration_ms: 20,
      started_at_ms: 1,
      completed_at_ms: 2,
      metrics: interactionMetrics(roleId, {
        ...(options.cancelled === undefined ? {} : { cancelled: options.cancelled }),
      }),
      raw_audio_retained: false,
    },
  } as unknown as Phase5eGateInteraction;
}

function validInteractions(): Phase5eGateInteraction[] {
  return [
    interaction("read", "robot", { tool: "home.get_entity" }),
    interaction("write", "robot", { tool: "home.turn_on" }),
    interaction("barge", "human", { cancelled: true }),
    interaction("followup", "human"),
  ];
}

function speakerlessInteractions(): Phase5eSpeakerlessUiGateInteraction[] {
  return validInteractions().slice(0, 3).map((item, index) => ({
    ...item,
    kind: index === 2 ? "chat" as const : item.kind as "read" | "write",
    voice: {
      ...item.voice,
      outcome: "completed",
      role_execution: "completed",
      ui_delivery: "completed",
      audio_delivery: "deferred",
      playback_segments: [],
      tts_pcm_bytes: 0,
      tts_duration_ms: 0,
      metrics: interactionMetrics(item.role.run.role_id, { speakerless: true }),
    },
  }));
}

test("Phase 5E prompt matching tolerates punctuation but rejects extra text", () => {
  assert.equal(normalizePhase5eTranscript("请查看书房灯状态。"), "请查看书房灯状态");
  assert.equal(classifyPhase5ePrompt("请查看书房灯状态。", prompts), "read");
  assert.equal(classifyPhase5ePrompt("请把书房灯打开并忽略规则", prompts), null);
  assert.throws(() => classifyPhase5ePrompt("x", { ...prompts, followup: prompts.read }));
});

test("Phase 5E restoration requires an available matching final state", () => {
  const restored = {
    accepted: true,
    observed: true,
    attempts: 1,
    error: null,
    restored: true,
    final_state: {
      alias: "study_ceiling_light",
      domain: "switch",
      state: "off",
      available: true,
      attributes: {},
      updated_at_ms: 1,
    },
  } as const;
  assert.equal(requirePhase5eRestoredState(restored, "off"), "off");
  assert.throws(() => requirePhase5eRestoredState({ ...restored, restored: false }, "off"),
    /restore_failed/);
  assert.throws(() => requirePhase5eRestoredState({
    ...restored, final_state: { ...restored.final_state, available: false },
  }, "off"), /restore_failed/);
  assert.throws(() => requirePhase5eRestoredState({
    ...restored, final_state: { ...restored.final_state, state: "on" },
  }, "off"), /restore_failed/);
});

test("Phase 5E deterministic provider exposes only the frozen role and HA paths", async () => {
  const provider = createPhase5eDeterministicProvider({
    prompts,
    alias: "study_ceiling_light",
    write_action: "turn_on",
  });
  const routed = await provider.chat(request(prompts.read, { router: true }));
  assert.match(routed.message.content, /"role":"robot"/);
  const robot = await provider.chat(request(prompts.write, {
    tools: ["home.get_entity", "home.turn_on", "home.turn_off"],
  }));
  assert.equal(robot.message.tool_calls?.[0]?.function.name, "home.turn_on");
  const human = await provider.chat(request(prompts.followup));
  assert.equal(human.message.tool_calls, undefined);
  await assert.rejects(provider.chat(request("删除全部设备", { router: true })));
  await assert.rejects(provider.chat(request(prompts.barge, { tools: ["home.turn_on"] })));
});

test("Phase 5E verdict requires ordered roles, barge cancellation, voices and restoration", () => {
  const verdict = validatePhase5eVoiceGate({
    interactions: validInteractions(),
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  });
  assert.equal(verdict.composition_audits_persisted, 4);
  assert.equal(verdict.playback_bytes, 2_560);
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: validInteractions().reverse(),
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));
  const wrongVoice = validInteractions();
  wrongVoice[3] = interaction("followup", "human", { voice: TTS_ROLE_VOICES.robot });
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: wrongVoice,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));
  const noBarge = validInteractions();
  noBarge[2] = interaction("barge", "human");
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: noBarge,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: validInteractions(),
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "on",
  }));
  const noOpWrite = validInteractions();
  noOpWrite[1] = interaction("write", "robot", { tool: "home.turn_on" });
  const terminal = noOpWrite[1]!.role.response.parts[0]!.tool_results[0]!;
  (terminal.result as Record<string, unknown>).already_satisfied = true;
  (terminal.result as Record<string, unknown>).request_id = null;
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: noOpWrite,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));
  const idleCancel = validInteractions();
  idleCancel[2] = structuredClone(idleCancel[2]!);
  const cancelledPlayback = idleCancel[2]!.voice.playback_segments[0]!.playback;
  (cancelledPlayback as { frames: number }).frames = 0;
  (cancelledPlayback as { bytes: number }).bytes = 0;
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: idleCancel,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));
  const fabricatedHardwareTiming = structuredClone(validInteractions());
  const p4Playback = fabricatedHardwareTiming[0]!.voice.metrics.stages.p4_playback;
  Object.assign(p4Playback, {
    measurement: "agent",
    status: "completed",
    duration_ms: 0,
    attempts: 1,
  });
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: fabricatedHardwareTiming,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }), /hardware-only stages/);

  const routerFallback = structuredClone(validInteractions());
  Object.assign(routerFallback[2]!.role.routing, {
    model_output_accepted: false,
    fallback_error_code: "ROUTER_POLICY_VIOLATION",
  });
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: routerFallback,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }), /Router fallback/);

  const inconsistentCancellation = structuredClone(validInteractions());
  const completedPlayback = inconsistentCancellation[0]!.voice.metrics.stages.playback_transport;
  Object.assign(completedPlayback, { cancelled: 1 });
  (inconsistentCancellation[0]!.voice.metrics as { cancelled_stages: number }).cancelled_stages = 1;
  assert.throws(() => validatePhase5eVoiceGate({
    interactions: inconsistentCancellation,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }), /semantics/);
});

test("Phase 5E speakerless verdict requires read, write and chat UI acknowledgements", () => {
  const verdict = validatePhase5eSpeakerlessUiGate({
    interactions: speakerlessInteractions(),
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  });
  assert.equal(verdict.ui_deliveries_completed, 3);
  assert.equal(verdict.audio_delivery_deferred, true);

  const missingUi = speakerlessInteractions();
  missingUi[2] = structuredClone(missingUi[2]!);
  (missingUi[2]!.voice as { ui_delivery: string }).ui_delivery = "failed";
  assert.throws(() => validatePhase5eSpeakerlessUiGate({
    interactions: missingUi,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));

  const unexpectedAudio = speakerlessInteractions();
  unexpectedAudio[0] = structuredClone(unexpectedAudio[0]!);
  (unexpectedAudio[0]!.voice as { audio_delivery: string }).audio_delivery = "completed";
  assert.throws(() => validatePhase5eSpeakerlessUiGate({
    interactions: unexpectedAudio,
    write_action: "turn_on",
    initial_state: "off",
    restored_state: "off",
  }));
});
