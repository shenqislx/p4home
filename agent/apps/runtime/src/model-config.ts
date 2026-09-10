/** Product-selected shared Ollama model for Role Router and role-scoped runs. */
export const DEFAULT_OLLAMA_MODEL = "qwen3.6:35b-mlx";

/** Frequent voice/chat use shares a finite thirty-minute idle residency window. */
export const PRODUCT_OLLAMA_KEEP_ALIVE = "30m";

/** Deployment override in whole minutes; never implicitly pin model memory forever. */
export function resolveProductOllamaKeepAlive(value: string | undefined): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return PRODUCT_OLLAMA_KEEP_ALIVE;
  const minutes = Number(normalized);
  if (!/^\d+$/u.test(normalized) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error("invalid_p4home_ollama_keep_alive_minutes");
  }
  return `${minutes}m`;
}

/** Qwen requests must not enter thinking/reasoning mode. */
export const QWEN_THINKING_ENABLED = false as const;
