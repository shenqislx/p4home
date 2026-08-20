import assert from "node:assert/strict";
import test from "node:test";

import type { OllamaChatRequest } from "@p4home/provider-ollama";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import {
  assertRoleToolAuthorization,
  buildRoleContext,
  CatObjectEventPolicy,
  CatObjectEventPolicyError,
  DeterministicFakeDevice,
  DeterministicFakeDeviceSocket,
  DeviceWebSocketActionAdapter,
  getRoleProfile,
  RoleScheduler,
  runCatObjectSitEvent,
} from "@p4home/runtime";

const TARGET_ID = "living_room.sofa" as const;

function objectSitEvent(id: string, occurredAtMs: number, targetId: string = TARGET_ID) {
  return {
    event_id: id,
    event_type: "test.object_sit_target",
    source: "test_harness",
    occurred_at_ms: occurredAtMs,
    payload: { target_id: targetId },
  };
}

function objectSequenceProvider(
  targetId: string = TARGET_ID,
  onChat?: () => void,
) {
  const requests: OllamaChatRequest[] = [];
  return {
    requests,
    provider: {
      async chat(request: OllamaChatRequest) {
        requests.push(request);
        onChat?.();
        return {
          model: "fake-cat-object-model",
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              {
                type: "function" as const,
                function: {
                  name: "character.go_to",
                  arguments: { target_id: targetId },
                },
              },
              {
                type: "function" as const,
                function: {
                  name: "character.sit",
                  arguments: { target_id: targetId },
                },
              },
            ],
          },
        };
      },
    },
  };
}

function connectedV2(options: {
  readonly now?: () => number;
  readonly auto_execute?: boolean;
} = {}) {
  const device = new DeterministicFakeDevice({
    protocol_version: 2,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.auto_execute === undefined ? {} : { auto_execute: options.auto_execute }),
  });
  const socket = new DeterministicFakeDeviceSocket(device);
  const adapter = new DeviceWebSocketActionAdapter(socket, {
    device_id: device.device_id,
    protocol_version: 2,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  socket.connect("test");
  assert.equal(adapter.is_ready, true);
  assert.equal(adapter.protocol_version, 2);
  assert.equal(adapter.object_capabilities.length, 3);
  return { device, socket, adapter };
}

function runOptions(
  suffix: string,
  now: number,
  harness: ReturnType<typeof connectedV2>,
  provider: ReturnType<typeof objectSequenceProvider>["provider"],
  store: SqliteAuditStore,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    event: objectSitEvent(`object-event-${suffix}`, now),
    run_id: `object-run-${suffix}`,
    session_id: `object-session-${suffix}`,
    session_created_at_ms: now - 1,
    tool_call_ids: [`object-tool-${suffix}-1`, `object-tool-${suffix}-2`] as const,
    action_ids: [`object-action-${suffix}-1`, `object-action-${suffix}-2`] as const,
    policy: new CatObjectEventPolicy({ now: () => now, minimum_interval_ms: 0 }),
    scheduler: new RoleScheduler(),
    adapter: harness.adapter,
    provider,
    clock: () => now,
    audit_store: store,
    ...overrides,
  };
}

