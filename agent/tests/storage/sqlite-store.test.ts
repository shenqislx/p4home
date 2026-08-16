import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuditStorageError,
  SqliteAuditStore,
} from "@p4home/storage-sqlite";

async function seed(store: SqliteAuditStore): Promise<void> {
  await store.saveAgentProfile({
    agent_profile_id: "profile-1",
    name: "P4 Home",
    locale: "zh-CN",
    allowed_tools: ["character.go_to_room"],
  });
  await store.saveSession({
    session_id: "session-1",
    agent_profile_id: "profile-1",
    created_at_ms: 100,
    updated_at_ms: 100,
  });
  await store.saveRun({
    run_id: "run-1",
    session_id: "session-1",
    status: "running",
    started_at_ms: 110,
    completed_at_ms: null,
  });
}

test("SQLite audit store persists a complete correlated run trace", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seed(store);
  await store.saveMessage({
    message_id: "message-1",
    session_id: "session-1",
    run_id: "run-1",
    role: "user",
    content: "去书房",
    tool_name: null,
    created_at_ms: 111,
    metadata: { locale: "zh-CN" },
  });
  await store.saveToolCall("run-1", {
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
  }, 112);
  await store.saveAction({
    action_id: "action-1",
    run_id: "run-1",
    tool_call_id: "tool-call-1",
    status: "completed",
    created_at_ms: 113,
  });
  await store.saveToolResult("run-1", {
    schema_version: 1,
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    status: "success",
    result: { room_id: "study" },
    error: null,
  }, 114);
  await store.appendEvent({
    event_id: "event-1",
    run_id: "run-1",
    type: "tool.completed",
    occurred_at_ms: 115,
    payload: { tool_call_id: "tool-call-1" },
  });
  await store.saveRun({
    run_id: "run-1",
    session_id: "session-1",
    status: "completed",
    started_at_ms: 110,
    completed_at_ms: 116,
  });

  const trace = await store.getRunTrace("run-1");

  assert.ok(trace !== null);
  assert.equal(trace.run.status, "completed");
  assert.equal(trace.messages[0]?.content, "去书房");
  assert.deepEqual(trace.tool_calls[0], {
    tool_call_id: "tool-call-1",
    run_id: "run-1",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
    status: "success",
    created_at_ms: 112,
    completed_at_ms: 114,
    result: { room_id: "study" },
    error: null,
  });
  assert.equal(trace.actions[0]?.action_id, "action-1");
  assert.equal(trace.events[0]?.type, "tool.completed");
  assert.equal(await store.getRunTrace("missing"), null);
});

test("SQLite constraints reject orphaned and cross-run audit records", async () => {
  using store = new SqliteAuditStore(":memory:");
  await assert.rejects(
    store.saveRun({
      run_id: "orphan-run",
      session_id: "missing-session",
      status: "running",
      started_at_ms: 1,
      completed_at_ms: null,
    }),
    /FOREIGN KEY constraint failed/,
  );

  await seed(store);
  await store.saveToolCall("run-1", {
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
  }, 112);
  await store.saveSession({
    session_id: "session-2",
    agent_profile_id: "profile-1",
    created_at_ms: 120,
    updated_at_ms: 120,
  });
  await store.saveRun({
    run_id: "run-2",
    session_id: "session-2",
    status: "running",
    started_at_ms: 121,
    completed_at_ms: null,
  });

  await assert.rejects(
    store.saveAction({
      action_id: "cross-run-action",
      run_id: "run-2",
      tool_call_id: "tool-call-1",
      status: "requested",
      created_at_ms: 122,
    }),
    /FOREIGN KEY constraint failed/,
  );
});

test("tool results terminate exactly one pending call and the store closes explicitly", async () => {
  const store = new SqliteAuditStore(":memory:");
  await seed(store);
  await store.saveToolCall("run-1", {
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
  }, 112);
  const result = {
    schema_version: 1 as const,
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    status: "success" as const,
    result: { room_id: "study" },
    error: null,
  };

  await store.saveToolResult("run-1", result, 113);
  await assert.rejects(
    store.saveToolResult("run-1", result, 114),
    AuditStorageError,
  );
  const trace = await store.getRunTrace("run-1");
  assert.equal(trace?.tool_calls[0]?.completed_at_ms, 113);

  store.close();
  await assert.rejects(store.getRunTrace("run-1"), AuditStorageError);
});

