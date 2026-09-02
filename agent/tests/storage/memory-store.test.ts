import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AuditStorageError,
  SqliteAuditStore,
  SynchronousSqliteAuditStore,
  type MemoryCreate,
} from "@p4home/storage-sqlite";

function memory(
  memoryId: string,
  overrides: Partial<MemoryCreate> = {},
): MemoryCreate {
  return {
    schema_version: 1,
    memory_id: memoryId,
    kind: "user_fact",
    content: "用户喜欢在书房阅读科幻小说",
    source: "user_explicit",
    source_interaction_id: "interaction-1",
    confidence: 0.9,
    sensitivity: "personal",
    owner_role: "robot",
    visibility_scope: "owner_only",
    visible_to_roles: [],
    policy_revision: 1,
    tags: ["preference", "reading"],
    created_at_ms: 100,
    expires_at_ms: null,
    ...overrides,
  };
}

async function seedAudit(store: SqliteAuditStore): Promise<void> {
  await store.saveAgentProfile({
    agent_profile_id: "profile-migration",
    name: "P4 Home",
    locale: "zh-CN",
    allowed_tools: [],
  });
  await store.saveSession({
    session_id: "session-migration",
    agent_profile_id: "profile-migration",
    created_at_ms: 1,
    updated_at_ms: 1,
  });
  await store.saveRun({
    run_id: "run-migration",
    session_id: "session-migration",
    status: "running",
    started_at_ms: 2,
    completed_at_ms: null,
  });
  await store.appendEvent({
    event_id: "event-migration",
    run_id: "run-migration",
    type: "migration.probe",
    occurred_at_ms: 3,
    payload: { preserved: true },
  });
}

function downgradeToAuditSchema(databasePath: string, version: 1 | 2): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    DROP TABLE memory_deletion_items;
    DROP TABLE memory_deletion_requests;
    DROP TRIGGER memories_fts_insert;
    DROP TRIGGER memories_fts_delete;
    DROP TRIGGER memories_fts_update;
    DROP TABLE memories_fts;
    DROP TABLE memory_tags;
    DROP TABLE memory_visible_roles;
    DROP TABLE memories;
  `);
  if (version === 1) {
    database.exec("DROP INDEX events_role_interaction_idx");
  }
  database.exec(`PRAGMA user_version = ${version}`);
  database.close();
}

function createV3MemoryDatabase(databasePath: string, blocker = false): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE memories (
      schema_version INTEGER NOT NULL,
      memory_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      source_interaction_id TEXT,
      confidence REAL NOT NULL,
      sensitivity TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      policy_revision INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER
    ) STRICT;
    CREATE TABLE memory_visible_roles (
      memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
      visible_role TEXT NOT NULL,
      PRIMARY KEY (memory_id, visible_role)
    ) STRICT;
    CREATE TABLE memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    ) STRICT;
    INSERT INTO memories VALUES (
      1, 'v3-preserved', 1, 'user_fact', 'v3 中保留的事实',
      'user_explicit', 'interaction-v3', 0.9, 'personal', 'robot',
      'owner_only', 1, 100, 100, NULL
    );
    INSERT INTO memory_tags VALUES ('v3-preserved', 'migration');
    PRAGMA user_version = 3;
  `);
  if (blocker) {
    database.exec("CREATE TABLE memory_deletion_requests (blocker TEXT) STRICT");
  }
  database.close();
  chmodSync(databasePath, 0o600);
}

