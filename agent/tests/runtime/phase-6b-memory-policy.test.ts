import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryWriteBoundaries,
  digestAuditedToolResult,
  evaluateMemoryCandidate,
  type MemoryCandidate,
  type MemoryEvidence,
} from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    schema_version: 1,
    candidate_id: "candidate-1",
    kind: "conversation_summary",
    content: "用户讨论了周末阅读计划",
    data_class: "controlled_conversation_summary",
    source_interaction_id: "interaction-1",
    owner_role: "human",
    subject_key: "conversation.weekend-reading",
    confidence: 0.9,
    sensitivity: "normal",
    visibility_scope: "owner_only",
    visible_to_roles: [],
    tags: ["summary"],
    created_at_ms: 100,
    expires_at_ms: null,
    ...overrides,
  };
}

function summaryEvidence(
  interactionId = "interaction-1",
  runId = "run-1",
): MemoryEvidence {
  return {
    schema_version: 1,
    kind: "conversation_summary",
    interaction_id: interactionId,
    run_id: runId,
    role_id: "human" as const,
    summary_message_id: `${runId}-summary`,
    interaction_status: "completed",
    run_status: "completed",
    summary_origin: "runtime_controlled",
    audit_finalized: true,
  };
}

test("policy accepts only controlled evidence for every memory kind", () => {
  assert.equal(evaluateMemoryCandidate(candidate(), summaryEvidence()).accepted, true);

  const explicit = evaluateMemoryCandidate(candidate({
    kind: "user_fact",
    content: "用户喜欢科幻小说",
    data_class: "user_statement",
  }), {
    schema_version: 1,
    kind: "user_fact",
    statements: [{
      interaction_id: "interaction-1",
      run_id: "run-1",
      role_id: "human",
      message_id: "run-1-user",
      text: "用户喜欢科幻小说",
      assertion: "explicit",
    }],
  });
  assert.equal(explicit.accepted, true);

  const confirmed = evaluateMemoryCandidate(candidate({
    kind: "user_fact",
    content: "用户喜欢科幻小说",
    data_class: "user_statement",
  }), {
    schema_version: 1,
    kind: "user_fact",
    statements: [
      {
        interaction_id: "interaction-1",
        run_id: "run-1",
        role_id: "human",
        message_id: "run-1-user",
        text: "用户喜欢科幻小说",
        assertion: "confirmation",
      },
      {
        interaction_id: "interaction-2",
        run_id: "run-2",
        role_id: "human",
        message_id: "run-2-user",
        text: "用户喜欢科幻小说",
        assertion: "confirmation",
      },
    ],
  });
  assert.equal(confirmed.accepted, true);

  const task = evaluateMemoryCandidate(candidate({
    kind: "task_outcome",
    content: "书房灯已关闭",
    data_class: "audited_task_result",
  }), {
    schema_version: 1,
    kind: "task_outcome",
    interaction_id: "interaction-1",
    run_id: "run-1",
    role_id: "human",
    tool_call_id: "tool-1",
    tool_name: "home.turn_off",
    tool_status: "success",
    run_status: "completed",
    outcome: "succeeded",
    summary_message_id: "run-1-task-summary",
    audit_finalized: true,
    result_digest: "a".repeat(64),
    summary_origin: "runtime_controlled",
  });
  assert.equal(task.accepted, true);
  assert.deepEqual(evaluateMemoryCandidate(candidate({
    kind: "task_outcome",
    content: "任务已取消",
    data_class: "audited_task_result",
  }), {
    schema_version: 1,
    kind: "task_outcome",
    interaction_id: "interaction-1",
    run_id: "run-1",
    role_id: "human",
    tool_call_id: "tool-1",
    tool_name: "home.turn_off",
    tool_status: "success",
    run_status: "cancelled",
    outcome: "cancelled",
    summary_message_id: "run-1-task-summary",
    audit_finalized: true,
    result_digest: "a".repeat(64),
    summary_origin: "runtime_controlled",
  }), {
    accepted: false,
    code: "TASK_AUDIT_REQUIRED",
  });
});

