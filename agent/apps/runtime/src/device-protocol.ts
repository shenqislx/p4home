import {
  ContractBoundaryError,
  type FrozenDeviceMessage,
  type FrozenDeviceMessageType,
  type HumanAvatarDeviceMessage,
  type ObjectRuntimeDeviceMessage,
  validateHumanAvatarDeviceMessage,
  validateObjectRuntimeDeviceMessage,
  validateFrozenDeviceMessage,
} from "@p4home/contracts";
import type { CharacterActivity, RoomId } from "@p4home/domain-p4home";

export const DEVICE_PROTOCOL_VERSION = 1 as const;
export const OBJECT_RUNTIME_DEVICE_PROTOCOL_VERSION = 2 as const;
export const HUMAN_AVATAR_DEVICE_PROTOCOL_VERSION = 3 as const;
export const HUMAN_AVATAR_ACTOR_ID = "human_avatar" as const;
export type HumanAvatarActorId = typeof HUMAN_AVATAR_ACTOR_ID;
export type DeviceProtocolVersion = 1 | 2 | 3;
export const DEVICE_MAX_JSON_FRAME_BYTES = 16_384;
export const DEVICE_ACTION_QUEUE_CAPACITY = 8;

export type DeviceToolName =
  | "character.get_state"
  | "character.go_to_room"
  | "character.set_activity"
  | "character.say"
  | "world.get_snapshot"
  | "character.go_to"
  | "character.sit"
  | "character.look_at"
  | "character.interact";

export type DeviceActionErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_TOOL"
  | "UNKNOWN_ROOM"
  | "QUEUE_FULL"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "DEVICE_BUSY"
  | "ACTION_ID_CONFLICT"
  | "UNKNOWN_OBJECT"
  | "UNSUPPORTED_OBJECT_ACTION"
  | "OBJECT_UNAVAILABLE"
  | "OBJECT_OCCUPIED"
  | "OBJECT_NOT_REACHED"
  | "INTERNAL";

export type DeviceActionOrigin = "user" | "agent" | "autonomy" | "test";

export type CharacterState = Readonly<{
  room_id: RoomId;
  activity: CharacterActivity;
  speaking: boolean;
  active_action_id: string | null;
}>;

export type ObjectRuntimeCharacterState = CharacterState & Readonly<{
  target_object_id: ObjectId | null;
  pose: "standing" | "sitting";
}>;

export type ObjectId = "living_room.sofa" | "study.desk" | "living_room.window";
export type ObjectAction = "go_to" | "sit" | "look_at" | "interact";

export type DeviceObjectCapability = Readonly<{
  object_id: ObjectId;
  room_id: RoomId;
  supported_actions: readonly ObjectAction[];
  available: boolean;
}>;

export type DeviceObjectState = Readonly<{
  object_id: ObjectId;
  room_id: RoomId;
  available: boolean;
  occupied: boolean;
}>;

export type WorldSnapshotPayload = Readonly<{
  snapshot_id: string;
  reason: "connect" | "reconnect" | "resync" | "requested";
  state_version: number;
  observed_at_ms: number;
  character: CharacterState | ObjectRuntimeCharacterState;
  objects?: readonly DeviceObjectState[];
  actor_id?: HumanAvatarActorId;
}>;

export type DeviceCapabilitiesPayload = Readonly<{
  selected_protocol_version: DeviceProtocolVersion;
  rooms: readonly RoomId[];
  actions: readonly DeviceToolName[];
  objects?: readonly DeviceObjectCapability[];
  actor_id?: HumanAvatarActorId;
  limits: Readonly<Record<string, number>>;
}>;

export type ActionRequestPayload = Readonly<{
  action_id: string;
  actor_id?: HumanAvatarActorId;
  tool: DeviceToolName;
  arguments: Record<string, unknown>;
  timeout_ms: number;
  origin: DeviceActionOrigin;
}>;

export type ActionAcceptedPayload = Readonly<{
  action_id: string;
  actor_id?: HumanAvatarActorId;
  queue_position: number;
  accepted_at_ms: number;
}>;