test("memory persists across synchronous create and worker reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-persist-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      using store = new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      const created = await store.createMemory(memory("memory-persisted"));
      assert.equal(created.revision, 1);
      assert.deepEqual(created.tags, ["preference", "reading"]);
    }
    {
      await using reopened = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      const stored = await reopened.getMemory("memory-persisted", "robot", 100);
      assert.equal(stored?.content, "用户喜欢在书房阅读科幻小说");
      assert.equal(stored?.schema_version, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory inputs and all query bounds are validated", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await assert.rejects(
    store.createMemory(memory("invalid-content", { content: "" })),
    AuditStorageError,
  );
  await assert.rejects(
    store.createMemory(memory("too-many-tags", {
      tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`),
    })),
    /at most 32 tags/,
  );
  await assert.rejects(
    store.createMemory(memory("invalid-acl", {
      visibility_scope: "owner_only",
      visible_to_roles: ["human"],
    })),
    /must be empty/,
  );
  await assert.rejects(
    store.createMemory(memory("owner-in-acl", {
      visibility_scope: "explicit_roles",
      visible_to_roles: ["robot"],
    })),
    /cannot include memory\.owner_role/,
  );
  await assert.rejects(
    store.createMemory(memory("restricted-acl", {
      sensitivity: "restricted",
      visibility_scope: "explicit_roles",
      visible_to_roles: ["human"],
    })),
    /restricted memory must use owner_only/,
  );
  await assert.rejects(
    store.createMemory(memory("invalid-confidence", { confidence: Number.NaN })),
    /finite number/,
  );
  await assert.rejects(
    store.createMemory(memory("invalid-kind-source", {
      kind: "task_outcome",
      source: "user_explicit",
    })),
    /source is invalid for memory\.kind task_outcome/,
  );
  await assert.rejects(
    store.createMemory(memory("invalid-expiry", {
      created_at_ms: 100,
      expires_at_ms: 99,
    })),
    /cannot precede created_at_ms/,
  );
  await assert.rejects(
    store.listMemories({ requester_role: "robot", limit: 101 }),
    /cannot exceed 100/,
  );
  await assert.rejects(
    store.listMemories({ requester_role: "robot", offset: 10_001 }),
    /cannot exceed 10000/,
  );
  await assert.rejects(
    store.listMemories({ requester_role: "robot", kinds: [] }),
    /kinds must not be empty/,
  );
  await assert.rejects(
    store.listMemories({ requester_role: "robot", tags: [] }),
    /tags must not be empty/,
  );

  await store.createMemory(memory("safe-query"));
  const rawSyntax = await store.searchMemories({
    requester_role: "robot",
    query: "书房 OR *",
    now_ms: 100,
  });
  assert.deepEqual(rawSyntax.items, []);
  const quotedFtsSyntax = await store.searchMemories({
    requester_role: "robot",
    query: "书房阅读\" ORR NEAR(reading)",
    now_ms: 100,
  });
  assert.deepEqual(quotedFtsSyntax.items, []);
});

test("6A reads stay owner-only even for explicit role ACLs", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await store.createMemory(memory("owner-only-memory"));
  await store.createMemory(memory("explicit-memory", {
    visibility_scope: "explicit_roles",
    visible_to_roles: ["human", "cat"],
  }));

  assert.equal(await store.getMemory("owner-only-memory", "human", 100), null);
  assert.equal(await store.getMemory("explicit-memory", "human", 100), null);
  assert.deepEqual((await store.listMemories({
    requester_role: "human",
    now_ms: 100,
  })).items, []);
  assert.deepEqual((await store.searchMemories({
    requester_role: "cat",
    query: "书房阅读",
    now_ms: 100,
  })).items, []);
  await assert.rejects(
    store.updateMemory({
      memory_id: "explicit-memory",
      requester_role: "human",
      expected_revision: 1,
      updated_at_ms: 101,
      content: "cross-role update",
    }),
    /not visible to requester/,
  );
  assert.deepEqual(
    (await store.getMemory("explicit-memory", "robot", 100))?.visible_to_roles,
    ["cat", "human"],
  );
});

test("Chinese full-text search follows content updates and tag filters", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  const created = await store.createMemory(memory("searchable"));
  await store.createMemory(memory("other-tag", {
    content: "用户也喜欢书房阅读历史书籍",
    tags: ["reading"],
    created_at_ms: 101,
  }));

  assert.deepEqual((await store.searchMemories({
    requester_role: "robot",
    query: "书房阅读",
    tags: ["preference"],
    now_ms: 101,
  })).items.map((item) => item.memory_id), ["searchable"]);

  const updated = await store.updateMemory({
    memory_id: "searchable",
    requester_role: "robot",
    expected_revision: created.revision,
    updated_at_ms: 110,
    content: "用户喜欢在阳台种植绿色植物",
    tags: ["preference", "gardening"],
  });
  assert.equal(updated.revision, 2);
  assert.deepEqual((await store.searchMemories({
    requester_role: "robot",
    query: "书房阅读",
    now_ms: 110,
  })).items.map((item) => item.memory_id), ["other-tag"]);
  assert.deepEqual((await store.searchMemories({
    requester_role: "robot",
    query: "阳台种植",
    tags: ["gardening"],
    now_ms: 110,
  })).items.map((item) => item.memory_id), ["searchable"]);
});

test("expiry is exclusive at the boundary and purge is bounded", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await store.createMemory(memory("expiring", {
    created_at_ms: 100,
    expires_at_ms: 200,
  }));
  assert.ok(await store.getMemory("expiring", "robot", 199));
  assert.equal(await store.getMemory("expiring", "robot", 200), null);
  assert.deepEqual((await store.listMemories({
    requester_role: "robot",
    now_ms: 200,
  })).items, []);
  assert.equal(await store.purgeExpiredMemories(199, 1), 0);
  assert.equal(await store.purgeExpiredMemories(200, 1), 1);
  assert.equal(await store.purgeExpiredMemories(200, 1), 0);
  await assert.rejects(store.purgeExpiredMemories(200, 1_001), /cannot exceed 1000/);
});

test("concurrent memory updates allow exactly one expected revision", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await store.createMemory(memory("revisioned"));
  const outcomes = await Promise.allSettled([
    store.updateMemory({
      memory_id: "revisioned",
      requester_role: "robot",
      expected_revision: 1,
      updated_at_ms: 101,
      content: "first concurrent update",
    }),
    store.updateMemory({
      memory_id: "revisioned",
      requester_role: "robot",
      expected_revision: 1,
      updated_at_ms: 102,
      content: "second concurrent update",
    }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const stored = await store.getMemory("revisioned", "robot", 102);
  assert.equal(stored?.revision, 2);
  assert.ok(
    stored?.content === "first concurrent update"
    || stored?.content === "second concurrent update",
  );
});

test("memory updates reject no-ops and policy revision rollback", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await store.createMemory(memory("policy-revisioned", { policy_revision: 2 }));
  await assert.rejects(
    store.updateMemory({
      memory_id: "policy-revisioned",
      requester_role: "robot",
      expected_revision: 1,
      updated_at_ms: 101,
      confidence: 0.9,
    }),
    /must change at least one field/,
  );
  await assert.rejects(
    store.updateMemory({
      memory_id: "policy-revisioned",
      requester_role: "robot",
      expected_revision: 1,
      updated_at_ms: 101,
      policy_revision: 1,
      content: "attempted policy rollback",
    }),
    /policy_revision cannot move backwards/,
  );
  assert.equal(
    (await store.getMemory("policy-revisioned", "robot", 101))?.revision,
    1,
  );
});

test("hard delete removes FTS, tags, ACLs, and survives reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-delete-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      await using store = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await store.createMemory(memory("deleted", {
        visibility_scope: "explicit_roles",
        visible_to_roles: ["human"],
      }));
      assert.equal(await store.deleteMemory("deleted", "human"), false);
      assert.equal(await store.deleteMemory("deleted", "robot"), true);
      assert.deepEqual((await store.searchMemories({
        requester_role: "robot",
        query: "书房阅读",
        now_ms: 100,
      })).items, []);
    }
    {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_tags").get()?.count, 0);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM memory_visible_roles").get()?.count,
        0,
      );
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memories_fts").get()?.count, 0);
      database.close();
    }
    {
      await using reopened = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      assert.equal(await reopened.getMemory("deleted", "robot", 100), null);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory schema enforces STRICT, foreign keys, ACL guards, and FTS integrity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-schema-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      using store = new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await store.createMemory(memory("schema-guarded"));
    }
    const database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
    });
    assert.throws(
      () => database.prepare(`
        INSERT INTO memory_visible_roles (memory_id, visible_role)
        VALUES ('schema-guarded', 'human')
      `).run(),
      /invalid memory visibility ACL/,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO memory_tags (memory_id, tag)
        VALUES ('missing-memory', 'orphan')
      `).run(),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.exec("UPDATE memories SET content = x'00' WHERE memory_id = 'schema-guarded'"),
      /cannot store BLOB value in TEXT column/,
    );
    database.exec("INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')");
    const strictRows = database.prepare(`
      SELECT name, strict
      FROM pragma_table_list
      WHERE name IN ('memories', 'memory_visible_roles', 'memory_tags')
      ORDER BY name
    `).all();
    assert.equal(strictRows.length, 3);
    assert.ok(strictRows.every((row) => row.strict === 1));
    const indexes = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'memories_owner_updated_idx',
          'memories_expiry_idx',
          'memory_visible_roles_role_idx',
          'memory_tags_tag_idx'
        )
    `).all();
    assert.equal(indexes.length, 4);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory pagination has a deterministic order and bounded pages", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  for (const memoryId of ["memory-c", "memory-a", "memory-b"]) {
    await store.createMemory(memory(memoryId));
  }
  const first = await store.listMemories({
    requester_role: "robot",
    limit: 2,
    now_ms: 100,
  });
  assert.notEqual(first.next_offset, null);
  if (first.next_offset === null) {
    throw new Error("first page unexpectedly had no continuation");
  }
  const second = await store.listMemories({
    requester_role: "robot",
    limit: 2,
    offset: first.next_offset,
    now_ms: 100,
  });
  assert.deepEqual(first.items.map((item) => item.memory_id), ["memory-a", "memory-b"]);
  assert.equal(first.next_offset, 2);
  assert.deepEqual(second.items.map((item) => item.memory_id), ["memory-c"]);
  assert.equal(second.next_offset, null);
});

test("failed schema v0 creation leaves no partial latest schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-v0-rollback-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    const blocker = new DatabaseSync(databasePath);
    blocker.exec("CREATE TABLE sessions (blocker TEXT) STRICT");
    blocker.close();
    chmodSync(databasePath, 0o600);

    assert.throws(
      () => new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      }),
      /table sessions already exists/,
    );

    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('agent_profiles', 'memories')
      `).get()?.count,
      0,
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const oldVersion of [1, 2] as const) {
  test(`failed schema v${oldVersion} migration rolls back every migration step`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `p4home-memory-v${oldVersion}-rollback-`));
    const databasePath = join(directory, "audit.sqlite");
    try {
      {
        await using initial = new SqliteAuditStore(databasePath, {
          reconcile_on_open: false,
        });
        await seedAudit(initial);
      }
      downgradeToAuditSchema(databasePath, oldVersion);
      const blocker = new DatabaseSync(databasePath);
      blocker.exec("CREATE TABLE memory_tags (blocker TEXT) STRICT");
      blocker.close();

      assert.throws(
        () => new SynchronousSqliteAuditStore(databasePath, {
          reconcile_on_open: false,
        }),
        /table memory_tags already exists/,
      );

      const database = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, oldVersion);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
        1,
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table' AND name IN ('memories', 'memory_visible_roles')
        `).get()?.count,
        0,
      );
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'index' AND name = 'events_role_interaction_idx'
        `).get()?.count,
        oldVersion === 1 ? 0 : 1,
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("canonical writes are idempotent without treating memory ID conflicts as retries", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  const first = await store.createCanonicalMemory({
    ...memory("canonical-a"),
    idempotency_key: "idem-a",
    subject_key: "reading.preference",
  });
  const retry = await store.createCanonicalMemory({
    ...memory("canonical-a"),
    idempotency_key: "idem-a",
    subject_key: "reading.preference",
  });
  assert.equal(retry.memory_id, first.memory_id);
  assert.equal((await store.listMemories({
    requester_role: "robot",
    now_ms: 100,
  })).items.length, 1);

  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("canonical-a", {
        content: "不同事实",
        source_interaction_id: "interaction-2",
      }),
      idempotency_key: "idem-b",
      subject_key: "reading.preference",
    }),
    /memory_id canonical-a conflicts/,
  );
  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("canonical-b", { content: "不同 payload" }),
      idempotency_key: "idem-a",
      subject_key: "reading.preference",
    }),
    /idempotency key idem-a conflicts/,
  );
  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("canonical-b"),
      idempotency_key: "idem-a",
      subject_key: "reading.preference",
    }),
    /idempotency key idem-a conflicts/,
  );
  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("canonical-a", { tags: ["different-tag"] }),
      idempotency_key: "idem-a",
      subject_key: "reading.preference",
    }),
    /idempotency key idem-a conflicts/,
  );
});

