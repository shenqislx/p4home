import {
  getRobotHaToolDefinitions,
  type RobotHaCapability,
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
import {
  validateRobotHaProjectedState,
  type RobotHaObservationCursor,
  type RobotHaProjectedState,
  type RobotHaStateObservation,
  type RobotHaWriteAttempt,
  type RobotHaWriteClient,
  type RobotHaWriteResponse,
} from "@p4home/transport-ha";

import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import {
  ROBOT_HA_OFFLINE_TEXT,
  ROBOT_HA_READ_NOT_SELECTED_TEXT,
  readRobotHaCapabilities,
  type RobotHaReadAudit,
} from "./robot-ha-read-runner.ts";
import type { RoleProfile } from "./role-profiles.ts";

const MAX_CALLS = 4;
const OBSERVATION_TIMEOUT_DEFAULT_MS = 5_000;

type ToolName = "home.get_entity" | "home.turn_on" | "home.turn_off" | "home.activate_scene";
type WriteToolName = Exclude<ToolName, "home.get_entity">;
type WriteOutcome = "accepted" | "completed" | "rejected" | "unknown";

const ACTION_BY_TOOL: Readonly<Record<WriteToolName, RobotHaWriteAction>> = {
  "home.turn_on": "turn_on",
  "home.turn_off": "turn_off",
  "home.activate_scene": "activate_scene",
};

function lowRiskWriteActions(capability: RobotHaCapability): readonly RobotHaWriteAction[] {
  if (capability.domain === "light" || capability.domain === "switch") {
    return capability.write_actions.filter((action) => action === "turn_on" || action === "turn_off");
  }
  if (capability.domain === "scene") {
    return capability.write_actions.filter((action) => action === "activate_scene");
  }
  return [];
}

export interface RobotHaWriteAudit extends RobotHaReadAudit {
  haWriteDispatched(
    toolCallId: string,
    alias: string,
    action: RobotHaWriteAction,
    requestId: number,
  ): Promise<void>;
  haWriteObservation(
    toolCallId: string,
    alias: string,
    action: RobotHaWriteAction,
    requestId: number | null,
    source: "subscribed_state_changed" | "already_satisfied_cache" | "reconciliation_read",
    cursor: RobotHaObservationCursor | null,
  ): Promise<void>;
  haWriteOutcome(
    toolCallId: string,
    alias: string,
    action: RobotHaWriteAction,
    requestId: number | null,
    outcome: WriteOutcome,
    accepted: boolean | null,
  ): Promise<void>;
}

export interface RunRobotHaWriteOptions {
  readonly run_id: string;
  readonly messages: readonly OllamaChatMessage[];
  readonly profile: RoleProfile;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly client: RobotHaWriteClient;
  readonly timeout_ms?: number;
  readonly observation_timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: RobotHaWriteAudit;
  /** Synchronous latch: beginWrite returned and a physical side effect may exist. */
  readonly on_side_effect_dispatched?: () => void;
}

export interface RobotHaWriteRuntime {
  readonly client: RobotHaWriteClient;
  readonly observation_timeout_ms?: number;
}

export interface RobotHaWriteExecution {
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

function observationTimeout(value: number | undefined): number {
  const actual = value ?? OBSERVATION_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(actual) || actual < 100 || actual > 60_000) {
    throw new TypeError("observation_timeout_ms must be an integer between 100 and 60000");
  }
  return actual;
}

function failure(
  source: NonNullable<RobotHaWriteExecution["error"]>["source"],
  code: string,
  message: string,
  modelTurns: 0 | 1,
  toolResults: readonly ToolResult[] = [],
  status: Extract<RobotHaWriteExecution["status"], "failed" | "cancelled" | "timed_out"> = "failed",
  retryable = false,
  finalText = "",
): RobotHaWriteExecution {
  return {
    status,
    final_text: finalText,
    model_turns: modelTurns,
    capability_available: true,
    outcome: "error",
    tool_results: toolResults,
    error: { source, code, message, retryable },
  };
}

function modelCapabilities(capabilities: readonly RobotHaCapability[]): readonly Record<string, unknown>[] {
  return capabilities.map((capability) => ({
    alias: capability.alias,
    domain: capability.domain,
    tools: [
      "home.get_entity",
      ...lowRiskWriteActions(capability).map((action) =>
        action === "activate_scene" ? "home.activate_scene" : `home.${action}`
      ),
    ],
  }));
}

function withCapabilities(
  messages: readonly OllamaChatMessage[],
  capabilities: readonly RobotHaCapability[],
): readonly OllamaChatMessage[] {
  const [system, ...rest] = messages;
  if (system?.role !== "system") {
    throw new TypeError("Robot context must begin with a system message");
  }
  return [{
    ...system,
    content: `${system.content}当前能力：${JSON.stringify(modelCapabilities(capabilities))}。只能原样选择 alias 和对应 tool；结果由 Runtime 确定。`,
  }, ...rest];
}

function modelTools(capabilities: readonly RobotHaCapability[]): readonly OllamaToolDefinition[] {
  const allowedNames = new Set<ToolName>(["home.get_entity"]);
  for (const capability of capabilities) {
    for (const action of lowRiskWriteActions(capability)) {
      allowedNames.add(action === "activate_scene" ? "home.activate_scene" : `home.${action}`);
    }
  }
  return getRobotHaToolDefinitions()
    .filter((tool): tool is typeof tool & { readonly name: ToolName } =>
      allowedNames.has(tool.name as ToolName)
    )
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.side_effect
          ? "对明确 allowlist alias 执行一次低风险 Home Assistant 动作。"
          : "读取明确 allowlist alias 的当前状态。",
        parameters: tool.parameters,
      },
    }));
}

