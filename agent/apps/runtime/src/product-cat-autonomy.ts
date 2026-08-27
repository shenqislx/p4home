import type { OllamaProvider } from "@p4home/provider-ollama";
import { ROOM_IDS, type RoomId } from "@p4home/domain-p4home";
import type { AuditStore } from "@p4home/storage-sqlite";
import type { RobotHaProjectedState, RobotHaWriteClient } from "@p4home/transport-ha";

import {
  CatAutonomyPolicy,
  type CatAutonomyMode,
  type CatAutonomyStatus,
  type CatAutonomyAuditRecord,
  CAT_AUTONOMY_DAILY_BUDGET_MAX,
  CAT_AUTONOMY_DAILY_BUDGET_MIN,
} from "./cat-autonomy-policy.ts";
import {
  CatAutonomyRuntime,
  CatAutonomySourceBridge,
  type CatAutonomyEventHandler,
  type CatAutonomyTriggerResult,
} from "./cat-autonomy-runtime.ts";
import type { CatAutonomyEvent } from "./cat-autonomy-policy.ts";
import type { DeviceWebSocketActionAdapter } from "./device-action-adapter.ts";
import type { DeviceRuntimeHub } from "./device-websocket-server.ts";
import {
  LowPriorityCatRunRegistry,
  defaultLowPriorityCatRunRegistry,
} from "./low-priority-cat-run-registry.ts";
import type { RoleTaskCompletionNotice } from "./role-orchestrator.ts";
import type { RoleMemoryRuntime } from "./role-memory.ts";
import type { RoleScheduler } from "./role-scheduler.ts";