test("same-content canonical writes keep distinct identities in one lineage", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  const first = await store.createCanonicalMemory({
    ...memory("same-content-a"),
    idempotency_key: "same-content-idem-a",
    subject_key: "same-content",
  });
  const second = await store.createCanonicalMemory({
    ...memory("same-content-b", {
      source_interaction_id: "interaction-2",
      created_at_ms: 101,
    }),
    idempotency_key: "same-content-idem-b",
    subject_key: "same-content",
  });
  assert.notEqual(second.memory_id, first.memory_id);
  assert.equal(second.supersedes_memory_id, first.memory_id);
  await assert.rejects(
    store.updateMemory({
      memory_id: second.memory_id,
      requester_role: "robot",
      expected_revision: 1,
      updated_at_ms: 102,
      content: "password=must-not-bypass-policy",
    }),
    /canonical memory .* is immutable/,
  );
});

test("concurrent canonical writers preserve idempotency and a single lineage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-concurrent-canonical-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      await using firstStore = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await using secondStore = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await firstStore.listMemories({ requester_role: "robot", now_ms: 100 });
      await secondStore.listMemories({ requester_role: "robot", now_ms: 100 });

      const identical = {
        ...memory("concurrent-idempotent"),
        idempotency_key: "concurrent-idempotent-key",
        subject_key: "concurrent.idempotent",
      } as const;
      const retries = await Promise.all([
        firstStore.createCanonicalMemory(identical),
        secondStore.createCanonicalMemory(identical),
      ]);
      assert.equal(retries[0].memory_id, retries[1].memory_id);

      const conflictResults = await Promise.allSettled([
        firstStore.createCanonicalMemory({
          ...memory("concurrent-lineage-a", {
            content: "concurrent value a",
            created_at_ms: 101,
          }),
          idempotency_key: "concurrent-lineage-key-a",
          subject_key: "concurrent.lineage",
        }),
        secondStore.createCanonicalMemory({
          ...memory("concurrent-lineage-b", {
            content: "concurrent value b",
            source_interaction_id: "interaction-2",
            created_at_ms: 102,
          }),
          idempotency_key: "concurrent-lineage-key-b",
          subject_key: "concurrent.lineage",
        }),
      ]);
      const conflicts = conflictResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      assert.ok(conflicts.length >= 1);
      assert.ok(conflictResults.every((result) =>
        result.status === "fulfilled"
        || /is stale for subject/.test(String(result.reason))));
      const stored = (await firstStore.listMemories({
        requester_role: "robot",
        now_ms: 102,
        limit: 10,
      })).items.filter((item) => item.subject_key === "concurrent.lineage");
      assert.ok(stored.length >= 1);
      assert.equal(stored.filter((item) =>
        !stored.some((child) => child.supersedes_memory_id === item.memory_id)).length, 1);
      assert.equal(Math.max(...stored.map((item) => item.created_at_ms)), 102);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conflicting canonical facts create immutable same-owner lineage", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  const first = await store.createCanonicalMemory({
    ...memory("lineage-a"),
    idempotency_key: "lineage-idem-a",
    subject_key: "favorite.book",
  });
  const second = await store.createCanonicalMemory({
    ...memory("lineage-b", {
      content: "用户现在更喜欢历史小说",
      source_interaction_id: "interaction-2",
      created_at_ms: 101,
    }),
    idempotency_key: "lineage-idem-b",
    subject_key: "favorite.book",
  });
  assert.equal(first.supersedes_memory_id, null);
  assert.equal(second.supersedes_memory_id, first.memory_id);
  assert.equal((await store.getMemory(first.memory_id, "robot", 101))?.content, first.content);
  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("lineage-stale", {
        content: "stale value",
        created_at_ms: 100,
      }),
      idempotency_key: "lineage-stale-idem",
      subject_key: "favorite.book",
    }),
    /is stale for subject/,
  );

  await assert.rejects(
    store.createMemory({
      ...memory("cross-owner", {
        owner_role: "human",
        content: "cross owner",
      }),
      idempotency_key: "cross-owner-idem",
      subject_key: "favorite.book",
      supersedes_memory_id: first.memory_id,
    }),
    /invalid memory supersession lineage/,
  );
  await assert.rejects(
    store.createMemory({
      ...memory("self-parent"),
      idempotency_key: "self-idem",
      subject_key: "self",
      supersedes_memory_id: "self-parent",
    }),
    /invalid memory supersession lineage/,
  );
  await assert.rejects(
    store.createMemory({
      ...memory("cross-subject", {
        content: "cross subject",
      }),
      idempotency_key: "cross-subject-idem",
      subject_key: "different.subject",
      supersedes_memory_id: first.memory_id,
    }),
    /invalid memory supersession lineage/,
  );
  await assert.rejects(
    store.createMemory({
      ...memory("lineage-branch", {
        content: "branch",
      }),
      idempotency_key: "lineage-branch-idem",
      subject_key: "favorite.book",
      supersedes_memory_id: first.memory_id,
    }),
    /UNIQUE constraint failed: memories\.supersedes_memory_id/,
  );
});