function validateCalls(
  runId: string,
  nativeCalls: readonly NonNullable<OllamaChatMessage["tool_calls"]>[number][],
): readonly ToolCall[] {
  if (nativeCalls.length < 1 || nativeCalls.length > MAX_CALLS) {
    throw new TypeError("Robot returned an invalid number of HA calls");
  }
  const aliases = new Set<string>();
  return nativeCalls.map((call, index) => {
    const keys = Object.keys(call.function.arguments).sort();
    const alias = call.function.arguments.alias;
    if (
      call.type !== "function"
      || !["home.get_entity", "home.turn_on", "home.turn_off", "home.activate_scene"].includes(call.function.name)
      || keys.length !== 1
      || keys[0] !== "alias"
      || typeof alias !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/.test(alias)
      || aliases.has(alias)
    ) {
      throw new TypeError("Robot returned an invalid, unsafe or duplicate HA call");
    }
    aliases.add(alias);
    return {
      tool_call_id: `${runId}:tool:${index + 1}`,
      name: call.function.name,
      arguments: { alias },
    };
  });
}

function failedTool(
  call: ToolCall,
  code: ToolFailureResult["error"]["code"],
  message: string,
  details?: Record<string, unknown>,
): ToolFailureResult {
  return {
    schema_version: 1,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "error",
    result: null,
    error: {
      code,
      message,
      retryable: false,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function readSuccess(call: ToolCall, state: RobotHaProjectedState): ToolSuccessResult {
  return {
    schema_version: 1,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "success",
    result: { ...structuredClone(state), outcome: "completed", replay_allowed: false },
    error: null,
  };
}

function writeSuccess(
  call: ToolCall,
  action: RobotHaWriteAction,
  state: RobotHaProjectedState,
  requestId: number | null,
  alreadySatisfied: boolean,
): ToolSuccessResult {
  return {
    schema_version: 1,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "success",
    result: {
      alias: state.alias,
      action,
      outcome: "completed",
      request_id: requestId,
      accepted: requestId === null ? null : true,
      already_satisfied: alreadySatisfied,
      replay_allowed: false,
      observed_state: structuredClone(state),
    },
    error: null,
  };
}

function alreadySatisfied(action: RobotHaWriteAction, state: RobotHaProjectedState): boolean {
  if (action === "turn_off") {
    return state.state === "off";
  }
  if (action === "turn_on") {
    return state.available && state.state === "on";
  }
  return false;
}

function actionSatisfied(action: RobotHaWriteAction, before: RobotHaProjectedState, state: RobotHaProjectedState): boolean {
  if (state.alias !== before.alias || state.domain !== before.domain) {
    return false;
  }
  if (
    state.updated_at_ms === null
    || before.updated_at_ms === null
    || state.updated_at_ms <= before.updated_at_ms
  ) {
    return false;
  }
  if (action === "turn_off") {
    return state.state === "off";
  }
  if (action === "turn_on") {
    return state.available && state.state === "on";
  }
  return state.available && state.state !== before.state;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validCursor(value: unknown): value is RobotHaObservationCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ["connection_generation", "sequence"])
    && Number.isSafeInteger(record.connection_generation)
    && (record.connection_generation as number) >= 1
    && Number.isSafeInteger(record.sequence)
    && (record.sequence as number) >= 0;
}

function validAttempt(value: unknown): value is RobotHaWriteAttempt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ["request_id", "dispatch_cursor", "response"])
    && Number.isSafeInteger(record.request_id)
    && (record.request_id as number) >= 1
    && validCursor(record.dispatch_cursor)
    && record.response instanceof Promise;
}

