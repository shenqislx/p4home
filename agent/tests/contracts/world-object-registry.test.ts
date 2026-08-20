import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorldObjectCapabilities,
  getWorldObjectRegistry,
  parseWorldObjectRegistry,
  WorldObjectRegistryError,
} from "@p4home/contracts";

test("World Object Registry v1 exposes stable room-qualified objects", () => {
  const registry = getWorldObjectRegistry();

  assert.equal(registry.schema_version, 1);
  assert.equal(registry.registry_id, "p4home.object-registry/v1");
  assert.deepEqual(
    registry.objects.map((object) => object.object_id),
    ["living_room.sofa", "study.desk", "living_room.window"],
  );
  assert.deepEqual(registry.objects[0]?.supported_actions, [
    "go_to",
    "sit",
    "look_at",
    "interact",
  ]);
});

test("model-facing object capabilities omit anchors and animation bindings", () => {
  const capabilities = getWorldObjectCapabilities();

  assert.deepEqual(Object.keys(capabilities[0] ?? {}).sort(), [
    "available",
    "object_id",
    "room_id",
    "supported_actions",
  ]);
  assert.equal(JSON.stringify(capabilities).includes("art_x"), false);
  assert.equal(JSON.stringify(capabilities).includes("cat_sit"), false);
});

test("registry rejects duplicate ids, unqualified ids and mismatched bindings", () => {
  const duplicate = getWorldObjectRegistry();
  (duplicate.objects[1] as { object_id: string }).object_id = duplicate.objects[0]!.object_id;
  assert.throws(
    () => parseWorldObjectRegistry(duplicate),
    (error) => error instanceof WorldObjectRegistryError && /duplicate object_id/.test(error.message),
  );

  const unqualified = getWorldObjectRegistry();
  (unqualified.objects[0] as { object_id: string }).object_id = "study.sofa";
  assert.throws(
    () => parseWorldObjectRegistry(unqualified),
    (error) => error instanceof WorldObjectRegistryError && /qualified by room_id/.test(error.message),
  );

  const missingBinding = getWorldObjectRegistry();
  delete (missingBinding.objects[0]!.animation_bindings as Record<string, unknown>).sit;
  assert.throws(
    () => parseWorldObjectRegistry(missingBinding),
    (error) => error instanceof WorldObjectRegistryError && /exactly match/.test(error.message),
  );
});

test("registry getters return defensive clones", () => {
  const first = getWorldObjectRegistry();
  (first.objects[0]!.anchor as { art_x: number }).art_x = 48;

  assert.equal(getWorldObjectRegistry().objects[0]?.anchor.art_x, 10);
});
