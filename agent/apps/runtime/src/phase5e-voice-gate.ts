import { OllamaProviderError, type OllamaChatRequest, type OllamaChatResult } from "@p4home/provider-ollama";
import { TTS_ROLE_VOICES } from "@p4home/provider-tts";

import type { RunRoleInteractionResult } from "./role-orchestrator.ts";
import {
  VOICE_INTERACTION_STAGE_NAMES,
  type VoiceInteractionResult,
  type VoiceStageMetric,
} from "./voice-interaction-coordinator.ts";
import type { GateRestoreResult } from "./phase4c-ha-gate-core.ts";

export type Phase5ePromptKind = "barge" | "followup" | "read" | "write";

export interface Phase5ePromptSet {
  readonly read: string;
  readonly write: string;
  readonly barge: string;
  readonly followup: string;
}

export interface Phase5eGateInteraction {
  readonly kind: Phase5ePromptKind;
  readonly voice: VoiceInteractionResult;
  readonly role: RunRoleInteractionResult;
}

export interface Phase5eSpeakerlessUiGateInteraction {
  readonly kind: "read" | "write" | "chat";
  readonly voice: VoiceInteractionResult;
  readonly role: RunRoleInteractionResult;
}

export interface Phase5eVoiceGateVerdict {
  readonly read_passed: true;
  readonly write_passed: true;
  readonly barge_in_passed: true;
  readonly followup_passed: true;
  readonly composition_audits_persisted: 4;
  readonly playback_segments: number;
  readonly playback_bytes: number;
  readonly raw_audio_retained: false;
}

export interface Phase5eSpeakerlessUiGateVerdict {
  readonly read_passed: true;
  readonly write_passed: true;
  readonly chat_passed: true;
  readonly ui_deliveries_completed: 3;
  readonly audio_delivery_deferred: true;
  readonly composition_audits_persisted: 3;
  readonly raw_audio_retained: false;
}

const SAFE_ALIAS = /^[a-z][a-z0-9_]{0,63}$/;
const STAGE_METRIC_KEYS = [
  "measurement", "status", "duration_ms", "attempts", "dropped", "cancelled",
] as const;
const METRICS_KEYS = [
  "schema_version", "stages", "dropped_events", "cancelled_stages",
  "interaction_cancelled",
] as const;
const MEASUREMENTS = [
  "agent", "hardware_pending", "not_applicable", "status_only", "unavailable",
] as const;
const STATUSES = [
  "cancelled", "completed", "failed", "hardware_pending", "not_applicable",
  "not_attempted", "partial", "timed_out", "unavailable",
] as const;

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function assertStageMetric(value: unknown): asserts value is VoiceStageMetric {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !hasExactKeys(value, STAGE_METRIC_KEYS)) {
    throw new TypeError("Phase 5E stage metric shape is invalid");
  }
  const metric = value as unknown as VoiceStageMetric;
  const boundedCounter = (counter: number): boolean => (
    Number.isInteger(counter) && counter >= 0 && counter <= 4_096
  );
  if (!(MEASUREMENTS as readonly string[]).includes(metric.measurement)
      || !(STATUSES as readonly string[]).includes(metric.status)
      || !boundedCounter(metric.attempts) || !boundedCounter(metric.dropped)
      || !boundedCounter(metric.cancelled) || metric.cancelled > metric.attempts
      || (metric.measurement === "agent"
        ? typeof metric.duration_ms !== "number" || !Number.isInteger(metric.duration_ms)
          || metric.duration_ms < 0
          || metric.duration_ms > 600_000
        : metric.duration_ms !== null)) {
    throw new TypeError("Phase 5E stage metric values are invalid");
  }
}

function assertExactStage(
  metric: VoiceStageMetric,
  expected: Omit<VoiceStageMetric, "duration_ms">,
): void {
  if (metric.measurement !== expected.measurement || metric.status !== expected.status
      || metric.attempts !== expected.attempts || metric.dropped !== expected.dropped
      || metric.cancelled !== expected.cancelled) {
    throw new TypeError("Phase 5E stage metric semantics do not match interaction truth");
  }
}

