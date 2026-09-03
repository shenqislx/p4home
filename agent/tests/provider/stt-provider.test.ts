import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  PythonSttProvider,
  pythonSttProviderInternals,
  STT_CHANNELS,
  STT_SAMPLE_BITS,
  STT_SAMPLE_RATE_HZ,
  STT_MODEL_REVISION,
  STT_PROVIDER_VERSION,
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

const SLOW_WORKER = `
import json
import sys
import time
print(json.dumps({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "${STT_PROVIDER_VERSION}",
    "model_revision": "${STT_MODEL_REVISION}",
    "python_version": "3.12.12",
}, separators=(",", ":")), flush=True)
for line in sys.stdin:
    json.loads(line)
    time.sleep(10)
`;

const SUCCESS_WORKER = `
import json
import sys
print(json.dumps({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "${STT_PROVIDER_VERSION}",
    "model_revision": "${STT_MODEL_REVISION}",
    "python_version": "3.12.12",
}, separators=(",", ":")), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({
        "schema_version": 2,
        "status": "completed",
        "session_id": request["session_id"],
        "stream_id": request["stream_id"],
        "epoch": request["epoch"],
        "text": "打开客厅灯",
        "language": "zh",
        "duration_ms": 20.0,
        "python_version": "3.12.12",
    }, separators=(",", ":")), flush=True)
`;

const MODEL_UNAVAILABLE_WORKER = `
import json
print(json.dumps({
    "schema_version": 2,
    "status": "startup_error",
    "error_code": "MODEL_UNAVAILABLE",
}, separators=(",", ":")), flush=True)
`;

const WRONG_IDENTITY_WORKER = `
import json
import sys
print(json.dumps({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "${STT_PROVIDER_VERSION}",
    "model_revision": "${STT_MODEL_REVISION}",
    "python_version": "3.12.12",
}, separators=(",", ":")), flush=True)
request = json.loads(sys.stdin.readline())
print(json.dumps({
    "schema_version": 2,
    "status": "completed",
    "session_id": "wrong-session",
    "stream_id": request["stream_id"],
    "epoch": request["epoch"],
    "text": "越界结果",
    "language": "zh",
    "duration_ms": 20.0,
    "python_version": "3.12.12",
}, separators=(",", ":")), flush=True)
`;

const COUNTING_WORKER = `
import json
import sys
print(json.dumps({
    "schema_version": 2,
    "status": "ready",
    "provider_version": "${STT_PROVIDER_VERSION}",
    "model_revision": "${STT_MODEL_REVISION}",
    "python_version": "3.12.12",
}, separators=(",", ":")), flush=True)
requests = 0
for line in sys.stdin:
    request = json.loads(line)
    requests += 1
    print(json.dumps({
        "schema_version": 2,
        "status": "completed",
        "session_id": request["session_id"],
        "stream_id": request["stream_id"],
        "epoch": request["epoch"],
        "text": str(requests),
        "language": "zh",
        "duration_ms": 20.0,
        "python_version": "3.12.12",
    }, separators=(",", ":")), flush=True)
`;

function providerWithWorkerSequence(
  workers: readonly string[],
  timeoutMs: number,
  beforeSpawn?: (invocation: number) => void,
  idleTimeoutMs = 120_000,
): { readonly provider: PythonSttProvider; readonly children: ReturnType<typeof spawn>[] } {
  let invocation = 0;
  const children: ReturnType<typeof spawn>[] = [];
  const provider = new PythonSttProvider({
    python_executable: "/usr/bin/python3",
    worker_script: "/opt/p4home-stt/test-worker.py",
    model_path: "/private/tmp/p4home-stt-model",
    model_revision: STT_MODEL_REVISION,
    provider_version: STT_PROVIDER_VERSION,
    timeout_ms: timeoutMs,
    idle_timeout_ms: idleTimeoutMs,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      const currentInvocation = invocation++;
      beforeSpawn?.(currentInvocation);
      const child = spawn(
        args[0],
        ["-I", "-u", "-c", workers[currentInvocation] ?? SUCCESS_WORKER],
        args[2],
      );
      children.push(child);
      return child;
    }) as typeof spawn,
  });
  return { provider, children };
}

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
  assert.throws(() => new PythonSttProvider({
    python_executable: "/opt/p4home-stt/bin/python",
    worker_script: "/opt/p4home-stt/p4home_stt_worker.py",
    model_path: "/opt/p4home-stt/models/whisper-small",
    model_revision: STT_MODEL_REVISION,
    provider_version: STT_PROVIDER_VERSION,
    idle_timeout_ms: 600_001,
  }), /idle timeout/);
  assert.doesNotThrow(() => pythonSttProviderInternals.validateRequest(REQUEST));
  assert.throws(() => pythonSttProviderInternals.validateRequest({
    ...REQUEST,
    pcm: new Uint8Array(641),
  }));
});

