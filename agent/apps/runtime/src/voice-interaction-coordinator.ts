import { isDeepStrictEqual } from "node:util";

import {
  CONVERSATION_UI_MAX_RESPONSE_BYTES,
  CONVERSATION_UI_MAX_RESPONSE_CHARS,
  CONVERSATION_UI_MAX_USER_BYTES,
  CONVERSATION_UI_MAX_USER_CHARS,
  validateConversationUiUpdate,
  type ConversationUiUpdate,
} from "@p4home/contracts";
import { TTS_MAX_PCM_BYTES, TTS_ROLE_VOICES, TTS_SAMPLE_RATE_HZ } from "@p4home/provider-tts";

import type { ComposedRoleResponse } from "./role-response-composer.ts";
import type { RunRoleInteractionResult } from "./role-orchestrator.ts";
import type { UserTextInteraction } from "./role-contracts.ts";
import type { RoleAwareTtsResult, RoleAwareTtsSegment } from "./role-aware-tts.ts";
import type { VoicePlaybackSummary } from "./voice-playback-sender.ts";
import type {
  ConversationUiDeliverySummary,
  VoiceCaptureSummary,
  VoiceDispatchContext,
} from "./voice-websocket-server.ts";

const MAX_RESULT_HISTORY = 4_096;
const MAX_STAGE_DURATION_MS = 600_000;
const MAX_STAGE_ATTEMPTS = 4_096;

export const VOICE_INTERACTION_STAGE_NAMES = [
  "stt",
  "router",
  "human",
  "robot",
  "composer",
  "tts",
  "ui",
  "playback_transport",
  "p4_wake",
  "p4_vad",
  "p4_playback",
] as const;

export type VoiceInteractionStageName = (typeof VOICE_INTERACTION_STAGE_NAMES)[number];
export type VoiceStageMeasurement =
  | "agent"
  | "hardware_pending"
  | "not_applicable"
  | "status_only"
  | "unavailable";
export type VoiceStageStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "hardware_pending"
  | "not_applicable"
  | "not_attempted"
  | "partial"
  | "timed_out"
  | "unavailable";

export interface VoiceStageMetric {
  readonly measurement: VoiceStageMeasurement;
  readonly status: VoiceStageStatus;
  readonly duration_ms: number | null;
  readonly attempts: number;
  readonly dropped: number;
  readonly cancelled: number;
}

export interface VoiceInteractionMetrics {
  readonly schema_version: 1;
  readonly stages: Readonly<Record<VoiceInteractionStageName, VoiceStageMetric>>;
  readonly dropped_events: number;
  readonly cancelled_stages: number;
  readonly interaction_cancelled: 0 | 1;
}

export type VoiceInteractionOutcome =
  | "cancelled"
  | "completed"
  | "playback_failed"
  | "role_failed"
  | "stale"
  | "tts_failed"
  | "ui_failed";

export type VoiceRoleExecutionStatus = "cancelled" | "completed" | "failed" | "partial" | "stale";
export type VoiceUiDeliveryStatus =
  | "cancelled" | "completed" | "disabled" | "failed" | "not_attempted";
export type VoiceAudioDeliveryStatus =
  | "cancelled" | "completed" | "deferred" | "failed" | "not_attempted";

export interface VoicePlaybackSegmentResult {
  readonly assignment_id: string;
  readonly segment_index: number;
  readonly role_id: RoleAwareTtsSegment["role_id"];
  readonly voice: RoleAwareTtsSegment["voice"];
  readonly source_status: RoleAwareTtsSegment["source_status"];
  readonly source_outcome: RoleAwareTtsSegment["source_outcome"];
  readonly pcm_bytes: number;
  readonly duration_ms: number;
  readonly playback: VoicePlaybackSummary;
}

export interface VoiceInteractionResult extends VoiceDispatchContext {
  readonly schema_version: 2;
  readonly interaction_id: string;
  readonly outcome: VoiceInteractionOutcome;
  readonly role_execution: VoiceRoleExecutionStatus;
  readonly ui_delivery: VoiceUiDeliveryStatus;
  readonly audio_delivery: VoiceAudioDeliveryStatus;
  readonly role_response: ComposedRoleResponse | null;
  readonly composition_audit_status: RunRoleInteractionResult["composition_audit_status"] | null;
  readonly playback_segments: readonly VoicePlaybackSegmentResult[];
  readonly tts_pcm_bytes: number;
  readonly tts_duration_ms: number;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly metrics: VoiceInteractionMetrics;
  readonly raw_audio_retained: false;
}

