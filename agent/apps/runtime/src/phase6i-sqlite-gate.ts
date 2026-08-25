import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  AuditStorageError,
  SynchronousSqliteAuditStore,
  type AuditStorageErrorCode,
  type MemoryCreate,
  type MemoryKind,
  type MemoryRetentionPolicy,
  type MemorySensitivity,
  type SqliteStorageQuota,
} from "@p4home/storage-sqlite";

const execFileAsync = promisify(execFile);

interface ControlledKillResult {
  readonly signal: string | null;
  readonly integrity_check: string;
  readonly committed_memory_count: number;
  readonly checkpoint_busy: number;
  readonly reopen_read_count_bounded: number;
}

export interface Phase6iAssessmentInput {
  readonly directory_mode: string;
  readonly database_mode: string;
  readonly wal_mode: string;
  readonly shm_mode: string;
  readonly journal_mode: string;
  readonly synchronous: number;
  readonly secure_delete: number;
  readonly reopen_read: boolean;
  readonly permissive_database_rejected: boolean;
  readonly permissive_sidecar_rejected: boolean;
  readonly integrity_check: string;
  readonly corruption_rejected: boolean;
  readonly controlled_kill_signal: string | null;
  readonly post_kill_integrity_check: string;
  readonly post_kill_committed_memory_count: number;
  readonly post_kill_checkpoint_busy: number;
  readonly post_kill_reopen_read_count_bounded: number;
  readonly online_backup_mode: string;
  readonly online_backup_integrity_check: string;
  readonly online_backup_pages_transferred: number;
  readonly online_backup_restored_memory_count: number;
  readonly online_backup_excludes_post_snapshot_memory: boolean;
  readonly backup_mode: string;
  readonly backup_integrity_check: string;
  readonly backup_restored_memory_count: number;
  readonly database_quota_rejected: boolean;
  readonly database_quota_bytes: number;
  readonly database_quota_limit_bytes: number;
  readonly wal_quota_rejected_with_pinned_reader: boolean;
  readonly wal_quota_bytes: number;
  readonly wal_quota_limit_bytes: number;
  readonly index_quota_rejected: boolean;
  readonly index_quota_bytes: number;
  readonly index_quota_limit_bytes: number;
  readonly retention_matrix_validated: boolean;
  readonly retention_overlong_rejected: boolean;
  readonly retention_legacy_reopen_rejected: boolean;
  readonly retention_expired_purge_propagated: boolean;
}

export interface Phase6iSqliteGateResult extends Phase6iAssessmentInput {
  readonly schema_version: 1;
  readonly profile: "phase6i_sqlite_filesystem_v1";
  readonly passed: boolean;
  readonly generated_at: string;
  readonly git_sha: string;
  readonly worktree_clean: boolean;
  readonly worktree_status_sha256: string;
  readonly evidence_scope: "local_precommit" | "commit_bound";
  readonly platform: NodeJS.Platform;
  readonly real_filesystem: true;
  readonly controlled_process_kill_performed: true;
  readonly cold_backup_after_checkpoint: true;
  readonly real_power_loss_performed: false;
  readonly online_backup_api_validated: true;
  readonly quota_gate_validated: boolean;
  readonly retention_gate_validated: boolean;
  readonly encryption_gate_validated: false;
  readonly secure_delete_gate_validated: false;
  readonly reason: "ok" | "gate_failed";
}

export function assessPhase6iSqliteGate(input: Phase6iAssessmentInput): boolean {
  return input.directory_mode === "700"
    && input.database_mode === "600"
    && input.wal_mode === "600"
    && input.shm_mode === "600"
    && input.journal_mode === "wal"
    && input.synchronous === 1
    && input.reopen_read
    && input.permissive_database_rejected
    && input.permissive_sidecar_rejected
    && input.integrity_check === "ok"
    && input.corruption_rejected
    && input.controlled_kill_signal === "SIGKILL"
    && input.post_kill_integrity_check === "ok"
    && input.post_kill_committed_memory_count >= 1
    && input.post_kill_checkpoint_busy === 0
    && input.post_kill_reopen_read_count_bounded >= 1
    && input.online_backup_mode === "600"
    && input.online_backup_integrity_check === "ok"
    && input.online_backup_pages_transferred > 0
    && input.online_backup_restored_memory_count === 1
    && input.online_backup_excludes_post_snapshot_memory
    && input.backup_mode === "600"
    && input.backup_integrity_check === "ok"
    && input.backup_restored_memory_count === 1
    && assessPhase6iQuotaGate(input)
    && assessPhase6iRetentionGate(input);
}

