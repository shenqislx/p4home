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

test("worker chunks stay on protocol stdout while model diagnostics are redirected", async () => {
  const tts = provider("tts-worker-ok.py");
  try {
    const result = await tts.synthesize(REQUEST);
    assert.equal(result.interaction_id, REQUEST.interaction_id);
    assert.equal(result.assignment_id, REQUEST.assignment_id);
    assert.equal(result.role_id, "human");
    assert.equal(result.voice, TTS_ROLE_VOICES.human);
    assert.equal(result.pcm.byteLength, 640);
    assert.equal(result.samples, 320);
    assert.equal(result.sample_rate_hz, 16_000);
    result.pcm.fill(0);
  } finally {
    tts.close();
  }
});

test("TTS stream yields the first PCM chunk before synthesis terminal", async () => {
  const tts = provider("tts-worker-incremental.py");
  try {
    const iterator = tts.stream(REQUEST)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.kind, "pcm_chunk");
    assert.equal(first.value?.chunk_index, 0);
    assert.equal(first.value?.pcm.byteLength, 640);
    first.value?.pcm.fill(0);
    const secondPending = iterator.next();
    assert.equal(await Promise.race([
      secondPending.then(() => "second" as const),
      new Promise<"still_streaming">((resolve) => setTimeout(() => resolve("still_streaming"), 50)),
    ]), "still_streaming");
    const second = await secondPending;
    assert.equal(second.done, false);
    assert.equal(second.value?.chunk_index, 1);
    second.value?.pcm.fill(0);
    assert.equal((await iterator.next()).done, true);
  } finally {
    tts.close();
  }
});

test("TTS rejects unsafe text before spawn and preserves bounded structured speech", async () => {
  const tts = provider("tts-worker-ok.py");
  try {
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
    healthy.pcm.fill(0);
  } finally {
    tts.close();
  }
});

test("worker model errors are explicit and non-retryable", async () => {
  const tts = provider("tts-worker-model-unavailable.py");
  try {
    await assert.rejects(tts.synthesize(REQUEST), (error: unknown) => {
      assert.ok(error instanceof TtsProviderError);
      assert.equal(error.code, "MODEL_UNAVAILABLE");
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    tts.close();
  }
});

test("abort kills a non-cooperative TTS worker promptly", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const tts = provider("tts-worker-slow.py", 5_000);
  try {
    const pending = tts.synthesize(REQUEST, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("barge in")), 20);
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof TtsProviderError);
      assert.equal(error.code, "CANCELLED");
      return true;
    });
    assert.ok(performance.now() - started < 1_000);
  } finally {
    tts.close();
  }
});

test("timeout kills a non-cooperative resident worker with retryable TIMEOUT", async () => {
  const tts = provider("tts-worker-slow.py", 1_000);
  try {
    await assert.rejects(tts.synthesize(REQUEST), (error: unknown) => {
      assert.ok(error instanceof TtsProviderError);
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    });
  } finally {
    tts.close();
  }
});

test("abort discards the resident worker and the next request starts from a clean process", async () => {
  let invocations = 0;
  const tts = new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL("../fixtures/tts-worker-controlled.py", import.meta.url).pathname,
    model_path: "/private/tmp/p4home-tts-model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 5_000,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      invocations++;
      return spawn(...args);
    }) as typeof spawn,
  });
  try {
    const controller = new AbortController();
    const slow = tts.synthesize({ ...REQUEST, text: "慢请求。" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(slow, (error: unknown) => (
      error instanceof TtsProviderError && error.code === "CANCELLED"
    ));
    const healthy = await tts.synthesize(REQUEST);
    assert.equal(healthy.pcm.byteLength, 640);
    healthy.pcm.fill(0);
    assert.equal(invocations, 2);
  } finally {
    tts.close();
  }
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
  try {
    const started = performance.now();
    await assert.rejects(racingProvider.synthesize(REQUEST, { signal: controller.signal }),
      (error: unknown) => error instanceof TtsProviderError && error.code === "CANCELLED");
    assert.ok(performance.now() - started < 1_000);
  } finally {
    racingProvider.close();
  }
});

test("TTS warmup is one-time and keeps one resident worker for later requests", async () => {
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
  try {
    await Promise.all([tts.warmup(), tts.warmup()]);
    await tts.warmup();
    assert.equal(invocations, 1);
    const healthy = await tts.synthesize(REQUEST);
    assert.equal(healthy.pcm.byteLength, 640);
    healthy.pcm.fill(0);
    assert.equal(invocations, 1);
  } finally {
    tts.close();
  }
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
  try {
    await assert.rejects(tts.warmup(), TtsProviderError);
    await assert.rejects(tts.warmup(), TtsProviderError);
    assert.equal(invocations, 1);
  } finally {
    tts.close();
  }
});

