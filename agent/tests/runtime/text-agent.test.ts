import assert from "node:assert/strict";
import test from "node:test";

import { ContractBoundaryError } from "@p4home/contracts";
import { createMockP4HomeDomain } from "@p4home/domain-p4home";
import {
  runTextAgent,
  TextAgentError,
  type TextAgentRunOptions,
} from "@p4home/runtime";
import type { OllamaChatResult, OllamaProvider } from "@p4home/provider-ollama";

function chatResult(
  content: string,
  calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[] = [],
): OllamaChatResult {
  return {
    model: "test-model",
    message: {
      role: "assistant",
      content,
      ...(calls.length === 0
        ? {}
        : {
            tool_calls: calls.map((call, index) => ({
              type: "function" as const,
              function: { index, ...call },
            })),
          }),
    },
  };
}

function queuedProvider(
  responses: readonly OllamaChatResult[],
  requests: Parameters<Pick<OllamaProvider, "chat">["chat"]>[0][] = [],
): Pick<OllamaProvider, "chat"> {
  const queue = [...responses];
  return {
    async chat(request): Promise<OllamaChatResult> {
      requests.push(request);
      const response = queue.shift();
      assert.ok(response !== undefined, "unexpected model turn");
      return response;
    },
  };
}

test("text agent executes validated calls in order and returns the final model text", async () => {
  const requests: Parameters<Pick<OllamaProvider, "chat">["chat"]>[0][] = [];
  const provider = queuedProvider(
    [
      chatResult("", [
        { name: "character.go_to_room", arguments: { room_id: "study" } },
        { name: "character.say", arguments: { text: "我到书房了" } },
      ]),
      chatResult("已经到书房了。"),
    ],
    requests,
  );
  const domain = createMockP4HomeDomain();

  const result = await runTextAgent({
    run_id: "run-001",
    user_text: "去书房并告诉我",
    provider,
    tools: domain.tools,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.final_text, "已经到书房了。");
  assert.equal(result.model_turns, 2);
  assert.deepEqual(
    result.tool_results.map((item) => [item.tool_call_id, item.name, item.status]),
    [
      ["run-001:tool:1", "character.go_to_room", "success"],
      ["run-001:tool:2", "character.say", "success"],
    ],
  );
  assert.equal(domain.getState().room_id, "study");
  const followUp = requests[1];
  assert.ok(followUp !== undefined);
  assert.deepEqual(
    followUp.messages.slice(-2).map((message) => [message.role, message.tool_name]),
    [
      ["tool", "character.go_to_room"],
      ["tool", "character.say"],
    ],
  );
});

test("text agent rejects a fabricated tool before execution", async () => {
  const domain = createMockP4HomeDomain();
  const provider = queuedProvider([
    chatResult("", [{ name: "shell.exec", arguments: { command: "true" } }]),
  ]);

  await assert.rejects(
    runTextAgent({
      run_id: "run-unknown-tool",
      user_text: "执行命令",
      provider,
      tools: domain.tools,
    }),
    (error) => {
      assert.ok(error instanceof ContractBoundaryError);
      assert.equal(error.code, "UNKNOWN_TOOL");
      return true;
    },
  );
  assert.equal(domain.getStateVersion(), 1);
});

test("text agent enforces the total tool-call budget across model turns", async () => {
  const domain = createMockP4HomeDomain();
  const provider = queuedProvider(
    Array.from({ length: 5 }, () =>
      chatResult("", [{ name: "character.get_state", arguments: {} }]),
    ),
  );

  await assert.rejects(
    runTextAgent({
      run_id: "run-budget",
      user_text: "不断读取状态",
      provider,
      tools: domain.tools,
    } satisfies TextAgentRunOptions),
    (error) => {
      assert.ok(error instanceof TextAgentError);
      assert.equal(error.code, "MODEL_TURN_BUDGET_EXCEEDED");
      return true;
    },
  );
});
