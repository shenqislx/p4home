import assert from "node:assert/strict";
import test from "node:test";

import {
  OllamaProviderError,
  type OllamaChatResult,
} from "@p4home/provider-ollama";
import {
  measureOllamaChatProvider,
  OLLAMA_CHAT_MAX_REQUEST_DURATION_MS,
  summarizeOllamaChatTimings,
  type OllamaChatCallTiming,
} from "@p4home/runtime";

const REQUEST = { messages: [{ role: "user" as const, content: "private input" }] };

test("chat timing keeps wall and Ollama usage without retaining request or response bodies", async () => {
  const ticks = [10, 22];
  const measured = measureOllamaChatProvider({
    async chat(): Promise<OllamaChatResult> {
      return {
        model: "qwen-test",
        message: { role: "assistant", content: "private output" },
        total_duration_ns: 9_000_000,
        load_duration_ns: 1_000_000,
        prompt_eval_count: 12,
        prompt_eval_duration_ns: 2_000_000,
        eval_count: 8,
        eval_duration_ns: 6_000_000,
      };
    },
  }, () => ticks.shift() ?? 22);

  await measured.provider.chat(REQUEST);
  const summary = measured.snapshot();

  assert.equal(summary.calls, 1);
  assert.equal(summary.request_total_ms, 12);
  assert.equal(summary.usage_complete_calls, 1);
  assert.deepEqual(summary.ollama_totals, {
    total_duration_ns: 9_000_000,
    load_duration_ns: 1_000_000,
    prompt_eval_count: 12,
    prompt_eval_duration_ns: 2_000_000,
    eval_count: 8,
    eval_duration_ns: 6_000_000,
  });
  assert.equal(summary.content_retained, false);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("private input"), false);
  assert.equal(serialized.includes("private output"), false);
});

test("chat timing accounts for missing usage, failures and cancellation terminals", async () => {
  let invocation = 0;
  let tick = 0;
  const measured = measureOllamaChatProvider({
    async chat(): Promise<OllamaChatResult> {
      invocation++;
      if (invocation === 1) {
        return { model: "fake", message: { role: "assistant", content: "ok" } };
      }
      if (invocation === 2) throw new Error("provider failed with private detail");
      throw new OllamaProviderError("CANCELLED", "private cancellation detail");
    },
  }, () => tick++ * 5);

  await measured.provider.chat(REQUEST);
  await assert.rejects(measured.provider.chat(REQUEST));
  await assert.rejects(measured.provider.chat(REQUEST));
  const summary = measured.snapshot();

  assert.deepEqual({
    calls: summary.calls,
    completed: summary.completed_calls,
    failed: summary.failed_calls,
    cancelled: summary.cancelled_calls,
    complete: summary.usage_complete_calls,
    missing: summary.usage_missing_calls,
  }, { calls: 3, completed: 1, failed: 1, cancelled: 1, complete: 0, missing: 3 });
  assert.equal(summary.request_total_ms, 15);
  assert.equal(JSON.stringify(summary).includes("private"), false);
});

test("chat timing distinguishes deadline expiry from cancellation", async () => {
  const timeout = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const measured = measureOllamaChatProvider({
    async chat(_request, signal): Promise<OllamaChatResult> {
      // A provider can flatten every abort into CANCELLED; the caller signal
      // still preserves whether the interaction deadline expired.
      assert.equal(signal?.aborted, true);
      throw new OllamaProviderError("CANCELLED", "private timeout detail");
    },
  });

  await assert.rejects(measured.provider.chat(REQUEST, timeout));
  assert.deepEqual({
    failed: measured.snapshot().failed_calls,
    cancelled: measured.snapshot().cancelled_calls,
    timedOut: measured.snapshot().timed_out_calls,
  }, { failed: 0, cancelled: 0, timedOut: 1 });
  assert.equal(JSON.stringify(measured.snapshot()).includes("private"), false);
});

test("a concurrent abort does not relabel an unrelated provider failure", async () => {
  const controller = new AbortController();
  const measured = measureOllamaChatProvider({
    async chat(): Promise<OllamaChatResult> {
      controller.abort();
      throw new Error("private provider failure");
    },
  });
  await assert.rejects(measured.provider.chat(REQUEST, controller.signal));
  assert.deepEqual({
    failed: measured.snapshot().failed_calls,
    cancelled: measured.snapshot().cancelled_calls,
  }, { failed: 1, cancelled: 0 });
});

test("chat timing is complete under concurrent out-of-order terminals", async () => {
  const terminals: Array<(value: OllamaChatResult) => void> = [];
  const measured = measureOllamaChatProvider({
    async chat(): Promise<OllamaChatResult> {
      return await new Promise((resolve) => terminals.push(resolve));
    },
  });
  const first = measured.provider.chat(REQUEST);
  const second = measured.provider.chat(REQUEST);
  terminals[1]?.({ model: "fake", message: { role: "assistant", content: "private second" } });
  terminals[0]?.({ model: "fake", message: { role: "assistant", content: "private first" } });
  await Promise.all([first, second]);

  const summary = measured.snapshot();
  assert.equal(summary.calls, 2);
  assert.equal(summary.completed_calls, 2);
  assert.equal(summary.call_details.length, 2);
  assert.equal(JSON.stringify(summary).includes("private"), false);
});

test("timing aggregation strips forged fields and normalizes unsafe numbers", () => {
  const forged = {
    schema_version: 1,
    status: "completed",
    request_duration_ms: Number.NaN,
    ollama: {
      total_duration_ns: Number.MAX_SAFE_INTEGER + 1,
      load_duration_ns: -1,
      prompt_eval_count: 1.5,
      prompt_eval_duration_ns: 2,
      eval_count: 3,
      eval_duration_ns: 4,
      response: "private nested response",
    },
    transcript: "private transcript",
    error: "private error",
  } as unknown as OllamaChatCallTiming;
  const summary = summarizeOllamaChatTimings([forged, {
    schema_version: 1,
    status: "failed",
    request_duration_ms: Number.MAX_SAFE_INTEGER,
    ollama: {
      total_duration_ns: null,
      load_duration_ns: null,
      prompt_eval_count: null,
      prompt_eval_duration_ns: null,
      eval_count: null,
      eval_duration_ns: null,
    },
  }]);

  assert.equal(summary.call_details[0]?.request_duration_ms, 0);
  assert.equal(
    summary.call_details[1]?.request_duration_ms,
    OLLAMA_CHAT_MAX_REQUEST_DURATION_MS,
  );
  assert.deepEqual(summary.call_details[0]?.ollama, {
    total_duration_ns: null,
    load_duration_ns: null,
    prompt_eval_count: null,
    prompt_eval_duration_ns: 2,
    eval_count: 3,
    eval_duration_ns: 4,
  });
  assert.equal(JSON.stringify(summary).includes("private"), false);
  assert.deepEqual(Object.keys(summary.call_details[0] ?? {}).sort(), [
    "ollama", "request_duration_ms", "schema_version", "status",
  ]);
});
