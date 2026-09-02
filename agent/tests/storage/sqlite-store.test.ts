import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AuditStorageError,
  SqliteAuditStore,
  SynchronousSqliteAuditStore,
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

test("interaction correlation lookup deduplicates repeated start events", async () => {
  using store = new SqliteAuditStore(":memory:");
  await seed(store);
  for (const [index, occurredAtMs] of [111, 112].entries()) {
    await store.appendEvent({
      event_id: `role-start-${index + 1}`,
      run_id: "run-1",
      type: "role.run.started",
      occurred_at_ms: occurredAtMs,
      payload: { interaction_id: "interaction-1" },
    });
  }

  assert.deepEqual(await store.listRunIdsForInteraction("interaction-1"), ["run-1"]);
});

test("schema v1 databases migrate the interaction correlation index to latest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-audit-migration-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      using store = new SqliteAuditStore(databasePath, { reconcile_on_open: false });
      await store.listRunIdsForInteraction("initialization-probe");
    }
    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`
      DROP TABLE memory_deletion_items;
      DROP TABLE memory_deletion_requests;
      DROP TRIGGER memories_fts_insert;
      DROP TRIGGER memories_fts_delete;
      DROP TRIGGER memories_fts_update;
      DROP TABLE memories_fts;
      DROP TABLE memory_tags;
      DROP TABLE memory_visible_roles;
      DROP TABLE memories;
      DROP INDEX events_role_interaction_idx;
      PRAGMA user_version = 1;
    `);
    oldDatabase.close();

    {
      using store = new SqliteAuditStore(databasePath, { reconcile_on_open: false });
      await store.listRunIdsForInteraction("migration-probe");
    }
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const version = migratedDatabase.prepare("PRAGMA user_version").get();
    const index = migratedDatabase.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'events_role_interaction_idx'
    `).get();
    migratedDatabase.close();

    assert.equal(version?.user_version, 5);
    assert.equal(index?.name, "events_role_interaction_idx");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file-backed SQLite creates and reopens only private database files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-private-sqlite-"));
  const databasePath = join(directory, "audit.sqlite");
  const mode = (path: string): number => lstatSync(path).mode & 0o777;
  try {
    {
      using store = new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await store.createMemory({
        schema_version: 1,
        memory_id: "private-file-probe",
        kind: "user_fact",
        content: "synthetic private file probe",
        source: "user_explicit",
        source_interaction_id: "private-file-probe-interaction",
        confidence: 1,
        sensitivity: "personal",
        owner_role: "robot",
        visibility_scope: "owner_only",
        visible_to_roles: [],
        policy_revision: 1,
        tags: ["probe"],
        created_at_ms: 1,
        expires_at_ms: null,
      });
      assert.equal(mode(directory), 0o700);
      assert.equal(mode(databasePath), 0o600);
      assert.equal(existsSync(`${databasePath}-wal`), true);
      assert.equal(existsSync(`${databasePath}-shm`), true);
      assert.equal(mode(`${databasePath}-wal`), 0o600);
      assert.equal(mode(`${databasePath}-shm`), 0o600);
    }
    {
      using reopened = new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      assert.equal(mode(databasePath), 0o600);
      assert.equal(
        (await reopened.getMemory("private-file-probe", "robot", 1))?.memory_id,
        "private-file-probe",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file-backed SQLite rejects permissive directories, files, sidecars, and symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-private-sqlite-reject-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    chmodSync(directory, 0o755);
    assert.throws(
      () => new SynchronousSqliteAuditStore(databasePath),
      /parent directory must use mode 0700, found 755/,
    );
    chmodSync(directory, 0o700);

    {
      using store = new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
    }
    chmodSync(databasePath, 0o644);
    assert.throws(
      () => new SynchronousSqliteAuditStore(databasePath),
      /database must use mode 0600, found 644/,
    );
    rmSync(databasePath, { force: true });

    writeFileSync(`${databasePath}-wal`, "not a real WAL", { mode: 0o644 });
    assert.throws(
      () => new SynchronousSqliteAuditStore(databasePath),
      /WAL file must use mode 0600, found 644/,
    );
    rmSync(`${databasePath}-wal`, { force: true });

    const targetPath = join(directory, "target.sqlite");
    writeFileSync(targetPath, "not a database", { mode: 0o600 });
    symlinkSync(targetPath, databasePath);
    assert.throws(
      () => new SynchronousSqliteAuditStore(databasePath),
      /database must be a regular non-symlink file/,
    );
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker online backup is private, ordered, durable, and readable while the source stays open", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-online-backup-"));
  const databasePath = join(directory, "audit.sqlite");
  const backupPath = join(directory, "audit-backup.sqlite");
  const store = new SqliteAuditStore(databasePath, { reconcile_on_open: false });
  try {
    await store.createMemory({
      schema_version: 1,
      memory_id: "online-backup-before",
      kind: "user_fact",
      content: "present in the online backup",
      source: "user_explicit",
      source_interaction_id: "online-backup-before-interaction",
      confidence: 1,
      sensitivity: "personal",
      owner_role: "robot",
      visibility_scope: "owner_only",
      visible_to_roles: [],
      policy_revision: 1,
      tags: ["backup"],
      created_at_ms: 1,
      expires_at_ms: null,
    });

    const backupPromise = store.backup(backupPath);
    const postSnapshotWrite = store.createMemory({
      schema_version: 1,
      memory_id: "online-backup-after",
      kind: "user_fact",
      content: "written after the online backup request",
      source: "user_explicit",
      source_interaction_id: "online-backup-after-interaction",
      confidence: 1,
      sensitivity: "personal",
      owner_role: "robot",
      visibility_scope: "owner_only",
      visible_to_roles: [],
      policy_revision: 1,
      tags: ["backup"],
      created_at_ms: 2,
      expires_at_ms: null,
    });
    const close = store.closeAsync();

    const result = await backupPromise;
    await postSnapshotWrite;
    await close;
    assert.equal(result.destination, backupPath);
    assert.equal(result.mode, "600");
    assert.equal(result.integrity_check, "ok");
    assert.ok(result.pages_transferred > 0);
    assert.equal(lstatSync(backupPath).mode & 0o777, 0o600);

    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(
        backupDatabase.prepare("PRAGMA integrity_check").get()?.integrity_check,
        "ok",
      );
      assert.equal(
        backupDatabase.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?")
          .get("online-backup-before")?.count,
        1,
      );
      assert.equal(
        backupDatabase.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?")
          .get("online-backup-after")?.count,
        0,
      );
    } finally {
      backupDatabase.close();
    }

    using reopened = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
    });
    assert.equal(
      (await reopened.getMemory("online-backup-after", "robot", 2))?.memory_id,
      "online-backup-after",
    );
  } finally {
    await store.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("online backup rejects insecure parents and never overwrites a destination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-online-backup-reject-"));
  const databasePath = join(directory, "audit.sqlite");
  const existingPath = join(directory, "existing.sqlite");
  const insecureDirectory = join(directory, "insecure");
  try {
    using store = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
    });
    writeFileSync(existingPath, "do not overwrite", { mode: 0o600 });
    await assert.rejects(
      store.backup(existingPath),
      /backup destination must not already exist/,
    );
    assert.equal(readFileSync(existingPath, "utf8"), "do not overwrite");

    mkdirSync(insecureDirectory, { mode: 0o755 });
    await assert.rejects(
      store.backup(join(insecureDirectory, "backup.sqlite")),
      /parent directory must use mode 0700, found 755/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("close drains requests that started before initialization completed", async () => {
  const store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  const pendingRead = store.getRunTrace("missing");
  const closing = store.closeAsync();

  assert.equal(await pendingRead, null);
  await closing;
  await assert.rejects(store.getRunTrace("missing"), /audit store is closed/);
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

test("SQLite lock waits in the worker without blocking main-loop timers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-worker-lock-"));
  const databasePath = join(directory, "audit.sqlite");
  const store = new SqliteAuditStore(databasePath, {
    timeout_ms: 2_000,
    reconcile_on_open: false,
  });
  let locker: DatabaseSync | undefined;
  try {
    await seed(store);
    locker = new DatabaseSync(databasePath);
    locker.exec("BEGIN IMMEDIATE");
    let writeSettled = false;
    const write = store.appendEvent({
      event_id: "event-after-lock",
      run_id: "run-1",
      type: "worker.lock.released",
      occurred_at_ms: 120,
      payload: {},
    }).finally(() => {
      writeSettled = true;
    });
    const timerResult = await Promise.race([
      write.then(() => "write" as const),
      new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), 25)),
    ]);
    assert.equal(timerResult, "timer");
    assert.equal(writeSettled, false);
    locker.exec("ROLLBACK");
    await write;
    assert.equal((await store.getRunTrace("run-1"))?.events[0]?.event_id, "event-after-lock");
  } finally {
    try {
      locker?.exec("ROLLBACK");
    } catch {
      // The successful path already released the lock.
    }
    locker?.close();
    await store.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup recovery records unknown outcomes and forbids blind replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-recovery-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    const initial = new SqliteAuditStore(databasePath, { reconcile_on_open: false });
    await seed(initial);
    await initial.saveToolCall("run-1", {
      tool_call_id: "tool-call-interrupted",
      name: "character.go_to_room",
      arguments: { room_id: "study" },
    }, 112);
    await initial.saveAction({
      action_id: "action-interrupted",
      run_id: "run-1",
      tool_call_id: "tool-call-interrupted",
      status: "started",
      created_at_ms: 113,
    });
    await initial.closeAsync();

    const recovered = new SqliteAuditStore(databasePath);
    const trace = await recovered.getRunTrace("run-1");
    assert.equal(trace?.run.status, "failed");
    assert.equal(trace?.tool_calls[0]?.status, "error");
    assert.deepEqual(trace?.tool_calls[0]?.error?.details, {
      outcome: "unknown",
      recovery: "process_restart",
      replay_allowed: false,
    });
    assert.equal(trace?.actions[0]?.status, "unknown");
    assert.deepEqual(trace?.events.at(-1)?.payload, {
      status: "failed",
      previous_outcome: "unknown",
      reason: "process_restart",
      replay_allowed: false,
      recovered_tool_calls: 1,
      recovered_actions: 1,
    });
    assert.deepEqual(await recovered.reconcileInterruptedRuns(), {
      run_ids: [],
      recovered_tool_calls: 0,
      recovered_actions: 0,
    });
    await recovered.closeAsync();

    const reopened = new SqliteAuditStore(databasePath);
    const stableTrace = await reopened.getRunTrace("run-1");
    assert.equal(stableTrace?.events.filter((event) => event.type === "run.recovered").length, 1);
    await reopened.closeAsync();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker initialization failures reject callers and still close cleanly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-init-error-"));
  const store = new SqliteAuditStore(directory);
  try {
    await assert.rejects(store.getRunTrace("run-1"), AuditStorageError);
  } finally {
    await store.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  }
});
