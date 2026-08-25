import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AuditStorageError,
  SqliteAuditStore,
  SynchronousSqliteAuditStore,
  type MemoryCreate,
  type MemoryKind,
  type MemoryRetentionPolicy,
  type MemorySensitivity,
  type SqliteStorageQuota,
} from "@p4home/storage-sqlite";

const DAY = 86_400_000;
const RETENTION: MemoryRetentionPolicy = {
  retention_policy_revision: 7,
  max_age_ms: {
    conversation_summary: { normal: 30 * DAY, personal: 14 * DAY, restricted: 7 * DAY },
    user_fact: { normal: 365 * DAY, personal: 180 * DAY, restricted: 30 * DAY },
    task_outcome: { normal: 90 * DAY, personal: 60 * DAY, restricted: 30 * DAY },
  },
};

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "p4home-storage-policy-"));
  chmodSync(path, 0o700);
  return path;
}

function source(kind: MemoryKind): MemoryCreate["source"] {
  return ({
    conversation_summary: "model_derived",
    user_fact: "user_explicit",
    task_outcome: "task_execution",
  } as const satisfies Record<MemoryKind, MemoryCreate["source"]>)[kind];
}

function memory(
  id: string,
  kind: MemoryKind = "user_fact",
  sensitivity: MemorySensitivity = "personal",
  overrides: Partial<MemoryCreate> = {},
): MemoryCreate {
  return {
    schema_version: 1,
    memory_id: id,
    kind,
    content: `bounded storage policy probe ${id}`,
    source: source(kind),
    source_interaction_id: `${id}-interaction`,
    confidence: 1,
    sensitivity,
    owner_role: "cat",
    visibility_scope: "owner_only",
    visible_to_roles: [],
    policy_revision: 7,
    tags: ["storage-policy"],
    created_at_ms: 1_000,
    expires_at_ms: null,
    ...overrides,
  };
}

function quota(maxDatabaseBytes = 512 * 1_024): SqliteStorageQuota {
  const pageSize = 4_096;
  const pages = Math.floor(maxDatabaseBytes / pageSize);
  return {
    max_database_bytes: maxDatabaseBytes,
    max_wal_bytes: 32 + pages * (pageSize + 24),
    max_index_bytes: maxDatabaseBytes * 2,
  };
}