test("stored identities and terminal lifecycles cannot be rewritten", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seed(store);
  await store.saveToolCall("run-1", {
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
  }, 112);
  await store.saveAction({
    action_id: "action-1",
    run_id: "run-1",
    tool_call_id: "tool-call-1",
    status: "completed",
    created_at_ms: 113,
  });
  await store.saveToolResult("run-1", {
    schema_version: 1,
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    status: "success",
    result: { room_id: "study" },
    error: null,
  }, 114);
  await store.saveRun({
    run_id: "run-1",
    session_id: "session-1",
    status: "completed",
    started_at_ms: 110,
    completed_at_ms: 115,
  });

  await assert.rejects(
    store.saveRun({
      run_id: "run-1",
      session_id: "session-1",
      status: "running",
      started_at_ms: 110,
      completed_at_ms: null,
    }),
    AuditStorageError,
  );
  await assert.rejects(
    store.saveToolCall("run-1", {
      tool_call_id: "late-tool-call",
      name: "character.go_to_room",
      arguments: { room_id: "study" },
    }, 116),
    /run run-1 is not writable/,
  );
  await assert.rejects(
    store.saveAction({
      action_id: "action-1",
      run_id: "run-1",
      tool_call_id: "tool-call-1",
      status: "started",
      created_at_ms: 113,
    }),
    AuditStorageError,
  );
  await assert.rejects(
    store.saveSession({
      session_id: "session-1",
      agent_profile_id: "profile-1",
      created_at_ms: 100,
      updated_at_ms: 99,
    }),
  );
});

test("a file-backed audit trace survives explicit close and reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-audit-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      using store = new SqliteAuditStore(databasePath);
      await seed(store);
      await store.appendEvent({
        event_id: "event-persisted",
        run_id: "run-1",
        type: "run.started",
        occurred_at_ms: 111,
        payload: { durable: true },
      });
    }
    {
      using reopened = new SqliteAuditStore(databasePath);
      const trace = await reopened.getRunTrace("run-1");
      assert.equal(trace?.events[0]?.event_id, "event-persisted");
      assert.deepEqual(trace?.events[0]?.payload, { durable: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a run cannot terminate while a tool call is still pending", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seed(store);
  await store.saveToolCall("run-1", {
    tool_call_id: "tool-call-pending",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
  }, 112);

  await assert.rejects(
    store.saveRun({
      run_id: "run-1",
      session_id: "session-1",
      status: "completed",
      started_at_ms: 110,
      completed_at_ms: 113,
    }),
    /cannot terminate with unfinished work/,
  );
  const trace = await store.getRunTrace("run-1");
  assert.equal(trace?.run.status, "running");
  assert.equal(trace?.tool_calls[0]?.status, "pending");
});

test("an audit batch rolls back every write when one event conflicts", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seed(store);
  await store.saveToolCall("run-1", {
    tool_call_id: "tool-call-1",
    name: "character.go_to_room",
    arguments: { room_id: "study" },
  }, 112);
  const event = {
    event_id: "event-conflict",
    run_id: "run-1",
    type: "tool.completed",
    occurred_at_ms: 114,
    payload: { tool_call_id: "tool-call-1" },
  };
  await store.appendEvent(event);

  await assert.rejects(
    store.writeBatch({
      tool_results: [{
        run_id: "run-1",
        completed_at_ms: 113,
        result: {
          schema_version: 1,
          tool_call_id: "tool-call-1",
          name: "character.go_to_room",
          status: "success",
          result: { room_id: "study" },
          error: null,
        },
      }],
      events: [event],
    }),
    /UNIQUE constraint failed/,
  );
  const trace = await store.getRunTrace("run-1");
  assert.equal(trace?.tool_calls[0]?.status, "pending");
  assert.equal(trace?.tool_calls[0]?.result, null);
});

test("run trace reads one snapshot while a terminal write follows", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seed(store);

  const snapshotPromise = store.getRunTrace("run-1");
  const finishPromise = store.writeBatch({
    run: {
      run_id: "run-1",
      session_id: "session-1",
      status: "completed",
      started_at_ms: 110,
      completed_at_ms: 120,
    },
    events: [{
      event_id: "event-completed",
      run_id: "run-1",
      type: "run.completed",
      occurred_at_ms: 120,
      payload: { status: "completed" },
    }],
  });
  const snapshot = await snapshotPromise;
  await finishPromise;
  const current = await store.getRunTrace("run-1");

  assert.equal(snapshot?.run.status, "running");
  assert.deepEqual(snapshot?.events, []);
  assert.equal(current?.run.status, "completed");
  assert.equal(current?.events[0]?.type, "run.completed");
});
