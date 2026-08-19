import assert from "node:assert/strict";
import test from "node:test";

import type { OllamaChatRequest } from "@p4home/provider-ollama";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import {
  CatEventPolicy,
  CatEventPolicyError,
  DeterministicFakeDevice,
  DeterministicFakeDeviceSocket,
  DeviceActionAdapterError,
  DeviceProtocolBoundaryError,
  DeviceWebSocketActionAdapter,
  RoleScheduler,
  runCatRoomTargetEvent,
} from "@p4home/runtime";

function roomEvent(id: string, occurredAtMs: number, roomTarget = "study") {
  return {
    event_id: id,
    event_type: "test.room_target",
    source: "test_harness",
    occurred_at_ms: occurredAtMs,
    payload: { room_target: roomTarget },
  };
}

function catToolProvider(roomId: string) {
  const requests: OllamaChatRequest[] = [];
  return {
    requests,
    provider: {
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
                arguments: { room_id: roomId },
              },
            }],
          },
        };
      },
    },
  };
}

function connectedHarness(options: {
  readonly now?: () => number;
  readonly auto_execute?: boolean;
  readonly auto_resync?: boolean;
  readonly waiter_capacity?: number;
  readonly action_record_capacity?: number;
  readonly idempotency_capacity?: number;
} = {}) {
  const device = new DeterministicFakeDevice({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.auto_execute === undefined ? {} : { auto_execute: options.auto_execute }),
    ...(options.auto_resync === undefined ? {} : { auto_resync: options.auto_resync }),
    ...(options.idempotency_capacity === undefined
      ? {}
      : { idempotency_capacity: options.idempotency_capacity }),
  });
  const socket = new DeterministicFakeDeviceSocket(device);
  const adapter = new DeviceWebSocketActionAdapter(socket, {
    device_id: device.device_id,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.waiter_capacity === undefined ? {} : { waiter_capacity: options.waiter_capacity }),
    ...(options.action_record_capacity === undefined
      ? {}
      : { action_record_capacity: options.action_record_capacity }),
  });
  socket.connect("test");
  assert.equal(adapter.is_ready, true);
  return { device, socket, adapter };
}

test("Cat Event Policy rejects unauthorized, stale, duplicate, and rate-limited events", () => {
  let now = 10_000;
  const policy = new CatEventPolicy({ now: () => now, minimum_interval_ms: 100 });
  const approved = policy.approve(roomEvent("event-1", now));
  assert.equal(approved.tool, "character.go_to_room");
  assert.deepEqual(approved.arguments, { room_id: "study" });

  assert.throws(
    () => policy.approve(roomEvent("event-1", now)),
    (error) => error instanceof CatEventPolicyError && error.code === "DUPLICATE_EVENT",
  );
  assert.throws(
    () => policy.approve(roomEvent("event-2", now)),
    (error) => error instanceof CatEventPolicyError && error.code === "RATE_LIMITED",
  );
  now += 100;
  assert.throws(
    () => policy.approve({ ...roomEvent("event-3", now), source: "user" }),
    (error) => error instanceof CatEventPolicyError && error.code === "SOURCE_NOT_ALLOWED",
  );
  assert.throws(
    () => policy.approve({ ...roomEvent("event-4", now), text: "把猫送到书房" }),
    (error) => error instanceof CatEventPolicyError && error.code === "INVALID_EVENT",
  );
  assert.throws(
    () => policy.approve(roomEvent("event-5", now - 5_001)),
    (error) => error instanceof CatEventPolicyError && error.code === "STALE_EVENT",
  );
  assert.throws(
    () => new CatEventPolicy({ now: () => now, allowed_tools: [] }).approve(roomEvent("event-6", now)),
    (error) => error instanceof CatEventPolicyError && error.code === "TOOL_NOT_ALLOWED",
  );
});