function assertPhase5eMetrics(
  voice: VoiceInteractionResult,
  mode: "audio" | "speakerless_ui",
  role: RunRoleInteractionResult,
): void {
  const roleId = role.run.role_id;
  if (role.routing.model_output_accepted !== true
      || role.routing.fallback_error_code !== null) {
    throw new TypeError("Phase 5E Router fallback cannot satisfy the measured gate");
  }
  const metrics = voice.metrics;
  if (voice.schema_version !== 2 || metrics === null || typeof metrics !== "object"
      || Array.isArray(metrics) || !hasExactKeys(metrics, METRICS_KEYS)
      || metrics.schema_version !== 1 || metrics.stages === null
      || typeof metrics.stages !== "object" || Array.isArray(metrics.stages)
      || !hasExactKeys(metrics.stages, VOICE_INTERACTION_STAGE_NAMES)) {
    throw new TypeError("Phase 5E interaction metrics schema is invalid");
  }
  for (const name of VOICE_INTERACTION_STAGE_NAMES) assertStageMetric(metrics.stages[name]);
  const values = Object.values(metrics.stages);
  const dropped = values.reduce((sum, metric) => sum + metric.dropped, 0)
    + (voice.outcome === "stale" ? 1 : 0);
  const cancelled = values.reduce((sum, metric) => sum + metric.cancelled, 0);
  if (metrics.dropped_events !== dropped || metrics.cancelled_stages !== cancelled
      || metrics.interaction_cancelled !== (voice.outcome === "cancelled" ? 1 : 0)
      || metrics.stages.stt.measurement !== "agent"
      || metrics.stages.stt.status !== "completed"
      || metrics.stages.router.measurement !== "status_only"
      || metrics.stages.router.status !== "completed"
      || metrics.stages.composer.measurement !== "status_only"
      || metrics.stages.composer.status !== "completed") {
    throw new TypeError("Phase 5E measured stage counters are inconsistent");
  }
  for (const hardware of ["p4_wake", "p4_vad", "p4_playback"] as const) {
    const metric = metrics.stages[hardware];
    if (metric.measurement !== "hardware_pending" || metric.status !== "hardware_pending"
        || metric.duration_ms !== null || metric.attempts !== 0 || metric.dropped !== 0
        || metric.cancelled !== 0) {
      throw new TypeError("Phase 5E hardware-only stages must remain explicitly pending");
    }
  }
  assertExactStage(metrics.stages.stt, {
    measurement: "agent", status: "completed", attempts: 1, dropped: 0, cancelled: 0,
  });
  assertExactStage(metrics.stages.router, {
    measurement: "status_only", status: "completed", attempts: 1, dropped: 0, cancelled: 0,
  });
  assertExactStage(metrics.stages.composer, {
    measurement: "status_only", status: "completed", attempts: 1, dropped: 0, cancelled: 0,
  });
  const activeRole = metrics.stages[roleId];
  const inactiveRole = metrics.stages[roleId === "human" ? "robot" : "human"];
  assertExactStage(activeRole, {
    measurement: "status_only",
    status: "completed",
    attempts: role.response.parts.filter((part) => part.role_id === roleId).length,
    dropped: 0,
    cancelled: 0,
  });
  assertExactStage(inactiveRole, {
    measurement: "not_applicable", status: "not_applicable",
    attempts: 0, dropped: 0, cancelled: 0,
  });
  if (mode === "speakerless_ui") {
    assertExactStage(metrics.stages.ui, {
      measurement: "agent", status: "completed", attempts: 2, dropped: 0, cancelled: 0,
    });
    for (const stage of [metrics.stages.tts, metrics.stages.playback_transport]) {
      assertExactStage(stage, {
        measurement: "not_applicable", status: "not_applicable",
        attempts: 0, dropped: 0, cancelled: 0,
      });
    }
    return;
  }
  const playbackStatus = voice.outcome === "cancelled" ? "cancelled" : "completed";
  assertExactStage(metrics.stages.ui, {
    measurement: "not_applicable", status: "not_applicable",
    attempts: 0, dropped: 0, cancelled: 0,
  });
  assertExactStage(metrics.stages.tts, {
    measurement: "agent", status: "completed", attempts: 1, dropped: 0, cancelled: 0,
  });
  assertExactStage(metrics.stages.playback_transport, {
    measurement: "agent",
    status: playbackStatus,
    attempts: voice.playback_segments.length,
    dropped: voice.playback_segments.reduce(
      (sum, segment) => sum + segment.playback.dropped_frames, 0,
    ),
    cancelled: playbackStatus === "cancelled" ? 1 : 0,
  });
}

