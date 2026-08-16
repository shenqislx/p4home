import assert from "node:assert/strict";
import test from "node:test";

import { getFrozenToolDefinitions, validateFrozenToolCalls } from "@p4home/contracts";
import {
  OllamaHttpProvider,
  type OllamaFetch,
  type OllamaToolDefinition,
} from "@p4home/provider-ollama";

test("native Ollama tool calls cross the frozen Tool Schema v1 boundary", async () => {
  let requestTools: unknown;
  const fetch: OllamaFetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestTools = body.tools;
    return new Response(
      JSON.stringify({
        model: "qwen3:8b",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                index: 0,
                name: "character.go_to_room",
                arguments: { room_id: "study" },
              },
            },
          ],
        },
        done: true,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const tools: readonly OllamaToolDefinition[] = getFrozenToolDefinitions().map((tool) => ({
    type: "function",
    function: tool,
  }));
  const provider = new OllamaHttpProvider({ model: "qwen3:8b", fetch });

  const response = await provider.chat({
    messages: [{ role: "user", content: "去书房" }],
    tools,
  });
  const calls = validateFrozenToolCalls(
    (response.message.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  );

  assert.equal((requestTools as unknown[]).length, 5);
  assert.deepEqual(calls, [
    { name: "character.go_to_room", arguments: { room_id: "study" } },
  ]);
});
