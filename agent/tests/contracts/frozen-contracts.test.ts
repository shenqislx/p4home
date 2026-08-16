import assert from "node:assert/strict";
import test from "node:test";

import {
  ContractBoundaryError,
  getFrozenToolDefinitions,
  parseStructuredOutput,
  validateFrozenContracts,
  validateFrozenToolCalls,
} from "@p4home/contracts";

function assertBoundaryError(error: unknown, code: ContractBoundaryError["code"]): boolean {
  assert.ok(error instanceof ContractBoundaryError);
  assert.equal(error.code, code);
  return true;
}

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

test("frozen tool definitions preserve the model-facing catalog", () => {
  const tools = getFrozenToolDefinitions();

  assert.equal(tools.length, 5);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "character.get_state",
      "character.go_to_room",
      "character.set_activity",
      "character.say",
      "world.get_snapshot",
    ],
  );
  assert.equal(tools[1]?.description, "让角色移动到一个已注册房间的站立点。");
  assert.deepEqual(tools[1]?.parameters.required, ["room_id"]);
});

test("tool-call boundary accepts exact v1 arguments and clones them", () => {
  const argumentsValue = { room_id: "study" };
  const calls = validateFrozenToolCalls([
    { name: "character.go_to_room", arguments: argumentsValue },
  ]);

  argumentsValue.room_id = "kitchen";
  assert.deepEqual(calls, [
    { name: "character.go_to_room", arguments: { room_id: "study" } },
  ]);
});

test("tool-call boundary rejects unknown, malformed and excessive calls", () => {
  assert.throws(
    () => validateFrozenToolCalls([{ name: "shell.exec", arguments: {} }]),
    (error) => assertBoundaryError(error, "UNKNOWN_TOOL"),
  );
  assert.throws(
    () =>
      validateFrozenToolCalls([
        { name: "character.go_to_room", arguments: { room_id: "garage" } },
      ]),
    (error) => assertBoundaryError(error, "INVALID_TOOL_ARGUMENTS"),
  );
  assert.throws(
    () =>
      validateFrozenToolCalls(
        Array.from({ length: 5 }, () => ({ name: "character.get_state", arguments: {} })),
      ),
    (error) => assertBoundaryError(error, "TOO_MANY_TOOL_CALLS"),
  );
});

test("structured output is parsed and revalidated locally", () => {
  const schema = {
    type: "object",
    required: ["intent", "confidence"],
    properties: {
      intent: { enum: ["move", "speak"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  } as const;

  assert.deepEqual(
    parseStructuredOutput(schema, '{"intent":"move","confidence":0.9}'),
    { intent: "move", confidence: 0.9 },
  );
  assert.throws(
    () => parseStructuredOutput(schema, "not-json"),
    (error) => assertBoundaryError(error, "INVALID_STRUCTURED_JSON"),
  );
  assert.throws(
    () => parseStructuredOutput(schema, '{"intent":"move","confidence":2}'),
    (error) => assertBoundaryError(error, "INVALID_STRUCTURED_OUTPUT"),
  );
});
