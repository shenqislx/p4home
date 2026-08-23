import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

export * from "./world-object-registry.ts";
export * from "./object-runtime-contracts.ts";
export * from "./ha-runtime-contracts.ts";
export * from "./voice-protocol.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEVICE_PROTOCOL_ROOT = `${REPOSITORY_ROOT}contracts/device-protocol/v1`;
const TOOL_SCHEMA_ROOT = `${REPOSITORY_ROOT}contracts/tools/v1`;

interface InvalidFixture {
  readonly name: string;
  readonly expected_error: string;
  readonly expected_validation: {
    readonly instance_path: string;
    readonly keyword: string;
  };
  readonly message: Record<string, unknown>;
  readonly fixture_mutation?: string;
}

const INVALID_FIXTURE_ERROR_CODES = new Set([
  "INVALID_ARGUMENT",
  "INVALID_MESSAGE",
  "UNKNOWN_ROOM",
  "UNSUPPORTED_TOOL",
  "UNSUPPORTED_VERSION",
]);

export interface GoldenIntent {
  readonly id: string;
  readonly text: string;
  readonly expected: readonly {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }[];
  readonly no_tool?: {
    readonly code: string;
    readonly reason: string;
  };
}

interface ToolCatalog {
  readonly schema_version: number;
  readonly execution_policy: {
    readonly max_calls_per_turn: number;
  };
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: AnySchema;
  }[];
}

export interface FrozenToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface FrozenToolCallInput {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type FrozenDeviceMessageType =
  | "device.hello"
  | "device.capabilities"
  | "world.snapshot"
  | "world.changed"
  | "world.resync.request"
  | "user.text"
  | "action.request"
  | "action.accepted"
  | "action.started"
  | "action.completed"
  | "action.failed"
  | "action.cancel"
  | "heartbeat"
  | "error";

export interface FrozenDeviceMessage<
  TType extends FrozenDeviceMessageType = FrozenDeviceMessageType,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly protocol_version: 1;
  readonly message_id: string;
  readonly correlation_id: string | null;
  readonly device_id: string;
  readonly session_id: string;
  readonly seq: number;
  readonly sent_at_ms: number;
  readonly type: TType;
  readonly payload: TPayload;
}

export type ContractBoundaryErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_ARGUMENTS"
  | "INVALID_TOOL_RESULT"
  | "INVALID_DEVICE_MESSAGE"
  | "TOO_MANY_TOOL_CALLS"
  | "INVALID_STRUCTURED_JSON"
  | "INVALID_STRUCTURED_OUTPUT";

export class ContractBoundaryError extends Error {
  public readonly code: ContractBoundaryErrorCode;

  public constructor(code: ContractBoundaryErrorCode, message: string) {
    super(message);
    this.name = "ContractBoundaryError";
    this.code = code;
  }
}

export interface ContractValidationReport {
  readonly protocolVersion: 1;
  readonly toolSchemaVersion: 1;
  readonly messageTypes: number;
  readonly validMessages: number;
  readonly invalidMessages: number;
  readonly tools: number;
  readonly goldenIntents: number;
}

export class FrozenContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FrozenContractError";
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
}

function readToolCatalog(): ToolCatalog {
  return readJson<ToolCatalog>(`${TOOL_SCHEMA_ROOT}/tool-catalog.json`);
}

