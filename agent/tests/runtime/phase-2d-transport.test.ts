import assert from "node:assert/strict";
import test from "node:test";

import {
  CatEventPolicy,
  DeviceRuntimeHub,
  DeviceWebSocketServer,
  RoleScheduler,
  decodeDeviceMessage,
  encodeDeviceMessage,
  runCatRoomTargetEvent,
  type DeviceMessage,
} from "@p4home/runtime";
import WebSocket from "ws";

const DEVICE_ID = "p4-phase-2d-test";
const DEVICE_TOKEN = "phase-2d-test-token-0123456789abcdef";

function deviceFrame(
  sessionId: string,
  seq: number,
  type: DeviceMessage["type"],
  payload: Record<string, unknown>,
  correlationId: string | null = null,
): string {
  return encodeDeviceMessage({
    protocol_version: 1,
    message_id: `device-message-${seq}`,
    correlation_id: correlationId,
    device_id: DEVICE_ID,
    session_id: sessionId,
    seq,
    sent_at_ms: 1_787_000_000_000 + seq,
    type,
    payload,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("condition did not become true before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real WebSocket transport authenticates before upgrade and completes an action", async (t) => {
  const hub = new DeviceRuntimeHub({
    server: {
      host: "127.0.0.1",
      port: 0,
      device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
      allow_insecure_loopback_test: true,
    },
    handshake_timeout_ms: 250,
  });
  const server = hub.server;
  const address = await hub.start();
  t.after(async () => hub.close());

  const rejected = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: { "X-P4-Device-ID": DEVICE_ID },
  });
  await new Promise<void>((resolve, reject) => {
    rejected.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        rejected.terminate();
      }
    });
    rejected.once("open", () => reject(new Error("unauthenticated upgrade unexpectedly opened")));
    rejected.once("error", () => undefined);
  });
  assert.equal(server.connection_count, 0);

  const inheritedDevice = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": "constructor",
    },
  });
  await new Promise<void>((resolve, reject) => {
    inheritedDevice.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        inheritedDevice.terminate();
      }
    });
    inheritedDevice.once("open", () => reject(new Error("inherited token key unexpectedly opened")));
    inheritedDevice.once("error", () => undefined);
  });

  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": DEVICE_ID,
    },
  });
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const sessionId = "phase-2d-session-1";
  socket.send(deviceFrame(sessionId, 0, "device.hello", {
    boot_id: "phase-2d-boot-1",
    firmware_version: "phase-2d-test",
    protocol_versions: [1],
    connection_reason: "test",
  }));
  socket.send(deviceFrame(sessionId, 1, "device.capabilities", {
    selected_protocol_version: 1,
    rooms: ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
    actions: [
      "character.get_state",
      "character.go_to_room",
      "character.set_activity",
      "character.say",
      "world.get_snapshot",
    ],
    limits: {
      max_json_frame_bytes: 16_384,
      action_queue_capacity: 8,
      say_text_max_chars: 256,
      action_timeout_min_ms: 100,
      action_timeout_max_ms: 120_000,
      idempotency_retention_ms: 600_000,
    },
  }));
  socket.send(deviceFrame(sessionId, 2, "world.snapshot", {
    snapshot_id: "phase-2d-snapshot-1",
    reason: "connect",
    state_version: 1,
    observed_at_ms: 1_787_000_000_002,
    character: {
      room_id: "living_room",
      activity: "idle",
      speaking: false,
      active_action_id: null,
    },
  }));
  await waitUntil(() => hub.adapter_count === 1);
  const activeAdapter = hub.getAdapter(DEVICE_ID);
  assert.notEqual(activeAdapter, undefined);
  const adapter = activeAdapter!;
  await waitUntil(() => adapter.is_ready);

  let outgoingSeq = 3;
  socket.on("message", (data) => {
    const request = decodeDeviceMessage(data.toString("utf8"));
    if (request.type !== "action.request") {
      return;
    }
    const actionId = String(request.payload.action_id);
    socket.send(deviceFrame(sessionId, outgoingSeq++, "action.accepted", {
      action_id: actionId,
      queue_position: 0,
      accepted_at_ms: 1_787_000_000_010,
    }, request.message_id));
    socket.send(deviceFrame(sessionId, outgoingSeq++, "action.started", {
      action_id: actionId,
      started_at_ms: 1_787_000_000_011,
    }, request.message_id));
    socket.send(deviceFrame(sessionId, outgoingSeq++, "action.completed", {
      action_id: actionId,
      tool: "character.go_to_room",
      completed_at_ms: 1_787_000_000_012,
      state_version: 2,
      result: { room_id: "study" },
    }, request.message_id));
    socket.send(deviceFrame(sessionId, outgoingSeq++, "world.changed", {
      state_version: 2,
      observed_at_ms: 1_787_000_000_013,
      character: {
        room_id: "study",
        activity: "idle",
        speaking: false,
        active_action_id: null,
      },
    }));
  });

  const now = Date.now();
  const result = await runCatRoomTargetEvent({
    event: {
      event_id: "phase-2d-real-event-1",
      event_type: "test.room_target",
      source: "test_harness",
      occurred_at_ms: now,
      payload: { room_target: "study" },
    },
    run_id: "phase-2d-real-run-1",
    session_id: "phase-2d-real-cat-session-1",
    session_created_at_ms: now,
    tool_call_id: "phase-2d-real-tool-call-1",
    action_id: "phase-2d-real-action-1",
    policy: new CatEventPolicy({ now: () => now, minimum_interval_ms: 0 }),
    scheduler: new RoleScheduler(),
    adapter,
    provider: {
      async chat() {
        return {
          model: "phase-2d-deterministic-cat",
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
    },
    action_timeout_ms: 1_000,
    clock: () => now,
  });
  assert.equal(
    result.status,
    "completed",
    JSON.stringify({ result, protocol_error: adapter.last_protocol_error?.message }),
  );
  assert.equal(result.role_id, "cat");
  assert.deepEqual(
    result.outcome.status === "completed" ? result.outcome.result : null,
    { room_id: "study" },
  );
  const timing = adapter.getAction("phase-2d-real-action-1")?.timing;
  assert.equal(typeof timing?.accepted_latency_ms, "number");
  assert.equal(typeof timing?.started_latency_ms, "number");
  assert.equal(typeof timing?.terminal_latency_ms, "number");
  await waitUntil(() => adapter.last_snapshot?.state_version === 2);
  assert.equal(adapter.last_snapshot?.character.room_id, "study");
  assert.equal(server.connection_count, 1);

  socket.close(1000, "reconnect test");
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await waitUntil(() => server.connection_count === 0);
  assert.equal(adapter.is_ready, false);

  const reconnected = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": DEVICE_ID,
    },
  });
  t.after(() => reconnected.terminate());
  await new Promise<void>((resolve, reject) => {
    reconnected.once("open", resolve);
    reconnected.once("error", reject);
  });
  const reconnectedSessionId = "phase-2d-session-2";
  reconnected.send(deviceFrame(reconnectedSessionId, 0, "device.hello", {
    boot_id: "phase-2d-boot-1",
    firmware_version: "phase-2d-test",
    protocol_versions: [1],
    connection_reason: "reconnect",
  }));
  reconnected.send(deviceFrame(reconnectedSessionId, 1, "device.capabilities", {
    selected_protocol_version: 1,
    rooms: ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
    actions: [
      "character.get_state",
      "character.go_to_room",
      "character.set_activity",
      "character.say",
      "world.get_snapshot",
    ],
    limits: {
      max_json_frame_bytes: 16_384,
      action_queue_capacity: 8,
      say_text_max_chars: 256,
      action_timeout_min_ms: 100,
      action_timeout_max_ms: 120_000,
      idempotency_retention_ms: 600_000,
    },
  }));
  reconnected.send(deviceFrame(reconnectedSessionId, 2, "world.snapshot", {
    snapshot_id: "phase-2d-snapshot-2",
    reason: "connect",
    state_version: 2,
    observed_at_ms: 1_787_000_000_020,
    character: {
      room_id: "study",
      activity: "idle",
      speaking: false,
      active_action_id: null,
    },
  }));
  await waitUntil(() => adapter.is_ready);
  assert.equal(hub.adapter_count, 1, "reconnect must preserve the device adapter");
  assert.equal(adapter.getAction("phase-2d-real-action-1")?.status, "completed");

  const binaryClose = new Promise<{ code: number; reason: string }>((resolve) => {
    reconnected.once("close", (code, reason) => resolve({
      code,
      reason: reason.toString("utf8"),
    }));
  });
  reconnected.send(Buffer.from("{}", "utf8"));
  assert.deepEqual(await binaryClose, {
    code: 1003,
    reason: "binary frames are not supported by protocol v1",
  });
  await waitUntil(() => server.connection_count === 0);

  const stalled = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": DEVICE_ID,
    },
  });
  t.after(() => stalled.terminate());
  await new Promise<void>((resolve, reject) => {
    stalled.once("open", resolve);
    stalled.once("error", reject);
  });
  const stalledClose = await new Promise<{ code: number; reason: string }>((resolve) => {
    stalled.once("close", (code, reason) => resolve({
      code,
      reason: reason.toString("utf8"),
    }));
  });
  assert.deepEqual(stalledClose, { code: 1008, reason: "device handshake timeout" });
});

