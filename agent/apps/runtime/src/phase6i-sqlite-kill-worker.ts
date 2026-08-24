import { pathToFileURL } from "node:url";

import { SynchronousSqliteAuditStore } from "@p4home/storage-sqlite";

async function main(databasePath: string): Promise<void> {
  using store = new SynchronousSqliteAuditStore(databasePath, {
    reconcile_on_open: false,
  });
  for (let index = 0; index < 100_000; index += 1) {
    await store.createMemory({
      schema_version: 1,
      memory_id: `phase6i-kill-${index}`,
      kind: "user_fact",
      content: "x".repeat(4_096),
      source: "user_explicit",
      source_interaction_id: `phase6i-kill-interaction-${index}`,
      confidence: 1,
      sensitivity: "personal",
      owner_role: "robot",
      visibility_scope: "owner_only",
      visible_to_roles: [],
      policy_revision: 1,
      tags: ["phase6i-kill-probe"],
      created_at_ms: index + 1,
      expires_at_ms: null,
    });
    if (index === 0) {
      process.stdout.write("READY\n");
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  const databasePath = process.argv[2];
  if (databasePath === undefined) {
    throw new Error("phase6i kill worker requires a database path");
  }
  void main(databasePath).catch(() => {
    process.exitCode = 1;
  });
}
