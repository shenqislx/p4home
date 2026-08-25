import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPhase6iQuotaGate,
  assessPhase6iRetentionGate,
  assessPhase6iSqliteGate,
  runPhase6iSqliteGate,
  type Phase6iAssessmentInput,
} from "../../apps/runtime/src/phase6i-sqlite-gate.ts";

const PASSING: Phase6iAssessmentInput = {
  directory_mode: "700",
  database_mode: "600",
  wal_mode: "600",
  shm_mode: "600",
  journal_mode: "wal",
  synchronous: 1,
  secure_delete: 0,
  reopen_read: true,
  permissive_database_rejected: true,
  permissive_sidecar_rejected: true,
  integrity_check: "ok",
  corruption_rejected: true,
  controlled_kill_signal: "SIGKILL",
  post_kill_integrity_check: "ok",
  post_kill_committed_memory_count: 1,
  post_kill_checkpoint_busy: 0,
  post_kill_reopen_read_count_bounded: 1,
  online_backup_mode: "600",
  online_backup_integrity_check: "ok",
  online_backup_pages_transferred: 1,
  online_backup_restored_memory_count: 1,
  online_backup_excludes_post_snapshot_memory: true,
  backup_mode: "600",
  backup_integrity_check: "ok",
  backup_restored_memory_count: 1,
  database_quota_rejected: true,
  database_quota_bytes: 500,
  database_quota_limit_bytes: 500,
  wal_quota_rejected_with_pinned_reader: true,
  wal_quota_bytes: 400,
  wal_quota_limit_bytes: 500,
  index_quota_rejected: true,
  index_quota_bytes: 300,
  index_quota_limit_bytes: 300,
  retention_matrix_validated: true,
  retention_overlong_rejected: true,
  retention_legacy_reopen_rejected: true,
  retention_expired_purge_propagated: true,
};

test("Phase 6I assessment fails closed for every required filesystem signal", () => {
  assert.equal(assessPhase6iSqliteGate(PASSING), true);
  const mutations: readonly Partial<Phase6iAssessmentInput>[] = [
    { directory_mode: "755" },
    { database_mode: "644" },
    { wal_mode: "644" },
    { shm_mode: "644" },
    { journal_mode: "delete" },
    { synchronous: 2 },
    { reopen_read: false },
    { permissive_database_rejected: false },
    { permissive_sidecar_rejected: false },
    { integrity_check: "malformed" },
    { corruption_rejected: false },
    { controlled_kill_signal: null },
    { post_kill_integrity_check: "malformed" },
    { post_kill_committed_memory_count: 0 },
    { post_kill_checkpoint_busy: 1 },
    { post_kill_reopen_read_count_bounded: 0 },
    { online_backup_mode: "644" },
    { online_backup_integrity_check: "malformed" },
    { online_backup_pages_transferred: 0 },
    { online_backup_restored_memory_count: 0 },
    { online_backup_excludes_post_snapshot_memory: false },
    { backup_mode: "644" },
    { backup_integrity_check: "malformed" },
    { backup_restored_memory_count: 0 },
    { database_quota_rejected: false },
    { database_quota_bytes: 501 },
    { wal_quota_rejected_with_pinned_reader: false },
    { wal_quota_bytes: 501 },
    { index_quota_rejected: false },
    { index_quota_bytes: 301 },
    { retention_matrix_validated: false },
    { retention_overlong_rejected: false },
    { retention_legacy_reopen_rejected: false },
    { retention_expired_purge_propagated: false },
  ];
  for (const mutation of mutations) {
    assert.equal(assessPhase6iSqliteGate({ ...PASSING, ...mutation }), false);
  }
});

test("Phase 6I quota and retention validated flags reflect their own probes", () => {
  assert.equal(assessPhase6iQuotaGate(PASSING), true);
  assert.equal(assessPhase6iRetentionGate(PASSING), true);
  assert.equal(assessPhase6iQuotaGate({ ...PASSING, database_quota_rejected: false }), false);
  assert.equal(
    assessPhase6iRetentionGate({ ...PASSING, retention_overlong_rejected: false }),
    false,
  );
});

test("Phase 6I gate runs on a real filesystem without overstating pending gates", async () => {
  const result = await runPhase6iSqliteGate();
  assert.equal(result.passed, true);
  assert.equal(result.real_filesystem, true);
  assert.equal(result.controlled_process_kill_performed, true);
  assert.equal(result.cold_backup_after_checkpoint, true);
  assert.equal(result.real_power_loss_performed, false);
  assert.equal(result.online_backup_api_validated, true);
  assert.equal(result.quota_gate_validated, true);
  assert.equal(result.retention_gate_validated, true);
  assert.equal(result.encryption_gate_validated, false);
  assert.equal(result.secure_delete_gate_validated, false);
});
