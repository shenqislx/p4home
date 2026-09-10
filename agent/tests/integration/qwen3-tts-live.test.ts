import assert from "node:assert/strict";
import test from "node:test";
import { PythonTtsProvider, QWEN3_TTS_MODEL_REVISION, QWEN3_TTS_ROLE_VOICES,
  TTS_PROVIDER_VERSION, TtsProviderError, type TtsSynthesisRequest } from "@p4home/provider-tts";

const enabled = process.env.P4HOME_TTS_QWEN3_LIVE === "1";
function env(name: string): string {
  const value = process.env[name];
  if (!value?.startsWith("/")) throw new TypeError(`absolute ${name} required`);
  return value;
}

test("live Qwen3 streams both role voices, cancels and recovers with a fresh worker", {
  skip: !enabled, timeout: 120_000,
}, async () => {
  const provider = new PythonTtsProvider({
    python_executable: env("P4HOME_TTS_PYTHON"), worker_script: env("P4HOME_TTS_WORKER"),
    model_path: env("P4HOME_TTS_QWEN3_MODEL"), model_revision: QWEN3_TTS_MODEL_REVISION,
    provider_version: TTS_PROVIDER_VERSION, timeout_ms: 120_000,
  });
  const request = (role: "human" | "robot", text: string, id: string): TtsSynthesisRequest => ({
    interaction_id: `qwen3:live:${id}`, assignment_id: `assignment:${id}`, segment_index: 0,
    role_id: role, text, voice: QWEN3_TTS_ROLE_VOICES[role], language: "zh",
    sample_rate_hz: 16_000, channels: 1, sample_bits: 16,
  });
  try {
    await provider.warmup();
    for (const role of ["human", "robot"] as const) {
      let count = 0, bytes = 0, nonzero = false;
      for await (const chunk of provider.stream(request(role, "你好，我已经准备好了。", role))) {
        assert.equal(chunk.voice, QWEN3_TTS_ROLE_VOICES[role]);
        assert.equal(chunk.chunk_index, count++);
        assert.equal(chunk.pcm.byteLength, chunk.samples * 2);
        bytes += chunk.pcm.byteLength;
        nonzero ||= chunk.pcm.some(v => v !== 0);
        chunk.pcm.fill(0);
      }
      assert.ok(count > 1 && bytes > 640 && bytes <= 1_920_000 && nonzero);
    }
    const controller = new AbortController();
    await assert.rejects(async () => {
      for await (const chunk of provider.stream(request("human", "这是一个需要中途取消的语音测试。".repeat(10), "cancel"), { signal: controller.signal })) {
        chunk.pcm.fill(0);
        controller.abort();
      }
    }, (error: unknown) => error instanceof TtsProviderError && error.code === "CANCELLED");
    const recovered = await provider.synthesize(request("human", "现在可以继续了。", "recovered"));
    assert.ok(recovered.samples > 320);
    assert.equal(recovered.voice, QWEN3_TTS_ROLE_VOICES.human);
    recovered.pcm.fill(0);
  } finally { provider.close(); }
});