export interface VoiceInteractionCoordinatorOptions {
  readonly device_ids: readonly string[];
  readonly dispatch_role: (
    interaction: UserTextInteraction,
    signal: AbortSignal,
  ) => Promise<RunRoleInteractionResult>;
  readonly render_tts?: (
    interactionId: string,
    response: ComposedRoleResponse,
    signal: AbortSignal,
  ) => Promise<RoleAwareTtsResult>;
  readonly playback?: (
    deviceId: string,
    pcm: Uint8Array,
    signal: AbortSignal,
  ) => Promise<VoicePlaybackSummary>;
  readonly cancel_low_priority_cat: (
    reason: "barge_in",
    context: VoiceDispatchContext,
  ) => void;
  readonly ui_output?: "disabled" | "required";
  readonly audio_output?: "disabled" | "required";
  readonly present_ui?: (
    deviceId: string,
    update: ConversationUiUpdate,
    signal: AbortSignal,
  ) => Promise<ConversationUiDeliverySummary>;
  readonly clock?: () => number;
  readonly stt_duration_ms?: (context: VoiceDispatchContext) => number | null;
  readonly max_results?: number;
}

export interface VoiceInteractionBindings {
  readonly on_capture_open: (summary: VoiceCaptureSummary) => void;
  readonly on_device_disconnect: (deviceId: string) => void;
  readonly dispatch_final: (
    interaction: UserTextInteraction,
    signal: AbortSignal,
    context: VoiceDispatchContext,
  ) => Promise<void>;
}

interface ActiveInteraction {
  readonly epoch: number;
  readonly controller: AbortController;
}

function contextFromSummary(summary: VoiceCaptureSummary): VoiceDispatchContext {
  return {
    device_id: summary.device_id,
    session_id: summary.session_id,
    stream_id: summary.stream_id,
    epoch: summary.epoch,
  };
}

function assertContext(context: VoiceDispatchContext): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.device_id)
      || !/^[0-9a-f]{32}$/.test(context.session_id)
      || !Number.isInteger(context.stream_id) || context.stream_id < 1
      || !Number.isInteger(context.epoch) || context.epoch < 1) {
    throw new TypeError("voice interaction context is invalid");
  }
}

type MutableStageMetrics = Record<VoiceInteractionStageName, VoiceStageMetric>;

function metric(
  measurement: VoiceStageMeasurement,
  status: VoiceStageStatus,
  durationMs: number | null,
  attempts = 0,
  dropped = 0,
  cancelled = 0,
): VoiceStageMetric {
  const durationValid = durationMs === null || (
    Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= MAX_STAGE_DURATION_MS
  );
  if (!durationValid || !Number.isInteger(attempts) || attempts < 0
      || attempts > MAX_STAGE_ATTEMPTS || !Number.isInteger(dropped) || dropped < 0
      || dropped > MAX_STAGE_ATTEMPTS || !Number.isInteger(cancelled)
      || cancelled < 0 || cancelled > attempts) {
    throw new TypeError("voice stage metric is outside its bounds");
  }
  if ((measurement === "agent") !== (durationMs !== null)) {
    throw new TypeError("only Agent-measured stages may contain duration_ms");
  }
  return {
    measurement,
    status,
    duration_ms: durationMs === null ? null : Math.round(durationMs),
    attempts,
    dropped,
    cancelled,
  };
}

function agentMetric(
  status: VoiceStageStatus,
  startedAt: number,
  attempts = 1,
  dropped = 0,
): VoiceStageMetric {
  const durationMs = Math.min(MAX_STAGE_DURATION_MS, Math.max(0, performance.now() - startedAt));
  const boundedAttempts = status === "cancelled" ? Math.max(1, attempts) : attempts;
  return metric(
    "agent", status, durationMs, boundedAttempts, dropped, status === "cancelled" ? 1 : 0,
  );
}

function statusMetric(status: VoiceStageStatus, attempts = 1): VoiceStageMetric {
  return metric("status_only", status, null, attempts, 0, status === "cancelled" ? 1 : 0);
}

function fixedMetric(
  measurement: Extract<VoiceStageMeasurement, "hardware_pending" | "not_applicable" | "unavailable">,
  status: Extract<VoiceStageStatus, "hardware_pending" | "not_applicable" | "unavailable">,
): VoiceStageMetric {
  return metric(measurement, status, null);
}

