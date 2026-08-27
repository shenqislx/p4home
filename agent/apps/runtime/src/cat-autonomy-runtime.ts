import { createHash } from "node:crypto";

import type { RoomId } from "@p4home/domain-p4home";
import type { RobotHaProjectedState, RobotHaWriteClient } from "@p4home/transport-ha";

import {
  DeviceWebSocketActionAdapter,
  type DeviceWorldChangedObservation,
} from "./device-action-adapter.ts";
import {
  runCatRoomTargetEvent,
  type CatActionRunResult,
  type RunCatRoomTargetEventOptions,
} from "./cat-action-runner.ts";
import {
  type CatAutonomyAuditRecord,
  type CatAutonomyEvent,
  type CatAutonomyMode,
  CatAutonomyPolicy,
  type CatAutonomyStatus,
  type CatHaStateChangedEvent,
  type CatTaskCompletedEvent,
  type CatTimerElapsedEvent,
  type CatWorldChangedEvent,
} from "./cat-autonomy-policy.ts";
import {
  defaultLowPriorityCatRunRegistry,
  type LowPriorityCatRunRegistry,
} from "./low-priority-cat-run-registry.ts";
import type { RoleTaskCompletionNotice } from "./role-orchestrator.ts";

type RunnerOptions = Omit<
  RunCatRoomTargetEventOptions,
  | "event"
  | "run_id"
  | "session_id"
  | "session_created_at_ms"
  | "tool_call_id"
  | "action_id"
  | "policy"
  | "cat_run_registry"
>;

export interface CatAutonomyRuntimeOptions extends RunnerOptions {
  readonly policy: CatAutonomyPolicy;
  readonly session_id?: string;
  readonly runtime_started_at_ms?: number;
  readonly cat_run_registry?: LowPriorityCatRunRegistry;
}

export interface CatAutonomyEventIdentity {
  readonly run_id: string;
  readonly tool_call_id: string;
  readonly action_id: string;
}

export interface CatAutonomyEventFactoryOptions {
  readonly event_id: string;
  readonly occurred_at_ms: number;
}

function eventIdentity(eventId: string): CatAutonomyEventIdentity {
  const digest = createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 24);
  const runId = `cat7:${digest}`;
  return {
    run_id: runId,
    tool_call_id: `${runId}:tool:1`,
    action_id: `${runId}:action:1`,
  };
}

export function createCatTimerElapsedEvent(
  input: CatAutonomyEventFactoryOptions & { readonly schedule_id: string },
): CatTimerElapsedEvent {
  return {
    schema_version: 1,
    event_id: input.event_id,
    event_type: "timer.elapsed",
    source: "timer",
    occurred_at_ms: input.occurred_at_ms,
    payload: { schedule_id: input.schedule_id },
  };
}

export function createCatHaStateChangedEvent(
  input: CatAutonomyEventFactoryOptions & {
    readonly alias: string;
    readonly domain: string;
    readonly previous_state: string | null;
    readonly current_state: string | null;
    readonly available: boolean;
  },
): CatHaStateChangedEvent {
  return {
    schema_version: 1,
    event_id: input.event_id,
    event_type: "ha.state_changed",
    source: "home_assistant",
    occurred_at_ms: input.occurred_at_ms,
    payload: {
      alias: input.alias,
      domain: input.domain,
      previous_state: input.previous_state,
      current_state: input.current_state,
      available: input.available,
    },
  };
}

export function createCatWorldChangedEvent(
  input: CatAutonomyEventFactoryOptions & {
    readonly room_id: RoomId;
    readonly activity: "idle" | "sleep";
    readonly state_version: number;
    readonly cause: "user" | "robot" | "local_fallback" | "autonomy";
  },
): CatWorldChangedEvent {
  return {
    schema_version: 1,
    event_id: input.event_id,
    event_type: "world.changed",
    source: "p4_world",
    occurred_at_ms: input.occurred_at_ms,
    payload: {
      room_id: input.room_id,
      activity: input.activity,
      state_version: input.state_version,
      cause: input.cause,
    },
  };
}

export function createCatTaskCompletedEvent(
  input: CatAutonomyEventFactoryOptions & {
    readonly role_id: "human" | "robot";
    readonly outcome: "completed" | "failed" | "cancelled" | "timed_out";
  },
): CatTaskCompletedEvent {
  return {
    schema_version: 1,
    event_id: input.event_id,
    event_type: "task.completed",
    source: "runtime",
    occurred_at_ms: input.occurred_at_ms,
    payload: {
      role_id: input.role_id,
      outcome: input.outcome,
      task_kind: input.role_id === "robot" ? "home_command" : "conversation",
    },
  };
}

