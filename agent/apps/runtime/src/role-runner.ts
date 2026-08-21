import {
  OllamaProviderError,
  type OllamaProvider,
} from "@p4home/provider-ollama";
import type { ToolResult } from "@p4home/core";

import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import {
  RoleRunAuditTrail,
  type RoleRunAuditOptions,
} from "./role-audit.ts";
import {
  assertContractId,
  type RoutePlan,
  type UserTextInteraction,
  validateRoutePlan,
  validateUserTextInteraction,
} from "./role-contracts.ts";
import {
  assertRoleToolAuthorization,
  buildRoleContext,
  type RoleInput,
} from "./role-profiles.ts";
import {
  runRobotHaRead,
  type RobotHaReadRuntime,
} from "./robot-ha-read-runner.ts";
import {
  runRobotHaWrite,
  type RobotHaWriteRuntime,
} from "./robot-ha-write-runner.ts";
import { assessHumanResponsePolicy } from "./role-response-policy.ts";
import type { RoleSession } from "./role-session.ts";

export const ROBOT_CAPABILITY_UNAVAILABLE_TEXT =
  "家居控制能力将在 Phase 4 上线；这次没有执行任何设备动作。";

export interface RunAssignedRoleOptions {
  readonly run_id: string;
  readonly interaction: UserTextInteraction;
  readonly plan: RoutePlan;
  readonly session: RoleSession;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: RoleRunAuditOptions;
  readonly robot_ha?: RobotHaReadRuntime | RobotHaWriteRuntime;
}