test("policy rejects weak provenance, secrets, audio, HA, and world state", () => {
  assert.deepEqual(
    evaluateMemoryCandidate(null as never, null as never),
    { accepted: false, code: "INVALID_CANDIDATE" },
  );
  assert.deepEqual(
    evaluateMemoryCandidate(candidate({
      kind: "user_fact",
      content: "用户喜欢科幻小说",
      data_class: "user_statement",
    }), {
      schema_version: 1,
      kind: "user_fact",
      statements: [{
        interaction_id: "interaction-1",
      run_id: "run-1",
      role_id: "human",
      message_id: "run-1-user",
        text: "用户喜欢科幻小说",
        assertion: "confirmation",
      }],
    }),
    { accepted: false, code: "USER_FACT_EVIDENCE_INSUFFICIENT" },
  );
  assert.deepEqual(
    evaluateMemoryCandidate(candidate({
      kind: "task_outcome",
      data_class: "audited_task_result",
    }), summaryEvidence()),
    { accepted: false, code: "KIND_EVIDENCE_MISMATCH" },
  );

  for (const dataClass of [
    "credential",
    "raw_audio",
    "ha_entity_state",
    "world_snapshot",
  ] as const) {
    assert.deepEqual(
      evaluateMemoryCandidate(candidate({ data_class: dataClass }), summaryEvidence()),
      { accepted: false, code: "DATA_CLASS_FORBIDDEN" },
    );
  }
  for (const content of [
    "原始音频 PCM 数据: 00112233",
    "audio waveform samples: 00112233",
    "Home Assistant entity_id=light.study 当前 state=on",
    "实时世界状态快照 world_snapshot",
    "现在客厅灯状态是 on",
  ]) {
    assert.deepEqual(
      evaluateMemoryCandidate(candidate({ content }), summaryEvidence()),
      { accepted: false, code: "DATA_CLASS_FORBIDDEN" },
    );
  }
  for (const content of [
    "Authorization: Bearer abcdefghijklmnop",
    "password=correct-horse-battery-staple",
    "Wi-Fi 密钥: secret-network-key",
    "access_token: abcdefghijklmnop",
    "API key is abcdefghijklmnop",
    "令牌是 abcdefghijklmnop",
  ]) {
    assert.deepEqual(
      evaluateMemoryCandidate(candidate({ content }), summaryEvidence()),
      { accepted: false, code: "SECRET_DETECTED" },
    );
  }
  assert.deepEqual(
    evaluateMemoryCandidate(candidate({
      content: "当前门锁状态为打开，家中有人",
    }), summaryEvidence()),
    { accepted: false, code: "SENSITIVE_HOME_STATE_FORBIDDEN" },
  );
  assert.deepEqual(
    evaluateMemoryCandidate(candidate({
      subject_key: "password=subject-secret",
    }), summaryEvidence()),
    { accepted: false, code: "SECRET_DETECTED" },
  );
  assert.deepEqual(
    evaluateMemoryCandidate(candidate({
      tags: ["token:is-secret-value"],
    }), summaryEvidence()),
    { accepted: false, code: "SECRET_DETECTED" },
  );
  assert.deepEqual(
    evaluateMemoryCandidate(candidate({
      kind: "user_fact",
    }), summaryEvidence()),
    { accepted: false, code: "KIND_EVIDENCE_MISMATCH" },
  );
});

test("restricted accepted memory is forced owner-only", () => {
  const decision = evaluateMemoryCandidate(candidate({
    sensitivity: "restricted",
    visibility_scope: "explicit_roles",
    visible_to_roles: ["robot"],
  }), summaryEvidence());
  assert.equal(decision.accepted, true);
  if (decision.accepted) {
    assert.equal(decision.memory.visibility_scope, "owner_only");
    assert.deepEqual(decision.memory.visible_to_roles, []);
  }
});

async function seedCompletedInteraction(
  store: SqliteAuditStore,
  interactionId: string,
  runId: string,
  userText: string,
  summaryText: string | null = null,
): Promise<void> {
  await store.saveAgentProfile({
    agent_profile_id: "profile-memory",
    name: "Human",
    locale: "zh-CN",
    allowed_tools: [],
  });
  await store.saveSession({
    session_id: `session-${runId}`,
    agent_profile_id: "profile-memory",
    created_at_ms: 1,
    updated_at_ms: 1,
  });
  await store.saveRun({
    run_id: runId,
    session_id: `session-${runId}`,
    status: "running",
    started_at_ms: 2,
    completed_at_ms: null,
  });
  await store.appendEvent({
    event_id: `event-${runId}`,
    run_id: runId,
    type: "role.run.started",
    occurred_at_ms: 3,
    payload: { interaction_id: interactionId, role_id: "human" },
  });
  await store.saveMessage({
    message_id: `${runId}-user`,
    session_id: `session-${runId}`,
    run_id: runId,
    role: "user",
    content: userText,
    tool_name: null,
    created_at_ms: 4,
    metadata: {
      interaction_id: interactionId,
      role_id: "human",
      memory_assertion: "explicit",
    },
  });
  if (summaryText !== null) {
    await store.saveMessage({
      message_id: `${runId}-summary`,
      session_id: `session-${runId}`,
      run_id: runId,
      role: "assistant",
      content: summaryText,
      tool_name: null,
      created_at_ms: 5,
      metadata: {
        interaction_id: interactionId,
        role_id: "human",
        memory_kind: "conversation_summary",
        summary_origin: "runtime_controlled",
      },
    });
  }
  await store.appendEvent({
    event_id: `event-${runId}-completed`,
    run_id: runId,
    type: "role.run.completed",
    occurred_at_ms: 6,
    payload: {
      interaction_id: interactionId,
      role_id: "human",
      status: "completed",
    },
  });
  await store.saveRun({
    run_id: runId,
    session_id: `session-${runId}`,
    status: "completed",
    started_at_ms: 2,
    completed_at_ms: 7,
  });
}