export function assessPhase6iQuotaGate(input: Phase6iAssessmentInput): boolean {
  return input.database_quota_rejected
    && input.database_quota_bytes <= input.database_quota_limit_bytes
    && input.wal_quota_rejected_with_pinned_reader
    && input.wal_quota_bytes <= input.wal_quota_limit_bytes
    && input.index_quota_rejected
    && input.index_quota_bytes <= input.index_quota_limit_bytes;
}

export function assessPhase6iRetentionGate(input: Phase6iAssessmentInput): boolean {
  return input.retention_matrix_validated
    && input.retention_overlong_rejected
    && input.retention_legacy_reopen_rejected
    && input.retention_expired_purge_propagated;
}

function mode(path: string): string {
  return (lstatSync(path).mode & 0o777).toString(8).padStart(3, "0");
}

function rowString(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string`);
  }
  return value;
}

function rowNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`${key} must be numeric`);
  }
  return Number(value);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
  chmodSync(path, 0o600);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createProbeMemory(memoryId: string, createdAtMs = 1) {
  return {
    schema_version: 1 as const,
    memory_id: memoryId,
    kind: "user_fact" as const,
    content: "synthetic Phase 6I filesystem probe",
    source: "user_explicit" as const,
    source_interaction_id: `${memoryId}-interaction`,
    confidence: 1,
    sensitivity: "personal" as const,
    owner_role: "robot" as const,
    visibility_scope: "owner_only" as const,
    visible_to_roles: [],
    policy_revision: 1,
    tags: ["phase6i-probe"],
    created_at_ms: createdAtMs,
    expires_at_ms: null,
  };
}

const POLICY_DAY_MS = 86_400_000;
const SYNTHETIC_RETENTION_POLICY: MemoryRetentionPolicy = {
  retention_policy_revision: 19,
  max_age_ms: {
    conversation_summary: {
      normal: 30 * POLICY_DAY_MS,
      personal: 14 * POLICY_DAY_MS,
      restricted: 7 * POLICY_DAY_MS,
    },
    user_fact: {
      normal: 365 * POLICY_DAY_MS,
      personal: 180 * POLICY_DAY_MS,
      restricted: 30 * POLICY_DAY_MS,
    },
    task_outcome: {
      normal: 90 * POLICY_DAY_MS,
      personal: 60 * POLICY_DAY_MS,
      restricted: 30 * POLICY_DAY_MS,
    },
  },
};

function policySource(kind: MemoryKind): MemoryCreate["source"] {
  return ({
    conversation_summary: "model_derived",
    user_fact: "user_explicit",
    task_outcome: "task_execution",
  } as const)[kind];
}

function policyMemory(
  memoryId: string,
  kind: MemoryKind,
  sensitivity: MemorySensitivity,
  expiresAtMs: number | null = null,
): MemoryCreate {
  return {
    ...createProbeMemory(memoryId, 1_000),
    kind,
    source: policySource(kind),
    sensitivity,
    policy_revision: 1,
    expires_at_ms: expiresAtMs,
  };
}

function assertExpectedStorageError(
  error: unknown,
  code: AuditStorageErrorCode,
  label: string,
): void {
  assert.ok(error instanceof AuditStorageError, `${label} must throw AuditStorageError`);
  assert.equal(error.code, code, `${label} must throw ${code}`);
}

function syntheticQuota(maxDatabaseBytes = 512 * 1_024): SqliteStorageQuota {
  const pageSize = 4_096;
  const pages = Math.floor(maxDatabaseBytes / pageSize);
  return {
    max_database_bytes: maxDatabaseBytes,
    max_wal_bytes: 32 + pages * (pageSize + 24),
    max_index_bytes: maxDatabaseBytes * 2,
  };
}

interface StoragePolicyProbeResult {
  readonly database_quota_rejected: boolean;
  readonly database_quota_bytes: number;
  readonly database_quota_limit_bytes: number;
  readonly wal_quota_rejected_with_pinned_reader: boolean;
  readonly wal_quota_bytes: number;
  readonly wal_quota_limit_bytes: number;
  readonly index_quota_rejected: boolean;
  readonly index_quota_bytes: number;
  readonly index_quota_limit_bytes: number;
  readonly retention_matrix_validated: boolean;
  readonly retention_overlong_rejected: boolean;
  readonly retention_legacy_reopen_rejected: boolean;
  readonly retention_expired_purge_propagated: boolean;
}

async function storagePolicyProbe(directory: string): Promise<StoragePolicyProbeResult> {
  const quota = syntheticQuota();
  const databasePath = join(directory, "quota-database.sqlite");
  let databaseQuotaRejected = false;
  let databaseQuotaBytes = 0;
  {
    using store = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
      storage_quota: quota,
    });
    for (let index = 0; index < 100; index += 1) {
      const memoryId = `quota-database-${index}`;
      try {
        await store.createMemory({
          ...createProbeMemory(memoryId, index + 1),
          content: `quota-database-${index}:${"x".repeat(32_000)}`,
        });
      } catch (error) {
        assertExpectedStorageError(
          error,
          "SQLITE_DATABASE_QUOTA_EXCEEDED",
          "database quota probe",
        );
        assert.equal(await store.getMemory(memoryId, "robot", Number.MAX_SAFE_INTEGER), null);
        databaseQuotaRejected = true;
        break;
      }
    }
    databaseQuotaBytes = store.inspectStorageUsage().database_bytes;
  }

  const indexPath = join(directory, "quota-index.sqlite");
  let baselineIndexBytes = 0;
  {
    using baseline = new SynchronousSqliteAuditStore(indexPath, {
      reconcile_on_open: false,
    });
    baselineIndexBytes = baseline.inspectStorageUsage().index_bytes;
  }
  let indexQuotaRejected = false;
  let indexQuotaBytes = 0;
  {
    using store = new SynchronousSqliteAuditStore(indexPath, {
      reconcile_on_open: false,
      storage_quota: {
        ...quota,
        max_index_bytes: baselineIndexBytes + quota.max_database_bytes,
      },
    });
    for (let index = 0; index < 100; index += 1) {
      const memoryId = `quota-index-${index}`;
      try {
        await store.createMemory({
          ...createProbeMemory(memoryId, index + 1),
          content: (`quota-index-${index} ${"unique-search-term ".repeat(100)}`).trim(),
          tags: [`quota-index-${index}`],
        });
      } catch (error) {
        assertExpectedStorageError(
          error,
          "SQLITE_INDEX_QUOTA_HEADROOM",
          "index quota probe",
        );
        assert.equal(await store.getMemory(memoryId, "robot", Number.MAX_SAFE_INTEGER), null);
        indexQuotaRejected = true;
        break;
      }
    }
    indexQuotaBytes = store.inspectStorageUsage().index_bytes;
  }

  const walPath = join(directory, "quota-wal.sqlite");
  let walQuotaRejected = false;
  let walQuotaBytes = 0;
  let reader: DatabaseSync | undefined;
  try {
    using store = new SynchronousSqliteAuditStore(walPath, {
      reconcile_on_open: false,
      storage_quota: quota,
    });
    reader = new DatabaseSync(walPath, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM memories").get();
    await store.createMemory(createProbeMemory("quota-wal-first"));
    try {
      await store.createMemory(createProbeMemory("quota-wal-rejected", 2));
    } catch (error) {
      assertExpectedStorageError(
        error,
        "SQLITE_WAL_QUOTA_HEADROOM",
        "WAL quota probe",
      );
      assert.equal(
        await store.getMemory("quota-wal-rejected", "robot", Number.MAX_SAFE_INTEGER),
        null,
      );
      walQuotaRejected = true;
    }
    walQuotaBytes = store.inspectStorageUsage().wal_bytes;
  } finally {
    if (reader !== undefined) {
      reader.exec("ROLLBACK");
      reader.close();
    }
  }

  const retentionPath = join(directory, "retention.sqlite");
  let retentionMatrixValidated = true;
  let retentionOverlongRejected = false;
  let retentionExpiredPurgePropagated = false;
  {
    using store = new SynchronousSqliteAuditStore(retentionPath, {
      reconcile_on_open: false,
      memory_retention: SYNTHETIC_RETENTION_POLICY,
    });
    for (const kind of [
      "conversation_summary",
      "user_fact",
      "task_outcome",
    ] as const) {
      for (const sensitivity of ["normal", "personal", "restricted"] as const) {
        const record = await store.createMemory(policyMemory(
          `retention-${kind}-${sensitivity}`,
          kind,
          sensitivity,
        ));
        retentionMatrixValidated &&=
          record.expires_at_ms === 1_000
            + SYNTHETIC_RETENTION_POLICY.max_age_ms[kind][sensitivity];
      }
    }
    try {
      await store.createMemory(policyMemory(
        "retention-too-long",
        "user_fact",
        "restricted",
        1_001 + SYNTHETIC_RETENTION_POLICY.max_age_ms.user_fact.restricted,
      ));
    } catch (error) {
      assertExpectedStorageError(
        error,
        "MEMORY_RETENTION_EXPIRY_EXCEEDED",
        "retention overlong probe",
      );
      assert.equal(
        await store.getMemory("retention-too-long", "robot", Number.MAX_SAFE_INTEGER),
        null,
      );
      retentionOverlongRejected = true;
    }
    const expired = await store.createMemory(policyMemory(
      "retention-expired",
      "conversation_summary",
      "normal",
      1_001,
    ));
    const purged = await store.purgeExpiredMemories(1_001);
    retentionExpiredPurgePropagated = purged === 1
      && await store.getMemory(expired.memory_id, "robot", 1_001) === null;
  }

  const legacyPath = join(directory, "retention-legacy.sqlite");
  {
    using legacy = new SynchronousSqliteAuditStore(legacyPath, {
      reconcile_on_open: false,
    });
    await legacy.createMemory({
      ...createProbeMemory("retention-legacy"),
      policy_revision: 1,
    });
  }
  {
    using readable = new SynchronousSqliteAuditStore(legacyPath, {
      reconcile_on_open: false,
    });
    assert.notEqual(
      await readable.getMemory("retention-legacy", "robot", Number.MAX_SAFE_INTEGER),
      null,
    );
  }
  let retentionLegacyReopenRejected = false;
  try {
    using ignored = new SynchronousSqliteAuditStore(legacyPath, {
      reconcile_on_open: false,
      memory_retention: SYNTHETIC_RETENTION_POLICY,
    });
    void ignored;
  } catch (error) {
    assertExpectedStorageError(
      error,
      "MEMORY_RETENTION_EXISTING_ROW_VIOLATION",
      "retention legacy reopen probe",
    );
    retentionLegacyReopenRejected = true;
  }

  return {
    database_quota_rejected: databaseQuotaRejected,
    database_quota_bytes: databaseQuotaBytes,
    database_quota_limit_bytes: quota.max_database_bytes,
    wal_quota_rejected_with_pinned_reader: walQuotaRejected,
    wal_quota_bytes: walQuotaBytes,
    wal_quota_limit_bytes: quota.max_wal_bytes,
    index_quota_rejected: indexQuotaRejected,
    index_quota_bytes: indexQuotaBytes,
    index_quota_limit_bytes: baselineIndexBytes + quota.max_database_bytes,
    retention_matrix_validated: retentionMatrixValidated,
    retention_overlong_rejected: retentionOverlongRejected,
    retention_legacy_reopen_rejected: retentionLegacyReopenRejected,
    retention_expired_purge_propagated: retentionExpiredPurgePropagated,
  };
}

function storeOpenRejected(databasePath: string): boolean {
  try {
    const store = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
    });
    store.close();
    return false;
  } catch {
    return true;
  }
}

async function waitForChildReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;
  if (stdout === null) {
    throw new Error("controlled-kill child stdout is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffered = "";
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("controlled-kill child did not become ready"));
      }
    }, 10_000);
    stdout.on("data", (chunk: Buffer) => {
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(-4_096);
      if (!settled && buffered.includes("READY\n")) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`controlled-kill child exited before ready: ${code ?? signal}`));
      }
    });
  });
}

async function controlledKillProbe(databasePath: string): Promise<ControlledKillResult> {
  const workerPath = fileURLToPath(new URL("./phase6i-sqlite-kill-worker.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, databasePath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForChildReady(child);
    const exit = once(child, "exit");
    await delay(25);
    assert.equal(child.kill("SIGKILL"), true);
    const [exitCode, signal] = await exit as [number | null, NodeJS.Signals | null];
    assert.equal(exitCode, null);

    const database = new DatabaseSync(databasePath);
    const integrityCheck = rowString(
      database.prepare("PRAGMA integrity_check").get(),
      "integrity_check",
    );
    const committedMemoryCount = rowNumber(
      database.prepare("SELECT COUNT(*) AS count FROM memories").get(),
      "count",
    );
    const checkpointBusy = rowNumber(
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(),
      "busy",
    );
    database.close();

    using reopened = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
    });
    const page = await reopened.listMemories({
      requester_role: "robot",
      limit: 100,
    });
    return {
      signal,
      integrity_check: integrityCheck,
      committed_memory_count: committedMemoryCount,
      checkpoint_busy: checkpointBusy,
      reopen_read_count_bounded: page.items.length,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

export async function runPhase6iSqliteGate(): Promise<Phase6iSqliteGateResult> {
  const repoRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })).stdout.trim();
  const gitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })).stdout.trim();
  const worktreeStatus = (await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repoRoot, encoding: "utf8" },
  )).stdout;
  const worktreeClean = worktreeStatus.trim().length === 0;
  const directory = mkdtempSync(join(tmpdir(), "p4home-phase6i-gate-"));
  chmodSync(directory, 0o700);

  try {
    const databasePath = join(directory, "primary.sqlite");
    const store = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
    });
    const pragmas = store.inspectOperationalPragmas();
    await store.createMemory(createProbeMemory("phase6i-primary"));
    const onlineBackupPath = join(directory, "online-backup.sqlite");
    const onlineBackup = await store.backup(onlineBackupPath);
    await store.createMemory(createProbeMemory("phase6i-post-online-backup", 2));
    const directoryMode = mode(directory);
    const databaseMode = mode(databasePath);
    assert.equal(existsSync(`${databasePath}-wal`), true);
    assert.equal(existsSync(`${databasePath}-shm`), true);
    const walMode = mode(`${databasePath}-wal`);
    const shmMode = mode(`${databasePath}-shm`);
    store.close();

    const onlineBackupDatabase = new DatabaseSync(onlineBackupPath, { readOnly: true });
    const onlineBackupIntegrityCheck = rowString(
      onlineBackupDatabase.prepare("PRAGMA integrity_check").get(),
      "integrity_check",
    );
    const onlineBackupRestoredMemoryCount = rowNumber(
      onlineBackupDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?",
      ).get("phase6i-primary"),
      "count",
    );
    const onlineBackupPostSnapshotMemoryCount = rowNumber(
      onlineBackupDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?",
      ).get("phase6i-post-online-backup"),
      "count",
    );
    onlineBackupDatabase.close();

    using reopened = new SynchronousSqliteAuditStore(databasePath, {
      reconcile_on_open: false,
    });
    const reopenRead = (await reopened.getMemory(
      "phase6i-primary",
      "robot",
      1,
    ))?.memory_id === "phase6i-primary";
    reopened.close();

    const database = new DatabaseSync(databasePath);
    const integrityCheck = rowString(
      database.prepare("PRAGMA integrity_check").get(),
      "integrity_check",
    );
    const checkpointBusy = rowNumber(
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(),
      "busy",
    );
    assert.equal(checkpointBusy, 0);
    database.close();

    const backupPath = join(directory, "backup.sqlite");
    copyFileSync(databasePath, backupPath);
    chmodSync(backupPath, 0o600);
    const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
    const backupIntegrityCheck = rowString(
      backupDatabase.prepare("PRAGMA integrity_check").get(),
      "integrity_check",
    );
    const backupRestoredMemoryCount = rowNumber(
      backupDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?",
      ).get("phase6i-primary"),
      "count",
    );
    backupDatabase.close();

    const permissivePath = join(directory, "permissive.sqlite");
    {
      using permissive = new SynchronousSqliteAuditStore(permissivePath, {
        reconcile_on_open: false,
      });
    }
    chmodSync(permissivePath, 0o644);
    const permissiveDatabaseRejected = storeOpenRejected(permissivePath);

    const permissiveSidecarPath = join(directory, "permissive-sidecar.sqlite");
    writeFileSync(`${permissiveSidecarPath}-wal`, "synthetic invalid WAL", {
      mode: 0o644,
    });
    const permissiveSidecarRejected = storeOpenRejected(permissiveSidecarPath);

    const corruptPath = join(directory, "corrupt.sqlite");
    copyFileSync(backupPath, corruptPath);
    chmodSync(corruptPath, 0o600);
    truncateSync(corruptPath, Math.max(512, Math.floor(lstatSync(corruptPath).size / 3)));
    const corruptionRejected = storeOpenRejected(corruptPath);

    const killResult = await controlledKillProbe(join(directory, "kill.sqlite"));
    const storagePolicy = await storagePolicyProbe(directory);
    const assessment: Phase6iAssessmentInput = {
      directory_mode: directoryMode,
      database_mode: databaseMode,
      wal_mode: walMode,
      shm_mode: shmMode,
      journal_mode: pragmas.journal_mode,
      synchronous: pragmas.synchronous,
      secure_delete: pragmas.secure_delete,
      reopen_read: reopenRead,
      permissive_database_rejected: permissiveDatabaseRejected,
      permissive_sidecar_rejected: permissiveSidecarRejected,
      integrity_check: integrityCheck,
      corruption_rejected: corruptionRejected,
      controlled_kill_signal: killResult.signal,
      post_kill_integrity_check: killResult.integrity_check,
      post_kill_committed_memory_count: killResult.committed_memory_count,
      post_kill_checkpoint_busy: killResult.checkpoint_busy,
      post_kill_reopen_read_count_bounded: killResult.reopen_read_count_bounded,
      online_backup_mode: mode(onlineBackupPath),
      online_backup_integrity_check: onlineBackupIntegrityCheck,
      online_backup_pages_transferred: onlineBackup.pages_transferred,
      online_backup_restored_memory_count: onlineBackupRestoredMemoryCount,
      online_backup_excludes_post_snapshot_memory:
        onlineBackupPostSnapshotMemoryCount === 0,
      backup_mode: mode(backupPath),
      backup_integrity_check: backupIntegrityCheck,
      backup_restored_memory_count: backupRestoredMemoryCount,
      ...storagePolicy,
    };
    const passed = assessPhase6iSqliteGate(assessment);
    const quotaGateValidated = assessPhase6iQuotaGate(assessment);
    const retentionGateValidated = assessPhase6iRetentionGate(assessment);
    return {
      schema_version: 1,
      profile: "phase6i_sqlite_filesystem_v1",
      passed,
      generated_at: new Date().toISOString(),
      git_sha: gitSha,
      worktree_clean: worktreeClean,
      worktree_status_sha256: hash(worktreeStatus),
      evidence_scope: worktreeClean ? "commit_bound" : "local_precommit",
      platform: process.platform,
      real_filesystem: true,
      controlled_process_kill_performed: true,
      cold_backup_after_checkpoint: true,
      real_power_loss_performed: false,
      online_backup_api_validated: true,
      quota_gate_validated: quotaGateValidated,
      retention_gate_validated: retentionGateValidated,
      encryption_gate_validated: false,
      secure_delete_gate_validated: false,
      ...assessment,
      reason: passed ? "ok" : "gate_failed",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const result = await runPhase6iSqliteGate();
  const resultFile = process.env.P4HOME_PHASE6I_RESULT_FILE?.trim();
  if (resultFile) {
    await atomicJson(resultFile, result);
  }
  process.stdout.write(
    `VERIFY:phase6i:sqlite_filesystem:${result.passed ? "PASS" : "FAIL"} `
    + `mode=${result.database_mode} wal=${result.wal_mode} shm=${result.shm_mode} `
    + `kill=${result.controlled_kill_signal ?? "none"} integrity=${result.integrity_check} `
    + `online_backup=${result.online_backup_integrity_check}\n`,
  );
  process.stdout.write(
    `VERIFY:phase6i:storage_policy:${result.passed ? "PASS" : "FAIL"} `
    + `database=${result.database_quota_bytes}/${result.database_quota_limit_bytes} `
    + `wal=${result.wal_quota_bytes}/${result.wal_quota_limit_bytes} `
    + `index=${result.index_quota_bytes}/${result.index_quota_limit_bytes} `
    + `retention_matrix=${result.retention_matrix_validated}\n`,
  );
  return result.passed ? 0 : 1;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write("VERIFY:phase6i:sqlite_filesystem:FAIL reason=unexpected_error\n");
      process.exitCode = 1;
    },
  );
}