export interface RoleRunError {
  readonly source: "runtime" | "provider" | "model" | "tool";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RoleRunResult {
  readonly run_id: string;
  readonly role_id: "human" | "robot";
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly final_text: string;
  readonly model_turns: 0 | 1;
  readonly capability_available: boolean;
  readonly outcome: "response" | "capability_unavailable" | "error";
  readonly tool_results: readonly ToolResult[];
  readonly error: RoleRunError | null;
}

type UserTextRoleInput = Extract<RoleInput, { readonly kind: "user_text" }>;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isWriteRuntime(
  runtime: RobotHaReadRuntime | RobotHaWriteRuntime,
): runtime is RobotHaWriteRuntime {
  return typeof (runtime.client as { beginWrite?: unknown }).beginWrite === "function"
    && typeof (runtime.client as { onState?: unknown }).onState === "function"
    && typeof (runtime.client as { onObservation?: unknown }).onObservation === "function"
    && typeof (runtime.client as { reconcileState?: unknown }).reconcileState === "function";
}

function roleInput(options: RunAssignedRoleOptions): UserTextRoleInput {
  const assignment = options.plan.assignments[0];
  return {
    kind: "user_text",
    text: options.interaction.text,
    source_span: assignment.source_span,
    mode: assignment.mode,
  };
}

function failure(
  options: RunAssignedRoleOptions,
  roleId: "human" | "robot",
  status: Extract<RoleRunResult["status"], "failed" | "cancelled" | "timed_out">,
  error: RoleRunError,
  modelTurns: 0 | 1,
  toolResults: readonly ToolResult[] = [],
): RoleRunResult {
  return {
    run_id: options.run_id,
    role_id: roleId,
    status,
    final_text: "",
    model_turns: modelTurns,
    capability_available: roleId === "human",
    outcome: "error",
    tool_results: toolResults,
    error,
  };
}

function validateOptions(options: RunAssignedRoleOptions): "human" | "robot" {
  assertContractId(options.run_id, "run_id");
  validateUserTextInteraction(options.interaction);
  validateRoutePlan(options.plan, options.interaction);
  const roleId = options.plan.assignments[0].role_id;
  if (options.session.role_id !== roleId) {
    throw new TypeError(
      `assignment for ${roleId} cannot execute in ${options.session.role_id} session`,
    );
  }
  if (
    options.timeout_ms !== undefined
    && (!Number.isInteger(options.timeout_ms) || options.timeout_ms < 100 || options.timeout_ms > 600_000)
  ) {
    throw new TypeError("timeout_ms must be an integer between 100 and 600000");
  }
  return roleId;
}

async function executeAssignedRole(
  options: RunAssignedRoleOptions,
  roleId: "human" | "robot",
  input: UserTextRoleInput,
  audit: RoleRunAuditTrail | undefined,
): Promise<RoleRunResult> {
  if (isAborted(options.signal)) {
    return failure(options, roleId, "cancelled", {
      source: "runtime",
      code: "CANCELLED",
      message: "role run was cancelled before execution",
      retryable: false,
    }, 0);
  }

  if (roleId === "robot") {
    if (options.robot_ha !== undefined) {
      const context = buildRoleContext(options.session.profile, input);
      let execution;
      if (isWriteRuntime(options.robot_ha)) {
        assertRoleToolAuthorization(options.session.profile, [
          "home.get_entity",
          "home.turn_on",
          "home.turn_off",
          "home.activate_scene",
        ]);
        execution = await runRobotHaWrite({
          run_id: options.run_id,
          messages: context,
          profile: options.session.profile,
          provider: options.provider,
          client: options.robot_ha.client,
          ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
          ...(options.robot_ha.observation_timeout_ms === undefined
            ? {}
            : { observation_timeout_ms: options.robot_ha.observation_timeout_ms }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(audit === undefined ? {} : { audit }),
        });
      } else {
        assertRoleToolAuthorization(options.session.profile, ["home.get_entity"]);
        execution = await runRobotHaRead({
          run_id: options.run_id,
          messages: context,
          profile: options.session.profile,
          provider: options.provider,
          runtime: options.robot_ha,
          ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(audit === undefined ? {} : { audit }),
        });
      }
      return {
        run_id: options.run_id,
        role_id: "robot",
        ...execution,
      };
    }
    return {
      run_id: options.run_id,
      role_id: "robot",
      status: "completed",
      final_text: ROBOT_CAPABILITY_UNAVAILABLE_TEXT,
      model_turns: 0,
      capability_available: false,
      outcome: "capability_unavailable",
      tool_results: [],
      error: null,
    };
  }

  const profile = options.session.profile;
  let response;
  try {
    response = await options.provider.chat({
      messages: options.session.buildContext(input),
      options: {
        temperature: profile.temperature,
        num_ctx: profile.num_ctx,
        num_predict: profile.num_predict,
      },
      think: QWEN_THINKING_ENABLED,
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    }, options.signal);
  } catch (error) {
    if (error instanceof OllamaProviderError) {
      const status = error.code === "CANCELLED"
        ? "cancelled"
        : error.code === "TIMEOUT"
          ? "timed_out"
          : "failed";
      return failure(options, "human", status, {
        source: "provider",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }, 1);
    }
    return failure(options, "human", "failed", {
      source: "provider",
      code: "UNEXPECTED_PROVIDER_ERROR",
      message: "Human provider failed unexpectedly",
      retryable: false,
    }, 1);
  }

  if (isAborted(options.signal)) {
    return failure(options, "human", "cancelled", {
      source: "runtime",
      code: "CANCELLED",
      message: "role run was cancelled while waiting for the model",
      retryable: false,
    }, 1);
  }
  if (
    (response.message.tool_calls?.length ?? 0) > 0
    || (response.message.thinking?.trim().length ?? 0) > 0
  ) {
    return failure(options, "human", "failed", {
      source: "model",
      code: "ROLE_POLICY_VIOLATION",
      message: "Human returned tool calls or thinking content",
      retryable: true,
    }, 1);
  }
  const finalText = response.message.content.trim();
  if (finalText.length === 0 || finalText.length > 8_192) {
    return failure(options, "human", "failed", {
      source: "model",
      code: finalText.length === 0 ? "EMPTY_MODEL_RESPONSE" : "MODEL_RESPONSE_TOO_LONG",
      message: finalText.length === 0
        ? "Human returned an empty response"
        : "Human response exceeded 8192 characters",
      retryable: true,
    }, 1);
  }
  const policy = assessHumanResponsePolicy(finalText, input.mode);
  if (!policy.compliant) {
    return failure(options, "human", "failed", {
      source: "model",
      code: "ROLE_POLICY_VIOLATION",
      message: `Human response violated policy: ${policy.violation ?? "UNKNOWN"}`,
      retryable: true,
    }, 1);
  }
  return {
    run_id: options.run_id,
    role_id: "human",
    status: "completed",
    final_text: finalText,
    model_turns: 1,
    capability_available: true,
    outcome: "response",
    tool_results: [],
    error: null,
  };
}

export async function runAssignedRole(
  options: RunAssignedRoleOptions,
): Promise<RoleRunResult> {
  const roleId = validateOptions(options);
  const input = roleInput(options);
  return await options.session.runExclusive(async () => {
    const audit = options.audit === undefined
      ? undefined
      : new RoleRunAuditTrail(
          options.run_id,
          options.interaction,
          options.plan,
          options.session,
          options.audit,
        );
    await audit?.start(input);
    let result: RoleRunResult;
    try {
      result = await executeAssignedRole(options, roleId, input, audit);
    } catch (error) {
      try {
        await audit?.fail(error);
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          "role run failed and its audit trail could not be finalized",
        );
      }
      throw error;
    }
    await audit?.finish(result);
    if (
      result.status === "completed"
      && (roleId === "human" || options.robot_ha === undefined)
    ) {
      options.session.commitExchange(input, result.final_text);
    }
    return result;
  });
}
