import type { ComposedRoleResponse } from "./role-response-composer.ts";
import type { RunRoleInteractionResult } from "./role-orchestrator.ts";
import type { UserTextInteraction } from "./role-contracts.ts";
import type { RoleAwareTtsResult, RoleAwareTtsSegment } from "./role-aware-tts.ts";
import type { VoicePlaybackSummary } from "./voice-playback-sender.ts";
import type { VoiceCaptureSummary, VoiceDispatchContext } from "./voice-websocket-server.ts";

const MAX_RESULT_HISTORY = 4_096;

export type VoiceInteractionOutcome =
  | "cancelled"
  | "completed"
  | "playback_failed"
  | "role_failed"
  | "stale"
  | "tts_failed";

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
  readonly schema_version: 1;
  readonly interaction_id: string;
  readonly outcome: VoiceInteractionOutcome;
  readonly role_response: ComposedRoleResponse | null;
  readonly composition_audit_status: RunRoleInteractionResult["composition_audit_status"] | null;
  readonly playback_segments: readonly VoicePlaybackSegmentResult[];
  readonly tts_pcm_bytes: number;
  readonly tts_duration_ms: number;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly raw_audio_retained: false;
}

export interface VoiceInteractionCoordinatorOptions {
  readonly device_ids: readonly string[];
  readonly dispatch_role: (
    interaction: UserTextInteraction,
    signal: AbortSignal,
  ) => Promise<RunRoleInteractionResult>;
  readonly render_tts: (
    interactionId: string,
    response: ComposedRoleResponse,
    signal: AbortSignal,
  ) => Promise<RoleAwareTtsResult>;
  readonly playback: (
    deviceId: string,
    pcm: Uint8Array,
    signal: AbortSignal,
  ) => Promise<VoicePlaybackSummary>;
  readonly cancel_low_priority_cat: (
    reason: "barge_in",
    context: VoiceDispatchContext,
  ) => void;
  readonly clock?: () => number;
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
    this.#options = options;
    this.#deviceIds = deviceIds;
    this.#maxResults = maxResults;
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
    const latestEpoch = this.#latestEpoch.get(context.device_id);
    const dispatchedEpoch = this.#dispatchedEpoch.get(context.device_id) ?? -1;
    if ((latestEpoch !== undefined && context.epoch !== latestEpoch)
        || context.epoch <= dispatchedEpoch) {
      return this.#record(this.#result(
        interaction.interaction_id, context, "stale", null, null, [], 0, 0, startedAtMs,
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

    let stage: "role" | "tts" | "playback" = "role";
    let roleResult: RunRoleInteractionResult | null = null;
    let rendered: RoleAwareTtsResult | null = null;
    const playbackSegments: VoicePlaybackSegmentResult[] = [];
    const playbackIdentities = new Set<string>();
    try {
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", null, null, [], 0, 0, startedAtMs,
        ));
      }
      roleResult = await this.#options.dispatch_role(interaction, controller.signal);
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", roleResult.response,
          roleResult.composition_audit_status, [], 0, 0, startedAtMs,
        ));
      }
      stage = "tts";
      rendered = await this.#options.render_tts(
        interaction.interaction_id, roleResult.response, controller.signal,
      );
      assertRenderedResult(rendered, interaction.interaction_id, roleResult.response);
      if (controller.signal.aborted) {
        return this.#record(this.#result(
          interaction.interaction_id, context, "cancelled", roleResult.response,
          roleResult.composition_audit_status, [], rendered.pcm_bytes,
          rendered.duration_ms, startedAtMs,
        ));
      }
      stage = "playback";
      for (const segment of rendered.segments) {
        if (controller.signal.aborted) break;
        const playback = await this.#options.playback(
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
      ));
    } catch {
      return this.#record(this.#result(
        interaction.interaction_id,
        context,
        controller.signal.aborted
          ? "cancelled"
          : stage === "role" ? "role_failed" : stage === "tts" ? "tts_failed" : "playback_failed",
        roleResult?.response ?? null,
        roleResult?.composition_audit_status ?? null,
        playbackSegments,
        rendered?.pcm_bytes ?? 0,
        rendered?.duration_ms ?? 0,
        startedAtMs,
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
  ): VoiceInteractionResult {
    return {
      schema_version: 1,
      ...context,
      interaction_id: interactionId,
      outcome,
      role_response: roleResponse === null ? null : structuredClone(roleResponse),
      composition_audit_status: auditStatus,
      playback_segments: structuredClone(playbackSegments),
      tts_pcm_bytes: ttsPcmBytes,
      tts_duration_ms: ttsDurationMs,
      started_at_ms: startedAtMs,
      completed_at_ms: (this.#options.clock ?? Date.now)(),
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
          || (result.outcome === "cancelled" && signal.aborted)) {
        throw new Error(`voice interaction did not dispatch: ${result.outcome}`);
      }
    },
  };
}
import { isDeepStrictEqual } from "node:util";

import { TTS_MAX_PCM_BYTES, TTS_ROLE_VOICES, TTS_SAMPLE_RATE_HZ } from "@p4home/provider-tts";