test("Cat Event Policy dedupe cache is bounded and expires old event ids", () => {
  let wallNow = 11_000;
  let monotonicNow = 0;
  const policy = new CatEventPolicy({
    now: () => wallNow,
    monotonic_now: () => monotonicNow,
    minimum_interval_ms: 0,
    dedupe_capacity: 2,
    dedupe_retention_ms: 100,
  });
  policy.approve(roomEvent("bounded-event-1", wallNow));
  monotonicNow += 1;
  policy.approve(roomEvent("bounded-event-2", wallNow));
  monotonicNow += 1;
  assert.throws(
    () => policy.approve(roomEvent("bounded-event-3", wallNow)),
    (error) => error instanceof CatEventPolicyError
      && error.code === "DEDUPE_CAPACITY_EXCEEDED",
  );

  monotonicNow += 101;
  wallNow += 1;
  assert.doesNotThrow(() => policy.approve(roomEvent("bounded-event-3", wallNow)));
});

test("deterministic fake device completes 100 actions without silent loss", async () => {
  let now = 20_000;
  const { adapter, device } = connectedHarness({ now: () => now });
  const rooms = [
    "primary_bedroom",
    "study",
    "guest_room",
    "entry",
    "living_room",
    "kitchen",
  ] as const;

  for (let index = 0; index < 100; index += 1) {
    now += 1;
    const outcome = await adapter.executeAction({
      action_id: `stress-action-${index}`,
      tool: "character.go_to_room",
      arguments: { room_id: rooms[index % rooms.length] },
      timeout_ms: 1_000,
      origin: "test",
    });
    assert.equal(outcome.status, "completed");
    assert.equal(device.executionCount(`stress-action-${index}`), 1);
  }

  device.heartbeat();
  assert.equal(device.received_action_requests, 100);
  assert.equal(device.state_version, 101);
  assert.equal(adapter.last_snapshot?.state_version, 101);
  assert.equal(adapter.last_protocol_error, null);
});

test("same action_id redelivery returns terminal state without a second side effect", async () => {
  const { adapter, device } = connectedHarness();
  const first = await adapter.executeAction({
    action_id: "idempotent-action",
    tool: "character.go_to_room",
    arguments: { room_id: "kitchen" },
    timeout_ms: 1_000,
    origin: "test",
  });
  assert.equal(first.status, "completed");

  await adapter.redeliverAction("idempotent-action");
  const cached = await adapter.executeAction({
    action_id: "idempotent-action",
    tool: "character.go_to_room",
    arguments: { room_id: "kitchen" },
    timeout_ms: 1_000,
    origin: "test",
  });
  assert.equal(cached.status, "completed");
  assert.equal(device.received_action_requests, 2);
  assert.equal(device.executionCount("idempotent-action"), 1);

  await assert.rejects(
    adapter.executeAction({
      action_id: "idempotent-action",
      tool: "character.go_to_room",
      arguments: { room_id: "study" },
      timeout_ms: 1_000,
      origin: "test",
    }),
    (error) => error instanceof DeviceActionAdapterError && error.code === "ACTION_ID_CONFLICT",
  );
});

test("a locally invalid frame does not create an action, consume seq, or poison its id", async () => {
  const { adapter, device } = connectedHarness();
  await assert.rejects(
    adapter.executeAction({
      action_id: "invalid-timeout",
      tool: "character.go_to_room",
      arguments: { room_id: "study" },
      timeout_ms: 1,
      wait_timeout_ms: 100,
    }),
    (error) => error instanceof DeviceProtocolBoundaryError
      && error.code === "INVALID_MESSAGE",
  );
  assert.equal(adapter.getAction("invalid-timeout"), undefined);
  assert.equal(adapter.is_ready, true);

  const valid = await adapter.executeAction({
    action_id: "invalid-timeout",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
  });
  assert.equal(valid.status, "completed");
  assert.equal(device.received_action_requests, 1);
  assert.equal(device.executionCount("invalid-timeout"), 1);
});

test("an invalid local wait timeout does not retain or poison an action id", async () => {
  const { adapter, device } = connectedHarness();
  await assert.rejects(
    adapter.executeAction({
      action_id: "invalid-wait-timeout",
      tool: "character.go_to_room",
      arguments: { room_id: "study" },
      timeout_ms: 1_000,
      wait_timeout_ms: 0,
    }),
    /wait_timeout_ms must be a positive integer/,
  );
  assert.equal(adapter.getAction("invalid-wait-timeout"), undefined);

  const outcome = await adapter.executeAction({
    action_id: "invalid-wait-timeout",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
  });
  assert.equal(outcome.status, "completed");
  assert.equal(device.executionCount("invalid-wait-timeout"), 1);
});