test("resident worker serializes concurrent requests without identity crossover", async () => {
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
  try {
    const [first, second] = await Promise.all([
      tts.synthesize(REQUEST),
      tts.synthesize({ ...REQUEST, assignment_id: "assignment:human:2", segment_index: 1 }),
    ]);
    assert.equal(first.assignment_id, "assignment:human:1");
    assert.equal(second.assignment_id, "assignment:human:2");
    assert.equal(invocations, 1);
    first.pcm.fill(0);
    second.pcm.fill(0);
  } finally {
    tts.close();
  }
});

test("cancelling a queued request does not kill the worker serving the active stream", async () => {
  let invocations = 0;
  const tts = new PythonTtsProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL("../fixtures/tts-worker-incremental.py", import.meta.url).pathname,
    model_path: "/private/tmp/p4home-tts-model",
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 1_000,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      invocations++;
      return spawn(...args);
    }) as typeof spawn,
  });
  try {
    const active = tts.synthesize(REQUEST);
    const controller = new AbortController();
    const queued = tts.synthesize({
      ...REQUEST, assignment_id: "assignment:human:queued", segment_index: 1,
    }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(queued, (error: unknown) => (
      error instanceof TtsProviderError && error.code === "CANCELLED"
    ));
    const activeResult = await active;
    activeResult.pcm.fill(0);
    const later = await tts.synthesize(REQUEST);
    later.pcm.fill(0);
    assert.equal(invocations, 1);
  } finally {
    tts.close();
  }
});

test("Python source accumulator rejects a multi-chunk overrun before concatenation", () => {
  const output = execFileSync("/usr/bin/python3", [
    "-I",
    new URL("../fixtures/tts-bounds.py", import.meta.url).pathname,
    new URL("../../packages/provider-tts/python/tts_bounds.py", import.meta.url).pathname,
  ], { encoding: "utf8" });
  assert.equal(output.trim(), "source-bound:PASS");
});

test("worker stream rejects extra keys, identity, sequence, PCM and terminal mismatches", () => {
  const ready = {
    schema_version: 2,
    status: "ready",
    provider_version: TTS_PROVIDER_VERSION,
    model_revision: TTS_MODEL_REVISION,
    python_version: "3.12.12",
  };
  assert.doesNotThrow(() => pythonTtsProviderInternals.validateWorkerReady(ready));
  assert.throws(() => pythonTtsProviderInternals.validateWorkerReady({
    ...ready, transcript: "leak",
  }), /unexpected fields/);

  const chunk = {
    schema_version: 2,
    status: "chunk",
    interaction_id: REQUEST.interaction_id,
    assignment_id: REQUEST.assignment_id,
    segment_index: REQUEST.segment_index,
    role_id: REQUEST.role_id,
    voice: REQUEST.voice,
    chunk_index: 0,
    pcm_base64: Buffer.alloc(640).toString("base64"),
    sample_rate_hz: 16_000,
    channels: 1,
    sample_bits: 16,
    samples: 320,
    duration_ms: 20,
    final: false,
  };
  const valid = pythonTtsProviderInternals.validateWorkerChunk(chunk, REQUEST, 0);
  assert.equal(valid.pcm.byteLength, 640);
  valid.pcm.fill(0);
  for (const invalid of [
    { ...chunk, role_id: "robot" },
    { ...chunk, chunk_index: 1 },
    { ...chunk, samples: 321 },
    { ...chunk, duration_ms: Number.NaN },
    { ...chunk, final: true },
  ]) {
    assert.throws(() => pythonTtsProviderInternals.validateWorkerChunk(invalid, REQUEST, 0),
      TtsProviderError);
  }

  const terminal = {
    schema_version: 2,
    status: "completed",
    interaction_id: REQUEST.interaction_id,
    assignment_id: REQUEST.assignment_id,
    segment_index: REQUEST.segment_index,
    role_id: REQUEST.role_id,
    voice: REQUEST.voice,
    chunk_count: 1,
    pcm_bytes: 640,
    sample_rate_hz: 16_000,
    channels: 1,
    sample_bits: 16,
    samples: 320,
    duration_ms: 20,
    python_version: "3.12.12",
  };
  assert.doesNotThrow(() => pythonTtsProviderInternals.validateWorkerTerminal(
    terminal, REQUEST, { chunks: 1, bytes: 640, samples: 320 },
  ));
  assert.throws(() => pythonTtsProviderInternals.validateWorkerTerminal(
    { ...terminal, pcm_bytes: 638 }, REQUEST, { chunks: 1, bytes: 640, samples: 320 },
  ), /terminal totals/);
  assert.throws(() => pythonTtsProviderInternals.validateWorkerTerminal({
    schema_version: 2,
    status: "error",
    interaction_id: REQUEST.interaction_id,
    assignment_id: REQUEST.assignment_id,
    segment_index: REQUEST.segment_index,
    role_id: "robot",
    voice: TTS_ROLE_VOICES.robot,
    error_code: "PROCESS_ERROR",
  }, REQUEST, { chunks: 0, bytes: 0, samples: 0 }), /error identity/);
});
