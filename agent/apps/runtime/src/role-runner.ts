import {
  OllamaProviderError,
  type OllamaChatRequest,
  type OllamaChatResult,
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
  isHumanAvatarAssignment,
  type RouteAssignment,
  type RoutePlan,
  type UserTextInteraction,
  validateRoutePlan,
  validateUserTextInteraction,
} from "./role-contracts.ts";
import {
  assertRoleToolAuthorization,
  type RoleInput,
} from "./role-profiles.ts";
import {
  recallPrivateRoleMemory,
  type MemoryContextResult,
  type MemoryRecallMetadata,
  type RoleMemoryRuntime,
} from "./role-memory.ts";
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
import { HumanSpeechSegmenter } from "./human-speech-segmenter.ts";
import {
  runHumanAvatarAction,
  type HumanAvatarDeviceRuntime,
} from "./human-avatar-action-runner.ts";

export const ROBOT_CAPABILITY_UNAVAILABLE_TEXT =
  "家居控制能力将在 Phase 4 上线；这次没有执行任何设备动作。";

export interface RunAssignedRoleOptions {
  readonly run_id: string;
  readonly interaction: UserTextInteraction;
  readonly plan: RoutePlan;
  /** Required when the plan contains more than one assignment. */
  readonly assignment_id?: string;
  readonly session: RoleSession;
  readonly provider: Pick<OllamaProvider, "chat">
    & Partial<Pick<OllamaProvider, "chatStream">>;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: RoleRunAuditOptions;
  readonly robot_ha?: RobotHaReadRuntime | RobotHaWriteRuntime;
  readonly human_avatar?: HumanAvatarDeviceRuntime;
  /** Internal orchestration latch used to preserve unknown write outcomes. */
  readonly on_side_effect_dispatched?: () => void;
  readonly on_human_speech_segment?: (
    segment: HumanSpeechSegment,
    signal: AbortSignal | undefined,
  ) => void | Promise<void>;
  readonly memory?: RoleMemoryRuntime;
}

export interface HumanSpeechSegment {
  readonly schema_version: 1;
  readonly interaction_id: string;
  readonly assignment_id: string;
  readonly segment_index: number;
  readonly role_id: "human";
  readonly text: string;
}

const HUMAN_SPEECH_SEGMENTS_MAX = 64;

class HumanSpeechModelError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HumanSpeechModelError";
  }
}

class HumanSpeechDeliveryError extends Error {
  public constructor(cause: unknown) {
    super("Human speech delivery failed", { cause });
    this.name = "HumanSpeechDeliveryError";
  }
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
  readonly memory?: MemoryRecallMetadata;
}

export class RoleRunAuditFinalizeError extends Error {
  public readonly result: RoleRunResult;

  public constructor(result: RoleRunResult, cause: unknown) {
    super("role execution reached a terminal result but audit finalization failed", { cause });
    this.name = "RoleRunAuditFinalizeError";
    this.result = result;
  }
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

function roleInput(
  options: RunAssignedRoleOptions,
  assignment: RouteAssignment,
): UserTextRoleInput {
  return {
    kind: "user_text",
    text: options.interaction.text.slice(
      assignment.source_span.start,
      assignment.source_span.end,
    ),
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
  memory?: MemoryRecallMetadata,
  finalText = "",
): RoleRunResult {
  return {
    run_id: options.run_id,
    role_id: roleId,
    status,
    final_text: finalText,
    model_turns: modelTurns,
    capability_available: roleId === "human",
    outcome: "error",
    tool_results: toolResults,
    error,
    ...(memory === undefined ? {} : { memory }),
  };
}

function humanChatRequest(
  options: RunAssignedRoleOptions,
  input: UserTextRoleInput,
  memory: MemoryContextResult | undefined,
): OllamaChatRequest {
  const profile = options.session.profile;
  return {
    messages: options.session.buildContext(input, memory),
    options: {
      temperature: profile.temperature,
      num_ctx: profile.num_ctx,
      num_predict: profile.num_predict,
    },
    think: QWEN_THINKING_ENABLED,
    ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
  };
}

function providerFailure(
  options: RunAssignedRoleOptions,
  error: unknown,
  memory: MemoryContextResult | undefined,
): RoleRunResult {
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
    }, 1, [], memory?.metadata);
  }
  return failure(options, "human", "failed", {
    source: "provider",
    code: "UNEXPECTED_PROVIDER_ERROR",
    message: "Human provider failed unexpectedly",
    retryable: false,
  }, 1, [], memory?.metadata);
}

