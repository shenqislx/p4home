import { readFile, writeFile } from "node:fs/promises";

import {
  CatEventPolicy,
  DeviceRuntimeHub,
  RoleScheduler,
  runCatRoomTargetEvent,
} from "@p4home/runtime";

const ACTION_COUNT = 100;
const RECONNECT_AFTER_ACTIONS = 50;
const ROOMS = [
  "primary_bedroom",
  "study",
  "guest_room",
  "entry",
  "living_room",
  "kitchen",
] as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`missing_${name.toLowerCase()}`);
  }
  return value;
}

function positivePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid_agent_port");
  }
  return port;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  reason: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(reason);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  const deviceId = requiredEnvironment("P4HOME_AGENT_DEVICE_ID");
  const deviceToken = (
    await readFile(requiredEnvironment("P4HOME_AGENT_DEVICE_TOKEN_FILE"), "utf8")
  ).trim();
  const key = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_KEY_FILE"));
  const cert = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_CERT_FILE"));
  const readyFile = requiredEnvironment("P4HOME_HARNESS_READY_FILE");
  const resultFile = requiredEnvironment("P4HOME_HARNESS_RESULT_FILE");
  const port = positivePort(requiredEnvironment("P4HOME_AGENT_PORT"));
  const hub = new DeviceRuntimeHub({
    server: {
      host: "0.0.0.0",
      port,
      tls: { key, cert },
      device_tokens: { [deviceId]: deviceToken },
      max_connections: 1,
    },
    handshake_timeout_ms: 30_000,
  });
  const policy = new CatEventPolicy({ minimum_interval_ms: 0 });
  const scheduler = new RoleScheduler();
  let closed = false;
  const closeHub = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await hub.close();
    }
  };
  process.once("SIGTERM", () => void closeHub());
  process.once("SIGINT", () => void closeHub());

  try {
    await hub.start();
    await writeFile(readyFile, "ready\n", { mode: 0o600 });
    process.stdout.write("HARNESS:agent_server:READY\n");
    await waitUntil(() => hub.getAdapter(deviceId)?.is_ready === true, 120_000,
      "device_handshake_timeout");
    const adapter = hub.getAdapter(deviceId);
    if (adapter === undefined) {
      throw new Error("device_adapter_missing");
    }

    let maxAcceptedLatencyMs = 0;
    let maxStartedLatencyMs = 0;
    let maxCompletedLatencyMs = 0;
    let reconnectSnapshotVersion = 0;
    for (let index = 0; index < ACTION_COUNT; index += 1) {
      const room = ROOMS[index % ROOMS.length]!;
      const now = Date.now();
      const result = await runCatRoomTargetEvent({
        event: {
          event_id: `hardware-event-${index}`,
          event_type: "test.room_target",
          source: "test_harness",
          occurred_at_ms: now,
          payload: { room_target: room },
        },
        run_id: `hardware-run-${index}`,
        session_id: "hardware-cat-session",
        session_created_at_ms: now,
        tool_call_id: `hardware-tool-call-${index}`,
        action_id: `hardware-action-${index}`,
        policy,
        scheduler,
        adapter,
        provider: {
          async chat() {
            return {
              model: "phase-2d-hardware-deterministic-cat",
              message: {
                role: "assistant" as const,
                content: "",
                tool_calls: [{
                  type: "function" as const,
                  function: {
                    name: "character.go_to_room",
                    arguments: { room_id: room },
                  },
                }],
              },
            };
          },
        },
        action_timeout_ms: 5_000,
        wait_timeout_ms: 7_000,
        reconciliation_timeout_ms: 5_000,
      });
      if (result.status !== "completed" || result.outcome.status !== "completed") {
        throw new Error(`action_${index}_not_completed`);
      }
      const timing = adapter.getAction(`hardware-action-${index}`)?.timing;
      if (
        timing?.accepted_latency_ms === null
        || timing?.accepted_latency_ms === undefined
        || timing.started_latency_ms === null
        || timing.terminal_latency_ms === null
      ) {
        throw new Error(`action_${index}_timing_missing`);
      }
      maxAcceptedLatencyMs = Math.max(maxAcceptedLatencyMs, timing.accepted_latency_ms);
      maxStartedLatencyMs = Math.max(maxStartedLatencyMs, timing.started_latency_ms);
      maxCompletedLatencyMs = Math.max(maxCompletedLatencyMs, timing.terminal_latency_ms);

      if (index + 1 === RECONNECT_AFTER_ACTIONS) {
        const beforeReconnectVersion = adapter.last_snapshot?.state_version ?? 0;
        if (!hub.server.disconnectDevice(deviceId)) {
          throw new Error("reconnect_disconnect_failed");
        }
        await waitUntil(() => !adapter.is_ready, 5_000, "device_disconnect_timeout");
        await waitUntil(() => adapter.is_ready, 30_000, "device_reconnect_timeout");
        reconnectSnapshotVersion = adapter.last_snapshot?.state_version ?? 0;
        if (
          reconnectSnapshotVersion < beforeReconnectVersion
          || adapter.last_snapshot?.character.room_id !== room
        ) {
          throw new Error("reconnect_snapshot_mismatch");
        }
      }
    }

    const result = {
      schema_version: 1,
      actions_completed: ACTION_COUNT,
      reconnect_after_actions: RECONNECT_AFTER_ACTIONS,
      reconnect_snapshot_version: reconnectSnapshotVersion,
      max_accepted_latency_ms: maxAcceptedLatencyMs,
      max_started_latency_ms: maxStartedLatencyMs,
      max_completed_latency_ms: maxCompletedLatencyMs,
    };
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `VERIFY:agent_transport:cat_action_chain:PASS actions=${ACTION_COUNT} `
      + `accepted_max_ms=${maxAcceptedLatencyMs} started_max_ms=${maxStartedLatencyMs} `
      + `completed_max_ms=${maxCompletedLatencyMs}\n`,
    );
    process.stdout.write(
      `VERIFY:agent_transport:reconnect_snapshot:PASS state_version=${reconnectSnapshotVersion}\n`,
    );
    await closeHub();
    process.stdout.write("HARNESS:agent_offline:STARTED\n");
  } finally {
    await closeHub();
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown_error";
  process.stdout.write(`VERIFY:agent_transport:hardware_harness:FAIL reason=${reason}\n`);
  process.exitCode = 1;
});
