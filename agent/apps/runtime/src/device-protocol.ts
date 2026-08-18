import {
  ContractBoundaryError,
  type FrozenDeviceMessage,
  type FrozenDeviceMessageType,
  validateFrozenDeviceMessage,
} from "@p4home/contracts";
import type { CharacterActivity, RoomId } from "@p4home/domain-p4home";

export const DEVICE_PROTOCOL_VERSION = 1 as const;
export const DEVICE_MAX_JSON_FRAME_BYTES = 16_384;
export const DEVICE_ACTION_QUEUE_CAPACITY = 8;

export type DeviceToolName =
  | "character.get_state"
  | "character.go_to_room"
  | "character.set_activity"
  | "character.say"
  | "world.get_snapshot";

export type DeviceActionErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_TOOL"
  | "UNKNOWN_ROOM"
  | "QUEUE_FULL"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "DEVICE_BUSY"
  | "ACTION_ID_CONFLICT"
  | "INTERNAL";

export type DeviceActionOrigin = "user" | "agent" | "autonomy" | "test";

export type CharacterState = Readonly<{
  room_id: RoomId;
  activity: CharacterActivity;
  speaking: boolean;
  active_action_id: string | null;
}>;

export type WorldSnapshotPayload = Readonly<{
  snapshot_id: string;
  reason: "connect" | "reconnect" | "resync" | "requested";
  state_version: number;
  observed_at_ms: number;
  character: CharacterState;
}>;

export type ActionRequestPayload = Readonly<{
  action_id: string;
  tool: DeviceToolName;
  arguments: Record<string, unknown>;
  timeout_ms: number;
  origin: DeviceActionOrigin;
}>;

export type ActionAcceptedPayload = Readonly<{
  action_id: string;
  queue_position: number;
  accepted_at_ms: number;
}>;

export type ActionStartedPayload = Readonly<{
  action_id: string;
  started_at_ms: number;
}>;

export type ActionCompletedPayload = Readonly<{
  action_id: string;
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
  failed_at_ms: number;
  error: DeviceActionError;
}>;

export type DeviceMessage<
  TType extends FrozenDeviceMessageType = FrozenDeviceMessageType,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = FrozenDeviceMessage<TType, TPayload>;

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
    validated = validateFrozenDeviceMessage(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeviceProtocolBoundaryError("INVALID_MESSAGE", detail);
  }
  const frame = JSON.stringify(validated);
  if (Buffer.byteLength(frame, "utf8") > DEVICE_MAX_JSON_FRAME_BYTES) {
    throw new DeviceProtocolBoundaryError(
      "FRAME_TOO_LARGE",
      `Device Protocol v1 frame exceeds ${DEVICE_MAX_JSON_FRAME_BYTES} bytes`,
    );
  }
  return frame;
}

export function decodeDeviceMessage(frame: string): DeviceMessage {
  if (Buffer.byteLength(frame, "utf8") > DEVICE_MAX_JSON_FRAME_BYTES) {
    throw new DeviceProtocolBoundaryError(
      "FRAME_TOO_LARGE",
      `Device Protocol v1 frame exceeds ${DEVICE_MAX_JSON_FRAME_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new DeviceProtocolBoundaryError("INVALID_JSON", "Device Protocol v1 frame is not JSON");
  }
  try {
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
