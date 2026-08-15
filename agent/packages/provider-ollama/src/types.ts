export interface OllamaCapabilities {
  readonly serverVersion: string;
  readonly model: string;
  readonly modelAvailable: boolean;
  readonly declaredCapabilities: readonly string[];
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly cancellation: boolean;
}

export type OllamaJsonSchema = Readonly<Record<string, unknown>>;

export interface OllamaGenerateOptions {
  readonly temperature?: number;
  readonly seed?: number;
  readonly num_predict?: number;
}

export interface OllamaGenerateRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly format?: "json" | OllamaJsonSchema;
  readonly options?: OllamaGenerateOptions;
  readonly keep_alive?: string | number;
  readonly timeout_ms?: number;
}

export interface OllamaUsage {
  readonly total_duration_ns?: number;
  readonly load_duration_ns?: number;
  readonly prompt_eval_count?: number;
  readonly prompt_eval_duration_ns?: number;
  readonly eval_count?: number;
  readonly eval_duration_ns?: number;
}

export interface OllamaGenerateResult extends OllamaUsage {
  readonly model: string;
  readonly response: string;
  readonly thinking: string;
  readonly done_reason?: string;
}

export interface OllamaGenerateChunk extends OllamaUsage {
  readonly model: string;
  readonly response: string;
  readonly thinking: string;
  readonly done: boolean;
  readonly done_reason?: string;
}

export interface OllamaProvider {
  probe(signal?: AbortSignal): Promise<OllamaCapabilities>;
  generate(request: OllamaGenerateRequest, signal?: AbortSignal): Promise<OllamaGenerateResult>;
  stream(request: OllamaGenerateRequest, signal?: AbortSignal): AsyncIterable<OllamaGenerateChunk>;
}

export type OllamaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaHttpProviderOptions {
  readonly model: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: OllamaFetch;
}