function validResponse(value: unknown, requestId: number): value is RobotHaWriteResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ["accepted", "request_id"])
    && record.request_id === requestId
    && typeof record.accepted === "boolean";
}

function observationAfter(
  value: unknown,
  cursor: RobotHaObservationCursor,
): value is RobotHaStateObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ["connection_generation", "sequence", "source", "state"])
    && record.source === "subscribed_state_changed"
    && record.connection_generation === cursor.connection_generation
    && Number.isSafeInteger(record.sequence)
    && (record.sequence as number) > cursor.sequence;
}

function compose(results: readonly ToolSuccessResult[]): string {
  return results.map((result) => {
    if (result.name === "home.get_entity") {
      const state = result.result.state;
      return `${String(result.result.alias)} 当前状态：${state === null ? "不可用" : String(state)}。`;
    }
    const already = result.result.already_satisfied === true ? "（原状态已满足，未发送写请求）" : "";
    return `${String(result.result.alias)}：${String(result.result.action)} 已由状态回刷确认完成${already}。`;
  }).join("\n");
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<
  { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "aborted" }
> {
  const settled = promise.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  if (isAborted(signal)) {
    return { kind: "aborted" };
  }
  let onAbort: (() => void) | undefined;
  const abort = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    if (signal !== undefined) {
      onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([
      settled,
      abort,
    ]);
  } finally {
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function waitForObservation<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly kind: "observed"; readonly state: T } | { readonly kind: "unknown" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const raced = await raceAbort(Promise.race([promise, timeout]), signal);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return raced.kind === "value" && raced.value !== null
    ? { kind: "observed", state: raced.value }
    : { kind: "unknown" };
}

interface ReconciliationEvidence {
  readonly attempted: boolean;
  readonly matches_target: boolean | null;
}

async function reconcileUnknown(
  options: RunRobotHaWriteOptions,
  call: ToolCall,
  alias: string,
  action: RobotHaWriteAction,
  before: RobotHaProjectedState,
  capability: RobotHaCapability,
  requestId: number | null,
  timeoutMs: number,
): Promise<ReconciliationEvidence> {
  if (isAborted(options.signal)) {
    return { attempted: false, matches_target: null };
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await raceAbort(
      Promise.resolve(options.client.reconcileState(alias, controller.signal)),
      controller.signal,
    );
    if (outcome.kind !== "value" || isAborted(options.signal)) {
      return { attempted: true, matches_target: null };
    }
    const validated = validateRobotHaProjectedState(outcome.value, capability);
    await options.audit?.haWriteObservation(
      call.tool_call_id,
      alias,
      action,
      requestId,
      "reconciliation_read",
      null,
    );
    return { attempted: true, matches_target: actionSatisfied(action, before, validated) };
  } catch {
    return { attempted: true, matches_target: null };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function reconciliationDetails(evidence: ReconciliationEvidence): Readonly<Record<string, unknown>> {
  return {
    reconciliation_attempted: evidence.attempted,
    reconciliation_matches_target: evidence.matches_target,
  };
}

function skipped(call: ToolCall): ToolFailureResult {
  return failedTool(call, "CANCELLED", "HA call was skipped after a prior terminal failure", {
    replay_allowed: false,
  });
}

function toolFailureText(result: ToolFailureResult): string {
  switch (result.error.code) {
    case "HA_OUTCOME_UNKNOWN":
      return "家居动作结果未知；系统不会自动重试，请先核对当前状态。";
    case "HA_REJECTED":
      return "Home Assistant 拒绝了家居动作；没有报告完成。";
    case "UNAUTHORIZED_HA_ACTION":
    case "UNKNOWN_ENTITY":
      return "该家居动作未获授权，没有发送请求。";
    case "HA_OFFLINE":
      return ROBOT_HA_OFFLINE_TEXT;
    default:
      return "家居动作未完成；系统没有报告成功。";
  }
}

export async function runRobotHaWrite(options: RunRobotHaWriteOptions): Promise<RobotHaWriteExecution> {
  const observationTimeoutMs = observationTimeout(options.observation_timeout_ms);
  if (isAborted(options.signal)) {
    const status = abortedRunStatus(options.signal);
    return failure(
      "runtime",
      status === "timed_out" ? "DEADLINE_EXCEEDED" : "CANCELLED",
      status === "timed_out"
        ? "Robot run exceeded the interaction deadline before HA work"
        : "Robot run was cancelled before HA work",
      0,
      [],
      status,
    );
  }
  if (options.client.state !== "ready") {
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
  const capabilities = readRobotHaCapabilities(options.client);
  await options.audit?.modelRequested(1);
  let response;
  try {
    response = await options.provider.chat({
      messages: withCapabilities(options.messages, capabilities),
      tools: modelTools(capabilities),
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
      const status = error.code === "CANCELLED" ? "cancelled" : error.code === "TIMEOUT" ? "timed_out" : "failed";
      return failure("provider", error.code, error.message, 1, [], status, error.retryable);
    }
    return failure("provider", "UNEXPECTED_PROVIDER_ERROR", "Robot provider failed unexpectedly", 1);
  }
  await options.audit?.modelCompleted(response.message, 1);
  if (isAborted(options.signal)) {
    const status = abortedRunStatus(options.signal);
    return failure(
      "runtime",
      status === "timed_out" ? "DEADLINE_EXCEEDED" : "CANCELLED",
      status === "timed_out"
        ? "Robot run exceeded the interaction deadline after model output"
        : "Robot run was cancelled after model output",
      1,
      [],
      status,
    );
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
    return failure("model", "INVALID_HA_TOOL_CALL", "Robot returned an invalid HA call", 1, [], "failed", true);
  }
  await options.audit?.toolCalls(calls, 1);
  const capabilityByAlias = new Map(capabilities.map((capability) => [capability.alias, capability]));
  const results: ToolResult[] = [];
  const requestIds = new Set<number>();
  let terminalFailure: ToolFailureResult | null = null;

  for (const call of calls) {
    if (terminalFailure !== null) {
      const result = skipped(call);
      results.push(result);
      await options.audit?.toolResult(result, 1);
      continue;
    }
    const alias = String(call.arguments.alias);
    const capability = capabilityByAlias.get(alias);
    const writeAction = call.name === "home.get_entity"
      ? null
      : ACTION_BY_TOOL[call.name as WriteToolName];
    const allowed = capability !== undefined
      && (writeAction === null || lowRiskWriteActions(capability).includes(writeAction));
    await options.audit?.haPolicyDecision(
      call.tool_call_id,
      alias,
      allowed,
      allowed ? (writeAction === null ? "allowlisted_read" : "allowlisted_write") : "unauthorized_alias_or_action",
    );
    let result: ToolResult;
    if (isAborted(options.signal)) {
      result = failedTool(call, "CANCELLED", "HA call was cancelled before execution");
    } else if (!allowed || capability === undefined) {
      result = failedTool(call, writeAction === null ? "UNKNOWN_ENTITY" : "UNAUTHORIZED_HA_ACTION", "HA alias or action is not allowlisted");
    } else if (options.client.state !== "ready") {
      result = failedTool(call, "HA_OFFLINE", "Home Assistant disconnected before execution");
    } else {
      const cached = options.client.getState(alias);
      let before: RobotHaProjectedState | null = null;
      if (cached !== null) {
        try {
          before = validateRobotHaProjectedState(cached, capability);
        } catch {
          before = null;
        }
      }
      if (before === null) {
        result = failedTool(call, cached === null ? "HA_STATE_MISSING" : "HA_STATE_INVALID", "allowlisted entity state is unavailable");
      } else if (writeAction === null) {
        await options.audit?.haReadRequested(call.tool_call_id, alias);
        if (isAborted(options.signal)) {
          result = failedTool(call, "CANCELLED", "HA read was cancelled before cache access");
        } else if (options.client.state !== "ready") {
          result = failedTool(call, "HA_OFFLINE", "Home Assistant disconnected before cache access");
        } else {
          const current = options.client.getState(alias);
          if (current === null) {
            result = failedTool(call, "HA_STATE_MISSING", "allowlisted entity state is unavailable");
          } else {
            try {
              result = readSuccess(call, validateRobotHaProjectedState(current, capability));
            } catch {
              result = failedTool(call, "HA_STATE_INVALID", "allowlisted entity state is invalid");
            }
          }
        }
      } else if (alreadySatisfied(writeAction, before)) {
        result = writeSuccess(call, writeAction, before, null, true);
        await options.audit?.haWriteObservation(
          call.tool_call_id,
          alias,
          writeAction,
          null,
          "already_satisfied_cache",
          null,
        );
        await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, null, "completed", null);
      } else if (isAborted(options.signal)) {
        result = failedTool(call, "CANCELLED", "HA write was cancelled before dispatch");
      } else {
        let dispatchCursor: RobotHaObservationCursor | null = null;
        let observed: RobotHaStateObservation | null = null;
        const buffered: RobotHaStateObservation[] = [];
        let resolveObservation: ((observation: RobotHaStateObservation) => void) | undefined;
        const observation = new Promise<RobotHaStateObservation>((resolve) => {
          resolveObservation = resolve;
        });
        const acceptObservation = (candidate: unknown): void => {
          if (dispatchCursor === null) {
            if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
              buffered.push(structuredClone(candidate as RobotHaStateObservation));
              if (buffered.length > 8) {
                buffered.shift();
              }
            }
            return;
          }
          if (!observationAfter(candidate, dispatchCursor)) {
            return;
          }
          try {
            const validated = validateRobotHaProjectedState(candidate.state, capability);
            if (actionSatisfied(writeAction, before, validated)) {
              const accepted = { ...structuredClone(candidate), state: validated };
              observed = accepted;
              resolveObservation?.(accepted);
            }
          } catch {
            // Forged or unrelated observations cannot prove completion.
          }
        };
        const unsubscribe = options.client.onObservation(acceptObservation);
        let requestId: number | null = null;
        let dispatchAttempted = false;
        let reconciliationPromise: Promise<ReconciliationEvidence> | null = null;
        const reconcileOnce = (): Promise<ReconciliationEvidence> => {
          reconciliationPromise ??= reconcileUnknown(
            options,
            call,
            alias,
            writeAction,
            before,
            capability,
            requestId,
            observationTimeoutMs,
          );
          return reconciliationPromise;
        };
        try {
          const rawAttempt: unknown = options.client.beginWrite(alias, writeAction);
          dispatchAttempted = true;
          options.on_side_effect_dispatched?.();
          const possibleResponse = rawAttempt !== null && typeof rawAttempt === "object"
            ? (rawAttempt as Record<string, unknown>).response
            : null;
          const guardedResponse = possibleResponse instanceof Promise
            ? raceAbort(possibleResponse, options.signal)
            : null;
          if (!validAttempt(rawAttempt) || guardedResponse === null || requestIds.has(rawAttempt.request_id)) {
            throw new TypeError("Robot HA write attempt shape or request id is invalid");
          }
          const attempt = rawAttempt;
          requestId = attempt.request_id;
          requestIds.add(requestId);
          dispatchCursor = structuredClone(attempt.dispatch_cursor);
          for (const candidate of buffered) {
            acceptObservation(candidate);
          }
          buffered.length = 0;
          await options.audit?.haWriteDispatched(call.tool_call_id, alias, writeAction, requestId);
          const responseOutcome = await guardedResponse;
          if (responseOutcome.kind !== "value" || !validResponse(responseOutcome.value, requestId)) {
            const reconciliation = await reconcileOnce();
            result = failedTool(call, "HA_OUTCOME_UNKNOWN", "HA write outcome is unknown after dispatch", {
              outcome: "unknown",
              request_id: requestId,
              accepted: null,
              replay_allowed: false,
              ...reconciliationDetails(reconciliation),
            });
            await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, requestId, "unknown", null);
          } else if (!responseOutcome.value.accepted) {
            result = failedTool(call, "HA_REJECTED", "Home Assistant rejected the write", {
              outcome: "rejected",
              request_id: requestId,
              accepted: false,
              replay_allowed: false,
            });
            await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, requestId, "rejected", false);
          } else {
            await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, requestId, "accepted", true);
            const completion = observed === null
              ? await waitForObservation(observation, observationTimeoutMs, options.signal)
              : { kind: "observed" as const, state: observed };
            if (completion.kind === "observed") {
              const confirmed = completion.state;
              result = writeSuccess(call, writeAction, confirmed.state, requestId, false);
              await options.audit?.haWriteObservation(
                call.tool_call_id,
                alias,
                writeAction,
                requestId,
                confirmed.source,
                {
                  connection_generation: confirmed.connection_generation,
                  sequence: confirmed.sequence,
                },
              );
              await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, requestId, "completed", true);
            } else {
              const reconciliation = await reconcileOnce();
              result = failedTool(call, "HA_OUTCOME_UNKNOWN", "HA accepted the write but no confirming state was observed", {
                outcome: "unknown",
                request_id: requestId,
                accepted: true,
                replay_allowed: false,
                ...reconciliationDetails(reconciliation),
              });
              await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, requestId, "unknown", true);
            }
          }
        } catch {
          const reconciliation = dispatchAttempted
            ? await reconcileOnce()
            : null;
          result = failedTool(call, dispatchAttempted ? "HA_OUTCOME_UNKNOWN" : "HA_OFFLINE", dispatchAttempted
            ? "HA write outcome is unknown after dispatch"
            : "Home Assistant disconnected before write dispatch", !dispatchAttempted ? undefined : {
              outcome: "unknown",
              request_id: requestId,
              accepted: null,
              replay_allowed: false,
              ...(reconciliation === null ? {} : reconciliationDetails(reconciliation)),
            });
          if (dispatchAttempted) {
            await options.audit?.haWriteOutcome(call.tool_call_id, alias, writeAction, requestId, "unknown", null);
          }
        } finally {
          unsubscribe();
        }
      }
    }
    results.push(result);
    await options.audit?.toolResult(result, 1);
    if (result.status === "error") {
      terminalFailure = result;
    }
  }

  if (terminalFailure !== null) {
    const status = isAborted(options.signal) ? abortedRunStatus(options.signal) : "failed";
    return failure(
      "tool",
      terminalFailure.error.code,
      terminalFailure.error.message,
      1,
      results,
      status,
      false,
      toolFailureText(terminalFailure),
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
