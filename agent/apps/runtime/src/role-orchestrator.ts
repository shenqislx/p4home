import { OllamaProviderError, type OllamaProvider } from "@p4home/provider-ollama";
import { createHash } from "node:crypto";
import type { ToolFailureResult } from "@p4home/core";
import type { RunAuditTrace } from "@p4home/storage-sqlite";

import type { RoleRunAuditOptions } from "./role-audit.ts";
import {
  assertContractId,
  type UserTextInteraction,
} from "./role-contracts.ts";
import {
  routeInteraction,
  type RouteInteractionResult,
} from "./role-router.ts";
import {
  runAssignedRole,
  RoleRunAuditFinalizeError,
  type RoleRunError,
  type RoleRunResult,
} from "./role-runner.ts";
import {
  composeRoleResponse,
  type AssignmentRunResult,
  type ComposedRoleResponse,
} from "./role-response-composer.ts";
import { RoleScheduler, RoleSchedulerError } from "./role-scheduler.ts";
import { RoleSessionRegistry } from "./role-session.ts";
import type { RobotHaReadRuntime } from "./robot-ha-read-runner.ts";
import type { RobotHaWriteRuntime } from "./robot-ha-write-runner.ts";
import type { RoleMemoryRuntime } from "./role-memory.ts";
import {
  defaultLowPriorityCatRunRegistry,
  type LowPriorityCatRunRegistry,
} from "./low-priority-cat-run-registry.ts";

export interface RoleTaskCompletionNotice {
  readonly run_id: string;
  readonly role_id: "human" | "robot";
  readonly outcome: "completed" | "failed" | "cancelled" | "timed_out";
  readonly occurred_at_ms: number;
}

export interface RunRoleInteractionOptions {
  readonly interaction: UserTextInteraction;
  readonly route_plan_id: string;
  readonly run_id: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly sessions: RoleSessionRegistry;
  readonly scheduler: RoleScheduler;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: RoleRunAuditOptions;
  readonly audit_finalize_timeout_ms?: number;
  readonly clock?: () => number;
  readonly robot_ha?: RobotHaReadRuntime | RobotHaWriteRuntime;
  readonly memory?: RoleMemoryRuntime;
  readonly human_only?: boolean;
  readonly cat_run_registry?: LowPriorityCatRunRegistry;
  readonly on_task_complete?: (notice: RoleTaskCompletionNotice) => void;
}

export interface RunRoleInteractionResult {
  readonly routing: RouteInteractionResult;
  readonly runs: readonly AssignmentRunResult[];
  readonly response: ComposedRoleResponse;
  readonly composition_audit_run_id: string | null;
  readonly composition_audit_status: "disabled" | "persisted" | "deferred";
  /** Compatibility view for single-assignment callers; mixed routes expose the first run. */
  readonly run: RoleRunResult;
}

function assignmentRunId(base: string, index: number, count: number): string {
  if (count === 1 || index === 0) {
    return base;
  }
  const suffix = `:${index + 1}`;
  return suffixedId(base, suffix);
}

function suffixedId(base: string, suffix: string): string {
  if (base.length + suffix.length <= 100) {
    return `${base}${suffix}`;
  }
  const digest = createHash("sha256")
    .update(`${base}\0${suffix}`)
    .digest("hex")
    .slice(0, 12);
  const tail = `:${digest}${suffix}`;
  return `${base.slice(0, 100 - tail.length)}${tail}`;
}

