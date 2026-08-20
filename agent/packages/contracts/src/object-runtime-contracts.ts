import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEVICE_V1_ROOT = `${REPOSITORY_ROOT}contracts/device-protocol/v1`;
const DEVICE_V2_ROOT = `${REPOSITORY_ROOT}contracts/device-protocol/v2`;
const TOOLS_V1_ROOT = `${REPOSITORY_ROOT}contracts/tools/v1`;
const TOOLS_V2_ROOT = `${REPOSITORY_ROOT}contracts/tools/v2`;
const WORLD_ROOT = `${REPOSITORY_ROOT}contracts/world/v1`;

const OBJECT_TOOL_NAMES = [
  "character.go_to",
  "character.sit",
  "character.look_at",
  "character.interact",
] as const;
const ACTION_BY_TOOL: Readonly<Record<(typeof OBJECT_TOOL_NAMES)[number], string>> = {
  "character.go_to": "go_to",
  "character.sit": "sit",
  "character.look_at": "look_at",
  "character.interact": "interact",
};
const RESULT_REF_BY_TOOL: Readonly<Record<(typeof OBJECT_TOOL_NAMES)[number], string>> = {
  "character.go_to": "tool-result.schema.json#/$defs/goToObjectResult",
  "character.sit": "tool-result.schema.json#/$defs/sitObjectResult",
  "character.look_at": "tool-result.schema.json#/$defs/lookAtObjectResult",
  "character.interact": "tool-result.schema.json#/$defs/interactObjectResult",
};
const FORBIDDEN_MODEL_METADATA = [
  '"anchor"',
  '"art_x"',
  '"floor_y"',
  '"facing"',
  '"animation_bindings"',
  '"default_available"',
] as const;

interface ToolCatalog {
  readonly schema_version: number;
  readonly tools: readonly {
    readonly name: string;
    readonly result_schema_ref: string;
    readonly parameters: AnySchema;
  }[];
}

interface ObjectRegistry {
  readonly objects: readonly {
    readonly object_id: string;
    readonly room_id: string;
    readonly supported_actions: readonly string[];
    readonly default_available: boolean;
  }[];
}

interface InvalidFixture {
  readonly name: string;
  readonly message: unknown;
}

interface InvalidToolResultFixture {
  readonly name: string;
  readonly result: unknown;
}

export interface ObjectRuntimeDeviceMessage {
  readonly protocol_version: 2;
  readonly message_id: string;
  readonly correlation_id: string | null;
  readonly device_id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly sent_at_ms: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface ObjectRuntimeToolResult {
  readonly schema_version: 2;
  readonly tool_call_id: string;
  readonly name: string;
  readonly status: "success" | "error";
  readonly result: Record<string, unknown> | null;
  readonly error: Record<string, unknown> | null;
}

export interface ObjectRuntimeContractReport {
  readonly protocolVersion: 2;
  readonly toolSchemaVersion: 2;
  readonly messageTypes: 14;
  readonly validMessages: number;
  readonly invalidMessages: number;
  readonly validToolResults: number;
  readonly invalidToolResults: number;
  readonly tools: 9;
  readonly objectActions: 4;
}

export class ObjectRuntimeContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ObjectRuntimeContractError";
  }
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ObjectRuntimeContractError(`failed to read object runtime contract: ${detail}`);
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

function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
}

let objectRuntimeMessageValidator: ValidateFunction | undefined;
let objectRuntimeToolResultValidator: ValidateFunction | undefined;

function getObjectRuntimeMessageValidator(): ValidateFunction {
  if (objectRuntimeMessageValidator !== undefined) {
    return objectRuntimeMessageValidator;
  }
  const ajv = createAjv();
  ajv.addSchema(readJson<AnySchema>(`${DEVICE_V1_ROOT}/messages/payloads.schema.json`));
  ajv.addSchema(readJson<AnySchema>(`${DEVICE_V2_ROOT}/envelope.schema.json`));
  ajv.addSchema(readJson<AnySchema>(`${DEVICE_V2_ROOT}/messages/payloads.schema.json`));
  objectRuntimeMessageValidator = ajv.compile(
    readJson<AnySchema>(`${DEVICE_V2_ROOT}/message.schema.json`),
  );
  return objectRuntimeMessageValidator;
}

function getObjectRuntimeToolResultValidator(): ValidateFunction {
  if (objectRuntimeToolResultValidator === undefined) {
    objectRuntimeToolResultValidator = createAjv().compile(
      readJson<AnySchema>(`${TOOLS_V2_ROOT}/tool-result.schema.json`),
    );
  }
  return objectRuntimeToolResultValidator;
}

