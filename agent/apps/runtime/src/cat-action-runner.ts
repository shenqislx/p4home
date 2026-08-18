import {
  getFrozenToolDefinitions,
  validateFrozenToolCalls,
} from "@p4home/contracts";
import type { Action, Event, Run, ToolResult } from "@p4home/core";
import {
  OllamaProviderError,
  type OllamaProvider,
} from "@p4home/provider-ollama";
import type { AuditStore } from "@p4home/storage-sqlite";

import {
  CatEventPolicy,
  type ApprovedCatRoomTargetEvent,
} from "./cat-event-policy.ts";
import {
  DeviceWebSocketActionAdapter,
  type DeviceActionOutcome,
} from "./device-action-adapter.ts";
import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import {
  CAT_WORLD_TOOLS,
  assertRoleToolAuthorization,
  buildRoleContext,
  getRoleProfile,
} from "./role-profiles.ts";
import { RoleScheduler } from "./role-scheduler.ts";

export interface RunCatRoomTargetEventOptions {
  readonly event: unknown;
  readonly run_id: string;
  readonly session_id: string;
  readonly session_created_at_ms: number;
  readonly tool_call_id: string;
  readonly action_id: string;
  readonly policy: CatEventPolicy;
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

export interface CatActionRunResult {
  readonly run_id: string;
  readonly role_id: "cat";
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly event_id: string;
  readonly tool_call_id: string;
  readonly action_id: string;
  readonly model_turns: 1;
  readonly outcome: DeviceActionOutcome;
}

const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CatModelDecisionError extends Error {
  public readonly code = "INVALID_CAT_MODEL_DECISION";

  public constructor(message: string) {
    super(message);
    this.name = "CatModelDecisionError";
  }
}

function assertId(value: string, label: string): void {
  if (!CONTRACT_ID.test(value)) {
    throw new TypeError(`${label} is not a valid contract id`);
  }
}

function runStatus(outcome: DeviceActionOutcome): CatActionRunResult["status"] {
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

function toolResult(
  toolCallId: string,
  outcome: DeviceActionOutcome,
): ToolResult {
  if (outcome.status === "completed") {
    return {
      schema_version: 1,
      tool_call_id: toolCallId,
      name: outcome.tool,
      status: "success",
      result: structuredClone(outcome.result),
      error: null,
    };
  }
  if (outcome.status === "failed") {
    return {
      schema_version: 1,
      tool_call_id: toolCallId,
      name: "character.go_to_room",
      status: "error",
      result: null,
      error: structuredClone(outcome.error),
    };
  }
  return {
    schema_version: 1,
    tool_call_id: toolCallId,
    name: "character.go_to_room",
    status: "error",
    result: null,
    error: {
      code: "DEVICE_OFFLINE",
      message: "device action outcome is unknown",
      retryable: true,
      details: {
        outcome: "unknown",
        reason: outcome.reason,
        replay_allowed: false,
        reconciliation: outcome.reconciliation,
      },
    },
  };
}

async function auditStart(
  options: RunCatRoomTargetEventOptions,
  approved: ApprovedCatRoomTargetEvent,
  startedAtMs: number,
): Promise<void> {
  const store = options.audit_store;
  if (store === undefined) {
    return;
  }
  await store.saveAgentProfile({
    agent_profile_id: "role-profile-v1:cat",
    name: "P4 Home cat",
    locale: "zh-CN",
    allowed_tools: CAT_WORLD_TOOLS,
  });
  await store.saveSession({
    session_id: options.session_id,
    agent_profile_id: "role-profile-v1:cat",
    created_at_ms: options.session_created_at_ms,
    updated_at_ms: startedAtMs,
  });
  const run: Run = {
    run_id: options.run_id,
    session_id: options.session_id,
    status: "running",
    started_at_ms: startedAtMs,
    completed_at_ms: null,
  };
  const event: Event = {
    event_id: `${options.run_id}:event:1`,
    run_id: options.run_id,
    type: "cat.run.started",
    occurred_at_ms: startedAtMs,
    payload: {
      source_event_id: approved.event_id,
      event_type: approved.event_type,
      event_source: approved.source,
      room_target: approved.payload.room_target,
      policy_approved_at_ms: approved.approved_at_ms,
      role_id: "cat",
      model_turns: 1,
    },
  };
  await store.writeBatch({
    run,
    events: [event],
  });
}

async function auditToolRequested(
  options: RunCatRoomTargetEventOptions,
  approved: ApprovedCatRoomTargetEvent,
  occurredAtMs: number,
): Promise<void> {
  const store = options.audit_store;
  if (store === undefined) {
    return;
  }
  const action: Action = {
    action_id: options.action_id,
    run_id: options.run_id,
    tool_call_id: options.tool_call_id,
    status: "requested",
    created_at_ms: occurredAtMs,
  };
  await store.writeBatch({
    tool_calls: [{
      run_id: options.run_id,
      call: {
        tool_call_id: options.tool_call_id,
        name: approved.tool,
        arguments: structuredClone(approved.arguments),
      },
      created_at_ms: occurredAtMs,
    }],
    actions: [action],
    events: [{
      event_id: `${options.run_id}:event:2`,
      run_id: options.run_id,
      type: "cat.model.completed",
      occurred_at_ms: occurredAtMs,
      payload: {
        role_id: "cat",
        model_turn: 1,
        tool_call_id: options.tool_call_id,
        tool: approved.tool,
      },
    }],
  });
}

async function auditFinish(
  options: RunCatRoomTargetEventOptions,
  result: CatActionRunResult,
  startedAtMs: number,
  completedAtMs: number,
  toolRequested: boolean,
  actionCreatedAtMs: number,
): Promise<void> {
  const store = options.audit_store;
  if (store === undefined) {
    return;
  }
  const action: Action = {
    action_id: options.action_id,
    run_id: options.run_id,
    tool_call_id: options.tool_call_id,
    status: result.outcome.status === "completed" ? "completed" : "failed",
    created_at_ms: actionCreatedAtMs,
  };
  const run: Run = {
    run_id: options.run_id,
    session_id: options.session_id,
    status: result.status,
    started_at_ms: startedAtMs,
    completed_at_ms: completedAtMs,
  };
  const event: Event = {
    event_id: `${options.run_id}:event:3`,
    run_id: options.run_id,
    type: `cat.run.${result.status}`,
    occurred_at_ms: completedAtMs,
    payload: {
      source_event_id: result.event_id,
      role_id: "cat",
      tool_call_id: result.tool_call_id,
      action_id: result.action_id,
      action_outcome: result.outcome.status,
      action_source: result.outcome.status === "completed" ? result.outcome.source : null,
      replay_allowed: result.outcome.status === "unknown" ? false : null,
      reconciliation: result.outcome.status === "unknown"
        ? result.outcome.reconciliation
        : null,
    },
  };
  await store.writeBatch({
    tool_results: toolRequested ? [{
      run_id: options.run_id,
      result: toolResult(options.tool_call_id, result.outcome),
      completed_at_ms: completedAtMs,
    }] : [],
    actions: toolRequested ? [action] : [],
    events: [event],
    run,
  });
}

async function decideCatAction(
  options: RunCatRoomTargetEventOptions,
  approved: ApprovedCatRoomTargetEvent,
): Promise<void> {
  const profile = getRoleProfile("cat");
  const tool = getFrozenToolDefinitions().find((definition) => definition.name === approved.tool);
  if (tool === undefined) {
    throw new CatModelDecisionError(`frozen tool ${approved.tool} is unavailable`);
  }
  const response = await options.provider.chat({
    messages: buildRoleContext(profile, {
      kind: "normalized_event",
      event_type: approved.event_type,
      payload: approved.payload,
    }),
    tools: [{ type: "function", function: tool }],
    options: {
      temperature: profile.temperature,
      num_ctx: profile.num_ctx,
      num_predict: profile.num_predict,
    },
    think: QWEN_THINKING_ENABLED,
    ...(options.model_timeout_ms === undefined ? {} : { timeout_ms: options.model_timeout_ms }),
  }, options.signal);
  if ((response.message.thinking?.trim().length ?? 0) > 0) {
    throw new CatModelDecisionError("Cat model returned forbidden thinking content");
  }
  const calls = validateFrozenToolCalls(
    (response.message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  );
  if (calls.length !== 1) {
    throw new CatModelDecisionError("Cat model must return exactly one tool call");
  }
  const call = calls[0]!;
  assertRoleToolAuthorization(profile, [call.name]);
  if (
    call.name !== approved.tool
    || Object.keys(call.arguments).length !== 1
    || call.arguments.room_id !== approved.arguments.room_id
  ) {
    throw new CatModelDecisionError("Cat model tool call does not match the approved event");
  }
}

/**
 * Product-facing Phase 2B boundary. Policy approval is deliberately performed
 * before scheduler admission, Run creation, model work, or WebSocket output.
 * The approved test event maps to one fixed Cat tool; no user text is retained.
 */
export async function runCatRoomTargetEvent(
  options: RunCatRoomTargetEventOptions,
): Promise<CatActionRunResult> {
  for (const [label, value] of [
    ["run_id", options.run_id],
    ["session_id", options.session_id],
    ["tool_call_id", options.tool_call_id],
    ["action_id", options.action_id],
  ] as const) {
    assertId(value, label);
  }
  const approved = options.policy.approve(options.event);
  const clock = options.clock ?? Date.now;
  return await options.scheduler.schedule({
    role_id: "cat",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    execute: async () => {
      const startedAtMs = clock();
      await auditStart(options, approved, startedAtMs);
      let outcome: DeviceActionOutcome;
      let statusOverride: CatActionRunResult["status"] | undefined;
      let toolRequested = false;
      let actionCreatedAtMs = startedAtMs;
      try {
        await decideCatAction(options, approved);
        actionCreatedAtMs = Math.max(startedAtMs, clock());
        await auditToolRequested(options, approved, actionCreatedAtMs);
        toolRequested = true;
        outcome = await options.adapter.executeAction({
          action_id: options.action_id,
          tool: approved.tool,
          arguments: structuredClone(approved.arguments),
          timeout_ms: options.action_timeout_ms ?? 5_000,
          origin: "autonomy",
          ...(options.wait_timeout_ms === undefined ? {} : { wait_timeout_ms: options.wait_timeout_ms }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (outcome.status === "unknown") {
          outcome = await options.adapter.waitForReconciliation(
            options.action_id,
            options.reconciliation_timeout_ms ?? 5_000,
            options.signal,
          );
          if (options.signal?.aborted === true) {
            statusOverride = "cancelled";
          }
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "INTERNAL";
        if (error instanceof OllamaProviderError) {
          statusOverride = error.code === "CANCELLED"
            ? "cancelled"
            : error.code === "TIMEOUT"
              ? "timed_out"
              : "failed";
        } else if (options.signal?.aborted === true) {
          statusOverride = "cancelled";
        }
        outcome = {
          status: "failed",
          action_id: options.action_id,
          error: {
            code: "INTERNAL",
            message: toolRequested
              ? "Cat action adapter failed before a terminal device outcome"
              : "Cat model decision failed before device execution",
            retryable: error instanceof OllamaProviderError ? error.retryable : false,
            details: {
              source: toolRequested ? "adapter" : "model",
              source_error_code: code,
            },
          },
        };
      }
      const result: CatActionRunResult = {
        run_id: options.run_id,
        role_id: "cat",
        status: statusOverride ?? runStatus(outcome),
        event_id: approved.event_id,
        tool_call_id: options.tool_call_id,
        action_id: options.action_id,
        model_turns: 1,
        outcome,
      };
      await auditFinish(
        options,
        result,
        startedAtMs,
        Math.max(startedAtMs, clock()),
        toolRequested,
        actionCreatedAtMs,
      );
      return result;
    },
  });
}
