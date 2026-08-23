export const STT_SAMPLE_RATE_HZ = 16_000;
export const STT_CHANNELS = 1;
export const STT_SAMPLE_BITS = 16;
export const STT_MAX_PCM_BYTES = 640_000;
export const STT_PROVIDER_VERSION = "0.4.3";
export const STT_MODEL_ID = "mlx-community/whisper-small-mlx";
export const STT_MODEL_REVISION = "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e";

export interface SttSessionIdentity {
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
}

export interface SttTranscriptionRequest extends SttSessionIdentity {
  readonly pcm: Uint8Array;
  readonly sample_rate_hz: typeof STT_SAMPLE_RATE_HZ;
  readonly channels: typeof STT_CHANNELS;
  readonly sample_bits: typeof STT_SAMPLE_BITS;
  readonly language: "zh";
}

export interface SttPartialTranscript extends SttSessionIdentity {
  readonly schema_version: 1;
  readonly kind: "partial";
  readonly sequence: number;
  readonly text: string;
  readonly language: "zh";
}

export interface SttFinalTranscript extends SttSessionIdentity {
  readonly schema_version: 1;
  readonly kind: "final";
  readonly text: string;
  readonly language: "zh";
  readonly duration_ms: number;
}

export interface SttTranscriptionOptions {
  readonly signal?: AbortSignal;
  readonly on_partial?: (partial: SttPartialTranscript) => void;
}

export interface SttProvider {
  transcribe(
    request: SttTranscriptionRequest,
    options?: SttTranscriptionOptions,
  ): Promise<SttFinalTranscript>;
}

export type SttProviderErrorCode =
  | "CANCELLED"
  | "INVALID_RESPONSE"
  | "MODEL_UNAVAILABLE"
  | "PROCESS_ERROR"
  | "TIMEOUT";

export class SttProviderError extends Error {
  public readonly code: SttProviderErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: SttProviderErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SttProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
