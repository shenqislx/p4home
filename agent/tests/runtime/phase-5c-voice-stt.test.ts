import assert from "node:assert/strict";
import test from "node:test";

import {
  STT_CHANNELS,
  STT_SAMPLE_BITS,
  STT_SAMPLE_RATE_HZ,
  SttProviderError,
  type SttFinalTranscript,
  type SttProvider,
  type SttTranscriptionOptions,
  type SttTranscriptionRequest,
} from "@p4home/provider-stt";
import {
  RoleScheduler,
  RoleSessionRegistry,
  PHASE5C_EXPECTED_TRANSCRIPT_SHA256,
  PHASE5C_MAX_VOICE_ATTEMPTS,
  UnifiedVoiceRoleDispatcher,
  VoiceSttPipeline,
  phase5cTranscriptMatches,
  phase5cTranscriptSha256,
  phase5cAttemptDecision,
  type UserTextInteraction,
  type VoiceCaptureSummary,
} from "@p4home/runtime";
import { VOICE_FLAG_END_OF_STREAM, type DecodedVoiceFrame } from "@p4home/contracts";
import type { OllamaChatResult } from "@p4home/provider-ollama";

const SESSION_ID = "00112233445566778899aabbccddeeff";

function summary(
  epoch: number,
  status: VoiceCaptureSummary["status"] = "active",
  eos = false,
): VoiceCaptureSummary {
  return {
    device_id: "p4-test",
    session_id: SESSION_ID,
    stream_id: 7,
    epoch,
    status,
    frames: 0,
    bytes: 0,
    dropped_frames: 0,
    peak_abs: 0,
    eos,
  };
}

function frame(epoch: number, sequence: number, amplitude: number): DecodedVoiceFrame {
  const payload = new Uint8Array(640);
  const view = new DataView(payload.buffer);
  for (let offset = 0; offset < payload.byteLength; offset += 2) {
    view.setInt16(offset, amplitude, true);
  }
  return {
    header: {
      kind: "capture_pcm",
      flags: 0,
      sessionId: Buffer.from(SESSION_ID, "hex"),
      streamId: 7,
      epoch,
      sequence,
      captureTimeUs: BigInt(sequence * 20_000),
      payloadBytes: 640,
      sampleRateHz: STT_SAMPLE_RATE_HZ,
      frameSamples: 320,
      channels: STT_CHANNELS,
      bitsPerSample: STT_SAMPLE_BITS,
    },
    payload,
  };
}

function impulseFrame(epoch: number, sequence: number, amplitude: number): DecodedVoiceFrame {
  const value = frame(epoch, sequence, 0);
  new DataView(value.payload.buffer, value.payload.byteOffset, value.payload.byteLength)
    .setInt16(0, amplitude, true);
  return value;
}

function shortEosFrame(epoch: number, sequence: number, amplitude: number): DecodedVoiceFrame {
  const payload = new Uint8Array(2);
  new DataView(payload.buffer).setInt16(0, amplitude, true);
  const value = frame(epoch, sequence, 0);
  return {
    header: {
      ...value.header,
      flags: VOICE_FLAG_END_OF_STREAM,
      payloadBytes: payload.byteLength,
      frameSamples: 1,
    },
    payload,
  };
}

function completeSession(pipeline: VoiceSttPipeline, epoch: number, speechFrames = 15): void {
  const active = summary(epoch);
  pipeline.onSessionOpen(active);
  let sequence = 0;
  for (; sequence < speechFrames; sequence++) pipeline.onFrame(active, frame(epoch, sequence, 1200));
  for (let silence = 0; silence < 40; silence++, sequence++) {
    pipeline.onFrame(active, frame(epoch, sequence, 0));
  }
  pipeline.onSessionClosed(summary(epoch, "completed", true));
}

class FakeSttProvider implements SttProvider {
  public requests: SttTranscriptionRequest[] = [];
  public text = "打开客厅灯";
  public error: Error | null = null;

  public async transcribe(
    request: SttTranscriptionRequest,
    options: SttTranscriptionOptions = {},
  ): Promise<SttFinalTranscript> {
    this.requests.push({ ...request, pcm: request.pcm.slice() });
    options.on_partial?.({
      schema_version: 1,
      kind: "partial",
      session_id: request.session_id,
      stream_id: request.stream_id,
      epoch: request.epoch,
      sequence: 0,
      text: "打开",
      language: "zh",
    });
    if (this.error !== null) throw this.error;
    return {
      schema_version: 1,
      kind: "final",
      session_id: request.session_id,
      stream_id: request.stream_id,
      epoch: request.epoch,
      text: this.text,
      language: "zh",
      duration_ms: 10,
    };
  }
}

