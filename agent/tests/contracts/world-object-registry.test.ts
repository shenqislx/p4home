import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as contracts from "@p4home/contracts";
import {
  projectWorldObjectCapabilities,
  validateWorldObjectRegistry,
  WORLD_OBJECT_REGISTRY_CAPACITY,
  WorldObjectRegistryError,
} from "@p4home/contracts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY_PATH = `${REPOSITORY_ROOT}contracts/world/v1/object-registry.json`;
const OBJECT_IDS = ["living_room.sofa", "study.desk", "living_room.window"] as const;

interface MutableRegistryFixture {
  schema_version: number;
  registry_id: string;
  objects: Array<{
    object_id: string;
    supported_actions: string[];
    animation_bindings: Record<string, string>;
  }>;
}

function readRegistry(): MutableRegistryFixture {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as MutableRegistryFixture;
}

function objectAt(registry: MutableRegistryFixture, index: number) {
  const object = registry.objects[index];
  assert.ok(object);
  return object;
}

function liveAvailability(
  overrides: Readonly<Record<string, boolean>> = {},
): Map<string, boolean> {
  return new Map(
    OBJECT_IDS.map((objectId) => [objectId, overrides[objectId] ?? true]),
  );
}

test("World Object Registry v1 validates the frozen room-qualified objects", () => {
  const registry = readRegistry();

  assert.doesNotThrow(() => validateWorldObjectRegistry(registry));
  assert.equal(registry.schema_version, 1);
  assert.equal(registry.registry_id, "p4home.object-registry/v1");
  assert.equal(registry.objects.length, WORLD_OBJECT_REGISTRY_CAPACITY);
  assert.deepEqual(
    registry.objects.map((object: { object_id: string }) => object.object_id),
    OBJECT_IDS,
  );
  assert.deepEqual(registry.objects[0]?.supported_actions, [
    "go_to",
    "sit",
    "look_at",
    "interact",
  ]);
});

test("model-facing capabilities use live availability and omit execution metadata", () => {
  const capabilities = projectWorldObjectCapabilities(
    liveAvailability({ "living_room.sofa": false }),
  );

  assert.equal(capabilities[0]?.available, false);
  assert.equal(capabilities[1]?.available, true);
  assert.deepEqual(Object.keys(capabilities[0] ?? {}).sort(), [
    "available",
    "object_id",
    "room_id",
    "supported_actions",
  ]);
  assert.equal(JSON.stringify(capabilities).includes("art_x"), false);
  assert.equal(JSON.stringify(capabilities).includes("cat_sit"), false);
  assert.equal("getWorldObjectRegistry" in contracts, false);
  assert.equal("parseWorldObjectRegistry" in contracts, false);
});

test("capability projection requires a complete and valid live availability map", () => {
  assert.throws(
    () => projectWorldObjectCapabilities(new Map()),
    (error) =>
      error instanceof WorldObjectRegistryError &&
      /missing live object availability/.test(error.message),
  );

  const unknown = liveAvailability();
  unknown.set("living_room.unknown", true);
  assert.throws(
    () => projectWorldObjectCapabilities(unknown),
    (error) =>
      error instanceof WorldObjectRegistryError &&
      /unknown live object availability/.test(error.message),
  );

  const invalid = liveAvailability() as Map<string, unknown>;
  invalid.set("study.desk", "yes");
  assert.throws(
    () => projectWorldObjectCapabilities(invalid as ReadonlyMap<string, boolean>),
    (error) =>
      error instanceof WorldObjectRegistryError &&
      /invalid live object availability/.test(error.message),
  );

  assert.throws(
    () =>
      projectWorldObjectCapabilities(
        { "living_room.sofa": true } as unknown as ReadonlyMap<string, boolean>,
      ),
    (error) =>
      error instanceof WorldObjectRegistryError && /must be a Map/.test(error.message),
  );
});

test("registry rejects invalid ids, capacity and animation bindings", () => {
  const duplicate = readRegistry();
  objectAt(duplicate, 1).object_id = objectAt(duplicate, 0).object_id;
  assert.throws(
    () => validateWorldObjectRegistry(duplicate),
    (error) => error instanceof WorldObjectRegistryError && /duplicate object_id/.test(error.message),
  );

  const unqualified = readRegistry();
  objectAt(unqualified, 0).object_id = "study.sofa";
  assert.throws(
    () => validateWorldObjectRegistry(unqualified),
    (error) => error instanceof WorldObjectRegistryError && /qualified by room_id/.test(error.message),
  );

  const missingBinding = readRegistry();
  delete objectAt(missingBinding, 0).animation_bindings.sit;
  assert.throws(
    () => validateWorldObjectRegistry(missingBinding),
    (error) => error instanceof WorldObjectRegistryError && /exactly match/.test(error.message),
  );

  const wrongBinding = readRegistry();
  objectAt(wrongBinding, 0).animation_bindings.sit = "cat_walk";
  assert.throws(
    () => validateWorldObjectRegistry(wrongBinding),
    (error) => error instanceof WorldObjectRegistryError,
  );

  const tooMany = readRegistry();
  tooMany.objects.push(structuredClone(objectAt(tooMany, 0)));
  assert.throws(
    () => validateWorldObjectRegistry(tooMany),
    (error) => error instanceof WorldObjectRegistryError,
  );
});

test("capability projections are defensive copies", () => {
  const availability = liveAvailability();
  const first = projectWorldObjectCapabilities(availability);
  (first[0]?.supported_actions as string[]).splice(0);
  (first[0] as { available: boolean }).available = false;

  const second = projectWorldObjectCapabilities(availability);
  assert.deepEqual(second[0]?.supported_actions, ["go_to", "sit", "look_at", "interact"]);
  assert.equal(second[0]?.available, true);
});