function validateHumanTerminal(
  options: RunAssignedRoleOptions,
  input: UserTextRoleInput,
  memory: MemoryContextResult | undefined,
  response: OllamaChatResult,
): RoleRunResult {
  if (isAborted(options.signal)) {
    return failure(options, "human", "cancelled", {
      source: "runtime",
      code: "CANCELLED",
      message: "role run was cancelled while waiting for the model",
      retryable: false,
    }, 1, [], memory?.metadata);
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
    }, 1, [], memory?.metadata);
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
    }, 1, [], memory?.metadata);
  }
  const policy = assessHumanResponsePolicy(finalText, input.mode);
  if (!policy.compliant) {
    return failure(options, "human", "failed", {
      source: "model",
      code: "ROLE_POLICY_VIOLATION",
      message: `Human response violated policy: ${policy.violation ?? "UNKNOWN"}`,
      retryable: true,
    }, 1, [], memory?.metadata);
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
    ...(memory === undefined ? {} : { memory: memory.metadata }),
  };
}

async function streamHumanResponse(
  options: RunAssignedRoleOptions,
  assignment: RouteAssignment,
  input: UserTextRoleInput,
  memory: MemoryContextResult | undefined,
): Promise<RoleRunResult> {
  const stream = options.provider.chatStream;
  const deliver = options.on_human_speech_segment;
  if (stream === undefined || deliver === undefined || input.mode !== "respond") {
    try {
      return validateHumanTerminal(
        options, input, memory,
        await options.provider.chat(humanChatRequest(options, input, memory), options.signal),
      );
    } catch (error) {
      return providerFailure(options, error, memory);
    }
  }

  const segmenter = new HumanSpeechSegmenter();
  let responseText = "";
  let terminal: OllamaChatResult | null = null;
  let segmentIndex = 0;
  let deliveredText = "";
  const retainSpokenPrefix = (result: RoleRunResult): RoleRunResult => (
    deliveredText.length === 0 ? result : { ...result, final_text: deliveredText }
  );
  const emit = async (text: string): Promise<void> => {
    if (segmentIndex >= HUMAN_SPEECH_SEGMENTS_MAX) {
      throw new HumanSpeechModelError(
        "MODEL_RESPONSE_TOO_LONG", "Human streaming response exceeded the speech segment bound",
      );
    }
    const candidate = `${deliveredText}${text}`;
    const policy = assessHumanResponsePolicy(candidate, "respond");
    if (!policy.compliant) {
      throw new HumanSpeechModelError(
        "ROLE_POLICY_VIOLATION", "Human streaming segment violated the speech policy",
      );
    }
    try {
      await deliver({
        schema_version: 1,
        interaction_id: options.interaction.interaction_id,
        assignment_id: assignment.assignment_id,
        segment_index: segmentIndex,
        role_id: "human",
        text,
      }, options.signal);
    } catch (error) {
      throw new HumanSpeechDeliveryError(error);
    }
    deliveredText = candidate;
    segmentIndex++;
  };

  try {
    for await (const event of stream.call(
      options.provider,
      humanChatRequest(options, input, memory),
      options.signal,
    )) {
      if (event.kind === "content_delta") {
        responseText += event.content;
        if (responseText.length > 8_192) {
          throw new HumanSpeechModelError(
            "MODEL_RESPONSE_TOO_LONG", "Human streaming response exceeded 8192 characters",
          );
        }
        for (const text of segmenter.push(event.content)) await emit(text);
      } else {
        terminal = event.result;
      }
    }
    if (terminal === null || terminal.message.content !== responseText) {
      throw new OllamaProviderError(
        "INVALID_RESPONSE", "Human stream terminal did not match accumulated content",
      );
    }
    const result = validateHumanTerminal(options, input, memory, terminal);
    if (result.status !== "completed") {
      segmenter.discard();
      return retainSpokenPrefix(result);
    }
    for (const text of segmenter.finish()) await emit(text);
    return result;
  } catch (error) {
    segmenter.discard();
    if (error instanceof HumanSpeechModelError) {
      return failure(options, "human", "failed", {
        source: "model",
        code: error.code,
        message: error.message,
        retryable: true,
      }, 1, [], memory?.metadata, deliveredText);
    }
    if (error instanceof OllamaProviderError) {
      return retainSpokenPrefix(providerFailure(options, error, memory));
    }
    if (error instanceof HumanSpeechDeliveryError) {
      const cancelled = isAborted(options.signal);
      return failure(options, "human", cancelled ? "cancelled" : "failed", {
        source: "runtime",
        code: cancelled ? "CANCELLED" : "SPEECH_DELIVERY_FAILED",
        message: cancelled
          ? "Human speech delivery was cancelled"
          : "Human speech delivery failed",
        retryable: !cancelled,
      }, 1, [], memory?.metadata, deliveredText);
    }
    return retainSpokenPrefix(providerFailure(options, error, memory));
  }
}

function validateOptions(options: RunAssignedRoleOptions): RouteAssignment {
  assertContractId(options.run_id, "run_id");
  validateUserTextInteraction(options.interaction);
  validateRoutePlan(options.plan, options.interaction);
  const assignment = options.assignment_id === undefined
    ? options.plan.assignments.length === 1
      ? options.plan.assignments[0]
      : undefined
    : options.plan.assignments.find((candidate) => candidate.assignment_id === options.assignment_id);
  if (assignment === undefined) {
    throw new TypeError("assignment_id must identify exactly one assignment in the route plan");
  }
  const roleId = assignment.role_id;
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
  return assignment;
}

