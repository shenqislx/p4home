import {
  getFrozenToolDefinitions,
  validateFrozenToolCalls,
  validateFrozenToolResult,
} from "@p4home/contracts";
import {
  runSequentialToolCalls,
  type ToolDefinition,
  type ToolResult,
} from "@p4home/core";
import {
  OllamaProviderError,
  type OllamaChatResult,
  type OllamaChatMessage,
  type OllamaProvider,
  type OllamaToolDefinition,
} from "@p4home/provider-ollama";

import {
  TextAgentAuditTrail,
  type TextAgentAuditOptions,
} from "./text-agent-audit.ts";

export const TEXT_AGENT_TOOL_CALLS_MAX = 4;
export const TEXT_AGENT_TOOL_ROUNDS_MAX = 4;

const DEFAULT_SYSTEM_PROMPT =
  "你是 P4 Home 的本地 Agent。需要执行动作时只能调用提供的工具；不得编造房间、工具或执行结果。";

export type TextAgentErrorCode =
  | "INVALID_CONFIGURATION"
  | "TOOL_CALL_BUDGET_EXCEEDED"
  | "MODEL_TURN_BUDGET_EXCEEDED";

export class TextAgentError extends Error {
  public readonly code: TextAgentErrorCode;

  public constructor(code: TextAgentErrorCode, message: string) {
    super(message);
    this.name = "TextAgentError";
    this.code = code;
  }
}

export interface TextAgentRunOptions {
  readonly run_id: string;
  readonly user_text: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly system_prompt?: string;
  readonly max_tool_rounds?: number;
  readonly model_timeout_ms?: number;
  readonly tool_timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: TextAgentAuditOptions;
}

export interface TextAgentRunResult {
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly final_text: string;
  readonly model_turns: number;
  readonly tool_results: readonly ToolResult[];
  readonly error: TextAgentRunError | null;
}

export interface TextAgentRunError {
  readonly source: "model" | "provider" | "tool";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

function validateOptions(options: TextAgentRunOptions): number {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(options.run_id) || options.run_id.length > 100) {
    throw new TextAgentError(
      "INVALID_CONFIGURATION",
      "run_id must be a contract-safe identifier of at most 100 characters",
    );
  }
  if (options.user_text.trim().length === 0) {
    throw new TextAgentError("INVALID_CONFIGURATION", "user_text must not be empty");
  }
  const rounds = options.max_tool_rounds ?? TEXT_AGENT_TOOL_ROUNDS_MAX;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > TEXT_AGENT_TOOL_ROUNDS_MAX) {
    throw new TextAgentError(
      "INVALID_CONFIGURATION",
      `max_tool_rounds must be an integer between 1 and ${TEXT_AGENT_TOOL_ROUNDS_MAX}`,
    );
  }
  return rounds;
}

function modelTools(tools: ReadonlyMap<string, ToolDefinition>): readonly OllamaToolDefinition[] {
  return getFrozenToolDefinitions()
    .filter((tool) => tools.has(tool.name))
    .map((tool) => ({ type: "function", function: tool }));
}

