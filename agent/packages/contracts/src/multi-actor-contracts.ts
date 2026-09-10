import { readFileSync } from "node:fs";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";

export const MULTI_ACTOR_IDS = ["human_avatar", "cat"] as const;
export type MultiActorId = typeof MULTI_ACTOR_IDS[number];
export interface MultiActorDeviceMessage {
  readonly protocol_version: 4;
  readonly message_id: string;
  readonly correlation_id: string | null;
  readonly device_id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly sent_at_ms: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}
export interface MultiActorState {
  readonly actor_id: MultiActorId;
  readonly state_version: number;
  readonly room_id: string;
  readonly activity: "idle" | "sleep";
  readonly speaking: boolean;
  readonly active_action_id: string | null;
  readonly target_object_id: string | null;
  readonly pose: "standing" | "sitting";
}
export interface MultiActorObjectState {
  readonly object_id: string;
  readonly room_id: string;
  readonly available: boolean;
  readonly occupied_by_actor_id: MultiActorId | null;
}
const root = new URL("../../../../contracts/device-protocol/", import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
function schema(path: string): AnySchema {
  return JSON.parse(readFileSync(new URL(path, root), "utf8")) as AnySchema;
}
ajv.addSchema(schema("v1/messages/payloads.schema.json"));
ajv.addSchema(schema("v4/envelope.schema.json"));
ajv.addSchema(schema("v4/messages/payloads.schema.json"));
const validate = ajv.compile(schema("v4/message.schema.json"));

/** Validate the complete shared world before producing either actor projection. */
export function validateMultiActorDeviceMessage(value: unknown): MultiActorDeviceMessage {
  if (!validate(value)) throw new TypeError(`invalid v4 message: ${ajv.errorsText(validate.errors)}`);
  const message = structuredClone(value) as MultiActorDeviceMessage;
  const p = message.payload;
  if (message.type === "world.snapshot" || message.type === "world.changed") {
    const actors = p.actors as readonly MultiActorState[];
    const objects = p.objects as readonly MultiActorObjectState[];
    if (actors.filter((actor) => actor.speaking).length > 1
      || actors.filter((actor) => actor.active_action_id !== null).length > 1) {
      throw new TypeError("v4 shared execution resource has multiple owners");
    }
    for (const actor of actors) {
      if (actor.target_object_id !== null && !objects.some((object) =>
        object.object_id === actor.target_object_id && object.available && object.room_id === actor.room_id)) {
        throw new TypeError("v4 actor target is unavailable or in another room");
      }
      if (actor.pose === "sitting" && !objects.some((object) =>
        object.object_id === actor.target_object_id && object.available
        && object.occupied_by_actor_id === actor.actor_id)) {
        throw new TypeError("v4 sitting actor does not own its available object");
      }
    }
    for (const object of objects) {
      if (object.occupied_by_actor_id !== null && !actors.some((actor) =>
        actor.actor_id === object.occupied_by_actor_id && actor.pose === "sitting"
        && actor.target_object_id === object.object_id && object.available)) {
        throw new TypeError("v4 occupied object has no seated owner");
      }
    }
  }
  if (message.type === "action.completed"
    && (p.tool === "character.get_state" || p.tool === "world.get_snapshot")
    && (p.result as Record<string, unknown>).actor_id !== p.actor_id) {
    throw new TypeError("v4 result actor does not match action actor");
  }
  return message;
}