export function requirePhase5eRestoredState(
  restore: GateRestoreResult,
  initialState: "off" | "on",
): "off" | "on" {
  if (!restore.restored || restore.final_state?.available !== true
      || restore.final_state.state !== initialState) {
    throw new Error("restore_failed");
  }
  return initialState;
}

export function normalizePhase5eTranscript(value: string): string {
  return value.normalize("NFKC").replace(/[\p{P}\p{Z}]/gu, "").toLowerCase();
}

function assertPrompts(prompts: Phase5ePromptSet): void {
  const normalized = Object.values(prompts).map((value) => {
    if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 128
        || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new TypeError("Phase 5E prompts must be trimmed, bounded text");
    }
    return normalizePhase5eTranscript(value);
  });
  if (normalized.some((value) => value.length === 0) || new Set(normalized).size !== 4) {
    throw new TypeError("Phase 5E prompts must have four unique normalized forms");
  }
}

export function classifyPhase5ePrompt(
  value: string,
  prompts: Phase5ePromptSet,
): Phase5ePromptKind | null {
  assertPrompts(prompts);
  const normalized = normalizePhase5eTranscript(value);
  for (const kind of ["read", "write", "barge", "followup"] as const) {
    if (normalized === normalizePhase5eTranscript(prompts[kind])) return kind;
  }
  return null;
}

function lastUserText(request: OllamaChatRequest): string {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "user");
  if (message === undefined || typeof message.content !== "string") {
    throw new OllamaProviderError("INVALID_RESPONSE", "Phase 5E request has no bounded user text");
  }
  return message.content;
}

export function createPhase5eDeterministicProvider(options: {
  readonly prompts: Phase5ePromptSet;
  readonly alias: string;
  readonly write_action: "turn_off" | "turn_on";
}): { readonly chat: (request: OllamaChatRequest) => Promise<OllamaChatResult> } {
  assertPrompts(options.prompts);
  if (!SAFE_ALIAS.test(options.alias)) throw new TypeError("Phase 5E HA alias is invalid");
  return {
    async chat(request): Promise<OllamaChatResult> {
      const text = lastUserText(request);
      const kind = classifyPhase5ePrompt(text, options.prompts);
      if (kind === null) {
        throw new OllamaProviderError(
          "INVALID_RESPONSE", "Phase 5E holdout transcript is outside the four allowed prompts",
        );
      }
      if (request.messages[0]?.content.includes("Role Router") === true) {
        return {
          model: "phase5e-deterministic-router",
          message: {
            role: "assistant",
            content: JSON.stringify({
              assignments: [{
                role: kind === "read" || kind === "write" ? "robot" : "human",
                text,
              }],
            }),
          },
        };
      }
      if (request.tools !== undefined) {
        if (kind !== "read" && kind !== "write") {
          throw new OllamaProviderError("INVALID_RESPONSE", "Human prompt reached Robot tools");
        }
        const name = kind === "read" ? "home.get_entity" : `home.${options.write_action}`;
        if (!request.tools.some((tool) => tool.function.name === name)) {
          throw new OllamaProviderError("INVALID_RESPONSE", "required Phase 5E tool is unavailable");
        }
        return {
          model: "phase5e-deterministic-robot",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              type: "function",
              function: { name, arguments: { alias: options.alias } },
            }],
          },
        };
      }
      if (kind === "barge") {
        return {
          model: "phase5e-deterministic-human",
          message: {
            role: "assistant",
            content: "你好，我是小贝。我会认真倾听你的问题，也会在需要控制家居时把执行交给受限的 Robot，并如实说明结果。",
          },
        };
      }
      if (kind === "followup") {
        return {
          model: "phase5e-deterministic-human",
          message: { role: "assistant", content: "你好，我在。" },
        };
      }
      throw new OllamaProviderError("INVALID_RESPONSE", "Robot prompt reached Human response path");
    },
  };
}