function initialStageMetrics(
  context: VoiceDispatchContext,
  sttDuration: VoiceInteractionCoordinatorOptions["stt_duration_ms"],
  uiOutput: "disabled" | "required",
  audioOutput: "disabled" | "required",
): MutableStageMetrics {
  let stt = fixedMetric("unavailable", "unavailable");
  if (sttDuration !== undefined) {
    try {
      const durationMs = sttDuration(context);
      if (durationMs !== null && Number.isFinite(durationMs)
          && durationMs >= 0 && durationMs <= MAX_STAGE_DURATION_MS) {
        stt = metric("agent", "completed", durationMs, 1);
      }
    } catch {
      /* Metrics are observational and cannot rewrite interaction truth. */
    }
  }
  const notAttempted = statusMetric("not_attempted", 0);
  return {
    stt,
    router: notAttempted,
    human: notAttempted,
    robot: notAttempted,
    composer: notAttempted,
    tts: audioOutput === "disabled"
      ? fixedMetric("not_applicable", "not_applicable") : notAttempted,
    ui: uiOutput === "disabled"
      ? fixedMetric("not_applicable", "not_applicable") : notAttempted,
    playback_transport: audioOutput === "disabled"
      ? fixedMetric("not_applicable", "not_applicable") : notAttempted,
    p4_wake: fixedMetric("hardware_pending", "hardware_pending"),
    p4_vad: fixedMetric("hardware_pending", "hardware_pending"),
    p4_playback: fixedMetric("hardware_pending", "hardware_pending"),
  };
}

function applyRoleStageMetrics(
  stages: MutableStageMetrics,
  result: RunRoleInteractionResult,
): void {
  stages.router = statusMetric(
    result.routing.model_output_accepted ? "completed" : "failed",
  );
  for (const roleId of ["human", "robot"] as const) {
    const parts = result.response.parts.filter((item) => item.role_id === roleId);
    stages[roleId] = parts.length === 0
      ? fixedMetric("not_applicable", "not_applicable")
      : statusMetric(
        parts.some((item) => item.status === "cancelled") ? "cancelled"
          : parts.some((item) => item.status === "timed_out") ? "timed_out"
            : parts.some((item) => item.status === "failed") ? "failed" : "completed",
        parts.length,
      );
  }
  stages.composer = statusMetric(result.response.status);
}

function finalizeMetrics(
  stages: MutableStageMetrics,
  outcome: VoiceInteractionOutcome,
): VoiceInteractionMetrics {
  const values = Object.values(stages);
  return {
    schema_version: 1,
    stages: structuredClone(stages),
    dropped_events: values.reduce((sum, value) => sum + value.dropped, 0)
      + (outcome === "stale" ? 1 : 0),
    cancelled_stages: values.reduce((sum, value) => sum + value.cancelled, 0),
    interaction_cancelled: outcome === "cancelled" ? 1 : 0,
  };
}

function boundedUiText(value: string, maxChars: number, maxBytes: number): string {
  const normalized = value.trim();
  if ([...normalized].length <= maxChars && Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }
  const suffix = "…";
  const output: string[] = [];
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const character of normalized) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (output.length + 1 >= maxChars || bytes + nextBytes > maxBytes) break;
    output.push(character);
    bytes += nextBytes;
  }
  return `${output.join("")}${suffix}`;
}

function conversationResponseRole(response: ComposedRoleResponse): ConversationUiUpdate["response_role"] {
  const roles = new Set(response.parts.map((part) => part.role_id));
  if (roles.size > 1) return "mixed";
  return roles.has("robot") ? "robot" : "human";
}

function conversationExecutionStatus(
  response: ComposedRoleResponse,
): ConversationUiUpdate["execution_status"] {
  const terminals = response.parts.flatMap((part) => part.tool_results);
  if (terminals.some((terminal) => terminal.status === "error"
      && terminal.error.code === "HA_OUTCOME_UNKNOWN")) return "unknown";
  if (response.status === "failed" || response.status === "partial"
      || terminals.some((terminal) => terminal.status === "error")) return "failed";
  return terminals.length === 0 ? "not_applicable" : "completed";
}

