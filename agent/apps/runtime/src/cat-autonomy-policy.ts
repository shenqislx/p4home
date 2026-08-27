import { ROOM_IDS, type RoomId } from "@p4home/domain-p4home";

import {
  CatEventPolicy,
  CatEventPolicyError,
  type CatEventPolicyErrorCode,
  type ApprovedCatRoomTargetEvent,
  type CatAutonomyEventSource,
} from "./cat-event-policy.ts";

export const CAT_AUTONOMY_EVENT_TYPES = [
  "timer.elapsed",
  "ha.state_changed",
  "world.changed",
  "task.completed",
] as const;

export type CatAutonomyEventType = (typeof CAT_AUTONOMY_EVENT_TYPES)[number];
export type CatAutonomyMode = "enabled" | "paused" | "disabled";
export const CAT_AUTONOMY_DAILY_BUDGET_MIN = 1;
export const CAT_AUTONOMY_DAILY_BUDGET_MAX = 1_000;

interface CatAutonomyEventBase {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly event_type: CatAutonomyEventType;
  readonly source: CatAutonomyEventSource;
  readonly occurred_at_ms: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CatTimerElapsedEvent extends CatAutonomyEventBase {
  readonly event_type: "timer.elapsed";
  readonly source: "timer";
  readonly payload: Readonly<{ readonly schedule_id: string }>;
}

export interface CatHaStateChangedEvent extends CatAutonomyEventBase {
  readonly event_type: "ha.state_changed";
  readonly source: "home_assistant";
  readonly payload: Readonly<{
    readonly alias: string;
    readonly domain: string;
    readonly previous_state: string | null;
    readonly current_state: string | null;
    readonly available: boolean;
  }>;
}

export interface CatWorldChangedEvent extends CatAutonomyEventBase {
  readonly event_type: "world.changed";
  readonly source: "p4_world";
  readonly payload: Readonly<{
    readonly room_id: RoomId;
    readonly activity: "idle" | "sleep";
    readonly state_version: number;
    readonly cause: "user" | "robot" | "local_fallback" | "autonomy";
  }>;
}

export interface CatTaskCompletedEvent extends CatAutonomyEventBase {
  readonly event_type: "task.completed";
  readonly source: "runtime";
  readonly payload: Readonly<{
    readonly role_id: "human" | "robot";
    readonly outcome: "completed" | "failed" | "cancelled" | "timed_out";
    readonly task_kind: "conversation" | "home_command";
  }>;
}

export type CatAutonomyEvent =
  | CatTimerElapsedEvent
  | CatHaStateChangedEvent
  | CatWorldChangedEvent
  | CatTaskCompletedEvent;

export type CatAutonomyPolicyErrorCode =
  | "AUTONOMY_DISABLED"
  | "AUTONOMY_PAUSED"
  | "BEFORE_RUNTIME_START"
  | "QUIET_HOURS"
  | "DAILY_BUDGET_EXHAUSTED"
  | "GLOBAL_RATE_LIMITED"
  | "SOURCE_RATE_LIMITED"
  | "SOURCE_MAPPING_MISSING"
  | "FEEDBACK_LOOP_BLOCKED";

export interface CatAutonomyAuditRecord {
  readonly sequence: number;
  readonly event_id: string | null;
  readonly event_type: CatAutonomyEventType | "control.mode_changed" | null;
  readonly source: CatAutonomyEventSource | "user_control" | null;
  readonly occurred_at_ms: number;
  readonly decision: "accepted" | "rejected" | "control";
  readonly reason: "POLICY_APPROVED" | CatAutonomyPolicyErrorCode | string;
  readonly room_target: RoomId | null;
  readonly mode: CatAutonomyMode;
}

export interface CatAutonomyStatus {
  readonly mode: CatAutonomyMode;
  readonly role_profile_revision: "role-profile/v6";
  readonly runtime_started_at_ms: number;
  readonly quiet_hours: Readonly<{
    readonly start_minute: number;
    readonly end_minute: number;
    readonly utc_offset_minutes: number;
  }> | null;
  readonly daily_model_call_budget: number;
  readonly budget_day: string;
  readonly admitted_model_calls_today: number;
  readonly remaining_model_calls_today: number;
  readonly accepted_triggers: number;
  readonly rejected_triggers: number;
}

export interface CatAutonomyHaTarget {
  readonly domain: string;
  readonly room_target: RoomId;
}

export interface CatAutonomyPolicyOptions {
  readonly now?: () => number;
  readonly monotonic_now?: () => number;
  readonly runtime_started_at_ms?: number;
  readonly mode?: CatAutonomyMode;
  readonly max_age_ms?: number;
  readonly max_future_skew_ms?: number;
  readonly global_minimum_interval_ms?: number;
  readonly source_minimum_interval_ms?: Partial<Record<CatAutonomyEventSource, number>>;
  readonly daily_model_call_budget?: number;
  readonly budget_utc_offset_minutes?: number;
  readonly quiet_hours?: Readonly<{
    readonly start_minute: number;
    readonly end_minute: number;
    readonly utc_offset_minutes: number;
  }> | null;
  readonly timer_room_targets?: Readonly<Record<string, RoomId>>;
  readonly ha_room_targets?: Readonly<Record<string, CatAutonomyHaTarget>>;
  readonly task_room_targets?: Partial<Readonly<Record<"human" | "robot", RoomId>>>;
  readonly dedupe_retention_ms?: number;
  readonly dedupe_capacity?: number;
  readonly audit_capacity?: number;
  readonly on_mode_changed?: (mode: CatAutonomyMode) => void;
}

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAPPING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_STATE_LENGTH = 128;
const DAY_MS = 86_400_000;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function assertDuration(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function assertRoom(room: string, label: string): asserts room is RoomId {
  if (!(ROOM_IDS as readonly string[]).includes(room)) {
    throw new TypeError(`${label} contains an unknown room`);
  }
}

function localDay(nowMs: number, offsetMinutes: number): string {
  return new Date(nowMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function localMinute(nowMs: number, offsetMinutes: number): number {
  const shifted = new Date(nowMs + offsetMinutes * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function inQuietHours(
  nowMs: number,
  quiet: NonNullable<CatAutonomyPolicyOptions["quiet_hours"]>,
): boolean {
  if (quiet.start_minute === quiet.end_minute) {
    return true;
  }
  const minute = localMinute(nowMs, quiet.utc_offset_minutes);
  return quiet.start_minute < quiet.end_minute
    ? minute >= quiet.start_minute && minute < quiet.end_minute
    : minute >= quiet.start_minute || minute < quiet.end_minute;
}

function sanitizedString(value: unknown, maximum = MAX_STATE_LENGTH): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Phase 7 admission boundary. It accepts only four exact, normalized schemas,
 * converts them to one minimal room action, and owns every low-frequency gate.
 * The process start fence deliberately makes restart catch-up impossible.
 */
export class CatAutonomyPolicy extends CatEventPolicy {
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #runtimeStartedAtMs: number;
  readonly #maxAgeMs: number;
  readonly #maxFutureSkewMs: number;
  readonly #globalMinimumIntervalMs: number;
  readonly #sourceMinimumIntervalMs: Readonly<Record<CatAutonomyEventSource, number>>;
  readonly #dailyBudget: number;
  readonly #budgetUtcOffsetMinutes: number;
  readonly #quietHours: CatAutonomyStatus["quiet_hours"];
  readonly #timerRoomTargets: ReadonlyMap<string, RoomId>;
  readonly #haRoomTargets: ReadonlyMap<string, CatAutonomyHaTarget>;
  readonly #taskRoomTargets: ReadonlyMap<"human" | "robot", RoomId>;
  readonly #dedupeRetentionMs: number;
  readonly #dedupeCapacity: number;
  readonly #auditCapacity: number;
  readonly #onModeChanged: ((mode: CatAutonomyMode) => void) | undefined;
  readonly #seenEventIds = new Map<string, number>();
  readonly #lastAcceptedBySource = new Map<CatAutonomyEventSource, number>();
  readonly #audit: CatAutonomyAuditRecord[] = [];
  #lastAcceptedAt: number | null = null;
  #budgetDay: string;
  #budgetUsed = 0;
  #mode: CatAutonomyMode;
  #accepted = 0;
  #rejected = 0;
  #auditSequence = 0;

  public constructor(options: CatAutonomyPolicyOptions = {}) {
    super();
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonic_now ?? (() => performance.now());
    const constructedAt = this.#checkedNow();
    this.#runtimeStartedAtMs = options.runtime_started_at_ms ?? constructedAt;
    this.#mode = options.mode ?? "enabled";
    this.#maxAgeMs = options.max_age_ms ?? 60_000;
    this.#maxFutureSkewMs = options.max_future_skew_ms ?? 1_000;
    this.#globalMinimumIntervalMs = options.global_minimum_interval_ms ?? 300_000;
    this.#sourceMinimumIntervalMs = {
      timer: options.source_minimum_interval_ms?.timer ?? 900_000,
      home_assistant: options.source_minimum_interval_ms?.home_assistant ?? 900_000,
      p4_world: options.source_minimum_interval_ms?.p4_world ?? 900_000,
      runtime: options.source_minimum_interval_ms?.runtime ?? 900_000,
    };
    this.#dailyBudget = options.daily_model_call_budget ?? 24;
    this.#budgetUtcOffsetMinutes = options.budget_utc_offset_minutes ?? 480;
    this.#quietHours = options.quiet_hours === undefined
      ? { start_minute: 23 * 60, end_minute: 7 * 60, utc_offset_minutes: 480 }
      : options.quiet_hours;
    this.#dedupeRetentionMs = options.dedupe_retention_ms ?? DAY_MS;
    this.#dedupeCapacity = options.dedupe_capacity ?? 8_192;
    this.#auditCapacity = options.audit_capacity ?? 2_048;
    this.#onModeChanged = options.on_mode_changed;

    if (!["enabled", "paused", "disabled"].includes(this.#mode)) {
      throw new TypeError("Cat autonomy mode is invalid");
    }
    assertDuration("runtime_started_at_ms", this.#runtimeStartedAtMs, 0, Number.MAX_SAFE_INTEGER);
    assertDuration("max_age_ms", this.#maxAgeMs, 1, DAY_MS);
    assertDuration("max_future_skew_ms", this.#maxFutureSkewMs, 0, 60_000);
    assertDuration("global_minimum_interval_ms", this.#globalMinimumIntervalMs, 0, DAY_MS);
    for (const [source, duration] of Object.entries(this.#sourceMinimumIntervalMs)) {
      assertDuration(`${source}_minimum_interval_ms`, duration, 0, DAY_MS);
    }
    assertDuration(
      "daily_model_call_budget",
      this.#dailyBudget,
      CAT_AUTONOMY_DAILY_BUDGET_MIN,
      CAT_AUTONOMY_DAILY_BUDGET_MAX,
    );
    assertDuration("budget_utc_offset_minutes", this.#budgetUtcOffsetMinutes, -840, 840);
    assertDuration("dedupe_retention_ms", this.#dedupeRetentionMs, 1, 7 * DAY_MS);
    assertDuration("dedupe_capacity", this.#dedupeCapacity, 1, 100_000);
    assertDuration("audit_capacity", this.#auditCapacity, 1, 100_000);
    if (this.#quietHours !== null) {
      assertDuration("quiet_hours.start_minute", this.#quietHours.start_minute, 0, 1_439);
      assertDuration("quiet_hours.end_minute", this.#quietHours.end_minute, 0, 1_439);
      assertDuration("quiet_hours.utc_offset_minutes", this.#quietHours.utc_offset_minutes, -840, 840);
    }

    this.#timerRoomTargets = new Map(Object.entries(options.timer_room_targets ?? {}));
    for (const [scheduleId, room] of this.#timerRoomTargets) {
      if (!MAPPING_ID_PATTERN.test(scheduleId)) {
        throw new TypeError("timer_room_targets contains an invalid schedule id");
      }
      assertRoom(room, "timer_room_targets");
    }
    this.#haRoomTargets = new Map(Object.entries(options.ha_room_targets ?? {}));
    for (const [alias, target] of this.#haRoomTargets) {
      if (!MAPPING_ID_PATTERN.test(alias) || !MAPPING_ID_PATTERN.test(target.domain)) {
        throw new TypeError("ha_room_targets contains an invalid alias or domain");
      }
      assertRoom(target.room_target, "ha_room_targets");
    }
    this.#taskRoomTargets = new Map(Object.entries(options.task_room_targets ?? {}) as [
      "human" | "robot",
      RoomId,
    ][]);
    for (const [role, room] of this.#taskRoomTargets) {
      if (role !== "human" && role !== "robot") {
        throw new TypeError("task_room_targets contains an invalid role");
      }
      assertRoom(room, "task_room_targets");
    }
    this.#budgetDay = localDay(constructedAt, this.#budgetUtcOffsetMinutes);
  }

  public override approve(input: unknown): ApprovedCatRoomTargetEvent {
    const now = this.#checkedNow();
    let event: CatAutonomyEvent;
    try {
      event = this.#validateEvent(input);
    } catch (error) {
      this.#rejected += 1;
      this.#record(null, now, "rejected", error instanceof CatEventPolicyError ? error.code : "INVALID_EVENT", null);
      throw error;
    }
    const reject = (code: CatEventPolicyErrorCode, message: string): never => {
      this.#rejected += 1;
      this.#record(event, now, "rejected", code, null);
      throw new CatEventPolicyError(code, message);
    };
    if (this.#mode === "disabled") reject("AUTONOMY_DISABLED", "Cat autonomy is disabled");
    if (this.#mode === "paused") reject("AUTONOMY_PAUSED", "Cat autonomy is paused");
    if (event.occurred_at_ms < this.#runtimeStartedAtMs) {
      reject("BEFORE_RUNTIME_START", "Cat trigger predates this runtime and will not be caught up");
    }
    if (event.occurred_at_ms > now + this.#maxFutureSkewMs) {
      reject("FUTURE_EVENT", "Cat trigger is too far in the future");
    }
    if (now - event.occurred_at_ms > this.#maxAgeMs) {
      reject("STALE_EVENT", "Cat trigger is stale");
    }
    if (this.#quietHours !== null && inQuietHours(now, this.#quietHours)) {
      reject("QUIET_HOURS", "Cat autonomy is suppressed during quiet hours");
    }
    const policyNow = this.#checkedMonotonicNow();
    this.#pruneSeen(policyNow);
    if (this.#seenEventIds.has(event.event_id)) {
      reject("DUPLICATE_EVENT", "Cat trigger event_id was already accepted");
    }
    if (this.#seenEventIds.size >= this.#dedupeCapacity) {
      reject("DEDUPE_CAPACITY_EXCEEDED", "Cat trigger dedupe capacity is exhausted");
    }
    if (
      this.#lastAcceptedAt !== null
      && policyNow - this.#lastAcceptedAt < this.#globalMinimumIntervalMs
    ) {
      reject("GLOBAL_RATE_LIMITED", "Cat autonomy global rate limit was exceeded");
    }
    const lastSource = this.#lastAcceptedBySource.get(event.source);
    if (
      lastSource !== undefined
      && policyNow - lastSource < this.#sourceMinimumIntervalMs[event.source]
    ) {
      reject("SOURCE_RATE_LIMITED", "Cat autonomy source rate limit was exceeded");
    }
    this.#rollBudget(now);
    if (this.#budgetUsed >= this.#dailyBudget) {
      reject("DAILY_BUDGET_EXHAUSTED", "Cat autonomy daily model-call budget is exhausted");
    }

    const roomTarget = this.#roomTarget(event, reject);
    this.#seenEventIds.set(event.event_id, policyNow);
    this.#lastAcceptedAt = policyNow;
    this.#lastAcceptedBySource.set(event.source, policyNow);
    this.#budgetUsed += 1;
    this.#accepted += 1;
    this.#record(event, now, "accepted", "POLICY_APPROVED", roomTarget);
    return {
      event_id: event.event_id,
      event_type: event.event_type,
      source: event.source,
      occurred_at_ms: event.occurred_at_ms,
      payload: { room_target: roomTarget },
      tool: "character.go_to_room",
      arguments: { room_id: roomTarget },
      approved_at_ms: now,
    };
  }

  public setMode(mode: CatAutonomyMode): void {
    if (!["enabled", "paused", "disabled"].includes(mode)) {
      throw new TypeError("Cat autonomy mode is invalid");
    }
    if (mode === this.#mode) return;
    this.#mode = mode;
    const now = this.#checkedNow();
    this.#record({
      event_id: `control:${this.#auditSequence + 1}`,
      event_type: "control.mode_changed",
      source: "user_control",
      occurred_at_ms: now,
    }, now, "control", "MODE_CHANGED", null);
    try {
      this.#onModeChanged?.(mode);
    } catch {
      // A control observer cannot roll back or block the fail-closed mode change.
    }
  }

  public getStatus(): CatAutonomyStatus {
    const now = this.#checkedNow();
    this.#rollBudget(now);
    return {
      mode: this.#mode,
      role_profile_revision: "role-profile/v6",
      runtime_started_at_ms: this.#runtimeStartedAtMs,
      quiet_hours: this.#quietHours === null ? null : { ...this.#quietHours },
      daily_model_call_budget: this.#dailyBudget,
      budget_day: this.#budgetDay,
      admitted_model_calls_today: this.#budgetUsed,
      remaining_model_calls_today: this.#dailyBudget - this.#budgetUsed,
      accepted_triggers: this.#accepted,
      rejected_triggers: this.#rejected,
    };
  }

  public listAudit(limit = 100): readonly CatAutonomyAuditRecord[] {
    assertDuration("audit limit", limit, 1, this.#auditCapacity);
    return this.#audit.slice(-limit).reverse().map((record) => structuredClone(record));
  }

  #checkedNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Cat autonomy clock must return a non-negative safe integer");
    }
    return value;
  }

  #checkedMonotonicNow(): number {
    const value = this.#monotonicNow();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("Cat autonomy monotonic clock must return a non-negative number");
    }
    return value;
  }

  #validateEvent(input: unknown): CatAutonomyEvent {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat autonomy trigger must be an object");
    }
    const event = input as Record<string, unknown>;
    if (!exactKeys(event, ["schema_version", "event_id", "event_type", "source", "occurred_at_ms", "payload"])) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat autonomy trigger has missing or unauthorized fields");
    }
    if (
      event.schema_version !== 1
      || !sanitizedString(event.event_id)
      || !EVENT_ID_PATTERN.test(event.event_id)
      || !(CAT_AUTONOMY_EVENT_TYPES as readonly unknown[]).includes(event.event_type)
      || !Number.isSafeInteger(event.occurred_at_ms)
      || Number(event.occurred_at_ms) < 0
      || event.payload === null
      || typeof event.payload !== "object"
      || Array.isArray(event.payload)
    ) {
      throw new CatEventPolicyError("INVALID_EVENT", "Cat autonomy trigger envelope is invalid");
    }
    const payload = event.payload as Record<string, unknown>;
    if (event.event_type === "timer.elapsed") {
      if (event.source !== "timer" || !exactKeys(payload, ["schedule_id"]) || !sanitizedString(payload.schedule_id, 64)) {
        throw new CatEventPolicyError("INVALID_EVENT", "Timer trigger projection is invalid");
      }
    } else if (event.event_type === "ha.state_changed") {
      if (
        event.source !== "home_assistant"
        || !exactKeys(payload, ["alias", "domain", "previous_state", "current_state", "available"])
        || !sanitizedString(payload.alias, 64)
        || !sanitizedString(payload.domain, 64)
        || (payload.previous_state !== null && !sanitizedString(payload.previous_state))
        || (payload.current_state !== null && !sanitizedString(payload.current_state))
        || typeof payload.available !== "boolean"
      ) {
        throw new CatEventPolicyError("INVALID_EVENT", "HA trigger projection is invalid");
      }
    } else if (event.event_type === "world.changed") {
      if (
        event.source !== "p4_world"
        || !exactKeys(payload, ["room_id", "activity", "state_version", "cause"])
        || typeof payload.room_id !== "string"
        || !(ROOM_IDS as readonly string[]).includes(payload.room_id)
        || (payload.activity !== "idle" && payload.activity !== "sleep")
        || !Number.isSafeInteger(payload.state_version)
        || Number(payload.state_version) < 0
        || !["user", "robot", "local_fallback", "autonomy"].includes(String(payload.cause))
      ) {
        throw new CatEventPolicyError("INVALID_EVENT", "World trigger projection is invalid");
      }
    } else if (
      event.source !== "runtime"
      || !exactKeys(payload, ["role_id", "outcome", "task_kind"])
      || (payload.role_id !== "human" && payload.role_id !== "robot")
      || !["completed", "failed", "cancelled", "timed_out"].includes(String(payload.outcome))
      || !["conversation", "home_command"].includes(String(payload.task_kind))
    ) {
      throw new CatEventPolicyError("INVALID_EVENT", "Task-complete trigger projection is invalid");
    }
    return structuredClone(event) as unknown as CatAutonomyEvent;
  }

  #roomTarget(
    event: CatAutonomyEvent,
    reject: (code: CatEventPolicyErrorCode, message: string) => never,
  ): RoomId {
    if (event.event_type === "timer.elapsed") {
      return this.#timerRoomTargets.get(event.payload.schedule_id)
        ?? reject("SOURCE_MAPPING_MISSING", "Timer schedule has no allowlisted Cat target");
    }
    if (event.event_type === "ha.state_changed") {
      const target = this.#haRoomTargets.get(event.payload.alias);
      if (target === undefined || target.domain !== event.payload.domain) {
        return reject("SOURCE_MAPPING_MISSING", "HA alias/domain has no allowlisted Cat target");
      }
      return target.room_target;
    }
    if (event.event_type === "world.changed") {
      if (event.payload.cause === "autonomy") {
        return reject("FEEDBACK_LOOP_BLOCKED", "Autonomy-originated World changes cannot retrigger Cat");
      }
      return event.payload.room_id;
    }
    return this.#taskRoomTargets.get(event.payload.role_id)
      ?? reject("SOURCE_MAPPING_MISSING", "Task role has no allowlisted Cat target");
  }

  #rollBudget(now: number): void {
    const day = localDay(now, this.#budgetUtcOffsetMinutes);
    if (day !== this.#budgetDay) {
      this.#budgetDay = day;
      this.#budgetUsed = 0;
    }
  }

  #pruneSeen(now: number): void {
    const cutoff = now - this.#dedupeRetentionMs;
    for (const [eventId, acceptedAt] of this.#seenEventIds) {
      if (acceptedAt > cutoff) break;
      this.#seenEventIds.delete(eventId);
    }
  }

  #record(
    event: Pick<CatAutonomyEvent, "event_id" | "event_type" | "source" | "occurred_at_ms"> | {
      readonly event_id: string;
      readonly event_type: "control.mode_changed";
      readonly source: "user_control";
      readonly occurred_at_ms: number;
    } | null,
    decidedAtMs: number,
    decision: CatAutonomyAuditRecord["decision"],
    reason: string,
    roomTarget: RoomId | null,
  ): void {
    this.#auditSequence += 1;
    this.#audit.push({
      sequence: this.#auditSequence,
      event_id: event?.event_id ?? null,
      event_type: event?.event_type ?? null,
      source: event?.source ?? null,
      occurred_at_ms: event?.occurred_at_ms ?? decidedAtMs,
      decision,
      reason,
      room_target: roomTarget,
      mode: this.#mode,
    });
    if (this.#audit.length > this.#auditCapacity) {
      this.#audit.splice(0, this.#audit.length - this.#auditCapacity);
    }
  }
}