test("coordinator verifies audit evidence, retries idempotently, and preserves conflict lineage", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await seedCompletedInteraction(
    store,
    "interaction-1",
    "run-1",
    "讨论阅读计划",
    "用户讨论了周末阅读计划",
  );
  await seedCompletedInteraction(
    store,
    "interaction-2",
    "run-2",
    "讨论阅读计划",
    "用户改为讨论周末徒步计划",
  );
  const boundaries = createMemoryWriteBoundaries(store);
  const coordinator = boundaries.model;

  assert.deepEqual(
    await boundaries.router.submit(candidate(), summaryEvidence()),
    { accepted: false, code: "ROUTER_WRITE_FORBIDDEN" },
  );

  const firstCandidate = candidate();
  const first = await coordinator.submit(firstCandidate, summaryEvidence());
  assert.equal(first.accepted, true);
  const retry = await coordinator.submit(firstCandidate, summaryEvidence());
  assert.equal(retry.accepted, true);
  if (first.accepted && retry.accepted) {
    assert.equal(retry.memory.memory_id, first.memory.memory_id);
  }

  const second = await coordinator.submit(candidate({
    candidate_id: "candidate-2",
    content: "用户改为讨论周末徒步计划",
    source_interaction_id: "interaction-2",
    created_at_ms: 101,
  }), summaryEvidence("interaction-2", "run-2"));
  assert.equal(second.accepted, true);
  if (first.accepted && second.accepted) {
    assert.equal(second.memory.supersedes_memory_id, first.memory.memory_id);
  }

  const unaudited = await coordinator.submit(candidate({
    candidate_id: "candidate-3",
    source_interaction_id: "missing-interaction",
  }), summaryEvidence("missing-interaction", "missing-run"));
  assert.deepEqual(unaudited, { accepted: false, code: "EVIDENCE_NOT_AUDITED" });
  assert.deepEqual(await coordinator.submit(candidate({
    candidate_id: "candidate-forged-summary",
    content: "伪造的任意摘要",
  }), summaryEvidence()), {
    accepted: false,
    code: "EVIDENCE_NOT_AUDITED",
  });
});