export type ActionStartedPayload = Readonly<{
  action_id: string;
  actor_id?: HumanAvatarActorId;
  started_at_ms: number;
}>;

export type ActionCompletedPayload = Readonly<{
  action_id: string;
  actor_id?: HumanAvatarActorId;
  tool: DeviceToolName;
  completed_at_ms: number;
  state_version: number;
  result: Record<string, unknown>;
}>;

export type DeviceActionError = Readonly<{
  code: DeviceActionErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}>;

export type ActionFailedPayload = Readonly<{
  action_id: string;
  actor_id?: HumanAvatarActorId;
  failed_at_ms: number;
  error: DeviceActionError;
}>;

export type ObjectRuntimeMessage = Omit<ObjectRuntimeDeviceMessage, "type"> & {
  readonly type: FrozenDeviceMessageType;
};

export type HumanAvatarRuntimeMessage = Omit<HumanAvatarDeviceMessage, "type"> & {
  readonly type: FrozenDeviceMessageType;
};

export type DeviceMessage = FrozenDeviceMessage | ObjectRuntimeMessage | HumanAvatarRuntimeMessage;

export type DeviceProtocolBoundaryErrorCode =
  | "FRAME_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_MESSAGE";

export class DeviceProtocolBoundaryError extends Error {
  public readonly code: DeviceProtocolBoundaryErrorCode;

  public constructor(code: DeviceProtocolBoundaryErrorCode, message: string) {
    super(message);
    this.name = "DeviceProtocolBoundaryError";
    this.code = code;
  }
}

export function encodeDeviceMessage(message: DeviceMessage): string {
  let validated: DeviceMessage;
  try {
    validated = message.protocol_version === HUMAN_AVATAR_DEVICE_PROTOCOL_VERSION
      ? validateHumanAvatarDeviceMessage<HumanAvatarRuntimeMessage>(message)
      : message.protocol_version === OBJECT_RUNTIME_DEVICE_PROTOCOL_VERSION
        ? validateObjectRuntimeDeviceMessage<ObjectRuntimeMessage>(message)
        : validateFrozenDeviceMessage(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeviceProtocolBoundaryError("INVALID_MESSAGE", detail);
  }
  const frame = JSON.stringify(validated);
  if (Buffer.byteLength(frame, "utf8") > DEVICE_MAX_JSON_FRAME_BYTES) {
    throw new DeviceProtocolBoundaryError(
      "FRAME_TOO_LARGE",
      `Device Protocol v${message.protocol_version} frame exceeds ${DEVICE_MAX_JSON_FRAME_BYTES} bytes`,
    );
  }
  return frame;
}

export function decodeDeviceMessage(frame: string): DeviceMessage {
  if (Buffer.byteLength(frame, "utf8") > DEVICE_MAX_JSON_FRAME_BYTES) {
    throw new DeviceProtocolBoundaryError(
      "FRAME_TOO_LARGE",
      `Device Protocol frame exceeds ${DEVICE_MAX_JSON_FRAME_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new DeviceProtocolBoundaryError("INVALID_JSON", "Device Protocol v1 frame is not JSON");
  }
  try {
    const version = (value as { protocol_version?: unknown }).protocol_version;
    if (version === HUMAN_AVATAR_DEVICE_PROTOCOL_VERSION) {
      return validateHumanAvatarDeviceMessage<HumanAvatarRuntimeMessage>(value);
    }
    if (version === OBJECT_RUNTIME_DEVICE_PROTOCOL_VERSION) {
      return validateObjectRuntimeDeviceMessage<ObjectRuntimeMessage>(value);
    }
    return validateFrozenDeviceMessage(value);
  } catch (error) {
    const detail = error instanceof ContractBoundaryError ? error.message : String(error);
    throw new DeviceProtocolBoundaryError("INVALID_MESSAGE", detail);
  }
}

export function payloadOf<T extends Record<string, unknown>>(
  message: DeviceMessage,
): T {
  return message.payload as T;
}
