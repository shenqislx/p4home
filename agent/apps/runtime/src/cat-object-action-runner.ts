import {
  getObjectRuntimeToolDefinitions,
  validateObjectRuntimeToolCalls,
  validateObjectRuntimeToolResult,
  type ObjectRuntimeToolDefinition,
  type WorldObjectCapability,
} from "@p4home/contracts";
import type { Action, Event, Run, ToolCall, ToolResult } from "@p4home/core";
import { OllamaProviderError, type OllamaProvider } from "@p4home/provider-ollama";
import type { AuditStore } from "@p4home/storage-sqlite";

import {
  CatObjectEventPolicy,
  type ApprovedCatObjectSitEvent,
  type ApprovedCatObjectStep,
} from "./cat-object-event-policy.ts";
import {
  DeviceWebSocketActionAdapter,
  type DeviceActionOutcome,
} from "./device-action-adapter.ts";
import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import {
  assertRoleToolAuthorization,
  buildRoleContext,
  getRoleProfile,
} from "./role-profiles.ts";
import { RoleScheduler } from "./role-scheduler.ts";

export interface RunCatObjectSitEventOptions {
  readonly event: unknown;
  readonly run_id: string;
  readonly session_id: string;
  readonly session_created_at_ms: number;
  readonly tool_call_ids: readonly [string, string];
  readonly action_ids: readonly [string, string];
  readonly policy: CatObjectEventPolicy;
  readonly scheduler: RoleScheduler;
  readonly adapter: DeviceWebSocketActionAdapter;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly action_timeout_ms?: number;
  readonly wait_timeout_ms?: number;
  readonly model_timeout_ms?: number;
  readonly reconciliation_timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
  readonly audit_store?: AuditStore;
}

export interface CatObjectStepResult {
  readonly index: 0 | 1;
  readonly tool_call_id: string;
  readonly action_id: string;
  readonly tool: ApprovedCatObjectStep["tool"];
  readonly arguments: Readonly<{ readonly target_id: string }>;
  readonly executed: boolean;
  readonly outcome: DeviceActionOutcome;
}

export interface CatObjectActionRunResult {
  readonly run_id: string;
  readonly role_id: "cat";
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly event_id: string;
  readonly model_turns: 1;
  readonly steps: readonly CatObjectStepResult[];
}

const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_TIMEOUT_MIN_MS = 100;
const ACTION_TIMEOUT_MAX_MS = 120_000;

export class CatObjectModelDecisionError extends Error {
  public readonly code = "INVALID_CAT_OBJECT_MODEL_DECISION";

  public constructor(message: string) {
    super(message);
    this.name = "CatObjectModelDecisionError";
  }
}