function assertFrozenToolCatalog(catalog: ToolCatalog): void {
  const toolsReadme = readFileSync(`${TOOL_SCHEMA_ROOT}/README.md`, "utf8");
  if (!toolsReadme.includes("> Status: frozen") || catalog.schema_version !== 1) {
    throw new FrozenContractError("runtime may import only frozen Tool Schema v1");
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

function assertValid(
  validate: ValidateFunction,
  value: unknown,
  label: string,
): void {
  if (!validate(value)) {
    throw new FrozenContractError(`${label}: ${formatErrors(validate.errors)}`);
  }
}

let frozenDeviceMessageValidator: ValidateFunction | undefined;

function getFrozenDeviceMessageValidator(): ValidateFunction {
  if (frozenDeviceMessageValidator !== undefined) {
    return frozenDeviceMessageValidator;
  }
  const ajv = createAjv();
  ajv.addSchema(readJson<AnySchema>(`${DEVICE_PROTOCOL_ROOT}/envelope.schema.json`));
  ajv.addSchema(readJson<AnySchema>(`${DEVICE_PROTOCOL_ROOT}/messages/payloads.schema.json`));
  frozenDeviceMessageValidator = ajv.compile(
    readJson<AnySchema>(`${DEVICE_PROTOCOL_ROOT}/message.schema.json`),
  );
  return frozenDeviceMessageValidator;
}

export function validateFrozenDeviceMessage<T extends FrozenDeviceMessage>(message: unknown): T {
  const validate = getFrozenDeviceMessageValidator();
  if (!validate(message)) {
    throw new ContractBoundaryError(
      "INVALID_DEVICE_MESSAGE",
      `Device Protocol v1 message: ${formatErrors(validate.errors)}`,
    );
  }
  return structuredClone(message) as T;
}

function mutateInvalidFixture(fixture: InvalidFixture): Record<string, unknown> {
  const message = structuredClone(fixture.message);
  if (fixture.fixture_mutation === undefined) {
    return message;
  }
  if (fixture.fixture_mutation !== "repeat payload.arguments.text 20 times before validation") {
    throw new FrozenContractError(`unsupported invalid fixture mutation: ${fixture.fixture_mutation}`);
  }
  const payload = message.payload as Record<string, unknown>;
  const argumentsValue = payload.arguments as Record<string, unknown>;
  argumentsValue.text = String(argumentsValue.text).repeat(20);
  return message;
}

export function validateFrozenContracts(): ContractValidationReport {
  const protocolReadme = readFileSync(`${DEVICE_PROTOCOL_ROOT}/README.md`, "utf8");
  const toolsReadme = readFileSync(`${TOOL_SCHEMA_ROOT}/README.md`, "utf8");
  if (!protocolReadme.includes("> Status: frozen") || !toolsReadme.includes("> Status: frozen")) {
    throw new FrozenContractError("runtime may import only frozen protocol and tool contracts");
  }

  const envelope = readJson<AnySchema>(`${DEVICE_PROTOCOL_ROOT}/envelope.schema.json`);
  const payloads = readJson<AnySchema>(`${DEVICE_PROTOCOL_ROOT}/messages/payloads.schema.json`);
  const messageSchema = readJson<AnySchema>(`${DEVICE_PROTOCOL_ROOT}/message.schema.json`);
  const toolResultSchema = readJson<AnySchema>(`${TOOL_SCHEMA_ROOT}/tool-result.schema.json`);
  const validMessages = readJson<unknown[]>(`${DEVICE_PROTOCOL_ROOT}/examples/valid/messages.json`);
  const invalidMessages = readJson<InvalidFixture[]>(`${DEVICE_PROTOCOL_ROOT}/examples/invalid/messages.json`);
  const toolCatalog = readToolCatalog();
  const goldenIntents = readJson<GoldenIntent[]>(`${TOOL_SCHEMA_ROOT}/fixtures/golden-intents.json`);

  const ajv = createAjv();
  ajv.addSchema(envelope);
  ajv.addSchema(payloads);
  const validateMessage = ajv.compile(messageSchema);
  ajv.compile(toolResultSchema);

  for (const [index, message] of validMessages.entries()) {
    assertValid(validateMessage, message, `valid message fixture ${index}`);
  }
  for (const fixture of invalidMessages) {
    const expectedValidation = fixture.expected_validation;
    if (
      typeof fixture.name !== "string"
      || fixture.name.trim().length === 0
      || typeof fixture.expected_error !== "string"
      || !INVALID_FIXTURE_ERROR_CODES.has(fixture.expected_error)
      || expectedValidation === null
      || typeof expectedValidation !== "object"
      || typeof expectedValidation.instance_path !== "string"
      || typeof expectedValidation.keyword !== "string"
      || expectedValidation.keyword.trim().length === 0
    ) {
      throw new FrozenContractError(`invalid fixture metadata is incomplete: ${fixture.name}`);
    }
    if (validateMessage(mutateInvalidFixture(fixture))) {
      throw new FrozenContractError(`invalid fixture unexpectedly passed: ${fixture.name}`);
    }
    const expectedFailure = validateMessage.errors?.some((error) =>
      error.instancePath === expectedValidation.instance_path
      && error.keyword === expectedValidation.keyword
    ) === true;
    if (!expectedFailure) {
      throw new FrozenContractError(
        `invalid fixture failed for the wrong reason: ${fixture.name} (${fixture.expected_error})`,
      );
    }
  }

  const toolValidators = new Map<string, ValidateFunction>();
  for (const tool of toolCatalog.tools) {
    if (toolValidators.has(tool.name)) {
      throw new FrozenContractError(`duplicate frozen tool definition: ${tool.name}`);
    }
    toolValidators.set(tool.name, ajv.compile(tool.parameters));
  }
  const fixtureNames = invalidMessages.map((fixture) => fixture.name);
  if (new Set(fixtureNames).size !== fixtureNames.length) {
    throw new FrozenContractError("invalid message fixture names must be unique");
  }
  const goldenIds = new Set<string>();
  for (const scenario of goldenIntents) {
    if (
      typeof scenario.id !== "string"
      || scenario.id.trim().length === 0
      || typeof scenario.text !== "string"
      || scenario.text.trim().length === 0
      || goldenIds.has(scenario.id)
      || !Array.isArray(scenario.expected)
    ) {
      throw new FrozenContractError(`golden intent id/text is empty or duplicated: ${scenario.id}`);
    }
    goldenIds.add(scenario.id);
    if (scenario.expected.length === 0 && scenario.no_tool === undefined) {
      throw new FrozenContractError(`golden intent ${scenario.id} lacks no_tool outcome`);
    }
    if (scenario.expected.length > 0 && scenario.no_tool !== undefined) {
      throw new FrozenContractError(`golden intent ${scenario.id} mixes tool and no_tool outcomes`);
    }
    if (scenario.expected.length > toolCatalog.execution_policy.max_calls_per_turn) {
      throw new FrozenContractError(`golden intent ${scenario.id} exceeds the per-turn call limit`);
    }
    if (
      scenario.no_tool !== undefined
      && (scenario.no_tool.code.trim().length === 0 || scenario.no_tool.reason.trim().length === 0)
    ) {
      throw new FrozenContractError(`golden intent ${scenario.id} has an incomplete no_tool outcome`);
    }
    for (const call of scenario.expected) {
      const validator = toolValidators.get(call.name);
      if (validator === undefined) {
        throw new FrozenContractError(`golden intent ${scenario.id} uses unknown tool ${call.name}`);
      }
      assertValid(validator, call.arguments, `golden intent ${scenario.id}`);
    }
  }

  const messageTypes = (envelope as { properties?: { type?: { enum?: unknown[] } } })
    .properties?.type?.enum?.length;
  if (messageTypes === undefined) {
    throw new FrozenContractError("envelope does not expose message type enum");
  }
  if (toolCatalog.schema_version !== 1 || goldenIntents.length < 32) {
    throw new FrozenContractError("Tool Schema v1 catalog or golden intent baseline drifted");
  }

  return {
    protocolVersion: 1,
    toolSchemaVersion: 1,
    messageTypes,
    validMessages: validMessages.length,
    invalidMessages: invalidMessages.length,
    tools: toolCatalog.tools.length,
    goldenIntents: goldenIntents.length,
  };
}

export function getFrozenToolDefinitions(): readonly FrozenToolDefinition[] {
  const catalog = readToolCatalog();
  assertFrozenToolCatalog(catalog);
  return catalog.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as Record<string, unknown>,
  }));
}