function completedConversationUiUpdate(
  interaction: UserTextInteraction,
  response: ComposedRoleResponse,
  context: VoiceDispatchContext,
  revision: number,
): ConversationUiUpdate {
  if (response.parts.length === 0 || response.text.trim().length === 0) {
    throw new TypeError("conversation UI requires a composed role response");
  }
  return validateConversationUiUpdate({
    ui_protocol_version: 1,
    type: "ui.update",
    session_id: context.session_id,
    stream_id: context.stream_id,
    epoch: context.epoch,
    revision,
    stage: "completed",
    user_text: boundedUiText(
      interaction.text, CONVERSATION_UI_MAX_USER_CHARS, CONVERSATION_UI_MAX_USER_BYTES,
    ),
    response_text: boundedUiText(
      response.text, CONVERSATION_UI_MAX_RESPONSE_CHARS, CONVERSATION_UI_MAX_RESPONSE_BYTES,
    ),
    response_role: conversationResponseRole(response),
    execution_status: conversationExecutionStatus(response),
  });
}

function thinkingConversationUiUpdate(
  interaction: UserTextInteraction,
  context: VoiceDispatchContext,
  revision: number,
): ConversationUiUpdate {
  return validateConversationUiUpdate({
    ui_protocol_version: 1,
    type: "ui.update",
    session_id: context.session_id,
    stream_id: context.stream_id,
    epoch: context.epoch,
    revision,
    stage: "thinking",
    user_text: boundedUiText(
      interaction.text, CONVERSATION_UI_MAX_USER_CHARS, CONVERSATION_UI_MAX_USER_BYTES,
    ),
    response_text: "",
    response_role: "none",
    execution_status: "pending",
  });
}

function roleExecutionStatus(
  outcome: VoiceInteractionOutcome,
  response: ComposedRoleResponse | null,
): VoiceRoleExecutionStatus {
  if (outcome === "stale") return "stale";
  if (response !== null) return response.status;
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

function defaultAudioDelivery(
  outcome: VoiceInteractionOutcome,
  audioOutput: "disabled" | "required",
): VoiceAudioDeliveryStatus {
  if (audioOutput === "disabled") return "deferred";
  if (outcome === "completed") return "completed";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "role_failed" || outcome === "stale" || outcome === "ui_failed") {
    return "not_attempted";
  }
  return "failed";
}

function abortError(reason: string): DOMException {
  return new DOMException(reason, "AbortError");
}

function wipeRenderedPcm(value: unknown): void {
  if (typeof value !== "object" || value === null || !("segments" in value)
      || !Array.isArray(value.segments)) return;
  for (const segment of value.segments) {
    if (typeof segment === "object" && segment !== null && "pcm" in segment
        && segment.pcm instanceof Uint8Array) segment.pcm.fill(0);
  }
}

function assertRenderedResult(
  value: RoleAwareTtsResult,
  interactionId: string,
  response: ComposedRoleResponse,
): void {
  if (value.schema_version !== 1 || value.interaction_id !== interactionId
      || !isDeepStrictEqual(value.role_response, response)
      || !Array.isArray(value.segments) || value.segments.length !== response.parts.length
      || !Number.isInteger(value.pcm_bytes) || value.pcm_bytes < 2
      || value.pcm_bytes > TTS_MAX_PCM_BYTES
      || !Number.isFinite(value.duration_ms) || value.duration_ms <= 0) {
    wipeRenderedPcm(value);
    throw new TypeError("rendered TTS result identity or totals are invalid");
  }
  let totalBytes = 0;
  let totalDurationMs = 0;
  for (const [index, segment] of value.segments.entries()) {
    const part = response.parts[index]!;
    const expectedDurationMs = segment.samples / TTS_SAMPLE_RATE_HZ * 1_000;
    if (segment.schema_version !== 1 || segment.interaction_id !== interactionId
        || segment.assignment_id !== part.assignment_id || segment.segment_index !== index
        || segment.role_id !== part.role_id || segment.voice !== TTS_ROLE_VOICES[part.role_id]
        || segment.source_status !== part.status || segment.source_outcome !== part.outcome
        || !(segment.pcm instanceof Uint8Array) || segment.pcm.byteLength < 2
        || segment.pcm.byteLength % 2 !== 0
        || !Number.isInteger(segment.samples) || segment.samples !== segment.pcm.byteLength / 2
        || !Number.isFinite(segment.duration_ms) || segment.duration_ms <= 0
        || Math.abs(segment.duration_ms - expectedDurationMs) > 0.000_51) {
      wipeRenderedPcm(value);
      throw new TypeError("rendered TTS segment identity, order or PCM geometry is invalid");
    }
    totalBytes += segment.pcm.byteLength;
    totalDurationMs += segment.duration_ms;
  }
  if (totalBytes !== value.pcm_bytes
      || Math.abs(totalDurationMs - value.duration_ms) > 0.000_51) {
    wipeRenderedPcm(value);
    throw new TypeError("rendered TTS totals do not match its segments");
  }
}