test("only an active final transcript enters the existing user_text voice boundary", async () => {
  const provider = new FakeSttProvider();
  const partials: string[] = [];
  const dispatched: UserTextInteraction[] = [];
  const pipeline = new VoiceSttPipeline({
    provider,
    on_partial_ui: (partial) => partials.push(partial.text),
    dispatch_final: async (interaction) => { dispatched.push(structuredClone(interaction)); },
    clock: () => 1234,
  });

  completeSession(pipeline, 1);
  await pipeline.drain();

  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.pcm.byteLength, 55 * 640);
  assert.deepEqual(partials, ["打开"]);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    schema_version: 1,
    interaction_id: dispatched[0]?.interaction_id,
    kind: "user_text",
    text: "打开客厅灯",
    locale: "zh-CN",
    source: "voice",
    received_at_ms: 1234,
  });
  assert.match(dispatched[0]?.interaction_id ?? "", /^voice:[0-9a-f]{24}$/);
  assert.equal(pipeline.results[0]?.outcome, "dispatched");

  pipeline.onSessionClosed(summary(1, "completed", true));
  await pipeline.drain();
  assert.equal(dispatched.length, 1, "duplicate terminal must not create another Interaction");
});

test("device disconnect aborts in-flight STT before any final transcript dispatch", async () => {
  let providerStarted = false;
  let dispatches = 0;
  const provider: SttProvider = {
    async transcribe(): Promise<SttFinalTranscript> {
      providerStarted = true;
      return await new Promise<SttFinalTranscript>(() => undefined);
    },
  };
  const pipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: async () => { dispatches++; },
  });
  completeSession(pipeline, 101);
  while (!providerStarted) await new Promise((resolve) => setImmediate(resolve));
  pipeline.onDeviceDisconnect("p4-test");
  await pipeline.drain();

  assert.equal(dispatches, 0);
  assert.equal(pipeline.results[0]?.outcome, "stale");
});

test("a legal short EOS tail reaches STT without inflating the minimum speech duration", async () => {
  const provider = new FakeSttProvider();
  const pipeline = new VoiceSttPipeline({ provider, dispatch_final: async () => undefined });
  const active = summary(1);
  pipeline.onSessionOpen(active);
  let sequence = 0;
  for (; sequence < 15; sequence++) pipeline.onFrame(active, frame(1, sequence, 1_200));
  for (let silence = 0; silence < 10; silence++, sequence++) {
    pipeline.onFrame(active, frame(1, sequence, 0));
  }
  pipeline.onFrame(active, shortEosFrame(1, sequence, 1_200));
  pipeline.onSessionClosed(summary(1, "completed", true));
  await pipeline.drain();

  assert.equal(provider.requests[0]?.pcm.byteLength, 25 * 640 + 2);
  assert.equal(pipeline.results[0]?.pcm_bytes, 25 * 640 + 2);
  assert.equal(pipeline.results[0]?.speech_frames, 15);
  assert.equal(pipeline.results[0]?.outcome, "dispatched");

  const invalid = summary(2);
  pipeline.onSessionOpen(invalid);
  const shortWithoutEos = shortEosFrame(2, 0, 0);
  assert.throws(() => pipeline.onFrame(invalid, {
    ...shortWithoutEos,
    header: { ...shortWithoutEos.header, flags: 0 },
  }), /does not match/);
});

test("Phase 5C fixed transcript gate tolerates punctuation only and rejects hallucinations", () => {
  assert.equal(phase5cTranscriptSha256("你好, 请介绍一下你自己。"),
    PHASE5C_EXPECTED_TRANSCRIPT_SHA256);
  assert.equal(phase5cTranscriptMatches("你好，请介绍一下你自己！"), true);
  assert.equal(phase5cTranscriptMatches("打开客厅灯"), false);
  assert.equal(PHASE5C_MAX_VOICE_ATTEMPTS, 3);
  assert.equal(phase5cAttemptDecision(["silence"]), "continue");
  assert.equal(phase5cAttemptDecision(["silence", "provider_error", "too_short"]), "fail");
  assert.equal(phase5cAttemptDecision(["silence", "dispatched"]), "pass");
});

