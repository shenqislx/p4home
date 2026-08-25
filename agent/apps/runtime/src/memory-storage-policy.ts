import type {
  MemoryRetentionPolicy,
  SqliteAuditStoreOptions,
  SqliteStorageQuota,
} from "@p4home/storage-sqlite";

const MIB = 1_024 * 1_024;
const DAY_MS = 86_400_000;

function deepFreeze<T extends object>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export interface ProductionMemoryStoragePolicy {
  readonly schema_version: 1;
  readonly policy_revision: 1;
  readonly storage_quota: SqliteStorageQuota;
  readonly memory_retention: MemoryRetentionPolicy;
}

/**
 * Phase 6 review-approved production baseline. Callers must opt in explicitly;
 * this is not an implicit default for temporary evaluation or audit Stores.
 */
export const PRODUCTION_MEMORY_STORAGE_POLICY_V1: ProductionMemoryStoragePolicy = deepFreeze({
  schema_version: 1,
  policy_revision: 1,
  storage_quota: {
    max_database_bytes: 128 * MIB,
    max_wal_bytes: 256 * MIB,
    max_index_bytes: 256 * MIB,
  },
  memory_retention: {
    retention_policy_revision: 1,
    max_age_ms: {
      conversation_summary: {
        normal: 30 * DAY_MS,
        personal: 14 * DAY_MS,
        restricted: 7 * DAY_MS,
      },
      user_fact: {
        normal: 365 * DAY_MS,
        personal: 180 * DAY_MS,
        restricted: 30 * DAY_MS,
      },
      task_outcome: {
        normal: 90 * DAY_MS,
        personal: 60 * DAY_MS,
        restricted: 30 * DAY_MS,
      },
    },
  },
});

export function productionMemoryStoreOptions(): Pick<
  SqliteAuditStoreOptions,
  "storage_quota" | "memory_retention"
> {
  const policy = PRODUCTION_MEMORY_STORAGE_POLICY_V1;
  return {
    storage_quota: { ...policy.storage_quota },
    memory_retention: {
      retention_policy_revision: policy.memory_retention.retention_policy_revision,
      max_age_ms: {
        conversation_summary: { ...policy.memory_retention.max_age_ms.conversation_summary },
        user_fact: { ...policy.memory_retention.max_age_ms.user_fact },
        task_outcome: { ...policy.memory_retention.max_age_ms.task_outcome },
      },
    },
  };
}
