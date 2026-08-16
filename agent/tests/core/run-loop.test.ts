import assert from "node:assert/strict";
import test from "node:test";

import {
  runSequentialToolCalls,
  ToolExecutionError,
  ToolLoopConfigurationError,
  type ToolDefinition,
} from "@p4home/core";

test("tool calls execute in order and wait for terminal success", async () => {
  const order: string[] = [];
  const tools = new Map<string, ToolDefinition>([
    [
      "first",
      {
        name: "first",
        async execute() {
          order.push("first:start");
          await Promise.resolve();
          order.push("first:end");
          return { value: 1 };
        },
      },
    ],
    [
      "second",
      {
        name: "second",
        async execute() {
          order.push("second:start");
          return { value: 2 };
        },
      },
    ],
  ]);

  const result = await runSequentialToolCalls({
    run_id: "run-1",
    tools,
    calls: [
      { tool_call_id: "call-1", name: "first", arguments: {} },
      { tool_call_id: "call-2", name: "second", arguments: {} },
    ],
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
  assert.equal(result.results.length, 2);
});

test("terminal tool error stops remaining calls", async () => {
  let secondRan = false;
  const tools = new Map<string, ToolDefinition>([
    [
      "fail",
      {
        name: "fail",
        async execute() {
          throw new ToolExecutionError("INVALID_ARGUMENT", "bad input");
        },
      },
    ],
    [
      "second",
      {
        name: "second",
        async execute() {
          secondRan = true;
          return {};
        },
      },
    ],
  ]);

  const result = await runSequentialToolCalls({
    run_id: "run-2",
    tools,
    calls: [
      { tool_call_id: "call-1", name: "fail", arguments: {} },
      { tool_call_id: "call-2", name: "second", arguments: {} },
    ],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.error?.code, "INVALID_ARGUMENT");
  assert.equal(secondRan, false);
});

test("tool errors are normalized to the frozen result message limit", async () => {
  const tools = new Map<string, ToolDefinition>([
    [
      "fail",
      {
        name: "fail",
        async execute() {
          throw new Error("x".repeat(300));
        },
      },
    ],
  ]);

  const result = await runSequentialToolCalls({
    run_id: "run-long-error",
    tools,
    calls: [{ tool_call_id: "call-long-error", name: "fail", arguments: {} }],
  });

  assert.equal(result.status, "failed");
  assert.equal(result.results[0]?.error?.code, "INTERNAL");
  assert.equal(result.results[0]?.error?.message.length, 256);
});

test("duplicate IDs and more than four calls are rejected before execution", async () => {
  const tools = new Map<string, ToolDefinition>();
  await assert.rejects(
    runSequentialToolCalls({
      run_id: "run-3",
      tools,
      calls: [
        { tool_call_id: "same", name: "x", arguments: {} },
        { tool_call_id: "same", name: "x", arguments: {} },
      ],
    }),
    ToolLoopConfigurationError,
  );
  await assert.rejects(
    runSequentialToolCalls({
      run_id: "run-4",
      tools,
      calls: Array.from({ length: 5 }, (_value, index) => ({
        tool_call_id: `call-${index}`,
        name: "x",
        arguments: {},
      })),
    }),
    ToolLoopConfigurationError,
  );
});

test("relative timeout terminates a tool that ignores cancellation", async () => {
  const tools = new Map<string, ToolDefinition>([
    [
      "slow",
      {
        name: "slow",
        execute: async () => await new Promise<Record<string, unknown>>(() => undefined),
      },
    ],
  ]);
  const result = await runSequentialToolCalls({
    run_id: "run-timeout",
    tools,
    timeout_ms: 100,
    calls: [{ tool_call_id: "slow-1", name: "slow", arguments: {} }],
  });
  assert.equal(result.status, "timed_out");
  assert.equal(result.results[0]?.error?.code, "DEADLINE_EXCEEDED");
});

test("relative timeout rejects non-finite and fractional values", async () => {
  for (const timeout_ms of [Number.NaN, Number.POSITIVE_INFINITY, 100.5]) {
    await assert.rejects(
      runSequentialToolCalls({
        run_id: "run-invalid-timeout",
        tools: new Map(),
        timeout_ms,
        calls: [],
      }),
      ToolLoopConfigurationError,
    );
  }
});

test("AbortSignal cancels an active tool", async () => {
  const controller = new AbortController();
  const tools = new Map<string, ToolDefinition>([
    [
      "wait",
      {
        name: "wait",
        execute: async () => await new Promise<Record<string, unknown>>(() => undefined),
      },
    ],
  ]);
  setTimeout(() => controller.abort(), 0);
  const result = await runSequentialToolCalls({
    run_id: "run-cancel",
    tools,
    signal: controller.signal,
    calls: [{ tool_call_id: "wait-1", name: "wait", arguments: {} }],
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.results[0]?.error?.code, "CANCELLED");
});

test("an abort during tool lookup is observed before execution starts", async () => {
  const controller = new AbortController();
  let executed = false;
  const tools = new Map<string, ToolDefinition>([
    [
      "wait",
      {
        name: "wait",
        async execute() {
          executed = true;
          return {};
        },
      },
    ],
  ]);
  const originalGet = tools.get.bind(tools);
  tools.get = (name: string): ToolDefinition | undefined => {
    controller.abort(new Error("abort during lookup"));
    return originalGet(name);
  };

  const result = await runSequentialToolCalls({
    run_id: "run-cancel-race",
    tools,
    signal: controller.signal,
    calls: [{ tool_call_id: "wait-race", name: "wait", arguments: {} }],
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.results[0]?.error?.code, "CANCELLED");
  assert.equal(executed, false);
});