test("silence, short speech, cancellation and empty final transcript execute nothing", async () => {
  const provider = new FakeSttProvider();
  const dispatched: UserTextInteraction[] = [];
  const pipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: async (interaction) => { dispatched.push(interaction); },
  });

  const silent = summary(1);
  pipeline.onSessionOpen(silent);
  for (let index = 0; index < 50; index++) pipeline.onFrame(silent, frame(1, index, 0));
  pipeline.onSessionClosed(summary(1, "completed", true));

  const short = summary(2);
  pipeline.onSessionOpen(short);
  for (let index = 0; index < 5; index++) pipeline.onFrame(short, frame(2, index, 1000));
  pipeline.onSessionClosed(summary(2, "completed", true));

  const cancelled = summary(3);
  pipeline.onSessionOpen(cancelled);
  for (let index = 0; index < 20; index++) pipeline.onFrame(cancelled, frame(3, index, 1000));
  pipeline.onSessionClosed(summary(3, "cancelled", false));

  provider.text = "   ";
  completeSession(pipeline, 4);
  await pipeline.drain();

  assert.equal(dispatched.length, 0);
  assert.deepEqual(pipeline.results.map((result) => result.outcome), [
    "silence", "too_short", "cancelled", "empty_transcript",
  ]);
});

test("provider errors and stale epochs never create guessed or replayed text", async () => {
  const provider = new FakeSttProvider();
  provider.error = new SttProviderError("MODEL_UNAVAILABLE", "offline");
  let dispatches = 0;
  const pipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: async () => { dispatches++; },
  });
  completeSession(pipeline, 1);
  await pipeline.drain();
  provider.error = new SttProviderError("TIMEOUT", "deadline", { retryable: true });
  completeSession(pipeline, 2);
  await pipeline.drain();
  assert.equal(dispatches, 0);
  assert.equal(pipeline.results[0]?.outcome, "provider_error");
  assert.equal(pipeline.results[1]?.outcome, "timed_out");
  assert.throws(() => pipeline.onSessionOpen(summary(2)), /new active epoch/);
});

test("a superseded provider result is cancelled and cannot dispatch after a newer epoch", async () => {
  let calls = 0;
  const provider: SttProvider = {
    async transcribe(request, options) {
      calls++;
      if (calls === 1) {
        await new Promise<never>((_resolve, reject) => {
          const rejectCancelled = (): void => reject(
            new SttProviderError("CANCELLED", "superseded"),
          );
          if (options?.signal?.aborted === true) rejectCancelled();
          else options?.signal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      }
      return {
        schema_version: 1,
        kind: "final",
        session_id: request.session_id,
        stream_id: request.stream_id,
        epoch: request.epoch,
        text: "新的请求",
        language: "zh",
        duration_ms: 1,
      };
    },
  };
  const epochs: number[] = [];
  const pipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: async (interaction) => {
      assert.equal(interaction.text, "新的请求");
      epochs.push(2);
    },
  });

  completeSession(pipeline, 1);
  completeSession(pipeline, 2);
  await pipeline.drain();

  assert.deepEqual(epochs, [2]);
  assert.deepEqual(
    pipeline.results.map((result) => [result.epoch, result.outcome]).sort((left, right) =>
      Number(left[0]) - Number(right[0])),
    [[1, "stale"], [2, "dispatched"]],
  );
});

test("partial transcript identity is UI-only and cannot enter role dispatch", async () => {
  const provider: SttProvider = {
    async transcribe(request, options) {
      options?.on_partial?.({
        schema_version: 1,
        kind: "partial",
        session_id: "ffeeddccbbaa99887766554433221100",
        stream_id: request.stream_id,
        epoch: request.epoch,
        sequence: 0,
        text: "伪造 partial",
        language: "zh",
      });
      return {
        schema_version: 1,
        kind: "final",
        session_id: request.session_id,
        stream_id: request.stream_id,
        epoch: request.epoch,
        text: "你好",
        language: "zh",
        duration_ms: 5,
      };
    },
  };
  const partials: string[] = [];
  const finalTexts: string[] = [];
  const pipeline = new VoiceSttPipeline({
    provider,
    on_partial_ui: (partial) => partials.push(partial.text),
    dispatch_final: async (interaction) => { finalTexts.push(interaction.text); },
  });
  completeSession(pipeline, 1);
  await pipeline.drain();
  assert.deepEqual(partials, []);
  assert.deepEqual(finalTexts, ["你好"]);
  assert.equal(pipeline.results[0]?.partials_seen, 0);
});