test("a pre-aborted action never reaches the device", async () => {
  const { adapter, device } = connectedHarness();
  const controller = new AbortController();
  controller.abort();
  const outcome = await adapter.executeAction({
    action_id: "pre-aborted-action",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
    signal: controller.signal,
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.status === "failed" ? outcome.error.code : null, "CANCELLED");
  assert.equal(device.received_action_requests, 0);
  assert.equal(device.executionCount("pre-aborted-action"), 0);
});

test("device.hello cannot reset sequence and session on a live transport", () => {
  const { adapter, device } = connectedHarness();
  device.emitInBandHelloForTest();
  assert.equal(adapter.is_ready, false);
  assert.match(adapter.last_protocol_error?.message ?? "", /cannot reset.*in-band/);
});

test("a completed result that contradicts its request fails protocol validation", async () => {
  const { adapter, device, socket } = connectedHarness({ auto_execute: false });
  const pending = adapter.executeAction({
    action_id: "contradictory-completion",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
    wait_timeout_ms: 10_000,
  });
  device.emitContradictoryCompletionForTest("contradictory-completion");
  assert.equal(adapter.is_ready, false);
  assert.match(adapter.last_protocol_error?.message ?? "", /contradicts its request/);
  assert.equal(device.executionCount("contradictory-completion"), 0);
  socket.disconnect();
  assert.equal((await pending).status, "unknown");
});

test("completed adapter records are evicted when the configured capacity is reached", async () => {
  const { adapter } = connectedHarness({ action_record_capacity: 1 });
  await adapter.executeAction({
    action_id: "bounded-action-1",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
  });
  await adapter.executeAction({
    action_id: "bounded-action-2",
    tool: "character.go_to_room",
    arguments: { room_id: "kitchen" },
    timeout_ms: 1_000,
  });
  assert.equal(adapter.getAction("bounded-action-1"), undefined);
  assert.equal(adapter.getAction("bounded-action-2")?.status, "completed");
});

test("fake device fails closed when retained idempotency records reach capacity", async () => {
  const { adapter, device, socket } = connectedHarness({ idempotency_capacity: 1 });
  const first = await adapter.executeAction({
    action_id: "fake-cache-action-1",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
  });
  assert.equal(first.status, "completed");

  const overflow = await adapter.executeAction({
    action_id: "fake-cache-action-2",
    tool: "character.go_to_room",
    arguments: { room_id: "kitchen" },
    timeout_ms: 1_000,
  });
  assert.equal(overflow.status, "unknown");
  assert.equal(overflow.status === "unknown" ? overflow.reason : null, "send_failed");
  assert.equal(adapter.is_ready, false);
  assert.equal(socket.is_open, false, "ambiguous send failure must force a new handshake");
  assert.equal(device.executionCount("fake-cache-action-2"), 0);
});

test("manual fake device enforces waiter capacity, queue full, cancellation, and deadline", async () => {
  let now = 30_000;
  {
    const { adapter } = connectedHarness({
      now: () => now,
      auto_execute: false,
      waiter_capacity: 1,
    });
    void adapter.executeAction({
      action_id: "waiter-1",
      tool: "character.go_to_room",
      arguments: { room_id: "study" },
      timeout_ms: 1_000,
    });
    await assert.rejects(
      adapter.executeAction({
        action_id: "waiter-2",
        tool: "character.go_to_room",
        arguments: { room_id: "kitchen" },
        timeout_ms: 1_000,
      }),
      (error) => error instanceof DeviceActionAdapterError
        && error.code === "WAITER_CAPACITY_EXCEEDED",
    );
  }

  const { adapter, device } = connectedHarness({
    now: () => now,
    auto_execute: false,
    waiter_capacity: 16,
  });
  const pending = Array.from({ length: 9 }, (_, index) => adapter.executeAction({
    action_id: `queued-action-${index}`,
    tool: "character.go_to_room",
    arguments: { room_id: index % 2 === 0 ? "study" : "kitchen" },
    timeout_ms: 100,
    wait_timeout_ms: 10_000,
    origin: "test",
  }));

  const queueFull = await pending[8]!;
  assert.equal(queueFull.status, "failed");
  assert.equal(queueFull.status === "failed" ? queueFull.error.code : null, "QUEUE_FULL");
  await adapter.cancelAction("queued-action-0", "test cancellation");
  const cancelled = await pending[0]!;
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.status === "failed" ? cancelled.error.code : null, "CANCELLED");

  now += 100;
  device.drain();
  const expired = await Promise.all(pending.slice(1, 8));
  assert.ok(expired.every((outcome) => outcome.status === "failed"
    && outcome.error.code === "DEADLINE_EXCEEDED"));
  assert.equal(device.queue_length, 0);
  assert.equal(
    Array.from({ length: 9 }, (_, index) => device.executionCount(`queued-action-${index}`))
      .reduce((sum, count) => sum + count, 0),
    0,
  );
});

