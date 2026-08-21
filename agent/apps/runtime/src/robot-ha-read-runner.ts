import {
  ROBOT_HA_DOMAINS,
  getRobotHaToolDefinitions,
  type RobotHaCapability,
  type RobotHaDomain,
  type RobotHaWriteAction,
} from "@p4home/contracts";
import type {
  ToolCall,
  ToolFailureResult,
  ToolResult,
  ToolSuccessResult,
} from "@p4home/core";
import {
  OllamaProviderError,
  type OllamaChatMessage,
  type OllamaProvider,
  type OllamaToolDefinition,
} from "@p4home/provider-ollama";
import type {
  RobotHaClientView,
  RobotHaProjectedState,
} from "@p4home/transport-ha";
import { validateRobotHaProjectedState } from "@p4home/transport-ha";

import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import type { RoleProfile } from "./role-profiles.ts";

const ROBOT_HA_READ_CALLS_MAX = 4;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortedRunStatus(signal: AbortSignal | undefined): "cancelled" | "timed_out" {
  const reasonName = typeof signal?.reason === "object"
    && signal.reason !== null
    && "name" in signal.reason
    ? String(signal.reason.name)
    : "";
  return reasonName === "TimeoutError" ? "timed_out" : "cancelled";
}

function abortedError(signal: AbortSignal | undefined): {
  readonly code: "CANCELLED" | "DEADLINE_EXCEEDED";
  readonly message: string;
  readonly status: "cancelled" | "timed_out";
} {
  const status = abortedRunStatus(signal);
  return status === "timed_out"
    ? { code: "DEADLINE_EXCEEDED", message: "HA read exceeded the interaction deadline", status }
    : { code: "CANCELLED", message: "HA read was cancelled", status };
}

export const ROBOT_HA_OFFLINE_TEXT = "Home Assistant 当前不可用，这次没有读取或执行任何设备动作。";
export const ROBOT_HA_READ_NOT_SELECTED_TEXT = "当前只支持查询明确的家居状态，不能执行控制动作。";

export interface RobotHaReadRuntime {
  readonly client: RobotHaClientView;
}

export interface RobotHaReadAudit {
  modelRequested(modelTurn: number): Promise<void>;
  modelCompleted(message: OllamaChatMessage, modelTurn: number): Promise<void>;
  modelToolRejected(message: OllamaChatMessage, reason: string): Promise<void>;
  toolCalls(calls: readonly ToolCall[], modelTurn: number): Promise<void>;
  haPolicyDecision(
    toolCallId: string,
    alias: string,
    allowed: boolean,
    reason: string,
  ): Promise<void>;
  haReadRequested(toolCallId: string, alias: string): Promise<void>;
  toolResult(result: ToolResult, modelTurn: number): Promise<void>;
}

