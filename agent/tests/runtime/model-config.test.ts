import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OLLAMA_MODEL,
  QWEN_THINKING_ENABLED,
} from "@p4home/runtime";

test("the product-selected default Ollama model is stable", () => {
  assert.equal(DEFAULT_OLLAMA_MODEL, "qwen3.8:27b-mlx");
  assert.equal(QWEN_THINKING_ENABLED, false);
});