test("a real worker MODEL_UNAVAILABLE terminal preserves its non-retryable error code", async (context) => {
  const provider = new PythonSttProvider({
    python_executable: "/usr/bin/python3",
    worker_script: new URL("../fixtures/stt-worker-model-unavailable.py", import.meta.url).pathname,
    model_path: "/private/tmp/p4home-missing-model",
    model_revision: STT_MODEL_REVISION,
    provider_version: "0.4.3",
  });
  context.after(() => provider.close());
  await assert.rejects(provider.transcribe(REQUEST), (error: unknown) => {
    assert.ok(error instanceof SttProviderError);
    assert.equal(error.code, "MODEL_UNAVAILABLE");
    assert.equal(error.retryable, false);
    return true;
  });
});

test("abort during process spawn cannot be lost and the next invocation remains healthy", async (context) => {
  const controller = new AbortController();
  const { provider, children } = providerWithWorkerSequence(
    [SLOW_WORKER, SUCCESS_WORKER],
    5_000,
    (invocation) => {
      if (invocation === 0) controller.abort(new Error("spawn race"));
    },
  );
  context.after(() => provider.close());

  const started = performance.now();
  await assert.rejects(provider.transcribe(REQUEST, { signal: controller.signal }),
    (error: unknown) => error instanceof SttProviderError && error.code === "CANCELLED");
  assert.ok(performance.now() - started < 1_000);
  assert.equal(children[0]?.killed, true);

  const result = await provider.transcribe(REQUEST);
  assert.equal(result.text, "打开客厅灯");
  assert.equal(children.length, 2);
});

