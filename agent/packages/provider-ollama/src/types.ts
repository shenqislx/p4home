export interface OllamaCapabilities {
  readonly serverVersion: string;
  readonly model: string;
  readonly modelAvailable: boolean;
  readonly declaredCapabilities: readonly string[];
  readonly toolCalling: boolean;
  /** Verified capability. A metadata-only probe cannot set this to true. */
  readonly structuredOutput: boolean;
  /** The Ollama API/model metadata declares the completion endpoint needed for format. */
  readonly structuredOutputApi: boolean;
  readonly streaming: boolean;
  readonly cancellation: boolean;
}

export type OllamaJsonSchema = Readonly<Record<string, unknown>>;

export interface OllamaGenerateOptions {
  readonly temperature?: number;
  readonly seed?: number;
  readonly num_predict?: number;
  readonly num_ctx?: number;
}

export interface OllamaGenerateRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly format?: "json" | OllamaJsonSchema;
  readonly options?: OllamaGenerateOptions;
  readonly think?: boolean | "low" | "medium" | "high";
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

export type OllamaChatRole = "system" | "user" | "assistant" | "tool";

export interface OllamaFunctionDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: OllamaJsonSchema;
}

export interface OllamaToolDefinition {
  readonly type: "function";
  readonly function: OllamaFunctionDefinition;
}

export interface OllamaToolCall {
  readonly type: "function";
  readonly function: {
    readonly index?: number;
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  readonly role: OllamaChatRole;
  readonly content: string;
  readonly thinking?: string;
  readonly tool_name?: string;
  readonly tool_calls?: readonly OllamaToolCall[];
}

export interface OllamaChatRequest {
  readonly messages: readonly OllamaChatMessage[];
  readonly tools?: readonly OllamaToolDefinition[];
  readonly format?: "json" | OllamaJsonSchema;
  readonly options?: OllamaGenerateOptions;
  readonly think?: boolean | "low" | "medium" | "high";
  readonly keep_alive?: string | number;
  readonly timeout_ms?: number;
}

export interface OllamaChatResult extends OllamaUsage {
  readonly model: string;
  readonly message: OllamaChatMessage & { readonly role: "assistant" };
  readonly done_reason?: string;
}

/**
 * A chat stream exposes only assistant content while the response is in flight.
 * Thinking and native tool calls remain terminal-only so callers cannot act on
 * partially assembled private reasoning or tool arguments.
 */
export type OllamaChatStreamEvent =
  | {
      readonly kind: "content_delta";
      readonly model: string;
      readonly content: string;
    }
  | {
      readonly kind: "terminal";
      readonly result: OllamaChatResult;
    };

export interface OllamaProvider {
  probe(signal?: AbortSignal): Promise<OllamaCapabilities>;
  generate(request: OllamaGenerateRequest, signal?: AbortSignal): Promise<OllamaGenerateResult>;
  stream(request: OllamaGenerateRequest, signal?: AbortSignal): AsyncIterable<OllamaGenerateChunk>;
  chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResult>;
  /** Optional so existing bounded, non-streaming providers remain compatible. */
  chatStream?(
    request: OllamaChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OllamaChatStreamEvent>;
}

export type OllamaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaHttpProviderOptions {
  readonly model: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  /** Applied to every generation unless that request explicitly overrides it. */
  readonly defaultKeepAlive?: string | number;
  readonly fetch?: OllamaFetch;
}