test("disconnect produces unknown outcome and reconnect snapshot reconciles without replay", async () => {
  let now = 40_000;
  const { adapter, device, socket } = connectedHarness({
    now: () => now,
    auto_execute: false,
  });
  const pending = adapter.executeAction({
    action_id: "reconcile-action",
    tool: "character.go_to_room",
    arguments: { room_id: "guest_room" },
    timeout_ms: 1_000,
    wait_timeout_ms: 10_000,
    origin: "test",
  });
  assert.equal(device.startNext(), true);
  socket.disconnect();
  const disconnected = await pending;
  assert.deepEqual(disconnected, {
    status: "unknown",
    action_id: "reconcile-action",
    reason: "disconnected",
    replay_allowed: false,
    reconciliation: null,
  });

  now += 1;
  assert.equal(device.completeActive(), true);
  assert.equal(device.executionCount("reconcile-action"), 1);
  assert.equal(device.received_action_requests, 1);
  socket.connect("reconnect");

  const reconciled = adapter.getAction("reconcile-action")?.outcome;
  assert.equal(reconciled?.status, "unknown");
  assert.equal(
    reconciled?.status === "unknown" ? reconciled.reconciliation?.status : null,
    "state_satisfied",
  );
  assert.equal(device.received_action_requests, 1);
  assert.equal(adapter.last_snapshot?.character.room_id, "guest_room");
});

test("snapshot records state evidence but never completes an unexecuted queued action", async () => {
  const { adapter, device, socket } = connectedHarness({ auto_execute: false });
  const first = adapter.executeAction({
    action_id: "actual-action",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
    wait_timeout_ms: 10_000,
  });
  const queued = adapter.executeAction({
    action_id: "unexecuted-action",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
    wait_timeout_ms: 10_000,
  });
  assert.equal(device.startNext(), true);
  socket.disconnect();
  await Promise.all([first, queued]);
  assert.equal(device.completeActive(), true);
  socket.connect("reconnect");

  const record = adapter.getAction("unexecuted-action");
  assert.equal(record?.status, "unknown");
  assert.equal(record?.outcome?.status, "unknown");
  assert.equal(
    record?.outcome?.status === "unknown" ? record.outcome.reconciliation?.status : null,
    "state_satisfied",
  );
  assert.equal(device.executionCount("unexecuted-action"), 0);
  assert.equal(device.queue_length, 1);
});

test("resync ignores uncorrelated snapshots until the matching response arrives", () => {
  const { adapter, device } = connectedHarness({ auto_resync: false });
  const initialSnapshotId = adapter.last_snapshot?.snapshot_id;
  device.injectStateVersionGapForTest();
  assert.equal(adapter.is_ready, false);

  device.emitUncorrelatedSnapshotForTest();
  assert.equal(adapter.is_ready, false);
  assert.equal(adapter.last_snapshot?.snapshot_id, initialSnapshotId);

  device.respondToPendingResyncForTest();
  assert.equal(adapter.is_ready, true);
  assert.equal(adapter.last_snapshot?.reason, "resync");
  assert.notEqual(adapter.last_snapshot?.snapshot_id, initialSnapshotId);
});

