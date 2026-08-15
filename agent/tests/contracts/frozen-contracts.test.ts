import assert from "node:assert/strict";
import test from "node:test";

import { validateFrozenContracts } from "@p4home/contracts";

test("frozen Device Protocol v1 and Tool Schema v1 load through AJV", () => {
  assert.deepEqual(validateFrozenContracts(), {
    protocolVersion: 1,
    toolSchemaVersion: 1,
    messageTypes: 14,
    validMessages: 17,
    invalidMessages: 6,
    tools: 5,
    goldenIntents: 32,
  });
});