function failedScheduledRun(
  runId: string,
  roleId: "human" | "robot",
  error: unknown,
  deadlineExpired: boolean,
  signalAborted: boolean,
): RoleRunResult {
  const schedulerCode = error instanceof RoleSchedulerError ? error.code : null;
  const status = deadlineExpired
    ? "timed_out"
    : signalAborted || schedulerCode === "CANCELLED"
      ? "cancelled"
      : "failed";
  const detail: RoleRunError = {
    source: "runtime",
    code: deadlineExpired
      ? "DEADLINE_EXCEEDED"
      : signalAborted
        ? "CANCELLED"
      : schedulerCode === null
        ? "ROLE_RUN_FAILED"
        : `SCHEDULER_${schedulerCode}`,
    message: deadlineExpired
      ? "interaction deadline expired before the role run completed"
      : schedulerCode === null
        ? "role run failed unexpectedly"
        : "role run did not reach execution because scheduling failed",
    retryable: schedulerCode === "QUEUE_FULL",
  };
  return {
    run_id: runId,
    role_id: roleId,
    status,
    final_text: "",
    model_turns: 0,
    capability_available: roleId === "human",
    outcome: "error",
    tool_results: [],
    error: detail,
  };
}

function settleOnAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const abortError = (): OllamaProviderError => {
    const reasonName = typeof signal?.reason === "object"
      && signal.reason !== null
      && "name" in signal.reason
      ? String(signal.reason.name)
      : "";
    const timedOut = reasonName === "TimeoutError";
    return new OllamaProviderError(
      timedOut ? "TIMEOUT" : "CANCELLED",
      timedOut ? "operation exceeded the interaction deadline" : "operation was cancelled",
      { retryable: false },
    );
  };
  if (signal === undefined) {
    return operation();
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

interface AssignmentAuditTracker {
  dispatched: boolean;
  tail: Promise<void>;
}

class RoleAuditPersistenceError extends Error {
  public constructor(cause: unknown) {
    super("role audit persistence failed", { cause });
    this.name = "RoleAuditPersistenceError";
  }
}

async function persistAuditIo<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RoleAuditPersistenceError(error);
  }
}

function deferredAuditFallback(property: PropertyKey): unknown {
  if (property === "getRunTrace" || property === "getSessionAgentProfile") {
    return null;
  }
  if (property === "listSessionMessages" || property === "listRunIdsForInteraction") {
    return [];
  }
  return undefined;
}

function boundedAuditStore(
  store: RoleRunAuditOptions["store"],
  signal: AbortSignal | undefined,
  tracker: AssignmentAuditTracker,
): RoleRunAuditOptions["store"] {
  if (signal === undefined) {
    return store;
  }
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: readonly unknown[]) => {
        const operation = async () => await Reflect.apply(value, target, args) as unknown;
        if (!tracker.dispatched) {
          return settleOnAbort(operation, signal);
        }

        // After beginWrite returns, audit I/O must no longer sit on the physical
        // action state machine. Preserve ordering in a deferred queue; the
        // composer finalize phase drains and repairs it under its own budget.
        tracker.tail = tracker.tail.then(
          async () => { await operation(); },
          async () => { await operation(); },
        ).catch(() => undefined);
        return Promise.resolve(deferredAuditFallback(property));
      };
    },
  }) as RoleRunAuditOptions["store"];
}

function assertRoleTraceIdentity(
  trace: RunAuditTrace,
  expected: AssignmentRunResult,
  interaction: UserTextInteraction,
  routePlanId: string,
): void {
  const starts = trace.events.filter((event) => event.type === "role.run.started");
  if (starts.length !== 1) {
    throw new Error("stored role trace must contain exactly one start identity event");
  }
  const payload = starts[0]?.payload;
  const span = payload?.source_span;
  if (
    payload?.interaction_id !== interaction.interaction_id
    || payload.route_plan_id !== routePlanId
    || payload.assignment_id !== expected.assignment.assignment_id
    || payload.role_id !== expected.assignment.role_id
    || span === null
    || typeof span !== "object"
    || Array.isArray(span)
    || (span as { start?: unknown }).start !== expected.assignment.source_span.start
    || (span as { end?: unknown }).end !== expected.assignment.source_span.end
  ) {
    throw new Error("stored role trace identity does not match the current assignment");
  }
}

