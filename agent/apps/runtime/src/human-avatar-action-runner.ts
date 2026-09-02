import {
  getHumanAvatarToolDefinitions,
  validateHumanAvatarToolCalls,
  validateHumanAvatarToolResult,
} from "@p4home/contracts";
import type { ToolCall, ToolResult } from "@p4home/core";
import type { OllamaProvider } from "@p4home/provider-ollama";
import { ROOM_IDS, type RoomId } from "@p4home/domain-p4home";

import type {
  DeviceActionOutcome,
  DeviceToolName,
  DeviceWebSocketActionAdapter,
} from "./device-action-adapter.ts";
import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import type { RoleRunAuditTrail } from "./role-audit.ts";
import {
  assertRoleToolAuthorization,
  getHumanAvatarExecutorProfile,
  HUMAN_AVATAR_TOOLS,
} from "./role-profiles.ts";
import { createHash } from "node:crypto";

export const HUMAN_AVATAR_ID = "human_avatar" as const;
export { HUMAN_AVATAR_TOOLS } from "./role-profiles.ts";

export type HumanAvatarToolName = (typeof HUMAN_AVATAR_TOOLS)[number];

export interface HumanAvatarDeviceRuntime extends Pick<
  DeviceWebSocketActionAdapter,
  "is_ready" | "protocol_version" | "object_capabilities" | "last_snapshot" | "executeAction"
> {
  readonly room_capabilities: readonly RoomId[];
  readonly action_capabilities: readonly DeviceToolName[];
}

export interface HumanAvatarActionRunnerOptions {
  readonly run_id: string;
  readonly assignment_id: string;
  readonly text: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly device: HumanAvatarDeviceRuntime;
  readonly signal?: AbortSignal;
  readonly timeout_ms?: number;
  readonly action_timeout_ms?: number;
  readonly audit?: RoleRunAuditTrail;
  /** Latches audit persistence before a physical Device action may be sent. */
  readonly on_side_effect_dispatched?: () => void;
}

export interface HumanAvatarActionRunnerResult {
  readonly status: "completed" | "clarify" | "unavailable" | "failed" | "cancelled";
  readonly final_text: string;
  readonly model_turns: 0 | 1;
  readonly tool_results: readonly ToolResult[];
  readonly error_code: string | null;
}

const ROOM_LABELS: Readonly<Record<RoomId, string>> = {
  primary_bedroom: "主卧",
  study: "书房",
  guest_room: "客房",
  entry: "玄关",
  living_room: "客厅",
  kitchen: "厨房",
};

const OBJECT_LABELS: Readonly<Record<string, string>> = {
  "living_room.sofa": "客厅沙发",
  "study.desk": "书房书桌",
  "living_room.window": "客厅窗边",
};

function narrowedDefinitions(device: HumanAvatarDeviceRuntime) {
  const allowedActions = new Set(device.action_capabilities);
  const rooms = device.room_capabilities.filter((room): room is RoomId =>
    (ROOM_IDS as readonly string[]).includes(room)
  );
  const objects = device.object_capabilities.filter((object) => object.available);
  const definitions = getHumanAvatarToolDefinitions()
    .filter((definition) =>
      (HUMAN_AVATAR_TOOLS as readonly string[]).includes(definition.name)
      && allowedActions.has(definition.name as DeviceToolName)
    );
  return definitions.flatMap((definition) => {
    const parameters = structuredClone(definition.parameters) as Record<string, unknown>;
    const properties = structuredClone(
      (parameters.properties ?? {}) as Record<string, unknown>,
    );
    if (definition.name === "character.go_to_room") {
      if (rooms.length === 0) return [];
      properties.room_id = { enum: rooms };
    } else {
      const action = definition.name.replace("character.", "") as
        "go_to" | "sit" | "look_at" | "interact";
      const targets = objects
        .filter((object) => object.supported_actions.includes(action))
        .map((object) => object.object_id);
      if (targets.length === 0) return [];
      properties.target_id = { enum: targets };
    }
    parameters.properties = properties;
    return [{ ...definition, parameters }];
  });
}