async function waitForRequests(device: DeterministicFakeDevice, count: number): Promise<void> {
  while (device.received_action_requests < count) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("Cat object policy derives a fixed sit sequence and rejects arbitrary input before model or device", async () => {
  const now = 100_000;
  const policy = new CatObjectEventPolicy({ now: () => now, minimum_interval_ms: 0 });
  const approved = policy.approve(objectSitEvent("approved-object-event", now));
  assert.deepEqual(approved.steps, [
    { tool: "character.go_to", arguments: { target_id: TARGET_ID } },
    { tool: "character.sit", arguments: { target_id: TARGET_ID } },
  ]);
  assert.throws(
    () => policy.approve({ ...objectSitEvent("object-user-text", now), text: "去桌子上坐" }),
    (error) => error instanceof CatObjectEventPolicyError && error.code === "INVALID_EVENT",
  );
  assert.throws(
    () => policy.approve({
      ...objectSitEvent("object-action-field", now),
      payload: { target_id: TARGET_ID, action: "interact" },
    }),
    (error) => error instanceof CatObjectEventPolicyError && error.code === "INVALID_EVENT",
  );
  assert.throws(
    () => policy.approve(objectSitEvent("object-desk-target", now, "study.desk")),
    (error) => error instanceof CatObjectEventPolicyError && error.code === "TARGET_NOT_ALLOWED",
  );
  assert.throws(
    () => new CatObjectEventPolicy({ allowed_targets: ["study.desk"] }),
    /cannot widen/,
  );

  const harness = connectedV2({ now: () => now });
  const model = objectSequenceProvider();
  using store = new SqliteAuditStore(":memory:");
  await assert.rejects(
    runCatObjectSitEvent({
      ...runOptions("rejected", now, harness, model.provider, store),
      event: { ...objectSitEvent("object-rejected-run", now), text: "用户原文" },
    }),
    (error) => error instanceof CatObjectEventPolicyError && error.code === "INVALID_EVENT",
  );
  assert.equal(model.requests.length, 0);
  assert.equal(harness.device.received_action_requests, 0);
  assert.equal(await store.getRunTrace("object-run-rejected"), null);
});

test("only Cat owns object tools and Cat still rejects original user text", () => {
  const cat = getRoleProfile("cat");
  const human = getRoleProfile("human");
  const robot = getRoleProfile("robot");
  assert.doesNotThrow(() => assertRoleToolAuthorization(cat, [
    "character.go_to",
    "character.sit",
    "character.look_at",
    "character.interact",
  ]));
  for (const profile of [human, robot]) {
    assert.throws(() => assertRoleToolAuthorization(profile, ["character.go_to"]));
    assert.equal(profile.allowed_tools.some((tool) => tool.startsWith("character.go_to")), false);
  }
  assert.throws(() => buildRoleContext(cat, {
    kind: "user_text",
    text: "去沙发坐下",
    source_span: { start: 0, end: 5 },
    mode: "respond",
  }));
});

test("Cat executes go_to then sit and audits the coordinate-free capability observation", async () => {
  const now = 110_000;
  const harness = connectedV2({ now: () => now });
  const model = objectSequenceProvider();
  using store = new SqliteAuditStore(":memory:");
  const result = await runCatObjectSitEvent(
    runOptions("success", now, harness, model.provider, store),
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.steps.map((step) => [step.tool, step.executed, step.outcome.status]), [
    ["character.go_to", true, "completed"],
    ["character.sit", true, "completed"],
  ]);
  assert.equal(harness.device.received_action_requests, 2);
  const state = harness.device.getState() as { target_object_id?: string; pose?: string };
  assert.equal(state.target_object_id, TARGET_ID);
  assert.equal(state.pose, "sitting");

  assert.equal(model.requests.length, 1);
  assert.deepEqual(model.requests[0]?.tools?.map((tool) => tool.function.name), [
    "character.go_to",
    "character.sit",
  ]);
  const modelBoundary = JSON.stringify(model.requests[0]);
  for (const forbidden of ["anchor", "art_x", "floor_y", "facing", "animation_bindings"]) {
    assert.equal(modelBoundary.includes(`\"${forbidden}\"`), false);
  }

  const trace = await store.getRunTrace("object-run-success");
  assert.equal(trace?.run.status, "completed");
  assert.deepEqual(trace?.tool_calls.map((call) => [call.name, call.status]), [
    ["character.go_to", "success"],
    ["character.sit", "success"],
  ]);
  assert.deepEqual(trace?.actions.map((action) => action.status), ["completed", "completed"]);
  const capabilityProjection = trace?.events[0]?.payload.capability_projection;
  assert.ok(Array.isArray(capabilityProjection));
  assert.equal(JSON.stringify(capabilityProjection).includes("art_x"), false);
});

test("live object availability is projected from snapshots and blocks work before the model", async () => {
  const now = 115_000;
  const harness = connectedV2({ now: () => now });
  harness.device.setObjectAvailable(TARGET_ID, false);
  assert.equal(
    harness.adapter.object_capabilities.find((object) => object.object_id === TARGET_ID)?.available,
    false,
  );
  const model = objectSequenceProvider();
  using store = new SqliteAuditStore(":memory:");
  const result = await runCatObjectSitEvent(
    runOptions("unavailable-capability", now, harness, model.provider, store),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.steps.length, 0);
  assert.equal(model.requests.length, 0);
  assert.equal(harness.device.received_action_requests, 0);
  assert.equal((await store.getRunTrace("object-run-unavailable-capability"))?.run.status, "failed");
});

test("a model cannot rewrite the policy target or leave unaudited pending calls", async () => {
  const now = 117_000;
  const harness = connectedV2({ now: () => now });
  const model = objectSequenceProvider("study.desk");
  using store = new SqliteAuditStore(":memory:");
  const result = await runCatObjectSitEvent(
    runOptions("model-rewrite", now, harness, model.provider, store),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.steps.length, 0);
  assert.equal(model.requests.length, 1);
  assert.equal(harness.device.received_action_requests, 0);
  const trace = await store.getRunTrace("object-run-model-rewrite");
  assert.equal(trace?.run.status, "failed");
  assert.equal(trace?.tool_calls.length, 0);
  assert.equal(trace?.actions.length, 0);
});

test("first-step object failures stop dispatch and terminalize the skipped ToolCall", async (t) => {
  for (const [suffix, code] of [
    ["unknown", "UNKNOWN_OBJECT"],
    ["occupied", "OBJECT_OCCUPIED"],
  ] as const) {
    await t.test(code, async () => {
      const now = 120_000;
      const harness = connectedV2({ now: () => now });
      if (code === "OBJECT_OCCUPIED") {
        harness.device.setObjectOccupied(TARGET_ID, true);
      } else {
        harness.device.forceObjectError("character.go_to", TARGET_ID, code);
      }
      const model = objectSequenceProvider();
      using store = new SqliteAuditStore(":memory:");
      const result = await runCatObjectSitEvent(
        runOptions(suffix, now, harness, model.provider, store),
      );

      assert.equal(result.status, "failed");
      assert.equal(result.steps[0]?.outcome.status, "failed");
      assert.equal(
        result.steps[0]?.outcome.status === "failed" ? result.steps[0].outcome.error.code : null,
        code,
      );
      assert.equal(result.steps[1]?.executed, false);
      assert.equal(harness.device.received_action_requests, 1);
      const trace = await store.getRunTrace(`object-run-${suffix}`);
      assert.deepEqual(trace?.tool_calls.map((call) => call.status), ["error", "error"]);
      assert.equal(trace?.tool_calls[0]?.error?.code, code);
      assert.equal(trace?.tool_calls[1]?.error?.code, "CANCELLED");
      assert.equal(trace?.tool_calls[1]?.error?.details?.skipped, true);
      assert.equal(trace?.actions.length, 1);
    });
  }
});

test("unsupported sit is audited after successful go_to and stops at the failing step", async () => {
  const now = 130_000;
  const harness = connectedV2({ now: () => now });
  harness.device.forceObjectError("character.sit", TARGET_ID, "UNSUPPORTED_OBJECT_ACTION");
  const model = objectSequenceProvider();
  using store = new SqliteAuditStore(":memory:");
  const result = await runCatObjectSitEvent(
    runOptions("unsupported", now, harness, model.provider, store),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.outcome.status, "completed");
  assert.equal(result.steps[1]?.outcome.status, "failed");
  assert.equal(
    result.steps[1]?.outcome.status === "failed" ? result.steps[1].outcome.error.code : null,
    "UNSUPPORTED_OBJECT_ACTION",
  );
  assert.equal(harness.device.received_action_requests, 2);
  const trace = await store.getRunTrace("object-run-unsupported");
  assert.deepEqual(trace?.tool_calls.map((call) => call.status), ["success", "error"]);
  assert.equal(trace?.tool_calls[1]?.error?.code, "UNSUPPORTED_OBJECT_ACTION");
});

test("cancellation during go_to is audited and never dispatches sit", async () => {
  const now = 140_000;
  const harness = connectedV2({ now: () => now, auto_execute: false });
  const model = objectSequenceProvider();
  const controller = new AbortController();
  using store = new SqliteAuditStore(":memory:");
  const runPromise = runCatObjectSitEvent(runOptions(
    "cancelled",
    now,
    harness,
    model.provider,
    store,
    { signal: controller.signal, wait_timeout_ms: 1_000, reconciliation_timeout_ms: 100 },
  ));
  await waitForRequests(harness.device, 1);
  assert.equal(harness.device.startNext(), true);
  controller.abort();
  const result = await runPromise;

  assert.equal(result.status, "cancelled");
  assert.equal(result.steps[0]?.outcome.status, "failed");
  assert.equal(
    result.steps[0]?.outcome.status === "failed" ? result.steps[0].outcome.error.code : null,
    "CANCELLED",
  );
  assert.equal(result.steps[1]?.executed, false);
  assert.equal(harness.device.received_action_requests, 1);
  const trace = await store.getRunTrace("object-run-cancelled");
  assert.equal(trace?.run.status, "cancelled");
  assert.deepEqual(trace?.tool_calls.map((call) => call.status), ["error", "error"]);
});

test("disconnect remains audited unknown after snapshot reconciliation and is never replayed", async () => {
  const now = 150_000;
  const harness = connectedV2({ now: () => now, auto_execute: false });
  const model = objectSequenceProvider();
  using store = new SqliteAuditStore(":memory:");
  const runPromise = runCatObjectSitEvent(runOptions(
    "disconnect",
    now,
    harness,
    model.provider,
    store,
    { wait_timeout_ms: 1_000, reconciliation_timeout_ms: 100 },
  ));
  await waitForRequests(harness.device, 1);
  assert.equal(harness.device.startNext(), true);
  harness.socket.disconnect();
  harness.socket.connect("reconnect");
  const result = await runPromise;

  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.outcome.status, "unknown");
  assert.equal(
    result.steps[0]?.outcome.status === "unknown"
      ? result.steps[0].outcome.reconciliation?.status
      : null,
    "state_not_satisfied",
  );
  assert.equal(result.steps[1]?.executed, false);
  assert.equal(harness.device.received_action_requests, 1);
  assert.equal(harness.device.executionCount("object-action-disconnect-1"), 0);
  const trace = await store.getRunTrace("object-run-disconnect");
  assert.equal(trace?.run.status, "failed");
  assert.equal(trace?.tool_calls[0]?.error?.code, "DEVICE_OFFLINE");
  assert.equal(trace?.tool_calls[0]?.error?.details?.replay_allowed, false);
  assert.equal(
    (trace?.tool_calls[0]?.error?.details?.reconciliation as { status?: string } | undefined)?.status,
    "state_not_satisfied",
  );
});
