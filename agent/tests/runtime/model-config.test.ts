import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OLLAMA_MODEL,
  PRODUCT_OLLAMA_KEEP_ALIVE,
  QWEN_THINKING_ENABLED,
} from "@p4home/runtime";
import { resolveProductOllamaKeepAlive } from "../../apps/runtime/src/model-config.ts";

test("the product-selected default Ollama model is stable", () => {
  assert.equal(DEFAULT_OLLAMA_MODEL, "qwen3.6:35b-mlx");
  assert.equal(PRODUCT_OLLAMA_KEEP_ALIVE, "30m");
  assert.equal(QWEN_THINKING_ENABLED, false);
});

test("product model residency accepts finite minute overrides and rejects malformed values", () => {
  for (const value of [undefined, "", "  "]) assert.equal(resolveProductOllamaKeepAlive(value), "30m");
  for (const value of ["1", " 10 ", "120"]) assert.equal(resolveProductOllamaKeepAlive(value), `${Number(value)}m`);
  for (const value of ["-1", "0", "121", "1.5", "Infinity", "10m", "1e2"]) {
    assert.throws(() => resolveProductOllamaKeepAlive(value), /invalid_p4home_ollama_keep_alive_minutes/);
  }
});