function assertObjectList(
  objects: unknown,
  capabilities: boolean,
): void {
  const registry = readJson<ObjectRegistry>(`${WORLD_ROOT}/object-registry.json`);
  if (!Array.isArray(objects) || objects.length !== registry.objects.length) {
    throw new ObjectRuntimeContractError("v2 object list must match registry capacity");
  }
  for (const [index, expected] of registry.objects.entries()) {
    const actual = objects[index] as Record<string, unknown> | undefined;
    if (actual?.object_id !== expected.object_id || actual.room_id !== expected.room_id) {
      throw new ObjectRuntimeContractError("v2 object list order or room drifted from registry");
    }
    if (capabilities &&
        JSON.stringify(actual.supported_actions) !== JSON.stringify(expected.supported_actions)) {
      throw new ObjectRuntimeContractError("v2 object capabilities drifted from registry actions");
    }
  }
}

function assertCharacterSemantics(character: unknown): void {
  const registry = readJson<ObjectRegistry>(`${WORLD_ROOT}/object-registry.json`);
  const actual = character as Record<string, unknown>;
  const targetId = actual.target_object_id;
  if (targetId === null) {
    if (actual.pose !== "standing") {
      throw new ObjectRuntimeContractError("a character without a target must be standing");
    }
    return;
  }
  const target = registry.objects.find((object) => object.object_id === targetId);
  if (target === undefined || actual.room_id !== target.room_id) {
    throw new ObjectRuntimeContractError("character target and room drifted from the registry");
  }
  if (actual.pose === "sitting" && !target.supported_actions.includes("sit")) {
    throw new ObjectRuntimeContractError("character is sitting at an object without sit support");
  }
}

function assertRuntimeSnapshot(payload: Record<string, unknown>): void {
  assertObjectList(payload.objects, false);
  assertCharacterSemantics(payload.character);
  const character = payload.character as Record<string, unknown>;
  const targetId = character.target_object_id;
  if (targetId === null) {
    return;
  }
  const objects = payload.objects as readonly Record<string, unknown>[];
  const target = objects.find((object) => object.object_id === targetId);
  const sitting = character.pose === "sitting";
  if (target?.available !== true) {
    throw new ObjectRuntimeContractError("character target must remain available");
  }
  if (target.occupied !== sitting) {
    throw new ObjectRuntimeContractError(
      "target occupancy must match the authoritative character pose",
    );
  }
}

function assertMessageSemantics(message: ObjectRuntimeDeviceMessage): void {
  const payload = message.payload;
  if (message.type === "device.capabilities") {
    assertObjectList(payload.objects, true);
  } else if (message.type === "world.snapshot" || message.type === "world.changed") {
    assertRuntimeSnapshot(payload);
  } else if (message.type === "action.completed" && payload.tool === "world.get_snapshot") {
    const result = payload.result as Record<string, unknown> | undefined;
    assertRuntimeSnapshot(result ?? {});
  } else if (message.type === "action.completed" && payload.tool === "character.get_state") {
    assertCharacterSemantics(payload.result);
  }
}

export function validateObjectRuntimeDeviceMessage<T extends ObjectRuntimeDeviceMessage>(
  message: unknown,
): T {
  const validate = getObjectRuntimeMessageValidator();
  if (!validate(message)) {
    throw new ObjectRuntimeContractError(
      `Device Protocol v2 message: ${formatErrors(validate.errors)}`,
    );
  }
  const cloned = structuredClone(message) as T;
  assertMessageSemantics(cloned);
  return cloned;
}

export function validateObjectRuntimeToolResult<T extends ObjectRuntimeToolResult>(
  result: unknown,
): T {
  const validate = getObjectRuntimeToolResultValidator();
  if (!validate(result)) {
    throw new ObjectRuntimeContractError(
      `Tool Schema v2 result: ${formatErrors(validate.errors)}`,
    );
  }
  const cloned = structuredClone(result) as T;
  if (cloned.status === "success" && cloned.name === "world.get_snapshot") {
    assertRuntimeSnapshot(cloned.result ?? {});
  } else if (cloned.status === "success" && cloned.name === "character.get_state") {
    assertCharacterSemantics(cloned.result);
  }
  return cloned;
}

function assertModelBoundary(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_MODEL_METADATA) {
    if (serialized.includes(forbidden)) {
      throw new ObjectRuntimeContractError(`${label} exposes forbidden metadata: ${forbidden}`);
    }
  }
}