test("real transport refuses plaintext binding outside loopback", () => {
  assert.throws(
    () => new DeviceWebSocketServer({
      host: "0.0.0.0",
      port: 8080,
      device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
    }),
    /requires TLS/,
  );
  assert.throws(
    () => new DeviceWebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: "/not-v1-device",
      device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
      allow_insecure_loopback_test: true,
    }),
    /path is frozen/,
  );
  assert.throws(
    () => new DeviceWebSocketServer({
      host: "127.0.0.1",
      port: 0,
      device_tokens: { [DEVICE_ID]: "x".repeat(256) },
      allow_insecure_loopback_test: true,
    }),
    /32 to 255 bytes/,
  );
});

test("completed handshake is not reclassified as a timeout during later resync", async (t) => {
  const hub = new DeviceRuntimeHub({
    server: {
      host: "127.0.0.1",
      port: 0,
      device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
      allow_insecure_loopback_test: true,
    },
    handshake_timeout_ms: 100,
  });
  const address = await hub.start();
  t.after(async () => hub.close());
  const socket = new WebSocket(`ws://${address.host}:${address.port}${address.path}`, {
    headers: {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-P4-Device-ID": DEVICE_ID,
    },
  });
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const sessionId = "phase-2d-handshake-resync-session";
  socket.send(deviceFrame(sessionId, 0, "device.hello", {
    boot_id: "phase-2d-handshake-resync-boot",
    firmware_version: "phase-2d-test",
    protocol_versions: [1],
    connection_reason: "test",
  }));
  socket.send(deviceFrame(sessionId, 1, "device.capabilities", {
    selected_protocol_version: 1,
    rooms: ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
    actions: [
      "character.get_state",
      "character.go_to_room",
      "character.set_activity",
      "character.say",
      "world.get_snapshot",
    ],
    limits: {
      max_json_frame_bytes: 16_384,
      action_queue_capacity: 8,
      say_text_max_chars: 256,
      action_timeout_min_ms: 100,
      action_timeout_max_ms: 120_000,
      idempotency_retention_ms: 600_000,
    },
  }));
  socket.send(deviceFrame(sessionId, 2, "world.snapshot", {
    snapshot_id: "phase-2d-handshake-resync-snapshot",
    reason: "connect",
    state_version: 1,
    observed_at_ms: 1_787_000_000_002,
    character: {
      room_id: "living_room",
      activity: "idle",
      speaking: false,
      active_action_id: null,
    },
  }));
  await waitUntil(() => hub.getAdapter(DEVICE_ID)?.is_ready === true);

  socket.send(deviceFrame(sessionId, 4, "world.changed", {
    state_version: 2,
    observed_at_ms: 1_787_000_000_004,
    character: {
      room_id: "study",
      activity: "idle",
      speaking: false,
      active_action_id: null,
    },
  }));
  await waitUntil(() => hub.getAdapter(DEVICE_ID)?.is_ready === false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(socket.readyState, WebSocket.OPEN);
});
