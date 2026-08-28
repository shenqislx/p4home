import { createHash } from "node:crypto";

import {
  STT_CHANNELS,
  STT_MAX_PCM_BYTES,
  STT_SAMPLE_BITS,
  STT_SAMPLE_RATE_HZ,
  SttProviderError,
  type SttFinalTranscript,
  type SttPartialTranscript,
  type SttProvider,
} from "@p4home/provider-stt";
import { VOICE_FLAG_END_OF_STREAM, type DecodedVoiceFrame } from "@p4home/contracts";

import type { UserTextInteraction } from "./role-contracts.ts";
import type {
  VoiceCaptureSink,
  VoiceCaptureSummary,
  VoiceDispatchContext,
} from "./voice-websocket-server.ts";

const FRAME_MS = 20;
const FRAME_BYTES = 640;
const DEFAULT_MIN_SPEECH_MS = 300;
const DEFAULT_END_SILENCE_MS = 800;
const DEFAULT_MAX_UTTERANCE_MS = 10_000;
const DEFAULT_STT_TIMEOUT_MS = 45_000;
const MAX_RESULTS = 4_096;
const MAX_PARTIAL_TRANSCRIPTS = 128;

export type VoiceSttOutcome =
  | "cancelled"
  | "dispatch_failed"
  | "dispatched"
  | "empty_transcript"
  | "provider_error"
  | "silence"
  | "stale"
  | "timed_out"
  | "too_long"
  | "too_short";

export interface VoiceSttResult {
  readonly device_id: string;
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
  readonly outcome: VoiceSttOutcome;
  readonly interaction_id: string | null;
  readonly pcm_bytes: number;
  readonly speech_frames: number;
  readonly partials_seen: number;
}

export interface VoiceSttPipelineOptions {
  readonly provider: SttProvider;
  readonly dispatch_final: (
    interaction: UserTextInteraction,
    signal: AbortSignal,
    context: VoiceDispatchContext,
  ) => Promise<void>;
  readonly on_capture_open?: (summary: VoiceCaptureSummary) => void;
  readonly on_partial_ui?: (partial: SttPartialTranscript) => void;
  readonly clock?: () => number;
  readonly vad_peak_threshold?: number;
  readonly min_speech_ms?: number;
  readonly end_silence_ms?: number;
  readonly max_utterance_ms?: number;
  readonly stt_timeout_ms?: number;
  readonly max_results?: number;
}

interface CaptureState {
  readonly summary: VoiceCaptureSummary;
  readonly frames: Buffer[];
  totalFrames: number;
  speechFrames: number;
  trailingSilenceFrames: number;
  endpointReached: boolean;
  tooLong: boolean;
}

function sessionKey(summary: VoiceCaptureSummary): string {
  return `${summary.device_id}\u0000${summary.session_id}\u0000${summary.stream_id}\u0000${summary.epoch}`;
}

function identityMatches(summary: VoiceCaptureSummary, frame: DecodedVoiceFrame): boolean {
  return Buffer.from(frame.header.sessionId).toString("hex") === summary.session_id
    && frame.header.streamId === summary.stream_id
    && frame.header.epoch === summary.epoch;
}

function frameEnergy(payload: Uint8Array): { readonly peak: number; readonly rms: number } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let peak = 0;
  let squaredSum = 0;
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true);
    peak = Math.max(peak, Math.abs(sample));
    squaredSum += sample * sample;
  }
  return { peak, rms: Math.sqrt(squaredSum / (payload.byteLength / 2)) };
}