function successfulTool(
  role: RunRoleInteractionResult,
  name: string,
  expectedState?: "off" | "on",
): boolean {
  const terminal = role.response.parts[0]?.tool_results[0];
  const result = terminal?.status === "success" ? terminal.result : null;
  const writeProven = expectedState === undefined || (
    result !== null && typeof result === "object" && !Array.isArray(result)
    && result.outcome === "completed"
    && typeof result.request_id === "number" && Number.isSafeInteger(result.request_id)
    && result.request_id > 0 && result.accepted === true
    && result.already_satisfied === false && result.replay_allowed === false
    && result.observed_state !== null && typeof result.observed_state === "object"
    && !Array.isArray(result.observed_state)
    && (result.observed_state as Record<string, unknown>).state === expectedState
  );
  return role.run.status === "completed" && role.run.role_id === "robot"
    && role.response.status === "completed" && terminal?.status === "success"
    && terminal.name === name && writeProven;
}

export function validatePhase5eVoiceGate(options: {
  readonly interactions: readonly Phase5eGateInteraction[];
  readonly write_action: "turn_off" | "turn_on";
  readonly initial_state: "off" | "on";
  readonly restored_state: string | null;
}): Phase5eVoiceGateVerdict {
  if (options.interactions.length !== 4
      || options.interactions.map((item) => item.kind).join(",") !== "read,write,barge,followup") {
    throw new TypeError("Phase 5E requires the exact four-interaction order");
  }
  const [read, write, barge, followup] = options.interactions as readonly [
    Phase5eGateInteraction, Phase5eGateInteraction,
    Phase5eGateInteraction, Phase5eGateInteraction,
  ];
  for (const item of options.interactions) {
    assertPhase5eMetrics(item.voice, "audio", item.role);
  }
  const completed = (item: Phase5eGateInteraction, roleId: "human" | "robot"): boolean => (
    item.voice.outcome === "completed"
    && item.role.run.status === "completed" && item.role.run.role_id === roleId
    && item.voice.playback_segments.length === item.role.response.parts.length
    && item.voice.playback_segments.every((segment) => segment.playback.status === "completed")
  );
  if (!completed(read, "robot") || !successfulTool(read.role, "home.get_entity")) {
    throw new TypeError("Phase 5E read interaction did not complete through Robot and playback");
  }
  const targetState = options.write_action === "turn_on" ? "on" : "off";
  if (!completed(write, "robot")
      || !successfulTool(write.role, `home.${options.write_action}`, targetState)) {
    throw new TypeError("Phase 5E write interaction did not complete through Robot and playback");
  }
  if (barge.voice.outcome !== "cancelled" || barge.role.run.role_id !== "human"
      || barge.role.run.status !== "completed" || barge.role.response.status !== "completed"
      || barge.voice.playback_segments.length < 1
      || barge.voice.playback_segments.some((segment) => (
        segment.role_id !== "human" || segment.voice !== TTS_ROLE_VOICES.human
      ))
      || !barge.voice.playback_segments.some((segment) => (
        segment.playback.status === "cancelled"
        && segment.playback.frames > 0 && segment.playback.bytes > 0
      ))) {
    throw new TypeError("Phase 5E barge-in did not cancel active Human playback");
  }
  if (!completed(followup, "human") || followup.role.response.parts[0]?.tool_results.length !== 0) {
    throw new TypeError("Phase 5E follow-up did not complete as tool-free Human playback");
  }
  if (options.interactions.some((item) => item.role.composition_audit_status !== "persisted")
      || options.interactions.some((item) => item.voice.raw_audio_retained !== false)
      || read.voice.playback_segments.some((segment) => segment.voice !== TTS_ROLE_VOICES.robot)
      || write.voice.playback_segments.some((segment) => segment.voice !== TTS_ROLE_VOICES.robot)
      || followup.voice.playback_segments.some((segment) => segment.voice !== TTS_ROLE_VOICES.human)
      || options.restored_state !== options.initial_state) {
    throw new TypeError("Phase 5E audit, role voice, retention or restoration invariant failed");
  }
  const segments = options.interactions.flatMap((item) => item.voice.playback_segments);
  return {
    read_passed: true,
    write_passed: true,
    barge_in_passed: true,
    followup_passed: true,
    composition_audits_persisted: 4,
    playback_segments: segments.length,
    playback_bytes: segments.reduce((total, segment) => total + segment.pcm_bytes, 0),
    raw_audio_retained: false,
  };
}