test("approved Cat event creates an audited Cat Run; rejected event sends no action", async () => {
  let now = 50_000;
  const { adapter, device } = connectedHarness({ now: () => now });
  const policy = new CatEventPolicy({ now: () => now, minimum_interval_ms: 0 });
  const scheduler = new RoleScheduler();
  const catModel = catToolProvider("primary_bedroom");
  using store = new SqliteAuditStore(":memory:");

  const result = await runCatRoomTargetEvent({
    event: roomEvent("cat-source-event-1", now, "primary_bedroom"),
    run_id: "cat-run-1",
    session_id: "cat-session-1",
    session_created_at_ms: now - 1,
    tool_call_id: "cat-tool-call-1",
    action_id: "cat-action-1",
    policy,
    scheduler,
    adapter,
    provider: catModel.provider,
    clock: () => now,
    audit_store: store,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.model_turns, 1);
  assert.equal(catModel.requests.length, 1);
  assert.equal(catModel.requests[0]?.think, false);
  assert.deepEqual(catModel.requests[0]?.tools?.map((tool) => tool.function.name), [
    "character.go_to_room",
  ]);

  const trace = await store.getRunTrace("cat-run-1");
  assert.ok(trace !== null);
  assert.equal(trace.run.status, "completed");
  assert.equal(trace.messages.length, 0);
  assert.equal(trace.tool_calls[0]?.name, "character.go_to_room");
  assert.deepEqual(trace.tool_calls[0]?.arguments, { room_id: "primary_bedroom" });
  assert.equal(trace.actions[0]?.status, "completed");
  assert.deepEqual(trace.events.map((event) => event.type), [
    "cat.run.started",
    "cat.model.completed",
    "cat.run.completed",
  ]);

  const requestsBeforeRejection = device.received_action_requests;
  await assert.rejects(
    runCatRoomTargetEvent({
      event: { ...roomEvent("cat-source-event-2", now), text: "用户原文" },
      run_id: "cat-run-2",
      session_id: "cat-session-1",
      session_created_at_ms: now - 1,
      tool_call_id: "cat-tool-call-2",
      action_id: "cat-action-2",
      policy,
      scheduler,
      adapter,
      provider: catModel.provider,
      clock: () => now,
      audit_store: store,
    }),
    (error) => error instanceof CatEventPolicyError && error.code === "INVALID_EVENT",
  );
  assert.equal(device.received_action_requests, requestsBeforeRejection);
  assert.equal(await store.getRunTrace("cat-run-2"), null);
  assert.equal(catModel.requests.length, 1);
});

test("an approved event terminalizes its audit Run when the device is not ready", async () => {
  const now = 60_000;
  const device = new DeterministicFakeDevice({ now: () => now });
  const socket = new DeterministicFakeDeviceSocket(device);
  const adapter = new DeviceWebSocketActionAdapter(socket, { device_id: device.device_id });
  const scheduler = new RoleScheduler();
  const catModel = catToolProvider("study");
  using store = new SqliteAuditStore(":memory:");

  const result = await runCatRoomTargetEvent({
    event: roomEvent("cat-offline-event", now),
    run_id: "cat-offline-run",
    session_id: "cat-offline-session",
    session_created_at_ms: now - 1,
    tool_call_id: "cat-offline-tool",
    action_id: "cat-offline-action",
    policy: new CatEventPolicy({ now: () => now, minimum_interval_ms: 0 }),
    scheduler,
    adapter,
    provider: catModel.provider,
    clock: () => now,
    audit_store: store,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.outcome.status, "failed");
  assert.equal(device.received_action_requests, 0);
  const trace = await store.getRunTrace("cat-offline-run");
  assert.equal(trace?.run.status, "failed");
  assert.equal(trace?.tool_calls[0]?.status, "error");
  assert.equal(trace?.actions[0]?.status, "failed");
});

test("Cat Run waits for snapshot evidence and persists unknown instead of false completion", async () => {
  let now = 70_000;
  const { adapter, device, socket } = connectedHarness({
    now: () => now,
    auto_execute: false,
  });
  void adapter.executeAction({
    action_id: "other-active-action",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 1_000,
    wait_timeout_ms: 10_000,
  });
  assert.equal(device.startNext(), true);
  const catModel = catToolProvider("study");
  using store = new SqliteAuditStore(":memory:");
  const runPromise = runCatRoomTargetEvent({
    event: roomEvent("cat-reconcile-event", now, "study"),
    run_id: "cat-reconcile-run",
    session_id: "cat-reconcile-session",
    session_created_at_ms: now - 1,
    tool_call_id: "cat-reconcile-tool",
    action_id: "cat-reconcile-action",
    policy: new CatEventPolicy({ now: () => now, minimum_interval_ms: 0 }),
    scheduler: new RoleScheduler(),
    adapter,
    provider: catModel.provider,
    clock: () => now,
    wait_timeout_ms: 10_000,
    reconciliation_timeout_ms: 1_000,
    audit_store: store,
  });
  while (device.received_action_requests < 2) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  socket.disconnect();
  now += 1;
  assert.equal(device.completeActive(), true);
  socket.connect("reconnect");

  const result = await runPromise;
  assert.equal(result.status, "failed");
  assert.equal(result.outcome.status, "unknown");
  assert.equal(
    result.outcome.status === "unknown" ? result.outcome.reconciliation?.status : null,
    "state_satisfied",
  );
  assert.equal(device.executionCount("cat-reconcile-action"), 0);
  const trace = await store.getRunTrace("cat-reconcile-run");
  assert.equal(trace?.run.status, "failed");
  assert.equal(trace?.actions[0]?.status, "failed");
  assert.equal(trace?.tool_calls[0]?.error?.details?.outcome, "unknown");
  assert.equal(
    (trace?.tool_calls[0]?.error?.details?.reconciliation as { status?: string } | undefined)?.status,
    "state_satisfied",
  );
});

test("Cat Run accepts an explicit late terminal during the reconciliation window", async () => {
  const now = 75_000;
  const { adapter, device } = connectedHarness({
    now: () => now,
    auto_execute: false,
  });
  const catModel = catToolProvider("guest_room");
  using store = new SqliteAuditStore(":memory:");
  const runPromise = runCatRoomTargetEvent({
    event: roomEvent("cat-late-terminal-event", now, "guest_room"),
    run_id: "cat-late-terminal-run",
    session_id: "cat-late-terminal-session",
    session_created_at_ms: now - 1,
    tool_call_id: "cat-late-terminal-tool",
    action_id: "cat-late-terminal-action",
    policy: new CatEventPolicy({ now: () => now, minimum_interval_ms: 0 }),
    scheduler: new RoleScheduler(),
    adapter,
    provider: catModel.provider,
    clock: () => now,
    wait_timeout_ms: 10,
    reconciliation_timeout_ms: 1_000,
    audit_store: store,
  });
  while (device.received_action_requests < 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(device.startNext(), true);
  assert.equal(device.completeActive(), true);

  const result = await runPromise;
  assert.equal(result.status, "completed");
  assert.equal(result.outcome.status, "completed");
  assert.equal(result.outcome.status === "completed" ? result.outcome.source : null, "lifecycle");
  assert.equal(device.executionCount("cat-late-terminal-action"), 1);
  const trace = await store.getRunTrace("cat-late-terminal-run");
  assert.equal(trace?.run.status, "completed");
  assert.equal(trace?.actions[0]?.status, "completed");
  assert.equal(trace?.tool_calls[0]?.status, "success");
});

test("invalid Cat model decisions fail before ToolCall audit or device output", async () => {
  const now = 80_000;
  const { adapter, device } = connectedHarness({ now: () => now });
  const wrongModel = catToolProvider("kitchen");
  using store = new SqliteAuditStore(":memory:");
  const result = await runCatRoomTargetEvent({
    event: roomEvent("cat-invalid-model-event", now, "study"),
    run_id: "cat-invalid-model-run",
    session_id: "cat-invalid-model-session",
    session_created_at_ms: now - 1,
    tool_call_id: "cat-invalid-model-tool",
    action_id: "cat-invalid-model-action",
    policy: new CatEventPolicy({ now: () => now, minimum_interval_ms: 0 }),
    scheduler: new RoleScheduler(),
    adapter,
    provider: wrongModel.provider,
    clock: () => now,
    audit_store: store,
  });

  assert.equal(result.status, "failed");
  assert.equal(device.received_action_requests, 0);
  const trace = await store.getRunTrace("cat-invalid-model-run");
  assert.equal(trace?.run.status, "failed");
  assert.equal(trace?.tool_calls.length, 0);
  assert.equal(trace?.actions.length, 0);
  assert.deepEqual(trace?.events.map((event) => event.type), [
    "cat.run.started",
    "cat.run.failed",
  ]);
});