export function validateObjectRuntimeContracts(): ObjectRuntimeContractReport {
  const protocolReadme = readFileSync(`${DEVICE_V2_ROOT}/README.md`, "utf8");
  const toolsReadme = readFileSync(`${TOOLS_V2_ROOT}/README.md`, "utf8");
  if (!protocolReadme.includes("Status: candidate for Phase 3B") ||
      !toolsReadme.includes("Status: candidate for Phase 3B")) {
    throw new ObjectRuntimeContractError("object runtime v2 contracts are not marked Phase 3B");
  }

  const validMessages = readJson<unknown[]>(
    `${DEVICE_V2_ROOT}/examples/valid/object-runtime.json`,
  );
  const invalidMessages = readJson<InvalidFixture[]>(
    `${DEVICE_V2_ROOT}/examples/invalid/object-runtime.json`,
  );
  const validToolResults = readJson<unknown[]>(
    `${TOOLS_V2_ROOT}/examples/valid/results.json`,
  );
  const invalidToolResults = readJson<InvalidToolResultFixture[]>(
    `${TOOLS_V2_ROOT}/examples/invalid/results.json`,
  );
  for (const [index, message] of validMessages.entries()) {
    try {
      validateObjectRuntimeDeviceMessage(message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ObjectRuntimeContractError(`valid v2 message ${index} failed: ${detail}`);
    }
  }
  for (const fixture of invalidMessages) {
    let rejected = false;
    try {
      validateObjectRuntimeDeviceMessage(fixture.message);
    } catch (error) {
      if (!(error instanceof ObjectRuntimeContractError)) {
        throw error;
      }
      rejected = true;
    }
    if (fixture.name.trim().length === 0 || !rejected) {
      throw new ObjectRuntimeContractError(
        `invalid v2 fixture unexpectedly passed: ${fixture.name}`,
      );
    }
  }
  for (const [index, result] of validToolResults.entries()) {
    try {
      validateObjectRuntimeToolResult(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ObjectRuntimeContractError(`valid v2 tool result ${index} failed: ${detail}`);
    }
  }
  for (const fixture of invalidToolResults) {
    let rejected = false;
    try {
      validateObjectRuntimeToolResult(fixture.result);
    } catch (error) {
      if (!(error instanceof ObjectRuntimeContractError)) {
        throw error;
      }
      rejected = true;
    }
    if (fixture.name.trim().length === 0 || !rejected) {
      throw new ObjectRuntimeContractError(
        `invalid v2 tool result unexpectedly passed: ${fixture.name}`,
      );
    }
  }

  const v1Catalog = readJson<ToolCatalog>(`${TOOLS_V1_ROOT}/tool-catalog.json`);
  const v2Catalog = readJson<ToolCatalog>(`${TOOLS_V2_ROOT}/tool-catalog.json`);
  const v1Names = v1Catalog.tools.map((tool) => tool.name);
  const v2Names = v2Catalog.tools.map((tool) => tool.name);
  if (v2Catalog.schema_version !== 2 || v2Names.length !== 9 ||
      v1Names.some((name, index) => v2Names[index] !== name) ||
      OBJECT_TOOL_NAMES.some((name, index) => v2Names[v1Names.length + index] !== name)) {
    throw new ObjectRuntimeContractError("Tool Schema v2 is not the exact v1-compatible superset");
  }

  const registry = readJson<ObjectRegistry>(`${WORLD_ROOT}/object-registry.json`);
  const ajv = createAjv();
  for (const tool of v2Catalog.tools) {
    ajv.compile(tool.parameters);
    if (OBJECT_TOOL_NAMES.includes(tool.name as (typeof OBJECT_TOOL_NAMES)[number])) {
      const objectTool = tool.name as (typeof OBJECT_TOOL_NAMES)[number];
      const targetEnum = (tool.parameters as {
        properties?: { target_id?: { enum?: unknown[] } };
      }).properties?.target_id?.enum;
      const expectedTargets = registry.objects
        .filter((object) => object.supported_actions.includes(ACTION_BY_TOOL[objectTool]))
        .map((object) => object.object_id);
      if (JSON.stringify(targetEnum) !== JSON.stringify(expectedTargets)) {
        throw new ObjectRuntimeContractError(`${tool.name} target IDs drifted from the registry`);
      }
      if (tool.result_schema_ref !== RESULT_REF_BY_TOOL[objectTool]) {
        throw new ObjectRuntimeContractError(`${tool.name} result schema is not action-specific`);
      }
    }
  }
  getObjectRuntimeToolResultValidator();

  const capabilities = (validMessages.find((message) =>
    (message as { type?: unknown }).type === "device.capabilities") as {
      payload?: { objects?: unknown };
    } | undefined)?.payload?.objects;
  const expectedCapabilities = registry.objects.map((object) => ({
    object_id: object.object_id,
    room_id: object.room_id,
    supported_actions: object.supported_actions,
    available: object.default_available,
  }));
  if (JSON.stringify(capabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new ObjectRuntimeContractError("v2 capabilities drifted from World Object Registry v1");
  }
  assertModelBoundary(v2Catalog, "Tool Schema v2");
  assertModelBoundary(capabilities, "Device Protocol v2 capabilities");

  const envelope = readJson<{
    properties?: { type?: { enum?: unknown[] } };
  }>(`${DEVICE_V2_ROOT}/envelope.schema.json`);
  if (envelope.properties?.type?.enum?.length !== 14) {
    throw new ObjectRuntimeContractError("Device Protocol v2 message type set drifted from v1");
  }
  return {
    protocolVersion: 2,
    toolSchemaVersion: 2,
    messageTypes: 14,
    validMessages: validMessages.length,
    invalidMessages: invalidMessages.length,
    validToolResults: validToolResults.length,
    invalidToolResults: invalidToolResults.length,
    tools: 9,
    objectActions: 4,
  };
}
