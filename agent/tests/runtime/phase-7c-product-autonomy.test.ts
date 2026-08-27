import assert from "node:assert/strict";
import test from "node:test";

import type { OllamaChatRequest } from "@p4home/provider-ollama";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import {
  CatAutonomyControlServer,
  DeterministicFakeDevice,
  DeterministicFakeDeviceSocket,
  DeviceWebSocketActionAdapter,
  LowPriorityCatRunRegistry,
  parseProductCatAutonomyConfig,
  ProductCatAutonomyRuntime,
  RoleScheduler,
  type ProductCatAutonomyConfig,
} from "@p4home/runtime";

const NOW = 1_800_000_000_000;
const CONTROL_TOKEN = "phase-7-control-token-0123456789abcdef";

const haState = {
  alias: "study_light",
  domain: "light" as const,
  state: "off",
  available: true,
  attributes: {},
  updated_at_ms: NOW,
};

function rawConfig(): Record<string, unknown> {
  return {
    schema_version: 1,
    initial_mode: "enabled",
    timer: {
      schedule_id: "ambient_wander",
      interval_ms: 3_600_000,
      room_target: "living_room",
    },
    ha_room_targets: {
      study_light: { domain: "light", room_target: "study" },
    },
    task_room_targets: { human: "study", robot: "entry" },
    quiet_hours: null,
    daily_model_call_budget: 24,
    global_minimum_interval_ms: 0,
    source_minimum_interval_ms: {
      timer: 0,
      home_assistant: 0,
      p4_world: 0,
      runtime: 0,
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("Phase 7C product config is strict and cross-checks the real HA allowlist projection", () => {
  const parsed = parseProductCatAutonomyConfig(rawConfig(), [haState]);
  assert.equal(parsed.timer.room_target, "living_room");
  assert.deepEqual(parsed.ha_room_targets.study_light, {
    domain: "light",
    room_target: "study",
  });
  assert.throws(
    () => parseProductCatAutonomyConfig({ ...rawConfig(), extra: true }, [haState]),
    /unsupported field extra/,
  );
  assert.throws(
    () => parseProductCatAutonomyConfig({
      ...rawConfig(),
      ha_room_targets: { secret_sensor: { domain: "sensor", room_target: "study" } },
    }, [haState]),
    /not allowlisted/,
  );
  assert.throws(
    () => parseProductCatAutonomyConfig({
      ...rawConfig(),
      ha_room_targets: { study_light: { domain: "switch", room_target: "study" } },
    }, [haState]),
    /domain does not match/,
  );
  assert.throws(
    () => parseProductCatAutonomyConfig({
      ...rawConfig(),
      daily_model_call_budget: 0,
    }, [haState]),
    /between 1 and 1000/,
  );
  assert.throws(
    () => parseProductCatAutonomyConfig({
      ...rawConfig(),
      daily_model_call_budget: 1_001,
    }, [haState]),
    /between 1 and 1000/,
  );
});

class FakeDeviceHub {
  readonly #adapter: DeviceWebSocketActionAdapter;
  readonly #listeners = new Set<(deviceId: string, adapter: DeviceWebSocketActionAdapter) => void>();

  public constructor(adapter: DeviceWebSocketActionAdapter) {
    this.#adapter = adapter;
  }

  public getAdapter(deviceId: string): DeviceWebSocketActionAdapter | undefined {
    return deviceId === "p4-phase7-product" ? this.#adapter : undefined;
  }

  public onAdapterReady(
    listener: (deviceId: string, adapter: DeviceWebSocketActionAdapter) => void,
  ): () => void {
    this.#listeners.add(listener);
    if (this.#adapter.is_ready) listener("p4-phase7-product", this.#adapter);
    return () => this.#listeners.delete(listener);
  }

  public notifyReady(): void {
    for (const listener of this.#listeners) listener("p4-phase7-product", this.#adapter);
  }
}

test("Phase 7C product runtime waits for P4 readiness then mounts all bounded sources", async () => {
  const device = new DeterministicFakeDevice({
    device_id: "p4-phase7-product",
    protocol_version: 2,
    now: () => NOW,
  });
  const socket = new DeterministicFakeDeviceSocket(device);
  const adapter = new DeviceWebSocketActionAdapter(socket, {
    device_id: device.device_id,
    protocol_version: 2,
    now: () => NOW,
  });
  const hub = new FakeDeviceHub(adapter);
  let haListener: ((state: typeof haState) => void) | undefined;
  let haDetachCount = 0;
  const ha = {
    listStates: () => [haState],
    onState(listener: (state: typeof haState) => void) {
      haListener = listener;
      return () => {
        haListener = undefined;
        haDetachCount += 1;
      };
    },
  };
  const requests: OllamaChatRequest[] = [];
  const provider = {
    async chat(request: OllamaChatRequest) {
      requests.push(request);
      return {
        model: "fake-cat-model",
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [{
            type: "function" as const,
            function: {
              name: "character.go_to_room",
              arguments: { room_id: "study" },
            },
          }],
        },
      };
    },
  };
  using store = new SqliteAuditStore(":memory:");
  const scheduler = new RoleScheduler();
  const registry = new LowPriorityCatRunRegistry();
  const logs: string[] = [];
  const runtime = new ProductCatAutonomyRuntime({
    device_id: device.device_id,
    device_hub: hub,
    ha_client: ha,
    config: parseProductCatAutonomyConfig(rawConfig(), [haState]),
    provider,
    scheduler,
    audit_store: store,
    cat_run_registry: registry,
    clock: () => NOW,
    on_log: (record) => logs.push(record.event),
    execution_audit_capacity: 2,
  });

  runtime.start();
  assert.equal(runtime.getStatus().product_ready, false);
  runtime.taskCompletionSink()({
    run_id: "before-p4-ready",
    role_id: "human",
    outcome: "completed",
    occurred_at_ms: NOW,
  });
  assert.equal(requests.length, 0);

  socket.connect("test");
  assert.equal(adapter.is_ready, true);
  hub.notifyReady();
  assert.equal(runtime.getStatus().product_ready, true);
  assert.equal(logs.includes("cat_autonomy_ready"), true);

  runtime.taskCompletionSink()({
    run_id: "human-product-run",
    role_id: "human",
    outcome: "completed",
    occurred_at_ms: NOW,
  });
  while (device.received_action_requests === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.think, false);
  assert.equal(device.getState().room_id, "study");
  assert.equal(runtime.getStatus().admitted_model_calls_today, 1);

  socket.disconnect();
  assert.equal(runtime.getStatus().product_ready, false);
  const budgetBeforeOfflineEvent = runtime.getStatus().admitted_model_calls_today;
  haListener?.({ ...haState, state: "on", updated_at_ms: NOW + 1 });
  await waitUntil(() => runtime.listExecutionAudit(10).some(
    (record) => record.reason === "DEVICE_NOT_READY",
  ));
  assert.equal(requests.length, 1);
  assert.equal(runtime.getStatus().admitted_model_calls_today, budgetBeforeOfflineEvent);
  assert.equal(runtime.listExecutionAudit(10).some(
    (record) => record.reason === "DEVICE_NOT_READY",
  ), true);
  assert.equal(runtime.listExecutionAudit(50).length <= 2, true);

  socket.connect("reconnect");
  assert.equal(adapter.is_ready, true);
  assert.equal(runtime.getStatus().product_ready, true);
  haListener?.({ ...haState, state: "off", updated_at_ms: NOW + 2 });
  while (requests.length < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await waitUntil(() => runtime.listExecutionAudit(10).some(
    (record) => record.source === "home_assistant" && record.run_status === "completed",
  ));
  assert.equal(runtime.listExecutionAudit(10).some(
    (record) => record.source === "home_assistant" && record.run_status === "completed",
  ), true);

  const active = registry.begin("phase7-product-pause");
  runtime.setMode("paused");
  assert.equal(active.signal.aborted, true);
  active.release();
  assert.equal(runtime.listAudit(1)[0]?.reason, "MODE_CHANGED");
  assert.equal(runtime.listAudit(1)[0]?.mode, "paused");

  await runtime.close();
  assert.equal(runtime.getStatus().product_ready, false);
  const requestsAtClose = requests.length;
  runtime.taskCompletionSink()({
    run_id: "after-product-close",
    role_id: "human",
    outcome: "completed",
    occurred_at_ms: NOW + 3,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, requestsAtClose);
  assert.equal(haDetachCount, 1);
  assert.equal(haListener, undefined);
  scheduler.close();
  registry.close();
});

test("Phase 7C loopback control endpoint requires bearer auth and controls bounded audit", async (t) => {
  let mode: "enabled" | "paused" | "disabled" = "enabled";
  const config = parseProductCatAutonomyConfig(rawConfig(), [haState]);
  const target = {
    getStatus: () => ({
      mode,
      role_profile_revision: "role-profile/v6" as const,
      runtime_started_at_ms: NOW,
      quiet_hours: config.quiet_hours,
      daily_model_call_budget: 24,
      budget_day: "2027-01-15",
      admitted_model_calls_today: 0,
      remaining_model_calls_today: 24,
      accepted_triggers: 0,
      rejected_triggers: 0,
      product_ready: true,
      device_id: "p4-phase7-product",
      timer_schedule_id: "ambient_wander",
      timer_interval_ms: 3_600_000,
      ingress_inflight: 0,
    }),
    listAudit: (limit = 50) => [{
      sequence: 1,
      event_id: null,
      event_type: "control.mode_changed" as const,
      source: "user_control" as const,
      occurred_at_ms: NOW,
      decision: "control" as const,
      reason: `mode:${mode}`,
      room_target: null,
      mode,
    }].slice(0, limit),
    listExecutionAudit: () => [],
    setMode: (next: typeof mode) => { mode = next; },
  };
  const server = new CatAutonomyControlServer({
    host: "127.0.0.1",
    port: 0,
    token: Buffer.from(CONTROL_TOKEN),
    target,
  });
  const address = await server.start();
  t.after(async () => server.close());
  const base = `http://${address.host}:${address.port}`;

  const unauthorized = await fetch(`${base}/v1/autonomy/status`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");

  const headers = { authorization: `Bearer ${CONTROL_TOKEN}` };
  const status = await fetch(`${base}/v1/autonomy/status`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { product_ready: boolean }).product_ready, true);

  const changed = await fetch(`${base}/v1/autonomy/mode`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mode: "disabled" }),
  });
  assert.equal(changed.status, 200);
  assert.equal(mode, "disabled");

  const audit = await fetch(`${base}/v1/autonomy/audit?limit=1`, { headers });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json() as { decisions: unknown[]; executions: unknown[] };
  assert.equal(auditBody.decisions.length, 1);
  assert.equal(auditBody.executions.length, 0);
  const invalidLimit = await fetch(`${base}/v1/autonomy/audit?limit=1001`, { headers });
  assert.equal(invalidLimit.status, 400);
});
