import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OLLAMA_MODEL,
  PRODUCT_OLLAMA_KEEP_ALIVE,
  QWEN_THINKING_ENABLED,
} from "@p4home/runtime";

test("the product-selected default Ollama model is stable", () => {
  assert.equal(DEFAULT_OLLAMA_MODEL, "qwen3.6:35b-mlx");
  assert.equal(PRODUCT_OLLAMA_KEEP_ALIVE, "10m");
  assert.equal(QWEN_THINKING_ENABLED, false);
});