test("explicit deletion recursively removes descendants and retains body-free idempotent audit", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  for (const [index, content] of [
    "用户喜欢科幻小说",
    "用户更喜欢历史小说",
    "用户目前喜欢推理小说",
  ].entries()) {
    await store.createCanonicalMemory({
      ...memory(`cascade-${index}`, {
        content,
        source_interaction_id: `interaction-${index}`,
        created_at_ms: 100 + index,
      }),
      idempotency_key: `cascade-idem-${index}`,
      subject_key: "favorite.book",
    });
  }
  const request = {
    request_id: "delete-request-1",
    memory_id: "cascade-0",
    requester_role: "robot" as const,
    reason: "user_request" as const,
    requested_at_ms: 200,
  };
  const deleted = await store.deleteMemoryCascade(request);
  assert.deepEqual(deleted.memory_ids, ["cascade-0", "cascade-1", "cascade-2"]);
  assert.equal(deleted.deleted_count, 3);
  assert.deepEqual(await store.deleteMemoryCascade(request), deleted);
  assert.deepEqual(await store.getMemoryDeletionAudit("delete-request-1", "robot"), deleted);
  assert.equal(await store.getMemoryDeletionAudit("delete-request-1", "human"), null);
  assert.deepEqual((await store.searchMemories({
    requester_role: "robot",
    query: "小说",
    now_ms: 200,
  })).items, []);
  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("cascade-recreated"),
      idempotency_key: "cascade-idem-0",
      subject_key: "favorite.book",
    }),
    /memory identity was explicitly deleted/,
  );
  await assert.rejects(
    store.createCanonicalMemory({
      ...memory("cascade-0"),
      idempotency_key: "new-idempotency-key",
      subject_key: "favorite.book",
    }),
    /memory identity was explicitly deleted/,
  );

  const raw = new DatabaseSync(":memory:");
  raw.close();
  assert.equal(JSON.stringify(deleted).includes("用户喜欢科幻小说"), false);
});