export function getFrozenGoldenIntents(): readonly GoldenIntent[] {
  validateFrozenContracts();
  return structuredClone(
    readJson<GoldenIntent[]>(`${TOOL_SCHEMA_ROOT}/fixtures/golden-intents.json`),
  );
}

export function validateFrozenToolCalls(
  calls: readonly FrozenToolCallInput[],
): readonly FrozenToolCallInput[] {
  const catalog = readToolCatalog();
  assertFrozenToolCatalog(catalog);
  if (calls.length > catalog.execution_policy.max_calls_per_turn) {
    throw new ContractBoundaryError(
      "TOO_MANY_TOOL_CALLS",
      `Tool Schema v1 allows at most ${catalog.execution_policy.max_calls_per_turn} calls per turn`,
    );
  }
  const ajv = createAjv();
  const validators = new Map(
    catalog.tools.map((tool) => [tool.name, ajv.compile(tool.parameters)] as const),
  );
  return calls.map((call) => {
    const validator = validators.get(call.name);
    if (validator === undefined) {
      throw new ContractBoundaryError("UNKNOWN_TOOL", `tool ${call.name} is not in Tool Schema v1`);
    }
    if (!validator(call.arguments)) {
      throw new ContractBoundaryError(
        "INVALID_TOOL_ARGUMENTS",
        `${call.name}: ${formatErrors(validator.errors)}`,
      );
    }
    return { name: call.name, arguments: structuredClone(call.arguments) };
  });
}

export function validateFrozenToolResult<T>(result: T): T {
  const schema = readJson<AnySchema>(`${TOOL_SCHEMA_ROOT}/tool-result.schema.json`);
  const validate = createAjv().compile(schema);
  if (!validate(result)) {
    throw new ContractBoundaryError(
      "INVALID_TOOL_RESULT",
      `Tool Schema v1 result: ${formatErrors(validate.errors)}`,
    );
  }
  return structuredClone(result);
}

export function parseStructuredOutput<T = unknown>(
  schema: Readonly<Record<string, unknown>>,
  content: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new ContractBoundaryError(
      "INVALID_STRUCTURED_JSON",
      "model structured output is not valid JSON",
    );
  }
  const validate = createAjv().compile(schema);
  if (!validate(value)) {
    throw new ContractBoundaryError(
      "INVALID_STRUCTURED_OUTPUT",
      `model structured output: ${formatErrors(validate.errors)}`,
    );
  }
  return value as T;
}
