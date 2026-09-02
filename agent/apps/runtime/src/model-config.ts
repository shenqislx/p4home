/** Product-selected shared Ollama model for Role Router and role-scoped runs. */
export const DEFAULT_OLLAMA_MODEL = "qwen3.6:35b-mlx";

/** Keep the product model warm for ten idle minutes; every Router/role request renews the timer. */
export const PRODUCT_OLLAMA_KEEP_ALIVE = "10m";

/** Qwen requests must not enter thinking/reasoning mode. */
export const QWEN_THINKING_ENABLED = false as const;