function assertPlaybackSummary(
  value: VoicePlaybackSummary,
  deviceId: string,
  pcmBytes: number,
  identities: Set<string>,
): void {
  const identity = `${value.session_id}:${value.stream_id}:${value.epoch}`;
  const maxFrames = Math.ceil(pcmBytes / 640);
  const countersValid = Number.isInteger(value.frames) && value.frames >= 0
    && value.frames <= maxFrames && Number.isInteger(value.bytes) && value.bytes >= 0
    && value.bytes <= pcmBytes && value.bytes % 2 === 0
    && Number.isInteger(value.dropped_frames) && value.dropped_frames >= 0
    && value.dropped_frames <= value.frames
    && (value.frames === 0
      ? value.bytes === 0
      : value.bytes > 0 && value.frames === Math.ceil(value.bytes / 640));
  if (value.schema_version !== 1 || value.device_id !== deviceId
      || !/^[0-9a-f]{32}$/.test(value.session_id) || value.session_id === "0".repeat(32)
      || !Number.isInteger(value.stream_id) || value.stream_id < 1 || value.stream_id > 0xffff_ffff
      || !Number.isInteger(value.epoch) || value.epoch < 1 || value.epoch > 0xffff_ffff
      || !["completed", "cancelled", "failed"].includes(value.status)
      || !countersValid || identities.has(identity)
      || (value.status === "completed"
        && (value.bytes !== pcmBytes || value.frames !== maxFrames || value.dropped_frames !== 0))) {
    throw new TypeError("playback summary identity or counters are invalid");
  }
  identities.add(identity);
}

export class VoiceInteractionCoordinator {
  readonly #options: VoiceInteractionCoordinatorOptions;
  readonly #active = new Map<string, ActiveInteraction>();
  readonly #latestEpoch = new Map<string, number>();
  readonly #dispatchedEpoch = new Map<string, number>();
  readonly #results: VoiceInteractionResult[] = [];
  readonly #deviceIds: ReadonlySet<string>;
  readonly #maxResults: number;
  readonly #uiOutput: "disabled" | "required";
  readonly #audioOutput: "disabled" | "required";
  #closed = false;

