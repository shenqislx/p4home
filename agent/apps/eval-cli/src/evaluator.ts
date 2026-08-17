import { isDeepStrictEqual } from "node:util";

import {
  getFrozenGoldenIntents,
  getFrozenToolDefinitions,
  validateFrozenToolCalls,
  type FrozenToolCallInput,
  type GoldenIntent,
} from "@p4home/contracts";
import type {
  OllamaChatResult,
  OllamaProvider,
  OllamaUsage,
} from "@p4home/provider-ollama";
import {
  QWEN_THINKING_ENABLED,
  TEXT_AGENT_MODEL_OPTIONS,
  TEXT_AGENT_SYSTEM_PROMPT,
} from "@p4home/runtime";

export const EVAL_SYSTEM_PROMPT = TEXT_AGENT_SYSTEM_PROMPT;

export type EvalCaseOutcome =
  | "pass"
  | "mismatch"
  | "contract_error"
  | "invalid_response"
  | "provider_error";

export interface ToolCallingEvalConfig {
  readonly model: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly scenarios?: readonly GoldenIntent[];
  readonly system_prompt?: string;
  readonly num_ctx?: number;
  readonly num_predict?: number;
  readonly seed?: number;
  readonly timeout_ms?: number;
  readonly keep_alive?: string | number;
  readonly clock?: () => number;
  readonly on_case?: (result: ToolCallingEvalCaseResult) => void;
}

export interface ToolCallingEvalCaseResult {
  readonly id: string;
  readonly text: string;
  readonly expected: readonly FrozenToolCallInput[];
  readonly expected_no_tool_code: string | null;
  readonly actual: readonly FrozenToolCallInput[];
  readonly actual_text: string;
  readonly outcome: EvalCaseOutcome;
  readonly exact_match: boolean;
  readonly tool_name_sequence_match: boolean;
  readonly latency_ms: number;
  readonly usage: OllamaUsage;
  readonly error: string | null;
}

export interface ToolCallingEvalSummary {
  readonly total: number;
  readonly passed: number;
  readonly exact_accuracy: number;
  readonly tool_name_sequence_accuracy: number;
  readonly tool_cases: number;
  readonly tool_exact_accuracy: number;
  readonly no_tool_cases: number;
  readonly no_tool_accuracy: number;
  readonly contract_errors: number;
  readonly invalid_responses: number;
  readonly provider_errors: number;
  readonly latency_p50_ms: number;
  readonly latency_p95_ms: number;
  readonly tool_call_latency_p50_ms: number;
  readonly tool_call_latency_p95_ms: number;
  readonly prompt_tokens: number;
  readonly output_tokens: number;
  readonly output_tokens_per_second: number | null;
}

export interface ToolCallingEvalReport {
  readonly schema_version: 2;
  readonly model: string;
  readonly config: {
    readonly system_prompt: string;
    readonly temperature: 0;
    readonly seed: number;
    readonly num_ctx: number;
    readonly num_predict: number;
    readonly timeout_ms: number;
  };
  readonly summary: ToolCallingEvalSummary;
  readonly cases: readonly ToolCallingEvalCaseResult[];
}