export interface RobotHaReadExecution {
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly final_text: string;
  readonly model_turns: 0 | 1;
  readonly capability_available: boolean;
  readonly outcome: "response" | "capability_unavailable" | "error";
  readonly tool_results: readonly ToolResult[];
  readonly error: {
    readonly source: "runtime" | "provider" | "model" | "tool";
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

export interface RunRobotHaReadOptions {
  readonly run_id: string;
  readonly messages: readonly OllamaChatMessage[];
  readonly profile: RoleProfile;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly runtime: RobotHaReadRuntime;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: RobotHaReadAudit;
}

function failure(
  source: NonNullable<RobotHaReadExecution["error"]>["source"],
  code: string,
  message: string,
  modelTurns: 0 | 1,
  toolResults: readonly ToolResult[] = [],
  status: Extract<RobotHaReadExecution["status"], "failed" | "cancelled" | "timed_out"> = "failed",
  retryable = false,
): RobotHaReadExecution {
  return {
    status,
    final_text: "",
    model_turns: modelTurns,
    capability_available: true,
    outcome: "error",
    tool_results: toolResults,
    error: { source, code, message, retryable },
  };
}

function modelTools(): readonly OllamaToolDefinition[] {
  const tool = getRobotHaToolDefinitions().find((candidate) => candidate.name === "home.get_entity");
  if (tool === undefined || tool.side_effect) {
    throw new TypeError("home.get_entity contract is unavailable or unsafe");
  }
  return [{
    type: "function",
    function: {
      name: tool.name,
      description: "读取当前明确允许的 Home Assistant entity alias 状态。",
      parameters: tool.parameters,
    },
  }];
}

export function readRobotHaCapabilities(client: RobotHaClientView): readonly RobotHaCapability[] {
  const writesByDomain: Readonly<Record<RobotHaDomain, readonly RobotHaWriteAction[]>> = {
    light: ["turn_on", "turn_off"],
    switch: ["turn_on", "turn_off"],
    scene: ["activate_scene"],
    climate: ["turn_on", "turn_off"],
    sensor: [],
    binary_sensor: [],
  };
  let snapshot: readonly RobotHaCapability[];
  try {
    snapshot = structuredClone(client.capabilities);
  } catch {
    throw new TypeError("Robot HA read capabilities are invalid");
  }
  const valid = snapshot.every((item) => {
    const keys = Object.keys(item).sort();
    const expectedKeys = ["alias", "domain", "readable", "write_actions"];
    if (
      keys.length !== expectedKeys.length
      || !keys.every((key, index) => key === expectedKeys[index])
      || !/^[a-z][a-z0-9_]{0,63}$/.test(item.alias)
      || !(ROBOT_HA_DOMAINS as readonly string[]).includes(item.domain)
      || item.readable !== true
      || !Array.isArray(item.write_actions)
    ) {
      return false;
    }
    const allowedWrites = writesByDomain[item.domain];
    return new Set(item.write_actions).size === item.write_actions.length
      && item.write_actions.every((action) => allowedWrites.includes(action));
  });
  if (
    snapshot.length < 1
    || snapshot.length > 64
    || !valid
    || new Set(snapshot.map((item) => item.alias)).size !== snapshot.length
    || snapshot.some((item) => item.readable !== true)
  ) {
    throw new TypeError("Robot HA read capabilities are invalid");
  }
  return snapshot;
}

function withCapabilities(
  messages: readonly OllamaChatMessage[],
  capabilities: readonly Pick<RobotHaCapability, "alias" | "domain" | "readable">[],
): readonly OllamaChatMessage[] {
  const [system, ...rest] = messages;
  if (system?.role !== "system") {
    throw new TypeError("Robot context must begin with a system message");
  }
  return [{
    ...system,
    content: `${system.content}当前只读能力：${JSON.stringify(capabilities)}。只能原样选择其中一个 alias；状态由 Runtime 确定性呈现。`,
  }, ...rest];
}

function validateCalls(
  runId: string,
  calls: readonly NonNullable<OllamaChatMessage["tool_calls"]>[number][],
): readonly ToolCall[] {
  if (calls.length < 1 || calls.length > ROBOT_HA_READ_CALLS_MAX) {
    throw new TypeError(`Robot must request 1..${ROBOT_HA_READ_CALLS_MAX} read calls`);
  }
  const aliases = new Set<string>();
  return calls.map((call, index) => {
    const args = call.function.arguments;
    const keys = Object.keys(args).sort();
    const alias = args.alias;
    if (
      call.type !== "function"
      || call.function.name !== "home.get_entity"
      || keys.length !== 1
      || keys[0] !== "alias"
      || typeof alias !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/.test(alias)
      || aliases.has(alias)
    ) {
      throw new TypeError("Robot returned an invalid or duplicate HA read call");
    }
    aliases.add(alias);
    return {
      tool_call_id: `${runId}:tool:${index + 1}`,
      name: "home.get_entity",
      arguments: { alias },
    };
  });
}

function failedTool(
  call: ToolCall,
  code: "UNKNOWN_ENTITY" | "HA_OFFLINE" | "HA_STATE_MISSING" | "HA_STATE_INVALID",
  message: string,
): ToolFailureResult {
  return {
    schema_version: 1,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "error",
    result: null,
    error: { code, message, retryable: code === "HA_OFFLINE" },
  };
}

function successfulTool(call: ToolCall, state: RobotHaProjectedState): ToolSuccessResult {
  return {
    schema_version: 1,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "success",
    result: {
      alias: state.alias,
      domain: state.domain,
      state: state.state,
      available: state.available,
      attributes: structuredClone(state.attributes),
      updated_at_ms: state.updated_at_ms,
    },
    error: null,
  };
}

function compose(results: readonly ToolSuccessResult[]): string {
  return results.map((result) => {
    const alias = String(result.result.alias);
    const domain = String(result.result.domain);
    const state = result.result.available === true && typeof result.result.state === "string"
      ? result.result.state
      : "不可用";
    const attributes = result.result.attributes as Record<string, unknown>;
    const attributeText = Object.keys(attributes).length === 0
      ? ""
      : `，属性 ${JSON.stringify(attributes)}`;
    return `${alias}（${domain}）当前状态：${state}${attributeText}。`;
  }).join("\n");
}

export async function runRobotHaRead(options: RunRobotHaReadOptions): Promise<RobotHaReadExecution> {
  if (isAborted(options.signal)) {
    const aborted = abortedError(options.signal);
    return failure("runtime", aborted.code, aborted.message, 0, [], aborted.status);
  }
  if (options.runtime.client.state !== "ready") {
    return {
      status: "completed",
      final_text: ROBOT_HA_OFFLINE_TEXT,
      model_turns: 0,
      capability_available: false,
      outcome: "capability_unavailable",
      tool_results: [],
      error: null,
    };
  }
  const capabilities = readRobotHaCapabilities(options.runtime.client).map(
    ({ alias, domain, readable }) => ({ alias, domain, readable }),
  );
  await options.audit?.modelRequested(1);
  let response;
  try {
    response = await options.provider.chat({
      messages: withCapabilities(options.messages, capabilities),
      tools: modelTools(),
      options: {
        temperature: options.profile.temperature,
        num_ctx: options.profile.num_ctx,
        num_predict: options.profile.num_predict,
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
      return failure("provider", error.code, error.message, 1, [], status, error.retryable);
    }
    return failure("provider", "UNEXPECTED_PROVIDER_ERROR", "Robot provider failed unexpectedly", 1);
  }
  await options.audit?.modelCompleted(response.message, 1);
  if (isAborted(options.signal)) {
    const aborted = abortedError(options.signal);
    return failure("runtime", aborted.code, aborted.message, 1, [], aborted.status);
  }
  if ((response.message.thinking?.trim().length ?? 0) > 0) {
    return failure("model", "ROLE_POLICY_VIOLATION", "Robot returned thinking content", 1, [], "failed", true);
  }
  const nativeCalls = response.message.tool_calls ?? [];
  if (nativeCalls.length === 0) {
    return {
      status: "completed",
      final_text: ROBOT_HA_READ_NOT_SELECTED_TEXT,
      model_turns: 1,
      capability_available: true,
      outcome: "response",
      tool_results: [],
      error: null,
    };
  }
  let calls: readonly ToolCall[];
  try {
    calls = validateCalls(options.run_id, nativeCalls);
  } catch {
    await options.audit?.modelToolRejected(response.message, "invalid_or_unauthorized_ha_tool_call");
    return failure("model", "INVALID_HA_TOOL_CALL", "Robot returned an invalid HA read call", 1, [], "failed", true);
  }
  await options.audit?.toolCalls(calls, 1);
  const capabilityByAlias = new Map(capabilities.map((item) => [item.alias, item]));
  const results: ToolResult[] = [];
  for (const call of calls) {
    const alias = String(call.arguments.alias);
    const capability = capabilityByAlias.get(alias);
    const allowed = capability !== undefined;
    await options.audit?.haPolicyDecision(
      call.tool_call_id,
      alias,
      allowed,
      allowed ? "allowlisted_read" : "unknown_alias",
    );
    let result: ToolResult;
    if (!allowed) {
      result = failedTool(call, "UNKNOWN_ENTITY", "entity alias is not allowlisted");
    } else if (isAborted(options.signal)) {
      const aborted = abortedError(options.signal);
      result = {
        schema_version: 1,
        tool_call_id: call.tool_call_id,
        name: call.name,
        status: "error",
        result: null,
        error: { code: aborted.code, message: aborted.message, retryable: false },
      };
    } else if (options.runtime.client.state !== "ready") {
      result = failedTool(call, "HA_OFFLINE", "Home Assistant disconnected before the read");
    } else {
      await options.audit?.haReadRequested(call.tool_call_id, alias);
      if (isAborted(options.signal)) {
        const aborted = abortedError(options.signal);
        result = {
          schema_version: 1,
          tool_call_id: call.tool_call_id,
          name: call.name,
          status: "error",
          result: null,
          error: { code: aborted.code, message: aborted.message, retryable: false },
        };
      } else if (options.runtime.client.state !== "ready") {
        result = failedTool(call, "HA_OFFLINE", "Home Assistant disconnected before the read");
      } else {
        const state = options.runtime.client.getState(alias);
        if (state === null) {
          result = failedTool(call, "HA_STATE_MISSING", "allowlisted entity state is missing");
        } else {
          try {
            result = successfulTool(call, validateRobotHaProjectedState(state, capability));
          } catch {
            result = failedTool(call, "HA_STATE_INVALID", "allowlisted entity state is invalid");
          }
        }
      }
    }
    results.push(result);
    await options.audit?.toolResult(result, 1);
  }
  const failed = results.find((result) => result.status === "error");
  if (failed?.status === "error") {
    const status = failed.error.code === "CANCELLED"
      ? "cancelled"
      : failed.error.code === "DEADLINE_EXCEEDED"
        ? "timed_out"
        : "failed";
    return failure(
      "tool",
      failed.error.code,
      failed.error.message,
      1,
      results,
      status,
      failed.error.retryable,
    );
  }
  return {
    status: "completed",
    final_text: compose(results as readonly ToolSuccessResult[]),
    model_turns: 1,
    capability_available: true,
    outcome: "response",
    tool_results: results,
    error: null,
  };
}
