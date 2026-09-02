import assert from "node:assert/strict";
import test from "node:test";

import {
  PythonTtsProvider,
  TTS_MODEL_REVISION,
  TTS_PROVIDER_VERSION,
  TTS_ROLE_VOICES,
} from "@p4home/provider-tts";

const enabled = process.env.P4HOME_TTS_LIVE === "1";

function absoluteEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || !value.startsWith("/")) {
    throw new TypeError(`${name} must be an absolute path`);
  }
  return value;
}

test("live pinned Kokoro worker emits bounded non-silent 16 kHz PCM without a raw-audio path", {
  skip: !enabled,
  timeout: 120_000,
}, async () => {
  const python = absoluteEnv("P4HOME_TTS_PYTHON");
  const worker = absoluteEnv("P4HOME_TTS_WORKER");
  const model = absoluteEnv("P4HOME_TTS_MODEL");

  const provider = new PythonTtsProvider({
    python_executable: python,
    worker_script: worker,
    model_path: model,
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 120_000,
  });
  const request = {
    interaction_id: "tts:live:human:1",
    assignment_id: "assignment:human:1",
    segment_index: 0,
    role_id: "human",
    text: "你好，我是小贝。",
    voice: TTS_ROLE_VOICES.human,
    language: "zh",
    sample_rate_hz: 16_000,
    channels: 1,
    sample_bits: 16,
  } as const;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let nonzero = false;
  try {
    for await (const chunk of provider.stream(request)) {
      assert.equal(chunk.chunk_index, chunks.length);
      assert.equal(chunk.sample_rate_hz, 16_000);
      assert.equal(chunk.channels, 1);
      assert.equal(chunk.sample_bits, 16);
      assert.equal(chunk.pcm.byteLength, chunk.samples * 2);
      assert.equal("path" in chunk, false);
      bytes += chunk.pcm.byteLength;
      nonzero ||= chunk.pcm.some((byte) => byte !== 0);
      chunks.push(chunk.pcm);
    }
    assert.ok(chunks.length > 1);
    assert.ok(bytes > 640);
    assert.ok(bytes <= 1_920_000);
    assert.equal(nonzero, true);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    provider.close();
  }
});