function assertId(value: string, label: string): void {
  if (!CONTRACT_ID.test(value)) {
    throw new TypeError(`${label} is not a valid contract id`);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validateExecutionOptions(options: RunCatObjectSitEventOptions): void {
  const actionTimeoutMs = options.action_timeout_ms ?? 5_000;
  if (
    !Number.isInteger(actionTimeoutMs)
    || actionTimeoutMs < ACTION_TIMEOUT_MIN_MS
    || actionTimeoutMs > ACTION_TIMEOUT_MAX_MS
  ) {
    throw new RangeError(
      `action_timeout_ms must be between ${ACTION_TIMEOUT_MIN_MS} and ${ACTION_TIMEOUT_MAX_MS}`,
    );
  }
  for (const [name, value] of [
    ["wait_timeout_ms", options.wait_timeout_ms],
    ["model_timeout_ms", options.model_timeout_ms],
    ["reconciliation_timeout_ms", options.reconciliation_timeout_ms],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
}

function projectCapabilities(
  adapter: DeviceWebSocketActionAdapter,
  approved: ApprovedCatObjectSitEvent,
): readonly WorldObjectCapability[] {
  if (adapter.protocol_version !== 2 || !adapter.is_ready) {
    throw new TypeError("Cat object execution requires a ready Device Protocol v2 adapter");
  }
  const capabilities: readonly WorldObjectCapability[] = adapter.object_capabilities.map((object) => ({
    object_id: object.object_id,
    room_id: object.room_id,
    supported_actions: [...object.supported_actions],
    available: object.available,
  }));
  const target = capabilities.find((object) => object.object_id === approved.payload.target_id);
  if (
    target === undefined
    || !target.available
    || !target.supported_actions.includes("go_to")
    || !target.supported_actions.includes("sit")
  ) {
    throw new TypeError("approved Cat object target is absent from the live capability projection");
  }
  return capabilities;
}

function narrowTool(
  definition: ObjectRuntimeToolDefinition,
  targetId: string,
): ObjectRuntimeToolDefinition {
  const parameters = structuredClone(definition.parameters) as Record<string, unknown>;
  const properties = structuredClone(
    (parameters.properties ?? {}) as Record<string, unknown>,
  );
  properties.target_id = { enum: [targetId] };
  parameters.properties = properties;
  return { ...definition, parameters };
}

async function decideObjectSequence(
  options: RunCatObjectSitEventOptions,
  approved: ApprovedCatObjectSitEvent,
  capabilities: readonly WorldObjectCapability[],
): Promise<readonly ToolCall[]> {
  const profile = getRoleProfile("cat");
  const definitions = getObjectRuntimeToolDefinitions();
  const tools = approved.steps.map((step) => {
    const definition = definitions.find((candidate) => candidate.name === step.tool);
    if (definition === undefined) {
      throw new CatObjectModelDecisionError(`Tool Schema v2 is missing ${step.tool}`);
    }
    return narrowTool(definition, approved.payload.target_id);
  });
  const response = await options.provider.chat({
    messages: buildRoleContext(profile, {
      kind: "normalized_event",
      event_type: approved.event_type,
      payload: {
        target_id: approved.payload.target_id,
        objects: capabilities,
      },
    }),
    tools: tools.map((tool) => ({ type: "function" as const, function: tool })),
    options: {
      temperature: profile.temperature,
      num_ctx: profile.num_ctx,
      num_predict: profile.num_predict,
    },
    think: QWEN_THINKING_ENABLED,
    ...(options.model_timeout_ms === undefined ? {} : { timeout_ms: options.model_timeout_ms }),
  }, options.signal);
  if ((response.message.thinking?.trim().length ?? 0) > 0) {
    throw new CatObjectModelDecisionError("Cat model returned forbidden thinking content");
  }
  const calls = validateObjectRuntimeToolCalls(
    (response.message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  );
  if (calls.length !== 2) {
    throw new CatObjectModelDecisionError("Cat model must return exactly two object tool calls");
  }
  assertRoleToolAuthorization(profile, calls.map((call) => call.name));
  for (const [index, call] of calls.entries()) {
    const expected = approved.steps[index]!;
    if (
      call.name !== expected.tool
      || Object.keys(call.arguments).length !== 1
      || call.arguments.target_id !== approved.payload.target_id
    ) {
      throw new CatObjectModelDecisionError(
        "Cat model object sequence does not match the policy-approved plan",
      );
    }
  }
  return calls.map((call, index) => ({
    tool_call_id: options.tool_call_ids[index]!,
    name: call.name,
    arguments: structuredClone(call.arguments),
  }));
}

function outcomeStatus(outcome: DeviceActionOutcome): CatObjectActionRunResult["status"] {
  if (outcome.status === "completed") {
    return "completed";
  }
  if (outcome.status === "failed" && outcome.error.code === "CANCELLED") {
    return "cancelled";
  }
  if (outcome.status === "unknown" && outcome.reason === "wait_timeout") {
    return "timed_out";
  }
  return "failed";
}

function skippedOutcome(actionId: string, previous: DeviceActionOutcome): DeviceActionOutcome {
  return {
    status: "failed",
    action_id: actionId,
    error: {
      code: "CANCELLED",
      message: "object sequence stopped after the previous step did not complete",
      retryable: false,
      details: {
        skipped: true,
        dependency_outcome: previous.status,
        replay_allowed: false,
      },
    },
  };
}

function cancelledBeforeDispatchOutcome(actionId: string): DeviceActionOutcome {
  return {
    status: "failed",
    action_id: actionId,
    error: {
      code: "CANCELLED",
      message: "object sequence was cancelled before device dispatch",
      retryable: false,
      details: { skipped: true, replay_allowed: false },
    },
  };
}

function internalOutcome(actionId: string, error: unknown): DeviceActionOutcome {
  const sourceCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "INTERNAL";
  return {
    status: "failed",
    action_id: actionId,
    error: {
      code: "INTERNAL",
      message: "Cat object action failed before a terminal device outcome",
      retryable: error instanceof OllamaProviderError ? error.retryable : false,
      details: { source_error_code: sourceCode },
    },
  };
}

function asToolResult(step: CatObjectStepResult): ToolResult {
  const result: ToolResult = step.outcome.status === "completed"
    ? {
        schema_version: 2,
        tool_call_id: step.tool_call_id,
        name: step.tool,
        status: "success",
        result: structuredClone(step.outcome.result),
        error: null,
      }
    : step.outcome.status === "failed"
      ? {
          schema_version: 2,
          tool_call_id: step.tool_call_id,
          name: step.tool,
          status: "error",
          result: null,
          error: structuredClone(step.outcome.error),
        }
      : {
          schema_version: 2,
          tool_call_id: step.tool_call_id,
          name: step.tool,
          status: "error",
          result: null,
          error: {
            code: "DEVICE_OFFLINE",
            message: "device object action outcome is unknown",
            retryable: true,
            details: {
              outcome: "unknown",
              reason: step.outcome.reason,
              replay_allowed: false,
              reconciliation: step.outcome.reconciliation,
            },
          },
        };
  return validateObjectRuntimeToolResult(result) as ToolResult;
}

async function auditStart(
  options: RunCatObjectSitEventOptions,
  approved: ApprovedCatObjectSitEvent,
  capabilities: readonly WorldObjectCapability[],
  startedAtMs: number,
): Promise<void> {
  const store = options.audit_store;
  if (store === undefined) {
    return;
  }
  const profile = getRoleProfile("cat");
  const profileId = `${profile.revision}:cat`;
  await store.saveAgentProfile({
    agent_profile_id: profileId,
    name: "P4 Home cat",
    locale: "zh-CN",
    allowed_tools: profile.allowed_tools,
  });
  await store.saveSession({
    session_id: options.session_id,
    agent_profile_id: profileId,
    created_at_ms: options.session_created_at_ms,
    updated_at_ms: startedAtMs,
  });
  await store.writeBatch({
    run: {
      run_id: options.run_id,
      session_id: options.session_id,
      status: "running",
      started_at_ms: startedAtMs,
      completed_at_ms: null,
    },
    events: [{
      event_id: `${options.run_id}:event:1`,
      run_id: options.run_id,
      type: "cat.object.run.started",
      occurred_at_ms: startedAtMs,
      payload: {
        source_event_id: approved.event_id,
        event_type: approved.event_type,
        event_source: approved.source,
        target_id: approved.payload.target_id,
        policy_approved_at_ms: approved.approved_at_ms,
        capability_projection: structuredClone(capabilities),
        role_id: "cat",
        model_turns: 1,
      },
    }],
  });
}

async function auditModelCalls(
  options: RunCatObjectSitEventOptions,
  calls: readonly ToolCall[],
  occurredAtMs: number,
): Promise<void> {
  if (options.audit_store === undefined) {
    return;
  }
  await options.audit_store.writeBatch({
    tool_calls: calls.map((call) => ({
      run_id: options.run_id,
      call,
      created_at_ms: occurredAtMs,
    })),
    events: [{
      event_id: `${options.run_id}:event:2`,
      run_id: options.run_id,
      type: "cat.object.model.completed",
      occurred_at_ms: occurredAtMs,
      payload: {
        role_id: "cat",
        model_turn: 1,
        tool_call_ids: calls.map((call) => call.tool_call_id),
        tools: calls.map((call) => call.name),
      },
    }],
  });
}

async function auditActionRequested(
  options: RunCatObjectSitEventOptions,
  index: 0 | 1,
  occurredAtMs: number,
): Promise<void> {
  if (options.audit_store === undefined) {
    return;
  }
  await options.audit_store.saveAction({
    action_id: options.action_ids[index],
    run_id: options.run_id,
    tool_call_id: options.tool_call_ids[index],
    status: "requested",
    created_at_ms: occurredAtMs,
  });
}

async function auditFinish(
  options: RunCatObjectSitEventOptions,
  approved: ApprovedCatObjectSitEvent,
  status: CatObjectActionRunResult["status"],
  steps: readonly CatObjectStepResult[],
  startedAtMs: number,
  completedAtMs: number,
  actionCreatedAt: ReadonlyMap<number, number>,
  modelCallsAudited: boolean,
): Promise<void> {
  const store = options.audit_store;
  if (store === undefined) {
    return;
  }
  const run: Run = {
    run_id: options.run_id,
    session_id: options.session_id,
    status,
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
  };
  const actions: Action[] = steps
    .filter((step) => step.executed)
    .map((step) => ({
      action_id: step.action_id,
      run_id: options.run_id,
      tool_call_id: step.tool_call_id,
      status: step.outcome.status === "completed" ? "completed" : "failed",
      created_at_ms: actionCreatedAt.get(step.index) ?? startedAtMs,
    }));
  const event: Event = {
    event_id: `${options.run_id}:event:${modelCallsAudited ? 3 : 2}`,
    run_id: options.run_id,
    type: `cat.object.run.${status}`,
    occurred_at_ms: completedAtMs,
    payload: {
      source_event_id: approved.event_id,
      target_id: approved.payload.target_id,
      step_outcomes: steps.map((step) => ({
        index: step.index,
        tool_call_id: step.tool_call_id,
        action_id: step.action_id,
        tool: step.tool,
        executed: step.executed,
        outcome: step.outcome.status,
        error_code: step.outcome.status === "failed" ? step.outcome.error.code : null,
        replay_allowed: step.outcome.status === "unknown" ? false : null,
        reconciliation: step.outcome.status === "unknown"
          ? step.outcome.reconciliation
          : null,
      })),
    },
  };
  await store.writeBatch({
    tool_results: steps.map((step) => ({
      run_id: options.run_id,
      result: asToolResult(step),
      completed_at_ms: completedAtMs,
    })),
    actions,
    events: [event],
    run,
  });
}

/**
 * Phase 3C product boundary. Policy approval precedes scheduler admission,
 * model work, audit Run creation, and all WebSocket output. The two approved
 * actions execute in order and the second action is never dispatched unless
 * the first has an explicit completed lifecycle.
 */
export async function runCatObjectSitEvent(
  options: RunCatObjectSitEventOptions,
): Promise<CatObjectActionRunResult> {
  for (const [label, value] of [
    ["run_id", options.run_id],
    ["session_id", options.session_id],
    ["tool_call_ids[0]", options.tool_call_ids[0]],
    ["tool_call_ids[1]", options.tool_call_ids[1]],
    ["action_ids[0]", options.action_ids[0]],
    ["action_ids[1]", options.action_ids[1]],
  ] as const) {
    assertId(value, label);
  }
  if (new Set(options.tool_call_ids).size !== 2 || new Set(options.action_ids).size !== 2) {
    throw new TypeError("Cat object tool_call_ids and action_ids must be unique");
  }
  validateExecutionOptions(options);
  const approved = options.policy.approve(options.event);
  const clock = options.clock ?? Date.now;
  return await options.scheduler.schedule({
    role_id: "cat",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    execute: async () => {
      const startedAtMs = clock();
      let capabilities: readonly WorldObjectCapability[] = [];
      let calls: readonly ToolCall[] = [];
      const steps: CatObjectStepResult[] = [];
      const actionCreatedAt = new Map<number, number>();
      let modelCallsAudited = false;
      let cancelledDuringReconciliation = false;
      let status: CatObjectActionRunResult["status"] = "failed";
      try {
        capabilities = projectCapabilities(options.adapter, approved);
        await auditStart(options, approved, capabilities, startedAtMs);
        calls = await decideObjectSequence(options, approved, capabilities);
        const modelCompletedAtMs = Math.max(startedAtMs, clock());
        await auditModelCalls(options, calls, modelCompletedAtMs);
        modelCallsAudited = true;

        for (const rawIndex of [0, 1] as const) {
          const approvedStep = approved.steps[rawIndex];
          const previous = steps[rawIndex - 1];
          if (previous !== undefined && previous.outcome.status !== "completed") {
            steps.push({
              index: rawIndex,
              tool_call_id: options.tool_call_ids[rawIndex],
              action_id: options.action_ids[rawIndex],
              tool: approvedStep.tool,
              arguments: approvedStep.arguments,
              executed: false,
              outcome: skippedOutcome(options.action_ids[rawIndex], previous.outcome),
            });
            break;
          }
          if (isAborted(options.signal)) {
            steps.push({
              index: rawIndex,
              tool_call_id: options.tool_call_ids[rawIndex],
              action_id: options.action_ids[rawIndex],
              tool: approvedStep.tool,
              arguments: approvedStep.arguments,
              executed: false,
              outcome: cancelledBeforeDispatchOutcome(options.action_ids[rawIndex]),
            });
            continue;
          }
          const requestedAtMs = Math.max(startedAtMs, clock());
          actionCreatedAt.set(rawIndex, requestedAtMs);
          await auditActionRequested(options, rawIndex, requestedAtMs);
          let outcome: DeviceActionOutcome;
          try {
            outcome = await options.adapter.executeAction({
              action_id: options.action_ids[rawIndex],
              tool: approvedStep.tool,
              arguments: structuredClone(approvedStep.arguments),
              timeout_ms: options.action_timeout_ms ?? 5_000,
              origin: "autonomy",
              ...(options.wait_timeout_ms === undefined
                ? {}
                : { wait_timeout_ms: options.wait_timeout_ms }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            if (outcome.status === "unknown") {
              outcome = await options.adapter.waitForReconciliation(
                options.action_ids[rawIndex],
                options.reconciliation_timeout_ms ?? 5_000,
                options.signal,
              );
              cancelledDuringReconciliation = outcome.status === "unknown"
                && isAborted(options.signal);
            }
          } catch (error) {
            outcome = internalOutcome(options.action_ids[rawIndex], error);
          }
          steps.push({
            index: rawIndex,
            tool_call_id: options.tool_call_ids[rawIndex],
            action_id: options.action_ids[rawIndex],
            tool: approvedStep.tool,
            arguments: approvedStep.arguments,
            executed: true,
            outcome,
          });
        }
        status = cancelledDuringReconciliation
          ? "cancelled"
          : steps.every((step) => step.outcome.status === "completed")
            ? "completed"
            : outcomeStatus(steps.find((step) => step.outcome.status !== "completed")!.outcome);
      } catch (error) {
        if (error instanceof OllamaProviderError) {
          status = error.code === "CANCELLED"
            ? "cancelled"
            : error.code === "TIMEOUT"
              ? "timed_out"
              : "failed";
        } else if (options.signal?.aborted === true) {
          status = "cancelled";
        }
        if (modelCallsAudited) {
          for (const rawIndex of [0, 1] as const) {
            if (steps.some((step) => step.index === rawIndex)) {
              continue;
            }
            const approvedStep = approved.steps[rawIndex];
            const previous = steps[rawIndex - 1];
            steps.push({
              index: rawIndex,
              tool_call_id: options.tool_call_ids[rawIndex],
              action_id: options.action_ids[rawIndex],
              tool: approvedStep.tool,
              arguments: approvedStep.arguments,
              executed: false,
              outcome: previous !== undefined && previous.outcome.status !== "completed"
                ? skippedOutcome(options.action_ids[rawIndex], previous.outcome)
                : internalOutcome(options.action_ids[rawIndex], error),
            });
          }
        }
        if (capabilities.length === 0) {
          capabilities = options.adapter.object_capabilities.map((object) => ({
            object_id: object.object_id,
            room_id: object.room_id,
            supported_actions: [...object.supported_actions],
            available: object.available,
          }));
          await auditStart(options, approved, capabilities, startedAtMs);
        }
      }
      const completedAtMs = Math.max(startedAtMs, clock());
      await auditFinish(
        options,
        approved,
        status,
        steps,
        startedAtMs,
        completedAtMs,
        actionCreatedAt,
        modelCallsAudited,
      );
      return {
        run_id: options.run_id,
        role_id: "cat",
        status,
        event_id: approved.event_id,
        model_turns: 1,
        steps,
      };
    },
  });
}
