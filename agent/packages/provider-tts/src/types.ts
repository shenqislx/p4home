export const TTS_SAMPLE_RATE_HZ = 16_000;
export const TTS_CHANNELS = 1;
export const TTS_SAMPLE_BITS = 16;
export const TTS_FRAME_SAMPLES = 320;
export const TTS_MAX_TEXT_CHARS = 1_024;
export const TTS_MAX_PCM_BYTES = 1_920_000;
export const TTS_PROVIDER_VERSION = "0.4.8";
export const TTS_MODEL_ID = "mlx-community/Kokoro-82M-bf16";
export const TTS_MODEL_REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c";
export const TTS_ROLE_VOICES = {
  human: "zf_xiaobei",
  robot: "zm_yunxi",
} as const;

export type TtsRole = keyof typeof TTS_ROLE_VOICES;
export type TtsVoice = typeof TTS_ROLE_VOICES[TtsRole];

export interface TtsSegmentIdentity {
  readonly interaction_id: string;
  readonly assignment_id: string;
  readonly segment_index: number;
  readonly role_id: TtsRole;
}

export interface TtsSynthesisRequest extends TtsSegmentIdentity {
  readonly text: string;
  readonly voice: TtsVoice;
  readonly language: "zh";
  readonly sample_rate_hz: typeof TTS_SAMPLE_RATE_HZ;
  readonly channels: typeof TTS_CHANNELS;
  readonly sample_bits: typeof TTS_SAMPLE_BITS;
}

export interface TtsSynthesisResult extends TtsSegmentIdentity {
  readonly schema_version: 1;
  readonly kind: "final_pcm";
  readonly voice: TtsVoice;
  readonly pcm: Uint8Array;
  readonly sample_rate_hz: typeof TTS_SAMPLE_RATE_HZ;
  readonly channels: typeof TTS_CHANNELS;
  readonly sample_bits: typeof TTS_SAMPLE_BITS;
  readonly samples: number;
  readonly duration_ms: number;
}

/**
 * One increment of synthesized PCM. Ownership of `pcm` transfers to the
 * consumer when the chunk is yielded; the consumer must zero it after the
 * bytes have either been copied to the next bounded transport buffer or
 * discarded.
 */
export interface TtsPcmChunk extends TtsSegmentIdentity {
  readonly schema_version: 1;
  readonly kind: "pcm_chunk";
  readonly voice: TtsVoice;
  readonly chunk_index: number;
  readonly pcm: Uint8Array;
  readonly sample_rate_hz: typeof TTS_SAMPLE_RATE_HZ;
  readonly channels: typeof TTS_CHANNELS;
  readonly sample_bits: typeof TTS_SAMPLE_BITS;
  readonly samples: number;
  readonly duration_ms: number;
  readonly final: false;
}

export interface TtsSynthesisOptions {
  readonly signal?: AbortSignal;
}

export interface TtsProvider {
  synthesize(
    request: TtsSynthesisRequest,
    options?: TtsSynthesisOptions,
  ): Promise<TtsSynthesisResult>;
  /** Optional so existing bounded, non-streaming providers remain compatible. */
  stream?(
    request: TtsSynthesisRequest,
    options?: TtsSynthesisOptions,
  ): AsyncIterable<TtsPcmChunk>;
}

export interface StreamingTtsProvider extends TtsProvider {
  stream(
    request: TtsSynthesisRequest,
    options?: TtsSynthesisOptions,
  ): AsyncIterable<TtsPcmChunk>;
}

export type TtsProviderErrorCode =
  | "CANCELLED"
  | "INVALID_RESPONSE"
  | "MODEL_UNAVAILABLE"
  | "PROCESS_ERROR"
  | "TIMEOUT";

export class TtsProviderError extends Error {
  public readonly code: TtsProviderErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: TtsProviderErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TtsProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