test("timeout kills a real slow worker without poisoning the next invocation", async (context) => {
  const { provider, children } = providerWithWorkerSequence(
    [SLOW_WORKER, SUCCESS_WORKER],
    1_000,
  );
  context.after(() => provider.close());

  await assert.rejects(provider.transcribe(REQUEST), (error: unknown) => {
    assert.ok(error instanceof SttProviderError);
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(children[0]?.killed, true);

  const result = await provider.transcribe(REQUEST);
  assert.equal(result.text, "打开客厅灯");
  assert.equal(children.length, 2);
});

test("STT warmup is one-time and retains one resident worker for later requests", async (context) => {
  const { provider, children } = providerWithWorkerSequence(
    [SUCCESS_WORKER],
    5_000,
  );
  context.after(() => provider.close());
  await Promise.all([provider.warmup(), provider.warmup()]);
  await provider.warmup();
  assert.equal(children.length, 1);
  const result = await provider.transcribe(REQUEST);
  assert.equal(result.text, "打开客厅灯");
  assert.equal(children.length, 1);
});

test("STT warmup failure is cached and keeps readiness fail-closed", async (context) => {
  const { provider, children } = providerWithWorkerSequence(
    [MODEL_UNAVAILABLE_WORKER, SUCCESS_WORKER],
    5_000,
  );
  context.after(() => provider.close());
  await assert.rejects(provider.warmup(), SttProviderError);
  await assert.rejects(provider.warmup(), SttProviderError);
  assert.equal(children.length, 1);
});

test("STT worker response is identity-bound, Python 3.12-only and bounded", () => {
  const valid = pythonSttProviderInternals.validateWorkerResponse({
    schema_version: 2,
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
    schema_version: 2,
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
    schema_version: 2,
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

test("resident STT worker serializes concurrent requests without identity crossover", async (context) => {
  const { provider, children } = providerWithWorkerSequence([SUCCESS_WORKER], 5_000);
  context.after(() => provider.close());
  const secondRequest: SttTranscriptionRequest = {
    ...REQUEST,
    session_id: "second-session",
    stream_id: 8,
    epoch: 10,
  };
  const [first, second] = await Promise.all([
    provider.transcribe(REQUEST),
    provider.transcribe(secondRequest),
  ]);
  assert.equal(first.session_id, REQUEST.session_id);
  assert.equal(second.session_id, secondRequest.session_id);
  assert.equal(children.length, 1);
});

test("active cancellation discards the worker and the next request starts cleanly", async (context) => {
  const controller = new AbortController();
  const { provider, children } = providerWithWorkerSequence(
    [SLOW_WORKER, SUCCESS_WORKER],
    5_000,
  );
  context.after(() => provider.close());
  const active = provider.transcribe(REQUEST, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(active, (error: unknown) => (
    error instanceof SttProviderError && error.code === "CANCELLED"
  ));
  assert.equal(children[0]?.killed, true);
  const recovered = await provider.transcribe(REQUEST);
  assert.equal(recovered.text, "打开客厅灯");
  assert.equal(children.length, 2);
});

test("queued cancellation does not kill the worker serving the active request", async (context) => {
  const controller = new AbortController();
  const delayedWorker = SUCCESS_WORKER.replace(
    "request = json.loads(line)",
    "request = json.loads(line)\n    import time\n    time.sleep(0.1)",
  );
  const { provider, children } = providerWithWorkerSequence([delayedWorker], 5_000);
  context.after(() => provider.close());
  const active = provider.transcribe(REQUEST);
  const queued = provider.transcribe({ ...REQUEST, session_id: "queued-session" }, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(queued, (error: unknown) => (
    error instanceof SttProviderError && error.code === "CANCELLED"
  ));
  assert.equal((await active).text, "打开客厅灯");
  assert.equal((await provider.transcribe(REQUEST)).text, "打开客厅灯");
  assert.equal(children.length, 1);
});

test("identity protocol fault discards the worker and permits a safe restart", async (context) => {
  const { provider, children } = providerWithWorkerSequence(
    [WRONG_IDENTITY_WORKER, SUCCESS_WORKER],
    5_000,
  );
  context.after(() => provider.close());
  await assert.rejects(provider.transcribe(REQUEST), (error: unknown) => (
    error instanceof SttProviderError && error.code === "INVALID_RESPONSE"
  ));
  assert.equal(children[0]?.killed, true);
  assert.equal((await provider.transcribe(REQUEST)).text, "打开客厅灯");
  assert.equal(children.length, 2);
});

test("idle timeout retires the resident worker and the next request restarts it", async (context) => {
  const { provider, children } = providerWithWorkerSequence(
    [SUCCESS_WORKER, SUCCESS_WORKER],
    5_000,
    undefined,
    100,
  );
  context.after(() => provider.close());
  assert.equal((await provider.transcribe(REQUEST)).text, "打开客厅灯");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(children[0]?.killed, true);
  assert.equal((await provider.transcribe(REQUEST)).text, "打开客厅灯");
  assert.equal(children.length, 2);
});

test("capture refresh coalesces and reloads after idle without sending a transcript request", async (context) => {
  const { provider, children } = providerWithWorkerSequence(
    [COUNTING_WORKER, COUNTING_WORKER],
    5_000,
    undefined,
    100,
  );
  context.after(() => provider.close());
  await Promise.all([provider.refreshWarmup(), provider.refreshWarmup()]);
  assert.equal(children.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(children[0]?.killed, true);
  await Promise.all([provider.refreshWarmup(), provider.refreshWarmup()]);
  assert.equal(children.length, 2);
  const result = await provider.transcribe(REQUEST);
  assert.equal(result.text, "1", "prepare must not consume a transcription request");
});