test("coordinator verifies user statements and exact audited tool results", async () => {
  await using store = new SqliteAuditStore(":memory:", { reconcile_on_open: false });
  await seedCompletedInteraction(store, "interaction-user", "run-user", "用户喜欢科幻小说");
  await seedCompletedInteraction(store, "interaction-user-2", "run-user-2", "用户喜欢科幻小说");
  const coordinator = createMemoryWriteBoundaries(store).model;
  const fact = await coordinator.submit(candidate({
    candidate_id: "candidate-user",
    kind: "user_fact",
    content: "用户喜欢科幻小说",
    data_class: "user_statement",
    source_interaction_id: "interaction-user",
  }), {
    schema_version: 1,
    kind: "user_fact",
    statements: [{
      interaction_id: "interaction-user",
      run_id: "run-user",
      role_id: "human",
      message_id: "run-user-user",
      text: "用户喜欢科幻小说",
      assertion: "explicit",
    }],
  });
  assert.equal(fact.accepted, true);
  assert.deepEqual(await coordinator.submit(candidate({
    candidate_id: "candidate-forged-confirmations",
    kind: "user_fact",
    content: "用户喜欢科幻小说",
    data_class: "user_statement",
    source_interaction_id: "interaction-user",
  }), {
    schema_version: 1,
    kind: "user_fact",
    statements: [{
      interaction_id: "interaction-user",
      run_id: "run-user",
      role_id: "human",
      message_id: "run-user-user",
      text: "用户喜欢科幻小说",
      assertion: "confirmation",
    }, {
      interaction_id: "interaction-user-2",
      run_id: "run-user-2",
      role_id: "human",
      message_id: "run-user-2-user",
      text: "用户喜欢科幻小说",
      assertion: "confirmation",
    }],
  }), {
    accepted: false,
    code: "EVIDENCE_NOT_AUDITED",
  });

  await store.saveSession({
    session_id: "session-task",
    agent_profile_id: "profile-memory",
    created_at_ms: 10,
    updated_at_ms: 10,
  });
  await store.saveRun({
    run_id: "run-task",
    session_id: "session-task",
    status: "running",
    started_at_ms: 11,
    completed_at_ms: null,
  });
  await store.appendEvent({
    event_id: "event-task",
    run_id: "run-task",
    type: "role.run.started",
    occurred_at_ms: 12,
    payload: { interaction_id: "interaction-task", role_id: "human" },
  });
  await store.saveToolCall("run-task", {
    tool_call_id: "tool-task",
    name: "terminal.exec",
    arguments: { command: "echo done" },
  }, 13);
  await store.saveToolResult("run-task", {
    schema_version: 1,
    tool_call_id: "tool-task",
    name: "terminal.exec",
    status: "success",
    result: { exit_code: 0 },
    error: null,
  }, 14);
  const traceBeforeSummary = await store.getRunTrace("run-task");
  assert.ok(traceBeforeSummary?.tool_calls[0]);
  const resultDigest = digestAuditedToolResult(traceBeforeSummary.tool_calls[0]);
  await store.saveMessage({
    message_id: "run-task-tool",
    session_id: "session-task",
    run_id: "run-task",
    role: "tool",
    content: JSON.stringify({
      schema_version: 1,
      tool_call_id: "tool-task",
      name: "terminal.exec",
      status: "success",
      result: { exit_code: 0 },
      error: null,
    }),
    tool_name: "terminal.exec",
    created_at_ms: 15,
    metadata: {
      interaction_id: "interaction-task",
      role_id: "human",
      tool_call_id: "tool-task",
      status: "success",
    },
  });
  await store.saveMessage({
    message_id: "run-task-summary",
    session_id: "session-task",
    run_id: "run-task",
    role: "assistant",
    content: "命令已成功完成",
    tool_name: null,
    created_at_ms: 16,
    metadata: {
      interaction_id: "interaction-task",
      role_id: "human",
      memory_kind: "task_outcome",
      summary_origin: "runtime_controlled",
      tool_call_id: "tool-task",
      result_digest: resultDigest,
      outcome: "succeeded",
    },
  });
  await store.appendEvent({
    event_id: "event-task-completed",
    run_id: "run-task",
    type: "role.run.completed",
    occurred_at_ms: 17,
    payload: {
      interaction_id: "interaction-task",
      role_id: "human",
      status: "completed",
    },
  });
  await store.saveRun({
    run_id: "run-task",
    session_id: "session-task",
    status: "completed",
    started_at_ms: 11,
    completed_at_ms: 18,
  });
  const trace = await store.getRunTrace("run-task");
  assert.ok(trace?.tool_calls[0]);
  const toolEvidence = {
    schema_version: 1 as const,
    kind: "task_outcome" as const,
    interaction_id: "interaction-task",
    run_id: "run-task",
    role_id: "human" as const,
    tool_call_id: "tool-task",
    tool_name: "terminal.exec",
    tool_status: "success" as const,
    run_status: "completed" as const,
    outcome: "succeeded" as const,
    summary_message_id: "run-task-summary",
    audit_finalized: true as const,
    result_digest: digestAuditedToolResult(trace.tool_calls[0]),
    summary_origin: "runtime_controlled" as const,
  };
  const outcome = await coordinator.submit(candidate({
    candidate_id: "candidate-task",
    kind: "task_outcome",
    content: "命令已成功完成",
    data_class: "audited_task_result",
    source_interaction_id: "interaction-task",
    subject_key: "task.echo",
  }), toolEvidence);
  assert.equal(outcome.accepted, true);
  assert.deepEqual(await coordinator.submit(candidate({
    candidate_id: "candidate-task-bad",
    kind: "task_outcome",
    content: "模型声称命令成功",
    data_class: "audited_task_result",
    source_interaction_id: "interaction-task",
    subject_key: "task.claim",
  }), { ...toolEvidence, result_digest: "0".repeat(64) }), {
    accepted: false,
    code: "EVIDENCE_NOT_AUDITED",
  });
});