export function validatePhase5eSpeakerlessUiGate(options: {
  readonly interactions: readonly Phase5eSpeakerlessUiGateInteraction[];
  readonly write_action: "turn_off" | "turn_on";
  readonly initial_state: "off" | "on";
  readonly restored_state: string | null;
}): Phase5eSpeakerlessUiGateVerdict {
  if (options.interactions.length !== 3
      || options.interactions.map((item) => item.kind).join(",") !== "read,write,chat") {
    throw new TypeError("Phase 5E speakerless UI gate requires read, write and chat order");
  }
  const [read, write, chat] = options.interactions as readonly [
    Phase5eSpeakerlessUiGateInteraction, Phase5eSpeakerlessUiGateInteraction,
    Phase5eSpeakerlessUiGateInteraction,
  ];
  for (const item of options.interactions) {
    assertPhase5eMetrics(item.voice, "speakerless_ui", item.role);
  }
  const completed = (
    item: Phase5eSpeakerlessUiGateInteraction, roleId: "human" | "robot",
  ): boolean => (
    item.voice.outcome === "completed"
    && item.voice.role_execution === "completed"
    && item.voice.ui_delivery === "completed"
    && item.voice.audio_delivery === "deferred"
    && item.voice.playback_segments.length === 0
    && item.voice.tts_pcm_bytes === 0
    && item.role.run.status === "completed"
    && item.role.run.role_id === roleId
    && item.role.response.status === "completed"
  );
  if (!completed(read, "robot") || !successfulTool(read.role, "home.get_entity")) {
    throw new TypeError("Phase 5E speakerless read did not complete through Robot and UI");
  }
  const targetState = options.write_action === "turn_on" ? "on" : "off";
  if (!completed(write, "robot")
      || !successfulTool(write.role, `home.${options.write_action}`, targetState)) {
    throw new TypeError("Phase 5E speakerless write did not complete through Robot and UI");
  }
  if (!completed(chat, "human") || chat.role.response.parts.length !== 1
      || chat.role.response.parts[0]?.tool_results.length !== 0) {
    throw new TypeError("Phase 5E speakerless chat did not complete through Human and UI");
  }
  if (options.interactions.some((item) => item.role.composition_audit_status !== "persisted")
      || options.interactions.some((item) => item.voice.raw_audio_retained !== false)
      || options.restored_state !== options.initial_state) {
    throw new TypeError("Phase 5E speakerless audit, retention or restoration invariant failed");
  }
  return {
    read_passed: true,
    write_passed: true,
    chat_passed: true,
    ui_deliveries_completed: 3,
    audio_delivery_deferred: true,
    composition_audits_persisted: 3,
    raw_audio_retained: false,
  };
}
