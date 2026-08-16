import assert from "node:assert/strict";
import test from "node:test";

import { createMockP4HomeDomain } from "@p4home/domain-p4home";
import {
  createJsonLineLogger,
  runTextAgent,
} from "@p4home/runtime";
import {
  OllamaProviderError,
  type OllamaChatResult,
  type OllamaProvider,
} from "@p4home/provider-ollama";
import { SqliteAuditStore } from "@p4home/storage-sqlite";

async function seedSession(store: SqliteAuditStore): Promise<void> {
  await store.saveAgentProfile({
    agent_profile_id: "profile-audit",
    name: "P4 Home",
    locale: "zh-CN",
    allowed_tools: ["character.go_to_room"],
  });
  await store.saveSession({
    session_id: "session-audit",
    agent_profile_id: "profile-audit",
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
  });
}

function response(
  content: string,
  toolCalls: NonNullable<OllamaChatResult["message"]["tool_calls"]> = [],
): OllamaChatResult {
  return {
    model: "test-model",
    message: {
      role: "assistant",
      content,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    },
  };
}

test("text agent persists messages, tool calls, results and events as one run trace", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seedSession(store);
  const responses = [
    response("", [
      {
        type: "function",
        function: {
          index: 0,
          name: "character.go_to_room",
          arguments: { room_id: "study" },
        },
      },
    ]),
    response("已经到书房。"),
  ];
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      const next = responses.shift();
      assert.ok(next !== undefined);
      return next;
    },
  };
  const logLines: string[] = [];
  let now = 1_100;

  const result = await runTextAgent({
    run_id: "run-audit",
    user_text: "去书房",
    provider,
    tools: createMockP4HomeDomain().tools,
    audit: {
      store,
      session_id: "session-audit",
      clock: () => now++,
      logger: createJsonLineLogger({
        clock: () => now++,
        sink: (line) => logLines.push(line),
      }),
    },
  });
  const trace = await store.getRunTrace("run-audit");

  assert.equal(result.status, "completed");
  assert.ok(trace !== null);
  assert.equal(trace.run.status, "completed");
  assert.deepEqual(
    trace.messages.map((message) => message.role),
    ["system", "user", "assistant", "tool", "assistant"],
  );
  assert.equal(trace.tool_calls[0]?.status, "success");
  assert.deepEqual(trace.tool_calls[0]?.arguments, { room_id: "study" });
  assert.equal(
    trace.events.find((event) => event.type === "tool.completed")?.payload.tool_call_id,
    "run-audit:tool:1",
  );
  assert.deepEqual(
    trace.events.map((event) => event.type),
    [
      "run.started",
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.completed",
      "model.requested",
      "model.completed",
      "run.completed",
    ],
  );
  assert.equal(logLines.length, trace.events.length);
  const finalLog = JSON.parse(logLines.at(-1) ?? "null") as Record<string, unknown>;
  assert.equal(finalLog.event, "run.completed");
  assert.equal(finalLog.run_id, "run-audit");
  assert.equal(finalLog.session_id, "session-audit");
});

test("JSON line logger redacts secret-shaped fields and survives circular data", () => {
  const lines: string[] = [];
  const logger = createJsonLineLogger({
    clock: () => 123,
    sink: (line) => lines.push(line),
  });
  const data: Record<string, unknown> = {
    api_token: "secret-value",
    prompt_tokens: 42,
    nested: { password: "hidden", safe: "visible" },
  };
  data.circular = data;

  logger.log({
    level: "info",
    event: "review.test",
    run_id: "run-log",
    session_id: "session-log",
    tool_call_id: "tool-call-log",
    action_id: "action-log",
    data,
  });

  const parsed = JSON.parse(lines[0] ?? "null") as {
    occurred_at_ms: number;
    tool_call_id: string;
    action_id: string;
    data: Record<string, unknown>;
  };
  assert.equal(parsed.occurred_at_ms, 123);
  assert.equal(parsed.tool_call_id, "tool-call-log");
  assert.equal(parsed.action_id, "action-log");
  assert.equal(parsed.data.api_token, "[REDACTED]");
  assert.equal(parsed.data.prompt_tokens, 42);
  assert.deepEqual(parsed.data.nested, { password: "[REDACTED]", safe: "visible" });
  assert.equal(parsed.data.circular, "[Circular]");
  assert.equal(lines[0]?.includes("secret-value"), false);
  assert.equal(lines[0]?.includes("hidden"), false);
});