test("explicit deletion fails closed across owners and conflicting request reuse", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await store.createMemory(memory("private-delete"));
  await assert.rejects(
    store.deleteMemoryCascade({
      request_id: "cross-owner-delete",
      memory_id: "private-delete",
      requester_role: "human",
      reason: "user_request",
      requested_at_ms: 200,
    }),
    /not owned by requester/,
  );
  const request = {
    request_id: "owner-delete",
    memory_id: "private-delete",
    requester_role: "robot" as const,
    reason: "user_request" as const,
    requested_at_ms: 200,
  };
  await store.deleteMemoryCascade(request);
  await assert.rejects(
    store.deleteMemoryCascade({ ...request, reason: "privacy_request" }),
    /conflicts with stored request/,
  );
  await assert.rejects(
    store.deleteMemoryCascade({ ...request, memory_id: "different-memory" }),
    /conflicts with stored request/,
  );
  await assert.rejects(
    store.deleteMemoryCascade({ ...request, requester_role: "human" }),
    /conflicts with stored request/,
  );
  await assert.rejects(
    store.deleteMemoryCascade({ ...request, requested_at_ms: 201 }),
    /conflicts with stored request/,
  );
  await assert.rejects(
    store.deleteMemoryCascade({
      ...request,
      request_id: "free-text-reason",
      reason: "private-delete",
    } as never),
    /memory deletion reason is invalid/,
  );
});