test("VAD rejects isolated impulses and ignores frames after its deterministic endpoint", async () => {
  const provider = new FakeSttProvider();
  const pipeline = new VoiceSttPipeline({ provider, dispatch_final: async () => undefined });
  const noise = summary(1);
  pipeline.onSessionOpen(noise);
  for (let index = 0; index < 50; index++) {
    pipeline.onFrame(noise, impulseFrame(1, index, 1_000));
  }
  pipeline.onSessionClosed(summary(1, "completed", true));

  const active = summary(2);
  pipeline.onSessionOpen(active);
  let sequence = 0;
  for (; sequence < 15; sequence++) pipeline.onFrame(active, frame(2, sequence, 1_200));
  for (let index = 0; index < 40; index++, sequence++) {
    pipeline.onFrame(active, frame(2, sequence, 0));
  }
  for (let index = 0; index < 600; index++, sequence++) {
    pipeline.onFrame(active, frame(2, sequence, 1_200));
  }
  pipeline.onSessionClosed(summary(2, "completed", true));
  await pipeline.drain();

  assert.deepEqual(pipeline.results.map((result) => result.outcome), ["silence", "dispatched"]);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.pcm.byteLength, 55 * 640);
});

test("partial UI updates are strictly monotonic and bounded", async () => {
  const partials: number[] = [];
  const provider: SttProvider = {
    async transcribe(request, options) {
      for (const sequence of [0, 0, 2, 1, ...Array.from({ length: 200 }, (_, index) => index + 3)]) {
        options?.on_partial?.({
          schema_version: 1,
          kind: "partial",
          session_id: request.session_id,
          stream_id: request.stream_id,
          epoch: request.epoch,
          sequence,
          text: `partial-${sequence}`,
          language: "zh",
        });
      }
      return {
        schema_version: 1,
        kind: "final",
        session_id: request.session_id,
        stream_id: request.stream_id,
        epoch: request.epoch,
        text: "你好",
        language: "zh",
        duration_ms: 1,
      };
    },
  };
  const pipeline = new VoiceSttPipeline({
    provider,
    on_partial_ui: (partial) => partials.push(partial.sequence),
    dispatch_final: async () => undefined,
  });
  completeSession(pipeline, 1);
  await pipeline.drain();

  assert.equal(partials.length, 128);
  assert.equal(partials[0], 0);
  assert.equal(partials[1], 2);
  assert.equal(partials.at(-1), 128);
  assert.equal(pipeline.results[0]?.partials_seen, 128);
});

test("overlong audio and dispatch failures are terminal and never retried", async () => {
  const provider = new FakeSttProvider();
  const pipeline = new VoiceSttPipeline({
    provider,
    max_utterance_ms: 400,
    dispatch_final: async () => undefined,
  });
  const overlong = summary(1);
  pipeline.onSessionOpen(overlong);
  for (let index = 0; index < 21; index++) pipeline.onFrame(overlong, frame(1, index, 1_200));
  pipeline.onSessionClosed(summary(1, "completed", true));
  await pipeline.drain();

  assert.equal(provider.requests.length, 0);
  assert.deepEqual(pipeline.results.map((result) => result.outcome), ["too_long"]);

  let dispatches = 0;
  const failurePipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: async () => {
      dispatches++;
      throw new Error("unknown downstream outcome");
    },
  });
  completeSession(failurePipeline, 1);
  await failurePipeline.drain();

  assert.equal(provider.requests.length, 1);
  assert.equal(dispatches, 1);
  assert.deepEqual(failurePipeline.results.map((result) => result.outcome), ["dispatch_failed"]);
});

