import assert from "node:assert/strict";
import test from "node:test";

import { ContractBoundaryError } from "@p4home/contracts";
import { createMockP4HomeDomain } from "@p4home/domain-p4home";
import {
  runTextAgent,
  TextAgentError,
  type TextAgentRunOptions,
} from "@p4home/runtime";
import {
  OllamaProviderError,
  type OllamaChatResult,
  type OllamaProvider,
} from "@p4home/provider-ollama";

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
  assert.equal(result.error, null);
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

test("text agent exposes only tools present in the runtime allowlist", async () => {
  let exposedTools: readonly string[] = [];
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(request): Promise<OllamaChatResult> {
      exposedTools = (request.tools ?? []).map((tool) => tool.function.name);
      return chatResult("状态读取完成。");
    },
  };
  const getState = createMockP4HomeDomain().tools.get("character.get_state");
  assert.ok(getState !== undefined);

  const result = await runTextAgent({
    run_id: "run-allowlist",
    user_text: "读取状态",
    provider,
    tools: new Map([[getState.name, getState]]),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(exposedTools, ["character.get_state"]);
});

test("text agent rejects an empty final model response", async () => {
  const result = await runTextAgent({
    run_id: "run-empty-response",
    user_text: "去书房",
    provider: queuedProvider([chatResult("")]),
    tools: createMockP4HomeDomain().tools,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.source, "model");
  assert.equal(result.error?.code, "EMPTY_MODEL_RESPONSE");
});

test("text agent maps provider cancellation, timeout and transport errors to run results", async () => {
  const cases = [
    ["CANCELLED", "cancelled"],
    ["TIMEOUT", "timed_out"],
    ["UNREACHABLE", "failed"],
  ] as const;
  for (const [code, status] of cases) {
    const provider: Pick<OllamaProvider, "chat"> = {
      async chat(): Promise<OllamaChatResult> {
        throw new OllamaProviderError(code, `provider ${code.toLowerCase()}`, {
          retryable: code !== "CANCELLED",
        });
      },
    };

    const result = await runTextAgent({
      run_id: `run-provider-${code.toLowerCase()}`,
      user_text: "等待",
      provider,
      tools: createMockP4HomeDomain().tools,
    });

    assert.equal(result.status, status);
    assert.equal(result.error?.source, "provider");
    assert.equal(result.error?.code, code);
  }
});

test("text agent does not process a model response that races with cancellation", async () => {
  const controller = new AbortController();
  let executed = false;
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      controller.abort(new Error("cancel as response completes"));
      return chatResult("", [{ name: "character.say", arguments: { text: "不应执行" } }]);
    },
  };
  const tools = new Map([
    [
      "character.say",
      {
        name: "character.say",
        async execute(): Promise<Record<string, unknown>> {
          executed = true;
          return { text: "不应执行" };
        },
      },
    ],
  ]);

  const result = await runTextAgent({
    run_id: "run-provider-cancel-race",
    user_text: "说话",
    provider,
    tools,
    signal: controller.signal,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "CANCELLED");
  assert.equal(executed, false);
});

test("text agent does not start a model turn when already cancelled", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancel before run"));
  let modelCalled = false;
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      modelCalled = true;
      return chatResult("不应调用");
    },
  };

  const result = await runTextAgent({
    run_id: "run-pre-cancelled",
    user_text: "等待",
    provider,
    tools: createMockP4HomeDomain().tools,
    signal: controller.signal,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.model_turns, 0);
  assert.equal(modelCalled, false);
});

test("text agent preserves a long tool failure as a valid failed run", async () => {
  const provider = queuedProvider([
    chatResult("", [{ name: "character.say", arguments: { text: "你好" } }]),
  ]);
  const tools = new Map([
    [
      "character.say",
      {
        name: "character.say",
        async execute(): Promise<Record<string, unknown>> {
          throw new Error("x".repeat(300));
        },
      },
    ],
  ]);

  const result = await runTextAgent({
    run_id: "run-long-tool-error",
    user_text: "说你好",
    provider,
    tools,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.source, "tool");
  assert.equal(result.error?.code, "INTERNAL");
  assert.equal(result.error?.message.length, 256);
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