function usage(result: OllamaChatResult): OllamaUsage {
  return {
    ...(result.total_duration_ns === undefined
      ? {}
      : { total_duration_ns: result.total_duration_ns }),
    ...(result.load_duration_ns === undefined
      ? {}
      : { load_duration_ns: result.load_duration_ns }),
    ...(result.prompt_eval_count === undefined
      ? {}
      : { prompt_eval_count: result.prompt_eval_count }),
    ...(result.prompt_eval_duration_ns === undefined
      ? {}
      : { prompt_eval_duration_ns: result.prompt_eval_duration_ns }),
    ...(result.eval_count === undefined ? {} : { eval_count: result.eval_count }),
    ...(result.eval_duration_ns === undefined
      ? {}
      : { eval_duration_ns: result.eval_duration_ns }),
  };
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function summarize(cases: readonly ToolCallingEvalCaseResult[]): ToolCallingEvalSummary {
  const toolCases = cases.filter((item) => item.expected.length > 0);
  const noToolCases = cases.filter((item) => item.expected.length === 0);
  const promptTokens = cases.reduce((total, item) => total + (item.usage.prompt_eval_count ?? 0), 0);
  const outputTokens = cases.reduce((total, item) => total + (item.usage.eval_count ?? 0), 0);
  const evalDurationNs = cases.reduce(
    (total, item) => total + (item.usage.eval_duration_ns ?? 0),
    0,
  );
  const passed = cases.filter((item) => item.exact_match).length;
  return {
    total: cases.length,
    passed,
    exact_accuracy: ratio(passed, cases.length),
    tool_name_sequence_accuracy: ratio(
      cases.filter((item) => item.tool_name_sequence_match).length,
      cases.length,
    ),
    tool_cases: toolCases.length,
    tool_exact_accuracy: ratio(
      toolCases.filter((item) => item.exact_match).length,
      toolCases.length,
    ),
    no_tool_cases: noToolCases.length,
    no_tool_accuracy: ratio(
      noToolCases.filter((item) => item.actual.length === 0 && item.outcome === "pass").length,
      noToolCases.length,
    ),
    contract_errors: cases.filter((item) => item.outcome === "contract_error").length,
    invalid_responses: cases.filter((item) => item.outcome === "invalid_response").length,
    provider_errors: cases.filter((item) => item.outcome === "provider_error").length,
    latency_p50_ms: percentile(cases.map((item) => item.latency_ms), 0.5),
    latency_p95_ms: percentile(cases.map((item) => item.latency_ms), 0.95),
    tool_call_latency_p50_ms: percentile(toolCases.map((item) => item.latency_ms), 0.5),
    tool_call_latency_p95_ms: percentile(toolCases.map((item) => item.latency_ms), 0.95),
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    output_tokens_per_second: evalDurationNs === 0
      ? null
      : outputTokens / (evalDurationNs / 1_000_000_000),
  };
}

export async function evaluateToolCalling(
  options: ToolCallingEvalConfig,
): Promise<ToolCallingEvalReport> {
  const scenarios = options.scenarios ?? getFrozenGoldenIntents();
  const systemPrompt = options.system_prompt ?? EVAL_SYSTEM_PROMPT;
  const numCtx = options.num_ctx ?? TEXT_AGENT_MODEL_OPTIONS.num_ctx;
  const numPredict = options.num_predict ?? TEXT_AGENT_MODEL_OPTIONS.num_predict;
  const seed = options.seed ?? TEXT_AGENT_MODEL_OPTIONS.seed;
  const timeoutMs = options.timeout_ms ?? 300_000;
  const clock = options.clock ?? performance.now.bind(performance);
  const tools = getFrozenToolDefinitions().map((tool) => ({
    type: "function" as const,
    function: tool,
  }));
  const cases: ToolCallingEvalCaseResult[] = [];

  for (const scenario of scenarios) {
    const startedAt = clock();
    let result: ToolCallingEvalCaseResult;
    try {
      const response = await options.provider.chat({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: scenario.text },
        ],
        tools,
        options: {
          temperature: 0,
          seed,
          num_ctx: numCtx,
          num_predict: numPredict,
        },
        think: QWEN_THINKING_ENABLED,
        timeout_ms: timeoutMs,
        ...(options.keep_alive === undefined ? {} : { keep_alive: options.keep_alive }),
      });
      const elapsed = Math.max(0, clock() - startedAt);
      const rawActual = (response.message.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        arguments: call.function.arguments,
      }));
      try {
        const actual = validateFrozenToolCalls(rawActual);
        const expected = scenario.expected;
        const emptyResponse = actual.length === 0 && response.message.content.trim().length === 0;
        const exactMatch = !emptyResponse && isDeepStrictEqual(actual, expected);
        const toolNameSequenceMatch = isDeepStrictEqual(
          actual.map((call) => call.name),
          expected.map((call) => call.name),
        );
        result = {
          id: scenario.id,
          text: scenario.text,
          expected,
          expected_no_tool_code: scenario.no_tool?.code ?? null,
          actual,
          actual_text: response.message.content,
          outcome: emptyResponse ? "invalid_response" : exactMatch ? "pass" : "mismatch",
          exact_match: exactMatch,
          tool_name_sequence_match: toolNameSequenceMatch,
          latency_ms: elapsed,
          usage: usage(response),
          error: null,
        };
      } catch (error) {
        result = {
          id: scenario.id,
          text: scenario.text,
          expected: scenario.expected,
          expected_no_tool_code: scenario.no_tool?.code ?? null,
          actual: rawActual,
          actual_text: response.message.content,
          outcome: "contract_error",
          exact_match: false,
          tool_name_sequence_match: false,
          latency_ms: elapsed,
          usage: usage(response),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      result = {
        id: scenario.id,
        text: scenario.text,
        expected: scenario.expected,
        expected_no_tool_code: scenario.no_tool?.code ?? null,
        actual: [],
        actual_text: "",
        outcome: "provider_error",
        exact_match: false,
        tool_name_sequence_match: false,
        latency_ms: Math.max(0, clock() - startedAt),
        usage: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
    cases.push(result);
    options.on_case?.(result);
  }

  return {
    schema_version: 2,
    model: options.model,
    config: {
      system_prompt: systemPrompt,
      temperature: 0,
      seed,
      num_ctx: numCtx,
      num_predict: numPredict,
      timeout_ms: timeoutMs,
    },
    summary: summarize(cases),
    cases,
  };
}
