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
import type {
  OllamaChatMessage,
  OllamaProvider,
  OllamaToolDefinition,
} from "@p4home/provider-ollama";

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
}

export interface TextAgentRunResult {
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly final_text: string;
  readonly model_turns: number;
  readonly tool_results: readonly ToolResult[];
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

function modelTools(): readonly OllamaToolDefinition[] {
  return getFrozenToolDefinitions().map((tool) => ({ type: "function", function: tool }));
}

export async function runTextAgent(options: TextAgentRunOptions): Promise<TextAgentRunResult> {
  const maxToolRounds = validateOptions(options);
  const messages: OllamaChatMessage[] = [
    { role: "system", content: options.system_prompt ?? DEFAULT_SYSTEM_PROMPT },
    { role: "user", content: options.user_text },
  ];
  const toolResults: ToolResult[] = [];
  let toolCallOrdinal = 0;

  for (let modelTurn = 1; modelTurn <= maxToolRounds + 1; modelTurn += 1) {
    const chatRequest = {
      messages: [...messages],
      tools: modelTools(),
      options: { temperature: 0, num_ctx: 8192 },
      think: false,
      ...(options.model_timeout_ms === undefined
        ? {}
        : { timeout_ms: options.model_timeout_ms }),
    } as const;
    const response = await options.provider.chat(
      chatRequest,
      options.signal,
    );
    messages.push(response.message);
    const nativeCalls = response.message.tool_calls ?? [];
    if (nativeCalls.length === 0) {
      return {
        status: "completed",
        final_text: response.message.content,
        model_turns: modelTurn,
        tool_results: toolResults,
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
      messages.push({
        role: "tool",
        tool_name: validatedResult.name,
        content: JSON.stringify(validatedResult),
      });
    }
    if (execution.status !== "completed") {
      return {
        status: execution.status,
        final_text: "",
        model_turns: modelTurn,
        tool_results: toolResults,
      };
    }
  }

  throw new TextAgentError("MODEL_TURN_BUDGET_EXCEEDED", "model turn budget exhausted");
}
