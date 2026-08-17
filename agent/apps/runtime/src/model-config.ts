/** Product-selected shared Ollama model for Role Router and role-scoped runs. */
export const DEFAULT_OLLAMA_MODEL = "qwen3.8:27b-mlx";

/** Qwen requests must not enter thinking/reasoning mode. */
export const QWEN_THINKING_ENABLED = false as const;
