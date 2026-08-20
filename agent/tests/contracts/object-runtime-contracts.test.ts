import assert from "node:assert/strict";
import test from "node:test";

import {
  ObjectRuntimeContractError,
  validateObjectRuntimeContracts,
  validateObjectRuntimeDeviceMessage,
} from "@p4home/contracts";

test("Device Protocol v2 and Tool Schema v2 form a strict v1-compatible object runtime", () => {
  assert.deepEqual(validateObjectRuntimeContracts(), {
    protocolVersion: 2,
    toolSchemaVersion: 2,
    messageTypes: 14,
    validMessages: 6,
    invalidMessages: 5,
    tools: 9,
    objectActions: 4,
  });
});

test("v2 rejects execution metadata and unknown object targets", () => {
  const invalidTarget = {
    protocol_version: 2,
    message_id: "invalid-target",
    correlation_id: null,
    device_id: "p4-panel-001",
    session_id: "session-v2-001",
    seq: 0,
    sent_at_ms: 1,
    type: "action.request",
    payload: {
      action_id: "invalid-action",
      tool: "character.go_to",
      arguments: { target_id: "living_room.unknown" },
      timeout_ms: 1000,
      origin: "agent",
    },
  };
  assert.throws(
    () => validateObjectRuntimeDeviceMessage(invalidTarget),
    (error) => error instanceof ObjectRuntimeContractError,
  );

  const userOrigin = structuredClone(invalidTarget);
  userOrigin.payload.arguments.target_id = "living_room.sofa";
  userOrigin.payload.origin = "user";
  assert.throws(
    () => validateObjectRuntimeDeviceMessage(userOrigin),
    (error) => error instanceof ObjectRuntimeContractError,
  );

  const mismatchedResult = {
    ...structuredClone(invalidTarget),
    message_id: "invalid-result",
    type: "action.completed",
    payload: {
      action_id: "invalid-action",
      tool: "character.sit",
      completed_at_ms: 2,
      state_version: 2,
      result: {
        object_id: "living_room.sofa",
        action: "go_to",
        pose: "standing",
      },
    },
  };
  assert.throws(
    () => validateObjectRuntimeDeviceMessage(mismatchedResult),
    (error) => error instanceof ObjectRuntimeContractError,
  );
});
