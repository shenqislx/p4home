import assert from "node:assert/strict";
import test from "node:test";

import {
  PythonSttProvider,
  pythonSttProviderInternals,
  STT_CHANNELS,
  STT_SAMPLE_BITS,
  STT_SAMPLE_RATE_HZ,
  STT_MODEL_REVISION,
  SttProviderError,
  type SttTranscriptionRequest,
} from "@p4home/provider-stt";

const REQUEST: SttTranscriptionRequest = {
  session_id: "00112233445566778899aabbccddeeff",
  stream_id: 7,
  epoch: 9,
  pcm: new Uint8Array(640),
  sample_rate_hz: STT_SAMPLE_RATE_HZ,
  channels: STT_CHANNELS,
  sample_bits: STT_SAMPLE_BITS,
  language: "zh",
};

test("STT provider freezes Python, model revision and PCM geometry", () => {
  assert.doesNotThrow(() => new PythonSttProvider({
    python_executable: "/opt/p4home-stt/bin/python",
    worker_script: "/opt/p4home-stt/p4home_stt_worker.py",
    model_path: "/opt/p4home-stt/models/whisper-small",
    model_revision: STT_MODEL_REVISION,
    provider_version: "0.4.3",
  }));
  assert.throws(() => new PythonSttProvider({
    python_executable: "python3",
    worker_script: "/worker.py",
    model_path: "/model",
    model_revision: "main",
    provider_version: "0.4.3",
  }));
  assert.throws(() => new PythonSttProvider({
    python_executable: "/opt/p4home-stt/bin/python",
    worker_script: "/opt/p4home-stt/p4home_stt_worker.py",
    model_path: "/opt/p4home-stt/models/whisper-small",
    model_revision: "a".repeat(40),
    provider_version: "0.4.3",
  }), /pinned/);
  assert.doesNotThrow(() => pythonSttProviderInternals.validateRequest(REQUEST));
  assert.throws(() => pythonSttProviderInternals.validateRequest({
    ...REQUEST,
    pcm: new Uint8Array(641),
  }));
});

test("a real worker MODEL_UNAVAILABLE terminal preserves its non-retryable error code", async () => {
  const provider = new PythonSttProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL("../fixtures/stt-worker-model-unavailable.py", import.meta.url).pathname,
    model_path: "/private/tmp/p4home-missing-model",
    model_revision: STT_MODEL_REVISION,
    provider_version: "0.4.3",
  });
  await assert.rejects(provider.transcribe(REQUEST), (error: unknown) => {
    assert.ok(error instanceof SttProviderError);
    assert.equal(error.code, "MODEL_UNAVAILABLE");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("STT worker response is identity-bound, Python 3.12-only and bounded", () => {
  const valid = pythonSttProviderInternals.validateWorkerResponse({
    schema_version: 1,
    status: "completed",
    session_id: REQUEST.session_id,
    stream_id: REQUEST.stream_id,
    epoch: REQUEST.epoch,
    text: "打开客厅灯",
    language: "zh",
    duration_ms: 321.5,
    python_version: "3.12.12",
  }, REQUEST);
  assert.equal(valid.text, "打开客厅灯");
  assert.throws(() => pythonSttProviderInternals.validateWorkerResponse({
    ...valid,
    status: "completed",
    python_version: "3.14.3",
  }, REQUEST), SttProviderError);
  assert.throws(() => pythonSttProviderInternals.validateWorkerResponse({
    schema_version: 1,
    status: "completed",
    session_id: "ffeeddccbbaa99887766554433221100",
    stream_id: REQUEST.stream_id,
    epoch: REQUEST.epoch,
    text: "打开客厅灯",
    language: "zh",
    duration_ms: 1,
    python_version: "3.12.12",
  }, REQUEST), SttProviderError);
  assert.throws(() => pythonSttProviderInternals.validateWorkerResponse({
    schema_version: 1,
    status: "completed",
    session_id: REQUEST.session_id,
    stream_id: REQUEST.stream_id,
    epoch: REQUEST.epoch,
    text: "你好",
    language: "zh",
    duration_ms: 120_001,
    python_version: "3.12.12",
  }, REQUEST), SttProviderError);
});
