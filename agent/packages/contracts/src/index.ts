import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEVICE_PROTOCOL_ROOT = `${REPOSITORY_ROOT}contracts/device-protocol/v1`;
const TOOL_SCHEMA_ROOT = `${REPOSITORY_ROOT}contracts/tools/v1`;

interface InvalidFixture {
  readonly name: string;
  readonly expected_error: string;
  readonly message: Record<string, unknown>;
  readonly fixture_mutation?: string;
}

interface GoldenIntent {
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
  readonly tools: readonly {
    readonly name: string;
    readonly parameters: AnySchema;
  }[];
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
  const toolCatalog = readJson<ToolCatalog>(`${TOOL_SCHEMA_ROOT}/tool-catalog.json`);
  const goldenIntents = readJson<GoldenIntent[]>(`${TOOL_SCHEMA_ROOT}/fixtures/golden-intents.json`);

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
  ajv.addSchema(envelope);
  ajv.addSchema(payloads);
  const validateMessage = ajv.compile(messageSchema);
  ajv.compile(toolResultSchema);

  for (const [index, message] of validMessages.entries()) {
    assertValid(validateMessage, message, `valid message fixture ${index}`);
  }
  for (const fixture of invalidMessages) {
    if (validateMessage(mutateInvalidFixture(fixture))) {
      throw new FrozenContractError(`invalid fixture unexpectedly passed: ${fixture.name}`);
    }
  }

  const toolValidators = new Map<string, ValidateFunction>();
  for (const tool of toolCatalog.tools) {
    toolValidators.set(tool.name, ajv.compile(tool.parameters));
  }
  for (const scenario of goldenIntents) {
    if (scenario.expected.length === 0 && scenario.no_tool === undefined) {
      throw new FrozenContractError(`golden intent ${scenario.id} lacks no_tool outcome`);
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