const CONFIG_KEYS = new Set([
  "schema_version",
  "initial_mode",
  "timer",
  "ha_room_targets",
  "task_room_targets",
  "quiet_hours",
  "daily_model_call_budget",
  "global_minimum_interval_ms",
  "source_minimum_interval_ms",
]);
const TIMER_KEYS = new Set(["schedule_id", "interval_ms", "room_target"]);
const HA_TARGET_KEYS = new Set(["domain", "room_target"]);
const QUIET_KEYS = new Set(["start_minute", "end_minute", "utc_offset_minutes"]);
const SOURCE_KEYS = new Set(["timer", "home_assistant", "p4_world", "runtime"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface ProductCatAutonomyTimerConfig {
  readonly schedule_id: string;
  readonly interval_ms: number;
  readonly room_target: RoomId;
}

export interface ProductCatAutonomyConfig {
  readonly schema_version: 1;
  readonly initial_mode: CatAutonomyMode;
  readonly timer: ProductCatAutonomyTimerConfig;
  readonly ha_room_targets: Readonly<Record<string, {
    readonly domain: string;
    readonly room_target: RoomId;
  }>>;
  readonly task_room_targets: Readonly<Partial<Record<"human" | "robot", RoomId>>>;
  readonly quiet_hours: Readonly<{
    readonly start_minute: number;
    readonly end_minute: number;
    readonly utc_offset_minutes: number;
  }> | null;
  readonly daily_model_call_budget: number;
  readonly global_minimum_interval_ms: number;
  readonly source_minimum_interval_ms: Readonly<Partial<Record<
    "timer" | "home_assistant" | "p4_world" | "runtime",
    number
  >>>;
}

export interface ProductCatAutonomyLogRecord {
  readonly event:
    | "cat_autonomy_ready"
    | "cat_autonomy_trigger_completed"
    | "cat_autonomy_trigger_rejected"
    | "cat_autonomy_closed";
  readonly source?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly run_id?: string;
  readonly action_id?: string;
}

export interface ProductCatAutonomyExecutionRecord {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_type: CatAutonomyEvent["event_type"];
  readonly source: CatAutonomyEvent["source"];
  readonly occurred_at_ms: number;
  readonly decision: "terminal" | "rejected";
  readonly reason: string | null;
  readonly run_id: string | null;
  readonly action_id: string | null;
  readonly run_status: CatAutonomyTriggerResult["status"] | null;
  readonly outcome_status: CatAutonomyTriggerResult["outcome"]["status"] | null;
}

export interface ProductCatAutonomyRuntimeOptions {
  readonly device_id: string;
  readonly device_hub: Pick<DeviceRuntimeHub, "getAdapter" | "onAdapterReady">;
  readonly ha_client: Pick<RobotHaWriteClient, "listStates" | "onState">;
  readonly config: ProductCatAutonomyConfig;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly scheduler: RoleScheduler;
  readonly audit_store: AuditStore;
  readonly memory?: RoleMemoryRuntime;
  readonly cat_run_registry?: LowPriorityCatRunRegistry;
  readonly clock?: () => number;
  readonly on_log?: (record: ProductCatAutonomyLogRecord) => void;
  readonly execution_audit_capacity?: number;
}

export interface ProductCatAutonomyRuntimeStatus extends CatAutonomyStatus {
  readonly product_ready: boolean;
  readonly device_id: string;
  readonly timer_schedule_id: string;
  readonly timer_interval_ms: number;
  readonly ingress_inflight: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function room(value: unknown, label: string): RoomId {
  if (typeof value !== "string" || !(ROOM_IDS as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be a known room`);
  }
  return value as RoomId;
}

function durationRecord(
  value: unknown,
): ProductCatAutonomyConfig["source_minimum_interval_ms"] {
  const input = object(value, "source_minimum_interval_ms");
  exactKeys(input, SOURCE_KEYS, "source_minimum_interval_ms");
  return Object.fromEntries(Object.entries(input).map(([source, duration]) => [
    source,
    integer(duration, `source_minimum_interval_ms.${source}`, 0, 86_400_000),
  ]));
}

/** Strict product configuration; HA aliases must already exist in the real allowlist projection. */
export function parseProductCatAutonomyConfig(
  value: unknown,
  haStates: readonly RobotHaProjectedState[],
): ProductCatAutonomyConfig {
  const input = object(value, "Cat autonomy config");
  exactKeys(input, CONFIG_KEYS, "Cat autonomy config");
  if (input.schema_version !== 1) throw new TypeError("Cat autonomy schema_version must be 1");
  if (!(["enabled", "paused", "disabled"] as const).includes(input.initial_mode as CatAutonomyMode)) {
    throw new TypeError("Cat autonomy initial_mode is invalid");
  }

  const timerInput = object(input.timer, "timer");
  exactKeys(timerInput, TIMER_KEYS, "timer");
  if (typeof timerInput.schedule_id !== "string" || !ID.test(timerInput.schedule_id)) {
    throw new TypeError("timer.schedule_id is invalid");
  }
  const timer: ProductCatAutonomyTimerConfig = {
    schedule_id: timerInput.schedule_id,
    interval_ms: integer(timerInput.interval_ms, "timer.interval_ms", 60_000, 86_400_000),
    room_target: room(timerInput.room_target, "timer.room_target"),
  };

  const states = new Map(haStates.map((state) => [state.alias, state]));
  const haInput = object(input.ha_room_targets, "ha_room_targets");
  const haRoomTargets: Record<string, { domain: string; room_target: RoomId }> = {};
  for (const [alias, rawTarget] of Object.entries(haInput)) {
    if (!ID.test(alias)) throw new TypeError(`HA alias ${alias} is invalid`);
    const target = object(rawTarget, `ha_room_targets.${alias}`);
    exactKeys(target, HA_TARGET_KEYS, `ha_room_targets.${alias}`);
    const projected = states.get(alias);
    if (projected === undefined) throw new TypeError(`HA alias ${alias} is not allowlisted`);
    if (target.domain !== projected.domain) {
      throw new TypeError(`HA alias ${alias} domain does not match its allowlist projection`);
    }
    haRoomTargets[alias] = {
      domain: projected.domain,
      room_target: room(target.room_target, `ha_room_targets.${alias}.room_target`),
    };
  }

  const taskInput = object(input.task_room_targets, "task_room_targets");
  exactKeys(taskInput, new Set(["human", "robot"]), "task_room_targets");
  const taskRoomTargets: Partial<Record<"human" | "robot", RoomId>> = {};
  if (taskInput.human !== undefined) taskRoomTargets.human = room(taskInput.human, "task_room_targets.human");
  if (taskInput.robot !== undefined) taskRoomTargets.robot = room(taskInput.robot, "task_room_targets.robot");

  let quietHours: ProductCatAutonomyConfig["quiet_hours"] = null;
  if (input.quiet_hours !== null) {
    const quiet = object(input.quiet_hours, "quiet_hours");
    exactKeys(quiet, QUIET_KEYS, "quiet_hours");
    quietHours = {
      start_minute: integer(quiet.start_minute, "quiet_hours.start_minute", 0, 1_439),
      end_minute: integer(quiet.end_minute, "quiet_hours.end_minute", 0, 1_439),
      utc_offset_minutes: integer(
        quiet.utc_offset_minutes,
        "quiet_hours.utc_offset_minutes",
        -840,
        840,
      ),
    };
  }

  return {
    schema_version: 1,
    initial_mode: input.initial_mode as CatAutonomyMode,
    timer,
    ha_room_targets: haRoomTargets,
    task_room_targets: taskRoomTargets,
    quiet_hours: quietHours,
    daily_model_call_budget: integer(
      input.daily_model_call_budget,
      "daily_model_call_budget",
      CAT_AUTONOMY_DAILY_BUDGET_MIN,
      CAT_AUTONOMY_DAILY_BUDGET_MAX,
    ),
    global_minimum_interval_ms: integer(
      input.global_minimum_interval_ms,
      "global_minimum_interval_ms",
      0,
      86_400_000,
    ),
    source_minimum_interval_ms: durationRecord(input.source_minimum_interval_ms),
  };
}

class ProductCatAutonomyTimer {
  readonly #scheduleId: string;
  readonly #intervalMs: number;
  readonly #emit: (scheduleId: string) => Promise<CatAutonomyTriggerResult>;
  readonly #onResult: (result: CatAutonomyTriggerResult) => void;
  readonly #onError: (error: unknown) => void;
  #timeout: NodeJS.Timeout | null = null;
  #closed = false;

  public constructor(options: {
    schedule_id: string;
    interval_ms: number;
    emit: (scheduleId: string) => Promise<CatAutonomyTriggerResult>;
    on_result: (result: CatAutonomyTriggerResult) => void;
    on_error: (error: unknown) => void;
  }) {
    this.#scheduleId = options.schedule_id;
    this.#intervalMs = options.interval_ms;
    this.#emit = options.emit;
    this.#onResult = options.on_result;
    this.#onError = options.on_error;
  }

  public start(): void {
    if (this.#closed || this.#timeout !== null) return;
    this.#scheduleNext();
  }

  public close(): void {
    this.#closed = true;
    if (this.#timeout !== null) clearTimeout(this.#timeout);
    this.#timeout = null;
  }

  #scheduleNext(): void {
    this.#timeout = setTimeout(() => {
      this.#timeout = null;
      void this.#emit(this.#scheduleId).then(this.#onResult, this.#onError).finally(() => {
        if (!this.#closed) this.#scheduleNext();
      });
    }, this.#intervalMs);
    this.#timeout.unref();
  }
}

function safeReason(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code).slice(0, 64);
  }
  return error instanceof Error ? error.name.slice(0, 64) : "unknown";
}

/** Product lifecycle that activates only after the paired P4 has completed its handshake. */
export class ProductCatAutonomyRuntime {
  readonly #options: ProductCatAutonomyRuntimeOptions;
  readonly #policy: CatAutonomyPolicy;
  readonly #registry: LowPriorityCatRunRegistry;
  #runtime: CatAutonomyRuntime | null = null;
  #bridge: CatAutonomySourceBridge | null = null;
  #adapter: DeviceWebSocketActionAdapter | null = null;
  #timer: ProductCatAutonomyTimer | null = null;
  #removeAdapterReady: (() => void) | null = null;
  #sourceCleanups: (() => void)[] = [];
  #started = false;
  #closed = false;
  readonly #executionAuditCapacity: number;
  readonly #executionAudit: ProductCatAutonomyExecutionRecord[] = [];
  #executionSequence = 0;

  public constructor(options: ProductCatAutonomyRuntimeOptions) {
    this.#options = options;
    this.#registry = options.cat_run_registry ?? defaultLowPriorityCatRunRegistry;
    this.#executionAuditCapacity = options.execution_audit_capacity ?? 1_024;
    if (
      !Number.isInteger(this.#executionAuditCapacity)
      || this.#executionAuditCapacity < 1
      || this.#executionAuditCapacity > 100_000
    ) {
      throw new RangeError("Product Cat execution audit capacity must be between 1 and 100000");
    }
    const now = options.clock ?? Date.now;
    this.#policy = new CatAutonomyPolicy({
      now,
      runtime_started_at_ms: now(),
      mode: options.config.initial_mode,
      quiet_hours: options.config.quiet_hours,
      daily_model_call_budget: options.config.daily_model_call_budget,
      global_minimum_interval_ms: options.config.global_minimum_interval_ms,
      source_minimum_interval_ms: options.config.source_minimum_interval_ms,
      timer_room_targets: {
        [options.config.timer.schedule_id]: options.config.timer.room_target,
      },
      ha_room_targets: options.config.ha_room_targets,
      task_room_targets: options.config.task_room_targets,
    });
  }

  public start(): void {
    if (this.#closed) throw new TypeError("Product Cat autonomy runtime is closed");
    if (this.#started) return;
    this.#started = true;
    this.#removeAdapterReady = this.#options.device_hub.onAdapterReady((deviceId, adapter) => {
      if (deviceId === this.#options.device_id) this.#activate(adapter);
    });
    const existing = this.#options.device_hub.getAdapter(this.#options.device_id);
    if (existing?.is_ready === true) this.#activate(existing);
  }

  public taskCompletionSink(): (notice: RoleTaskCompletionNotice) => void {
    return (notice) => {
      if (this.#closed) return;
      this.#bridge?.taskCompletionSink()(notice);
    };
  }

  public setMode(mode: CatAutonomyMode): void {
    if (this.#runtime !== null) {
      this.#runtime.setMode(mode);
      return;
    }
    this.#policy.setMode(mode);
    if (mode === "paused") this.#registry.cancelAll("autonomy_paused");
    if (mode === "disabled") this.#registry.cancelAll("autonomy_disabled");
  }

  public getStatus(): ProductCatAutonomyRuntimeStatus {
    return {
      ...this.#policy.getStatus(),
      product_ready: !this.#closed && this.#adapter?.is_ready === true,
      device_id: this.#options.device_id,
      timer_schedule_id: this.#options.config.timer.schedule_id,
      timer_interval_ms: this.#options.config.timer.interval_ms,
      ingress_inflight: this.#bridge?.inflight_count ?? 0,
    };
  }

  public listAudit(limit?: number): readonly CatAutonomyAuditRecord[] {
    return this.#policy.listAudit(limit);
  }

  public listExecutionAudit(limit = 50): readonly ProductCatAutonomyExecutionRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Product Cat execution audit limit is invalid");
    }
    const boundedLimit = Math.min(limit, this.#executionAuditCapacity);
    return this.#executionAudit.slice(-boundedLimit).reverse()
      .map((record) => structuredClone(record));
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#timer?.close();
    this.#timer = null;
    for (const cleanup of this.#sourceCleanups.splice(0)) cleanup();
    this.#removeAdapterReady?.();
    this.#removeAdapterReady = null;
    this.#registry.cancelAll("shutdown");
    const bridge = this.#bridge;
    this.#bridge = null;
    await bridge?.close();
    this.#runtime = null;
    this.#adapter = null;
    this.#options.on_log?.({ event: "cat_autonomy_closed" });
  }

  #activate(adapter: DeviceWebSocketActionAdapter): void {
    if (this.#closed || this.#runtime !== null) return;
    const runtime = new CatAutonomyRuntime({
      policy: this.#policy,
      provider: this.#options.provider,
      scheduler: this.#options.scheduler,
      adapter,
      audit_store: this.#options.audit_store,
      cat_run_registry: this.#registry,
      ...(this.#options.memory === undefined ? {} : { memory: this.#options.memory }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
    });
    const guardedRuntime: CatAutonomyEventHandler = {
      handle: async (event) => {
        if (this.#closed || !adapter.is_ready) {
          const error = new Error("P4 device is not ready for Cat autonomy");
          error.name = "CatAutonomyDeviceNotReadyError";
          Object.assign(error, { code: "DEVICE_NOT_READY" });
          throw error;
        }
        return await runtime.handle(event);
      },
    };
    const bridge = new CatAutonomySourceBridge({
      runtime: guardedRuntime,
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      on_error: (error, event) => {
        const reason = safeReason(error);
        this.#appendExecution({
          event,
          decision: "rejected",
          reason,
          result: null,
        });
        this.#options.on_log?.({
          event: "cat_autonomy_trigger_rejected",
          source: event.source,
          reason,
        });
      },
      on_result: (result, event) => {
        this.#appendExecution({
          event,
          decision: "terminal",
          reason: null,
          result,
        });
        this.#options.on_log?.({
          event: "cat_autonomy_trigger_completed",
          source: event.source,
          status: result.status,
          run_id: result.run_id,
          action_id: result.action_id,
        });
      },
    });
    this.#runtime = runtime;
    this.#bridge = bridge;
    this.#adapter = adapter;
    this.#sourceCleanups.push(bridge.bindHa(
      this.#options.ha_client,
      new Set(Object.keys(this.#options.config.ha_room_targets)),
    ));
    this.#sourceCleanups.push(bridge.bindWorld(adapter));
    this.#timer = new ProductCatAutonomyTimer({
      schedule_id: this.#options.config.timer.schedule_id,
      interval_ms: this.#options.config.timer.interval_ms,
      emit: async (scheduleId) => await bridge.emitTimer(scheduleId),
      on_result: () => undefined,
      on_error: () => undefined,
    });
    this.#timer.start();
    this.#options.on_log?.({ event: "cat_autonomy_ready" });
  }

  #appendExecution(input: {
    readonly event: CatAutonomyEvent;
    readonly decision: ProductCatAutonomyExecutionRecord["decision"];
    readonly reason: string | null;
    readonly result: CatAutonomyTriggerResult | null;
  }): void {
    this.#executionSequence += 1;
    this.#executionAudit.push({
      sequence: this.#executionSequence,
      event_id: input.event.event_id,
      event_type: input.event.event_type,
      source: input.event.source,
      occurred_at_ms: input.event.occurred_at_ms,
      decision: input.decision,
      reason: input.reason,
      run_id: input.result?.run_id ?? null,
      action_id: input.result?.action_id ?? null,
      run_status: input.result?.status ?? null,
      outcome_status: input.result?.outcome.status ?? null,
    });
    if (this.#executionAudit.length > this.#executionAuditCapacity) {
      this.#executionAudit.splice(0, this.#executionAudit.length - this.#executionAuditCapacity);
    }
  }
}