async function executeAssignedRole(
  options: RunAssignedRoleOptions,
  assignment: RouteAssignment,
  input: UserTextRoleInput,
  audit: RoleRunAuditTrail | undefined,
): Promise<RoleRunResult> {
  const roleId = assignment.role_id;
  if (isAborted(options.signal)) {
    return failure(options, roleId, "cancelled", {
      source: "runtime",
      code: "CANCELLED",
      message: "role run was cancelled before execution",
      retryable: false,
    }, 0);
  }

  if (isHumanAvatarAssignment(assignment)) {
    if (options.human_avatar === undefined) {
      return {
        run_id: options.run_id,
        role_id: "human",
        status: "completed",
        final_text: "现在还不能控制屏幕上的 Human，请稍后再试。",
        model_turns: 0,
        capability_available: false,
        outcome: "capability_unavailable",
        tool_results: [],
        error: null,
      };
    }
    const avatar = await runHumanAvatarAction({
      run_id: options.run_id,
      assignment_id: assignment.assignment_id,
      text: input.text,
      provider: options.provider,
      device: options.human_avatar,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
      ...(audit === undefined ? {} : { audit }),
      ...(options.on_side_effect_dispatched === undefined
        ? {}
        : { on_side_effect_dispatched: options.on_side_effect_dispatched }),
    });
    if (avatar.status === "cancelled") {
      return failure(options, "human", "cancelled", {
        source: "runtime",
        code: "CANCELLED",
        message: "Human avatar action was cancelled",
        retryable: false,
      }, avatar.model_turns, avatar.tool_results);
    }
    if (avatar.status === "failed") {
      let terminalError: ToolResult["error"] = null;
      for (let index = avatar.tool_results.length - 1; index >= 0; index--) {
        const candidate = avatar.tool_results[index];
        if (candidate?.status === "error") {
          terminalError = candidate.error;
          break;
        }
      }
      return failure(options, "human", "failed", {
        source: "tool",
        code: avatar.error_code ?? terminalError?.code ?? "AVATAR_ACTION_FAILED",
        message: "Human avatar action did not reach a completed terminal",
        retryable: terminalError?.retryable ?? false,
      }, avatar.model_turns, avatar.tool_results);
    }
    if (avatar.status === "unavailable") {
      return {
        run_id: options.run_id,
        role_id: "human",
        status: "completed",
        final_text: avatar.final_text,
        model_turns: avatar.model_turns,
        capability_available: false,
        outcome: "capability_unavailable",
        tool_results: avatar.tool_results,
        error: null,
      };
    }
    return {
      run_id: options.run_id,
      role_id: "human",
      status: "completed",
      final_text: avatar.final_text,
      model_turns: avatar.model_turns,
      capability_available: true,
      outcome: "response",
      tool_results: avatar.tool_results,
      error: null,
    };
  }

  const profile = options.session.profile;
  const memory = options.memory === undefined
    ? undefined
    : await recallPrivateRoleMemory(options.memory, {
        role_id: roleId,
        query: input.text,
        memory_token_budget: profile.memory_token_budget,
        context_token_budget: options.session.memoryContextTokenHeadroom(input),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
  if (isAborted(options.signal)) {
    return failure(options, roleId, "cancelled", {
      source: "runtime",
      code: "CANCELLED",
      message: "role run was cancelled while recalling memory",
      retryable: false,
    }, 0, [], memory?.metadata);
  }

  if (roleId === "robot") {
    if (options.robot_ha !== undefined) {
      const context = options.session.buildContext(input, memory);
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
          ...(options.on_side_effect_dispatched === undefined
            ? {}
            : { on_side_effect_dispatched: options.on_side_effect_dispatched }),
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
        ...(memory === undefined ? {} : { memory: memory.metadata }),
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
      ...(memory === undefined ? {} : { memory: memory.metadata }),
    };
  }

  return await streamHumanResponse(options, assignment, input, memory);
}

export async function runAssignedRole(
  options: RunAssignedRoleOptions,
): Promise<RoleRunResult> {
  const assignment = validateOptions(options);
  const roleId = assignment.role_id;
  const input = roleInput(options, assignment);
  return await options.session.runExclusive(async () => {
    const audit = options.audit === undefined
      ? undefined
      : new RoleRunAuditTrail(
          options.run_id,
          options.interaction,
          options.plan,
          assignment,
          options.session,
          options.audit,
        );
    await audit?.start(input);
    let result: RoleRunResult;
    try {
      result = await executeAssignedRole(options, assignment, input, audit);
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
    try {
      await audit?.finish(result);
    } catch (error) {
      throw new RoleRunAuditFinalizeError(result, error);
    }
    if (result.final_text.length > 0
        && !isHumanAvatarAssignment(assignment)
        && (roleId === "human" || options.robot_ha === undefined)) {
      options.session.commitExchange(input, result.final_text);
    }
    return result;
  });
}