test("the STT deadline ends at final transcript and cannot cancel a later role dispatch", async () => {
  const provider = new FakeSttProvider();
  provider.transcribe = async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return {
      schema_version: 1,
      kind: "final",
      session_id: request.session_id,
      stream_id: request.stream_id,
      epoch: request.epoch,
      text: "你好",
      language: "zh",
      duration_ms: 900,
    };
  };
  let dispatchSignalAborted = false;
  const pipeline = new VoiceSttPipeline({
    provider,
    stt_timeout_ms: 1_000,
    dispatch_final: async (_interaction, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      dispatchSignalAborted = signal.aborted;
    },
  });
  completeSession(pipeline, 1);
  await pipeline.drain();
  assert.equal(dispatchSignalAborted, false);
  assert.equal(pipeline.results[0]?.outcome, "dispatched");
});

test("a non-cooperative provider cannot dispatch a final transcript after the STT deadline", async () => {
  const provider = new FakeSttProvider();
  provider.transcribe = async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return {
      schema_version: 1,
      kind: "final",
      session_id: request.session_id,
      stream_id: request.stream_id,
      epoch: request.epoch,
      text: "迟到文本",
      language: "zh",
      duration_ms: 1_100,
    };
  };
  let dispatches = 0;
  const pipeline = new VoiceSttPipeline({
    provider,
    stt_timeout_ms: 1_000,
    dispatch_final: async () => { dispatches++; },
  });
  completeSession(pipeline, 1);
  await pipeline.drain();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(dispatches, 0);
  assert.deepEqual(pipeline.results.map((result) => result.outcome), ["timed_out"]);
});

test("pipeline drain completes at its own deadline when the provider never settles", async () => {
  const provider = new FakeSttProvider();
  provider.transcribe = async () => await new Promise<SttFinalTranscript>(() => undefined);
  const pipeline = new VoiceSttPipeline({
    provider,
    stt_timeout_ms: 1_000,
    dispatch_final: async () => assert.fail("a hanging provider must not dispatch"),
  });
  completeSession(pipeline, 1);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pipeline.drain(),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error("pipeline drain remained blocked")), 2_000);
      }),
    ]);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
  }

  assert.deepEqual(pipeline.results.map((result) => result.outcome), ["timed_out"]);
});

test("close is permanent and rejects session callbacks after cancelling active work", async () => {
  const provider = new FakeSttProvider();
  let dispatches = 0;
  const pipeline = new VoiceSttPipeline({
    provider,
    dispatch_final: async () => { dispatches++; },
  });
  const active = summary(1);
  pipeline.onSessionOpen(active);
  for (let index = 0; index < 15; index++) pipeline.onFrame(active, frame(1, index, 1_200));
  pipeline.close();
  pipeline.onSessionClosed(summary(1, "completed", true));
  assert.throws(() => pipeline.onSessionOpen(summary(2)), /pipeline is closed/);
  assert.throws(() => pipeline.onFrame(active, frame(1, 16, 1_200)), /pipeline is closed/);
  await pipeline.drain();
  assert.equal(dispatches, 0);
  assert.deepEqual(pipeline.results.map((result) => result.outcome), ["cancelled"]);
});

test("final transcript uses the Phase 4 Router and Human session while Cat stays isolated", async () => {
  const stt = new FakeSttProvider();
  stt.text = "今天好累";
  const sessions = new RoleSessionRegistry({
    robot: "session:robot:voice",
    human: "session:human:voice",
    cat: "session:cat:voice",
  });
  const scheduler = new RoleScheduler();
  const roleResults: string[] = [];
  const dispatcher = new UnifiedVoiceRoleDispatcher({
    sessions,
    scheduler,
    clock: () => 2_000,
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        const router = request.messages[0]?.content.includes("Role Router") === true;
        return router
          ? {
              model: "fake",
              message: {
                role: "assistant",
                content: '{"assignments":[{"role":"human","text":"今天好累"}]}',
              },
            }
          : { model: "fake", message: { role: "assistant", content: "先休息一下吧。" } };
      },
    },
    on_result: (result) => { roleResults.push(result.response.text); },
  });
  const pipeline = new VoiceSttPipeline({
    provider: stt,
    dispatch_final: async (interaction, signal) => {
      await dispatcher.dispatch(interaction, signal);
    },
  });

  completeSession(pipeline, 1);
  await pipeline.drain();

  assert.deepEqual(roleResults, ["先休息一下吧。"]);
  assert.deepEqual(sessions.get("human").history().map((item) => item.content), [
    "今天好累", "先休息一下吧。",
  ]);
  assert.deepEqual(sessions.get("robot").history(), []);
  assert.deepEqual(sessions.get("cat").history(), []);
  scheduler.close();
});
