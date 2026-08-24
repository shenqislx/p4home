import assert from "node:assert/strict";
import test from "node:test";

import {
  AuditStorageError,
  SqliteAuditStore,
  SynchronousSqliteAuditStore,
  type MemoryCreate,
  type MemoryKind,
} from "@p4home/storage-sqlite";

function sourceFor(kind: MemoryKind): MemoryCreate["source"] {
  return kind === "user_fact"
    ? "user_explicit"
    : kind === "conversation_summary"
      ? "model_derived"
      : "task_execution";
}

function memory(
  memoryId: string,
  overrides: Partial<MemoryCreate> = {},
): MemoryCreate {
  const kind = overrides.kind ?? "user_fact";
  return {
    schema_version: 1,
    memory_id: memoryId,
    kind,
    content: `recall body ${memoryId}`,
    source: overrides.source ?? sourceFor(kind),
    source_interaction_id: `interaction-${memoryId}`,
    confidence: 0.8,
    sensitivity: "normal",
    owner_role: "robot",
    visibility_scope: "owner_only",
    visible_to_roles: [],
    policy_revision: 2,
    tags: ["phase-6c"],
    created_at_ms: 100,
    expires_at_ms: null,
    ...overrides,
  };
}

test("SQL recall enforces private, shared ACL, and hybrid matrices", async () => {
  using store = new SynchronousSqliteAuditStore(":memory:", { reconcile_on_open: false });
  await store.createMemory(memory("human-private", {
    owner_role: "human",
    kind: "conversation_summary",
    source: "model_derived",
  }));
  for (const kind of [
    "user_fact",
    "conversation_summary",
    "task_outcome",
  ] as const) {
    await store.createMemory(memory(`shared-${kind}`, {
      kind,
      source: sourceFor(kind),
      visibility_scope: "explicit_roles",
      visible_to_roles: ["human"],
    }));
  }
  await store.createMemory(memory("owner-only-cross-role"));
  await store.createMemory(memory("old-policy", {
    visibility_scope: "explicit_roles",
    visible_to_roles: ["human"],
    policy_revision: 1,
  }));
  await store.createMemory(memory("restricted", {
    sensitivity: "restricted",
  }));

  const recall = async (
    strategy: "private" | "shared_acl" | "hybrid",
    withQuery: boolean,
  ) =>
    (await store.recallMemories({
      requester_role: "human",
      strategy,
      approved_policy_revision: 2,
      ...(withQuery ? { query: "recall body" } : {}),
      now_ms: 100,
      limit: 20,
    })).items.map((item) => item.memory_id).sort();

  for (const withQuery of [true, false]) {
    assert.deepEqual(await recall("private", withQuery), ["human-private"]);
    assert.deepEqual(await recall("shared_acl", withQuery), [
      "human-private",
      "shared-conversation_summary",
      "shared-task_outcome",
      "shared-user_fact",
    ]);
    assert.deepEqual(await recall("hybrid", withQuery), ["human-private", "shared-user_fact"]);
  }

  for (const strategy of ["private", "shared_acl", "hybrid"] as const) {
    const ownerView = await store.recallMemories({
      requester_role: "robot",
      strategy,
      approved_policy_revision: 999,
      query: "restricted",
      now_ms: 100,
    });
    assert.deepEqual(ownerView.items.map((item) => item.memory_id), ["restricted"]);
  }
});

test("recall observes ACL revocation, expiry, and deletion on the next query", async () => {
  using store = new SynchronousSqliteAuditStore(":memory:", { reconcile_on_open: false });
  const created = await store.createMemory(memory("mutable-acl", {
    visibility_scope: "explicit_roles",
    visible_to_roles: ["human"],
    expires_at_ms: 200,
  }));
  const query = (now_ms: number) => store.recallMemories({
    requester_role: "human" as const,
    strategy: "shared_acl" as const,
    approved_policy_revision: 2,
    query: "mutable-acl",
    now_ms,
  });
  assert.equal((await query(199)).items.length, 1);
  await store.updateMemory({
    memory_id: "mutable-acl",
    requester_role: "robot",
    expected_revision: created.revision,
    updated_at_ms: 150,
    visibility_scope: "owner_only",
    visible_to_roles: [],
  });
  assert.deepEqual((await query(199)).items, []);

  await store.createMemory(memory("expiring-acl", {
    visibility_scope: "explicit_roles",
    visible_to_roles: ["human"],
    expires_at_ms: 200,
  }));
  assert.equal((await store.recallMemories({
    requester_role: "human",
    strategy: "shared_acl",
    approved_policy_revision: 2,
    query: "expiring-acl",
    now_ms: 199,
  })).items.length, 1);
  assert.equal((await store.recallMemories({
    requester_role: "human",
    strategy: "shared_acl",
    approved_policy_revision: 2,
    query: "expiring-acl",
    now_ms: 200,
  })).items.length, 0);
  assert.equal(await store.deleteMemory("expiring-acl", "robot"), true);
  assert.equal((await store.recallMemories({
    requester_role: "human",
    strategy: "shared_acl",
    approved_policy_revision: 2,
    query: "expiring-acl",
    now_ms: 199,
  })).items.length, 0);

  const policy = await store.createMemory(memory("policy-change", {
    visibility_scope: "explicit_roles",
    visible_to_roles: ["human"],
  }));
  assert.equal((await store.recallMemories({
    requester_role: "human",
    strategy: "shared_acl",
    approved_policy_revision: 2,
    query: "policy-change",
    now_ms: 199,
  })).items.length, 1);
  await store.updateMemory({
    memory_id: policy.memory_id,
    requester_role: "robot",
    expected_revision: policy.revision,
    updated_at_ms: 199,
    policy_revision: 3,
  });
  assert.equal((await store.recallMemories({
    requester_role: "human",
    strategy: "shared_acl",
    approved_policy_revision: 2,
    query: "policy-change",
    now_ms: 199,
  })).items.length, 0);
  assert.equal((await store.recallMemories({
    requester_role: "human",
    strategy: "shared_acl",
    approved_policy_revision: 3,
    query: "policy-change",
    now_ms: 199,
  })).items.length, 1);
});

