import { ROOM_IDS, type RoomId } from "@p4home/domain-p4home";

import { CAT_WORLD_TOOLS } from "./role-profiles.ts";

export const CAT_EVENT_SOURCES = ["test_harness"] as const;
export type CatEventSource = (typeof CAT_EVENT_SOURCES)[number];
export type CatAutonomyEventSource = "timer" | "home_assistant" | "p4_world" | "runtime";
export type CatRoomTargetEventType =
  | "test.room_target"
  | "timer.elapsed"
  | "ha.state_changed"
  | "world.changed"
  | "task.completed";

export interface CatRoomTargetEvent {
  readonly event_id: string;
  readonly event_type: CatRoomTargetEventType;
  readonly source: CatEventSource | CatAutonomyEventSource;
  readonly occurred_at_ms: number;
  readonly payload: Readonly<{ readonly room_target: RoomId }>;
}

export interface ApprovedCatRoomTargetEvent extends CatRoomTargetEvent {
  readonly tool: "character.go_to_room";
  readonly arguments: Readonly<{ readonly room_id: RoomId }>;
  readonly approved_at_ms: number;
}

export type CatEventPolicyErrorCode =
  | "INVALID_EVENT"
  | "SOURCE_NOT_ALLOWED"
  | "STALE_EVENT"
  | "FUTURE_EVENT"
  | "RATE_LIMITED"
  | "DUPLICATE_EVENT"
  | "DEDUPE_CAPACITY_EXCEEDED"
  | "TARGET_NOT_ALLOWED"
  | "TOOL_NOT_ALLOWED"
  | "AUTONOMY_DISABLED"
  | "AUTONOMY_PAUSED"
  | "BEFORE_RUNTIME_START"
  | "QUIET_HOURS"
  | "DAILY_BUDGET_EXHAUSTED"
  | "GLOBAL_RATE_LIMITED"
  | "SOURCE_RATE_LIMITED"
  | "SOURCE_MAPPING_MISSING"
  | "FEEDBACK_LOOP_BLOCKED";

export class CatEventPolicyError extends Error {
  public readonly code: CatEventPolicyErrorCode;

  public constructor(code: CatEventPolicyErrorCode, message: string) {
    super(message);
    this.name = "CatEventPolicyError";
    this.code = code;
  }
}

export interface CatEventPolicyOptions {
  readonly now?: () => number;
  readonly monotonic_now?: () => number;
  readonly max_age_ms?: number;
  readonly max_future_skew_ms?: number;
  readonly minimum_interval_ms?: number;
  readonly allowed_sources?: readonly CatEventSource[];
  readonly allowed_rooms?: readonly RoomId[];
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

export class CatEventPolicy {
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #maxAgeMs: number;
  readonly #maxFutureSkewMs: number;
  readonly #minimumIntervalMs: number;
  readonly #allowedSources: ReadonlySet<string>;
  readonly #allowedRooms: ReadonlySet<string>;
  readonly #allowedTools: ReadonlySet<string>;
  readonly #dedupeRetentionMs: number;
  readonly #dedupeCapacity: number;
  readonly #seenEventIds = new Map<string, number>();
  readonly #lastAcceptedAtBySource = new Map<string, number>();

  public constructor(options: CatEventPolicyOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonic_now ?? (() => performance.now());
    this.#maxAgeMs = options.max_age_ms ?? 5_000;
    this.#maxFutureSkewMs = options.max_future_skew_ms ?? 250;
    this.#minimumIntervalMs = options.minimum_interval_ms ?? 100;
    this.#allowedSources = new Set(options.allowed_sources ?? CAT_EVENT_SOURCES);
    this.#allowedRooms = new Set(options.allowed_rooms ?? ROOM_IDS);
    this.#allowedTools = new Set(options.allowed_tools ?? CAT_WORLD_TOOLS);
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

  public approve(input: unknown): ApprovedCatRoomTargetEvent {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat event must be an object");
    }
    const event = input as Record<string, unknown>;
    if (!exactKeys(event, ["event_id", "event_type", "source", "occurred_at_ms", "payload"])) {
      throw new CatEventPolicyError(
        "INVALID_EVENT",
        "Cat event contains missing or unauthorized fields",
      );
    }
    if (typeof event.event_id !== "string" || !EVENT_ID_PATTERN.test(event.event_id)) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat event_id is invalid");
    }
    if (event.event_type !== "test.room_target") {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat event_type is not allowed in Phase 2B");
    }
    if (typeof event.source !== "string" || !this.#allowedSources.has(event.source)) {
      throw new CatEventPolicyError("SOURCE_NOT_ALLOWED", "Cat event source is not allowed");
    }
    if (!Number.isInteger(event.occurred_at_ms) || Number(event.occurred_at_ms) < 0) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat event occurred_at_ms is invalid");
    }
    const payload = event.payload;
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
      || !exactKeys(payload as Record<string, unknown>, ["room_target"])
    ) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat event payload is invalid");
    }
    const roomTarget = (payload as Record<string, unknown>).room_target;
    if (typeof roomTarget !== "string" || !this.#allowedRooms.has(roomTarget)) {
      throw new CatEventPolicyError("TARGET_NOT_ALLOWED", "Cat room target is not allowed");
    }
    const tool = "character.go_to_room" as const;
    if (!this.#allowedTools.has(tool)) {
      throw new CatEventPolicyError("TOOL_NOT_ALLOWED", "Cat event tool is not allowed");
    }

    const now = this.#now();
    const policyNow = this.#monotonicNow();
    const occurredAtMs = Number(event.occurred_at_ms);
    if (occurredAtMs > now + this.#maxFutureSkewMs) {
      throw new CatEventPolicyError("FUTURE_EVENT", "Cat event timestamp is too far in the future");
    }
    if (now - occurredAtMs > this.#maxAgeMs) {
      throw new CatEventPolicyError("STALE_EVENT", "Cat event is stale");
    }
    this.#pruneSeenEvents(policyNow);
    if (this.#seenEventIds.has(event.event_id)) {
      throw new CatEventPolicyError("DUPLICATE_EVENT", "Cat event_id was already accepted");
    }
    const lastAcceptedAt = this.#lastAcceptedAtBySource.get(event.source);
    if (lastAcceptedAt !== undefined && policyNow - lastAcceptedAt < this.#minimumIntervalMs) {
      throw new CatEventPolicyError("RATE_LIMITED", "Cat event source exceeded its rate limit");
    }

    if (this.#seenEventIds.size >= this.#dedupeCapacity) {
      throw new CatEventPolicyError(
        "DEDUPE_CAPACITY_EXCEEDED",
        "Cat event dedupe capacity is exhausted",
      );
    }
    this.#seenEventIds.set(event.event_id, policyNow);
    this.#lastAcceptedAtBySource.set(event.source, policyNow);
    return {
      event_id: event.event_id,
      event_type: "test.room_target",
      source: event.source as CatEventSource,
      occurred_at_ms: occurredAtMs,
      payload: { room_target: roomTarget as RoomId },
      tool,
      arguments: { room_id: roomTarget as RoomId },
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
