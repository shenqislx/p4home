import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HaRuntimeContractError,
  projectRobotHaCapabilities,
  validateHaRuntimeContracts,
  validateRobotHaPolicy,
  type RobotHaPolicy,
} from "@p4home/contracts";

const VALID_POLICY_PATH = new URL(
  "../../../contracts/home-assistant/v1/examples/valid/policy.json",
  import.meta.url,
);

function validPolicy(): RobotHaPolicy {
  return JSON.parse(readFileSync(VALID_POLICY_PATH, "utf8")) as RobotHaPolicy;
}

test("Robot HA v1 contract freezes aliases without exposing arbitrary service data", () => {
  assert.deepEqual(validateHaRuntimeContracts(), {
    policySchemaVersion: 1,
    toolSchemaVersion: 1,
    validPolicies: 1,
    invalidPolicies: 7,
    tools: 4,
    allowedDomains: 6,
  });
  const policy = validateRobotHaPolicy(validPolicy());
  const capabilities = projectRobotHaCapabilities(policy);
  assert.deepEqual(capabilities, [
    {
      alias: "living_room_main_light",
      domain: "light",
      readable: true,
      write_actions: ["turn_on", "turn_off"],
    },
    {
      alias: "study_temperature",
      domain: "sensor",
      readable: true,
      write_actions: [],
    },
  ]);
  const serialized = JSON.stringify(capabilities);
  assert.equal(serialized.includes("entity_id"), false);
  assert.equal(serialized.includes("example_living_room_main"), false);
  assert.equal(serialized.includes("projected_attributes"), false);
});

test("Robot HA policy semantics reject duplicate targets, unsafe writes, and ordering drift", () => {
  const base = validPolicy();
  const mutations: unknown[] = [
    {
      ...base,
      entities: [base.entities[0], { ...base.entities[1], alias: base.entities[0]!.alias }],
    },
    {
      ...base,
      entities: [base.entities[0], { ...base.entities[1], entity_id: base.entities[0]!.entity_id }],
    },
    {
      ...base,
      entities: [{ ...base.entities[0], domain: "switch" }],
    },
    {
      ...base,
      entities: [{ ...base.entities[1], write_actions: ["turn_on"] }],
    },
    {
      ...base,
      entities: [{ ...base.entities[0], projected_attributes: ["current_temperature"] }],
    },
    {
      ...base,
      entities: [...base.entities].reverse(),
    },
    {
      ...base,
      entities: [{
        ...base.entities[0],
        entity_id: "lock.front_door",
        domain: "lock",
      }],
    },
  ];
  for (const mutation of mutations) {
    assert.throws(() => validateRobotHaPolicy(mutation), HaRuntimeContractError);
  }
});

test("validated Robot HA policies are defensive clones", () => {
  const source = validPolicy() as unknown as {
    entities: { alias: string; write_actions: string[] }[];
  };
  const validated = validateRobotHaPolicy(source);
  source.entities[0]!.alias = "mutated_alias";
  source.entities[0]!.write_actions.length = 0;
  assert.equal(validated.entities[0]?.alias, "living_room_main_light");
  assert.deepEqual(validated.entities[0]?.write_actions, ["turn_on", "turn_off"]);
});
