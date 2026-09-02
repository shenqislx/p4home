import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getHumanAvatarToolDefinitions,
  getObjectRuntimeToolDefinitions,
  validateHumanAvatarDeviceMessage,
  validateHumanAvatarToolCalls,
  validateHumanAvatarToolResult,
  validateObjectRuntimeToolResult,
} from "@p4home/contracts";
import {
  decodeDeviceMessage,
  encodeDeviceMessage,
  HUMAN_AVATAR_ACTOR_ID,
} from "../../apps/runtime/src/device-protocol.ts";
import {
  DeviceWebSocketActionAdapter,
  type DeviceWebSocketConnection,
} from "../../apps/runtime/src/device-action-adapter.ts";

const objects = [
  { object_id: "living_room.sofa", room_id: "living_room", available: true, occupied: false },
  { object_id: "study.desk", room_id: "study", available: true, occupied: false },
  { object_id: "living_room.window", room_id: "living_room", available: true, occupied: false },
] as const;

const objectCapabilities = [
  { ...objects[0], supported_actions: ["go_to", "sit", "look_at", "interact"] },
  { ...objects[1], supported_actions: ["go_to", "look_at", "interact"] },
  { ...objects[2], supported_actions: ["go_to", "look_at", "interact"] },
].map(({ occupied: _occupied, ...item }) => item);

const character = {
  room_id: "living_room",
  activity: "idle",
  speaking: false,
  active_action_id: null,
  target_object_id: null,
  pose: "standing",
} as const;

function deviceMessage(seq: number, type: string, payload: Record<string, unknown>) {
  return {
    protocol_version: 3 as const,
    message_id: `device-message-${seq}`,
    correlation_id: null,
    device_id: "p4-human-avatar",
    session_id: "session-human-avatar",
    seq,
    sent_at_ms: 1_000 + seq,
    type,
    payload,
  };
}

class FakeConnection implements DeviceWebSocketConnection {
  public is_open = true;
  public readonly sent: string[] = [];
  #frame: ((frame: string) => void) | null = null;
  #close: (() => void) | null = null;

