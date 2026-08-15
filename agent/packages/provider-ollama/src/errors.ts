export type OllamaProviderErrorCode =
  | "CANCELLED"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "MODEL_NOT_FOUND"
  | "TIMEOUT"
  | "UNREACHABLE";

export class OllamaProviderError extends Error {
  public readonly code: OllamaProviderErrorCode;
  public readonly retryable: boolean;
  public readonly status: number | undefined;

  public constructor(
    code: OllamaProviderErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly status?: number } = {},
  ) {
    super(message);
    this.name = "OllamaProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
