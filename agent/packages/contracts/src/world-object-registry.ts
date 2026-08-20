import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORLD_CONTRACT_ROOT = `${REPOSITORY_ROOT}contracts/world/v1`;

export const WORLD_OBJECT_ACTIONS = ["go_to", "sit", "look_at", "interact"] as const;
export type WorldObjectAction = (typeof WORLD_OBJECT_ACTIONS)[number];
export const WORLD_OBJECT_REGISTRY_CAPACITY = 3 as const;
type WorldObjectFacing = "left" | "right";
type WorldAnimationBinding = "cat_walk" | "cat_sit" | "cat_look" | "cat_paw";
type WorldObjectRoomId =
  | "primary_bedroom"
  | "study"
  | "guest_room"
  | "entry"
  | "living_room"
  | "kitchen";

interface WorldObjectAnchor {
  readonly art_x: number;
  readonly floor_y: number;
  readonly facing: WorldObjectFacing;
}

interface WorldObjectDefinition {
  readonly object_id: string;
  readonly room_id: WorldObjectRoomId;
  readonly anchor: WorldObjectAnchor;
  readonly supported_actions: readonly WorldObjectAction[];
  readonly default_available: boolean;
  readonly animation_bindings: Readonly<Partial<Record<WorldObjectAction, WorldAnimationBinding>>>;
}

interface WorldObjectRegistry {
  readonly schema_version: 1;
  readonly registry_id: "p4home.object-registry/v1";
  readonly coordinate_space: "p4home.room-art/v1";
  readonly objects: readonly WorldObjectDefinition[];
}

export interface WorldObjectCapability {
  readonly object_id: string;
  readonly room_id: WorldObjectRoomId;
  readonly supported_actions: readonly WorldObjectAction[];
  readonly available: boolean;
}

export class WorldObjectRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorldObjectRegistryError";
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new WorldObjectRegistryError(
      `failed to read World Object Registry contract: ${errorDetail(error)}`,
    );
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "unknown validation error";
  }
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

let registryValidator: ValidateFunction | undefined;

function getRegistryValidator(): ValidateFunction {
  if (registryValidator !== undefined) {
    return registryValidator;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  try {
    registryValidator = ajv.compile(
      readJson(`${WORLD_CONTRACT_ROOT}/object-registry.schema.json`) as AnySchema,
    );
  } catch (error) {
    if (error instanceof WorldObjectRegistryError) {
      throw error;
    }
    throw new WorldObjectRegistryError(
      `failed to compile World Object Registry schema: ${errorDetail(error)}`,
    );
  }
  return registryValidator;
}

function actionOrder(action: WorldObjectAction): number {
  return WORLD_OBJECT_ACTIONS.indexOf(action);
}

const ANIMATION_BY_ACTION: Readonly<Record<WorldObjectAction, WorldAnimationBinding>> = {
  go_to: "cat_walk",
  sit: "cat_sit",
  look_at: "cat_look",
  interact: "cat_paw",
};

function parseWorldObjectRegistry(input: unknown): WorldObjectRegistry {
  const validate = getRegistryValidator();
  if (!validate(input)) {
    throw new WorldObjectRegistryError(`World Object Registry v1: ${formatErrors(validate.errors)}`);
  }

  const registry = structuredClone(input) as WorldObjectRegistry;
  const objectIds = new Set<string>();
  const anchors = new Set<string>();
  if (registry.objects.length !== WORLD_OBJECT_REGISTRY_CAPACITY) {
    throw new WorldObjectRegistryError(
      `World Object Registry v1 must contain exactly ${WORLD_OBJECT_REGISTRY_CAPACITY} objects`,
    );
  }
  for (const object of registry.objects) {
    if (objectIds.has(object.object_id)) {
      throw new WorldObjectRegistryError(`duplicate object_id: ${object.object_id}`);
    }
    objectIds.add(object.object_id);
    if (!object.object_id.startsWith(`${object.room_id}.`)) {
      throw new WorldObjectRegistryError(
        `object_id must be qualified by room_id: ${object.object_id}`,
      );
    }
    if (object.supported_actions[0] !== "go_to") {
      throw new WorldObjectRegistryError(`${object.object_id} must support go_to first`);
    }
    const orderedActions = [...object.supported_actions].sort(
      (left, right) => actionOrder(left) - actionOrder(right),
    );
    if (orderedActions.some((action, index) => action !== object.supported_actions[index])) {
      throw new WorldObjectRegistryError(
        `${object.object_id} supported_actions must use canonical order`,
      );
    }
    const bindingActions = Object.keys(object.animation_bindings).sort(
      (left, right) => actionOrder(left as WorldObjectAction) - actionOrder(right as WorldObjectAction),
    );
    if (
      bindingActions.length !== object.supported_actions.length
      || bindingActions.some((action, index) => action !== object.supported_actions[index])
    ) {
      throw new WorldObjectRegistryError(
        `${object.object_id} animation bindings must exactly match supported actions`,
      );
    }
    for (const action of object.supported_actions) {
      if (object.animation_bindings[action] !== ANIMATION_BY_ACTION[action]) {
        throw new WorldObjectRegistryError(
          `${object.object_id} has an invalid animation binding for ${action}`,
        );
      }
    }
    const anchorKey = `${object.room_id}:${object.anchor.art_x}:${object.anchor.floor_y}`;
    if (anchors.has(anchorKey)) {
      throw new WorldObjectRegistryError(`duplicate object anchor: ${anchorKey}`);
    }
    anchors.add(anchorKey);
  }
  return registry;
}

let cachedRegistry: WorldObjectRegistry | undefined;

function getWorldObjectRegistry(): WorldObjectRegistry {
  cachedRegistry ??= parseWorldObjectRegistry(
    readJson(`${WORLD_CONTRACT_ROOT}/object-registry.json`),
  );
  return cachedRegistry;
}

export function validateWorldObjectRegistry(input: unknown): void {
  parseWorldObjectRegistry(input);
}

export function projectWorldObjectCapabilities(
  liveAvailability: ReadonlyMap<string, boolean>,
): readonly WorldObjectCapability[] {
  if (!(liveAvailability instanceof Map)) {
    throw new WorldObjectRegistryError("live object availability must be a Map");
  }
  const registry = getWorldObjectRegistry();
  const objectIds = new Set(registry.objects.map((object) => object.object_id));
  for (const [objectId, available] of liveAvailability) {
    if (!objectIds.has(objectId)) {
      throw new WorldObjectRegistryError(`unknown live object availability: ${objectId}`);
    }
    if (typeof available !== "boolean") {
      throw new WorldObjectRegistryError(`invalid live object availability: ${objectId}`);
    }
  }
  for (const object of registry.objects) {
    if (!liveAvailability.has(object.object_id)) {
      throw new WorldObjectRegistryError(`missing live object availability: ${object.object_id}`);
    }
  }
  return getWorldObjectRegistry().objects.map((object) => ({
    object_id: object.object_id,
    room_id: object.room_id,
    supported_actions: [...object.supported_actions],
    available: liveAvailability.get(object.object_id)!,
  }));
}
