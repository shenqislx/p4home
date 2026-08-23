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

  const result = await new PythonTtsProvider({
    python_executable: python,
    worker_script: worker,
    model_path: model,
    model_revision: TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION,
    timeout_ms: 120_000,
  }).synthesize({
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
  });

  assert.equal(result.sample_rate_hz, 16_000);
  assert.equal(result.channels, 1);
  assert.equal(result.sample_bits, 16);
  assert.equal(result.pcm.byteLength, result.samples * 2);
  assert.ok(result.pcm.byteLength > 640);
  assert.ok(result.pcm.byteLength <= 1_920_000);
  assert.ok(result.pcm.some((byte) => byte !== 0));
  assert.equal("path" in result, false);
});