function boundedFrames(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must resolve to at least one 20 ms frame`);
  }
  return value;
}

function transcriptMatches(
  transcript: SttFinalTranscript | SttPartialTranscript,
  summary: VoiceCaptureSummary,
): boolean {
  return transcript.session_id === summary.session_id
    && transcript.stream_id === summary.stream_id
    && transcript.epoch === summary.epoch
    && transcript.language === "zh";
}

function transcriptIsBounded(text: string): boolean {
  return text.length <= 1_024 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
}

export class VoiceSttPipeline implements VoiceCaptureSink {
  readonly #options: VoiceSttPipelineOptions;
  readonly #active = new Map<string, CaptureState>();
  readonly #latestEpoch = new Map<string, number>();
  readonly #inflightByDevice = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<void>>();
  readonly #results: VoiceSttResult[] = [];
  readonly #vadPeakThreshold: number;
  readonly #minSpeechFrames: number;
  readonly #endSilenceFrames: number;
  readonly #maxUtteranceFrames: number;
  readonly #sttTimeoutMs: number;
  readonly #maxResults: number;
  #closed = false;

  public constructor(options: VoiceSttPipelineOptions) {
    const vadPeakThreshold = options.vad_peak_threshold ?? 300;
    if (!Number.isInteger(vadPeakThreshold) || vadPeakThreshold < 1 || vadPeakThreshold > 32767) {
      throw new RangeError("VAD peak threshold must be an integer between 1 and 32767");
    }
    const minSpeechMs = options.min_speech_ms ?? DEFAULT_MIN_SPEECH_MS;
    const endSilenceMs = options.end_silence_ms ?? DEFAULT_END_SILENCE_MS;
    const maxUtteranceMs = options.max_utterance_ms ?? DEFAULT_MAX_UTTERANCE_MS;
    const sttTimeoutMs = options.stt_timeout_ms ?? DEFAULT_STT_TIMEOUT_MS;
    for (const [label, value] of [
      ["min speech", minSpeechMs],
      ["end silence", endSilenceMs],
      ["max utterance", maxUtteranceMs],
    ] as const) {
      if (!Number.isInteger(value) || value < FRAME_MS || value % FRAME_MS !== 0) {
        throw new RangeError(`${label} must be a positive multiple of 20 ms`);
      }
    }
    if (maxUtteranceMs * 32 > STT_MAX_PCM_BYTES) {
      throw new RangeError("max utterance exceeds the bounded STT PCM request");
    }
    if (minSpeechMs > maxUtteranceMs) {
      throw new RangeError("minimum speech cannot exceed maximum utterance");
    }
    if (!Number.isInteger(sttTimeoutMs) || sttTimeoutMs < 1_000 || sttTimeoutMs > 120_000) {
      throw new RangeError("STT timeout must be between 1000 and 120000 ms");
    }
    const maxResults = options.max_results ?? 256;
    if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > MAX_RESULTS) {
      throw new RangeError("STT result history must be bounded");
    }
    this.#options = options;
    this.#vadPeakThreshold = vadPeakThreshold;
    this.#minSpeechFrames = boundedFrames(minSpeechMs / FRAME_MS, "min speech");
    this.#endSilenceFrames = boundedFrames(endSilenceMs / FRAME_MS, "end silence");
    this.#maxUtteranceFrames = boundedFrames(maxUtteranceMs / FRAME_MS, "max utterance");
    this.#sttTimeoutMs = sttTimeoutMs;
    this.#maxResults = maxResults;
  }

  public onSessionOpen(summary: VoiceCaptureSummary): void {
    if (this.#closed) throw new TypeError("voice STT pipeline is closed");
    const previous = this.#latestEpoch.get(summary.device_id) ?? -1;
    if (summary.status !== "active" || summary.epoch <= previous || this.#active.has(sessionKey(summary))) {
      throw new TypeError("voice STT session must be a new active epoch");
    }
    this.#latestEpoch.set(summary.device_id, summary.epoch);
    this.#inflightByDevice.get(summary.device_id)?.abort(new DOMException("superseded", "AbortError"));
    this.#inflightByDevice.delete(summary.device_id);
    this.#options.on_capture_open?.(structuredClone(summary));
    this.#active.set(sessionKey(summary), {
      summary: structuredClone(summary),
      frames: [],
      totalFrames: 0,
      speechFrames: 0,
      trailingSilenceFrames: 0,
      endpointReached: false,
      tooLong: false,
    });
  }

  public onFrame(summary: VoiceCaptureSummary, frame: DecodedVoiceFrame): void {
    if (this.#closed) throw new TypeError("voice STT pipeline is closed");
    const state = this.#active.get(sessionKey(summary));
    const payloadBytes = frame.payload.byteLength;
    const eos = (frame.header.flags & VOICE_FLAG_END_OF_STREAM) !== 0;
    const payloadGeometryValid = payloadBytes === FRAME_BYTES || (
      eos
      && payloadBytes >= 2
      && payloadBytes < FRAME_BYTES
      && payloadBytes % 2 === 0
      && frame.header.frameSamples * 2 === payloadBytes
    );
    if (state === undefined || !identityMatches(summary, frame) || !payloadGeometryValid) {
      throw new TypeError("voice STT frame does not match its active PCM session");
    }
    if (state.endpointReached) return;
    state.totalFrames++;
    if (state.totalFrames > this.#maxUtteranceFrames) {
      state.tooLong = true;
      return;
    }
    const energy = frameEnergy(frame.payload);
    const speech = energy.peak >= this.#vadPeakThreshold
      && energy.rms >= Math.max(1, Math.floor(this.#vadPeakThreshold / 3));
    const fullFrame = payloadBytes === FRAME_BYTES;
    if (speech && fullFrame) {
      state.speechFrames++;
      state.trailingSilenceFrames = 0;
    } else if (!speech && fullFrame && state.speechFrames > 0) {
      state.trailingSilenceFrames++;
    }
    state.frames.push(Buffer.from(frame.payload));
    if (state.speechFrames > 0 && state.trailingSilenceFrames >= this.#endSilenceFrames) {
      state.endpointReached = true;
    }
  }

  public onSessionClosed(summary: VoiceCaptureSummary): void {
    if (this.#closed) return;
    const key = sessionKey(summary);
    const state = this.#active.get(key);
    if (state === undefined) return;
    this.#active.delete(key);
    if (summary.status !== "completed" || !summary.eos) {
      this.#record(state, "cancelled", null, 0);
      return;
    }
    const operation = this.#transcribeAndDispatch(state);
    this.#pending.add(operation);
    void operation.finally(() => this.#pending.delete(operation));
  }

  public onDeviceDisconnect(deviceId: string): void {
    this.#inflightByDevice.get(deviceId)?.abort(new DOMException("device disconnected", "AbortError"));
    this.#inflightByDevice.delete(deviceId);
  }

  public async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#inflightByDevice.values()) {
      controller.abort(new DOMException("pipeline closed", "AbortError"));
    }
    this.#inflightByDevice.clear();
    for (const state of this.#active.values()) this.#record(state, "cancelled", null, 0);
    this.#active.clear();
    this.#latestEpoch.clear();
  }

  public get results(): readonly VoiceSttResult[] {
    return structuredClone(this.#results);
  }

  public get active_count(): number { return this.#active.size; }
  public get known_device_count(): number { return this.#latestEpoch.size; }
  public get inflight_count(): number { return this.#inflightByDevice.size; }
  public get pending_count(): number { return this.#pending.size; }

  async #transcribeAndDispatch(state: CaptureState): Promise<void> {
    if ((this.#latestEpoch.get(state.summary.device_id) ?? -1) !== state.summary.epoch) {
      this.#record(state, "stale", null, 0);
      return;
    }
    if (state.tooLong) {
      this.#record(state, "too_long", null, 0);
      return;
    }
    if (state.speechFrames === 0) {
      this.#record(state, "silence", null, 0);
      return;
    }
    if (state.speechFrames < this.#minSpeechFrames) {
      this.#record(state, "too_short", null, 0);
      return;
    }
    const pcm = Buffer.concat(state.frames);
    const controller = new AbortController();
    const sttDeadline = new AbortController();
    this.#inflightByDevice.set(state.summary.device_id, controller);
    const timer = setTimeout(
      () => sttDeadline.abort(new DOMException("STT deadline exceeded", "TimeoutError")),
      this.#sttTimeoutMs,
    );
    timer.unref();
    const providerSignal = AbortSignal.any([controller.signal, sttDeadline.signal]);
    let partialsSeen = 0;
    let lastPartialSequence = -1;
    try {
      let detachProviderAbort = (): void => undefined;
      const providerAborted = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(
          providerSignal.reason instanceof Error
            ? providerSignal.reason
            : new DOMException("STT provider cancelled", "AbortError"),
        );
        detachProviderAbort = (): void => providerSignal.removeEventListener("abort", onAbort);
        if (providerSignal.aborted) onAbort();
        else providerSignal.addEventListener("abort", onAbort, { once: true });
      });
      const providerWork = this.#options.provider.transcribe({
        session_id: state.summary.session_id,
        stream_id: state.summary.stream_id,
        epoch: state.summary.epoch,
        pcm,
        sample_rate_hz: STT_SAMPLE_RATE_HZ,
        channels: STT_CHANNELS,
        sample_bits: STT_SAMPLE_BITS,
        language: "zh",
      }, {
        signal: providerSignal,
        on_partial: (partial) => {
          if (
            transcriptMatches(partial, state.summary)
            && Number.isInteger(partial.sequence)
            && partial.sequence > lastPartialSequence
            && transcriptIsBounded(partial.text)
            && partialsSeen < MAX_PARTIAL_TRANSCRIPTS
            && !this.#closed
            && !providerSignal.aborted
            && (this.#latestEpoch.get(state.summary.device_id) ?? -1) === state.summary.epoch
          ) {
            lastPartialSequence = partial.sequence;
            partialsSeen++;
            this.#options.on_partial_ui?.(structuredClone(partial));
          }
        },
      });
      let transcript: SttFinalTranscript;
      try {
        transcript = await Promise.race([providerWork, providerAborted]);
      } finally {
        detachProviderAbort();
        clearTimeout(timer);
      }
      if (sttDeadline.signal.aborted) {
        this.#record(state, "timed_out", null, partialsSeen);
        return;
      }
      if (controller.signal.aborted
          || (this.#latestEpoch.get(state.summary.device_id) ?? -1) !== state.summary.epoch) {
        this.#record(state, "stale", null, partialsSeen);
        return;
      }
      if (!transcriptMatches(transcript, state.summary) || !transcriptIsBounded(transcript.text)) {
        throw new SttProviderError("INVALID_RESPONSE", "final transcript identity is invalid");
      }
      if (transcript.text.trim().length === 0) {
        this.#record(state, "empty_transcript", null, partialsSeen);
        return;
      }
      const digest = createHash("sha256")
        .update(`${state.summary.device_id}\0${state.summary.session_id}\0${state.summary.stream_id}\0${state.summary.epoch}`)
        .digest("hex")
        .slice(0, 24);
      const interaction: UserTextInteraction = {
        schema_version: 1,
        interaction_id: `voice:${digest}`,
        kind: "user_text",
        text: transcript.text,
        locale: "zh-CN",
        source: "voice",
        received_at_ms: (this.#options.clock ?? Date.now)(),
      };
      try {
        await this.#options.dispatch_final(interaction, controller.signal, {
          device_id: state.summary.device_id,
          session_id: state.summary.session_id,
          stream_id: state.summary.stream_id,
          epoch: state.summary.epoch,
        });
      } catch {
        this.#record(
          state,
          controller.signal.aborted ? "stale" : "dispatch_failed",
          interaction.interaction_id,
          partialsSeen,
        );
        return;
      }
      this.#record(state, "dispatched", interaction.interaction_id, partialsSeen);
    } catch (error) {
      const outcome: VoiceSttOutcome = sttDeadline.signal.aborted
        ? "timed_out"
        : controller.signal.aborted
          ? "stale"
          : error instanceof SttProviderError && error.code === "TIMEOUT"
            ? "timed_out"
            : "provider_error";
      this.#record(state, outcome, null, partialsSeen);
    } finally {
      clearTimeout(timer);
      if (this.#inflightByDevice.get(state.summary.device_id) === controller) {
        this.#inflightByDevice.delete(state.summary.device_id);
      }
      pcm.fill(0);
      for (const frame of state.frames) frame.fill(0);
    }
  }

  #record(
    state: CaptureState,
    outcome: VoiceSttOutcome,
    interactionId: string | null,
    partialsSeen: number,
  ): void {
    for (const frame of state.frames) frame.fill(0);
    if (this.#maxResults === 0) return;
    this.#results.push({
      device_id: state.summary.device_id,
      session_id: state.summary.session_id,
      stream_id: state.summary.stream_id,
      epoch: state.summary.epoch,
      outcome,
      interaction_id: interactionId,
      pcm_bytes: state.frames.reduce((total, frame) => total + frame.byteLength, 0),
      speech_frames: state.speechFrames,
      partials_seen: partialsSeen,
    });
    if (this.#results.length > this.#maxResults) this.#results.shift();
  }
}
