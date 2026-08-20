import { getObjectRuntimeToolDefinitions } from "@p4home/contracts";

import { CAT_EVENT_SOURCES, type CatEventSource } from "./cat-event-policy.ts";
import { CAT_OBJECT_TOOLS } from "./role-profiles.ts";

export interface CatObjectSitEvent {
  readonly event_id: string;
  readonly event_type: "test.object_sit_target";
  readonly source: CatEventSource;
  readonly occurred_at_ms: number;
  readonly payload: Readonly<{ readonly target_id: string }>;
}

export interface ApprovedCatObjectStep {
  readonly tool: "character.go_to" | "character.sit";
  readonly arguments: Readonly<{ readonly target_id: string }>;
}

export interface ApprovedCatObjectSitEvent extends CatObjectSitEvent {
  readonly steps: readonly [ApprovedCatObjectStep, ApprovedCatObjectStep];
  readonly approved_at_ms: number;
}

export type CatObjectEventPolicyErrorCode =
  | "INVALID_EVENT"
  | "SOURCE_NOT_ALLOWED"
  | "STALE_EVENT"
  | "FUTURE_EVENT"
  | "RATE_LIMITED"
  | "DUPLICATE_EVENT"
  | "DEDUPE_CAPACITY_EXCEEDED"
  | "TARGET_NOT_ALLOWED"
  | "TOOL_NOT_ALLOWED";

export class CatObjectEventPolicyError extends Error {
  public readonly code: CatObjectEventPolicyErrorCode;

  public constructor(code: CatObjectEventPolicyErrorCode, message: string) {
    super(message);
    this.name = "CatObjectEventPolicyError";
    this.code = code;
  }
}

export interface CatObjectEventPolicyOptions {
  readonly now?: () => number;
  readonly monotonic_now?: () => number;
  readonly max_age_ms?: number;
  readonly max_future_skew_ms?: number;
  readonly minimum_interval_ms?: number;
  readonly allowed_sources?: readonly CatEventSource[];
  readonly allowed_targets?: readonly string[];
  readonly allowed_tools?: readonly string[];
  readonly dedupe_retention_ms?: number;
  readonly dedupe_capacity?: number;
}

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sitTargetIds(): readonly string[] {
  const definitions = getObjectRuntimeToolDefinitions();
  const targetIds = (toolName: string): readonly string[] => {
    const definition = definitions.find((candidate) => candidate.name === toolName);
    const targetEnum = (definition?.parameters as {
      properties?: { target_id?: { enum?: unknown } };
    }).properties?.target_id?.enum;
    if (!Array.isArray(targetEnum) || !targetEnum.every((value) => typeof value === "string")) {
      throw new TypeError(`Tool Schema v2 ${toolName} has no target_id enum`);
    }
    return targetEnum;
  };
  const goToTargets = new Set(targetIds("character.go_to"));
  return targetIds("character.sit").filter((targetId) => goToTargets.has(targetId));
}

/**
 * Phase 3C ingress boundary. The event can select only a reviewed sit target;
 * the action sequence is derived here and cannot be supplied by the event.
 */
export class CatObjectEventPolicy {
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #maxAgeMs: number;
  readonly #maxFutureSkewMs: number;
  readonly #minimumIntervalMs: number;
  readonly #allowedSources: ReadonlySet<string>;
  readonly #allowedTargets: ReadonlySet<string>;
  readonly #allowedTools: ReadonlySet<string>;
  readonly #dedupeRetentionMs: number;
  readonly #dedupeCapacity: number;
  readonly #seenEventIds = new Map<string, number>();
  readonly #lastAcceptedAtBySource = new Map<string, number>();

