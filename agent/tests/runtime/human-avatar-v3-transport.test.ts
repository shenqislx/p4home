import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceRuntimeHub,
  decodeDeviceMessage,
  encodeDeviceMessage,
  HUMAN_AVATAR_ACTOR_ID,
  type DeviceMessage,
} from "@p4home/runtime";
import WebSocket from "ws";

const DEVICE_ID = "p4-human-avatar-v3";
const DEVICE_TOKEN = "human-avatar-v3-token-0123456789abcdef";

function frame(
  sessionId: string,
  seq: number,
  type: DeviceMessage["type"],
  payload: Record<string, unknown>,
  correlationId: string | null = null,
): string {
  return encodeDeviceMessage({
    protocol_version: 3,
    message_id: `human-avatar-v3-${seq}`,
    correlation_id: correlationId,
    device_id: DEVICE_ID,
    session_id: sessionId,
    seq,
    sent_at_ms: 1_788_000_000_000 + seq,
    type,
    payload,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("DeviceRuntimeHub carries a Human-avatar action through Device Protocol v3", async (t) => {
  const hub = new DeviceRuntimeHub({
    server: {
      host: "127.0.0.1",
      port: 0,
      device_tokens: { [DEVICE_ID]: DEVICE_TOKEN },
      allow_insecure_loopback_test: true,
    },
    adapter: { protocol_version: 3, actor_id: HUMAN_AVATAR_ACTOR_ID },
    handshake_timeout_ms: 250,
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

  const sessionId = "human-avatar-v3-session";
  socket.send(frame(sessionId, 0, "device.hello", {
    boot_id: "human-avatar-v3-boot",
    firmware_version: "human-avatar-v3-test",
    protocol_versions: [1, 2, 3],
    connection_reason: "test",
  }));
  socket.send(frame(sessionId, 1, "device.capabilities", {
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    selected_protocol_version: 3,
    rooms: ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
    actions: [
      "character.get_state", "character.go_to_room", "character.set_activity",
      "character.say", "world.get_snapshot", "character.go_to", "character.sit",
      "character.look_at", "character.interact",
    ],
    limits: {
      max_json_frame_bytes: 16_384,
      action_queue_capacity: 8,
      say_text_max_chars: 256,
      action_timeout_min_ms: 100,
      action_timeout_max_ms: 120_000,
      idempotency_retention_ms: 600_000,
    },
    objects: [
      {
        object_id: "living_room.sofa", room_id: "living_room",
        supported_actions: ["go_to", "sit", "look_at", "interact"], available: true,
      },
      {
        object_id: "study.desk", room_id: "study",
        supported_actions: ["go_to", "look_at", "interact"], available: true,
      },
      {
        object_id: "living_room.window", room_id: "living_room",
        supported_actions: ["go_to", "look_at", "interact"], available: true,
      },
    ],
  }));
  socket.send(frame(sessionId, 2, "world.snapshot", {
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    snapshot_id: "human-avatar-v3-snapshot",
    reason: "connect",
    state_version: 1,
    observed_at_ms: 1_788_000_000_002,
    character: {
      room_id: "living_room",
      activity: "idle",
      speaking: false,
      active_action_id: null,
      pose: "standing",
      target_object_id: null,
    },
    objects: [
      { object_id: "living_room.sofa", room_id: "living_room", available: true, occupied: false },
      { object_id: "study.desk", room_id: "study", available: true, occupied: false },
      { object_id: "living_room.window", room_id: "living_room", available: true, occupied: false },
    ],
  }));

  await waitUntil(() => hub.getAdapter(DEVICE_ID)?.is_ready === true);
  const adapter = hub.getAdapter(DEVICE_ID)!;
  let seq = 3;
  socket.on("message", (data) => {
    const request = decodeDeviceMessage(data.toString("utf8"));
    if (request.type !== "action.request") return;
    assert.equal(request.payload.actor_id, HUMAN_AVATAR_ACTOR_ID);
    const actionId = String(request.payload.action_id);
    socket.send(frame(sessionId, seq++, "action.accepted", {
      actor_id: HUMAN_AVATAR_ACTOR_ID,
      action_id: actionId,
      queue_position: 0,
      accepted_at_ms: 1_788_000_000_010,
    }, request.message_id));
    socket.send(frame(sessionId, seq++, "action.started", {
      actor_id: HUMAN_AVATAR_ACTOR_ID,
      action_id: actionId,
      started_at_ms: 1_788_000_000_011,
    }, request.message_id));
    socket.send(frame(sessionId, seq++, "action.completed", {
      actor_id: HUMAN_AVATAR_ACTOR_ID,
      action_id: actionId,
      tool: "character.go_to_room",
      completed_at_ms: 1_788_000_000_012,
      state_version: 2,
      result: { room_id: "study" },
    }, request.message_id));
  });

  const outcome = await adapter.executeAction({
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    action_id: "human-avatar-v3-action",
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    origin: "user",
    timeout_ms: 2_000,
  });
  assert.equal(outcome.status, "completed");
});
