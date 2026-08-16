import assert from "node:assert/strict";
import test from "node:test";

import {
  getFrozenGoldenIntents,
  type GoldenIntent,
} from "@p4home/contracts";
import { evaluateToolCalling } from "@p4home/eval-cli";
import type {
  OllamaChatRequest,
  OllamaChatResult,
  OllamaProvider,
  OllamaToolCall,
} from "@p4home/provider-ollama";

const MODEL = "fake-tools:1b";

function response(
  calls: readonly OllamaToolCall[] = [],
  usage: Partial<OllamaChatResult> = {},
  content = calls.length === 0 ? "不执行。" : "",
): OllamaChatResult {
  return {
    model: MODEL,
    message: { role: "assistant", content, tool_calls: calls },
    ...usage,
  };
}

function call(name: string, argumentsValue: Record<string, unknown>): OllamaToolCall {
  return { type: "function", function: { name, arguments: argumentsValue } };
}

test("frozen golden intent accessor returns an isolated 32-case suite", () => {
  const first = getFrozenGoldenIntents();
  const second = getFrozenGoldenIntents();

  assert.equal(first.length, 32);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
});

test("evaluator continues after mismatch, contract and provider errors", async () => {
  const scenarios: readonly GoldenIntent[] = [
    {
      id: "correct-tool",
      text: "去书房",
      expected: [{ name: "character.go_to_room", arguments: { room_id: "study" } }],
    },
    {
      id: "correct-no-tool",
      text: "不要去厨房",
      expected: [],
      no_tool: { code: "NO_ACTION", reason: "negative" },
    },
    {
      id: "valid-mismatch",
      text: "去客厅",
      expected: [{ name: "character.go_to_room", arguments: { room_id: "living_room" } }],
    },
    {
      id: "invalid-contract",
      text: "执行未知工具",
      expected: [],
      no_tool: { code: "UNSUPPORTED_TOOL", reason: "unknown" },
    },
    {
      id: "provider-failure",
      text: "查询状态",
      expected: [{ name: "character.get_state", arguments: {} }],
    },
  ];
  const replies: Array<OllamaChatResult | Error> = [
    response([call("character.go_to_room", { room_id: "study" })], {
      prompt_eval_count: 10,
      eval_count: 2,
      eval_duration_ns: 1_000_000_000,
    }),
    response([], {
      prompt_eval_count: 11,
      eval_count: 3,
      eval_duration_ns: 1_000_000_000,
    }),
    response([call("character.go_to_room", { room_id: "kitchen" })], {
      prompt_eval_count: 12,
      eval_count: 4,
      eval_duration_ns: 1_000_000_000,
    }),
    response([call("shell.run", { command: "true" })], {
      prompt_eval_count: 13,
      eval_count: 5,
      eval_duration_ns: 1_000_000_000,
    }),
    new Error("offline"),
  ];
  const requests: OllamaChatRequest[] = [];
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(request): Promise<OllamaChatResult> {
      requests.push(request);
      const next = replies.shift();
      assert.ok(next !== undefined);
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
  const clockValues = [0, 10, 20, 40, 50, 80, 90, 130, 140, 190];

  const report = await evaluateToolCalling({
    model: MODEL,
    provider,
    scenarios,
    clock: () => clockValues.shift() ?? 190,
  });

  assert.deepEqual(report.cases.map((item) => item.outcome), [
    "pass",
    "pass",
    "mismatch",
    "contract_error",
    "provider_error",
  ]);
  assert.deepEqual(report.summary, {
    total: 5,
    passed: 2,
    exact_accuracy: 0.4,
    tool_name_sequence_accuracy: 0.6,
    tool_cases: 3,
    tool_exact_accuracy: 1 / 3,
    no_tool_cases: 2,
    no_tool_accuracy: 0.5,
    contract_errors: 1,
    invalid_responses: 0,
    provider_errors: 1,
    latency_p50_ms: 30,
    latency_p95_ms: 50,
    tool_call_latency_p50_ms: 30,
    tool_call_latency_p95_ms: 50,
    prompt_tokens: 46,
    output_tokens: 14,
    output_tokens_per_second: 3.5,
  });
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[0]?.options, {
    temperature: 0,
    seed: 42,
    num_ctx: 8_192,
    num_predict: 256,
  });
  assert.equal(requests[0]?.think, false);
  assert.equal(requests[0]?.tools?.length, 5);
  assert.equal(requests[0]?.messages[0]?.role, "system");
  assert.deepEqual(report.cases[3]?.actual, [
    { name: "shell.run", arguments: { command: "true" } },
  ]);
  assert.equal(report.cases[1]?.actual_text, "不执行。");
});

test("evaluator rejects an empty response when no tool is expected", async () => {
  const report = await evaluateToolCalling({
    model: MODEL,
    scenarios: [{
      id: "empty-no-tool",
      text: "不要执行",
      expected: [],
      no_tool: { code: "NO_ACTION", reason: "negative" },
    }],
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return response([], {}, "");
      },
    },
  });

  assert.equal(report.schema_version, 2);
  assert.equal(report.cases[0]?.outcome, "invalid_response");
  assert.equal(report.cases[0]?.exact_match, false);
  assert.equal(report.summary.no_tool_accuracy, 0);
  assert.equal(report.summary.invalid_responses, 1);
});