/**
 * Product-facing Phase 4D composition boundary. Device and transport adapters
 * should enter through this function instead of calling runAssignedRole
 * directly, so bounded scheduling and role-specific sessions cannot be skipped.
 */
export async function runRoleInteraction(
  options: RunRoleInteractionOptions,
): Promise<RunRoleInteractionResult> {
  assertContractId(options.run_id, "run_id");
  (options.cat_run_registry ?? defaultLowPriorityCatRunRegistry).cancelAll("user_interaction");
  if (
    options.timeout_ms !== undefined
    && (!Number.isInteger(options.timeout_ms) || options.timeout_ms < 100 || options.timeout_ms > 600_000)
  ) {
    throw new TypeError("timeout_ms must be an integer between 100 and 600000");
  }
  const auditFinalizeTimeoutMs = options.audit_finalize_timeout_ms ?? 1_000;
  if (
    !Number.isInteger(auditFinalizeTimeoutMs)
    || auditFinalizeTimeoutMs < 100
    || auditFinalizeTimeoutMs > 60_000
  ) {
    throw new TypeError("audit_finalize_timeout_ms must be an integer between 100 and 60000");
  }
  const deadlineSignal = options.timeout_ms === undefined
    ? undefined
    : AbortSignal.timeout(options.timeout_ms);
  const executionSignal = options.signal === undefined
    ? deadlineSignal
    : deadlineSignal === undefined
      ? options.signal
      : AbortSignal.any([options.signal, deadlineSignal]);
  const boundedProvider: Pick<OllamaProvider, "chat"> = {
    chat: async (request, signal) => await settleOnAbort(
      async () => await options.provider.chat(request, signal),
      signal,
    ),
  };
  const routing = await routeInteraction({
    interaction: options.interaction,
    route_plan_id: options.route_plan_id,
    provider: boundedProvider,
    ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    ...(executionSignal === undefined ? {} : { signal: executionSignal }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.human_only === undefined ? {} : { human_only: options.human_only }),
  });
  const auditTrackers: AssignmentAuditTracker[] = [];
  const scheduled = routing.plan.assignments.map(async (assignment, index): Promise<AssignmentRunResult> => {
    const runId = assignmentRunId(options.run_id, index, routing.plan.assignments.length);
    const auditTracker: AssignmentAuditTracker = {
      dispatched: false,
      tail: Promise.resolve(),
    };
    auditTrackers.push(auditTracker);
    const assignmentAudit = options.audit === undefined
      ? undefined
      : {
          ...options.audit,
          store: boundedAuditStore(options.audit.store, executionSignal, auditTracker),
        };
    try {
      const run = await options.scheduler.schedule({
        role_id: assignment.role_id,
        ...(executionSignal === undefined ? {} : { signal: executionSignal }),
        execute: async () => await runAssignedRole({
          run_id: runId,
          interaction: options.interaction,
          plan: routing.plan,
          assignment_id: assignment.assignment_id,
          session: options.sessions.get(assignment.role_id),
          provider: boundedProvider,
          ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
          ...(executionSignal === undefined ? {} : { signal: executionSignal }),
          ...(assignmentAudit === undefined ? {} : { audit: assignmentAudit }),
          ...(options.robot_ha === undefined ? {} : { robot_ha: options.robot_ha }),
          ...(options.memory === undefined ? {} : { memory: options.memory }),
          on_side_effect_dispatched: () => {
            auditTracker.dispatched = true;
          },
        }),
      });
      return {
        assignment,
        run,
      };
    } catch (error) {
      if (error instanceof RoleRunAuditFinalizeError) {
        return { assignment, run: error.result };
      }
      return {
        assignment,
        run: failedScheduledRun(
          runId,
          assignment.role_id,
          error,
          deadlineSignal?.aborted === true,
          executionSignal?.aborted === true,
        ),
      };
    }
  });
  const runs = await Promise.all(scheduled);
  const response = composeRoleResponse(routing.plan, runs);
  const run = runs[0]?.run;
  if (run === undefined) {
    throw new Error("validated route plan produced no assignment runs");
  }

  let compositionAuditRunId: string | null = null;
  let compositionAuditStatus: RunRoleInteractionResult["composition_audit_status"] = "disabled";
  if (options.audit !== undefined) {
    const audit = options.audit;
    const auditRunId = suffixedId(options.run_id, ":compose");
    compositionAuditRunId = auditRunId;
    const persistAudit = async (): Promise<string> => {
      await Promise.all(auditTrackers.map(async (tracker) => await tracker.tail));
      const clockValue = (audit.clock ?? options.clock ?? Date.now)();
    let roleTraces = await Promise.all(
      runs.map(async (item) => await persistAuditIo(
        async () => await audit.store.getRunTrace(item.run.run_id),
      )),
    );
    let syntheticTime = Math.max(
      clockValue,
      roleTraces.reduce((latest, trace) => trace === null
        ? latest
        : Math.max(
            latest,
            trace.run.completed_at_ms ?? trace.run.started_at_ms,
            ...trace.messages.map((message) => message.created_at_ms),
            ...trace.tool_calls.flatMap((call) => [
              call.created_at_ms,
              ...(call.completed_at_ms === null ? [] : [call.completed_at_ms]),
            ]),
            ...trace.actions.map((action) => action.created_at_ms),
            ...trace.events.map((event) => event.occurred_at_ms),
          ), -1) + 1,
    );
    for (const [index, item] of runs.entries()) {
      const existing = roleTraces[index] ?? null;
      if (existing !== null) {
        assertRoleTraceIdentity(
          existing,
          item,
          options.interaction,
          routing.plan.route_plan_id,
        );
      }
      if (existing !== null && !["pending", "running"].includes(existing.run.status)) {
        if (existing.run.status !== item.run.status) {
          throw new Error("stored role terminal status does not match the runtime result");
        }
        continue;
      }
      if (!Number.isSafeInteger(syntheticTime) || syntheticTime > Number.MAX_SAFE_INTEGER - 2) {
        throw new TypeError("synthetic role audit clock exhausted the safe integer range");
      }
      if (existing !== null) {
        const toolResults = existing.tool_calls
          .filter((call) => call.status === "pending")
          .map((call) => {
            const actual = item.run.tool_results.find(
              (result) => result.tool_call_id === call.tool_call_id && result.name === call.name,
            );
            if (actual !== undefined) {
              return actual;
            }
            if (item.run.status === "completed") {
              throw new Error("completed role result is missing a pending audited ToolResult");
            }
            return {
              schema_version: 1,
              tool_call_id: call.tool_call_id,
              name: call.name,
              status: "error",
              result: null,
              error: {
                code: item.run.status === "cancelled"
                  ? "CANCELLED"
                  : item.run.status === "timed_out"
                    ? "DEADLINE_EXCEEDED"
                    : "INTERNAL",
                message: "role audit finalization recovered an unfinished tool call",
                retryable: false,
              },
            } satisfies ToolFailureResult;
          });
        await persistAuditIo(async () => await audit.store.writeBatch({
          messages: item.run.final_text.length === 0 ? [] : [{
            message_id: `${item.run.run_id}:message:recovered-terminal`,
            session_id: existing.run.session_id,
            run_id: item.run.run_id,
            role: "assistant",
            content: item.run.final_text,
            tool_name: null,
            created_at_ms: syntheticTime + 1,
            metadata: { recovered_terminal: true, outcome: item.run.outcome },
          }],
          tool_results: toolResults.map((result) => ({
            run_id: item.run.run_id,
            result,
            completed_at_ms: syntheticTime + 1,
          })),
          actions: existing.actions
            .filter((action) => action.status !== "completed" && action.status !== "failed")
            .map((action) => ({ ...action, status: "failed" as const })),
          events: [{
            event_id: `${item.run.run_id}:event:recovered-terminal`,
            run_id: item.run.run_id,
            type: `role.run.${item.run.status}`,
            occurred_at_ms: syntheticTime + 1,
            payload: {
              interaction_id: options.interaction.interaction_id,
              route_plan_id: routing.plan.route_plan_id,
              assignment_id: item.assignment.assignment_id,
              role_id: item.assignment.role_id,
              status: item.run.status,
              outcome: item.run.outcome,
              error_code: item.run.error?.code ?? null,
              recovered_terminal: true,
            },
          }],
          run: {
            ...existing.run,
            status: item.run.status,
            completed_at_ms: syntheticTime + 2,
          },
        }));
        syntheticTime += 3;
        continue;
      }
      const session = options.sessions.get(item.assignment.role_id);
      const profile = session.profile;
      const profileId = `${profile.revision.replace("/", "-")}:${profile.role_id}`;
      const sessionId = suffixedId(item.run.run_id, ":synthetic-session");
      const inputText = options.interaction.text.slice(
        item.assignment.source_span.start,
        item.assignment.source_span.end,
      );
      await persistAuditIo(async () => await audit.store.saveAgentProfile({
        agent_profile_id: profileId,
        name: `P4 Home ${profile.role_id}`,
        locale: "zh-CN",
        allowed_tools: profile.allowed_tools,
      }));
      await persistAuditIo(async () => await audit.store.saveSession({
        session_id: sessionId,
        agent_profile_id: profileId,
        created_at_ms: syntheticTime,
        updated_at_ms: syntheticTime + 2,
      }));
      await persistAuditIo(async () => await audit.store.writeBatch({
        messages: [{
          message_id: `${item.run.run_id}:message:synthetic`,
          session_id: sessionId,
          run_id: item.run.run_id,
          role: "user",
          content: inputText,
          tool_name: null,
          created_at_ms: syntheticTime + 1,
          metadata: {
            interaction_id: options.interaction.interaction_id,
            route_plan_id: routing.plan.route_plan_id,
            assignment_id: item.assignment.assignment_id,
            role_id: item.assignment.role_id,
            source_span: item.assignment.source_span,
            synthetic: true,
          },
        }],
        events: [{
          event_id: `${item.run.run_id}:event:synthetic-start`,
          run_id: item.run.run_id,
          type: "role.run.started",
          occurred_at_ms: syntheticTime,
          payload: {
            interaction_id: options.interaction.interaction_id,
            route_plan_id: routing.plan.route_plan_id,
            assignment_id: item.assignment.assignment_id,
            role_id: item.assignment.role_id,
            route_reason: routing.plan.reason,
            assignment_mode: item.assignment.mode,
            source_span: item.assignment.source_span,
            synthetic: true,
          },
        }, {
          event_id: `${item.run.run_id}:event:synthetic-terminal`,
          run_id: item.run.run_id,
          type: `role.run.${item.run.status}`,
          occurred_at_ms: syntheticTime + 1,
          payload: {
            interaction_id: options.interaction.interaction_id,
            route_plan_id: routing.plan.route_plan_id,
            assignment_id: item.assignment.assignment_id,
            role_id: item.assignment.role_id,
            status: item.run.status,
            outcome: item.run.outcome,
            error_code: item.run.error?.code ?? null,
            synthetic: true,
          },
        }],
        run: {
          run_id: item.run.run_id,
          session_id: sessionId,
          status: item.run.status,
          started_at_ms: syntheticTime,
          completed_at_ms: syntheticTime + 2,
        },
      }));
      syntheticTime += 3;
    }
    roleTraces = await Promise.all(
      runs.map(async (item) => await persistAuditIo(
        async () => await audit.store.getRunTrace(item.run.run_id),
      )),
    );
    for (const [index, trace] of roleTraces.entries()) {
      if (
        trace === null
        || ["pending", "running"].includes(trace.run.status)
        || trace.run.status !== runs[index]?.run.status
      ) {
        throw new Error("all role audit traces must be terminal before composition");
      }
      assertRoleTraceIdentity(
        trace,
        runs[index] as AssignmentRunResult,
        options.interaction,
        routing.plan.route_plan_id,
      );
    }
    const latestRoleCompletion = roleTraces.reduce((latest, trace) =>
      Math.max(latest, trace?.run.completed_at_ms ?? -1), -1);
    const occurredAtMs = Math.max(clockValue, latestRoleCompletion + 1);
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0 || occurredAtMs > Number.MAX_SAFE_INTEGER - 2) {
      throw new TypeError("composer audit clock must return a usable non-negative safe integer");
    }
    const sessionId = suffixedId(options.run_id, ":composer-session");
    const profileId = "role-composer:v1";
    await persistAuditIo(async () => await audit.store.saveAgentProfile({
      agent_profile_id: profileId,
      name: "P4 Home deterministic response composer",
      locale: "zh-CN",
      allowed_tools: [],
    }));
    await persistAuditIo(async () => await audit.store.saveSession({
      session_id: sessionId,
      agent_profile_id: profileId,
      created_at_ms: occurredAtMs,
      updated_at_ms: occurredAtMs + 2,
    }));
    await persistAuditIo(async () => await audit.store.writeBatch({
      messages: [{
        message_id: `${auditRunId}:message:1`,
        session_id: sessionId,
        run_id: auditRunId,
        role: "assistant",
        content: response.text,
        tool_name: null,
        created_at_ms: occurredAtMs + 1,
        metadata: { schema_version: response.schema_version, status: response.status },
      }],
      events: [{
        event_id: `${auditRunId}:event:0`,
        run_id: auditRunId,
        type: "role.run.started",
        occurred_at_ms: occurredAtMs,
        payload: {
          interaction_id: options.interaction.interaction_id,
          route_plan_id: routing.plan.route_plan_id,
          role_id: "composer",
          assignment_ids: routing.plan.assignments.map((assignment) => assignment.assignment_id),
        },
      }, {
        event_id: `${auditRunId}:event:1`,
        run_id: auditRunId,
        type: "role.interaction.composed",
        occurred_at_ms: occurredAtMs + 1,
        payload: {
          interaction_id: options.interaction.interaction_id,
          route_plan_id: routing.plan.route_plan_id,
          status: response.status,
          text: response.text,
          parts: response.parts,
        },
      }],
      run: {
        run_id: auditRunId,
        session_id: sessionId,
        status: response.status === "completed" ? "completed" : "failed",
        started_at_ms: occurredAtMs,
        completed_at_ms: occurredAtMs + 2,
      },
    }));
      return auditRunId;
    };
    const persistence = persistAudit();
    const auditFinalizeSignal = AbortSignal.timeout(auditFinalizeTimeoutMs);
    try {
      await settleOnAbort(async () => await persistence, auditFinalizeSignal);
      compositionAuditStatus = "persisted";
    } catch (error) {
      if (
        !(error instanceof RoleAuditPersistenceError)
        && (
          !(error instanceof OllamaProviderError)
          || (error.code !== "CANCELLED" && error.code !== "TIMEOUT")
        )
      ) {
        throw error;
      }
      compositionAuditStatus = "deferred";
    }
  }
  if (options.on_task_complete !== undefined) {
    const occurredAtMs = (options.clock ?? Date.now)();
    for (const item of runs) {
      try {
        options.on_task_complete({
          run_id: item.run.run_id,
          role_id: item.assignment.role_id,
          outcome: item.run.status,
          occurred_at_ms: occurredAtMs,
        });
      } catch {
        // A low-priority autonomy observer cannot fail or delay the user response.
      }
    }
  }
  return {
    routing,
    runs,
    response,
    run,
    composition_audit_run_id: compositionAuditRunId,
    composition_audit_status: compositionAuditStatus,
  };
}
