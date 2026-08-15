export interface OllamaCapabilities {
  readonly model: string;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly cancellation: boolean;
}

export interface OllamaProvider {
  probe(signal?: AbortSignal): Promise<OllamaCapabilities>;
}