  public constructor(options: CatObjectEventPolicyOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonic_now ?? (() => performance.now());
    this.#maxAgeMs = options.max_age_ms ?? 5_000;
    this.#maxFutureSkewMs = options.max_future_skew_ms ?? 250;
    this.#minimumIntervalMs = options.minimum_interval_ms ?? 100;
    this.#allowedSources = new Set(options.allowed_sources ?? CAT_EVENT_SOURCES);
    const canonicalTargets = new Set(sitTargetIds());
    const configuredTargets = options.allowed_targets ?? [...canonicalTargets];
    if (configuredTargets.some((targetId) => !canonicalTargets.has(targetId))) {
      throw new RangeError("allowed_targets cannot widen the reviewed object sit targets");
    }
    this.#allowedTargets = new Set(configuredTargets);
    this.#allowedTools = new Set(options.allowed_tools ?? CAT_OBJECT_TOOLS);
    this.#dedupeRetentionMs = options.dedupe_retention_ms ?? 600_000;
    this.#dedupeCapacity = options.dedupe_capacity ?? 8_192;
    for (const [name, value] of [
      ["max_age_ms", this.#maxAgeMs],
      ["max_future_skew_ms", this.#maxFutureSkewMs],
      ["minimum_interval_ms", this.#minimumIntervalMs],
      ["dedupe_retention_ms", this.#dedupeRetentionMs],
    ] as const) {
      if (!Number.isInteger(value) || value < (name === "dedupe_retention_ms" ? 1 : 0)) {
        throw new RangeError(`${name} must be a valid integer duration`);
      }
    }
    if (!Number.isInteger(this.#dedupeCapacity) || this.#dedupeCapacity < 1) {
      throw new RangeError("dedupe_capacity must be a positive integer");
    }
  }

  public approve(input: unknown): ApprovedCatObjectSitEvent {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new CatObjectEventPolicyError("INVALID_EVENT", "Cat object event must be an object");
    }
    const event = input as Record<string, unknown>;
    if (!exactKeys(event, ["event_id", "event_type", "source", "occurred_at_ms", "payload"])) {
      throw new CatObjectEventPolicyError(
        "INVALID_EVENT",
        "Cat object event contains missing or unauthorized fields",
      );
    }
    if (typeof event.event_id !== "string" || !EVENT_ID_PATTERN.test(event.event_id)) {
      throw new CatObjectEventPolicyError("INVALID_EVENT", "Cat object event_id is invalid");
    }
    if (event.event_type !== "test.object_sit_target") {
      throw new CatObjectEventPolicyError(
        "INVALID_EVENT",
        "Cat object event_type is not allowed in Phase 3C",
      );
    }
    if (typeof event.source !== "string" || !this.#allowedSources.has(event.source)) {
      throw new CatObjectEventPolicyError("SOURCE_NOT_ALLOWED", "Cat object event source is not allowed");
    }
    if (!Number.isInteger(event.occurred_at_ms) || Number(event.occurred_at_ms) < 0) {
      throw new CatObjectEventPolicyError("INVALID_EVENT", "Cat object occurred_at_ms is invalid");
    }
    const payload = event.payload;
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || !exactKeys(payload as Record<string, unknown>, ["target_id"])
    ) {
      throw new CatObjectEventPolicyError("INVALID_EVENT", "Cat object event payload is invalid");
    }
    const targetId = (payload as Record<string, unknown>).target_id;
    if (typeof targetId !== "string" || !this.#allowedTargets.has(targetId)) {
      throw new CatObjectEventPolicyError("TARGET_NOT_ALLOWED", "Cat object target is not allowed");
    }
    const tools = ["character.go_to", "character.sit"] as const;
    if (tools.some((tool) => !this.#allowedTools.has(tool))) {
      throw new CatObjectEventPolicyError("TOOL_NOT_ALLOWED", "Cat object sequence is not allowed");
    }

    const now = this.#now();
    const policyNow = this.#monotonicNow();
    const occurredAtMs = Number(event.occurred_at_ms);
    if (occurredAtMs > now + this.#maxFutureSkewMs) {
      throw new CatObjectEventPolicyError("FUTURE_EVENT", "Cat object event is too far in the future");
    }
    if (now - occurredAtMs > this.#maxAgeMs) {
      throw new CatObjectEventPolicyError("STALE_EVENT", "Cat object event is stale");
    }
    this.#pruneSeenEvents(policyNow);
    if (this.#seenEventIds.has(event.event_id)) {
      throw new CatObjectEventPolicyError("DUPLICATE_EVENT", "Cat object event_id was already accepted");
    }
    const lastAcceptedAt = this.#lastAcceptedAtBySource.get(event.source);
    if (lastAcceptedAt !== undefined && policyNow - lastAcceptedAt < this.#minimumIntervalMs) {
      throw new CatObjectEventPolicyError("RATE_LIMITED", "Cat object event source exceeded its rate limit");
    }
    if (this.#seenEventIds.size >= this.#dedupeCapacity) {
      throw new CatObjectEventPolicyError(
        "DEDUPE_CAPACITY_EXCEEDED",
        "Cat object event dedupe capacity is exhausted",
      );
    }
    this.#seenEventIds.set(event.event_id, policyNow);
    this.#lastAcceptedAtBySource.set(event.source, policyNow);
    const argumentsValue = { target_id: targetId };
    return {
      event_id: event.event_id,
      event_type: "test.object_sit_target",
      source: event.source as CatEventSource,
      occurred_at_ms: occurredAtMs,
      payload: argumentsValue,
      steps: [
        { tool: "character.go_to", arguments: argumentsValue },
        { tool: "character.sit", arguments: argumentsValue },
      ],
      approved_at_ms: now,
    };
  }

  #pruneSeenEvents(now: number): void {
    const cutoff = now - this.#dedupeRetentionMs;
    for (const [eventId, acceptedAt] of this.#seenEventIds) {
      if (acceptedAt > cutoff) {
        break;
      }
      this.#seenEventIds.delete(eventId);
    }
  }
}
