import assert from "node:assert/strict";
import test from "node:test";
import { OllamaHttpProvider } from "@p4home/provider-ollama";

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