function validatePlan(
  rawCalls: readonly { readonly function: { readonly name: string; readonly arguments: Record<string, unknown> } }[],
  device: HumanAvatarDeviceRuntime,
): readonly Omit<ToolCall, "tool_call_id">[] {
  if (rawCalls.length < 1 || rawCalls.length > 4) {
    throw new TypeError("Human avatar action requires one to four tool calls");
  }
  const calls = validateHumanAvatarToolCalls(rawCalls.map((call) => ({
    name: call.function.name,
    arguments: call.function.arguments,
  })));
  assertRoleToolAuthorization(getHumanAvatarExecutorProfile(), calls.map((call) => call.name));
  if (!calls.every((call) => (HUMAN_AVATAR_TOOLS as readonly string[]).includes(call.name))) {
    throw new TypeError("Human avatar model selected a forbidden tool");
  }

  const definitions = new Map<string, ReturnType<typeof narrowedDefinitions>[number]>(
    narrowedDefinitions(device).map((definition) => [definition.name, definition]),
  );
  const availableObjects = new Map<string, (typeof device.object_capabilities)[number]>(
    device.object_capabilities.filter((object) => object.available)
      .map((object) => [object.object_id, object] as const),
  );
  const roomSet = new Set(device.room_capabilities);
  const character = device.last_snapshot?.character;
  let target: string | null = character !== undefined && "target_object_id" in character
    ? character.target_object_id
    : null;
  for (const [index, call] of calls.entries()) {
    if (!definitions.has(call.name)) {
      throw new TypeError("Human avatar tool is absent from live device capabilities");
    }
    if (call.name === "character.go_to_room") {
      if (calls.length !== 1 || !roomSet.has(call.arguments.room_id as RoomId)) {
        throw new TypeError("room movement must be one unambiguous live-capability action");
      }
      continue;
    }
    const targetId = call.arguments.target_id;
    if (typeof targetId !== "string") throw new TypeError("avatar object target is invalid");
    const capability = availableObjects.get(targetId);
    const action = call.name.replace("character.", "") as
      "go_to" | "sit" | "look_at" | "interact";
    if (capability === undefined || !capability.supported_actions.includes(action)) {
      throw new TypeError("avatar object target is unavailable for the requested action");
    }
    if (call.name === "character.go_to") {
      if (index !== 0) {
        throw new TypeError("go_to must be the first action in a single-target plan");
      }
      target = targetId;
    } else if (target !== targetId) {
      throw new TypeError("object action requires the avatar to reach the same target first");
    }
  }
  return calls;
}

function actionId(runId: string, index: number): string {
  return suffixedId(runId, `:avatar:${index + 1}`);
}