test("recall query bounds, literal FTS, filters, and stable ordering are deterministic", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  for (const [memoryId, confidence, updatedAt] of [
    ["stable-b", 0.9, 110],
    ["stable-a", 0.9, 110],
    ["stable-c", 0.8, 120],
  ] as const) {
    const created = await store.createMemory(memory(memoryId, {
      content: "用户喜欢书房阅读",
      confidence,
      tags: ["phase-6c", "reading"],
    }));
    await store.updateMemory({
      memory_id: memoryId,
      requester_role: "robot",
      expected_revision: created.revision,
      updated_at_ms: updatedAt,
      content: `用户喜欢书房阅读 ${memoryId}`,
    });
  }
  const recalled = await store.recallMemories({
    requester_role: "robot",
    strategy: "private",
    approved_policy_revision: 2,
    query: "书房阅读",
    kinds: ["user_fact"],
    tags: ["reading"],
    now_ms: 120,
    limit: 3,
  });
  assert.deepEqual(
    recalled.items.map((item) => item.memory_id),
    ["stable-a", "stable-b", "stable-c"],
  );
  assert.deepEqual((await store.recallMemories({
    requester_role: "robot",
    strategy: "private",
    approved_policy_revision: 2,
    query: "书房 OR *",
    now_ms: 120,
  })).items, []);
  assert.deepEqual(
    (await store.recallMemories({
      requester_role: "robot",
      strategy: "private",
      approved_policy_revision: 2,
      query: "书房",
      now_ms: 120,
    })).items.map((item) => item.memory_id),
    ["stable-a", "stable-b", "stable-c"],
  );
  assert.deepEqual((await store.recallMemories({
    requester_role: "robot",
    strategy: "private",
    approved_policy_revision: 2,
    query: "\" OR ( ) * -",
    now_ms: 120,
  })).items, []);

  const latest = await store.createMemory(memory("latest-revision", {
    content: "legacy-only-marker",
  }));
  await store.updateMemory({
    memory_id: latest.memory_id,
    requester_role: "robot",
    expected_revision: latest.revision,
    updated_at_ms: 121,
    content: "current-only-marker",
  });
  assert.deepEqual((await store.recallMemories({
    requester_role: "robot",
    strategy: "private",
    approved_policy_revision: 2,
    query: "legacy-only-marker",
    now_ms: 121,
  })).items, []);
  assert.deepEqual(
    (await store.recallMemories({
      requester_role: "robot",
      strategy: "private",
      approved_policy_revision: 2,
      query: "current-only-marker",
      now_ms: 121,
    })).items.map((item) => item.memory_id),
    ["latest-revision"],
  );
  await assert.rejects(
    store.recallMemories({
      requester_role: "robot",
      strategy: "private",
      approved_policy_revision: 2,
      query: "x",
      kinds: [],
    }),
    AuditStorageError,
  );
  await assert.rejects(
    store.recallMemories({
      requester_role: "robot",
      strategy: "private",
      approved_policy_revision: 2,
      query: "x",
      tags: [],
    }),
    AuditStorageError,
  );
  await assert.rejects(
    store.recallMemories({
      requester_role: "robot",
      strategy: "private",
      approved_policy_revision: 2,
      query: "x",
      limit: 101,
    }),
    /cannot exceed 100/,
  );
  await assert.rejects(
    store.recallMemories({
      requester_role: "robot",
      strategy: "shared_acl",
      approved_policy_revision: 0,
      query: "x",
    }),
    /positive safe integer/,
  );
});