  public constructor(options: VoiceInteractionCoordinatorOptions) {
    const deviceIds = new Set(options.device_ids);
    if (deviceIds.size < 1 || deviceIds.size > 1_024
        || deviceIds.size !== options.device_ids.length) {
      throw new RangeError("voice interaction devices must be unique and bounded");
    }
    for (const deviceId of deviceIds) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
        throw new TypeError("voice interaction device_id is invalid");
      }
    }
    const maxResults = options.max_results ?? 256;
    if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > MAX_RESULT_HISTORY) {
      throw new RangeError("voice interaction result history must be bounded");
    }
    const uiOutput = options.ui_output ?? "disabled";
    const audioOutput = options.audio_output ?? "required";
    if (uiOutput === "required" && options.present_ui === undefined) {
      throw new TypeError("required conversation UI output needs a presenter");
    }
    if (audioOutput === "required"
        && (options.render_tts === undefined || options.playback === undefined)) {
      throw new TypeError("required audio output needs TTS and playback");
    }
    this.#options = options;
    this.#deviceIds = deviceIds;
    this.#maxResults = maxResults;
    this.#uiOutput = uiOutput;
    this.#audioOutput = audioOutput;
  }

  public onCaptureOpen(summary: VoiceCaptureSummary): void {
    if (this.#closed) throw new TypeError("voice interaction coordinator is closed");
    const context = contextFromSummary(summary);
    assertContext(context);
    if (!this.#deviceIds.has(context.device_id)) throw new TypeError("voice device is not paired");
    const previousEpoch = this.#latestEpoch.get(context.device_id) ?? -1;
    if (summary.status !== "active" || context.epoch <= previousEpoch) {
      throw new TypeError("barge-in capture must use a new active epoch");
    }
    this.#latestEpoch.set(context.device_id, context.epoch);
    this.#active.get(context.device_id)?.controller.abort(abortError("barge_in"));
    this.#options.cancel_low_priority_cat("barge_in", context);
  }

  public onDeviceDisconnect(deviceId: string): void {
    if (!this.#deviceIds.has(deviceId)) return;
    this.#active.get(deviceId)?.controller.abort(abortError("device_disconnected"));
  }

  public async run(
    interaction: UserTextInteraction,
    upstreamSignal: AbortSignal,
    context: VoiceDispatchContext,
  ): Promise<VoiceInteractionResult> {
    if (this.#closed) throw new TypeError("voice interaction coordinator is closed");
    assertContext(context);
    if (!this.#deviceIds.has(context.device_id)) throw new TypeError("voice device is not paired");
    if (interaction.source !== "voice") {
      throw new TypeError("voice coordinator accepts only voice interactions");
    }
    const startedAtMs = (this.#options.clock ?? Date.now)();
    const stageMetrics = initialStageMetrics(
      context, this.#options.stt_duration_ms, this.#uiOutput, this.#audioOutput,
    );
    const latestEpoch = this.#latestEpoch.get(context.device_id);
    const dispatchedEpoch = this.#dispatchedEpoch.get(context.device_id) ?? -1;
    if ((latestEpoch !== undefined && context.epoch !== latestEpoch)
        || context.epoch <= dispatchedEpoch) {
      return this.#record(this.#result(
        interaction.interaction_id, context, "stale", null, null, [], 0, 0, startedAtMs,
        stageMetrics,
      ));
    }
    if (latestEpoch === undefined) this.#latestEpoch.set(context.device_id, context.epoch);
    this.#dispatchedEpoch.set(context.device_id, context.epoch);

    const controller = new AbortController();
    const onUpstreamAbort = (): void => controller.abort(upstreamSignal.reason);
    upstreamSignal.addEventListener("abort", onUpstreamAbort, { once: true });
    if (upstreamSignal.aborted) onUpstreamAbort();
    this.#active.get(context.device_id)?.controller.abort(abortError("superseded"));
    const active = { epoch: context.epoch, controller };
    this.#active.set(context.device_id, active);

    let stage: "role" | "ui" | "tts" | "playback" = "role";
    let roleResult: RunRoleInteractionResult | null = null;
    let rendered: RoleAwareTtsResult | null = null;
    let uiDelivery: VoiceUiDeliveryStatus = this.#uiOutput === "disabled"
      ? "disabled" : "not_attempted";
    const playbackSegments: VoicePlaybackSegmentResult[] = [];
    const playbackIdentities = new Set<string>();
    let uiDurationMs = 0;
    let uiAttempts = 0;
    let currentStageStartedAt = performance.now();
    try {
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", null, null, [], 0, 0, startedAtMs,
          stageMetrics,
        ));
      }
      stage = "role";
      currentStageStartedAt = performance.now();
      const pendingRole = this.#options.dispatch_role(interaction, controller.signal).then(
        (result) => ({ status: "fulfilled" as const, result }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (this.#uiOutput === "required") {
        stage = "ui";
        const presenter = this.#options.present_ui;
        if (presenter === undefined) throw new TypeError("conversation UI presenter is unavailable");
        const uiStartedAt = performance.now();
        uiAttempts++;
        try {
          await presenter(
            context.device_id,
            thinkingConversationUiUpdate(interaction, context, 1),
            controller.signal,
          );
        } catch {
          /* Transient progress is best-effort. The final, revision-2 update
           * remains required and is allowed to establish the first revision. */
          if (controller.signal.aborted) uiDelivery = "cancelled";
        } finally {
          uiDurationMs += performance.now() - uiStartedAt;
        }
        if (controller.signal.aborted) {
          stageMetrics.ui = metric("agent", "cancelled", uiDurationMs, uiAttempts, 0, 1);
        }
      }
      stage = "role";
      const settledRole = await pendingRole;
      if (settledRole.status === "rejected") throw settledRole.error;
      roleResult = settledRole.result;
      applyRoleStageMetrics(stageMetrics, roleResult);
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", roleResult.response,
          roleResult.composition_audit_status, [], 0, 0, startedAtMs, stageMetrics, uiDelivery,
        ));
      }
      if (this.#uiOutput === "required") {
        stage = "ui";
        const presenter = this.#options.present_ui;
        if (presenter === undefined) throw new TypeError("conversation UI presenter is unavailable");
        const update = completedConversationUiUpdate(interaction, roleResult.response, context, 2);
        const uiStartedAt = performance.now();
        uiAttempts++;
        let delivery: ConversationUiDeliverySummary;
        try {
          delivery = await presenter(context.device_id, update, controller.signal);
        } finally {
          uiDurationMs += performance.now() - uiStartedAt;
        }
        if (delivery.schema_version !== 1 || delivery.status !== "completed"
            || delivery.device_id !== context.device_id
            || delivery.session_id !== context.session_id
            || delivery.stream_id !== context.stream_id
            || delivery.epoch !== context.epoch || delivery.revision !== update.revision) {
          throw new TypeError("conversation UI delivery identity is invalid");
        }
        uiDelivery = "completed";
        stageMetrics.ui = metric("agent", "completed", uiDurationMs, uiAttempts);
      }
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", roleResult.response,
          roleResult.composition_audit_status, [], 0, 0, startedAtMs,
          stageMetrics,
          uiDelivery === "completed" ? "completed" : "cancelled",
          this.#audioOutput === "disabled" ? "deferred" : "not_attempted",
        ));
      }
      if (this.#audioOutput === "disabled") {
        return this.#record(this.#result(
          interaction.interaction_id, context, "completed", roleResult.response,
          roleResult.composition_audit_status, [], 0, 0, startedAtMs,
          stageMetrics,
          uiDelivery, "deferred",
        ));
      }
      stage = "tts";
      currentStageStartedAt = performance.now();
      rendered = await this.#options.render_tts!(
        interaction.interaction_id, roleResult.response, controller.signal,
      );
      stageMetrics.tts = agentMetric("completed", currentStageStartedAt);
      assertRenderedResult(rendered, interaction.interaction_id, roleResult.response);
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", roleResult.response,
          roleResult.composition_audit_status, [], rendered.pcm_bytes,
          rendered.duration_ms, startedAtMs, stageMetrics,
        ));
      }
      stage = "playback";
      currentStageStartedAt = performance.now();
      for (const segment of rendered.segments) {
        if (controller.signal.aborted) break;
        const playback = await this.#options.playback!(
          context.device_id, segment.pcm, controller.signal,
        );
        assertPlaybackSummary(
          playback, context.device_id, segment.pcm.byteLength, playbackIdentities,
        );
        playbackSegments.push({
          assignment_id: segment.assignment_id,
          segment_index: segment.segment_index,
          role_id: segment.role_id,
          voice: segment.voice,
          source_status: segment.source_status,
          source_outcome: segment.source_outcome,
          pcm_bytes: segment.pcm.byteLength,
          duration_ms: segment.duration_ms,
          playback: structuredClone(playback),
        });
        if (playback.status !== "completed") break;
      }
      const completed = !controller.signal.aborted
        && playbackSegments.length === rendered.segments.length
        && playbackSegments.every((segment) => segment.playback.status === "completed");
      const playbackCancelled = playbackSegments.some(
        (segment) => segment.playback.status === "cancelled",
      );
      const droppedFrames = playbackSegments.reduce(
        (total, segment) => total + segment.playback.dropped_frames, 0,
      );
      stageMetrics.playback_transport = agentMetric(
        controller.signal.aborted || playbackCancelled
          ? "cancelled" : completed ? "completed" : "failed",
        currentStageStartedAt,
        playbackSegments.length,
        droppedFrames,
      );
      return this.#record(this.#result(
        interaction.interaction_id,
        context,
        controller.signal.aborted || playbackCancelled
          ? "cancelled" : completed ? "completed" : "playback_failed",
        roleResult.response,
        roleResult.composition_audit_status,
        playbackSegments,
        rendered.pcm_bytes,
        rendered.duration_ms,
        startedAtMs,
        stageMetrics,
        uiDelivery,
        controller.signal.aborted || playbackCancelled ? "cancelled"
          : completed ? "completed" : "failed",
      ));
    } catch {
      const cancelled = controller.signal.aborted;
      if (stage === "role") {
        stageMetrics.router = statusMetric(cancelled ? "cancelled" : "failed");
      } else if (stage === "ui") {
        stageMetrics.ui = metric(
          "agent", cancelled ? "cancelled" : "failed", uiDurationMs,
          Math.max(1, uiAttempts), 0, cancelled ? 1 : 0,
        );
      } else if (stage === "tts") {
        stageMetrics.tts = agentMetric(
          cancelled ? "cancelled" : "failed", currentStageStartedAt,
        );
      } else {
        stageMetrics.playback_transport = agentMetric(
          cancelled ? "cancelled" : "failed", currentStageStartedAt,
          Math.max(1, playbackSegments.length),
          playbackSegments.reduce(
            (total, segment) => total + segment.playback.dropped_frames, 0,
          ),
        );
      }
      return this.#record(this.#result(
        interaction.interaction_id,
        context,
        cancelled
          ? "cancelled"
          : stage === "role" ? "role_failed"
            : stage === "ui" ? "ui_failed"
              : stage === "tts" ? "tts_failed" : "playback_failed",
        roleResult?.response ?? null,
        roleResult?.composition_audit_status ?? null,
        playbackSegments,
        rendered?.pcm_bytes ?? 0,
        rendered?.duration_ms ?? 0,
        startedAtMs,
        stageMetrics,
        stage === "ui" ? cancelled ? "cancelled" : "failed" : uiDelivery,
        this.#audioOutput === "disabled" ? "deferred"
          : stage === "role" || stage === "ui" ? "not_attempted"
            : cancelled ? "cancelled" : "failed",
      ));
    } finally {
      upstreamSignal.removeEventListener("abort", onUpstreamAbort);
      if (this.#active.get(context.device_id) === active) this.#active.delete(context.device_id);
      wipeRenderedPcm(rendered);
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of this.#active.values()) active.controller.abort(abortError("coordinator_closed"));
    this.#active.clear();
    this.#latestEpoch.clear();
    this.#dispatchedEpoch.clear();
  }

  public get active_count(): number {
    return this.#active.size;
  }

  public get known_device_count(): number {
    return this.#latestEpoch.size;
  }

  public get results(): readonly VoiceInteractionResult[] {
    return structuredClone(this.#results);
  }

  #result(
    interactionId: string,
    context: VoiceDispatchContext,
    outcome: VoiceInteractionOutcome,
    roleResponse: ComposedRoleResponse | null,
    auditStatus: RunRoleInteractionResult["composition_audit_status"] | null,
    playbackSegments: readonly VoicePlaybackSegmentResult[],
    ttsPcmBytes: number,
    ttsDurationMs: number,
    startedAtMs: number,
    stageMetrics: MutableStageMetrics,
    uiDelivery: VoiceUiDeliveryStatus = this.#uiOutput === "disabled"
      ? "disabled" : "not_attempted",
    audioDelivery: VoiceAudioDeliveryStatus = defaultAudioDelivery(outcome, this.#audioOutput),
  ): VoiceInteractionResult {
    return {
      schema_version: 2,
      ...context,
      interaction_id: interactionId,
      outcome,
      role_execution: roleExecutionStatus(outcome, roleResponse),
      ui_delivery: uiDelivery,
      audio_delivery: audioDelivery,
      role_response: roleResponse === null ? null : structuredClone(roleResponse),
      composition_audit_status: auditStatus,
      playback_segments: structuredClone(playbackSegments),
      tts_pcm_bytes: ttsPcmBytes,
      tts_duration_ms: ttsDurationMs,
      started_at_ms: startedAtMs,
      completed_at_ms: (this.#options.clock ?? Date.now)(),
      metrics: finalizeMetrics(stageMetrics, outcome),
      raw_audio_retained: false,
    };
  }

  #record(result: VoiceInteractionResult): VoiceInteractionResult {
    if (this.#maxResults > 0) {
      this.#results.push(structuredClone(result));
      if (this.#results.length > this.#maxResults) this.#results.shift();
    }
    return result;
  }
}

/** One binding object wires the same coordinator into STT and the Voice server. */
export function bindVoiceInteractionCoordinator(
  coordinator: VoiceInteractionCoordinator,
): VoiceInteractionBindings {
  return {
    on_capture_open: (summary) => coordinator.onCaptureOpen(summary),
    on_device_disconnect: (deviceId) => coordinator.onDeviceDisconnect(deviceId),
    dispatch_final: async (interaction, signal, context) => {
      const result = await coordinator.run(interaction, signal, context);
      if (result.outcome === "role_failed" || result.outcome === "stale"
          || result.outcome === "ui_failed"
          || (result.outcome === "cancelled" && signal.aborted)) {
        throw new Error(`voice interaction did not dispatch: ${result.outcome}`);
      }
    },
  };
}
