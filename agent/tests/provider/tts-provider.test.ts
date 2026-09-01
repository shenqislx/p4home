import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  PythonTtsProvider,
  pythonTtsProviderInternals,
  TTS_CHANNELS,
  TTS_MAX_TEXT_CHARS,
  TTS_MODEL_REVISION,
  TTS_PROVIDER_VERSION,
  TTS_ROLE_VOICES,
  TTS_SAMPLE_BITS,
  TTS_SAMPLE_RATE_HZ,
  TtsProviderError,
  type TtsSynthesisRequest,
} from "@p4home/provider-tts";

const REQUEST: TtsSynthesisRequest = {
  interaction_id: "voice:00112233445566778899aabb",
  assignment_id: "assignment:human:1",
  segment_index: 0,
  role_id: "human",
  text: "我听到了。",
  voice: TTS_ROLE_VOICES.human,
  language: "zh",
  sample_rate_hz: TTS_SAMPLE_RATE_HZ,
  channels: TTS_CHANNELS,
  sample_bits: TTS_SAMPLE_BITS,
};

function provider(worker: string, timeoutMs = 1_000): PythonTtsProvider {
  return new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL(`../fixtures/${worker}`, import.meta.url).pathname,
    model_path: "/private/tmp/p4home-tts-model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: timeoutMs,
  });
}

test("TTS provider freezes Python, model revision, role voice and PCM geometry", () => {
  assert.doesNotThrow(() => pythonTtsProviderInternals.validateRequest(REQUEST));
  assert.throws(() => pythonTtsProviderInternals.validateRequest({
    ...REQUEST,
    voice: TTS_ROLE_VOICES.robot,
  }), /frozen role voice/);
  assert.throws(() => pythonTtsProviderInternals.validateRequest({ ...REQUEST, text: " bad " }), /trimmed/);
  assert.throws(() => new PythonTtsProvider({
    python_executable: "python3",
    worker_script: "/worker.py",
    model_path: "/model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
  }), /absolute/);
  assert.throws(() => new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: "/worker.py",
    model_path: "/model",
    model_revision: "a".repeat(40),
    provider_version: TTS_PROVIDER_VERSION,
  }), /pinned/);
});

test("real worker round trip returns identity-bound 16 kHz PCM", async () => {
  const result = await provider("tts-worker-ok.py").synthesize(REQUEST);
  assert.equal(result.interaction_id, REQUEST.interaction_id);
  assert.equal(result.assignment_id, REQUEST.assignment_id);
  assert.equal(result.role_id, "human");
  assert.equal(result.voice, TTS_ROLE_VOICES.human);
  assert.equal(result.pcm.byteLength, 640);
  assert.equal(result.samples, 320);
  assert.equal(result.sample_rate_hz, 16_000);
});

test("TTS rejects unsafe text before spawn and preserves bounded structured speech", async () => {
  const tts = provider("tts-worker-ok.py");
  for (const text of [
    "长".repeat(TTS_MAX_TEXT_CHARS + 1),
    "正常文本\u0000伪造终态",
  ]) {
    await assert.rejects(tts.synthesize({ ...REQUEST, text }), TypeError);
  }

  const healthy = await tts.synthesize({
    ...REQUEST,
    text: '{"示例":"结构化文本也只是需要朗读的内容"}',
  });
  assert.equal(healthy.kind, "final_pcm");
  assert.equal(healthy.pcm.byteLength, 640);
});

test("worker model errors are explicit and non-retryable", async () => {
  await assert.rejects(provider("tts-worker-model-unavailable.py").synthesize(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof TtsProviderError);
      assert.equal(error.code, "MODEL_UNAVAILABLE");
      assert.equal(error.retryable, false);
      return true;
    });
});

test("abort kills a non-cooperative TTS worker promptly", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const pending = provider("tts-worker-slow.py", 5_000).synthesize(REQUEST, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("barge in")), 20);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof TtsProviderError);
    assert.equal(error.code, "CANCELLED");
    return true;
  });
  assert.ok(performance.now() - started < 1_000);
});