test("retention defaults and ceilings cover every kind and sensitivity", async () => {
  const root = directory();
  try {
    using store = new SynchronousSqliteAuditStore(join(root, "retention.sqlite"), {
      reconcile_on_open: false,
      memory_retention: RETENTION,
    });
    for (const kind of [
      "conversation_summary",
      "user_fact",
      "task_outcome",
    ] as const) {
      for (const sensitivity of ["normal", "personal", "restricted"] as const) {
        const record = await store.createMemory(memory(`${kind}-${sensitivity}`, kind, sensitivity));
        assert.equal(
          record.expires_at_ms,
          1_000 + RETENTION.max_age_ms[kind][sensitivity],
        );
      }
    }
    await assert.rejects(
      store.createMemory(memory("too-long", "user_fact", "restricted", {
        expires_at_ms: 1_000 + RETENTION.max_age_ms.user_fact.restricted + 1,
      })),
      /exceeds retention limit/u,
    );
    const independentAclRevision = await store.createMemory(
      memory("independent-acl-revision", "user_fact", "normal", {
        policy_revision: 6,
      }),
    );
    assert.equal(independentAclRevision.policy_revision, 6);
    assert.equal(
      independentAclRevision.expires_at_ms,
      1_000 + RETENTION.max_age_ms.user_fact.normal,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention rejects incomplete policy and legacy non-expiring rows on reopen", async () => {
  const root = directory();
  const path = join(root, "legacy.sqlite");
  try {
    assert.throws(
      () => new SynchronousSqliteAuditStore(join(root, "incomplete.sqlite"), {
        reconcile_on_open: false,
        memory_retention: {
          retention_policy_revision: 7,
          max_age_ms: {
            ...RETENTION.max_age_ms,
            user_fact: { normal: DAY, personal: DAY } as never,
          },
        },
      }),
      /must cover every sensitivity/u,
    );
    {
      using legacy = new SynchronousSqliteAuditStore(path, { reconcile_on_open: false });
      await legacy.createMemory(memory("legacy-no-expiry", "user_fact", "normal", {
        policy_revision: 7,
      }));
    }
    assert.throws(
      () => new SynchronousSqliteAuditStore(path, {
        reconcile_on_open: false,
        memory_retention: RETENTION,
      }),
      /violates retention policy/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database and index quotas roll back the rejected memory write", async () => {
  const root = directory();
  try {
    const databasePath = join(root, "database-quota.sqlite");
    using store = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
      storage_quota: quota(),
    });
    let rejectedId = "";
    for (let index = 0; index < 100; index += 1) {
      const id = `large-${index}`;
      try {
        await store.createMemory(memory(id, "user_fact", "normal", {
          content: `${id}:${"x".repeat(32_000)}`,
        }));
      } catch (error) {
        assert.ok(error instanceof AuditStorageError);
        assert.equal(error.code, "SQLITE_DATABASE_QUOTA_EXCEEDED");
        rejectedId = id;
        break;
      }
    }
    assert.notEqual(rejectedId, "");
    assert.equal(await store.getMemory(rejectedId, "cat", Number.MAX_SAFE_INTEGER), null);
    assert.ok(store.inspectStorageUsage().database_bytes <= quota().max_database_bytes);

    const indexPath = join(root, "index-quota.sqlite");
    let baselineIndexBytes = 0;
    {
      using baseline = new SynchronousSqliteAuditStore(indexPath, {
        reconcile_on_open: false,
      });
      baselineIndexBytes = baseline.inspectStorageUsage().index_bytes;
    }
    using indexStore = new SynchronousSqliteAuditStore(indexPath, {
      reconcile_on_open: false,
      storage_quota: {
        ...quota(),
        max_index_bytes: baselineIndexBytes + quota().max_database_bytes,
      },
    });
    let indexRejected = "";
    for (let index = 0; index < 100; index += 1) {
      const id = `index-overflow-${index}`;
      try {
        await indexStore.createMemory(memory(id, "user_fact", "personal", {
          content: `${id} ${"unique-search-term ".repeat(100)}`.trim(),
          tags: [`index-tag-${index}`],
        }));
      } catch (error) {
        assert.ok(error instanceof AuditStorageError);
        assert.equal(error.code, "SQLITE_INDEX_QUOTA_HEADROOM");
        indexRejected = id;
        break;
      }
    }
    assert.notEqual(indexRejected, "");
    assert.equal(await indexStore.getMemory(indexRejected, "cat", 2_000), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAL quota rejects a new write when a long reader pins prior frames", async () => {
  const root = directory();
  const path = join(root, "wal-quota.sqlite");
  let reader: DatabaseSync | undefined;
  try {
    using store = new SynchronousSqliteAuditStore(path, {
      reconcile_on_open: false,
      storage_quota: quota(),
    });
    reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM memories").get();
    await store.createMemory(memory("wal-first"));
    await assert.rejects(store.createMemory(memory("wal-rejected")), (error) => {
      assert.ok(error instanceof AuditStorageError);
      assert.equal(error.code, "SQLITE_WAL_QUOTA_HEADROOM");
      return true;
    });
    assert.equal(await store.getMemory("wal-rejected", "cat", 2_000), null);
    assert.ok(store.inspectStorageUsage().wal_bytes <= quota().max_wal_bytes);
  } finally {
    if (reader !== undefined) {
      reader.exec("ROLLBACK");
      reader.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage quota rejects impossible WAL headroom and reports worker usage", async () => {
  const root = directory();
  try {
    assert.throws(
      () => new SynchronousSqliteAuditStore(join(root, "bad-wal.sqlite"), {
        reconcile_on_open: false,
        storage_quota: { ...quota(), max_wal_bytes: 4_096 },
      }),
      AuditStorageError,
    );
    const worker = new SqliteAuditStore(join(root, "worker.sqlite"), {
      reconcile_on_open: false,
      storage_quota: quota(),
    });
    try {
      await worker.createMemory(memory("worker-usage"));
      const usage = await worker.inspectStorageUsage();
      assert.equal(usage.page_size, 4_096);
      assert.ok(usage.database_bytes <= quota().max_database_bytes);
      assert.ok(usage.wal_bytes <= quota().max_wal_bytes);
      assert.ok(usage.index_bytes <= quota().max_index_bytes);
    } finally {
      await worker.closeAsync();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database quota is active before schema migration and rolls DDL back", () => {
  const root = directory();
  const path = join(root, "migration-quota.sqlite");
  try {
    assert.throws(
      () => new SynchronousSqliteAuditStore(path, {
        reconcile_on_open: false,
        storage_quota: quota(4_096),
      }),
      (error) => {
        assert.ok(error instanceof AuditStorageError);
        assert.equal(error.code, "SQLITE_DATABASE_QUOTA_EXCEEDED");
        return true;
      },
    );
    const database = new DatabaseSync(path);
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 0);
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
        `).get()?.count,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