/** Product-facing Phase 7 facade: inspect/control policy and execute one admitted trigger. */
export class CatAutonomyRuntime {
  readonly #options: CatAutonomyRuntimeOptions;
  readonly #registry: LowPriorityCatRunRegistry;
  readonly #sessionId: string;
  readonly #runtimeStartedAtMs: number;

  public constructor(options: CatAutonomyRuntimeOptions) {
    this.#options = options;
    this.#registry = options.cat_run_registry ?? defaultLowPriorityCatRunRegistry;
    this.#sessionId = options.session_id ?? "cat-autonomy:v1";
    this.#runtimeStartedAtMs = options.runtime_started_at_ms ?? options.policy.getStatus().runtime_started_at_ms;
  }

  public async handle(event: CatAutonomyEvent): Promise<CatActionRunResult> {
    const identity = eventIdentity(event.event_id);
    return await runCatRoomTargetEvent({
      ...this.#options,
      event,
      ...identity,
      session_id: this.#sessionId,
      session_created_at_ms: this.#runtimeStartedAtMs,
      policy: this.#options.policy,
      cat_run_registry: this.#registry,
    });
  }

  public setMode(mode: CatAutonomyMode): void {
    this.#options.policy.setMode(mode);
    if (mode === "paused") this.#registry.cancelAll("autonomy_paused");
    if (mode === "disabled") this.#registry.cancelAll("autonomy_disabled");
  }

  public getStatus(): CatAutonomyStatus {
    return this.#options.policy.getStatus();
  }

  public listAudit(limit?: number): readonly CatAutonomyAuditRecord[] {
    return this.#options.policy.listAudit(limit);
  }
}

export type CatAutonomyTriggerResult = CatActionRunResult;

export interface CatAutonomyEventHandler {
  handle(event: CatAutonomyEvent): Promise<CatAutonomyTriggerResult>;
}

export interface CatAutonomySourceBridgeOptions {
  readonly runtime: CatAutonomyEventHandler;
  readonly clock?: () => number;
  readonly max_inflight?: number;
  readonly on_error?: (error: unknown, event: CatAutonomyEvent) => void;
  readonly on_result?: (
    result: CatAutonomyTriggerResult,
    event: CatAutonomyEvent,
  ) => void;
}

export class CatAutonomyIngressError extends Error {
  public readonly code: "INGRESS_FULL" | "INGRESS_CLOSED";

  public constructor(code: "INGRESS_FULL" | "INGRESS_CLOSED", message: string) {
    super(message);
    this.name = "CatAutonomyIngressError";
    this.code = code;
  }
}

function sameHaState(left: RobotHaProjectedState, right: RobotHaProjectedState): boolean {
  return left.alias === right.alias
    && left.domain === right.domain
    && left.state === right.state
    && left.available === right.available;
}

/**
 * Event-driven product ingress. It owns no timer loop: callers push Timer ticks,
 * while HA/P4/task observers are subscribed through bounded, non-blocking hooks.
 */