function toolCallId(assignmentId: string, index: number): string {
  return suffixedId(assignmentId, `:avatar-tool:${index + 1}`);
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

function toolResult(
  call: ToolCall,
  outcome: DeviceActionOutcome,
): ToolResult {
  const result: ToolResult = outcome.status === "completed"
    ? {
        schema_version: 3,
        tool_call_id: call.tool_call_id,
        name: call.name,
        status: "success",
        result: structuredClone(outcome.result),
        error: null,
      }
    : outcome.status === "failed"
      ? {
          schema_version: 3,
          tool_call_id: call.tool_call_id,
          name: call.name,
          status: "error",
          result: null,
          error: structuredClone(outcome.error),
        }
      : {
          schema_version: 3,
          tool_call_id: call.tool_call_id,
          name: call.name,
          status: "error",
          result: null,
          error: {
            code: "DEVICE_OFFLINE",
            message: "Human avatar action outcome is unknown",
            retryable: true,
            details: {
              outcome: "unknown",
              reason: outcome.reason,
              replay_allowed: false,
              reconciliation: outcome.reconciliation,
            },
          },
        };
  return validateHumanAvatarToolResult(result) as ToolResult;
}

function completedText(call: ToolCall): string {
  if (call.name === "character.go_to_room") {
    return `好的，Human 已移动到${ROOM_LABELS[call.arguments.room_id as RoomId]}。`;
  }
  const target = OBJECT_LABELS[String(call.arguments.target_id)] ?? "目标位置";
  if (call.name === "character.sit") return `好的，Human 已在${target}坐下。`;
  if (call.name === "character.look_at") return `好的，Human 已看向${target}。`;
  if (call.name === "character.interact") return `好的，Human 已和${target}互动。`;
  return `好的，Human 已移动到${target}。`;
}

function undispatchedResult(call: ToolCall, dependencyCode: string): ToolResult {
  return validateHumanAvatarToolResult({
    schema_version: 3,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "error",
    result: null,
    error: {
      code: "CANCELLED",
      message: "Human avatar action was not dispatched after an earlier step failed",
      retryable: false,
      details: { skipped: true, dependency_error_code: dependencyCode },
    },
  }) as ToolResult;
}

async function closeUndispatchedCalls(
  calls: readonly ToolCall[],
  start: number,
  dependencyCode: string,
  results: ToolResult[],
  audit: RoleRunAuditTrail | undefined,
): Promise<void> {
  for (const call of calls.slice(start)) {
    const skipped = undispatchedResult(call, dependencyCode);
    results.push(skipped);
    await audit?.toolResult(skipped, 1);
  }
}

export async function runHumanAvatarAction(
  options: HumanAvatarActionRunnerOptions,
): Promise<HumanAvatarActionRunnerResult> {
  if (options.signal?.aborted === true) {
    return { status: "cancelled", final_text: "", model_turns: 0, tool_results: [], error_code: "CANCELLED" };
  }
  if (
    !options.device.is_ready
    || Number(options.device.protocol_version) !== 3
    || options.device.room_capabilities.length === 0
    || options.device.action_capabilities.length === 0
  ) {
    return {
      status: "unavailable",
      final_text: "现在还不能控制屏幕上的 Human，请稍后再试。",
      model_turns: 0,
      tool_results: [],
      error_code: "AVATAR_DEVICE_UNAVAILABLE",
    };
  }
  const tools = narrowedDefinitions(options.device);
  if (tools.length === 0) {
    return {
      status: "unavailable",
      final_text: "屏幕上的 Human 当前没有可用动作，请稍后再试。",
      model_turns: 0,
      tool_results: [],
      error_code: "AVATAR_CAPABILITY_UNAVAILABLE",
    };
  }

  await options.audit?.modelRequested(1);
  let response;
  try {
    response = await options.provider.chat({
    messages: [{
      role: "system",
      content: [
        "你只为屏幕上的 Human 选择动作工具，不回答、不解释。",
        "只能使用 Runtime 给出的工具和枚举目标；不得生成 actor_id、坐标、Cat 或 Home Assistant 动作。",
        "输出一到四个串行动作；坐下、看向或互动前，若尚未到达目标，必须先 go_to 同一目标。",
        "含糊、未知、条件、否定或复杂混合意图不得猜测，返回零工具调用。",
      ].join(""),
    }, { role: "user", content: options.text }],
    tools: tools.map((tool) => ({ type: "function" as const, function: tool })),
    options: {
      temperature: 0,
      num_ctx: 4_096,
      num_predict: 128,
    },
    think: QWEN_THINKING_ENABLED,
    ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    }, options.signal);
  } catch {
    if (isAborted(options.signal)) {
      return {
        status: "cancelled", final_text: "", model_turns: 1,
        tool_results: [], error_code: "CANCELLED",
      };
    }
    return {
      status: "unavailable",
      final_text: "暂时无法理解屏幕 Human 的动作，请稍后再试。",
      model_turns: 1,
      tool_results: [],
      error_code: "AVATAR_MODEL_UNAVAILABLE",
    };
  }
  await options.audit?.modelCompleted(response.message, 1);
  if (
    response.message.content.trim().length > 0
    || (response.message.thinking?.trim().length ?? 0) > 0
  ) {
    return {
      status: "clarify",
      final_text: "我还不能确定要让屏幕上的 Human 做什么，请说清楚位置和动作。",
      model_turns: 1,
      tool_results: [],
      error_code: "INVALID_AVATAR_PLAN",
    };
  }

  let planned;
  try {
    planned = validatePlan(response.message.tool_calls ?? [], options.device);
  } catch {
    return {
      status: "clarify",
      final_text: "我还不能确定要让屏幕上的 Human 做什么，请说清楚位置和动作。",
      model_turns: 1,
      tool_results: [],
      error_code: "INVALID_AVATAR_PLAN",
    };
  }
  const calls: ToolCall[] = planned.map((call, index) => ({
    tool_call_id: toolCallId(options.assignment_id, index),
    name: call.name,
    arguments: structuredClone(call.arguments),
  }));
  await options.audit?.toolCalls(calls, 1);
  const results: ToolResult[] = [];
  for (const [index, call] of calls.entries()) {
    if (isAborted(options.signal)) {
      await closeUndispatchedCalls(
        calls, index, "CANCELLED", results, options.audit,
      );
      return {
        status: "cancelled", final_text: "", model_turns: 1,
        tool_results: results, error_code: "CANCELLED",
      };
    }
    const currentActionId = actionId(options.run_id, index);
    await options.audit?.avatarActionLifecycle(
      call.tool_call_id, currentActionId, call.name, call.arguments, "requested", null,
    );
    let outcome: DeviceActionOutcome;
    let dispatchAttempted = false;
    try {
      outcome = await options.device.executeAction({
        action_id: currentActionId,
        actor_id: HUMAN_AVATAR_ID,
        tool: call.name as HumanAvatarToolName,
        arguments: structuredClone(call.arguments),
        timeout_ms: options.action_timeout_ms ?? 10_000,
        origin: "user",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        on_dispatched: () => {
          if (dispatchAttempted) return;
          dispatchAttempted = true;
          options.on_side_effect_dispatched?.();
        },
      });
    } catch {
      const cancelled = isAborted(options.signal);
      const failed = validateHumanAvatarToolResult({
        schema_version: 3,
        tool_call_id: call.tool_call_id,
        name: call.name,
        status: "error",
        result: null,
        error: {
          code: cancelled ? "CANCELLED" : "INTERNAL",
          message: cancelled
            ? "Human avatar action was cancelled"
            : dispatchAttempted
              ? "Human avatar action failed after dispatch without a device terminal"
              : "Human avatar action was rejected before dispatch",
          retryable: false,
        },
      }) as ToolResult;
      results.push(failed);
      await options.audit?.toolResult(failed, 1);
      await options.audit?.avatarActionLifecycle(
        call.tool_call_id, currentActionId, call.name, call.arguments,
        cancelled ? "cancelled" : dispatchAttempted ? "unknown" : "failed",
        cancelled ? "CANCELLED" : "INTERNAL",
        false,
        null,
      );
      await closeUndispatchedCalls(
        calls, index + 1, cancelled ? "CANCELLED" : "INTERNAL", results, options.audit,
      );
      return {
        status: cancelled ? "cancelled" : "failed",
        final_text: cancelled ? "" : "屏幕上的 Human 动作没有完成，请稍后再试。",
        model_turns: 1,
        tool_results: results,
        error_code: cancelled ? "CANCELLED" : "AVATAR_ACTION_FAILED",
      };
    }
    const result = toolResult(call, outcome);
    results.push(result);
    await options.audit?.toolResult(result, 1);
    const lifecycleStatus = outcome.status === "completed"
      ? "completed"
      : outcome.status === "unknown"
        ? "unknown"
        : outcome.error.code === "CANCELLED"
          ? "cancelled"
          : "failed";
    await options.audit?.avatarActionLifecycle(
      call.tool_call_id,
      currentActionId,
      call.name,
      call.arguments,
      lifecycleStatus,
      result.error?.code ?? null,
      outcome.status === "unknown" ? outcome.replay_allowed : false,
      outcome.status === "unknown" ? outcome.reconciliation : null,
    );
    if (outcome.status !== "completed") {
      const cancelled = outcome.status === "failed" && outcome.error.code === "CANCELLED";
      await closeUndispatchedCalls(
        calls, index + 1, result.error?.code ?? "AVATAR_ACTION_FAILED",
        results, options.audit,
      );
      return {
        status: cancelled ? "cancelled" : "failed",
        final_text: cancelled ? "" : "屏幕上的 Human 动作没有完整完成，请稍后再试。",
        model_turns: 1,
        tool_results: results,
        error_code: cancelled ? "CANCELLED" : result.error?.code ?? "AVATAR_ACTION_FAILED",
      };
    }
  }
  return {
    status: "completed",
    final_text: completedText(calls.at(-1)!),
    model_turns: 1,
    tool_results: results,
    error_code: null,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