async function authorizedTools(
  options: TextAgentRunOptions,
): Promise<ReadonlyMap<string, ToolDefinition>> {
  if (options.audit === undefined) {
    return options.tools;
  }
  const profile = await options.audit.store.getSessionAgentProfile(options.audit.session_id);
  if (profile === null) {
    throw new TextAgentError(
      "INVALID_CONFIGURATION",
      `audit session ${options.audit.session_id} has no agent profile`,
    );
  }
  const allowed = new Set(profile.allowed_tools);
  return new Map(
    [...options.tools].filter(([name]) => allowed.has(name)),
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function providerFailure(
  error: OllamaProviderError,
  modelTurn: number,
  toolResults: readonly ToolResult[],
): TextAgentRunResult {
  const status =
    error.code === "CANCELLED"
      ? "cancelled"
      : error.code === "TIMEOUT"
        ? "timed_out"
        : "failed";
  return {
    status,
    final_text: "",
    model_turns: modelTurn,
    tool_results: toolResults,
    error: {
      source: "provider",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}

function cancelledFailure(
  modelTurn: number,
  toolResults: readonly ToolResult[],
): TextAgentRunResult {
  return {
    status: "cancelled",
    final_text: "",
    model_turns: modelTurn,
    tool_results: toolResults,
    error: {
      source: "provider",
      code: "CANCELLED",
      message: "run was cancelled",
      retryable: false,
    },
  };
}

function toolFailure(
  status: Extract<TextAgentRunResult["status"], "failed" | "cancelled" | "timed_out">,
  modelTurn: number,
  toolResults: readonly ToolResult[],
): TextAgentRunResult {
  let failure: ToolResult | undefined;
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    const candidate = toolResults[index];
    if (candidate?.status === "error") {
      failure = candidate;
      break;
    }
  }
  const error = failure?.error;
  return {
    status,
    final_text: "",
    model_turns: modelTurn,
    tool_results: toolResults,
    error: {
      source: "tool",
      code: error?.code ?? status.toUpperCase(),
      message: error?.message ?? `tool execution ${status}`,
      retryable: error?.retryable ?? false,
    },
  };
}

async function runTextAgentLoop(
  options: TextAgentRunOptions,
  maxToolRounds: number,
  systemPrompt: string,
  audit: TextAgentAuditTrail | undefined,
): Promise<TextAgentRunResult> {
  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: options.user_text },
  ];
  const toolResults: ToolResult[] = [];
  let toolCallOrdinal = 0;

  for (let modelTurn = 1; modelTurn <= maxToolRounds + 1; modelTurn += 1) {
    if (isAborted(options.signal)) {
      return cancelledFailure(modelTurn - 1, toolResults);
    }
    const chatRequest = {
      messages: [...messages],
      tools: modelTools(options.tools),
      options: { temperature: 0, num_ctx: 8192 },
      think: false,
      ...(options.model_timeout_ms === undefined
        ? {}
        : { timeout_ms: options.model_timeout_ms }),
    } as const;
    await audit?.modelRequested(modelTurn);
    let response: OllamaChatResult;
    try {
      response = await options.provider.chat(chatRequest, options.signal);
    } catch (error) {
      if (error instanceof OllamaProviderError) {
        return providerFailure(error, modelTurn, toolResults);
      }
      throw error;
    }
    await audit?.modelCompleted(response.message, modelTurn);
    if (isAborted(options.signal)) {
      return cancelledFailure(modelTurn, toolResults);
    }
    messages.push(response.message);
    const nativeCalls = response.message.tool_calls ?? [];
    if (nativeCalls.length === 0) {
      if (response.message.content.trim().length === 0) {
        return {
          status: "failed",
          final_text: "",
          model_turns: modelTurn,
          tool_results: toolResults,
          error: {
            source: "model",
            code: "EMPTY_MODEL_RESPONSE",
            message: "model returned neither tool calls nor final text",
            retryable: true,
          },
        };
      }
      return {
        status: "completed",
        final_text: response.message.content,
        model_turns: modelTurn,
        tool_results: toolResults,
        error: null,
      };
    }
    if (modelTurn > maxToolRounds) {
      throw new TextAgentError(
        "MODEL_TURN_BUDGET_EXCEEDED",
        "model requested another tool round after the configured limit",
      );
    }

    const validatedCalls = validateFrozenToolCalls(
      nativeCalls.map((call) => ({
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    );
    if (toolCallOrdinal + validatedCalls.length > TEXT_AGENT_TOOL_CALLS_MAX) {
      throw new TextAgentError(
        "TOOL_CALL_BUDGET_EXCEEDED",
        `one text run may execute at most ${TEXT_AGENT_TOOL_CALLS_MAX} tool calls`,
      );
    }
    const calls = validatedCalls.map((call) => {
      toolCallOrdinal += 1;
      return {
        tool_call_id: `${options.run_id}:tool:${toolCallOrdinal}`,
        name: call.name,
        arguments: call.arguments,
      };
    });
    await audit?.toolCalls(calls, modelTurn);
    const execution = await runSequentialToolCalls({
      run_id: options.run_id,
      calls,
      tools: options.tools,
      ...(options.tool_timeout_ms === undefined ? {} : { timeout_ms: options.tool_timeout_ms }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    for (const result of execution.results) {
      const validatedResult = validateFrozenToolResult(result);
      toolResults.push(validatedResult);
      await audit?.toolResult(validatedResult, modelTurn);
      messages.push({
        role: "tool",
        tool_name: validatedResult.name,
        content: JSON.stringify(validatedResult),
      });
    }
    if (execution.status !== "completed") {
      return toolFailure(execution.status, modelTurn, toolResults);
    }
  }

  throw new TextAgentError("MODEL_TURN_BUDGET_EXCEEDED", "model turn budget exhausted");
}

export async function runTextAgent(options: TextAgentRunOptions): Promise<TextAgentRunResult> {
  const maxToolRounds = validateOptions(options);
  const systemPrompt = options.system_prompt ?? DEFAULT_SYSTEM_PROMPT;
  const tools = await authorizedTools(options);
  const effectiveOptions = tools === options.tools ? options : { ...options, tools };
  const audit =
    options.audit === undefined
      ? undefined
      : new TextAgentAuditTrail(options.run_id, options.audit);
  await audit?.start(systemPrompt, options.user_text);
  try {
    const result = await runTextAgentLoop(effectiveOptions, maxToolRounds, systemPrompt, audit);
    await audit?.finish(result);
    return result;
  } catch (error) {
    try {
      await audit?.fail(error);
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        "text agent failed and its audit trail could not be finalized",
      );
    }
    throw error;
  }
}
