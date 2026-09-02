import {
  TTS_CHANNELS,
  TTS_MAX_PCM_BYTES,
  TTS_ROLE_VOICES,
  TTS_SAMPLE_BITS,
  TTS_SAMPLE_RATE_HZ,
  TtsProviderError,
  type TtsProvider,
  type TtsPcmChunk,
  type TtsRole,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "@p4home/provider-tts";

import type { ComposedResponsePart, ComposedRoleResponse } from "./role-response-composer.ts";
import type { HumanSpeechSegment } from "./role-runner.ts";

const MAX_TTS_SEGMENTS = 8;

export interface RoleAwareTtsSegment {
  readonly schema_version: 1;
  readonly interaction_id: string;
  readonly assignment_id: string;
  readonly segment_index: number;
  readonly role_id: TtsRole;
  readonly voice: typeof TTS_ROLE_VOICES[TtsRole];
  readonly text: string;
  readonly source_status: ComposedResponsePart["status"];
  readonly source_outcome: ComposedResponsePart["outcome"];
  readonly robot_tool_terminals: readonly {
    readonly tool_call_id: string;
    readonly name: string;
    readonly status: "success" | "error";
    readonly error_code: string | null;
  }[];
  readonly pcm: Uint8Array;
  readonly samples: number;
  readonly duration_ms: number;
}

export interface RoleAwareTtsResult {
  readonly schema_version: 1;
  readonly interaction_id: string;
  readonly role_response: ComposedRoleResponse;
  readonly segments: readonly RoleAwareTtsSegment[];
  readonly pcm_bytes: number;
  readonly duration_ms: number;
}

export type RoleAwareTtsErrorCode = "CANCELLED" | "INVALID_COMPOSITION" | "LIMIT_EXCEEDED" | "PROVIDER_ERROR";

export class RoleAwareTtsError extends Error {
  public constructor(
    public readonly code: RoleAwareTtsErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RoleAwareTtsError";
  }
}

function terminalMetadata(part: ComposedResponsePart): RoleAwareTtsSegment["robot_tool_terminals"] {
  if (part.role_id === "human") {
    if (part.tool_results.length !== 0) {
      throw new RoleAwareTtsError("INVALID_COMPOSITION", "Human TTS part cannot contain tool terminals");
    }
    return [];
  }
  return part.tool_results.map((terminal) => ({
    tool_call_id: terminal.tool_call_id,
    name: terminal.name,
    status: terminal.status,
    error_code: terminal.status === "error" ? terminal.error.code : null,
  }));
}

function renderText(part: ComposedResponsePart): string {
  if (part.role_id === "human") {
    return part.status === "completed" ? part.text.trim() : "暂时无法回应。";
  }
  const errors = part.tool_results.filter((terminal) => terminal.status === "error");
  if (errors.some((terminal) => terminal.error.code === "HA_OUTCOME_UNKNOWN")) {
    return "设备操作结果尚不确定。";
  }
  if (part.status !== "completed" || errors.length > 0) {
    return "设备操作未完成。";
  }
  return part.text.trim();
}

function assertComposition(response: ComposedRoleResponse): void {
  if (response.schema_version !== 1 || response.parts.length < 1
      || response.parts.length > MAX_TTS_SEGMENTS) {
    throw new RoleAwareTtsError("INVALID_COMPOSITION", "TTS composition must contain 1 to 8 parts");
  }
  const assignments = new Set<string>();
  let previousEnd = 0;
  for (const [index, part] of response.parts.entries()) {
    if (part.role_id !== "human" && part.role_id !== "robot") {
      throw new RoleAwareTtsError("INVALID_COMPOSITION", "TTS composition contains an invalid role");
    }
    if (assignments.has(part.assignment_id) || part.source_span.start < previousEnd
        || part.source_span.start > part.source_span.end) {
      throw new RoleAwareTtsError("INVALID_COMPOSITION", "TTS composition order or assignment identity is invalid");
    }
    assignments.add(part.assignment_id);
    previousEnd = part.source_span.end;
    const text = renderText(part);
    if (text.length === 0) {
      throw new RoleAwareTtsError("INVALID_COMPOSITION", `TTS part ${index} has no renderable text`);
    }
    terminalMetadata(part);
  }
}

function aborted(signal: AbortSignal | undefined): never {
  throw new RoleAwareTtsError("CANCELLED", "role-aware TTS was cancelled", {
    ...(signal?.reason === undefined ? {} : { cause: signal.reason }),
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function discardGeneratedPcm(value: unknown): void {
  if (typeof value === "object" && value !== null && "pcm" in value
      && value.pcm instanceof Uint8Array) {
    value.pcm.fill(0);
  }
}

function assertGeneratedResult(
  value: TtsSynthesisResult,
  request: {
    readonly interaction_id: string;
    readonly assignment_id: string;
    readonly segment_index: number;
    readonly role_id: TtsRole;
    readonly voice: typeof TTS_ROLE_VOICES[TtsRole];
  },
): void {
  const expectedDurationMs = value.samples / TTS_SAMPLE_RATE_HZ * 1_000;
  if (value.schema_version !== 1 || value.kind !== "final_pcm"
      || value.interaction_id !== request.interaction_id
      || value.assignment_id !== request.assignment_id
      || value.segment_index !== request.segment_index
      || value.role_id !== request.role_id || value.voice !== request.voice
      || value.sample_rate_hz !== TTS_SAMPLE_RATE_HZ
      || value.channels !== TTS_CHANNELS || value.sample_bits !== TTS_SAMPLE_BITS
      || !(value.pcm instanceof Uint8Array) || value.pcm.byteLength < 2
      || value.pcm.byteLength > TTS_MAX_PCM_BYTES || value.pcm.byteLength % 2 !== 0
      || !Number.isInteger(value.samples) || value.samples !== value.pcm.byteLength / 2
      || !Number.isFinite(value.duration_ms) || value.duration_ms <= 0
      || Math.abs(value.duration_ms - expectedDurationMs) > 0.000_51) {
    discardGeneratedPcm(value);
    throw new RoleAwareTtsError(
      "PROVIDER_ERROR", "role-aware TTS provider returned invalid identity or PCM geometry",
    );
  }
}

export class RoleAwareTtsPipeline {
  readonly #provider: TtsProvider;

  public constructor(provider: TtsProvider) {
    this.#provider = provider;
  }

  public async *streamHumanSegment(
    interactionId: string,
    segment: HumanSpeechSegment,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(interactionId)
        || segment.schema_version !== 1 || segment.interaction_id !== interactionId
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(segment.assignment_id)
        || !Number.isInteger(segment.segment_index) || segment.segment_index < 0
        || segment.segment_index > 63 || segment.role_id !== "human"
        || segment.text.trim() !== segment.text || segment.text.length < 1
        || segment.text.length > 1_024) {
      throw new RoleAwareTtsError(
        "INVALID_COMPOSITION", "streaming Human TTS segment identity or text is invalid",
      );
    }
    const stream = this.#provider.stream;
    if (stream === undefined) {
      throw new RoleAwareTtsError("PROVIDER_ERROR", "TTS provider does not support streaming");
    }
    if (isAborted(signal)) aborted(signal);
    const request = {
      interaction_id: interactionId,
      assignment_id: segment.assignment_id,
      segment_index: segment.segment_index,
      role_id: "human",
      text: segment.text,
      voice: TTS_ROLE_VOICES.human,
      language: "zh",
      sample_rate_hz: TTS_SAMPLE_RATE_HZ,
      channels: TTS_CHANNELS,
      sample_bits: TTS_SAMPLE_BITS,
    } satisfies TtsSynthesisRequest;
    let chunkIndex = 0;
    let totalBytes = 0;
    try {
      for await (const chunk of stream.call(
        this.#provider, request, signal === undefined ? {} : { signal },
      )) {
        this.#assertStreamChunk(chunk, request, chunkIndex);
        if (isAborted(signal)) {
          chunk.pcm.fill(0);
          aborted(signal);
        }
        totalBytes += chunk.pcm.byteLength;
        if (totalBytes > TTS_MAX_PCM_BYTES) {
          chunk.pcm.fill(0);
          throw new RoleAwareTtsError(
            "LIMIT_EXCEEDED", "streaming Human TTS PCM exceeded the total bound",
          );
        }
        chunkIndex++;
        yield chunk.pcm;
      }
      if (chunkIndex === 0) {
        throw new RoleAwareTtsError("PROVIDER_ERROR", "streaming Human TTS returned no PCM");
      }
    } catch (error) {
      if (error instanceof RoleAwareTtsError) throw error;
      if (isAborted(signal) || (error instanceof TtsProviderError && error.code === "CANCELLED")) {
        aborted(signal);
      }
      throw new RoleAwareTtsError(
        "PROVIDER_ERROR", "streaming Human TTS provider failed", { cause: error },
      );
    }
  }

  #assertStreamChunk(
    chunk: TtsPcmChunk,
    request: TtsSynthesisRequest,
    chunkIndex: number,
  ): void {
    const expectedDurationMs = chunk.samples / TTS_SAMPLE_RATE_HZ * 1_000;
    if (chunk.schema_version !== 1 || chunk.kind !== "pcm_chunk" || chunk.final !== false
        || chunk.interaction_id !== request.interaction_id
        || chunk.assignment_id !== request.assignment_id
        || chunk.segment_index !== request.segment_index || chunk.role_id !== "human"
        || chunk.voice !== TTS_ROLE_VOICES.human || chunk.chunk_index !== chunkIndex
        || chunk.sample_rate_hz !== TTS_SAMPLE_RATE_HZ || chunk.channels !== TTS_CHANNELS
        || chunk.sample_bits !== TTS_SAMPLE_BITS || !(chunk.pcm instanceof Uint8Array)
        || chunk.pcm.byteLength < 2 || chunk.pcm.byteLength % 2 !== 0
        || !Number.isInteger(chunk.samples) || chunk.samples !== chunk.pcm.byteLength / 2
        || !Number.isFinite(chunk.duration_ms) || chunk.duration_ms <= 0
        || Math.abs(chunk.duration_ms - expectedDurationMs) > 0.000_51) {
      if (chunk.pcm instanceof Uint8Array) chunk.pcm.fill(0);
      throw new RoleAwareTtsError(
        "PROVIDER_ERROR", "streaming Human TTS returned invalid identity or PCM geometry",
      );
    }
  }

  public async render(
    interactionId: string,
    roleResponse: ComposedRoleResponse,
    signal?: AbortSignal,
  ): Promise<RoleAwareTtsResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(interactionId)) {
      throw new RoleAwareTtsError("INVALID_COMPOSITION", "TTS interaction_id is invalid");
    }
    assertComposition(roleResponse);
    const segments: RoleAwareTtsSegment[] = [];
    let totalBytes = 0;
    let totalDurationMs = 0;
    try {
      for (const [segmentIndex, part] of roleResponse.parts.entries()) {
        if (isAborted(signal)) aborted(signal);
        const text = renderText(part);
        const voice = TTS_ROLE_VOICES[part.role_id];
        let generated: TtsSynthesisResult;
        const request = {
          interaction_id: interactionId,
          assignment_id: part.assignment_id,
          segment_index: segmentIndex,
          role_id: part.role_id,
          text,
          voice,
          language: "zh" as const,
          sample_rate_hz: TTS_SAMPLE_RATE_HZ,
          channels: TTS_CHANNELS,
          sample_bits: TTS_SAMPLE_BITS,
        } satisfies TtsSynthesisRequest;
        try {
          generated = await this.#provider.synthesize(
            request, signal === undefined ? {} : { signal },
          );
        } catch (error) {
          if (isAborted(signal) || (error instanceof TtsProviderError && error.code === "CANCELLED")) {
            aborted(signal);
          }
          throw new RoleAwareTtsError("PROVIDER_ERROR", "role-aware TTS provider failed", { cause: error });
        }
        assertGeneratedResult(generated, request);
        if (isAborted(signal)) {
          generated.pcm.fill(0);
          aborted(signal);
        }
        totalBytes += generated.pcm.byteLength;
        totalDurationMs += generated.duration_ms;
        if (totalBytes > TTS_MAX_PCM_BYTES) {
          generated.pcm.fill(0);
          throw new RoleAwareTtsError("LIMIT_EXCEEDED", "composed TTS PCM exceeded the total bound");
        }
        segments.push({
          schema_version: 1,
          interaction_id: interactionId,
          assignment_id: part.assignment_id,
          segment_index: segmentIndex,
          role_id: part.role_id,
          voice,
          text,
          source_status: part.status,
          source_outcome: part.outcome,
          robot_tool_terminals: terminalMetadata(part),
          pcm: generated.pcm,
          samples: generated.samples,
          duration_ms: generated.duration_ms,
        });
      }
      return {
        schema_version: 1,
        interaction_id: interactionId,
        role_response: structuredClone(roleResponse),
        segments,
        pcm_bytes: totalBytes,
        duration_ms: totalDurationMs,
      };
    } catch (error) {
      for (const segment of segments) segment.pcm.fill(0);
      throw error;
    }
  }
}