test("cascade deletion rejects over-deep lineage and rolls back its audit", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  for (let index = 0; index < 258; index += 1) {
    await store.createCanonicalMemory({
      ...memory(`deep-${index}`, {
        content: `deep value ${index}`,
        source_interaction_id: `interaction-${index}`,
        created_at_ms: 100 + index,
      }),
      idempotency_key: `deep-idem-${index}`,
      subject_key: "deep.lineage",
    });
  }
  await assert.rejects(
    store.deleteMemoryCascade({
      request_id: "deep-delete-request",
      memory_id: "deep-0",
      requester_role: "robot",
      reason: "user_request",
      requested_at_ms: 1_000,
    }),
    /lineage is too deep/,
  );
  assert.equal(
    await store.getMemoryDeletionAudit("deep-delete-request", "robot"),
    null,
  );
  assert.ok(await store.getMemory("deep-0", "robot", 1_000));
  assert.ok(await store.getMemory("deep-257", "robot", 1_000));
});

test("cascade deletion clears FTS, tags, ACL and stores no memory body in audit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-delete-audit-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      await using store = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await store.createMemory({
        ...memory("audit-delete", {
          content: "正文绝不进入删除审计 unique-body-marker",
          visibility_scope: "explicit_roles",
          visible_to_roles: ["human"],
        }),
        idempotency_key: "audit-delete-idem",
        subject_key: "audit-delete-subject",
      });
      await store.deleteMemoryCascade({
        request_id: "audit-delete-request",
        memory_id: "audit-delete",
        requester_role: "robot",
        reason: "user_request",
        requested_at_ms: 200,
      });
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    for (const table of [
      "memories",
      "memory_tags",
      "memory_visible_roles",
      "memories_fts",
    ]) {
      assert.equal(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        0,
      );
    }
    const columns = database.prepare(`
      SELECT name FROM pragma_table_info('memory_deletion_requests')
      UNION ALL
      SELECT name FROM pragma_table_info('memory_deletion_items')
    `).all().map((row) => row.name);
    assert.equal(columns.includes("content"), false);
    assert.equal(
      JSON.stringify(database.prepare(`
        SELECT * FROM memory_deletion_requests
        JOIN memory_deletion_items USING (request_id)
      `).all()).includes("unique-body-marker"),
      false,
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("logical deletion does not erase stale backups or prior WAL frames", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-delete-remnants-"));
  const databasePath = join(directory, "audit.sqlite");
  const preDeleteBackupPath = join(directory, "pre-delete.sqlite");
  const postDeleteBackupPath = join(directory, "post-delete.sqlite");
  const bodyCanary = "phase6i-remnant-canary-7f3d8a1c";
  const store = new SqliteAuditStore(databasePath, { reconcile_on_open: false });
  try {
    await store.createMemory(memory("remnant-probe", {
      content: bodyCanary,
      idempotency_key: "remnant-probe-idempotency",
      subject_key: "remnant.probe",
    }));
    await store.backup(preDeleteBackupPath);
    await store.deleteMemoryCascade({
      request_id: "remnant-delete-request",
      memory_id: "remnant-probe",
      requester_role: "robot",
      reason: "privacy_request",
      requested_at_ms: 200,
    });
    assert.equal(await store.getMemory("remnant-probe", "robot", 200), null);
    assert.deepEqual((await store.searchMemories({
      requester_role: "robot",
      query: "phase6i remnant canary",
      now_ms: 200,
    })).items, []);
    await store.backup(postDeleteBackupPath);

    const walPath = `${databasePath}-wal`;
    assert.equal(existsSync(walPath), true);
    assert.equal(
      readFileSync(walPath).includes(Buffer.from(bodyCanary, "utf8")),
      true,
    );

    const preDeleteBackup = new DatabaseSync(preDeleteBackupPath, { readOnly: true });
    try {
      assert.equal(
        preDeleteBackup.prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?",
        ).get("remnant-probe")?.count,
        1,
      );
      assert.equal(
        readFileSync(preDeleteBackupPath).includes(Buffer.from(bodyCanary, "utf8")),
        true,
      );
    } finally {
      preDeleteBackup.close();
    }

    const postDeleteBackup = new DatabaseSync(postDeleteBackupPath, { readOnly: true });
    try {
      assert.equal(
        postDeleteBackup.prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?",
        ).get("remnant-probe")?.count,
        0,
      );
      assert.equal(
        JSON.stringify(postDeleteBackup.prepare(`
          SELECT * FROM memory_deletion_requests
          JOIN memory_deletion_items USING (request_id)
        `).all()).includes(bodyCanary),
        false,
      );
    } finally {
      postDeleteBackup.close();
    }
  } finally {
    await store.closeAsync();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v3 migrates atomically to v4 and preserves memory data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-v3-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    createV3MemoryDatabase(databasePath);
    {
      await using store = new SqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      const preserved = await store.getMemory("v3-preserved", "robot", 100);
      assert.equal(preserved?.content, "v3 中保留的事实");
      assert.equal(preserved?.idempotency_key, "legacy:v3-preserved");
      assert.equal(preserved?.subject_key, "legacy:v3-preserved");
      assert.deepEqual(preserved?.tags, ["migration"]);
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 5);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema rejects an attempted supersession cycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-cycle-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    {
      using store = new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      });
      await store.createMemory({
        ...memory("cycle-a"),
        idempotency_key: "cycle-idem-a",
        subject_key: "cycle",
      });
      await store.createMemory({
        ...memory("cycle-b"),
        idempotency_key: "cycle-idem-b",
        subject_key: "cycle",
        supersedes_memory_id: "cycle-a",
      });
    }
    const database = new DatabaseSync(databasePath);
    assert.throws(
      () => database.exec(`
        UPDATE memories SET supersedes_memory_id = 'cycle-b'
        WHERE memory_id = 'cycle-a'
      `),
      /identity and lineage are immutable/,
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed schema v3 to v4 migration rolls back columns, indexes, and data", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-memory-v3-rollback-"));
  const databasePath = join(directory, "audit.sqlite");
  try {
    createV3MemoryDatabase(databasePath, true);
    assert.throws(
      () => new SynchronousSqliteAuditStore(databasePath, {
        reconcile_on_open: false,
      }),
      /table memory_deletion_requests already exists/,
    );
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 3);
    assert.equal(
      database.prepare("SELECT content FROM memories WHERE memory_id = 'v3-preserved'").get()
        ?.content,
      "v3 中保留的事实",
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM pragma_table_info('memories')
        WHERE name IN ('idempotency_key', 'subject_key', 'supersedes_memory_id')
      `).get()?.count,
      0,
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'index' AND name = 'memories_idempotency_key_unique'
      `).get()?.count,
      0,
    );
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const oldVersion of [1, 2] as const) {
  test(`schema v${oldVersion} migrates directly to latest and preserves audit data`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `p4home-memory-v${oldVersion}-`));
    const databasePath = join(directory, "audit.sqlite");
    try {
      {
        await using initial = new SqliteAuditStore(databasePath, {
          reconcile_on_open: false,
        });
        await seedAudit(initial);
      }
      downgradeToAuditSchema(databasePath, oldVersion);
      {
        await using migrated = new SqliteAuditStore(databasePath, {
          reconcile_on_open: false,
        });
        assert.deepEqual((await migrated.getRunTrace("run-migration"))?.events[0]?.payload, {
          preserved: true,
        });
        await migrated.createMemory(memory(`migrated-v${oldVersion}`));
      }
      const database = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 5);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM memories").get()?.count,
        1,
      );
      assert.equal(
        database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'events_role_interaction_idx'
        `).get()?.name,
        "events_role_interaction_idx",
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