test("thrown model contract failures leave a terminal failed audit trace", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seedSession(store);
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      return response("", [
        {
          type: "function",
          function: {
            index: 0,
            name: "fabricated.tool",
            arguments: {},
          },
        },
      ]);
    },
  };

  await assert.rejects(
    runTextAgent({
      run_id: "run-audit-failure",
      user_text: "执行不存在的工具",
      provider,
      tools: createMockP4HomeDomain().tools,
      audit: { store, session_id: "session-audit", clock: () => 2_000 },
    }),
  );
  const trace = await store.getRunTrace("run-audit-failure");

  assert.ok(trace !== null);
  assert.equal(trace.run.status, "failed");
  assert.equal(trace.run.completed_at_ms, 2_000);
  assert.deepEqual(
    trace.events.map((event) => event.type),
    ["run.started", "model.requested", "model.completed", "run.failed"],
  );
  assert.equal(trace.events.at(-1)?.payload.error_code, "UNKNOWN_TOOL");
});

test("an optional structured-log sink failure does not change the persisted run result", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seedSession(store);
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      return response("完成。");
    },
  };

  const result = await runTextAgent({
    run_id: "run-log-sink-failure",
    user_text: "回复完成",
    provider,
    tools: createMockP4HomeDomain().tools,
    audit: {
      store,
      session_id: "session-audit",
      logger: createJsonLineLogger({
        sink(): void {
          throw new Error("log pipe closed");
        },
      }),
    },
  });
  const trace = await store.getRunTrace("run-log-sink-failure");

  assert.equal(result.status, "completed");
  assert.equal(trace?.run.status, "completed");
  assert.equal(trace?.events.at(-1)?.type, "run.completed");
});

test("an audited run exposes only tools allowed by its session profile", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seedSession(store);
  let exposedTools: readonly string[] = [];
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(request): Promise<OllamaChatResult> {
      exposedTools = (request.tools ?? []).map((tool) => tool.function.name);
      return response("完成。");
    },
  };

  const result = await runTextAgent({
    run_id: "run-profile-allowlist",
    user_text: "完成测试",
    provider,
    tools: createMockP4HomeDomain().tools,
    audit: { store, session_id: "session-audit" },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(exposedTools, ["character.go_to_room"]);
});

test("a backward wall clock is clamped without losing a completed tool outcome", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seedSession(store);
  const domain = createMockP4HomeDomain();
  const responses = [
    response("", [{
      type: "function",
      function: {
        index: 0,
        name: "character.go_to_room",
        arguments: { room_id: "study" },
      },
    }]),
    response("已完成。"),
  ];
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      const next = responses.shift();
      assert.ok(next !== undefined);
      return next;
    },
  };
  let now = 2_000;

  const result = await runTextAgent({
    run_id: "run-clock-rollback",
    user_text: "去书房",
    provider,
    tools: domain.tools,
    audit: {
      store,
      session_id: "session-audit",
      clock: () => now--,
    },
  });
  const trace = await store.getRunTrace("run-clock-rollback");

  assert.equal(result.status, "completed");
  assert.equal(domain.getState().room_id, "study");
  assert.equal(trace?.run.status, "completed");
  assert.equal(trace?.tool_calls[0]?.status, "success");
  assert.equal(trace?.events.at(-1)?.type, "run.completed");
});

test("a returned provider timeout uses a distinct terminal audit event", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seedSession(store);
  const provider: Pick<OllamaProvider, "chat"> = {
    async chat(): Promise<OllamaChatResult> {
      throw new OllamaProviderError("TIMEOUT", "model timeout", { retryable: true });
    },
  };

  const result = await runTextAgent({
    run_id: "run-audit-timeout",
    user_text: "等待",
    provider,
    tools: createMockP4HomeDomain().tools,
    audit: { store, session_id: "session-audit" },
  });
  const trace = await store.getRunTrace("run-audit-timeout");

  assert.equal(result.status, "timed_out");
  assert.equal(trace?.run.status, "timed_out");
  assert.equal(trace?.events.at(-1)?.type, "run.timed_out");
});
