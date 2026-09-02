/** Product-selected shared Ollama model for Role Router and role-scoped runs. */
export const DEFAULT_OLLAMA_MODEL = "qwen3.6:35b-mlx";

/** Pin the product model in Ollama; every Router/role request renews the same policy. */
export const PRODUCT_OLLAMA_KEEP_ALIVE = -1;

/** Qwen requests must not enter thinking/reasoning mode. */
export const QWEN_THINKING_ENABLED = false as const;