test("abort during process spawn cannot be lost before listener registration", async () => {
  const controller = new AbortController();
  const racingProvider = new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL("../fixtures/tts-worker-slow.py", import.meta.url).pathname,
    model_path: "/private/tmp/p4home-tts-model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 5_000,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      controller.abort(new Error("spawn race"));
      return spawn(...args);
    }) as typeof spawn,
  });
  const started = performance.now();
  await assert.rejects(racingProvider.synthesize(REQUEST, { signal: controller.signal }),
    (error: unknown) => error instanceof TtsProviderError && error.code === "CANCELLED");
  assert.ok(performance.now() - started < 1_000);
});

test("TTS warmup is one-time and leaves the next one-shot invocation healthy", async () => {
  let invocations = 0;
  const tts = new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL("../fixtures/tts-worker-ok.py", import.meta.url).pathname,
    model_path: "/private/tmp/p4home-tts-model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 1_000,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      invocations++;
      return spawn(...args);
    }) as typeof spawn,
  });
  await Promise.all([tts.warmup(), tts.warmup()]);
  await tts.warmup();
  assert.equal(invocations, 1);
  const healthy = await tts.synthesize(REQUEST);
  assert.equal(healthy.pcm.byteLength, 640);
  assert.equal(invocations, 2);
});

test("TTS warmup failure is cached and keeps readiness fail-closed", async () => {
  let invocations = 0;
  const tts = new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL(
      "../fixtures/tts-worker-model-unavailable.py", import.meta.url,
    ).pathname,
    model_path: "/private/tmp/p4home-tts-model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 1_000,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      invocations++;
      return spawn(...args);
    }) as typeof spawn,
  });
  await assert.rejects(tts.warmup(), TtsProviderError);
  await assert.rejects(tts.warmup(), TtsProviderError);
  assert.equal(invocations, 1);
});

test("Python source accumulator rejects a multi-chunk overrun before concatenation", () => {
  const output = execFileSync("/usr/bin/python3", [
    "-I",
    new URL("../fixtures/tts-bounds.py", import.meta.url).pathname,
    new URL("../../packages/provider-tts/python/tts_bounds.py", import.meta.url).pathname,
  ], { encoding: "utf8" });
  assert.equal(output.trim(), "source-bound:PASS");
});

test("worker response rejects identity, Python and PCM size mismatches", () => {
  const base = {
    schema_version: 1,
    status: "completed",
    interaction_id: REQUEST.interaction_id,
    assignment_id: REQUEST.assignment_id,
    segment_index: REQUEST.segment_index,
    role_id: REQUEST.role_id,
    voice: REQUEST.voice,
    pcm_base64: Buffer.alloc(640).toString("base64"),
    sample_rate_hz: 16_000,
    channels: 1,
    sample_bits: 16,
    samples: 320,
    duration_ms: 20,
    python_version: "3.12.12",
  };
  assert.doesNotThrow(() => pythonTtsProviderInternals.validateWorkerResponse(base, REQUEST));
  assert.throws(() => pythonTtsProviderInternals.validateWorkerResponse({
    ...base, role_id: "robot",
  }, REQUEST), TtsProviderError);
  assert.throws(() => pythonTtsProviderInternals.validateWorkerResponse({
    ...base, python_version: "3.14.0",
  }, REQUEST), TtsProviderError);
  assert.throws(() => pythonTtsProviderInternals.validateWorkerResponse({
    ...base, samples: 321,
  }, REQUEST), /PCM is malformed/);
  assert.throws(() => pythonTtsProviderInternals.validateWorkerResponse({
    ...base, duration_ms: 120_000,
  }, REQUEST), /duration does not match/);
  assert.throws(() => pythonTtsProviderInternals.validateWorkerResponse({
    schema_version: 1,
    status: "error",
    interaction_id: REQUEST.interaction_id,
    assignment_id: REQUEST.assignment_id,
    segment_index: REQUEST.segment_index,
    role_id: "robot",
    voice: TTS_ROLE_VOICES.robot,
    error_code: "PROCESS_ERROR",
  }, REQUEST), /error identity/);
});