export class CatAutonomySourceBridge {
  readonly #runtime: CatAutonomyEventHandler;
  readonly #clock: () => number;
  readonly #maxInflight: number;
  readonly #onError: ((error: unknown, event: CatAutonomyEvent) => void) | undefined;
  readonly #onResult: ((
    result: CatAutonomyTriggerResult,
    event: CatAutonomyEvent,
  ) => void) | undefined;
  readonly #inflight = new Set<Promise<CatAutonomyTriggerResult>>();
  #sequence = 0;
  #closed = false;

  public constructor(options: CatAutonomySourceBridgeOptions) {
    this.#runtime = options.runtime;
    this.#clock = options.clock ?? Date.now;
    this.#maxInflight = options.max_inflight ?? 8;
    this.#onError = options.on_error;
    this.#onResult = options.on_result;
    if (!Number.isInteger(this.#maxInflight) || this.#maxInflight < 1 || this.#maxInflight > 1_024) {
      throw new RangeError("Cat autonomy max_inflight must be between 1 and 1024");
    }
  }

  public get inflight_count(): number {
    return this.#inflight.size;
  }

  public async emitTimer(
    scheduleId: string,
    occurredAtMs = this.#now(),
  ): Promise<CatAutonomyTriggerResult> {
    return await this.#dispatch(createCatTimerElapsedEvent({
      event_id: this.#eventId("timer", scheduleId, occurredAtMs),
      occurred_at_ms: occurredAtMs,
      schedule_id: scheduleId,
    }));
  }

  public bindHa(
    client: Pick<RobotHaWriteClient, "listStates" | "onState">,
    allowedAliases?: ReadonlySet<string>,
  ): () => void {
    const allowed = (alias: string): boolean => allowedAliases?.has(alias) ?? true;
    const previous = new Map(client.listStates()
      .filter((state) => allowed(state.alias))
      .map((state) => [state.alias, state]));
    return client.onState((state) => {
      if (!allowed(state.alias)) return;
      const before = previous.get(state.alias);
      previous.set(state.alias, structuredClone(state));
      if (before !== undefined && sameHaState(before, state)) return;
      const occurredAtMs = this.#now();
      const event = createCatHaStateChangedEvent({
        event_id: this.#eventId("ha", state.alias, occurredAtMs),
        occurred_at_ms: occurredAtMs,
        alias: state.alias,
        domain: state.domain,
        previous_state: before?.state ?? null,
        current_state: state.state,
        available: state.available,
      });
      this.#dispatchObserved(event);
    });
  }

  public bindWorld(adapter: Pick<
    DeviceWebSocketActionAdapter,
    "onWorldChanged" | "getAction"
  >): () => void {
    return adapter.onWorldChanged((observation) => {
      const occurredAtMs = this.#now();
      const event = createCatWorldChangedEvent({
        event_id: this.#eventId("world", String(observation.state_version), occurredAtMs),
        occurred_at_ms: occurredAtMs,
        room_id: observation.character.room_id,
        activity: observation.character.activity,
        state_version: observation.state_version,
        cause: this.#worldCause(adapter, observation),
      });
      this.#dispatchObserved(event);
    });
  }

  public taskCompletionSink(): (notice: RoleTaskCompletionNotice) => void {
    return (notice) => {
      if (this.#closed) return;
      const event = createCatTaskCompletedEvent({
        event_id: this.#eventId("task", notice.run_id, notice.occurred_at_ms),
        occurred_at_ms: notice.occurred_at_ms,
        role_id: notice.role_id,
        outcome: notice.outcome,
      });
      this.#dispatchObserved(event);
    };
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#inflight]);
  }

  async #dispatch(event: CatAutonomyEvent): Promise<CatAutonomyTriggerResult> {
    if (this.#closed) {
      throw new CatAutonomyIngressError("INGRESS_CLOSED", "Cat autonomy ingress is closed");
    }
    if (this.#inflight.size >= this.#maxInflight) {
      throw new CatAutonomyIngressError(
        "INGRESS_FULL",
        "Cat autonomy ingress capacity is exhausted",
      );
    }
    const operation = this.#runtime.handle(event);
    this.#inflight.add(operation);
    try {
      const result = await operation;
      try {
        this.#onResult?.(structuredClone(result), structuredClone(event));
      } catch {
        // A result observer cannot change Cat execution truth.
      }
      return result;
    } catch (error) {
      try {
        this.#onError?.(error, structuredClone(event));
      } catch {
        // An error observer cannot change Cat execution truth.
      }
      throw error;
    } finally {
      this.#inflight.delete(operation);
    }
  }

  #dispatchObserved(event: CatAutonomyEvent): void {
    void this.#dispatch(event).catch(() => undefined);
  }

  #worldCause(
    adapter: Pick<DeviceWebSocketActionAdapter, "getAction">,
    observation: DeviceWorldChangedObservation,
  ): CatWorldChangedEvent["payload"]["cause"] {
    const actionId = observation.character.active_action_id
      ?? observation.previous_active_action_id;
    if (actionId === null) return "local_fallback";
    const origin = adapter.getAction(actionId)?.request.origin;
    if (origin === "autonomy") return "autonomy";
    if (origin === "user") return "user";
    if (origin === "agent") return "robot";
    return "local_fallback";
  }

  #eventId(source: string, key: string, occurredAtMs: number): string {
    this.#sequence += 1;
    const digest = createHash("sha256")
      .update(`${source}\0${key}\0${occurredAtMs}\0${this.#sequence}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    return `cat7:${source}:${digest}`;
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Cat autonomy source clock must return a non-negative safe integer");
    }
    return value;
  }
}