  public async send(frame: string): Promise<void> { this.sent.push(frame); }
  public close(): void { this.is_open = false; this.#close?.(); }
  public onFrame(listener: (frame: string) => void): () => void {
    this.#frame = listener;
    return () => { this.#frame = null; };
  }
  public onClose(listener: () => void): () => void {
    this.#close = listener;
    return () => { this.#close = null; };
  }
  public receive(message: ReturnType<typeof deviceMessage>): void {
    this.#frame?.(JSON.stringify(message));
  }
}

test("Device Protocol v3 requires the fixed Human avatar actor on every remote boundary", () => {
  const snapshot = deviceMessage(2, "world.snapshot", {
    snapshot_id: "snapshot-human-avatar",
    reason: "connect",
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    state_version: 1,
    observed_at_ms: 1_002,
    character,
    objects,
  });
  assert.equal(validateHumanAvatarDeviceMessage(snapshot).payload.actor_id, HUMAN_AVATAR_ACTOR_ID);
  assert.equal(decodeDeviceMessage(JSON.stringify(snapshot)).protocol_version, 3);
  assert.throws(
    () => validateHumanAvatarDeviceMessage({ ...snapshot, payload: { ...snapshot.payload, actor_id: "cat" } }),
    /human_avatar|must be equal/,
  );
  assert.throws(
    () => validateHumanAvatarDeviceMessage({ ...snapshot, payload: { ...snapshot.payload, actor_id: undefined } }),
    /actor_id/,
  );
});

test("v3 canonical examples cover every action lifecycle payload", () => {
  const valid = JSON.parse(readFileSync(
    new URL("../../../contracts/device-protocol/v3/examples/valid/object-runtime.json", import.meta.url),
    "utf8",
  )) as readonly ReturnType<typeof deviceMessage>[];
  const invalid = JSON.parse(readFileSync(
    new URL("../../../contracts/device-protocol/v3/examples/invalid/object-runtime.json", import.meta.url),
    "utf8",
  )) as readonly { readonly name: string; readonly message: unknown }[];
  for (const message of valid) validateHumanAvatarDeviceMessage(message);
  for (const fixture of invalid) {
    assert.throws(
      () => validateHumanAvatarDeviceMessage(fixture.message),
      fixture.name,
    );
  }
  const lifecycleTypes = new Set(valid.map((message) => message.type));
  for (const type of [
    "action.request", "action.accepted", "action.started", "action.completed",
    "action.failed", "action.cancel",
  ]) {
    assert.equal(lifecycleTypes.has(type), true, `${type} example missing`);
  }
});

test("v3 adapter injects human_avatar and exposes cloned live capabilities", async () => {
  const connection = new FakeConnection();
  const adapter = new DeviceWebSocketActionAdapter(connection, {
    device_id: "p4-human-avatar",
    protocol_version: 3,
    actor_id: HUMAN_AVATAR_ACTOR_ID,
  });
  assert.throws(
    () => new DeviceWebSocketActionAdapter(new FakeConnection(), {
      device_id: "p4-human-avatar",
      protocol_version: 3,
    }),
    /bind human_avatar/,
  );
  connection.receive(deviceMessage(0, "device.hello", {
    boot_id: "boot-human-avatar",
    firmware_version: "test",
    protocol_versions: [1, 2, 3],
    connection_reason: "test",
  }));
  connection.receive(deviceMessage(1, "device.capabilities", {
    selected_protocol_version: 3,
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    rooms: ["primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen"],
    actions: ["character.get_state", "character.go_to_room", "character.set_activity", "character.say", "world.get_snapshot", "character.go_to", "character.sit", "character.look_at", "character.interact"],
    objects: objectCapabilities,
    limits: { max_json_frame_bytes: 16_384, action_queue_capacity: 8, say_text_max_chars: 256, action_timeout_min_ms: 100, action_timeout_max_ms: 120_000, idempotency_retention_ms: 600_000 },
  }));
  connection.receive(deviceMessage(2, "world.snapshot", {
    snapshot_id: "snapshot-human-avatar",
    reason: "connect",
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    state_version: 1,
    observed_at_ms: 1_002,
    character,
    objects,
  }));
  assert.equal(adapter.is_ready, true);
  assert.deepEqual(adapter.room_capabilities, [
    "primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen",
  ]);
  assert.equal(adapter.action_capabilities.includes("character.sit"), true);

  const outcome = adapter.executeAction({
    action_id: "human-avatar-action-1",
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    tool: "character.go_to_room",
    arguments: { room_id: "study" },
    timeout_ms: 5_000,
    origin: "user",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const outbound = decodeDeviceMessage(connection.sent[0]!);
  assert.equal(outbound.protocol_version, 3);
  assert.equal(outbound.payload.actor_id, HUMAN_AVATAR_ACTOR_ID);
  connection.receive(deviceMessage(3, "action.accepted", {
    action_id: "human-avatar-action-1",
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    queue_position: 0,
    accepted_at_ms: 1_003,
  }));
  connection.receive(deviceMessage(4, "action.started", {
    action_id: "human-avatar-action-1",
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    started_at_ms: 1_004,
  }));
  connection.receive(deviceMessage(5, "action.completed", {
    action_id: "human-avatar-action-1",
    actor_id: HUMAN_AVATAR_ACTOR_ID,
    tool: "character.go_to_room",
    completed_at_ms: 1_005,
    state_version: 2,
    result: { room_id: "study" },
  }));
  assert.equal((await outcome).status, "completed");
});

test("v1 and v2 encoders reject actor_id instead of silently widening frozen protocols", () => {
  for (const protocol_version of [1, 2] as const) {
    assert.throws(() => encodeDeviceMessage({
      protocol_version,
      message_id: "legacy-action",
      correlation_id: null,
      device_id: "p4-human-avatar",
      session_id: "legacy-session",
      seq: 0,
      sent_at_ms: 1,
      type: "action.request",
      payload: {
        action_id: "legacy-action",
        actor_id: HUMAN_AVATAR_ACTOR_ID,
        tool: "character.go_to_room",
        arguments: { room_id: "study" },
        timeout_ms: 1_000,
        origin: "user",
      },
    } as never));
  }
});

test("Human avatar Tool Schema v3 is isolated from frozen Cat Tool Schema v2", () => {
  const v2Names = getObjectRuntimeToolDefinitions().map((tool) => tool.name);
  const v3Names = getHumanAvatarToolDefinitions().map((tool) => tool.name);
  assert.deepEqual(v2Names, [
    "character.get_state", "character.go_to_room", "character.set_activity",
    "character.say", "world.get_snapshot", "character.go_to", "character.sit",
    "character.look_at", "character.interact",
  ]);
  assert.deepEqual(v3Names, [
    "character.go_to_room", "character.go_to", "character.sit",
    "character.look_at", "character.interact",
  ]);
  assert.throws(
    () => validateHumanAvatarToolCalls([{ name: "character.say", arguments: { text: "喵" } }]),
    /not in Human avatar Tool Schema v3/,
  );
  const v3Result = {
    schema_version: 3,
    tool_call_id: "avatar-tool-result",
    name: "character.go_to_room",
    status: "success",
    result: { room_id: "study" },
    error: null,
  } as const;
  assert.equal(validateHumanAvatarToolResult(v3Result).schema_version, 3);
  assert.throws(() => validateObjectRuntimeToolResult(v3Result), /Tool Schema v2/);
  assert.throws(() => validateHumanAvatarToolResult({ ...v3Result, schema_version: 2 }),
    /Tool Schema v3/);

  const mutable = getHumanAvatarToolDefinitions();
  (mutable[0]!.parameters as { properties?: unknown }).properties = {};
  assert.notDeepEqual(getHumanAvatarToolDefinitions()[0]?.parameters, {});
});
