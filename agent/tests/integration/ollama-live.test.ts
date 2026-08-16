import assert from "node:assert/strict";
import test from "node:test";
import {
  getFrozenToolDefinitions,
  parseStructuredOutput,
  validateFrozenToolCalls,
} from "@p4home/contracts";
import { createMockP4HomeDomain } from "@p4home/domain-p4home";
import { OllamaHttpProvider } from "@p4home/provider-ollama";
import { runTextAgent } from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";

const liveTest = process.env.P4HOME_OLLAMA_LIVE === "1" ? test : test.skip;

liveTest("local Ollama probes and generates with the selected installed model", async () => {
  const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: 300_000 });

  const capabilities = await provider.probe();
  assert.equal(capabilities.model, model);
  assert.equal(capabilities.modelAvailable, true);
  assert.ok(capabilities.declaredCapabilities.includes("completion"));

  const result = await provider.generate({
    prompt: "只回复 OK，不要解释。",
    options: { temperature: 0, num_predict: 64 },
    keep_alive: "2m",
  });
  assert.ok(result.response.trim().length > 0 || result.thinking.trim().length > 0);
});

liveTest("local Ollama emits a Tool Schema v1 call through native chat", async () => {
  const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: 300_000 });
  const tools = getFrozenToolDefinitions().map((tool) => ({
    type: "function" as const,
    function: tool,
  }));

  const result = await provider.chat({
    messages: [
      {
        role: "system",
        content: "你是 P4 Home Agent。需要执行动作时只使用提供的工具。",
      },
      { role: "user", content: "请去书房。" },
    ],
    tools,
    options: { temperature: 0, num_ctx: 8192, num_predict: 128 },
    think: false,
    keep_alive: "2m",
  });
  const calls = validateFrozenToolCalls(
    (result.message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  );

  assert.deepEqual(calls, [
    { name: "character.go_to_room", arguments: { room_id: "study" } },
  ]);
});

liveTest("local Ollama structured output is revalidated by AJV", async () => {
  const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: 300_000 });
  const schema = {
    type: "object",
    required: ["room_id", "should_move"],
    properties: {
      room_id: { const: "study" },
      should_move: { const: true },
    },
    additionalProperties: false,
  } as const;

  const result = await provider.chat({
    messages: [{ role: "user", content: "把“去书房”解析为指定 JSON。" }],
    format: schema,
    options: { temperature: 0, num_ctx: 8192, num_predict: 128 },
    think: false,
    keep_alive: "2m",
  });

  assert.deepEqual(parseStructuredOutput(schema, result.message.content), {
    room_id: "study",
    should_move: true,
  });
});

liveTest("local Ollama completes a bounded text-agent loop with mock tools", async () => {
  const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: 300_000 });
  const domain = createMockP4HomeDomain();
  using store = new SqliteAuditStore(":memory:");
  const createdAtMs = Date.now();
  await store.saveAgentProfile({
    agent_profile_id: "live-profile",
    name: "P4 Home",
    locale: "zh-CN",
    allowed_tools: ["character.go_to_room"],
  });
  await store.saveSession({
    session_id: "live-session",
    agent_profile_id: "live-profile",
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
  });

  const result = await runTextAgent({
    run_id: "live-text-agent-001",
    user_text: "请去书房，完成后简短告诉我。",
    provider,
    tools: domain.tools,
    max_tool_rounds: 2,
    model_timeout_ms: 300_000,
    audit: { store, session_id: "live-session" },
  });
  const trace = await store.getRunTrace("live-text-agent-001");

  assert.equal(result.status, "completed");
  assert.equal(domain.getState().room_id, "study");
  assert.ok(result.tool_results.some((item) => item.name === "character.go_to_room"));
  assert.ok(result.final_text.trim().length > 0);
  assert.equal(trace?.run.status, "completed");
  assert.equal(trace?.tool_calls[0]?.status, "success");
  assert.equal(trace?.events.at(-1)?.type, "run.completed");
});
