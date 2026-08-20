import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HA_CONTRACT_ROOT = `${REPOSITORY_ROOT}contracts/home-assistant/v1`;

export const ROBOT_HA_DOMAINS = [
  "light",
  "switch",
  "scene",
  "climate",
  "sensor",
  "binary_sensor",
] as const;
export type RobotHaDomain = (typeof ROBOT_HA_DOMAINS)[number];

export const ROBOT_HA_WRITE_ACTIONS = ["turn_on", "turn_off", "activate_scene"] as const;
export type RobotHaWriteAction = (typeof ROBOT_HA_WRITE_ACTIONS)[number];

export const ROBOT_HA_PROJECTED_ATTRIBUTES = [
  "brightness",
  "color_temp_kelvin",
  "current_temperature",
  "temperature",
  "hvac_action",
  "unit_of_measurement",
  "device_class",
] as const;
export type RobotHaProjectedAttribute = (typeof ROBOT_HA_PROJECTED_ATTRIBUTES)[number];

export interface RobotHaPolicyEntity {
  readonly alias: string;
  readonly entity_id: string;
  readonly domain: RobotHaDomain;
  readonly read: true;
  readonly write_actions: readonly RobotHaWriteAction[];
  readonly projected_attributes: readonly RobotHaProjectedAttribute[];
}

export interface RobotHaPolicy {
  readonly schema_version: 1;
  readonly policy_id: string;
  readonly entities: readonly RobotHaPolicyEntity[];
}

export interface RobotHaCapability {
  readonly alias: string;
  readonly domain: RobotHaDomain;
  readonly readable: true;
  readonly write_actions: readonly RobotHaWriteAction[];
}

interface HaToolCatalog {
  readonly schema_version: number;
  readonly namespace: string;
  readonly tools: readonly {
    readonly name: string;
    readonly side_effect: boolean;
    readonly parameters: AnySchema;
  }[];
}

interface InvalidPolicyFixture {
  readonly name: string;
  readonly policy: unknown;
}

export interface HaRuntimeContractReport {
  readonly policySchemaVersion: 1;
  readonly toolSchemaVersion: 1;
  readonly validPolicies: 1;
  readonly invalidPolicies: number;
  readonly tools: 4;
  readonly allowedDomains: 6;
}

export class HaRuntimeContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HaRuntimeContractError";
  }
}

const ACTIONS_BY_DOMAIN: Readonly<Record<RobotHaDomain, readonly RobotHaWriteAction[]>> = {
  light: ["turn_on", "turn_off"],
  switch: ["turn_on", "turn_off"],
  scene: ["activate_scene"],
  climate: ["turn_on", "turn_off"],
  sensor: [],
  binary_sensor: [],
};

const ATTRIBUTES_BY_DOMAIN: Readonly<Record<RobotHaDomain, readonly RobotHaProjectedAttribute[]>> = {
  light: ["brightness", "color_temp_kelvin"],
  switch: [],
  scene: [],
  climate: ["current_temperature", "temperature", "hvac_action"],
  sensor: ["unit_of_measurement", "device_class"],
  binary_sensor: ["device_class"],
};

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HaRuntimeContractError(`failed to read Robot HA contract: ${detail}`);
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

let policyValidator: ValidateFunction | undefined;

function getPolicyValidator(): ValidateFunction {
  policyValidator ??= new Ajv2020({ allErrors: true, strict: true }).compile(
    readJson<AnySchema>(`${HA_CONTRACT_ROOT}/policy.schema.json`),
  );
  return policyValidator;
}

function assertCanonicalPolicy(policy: RobotHaPolicy): void {
  const aliases = new Set<string>();
  const entityIds = new Set<string>();
  let previousAlias = "";
  for (const entity of policy.entities) {
    if (aliases.has(entity.alias)) {
      throw new HaRuntimeContractError(`duplicate Robot HA alias: ${entity.alias}`);
    }
    if (entityIds.has(entity.entity_id)) {
      throw new HaRuntimeContractError("one HA entity_id cannot be exposed through multiple aliases");
    }
    aliases.add(entity.alias);
    entityIds.add(entity.entity_id);
    if (entity.alias.localeCompare(previousAlias) <= 0) {
      throw new HaRuntimeContractError("Robot HA policy entities must use canonical alias order");
    }
    previousAlias = entity.alias;
    if (!entity.entity_id.startsWith(`${entity.domain}.`)) {
      throw new HaRuntimeContractError(`entity_id domain does not match alias ${entity.alias}`);
    }
    const allowedActions = new Set(ACTIONS_BY_DOMAIN[entity.domain]);
    if (entity.write_actions.some((action) => !allowedActions.has(action))) {
      throw new HaRuntimeContractError(`write action is not allowed for alias ${entity.alias}`);
    }
    const canonicalActions = ACTIONS_BY_DOMAIN[entity.domain].filter((action) =>
      entity.write_actions.includes(action)
    );
    if (canonicalActions.some((action, index) => action !== entity.write_actions[index])) {
      throw new HaRuntimeContractError(`write actions are not canonical for alias ${entity.alias}`);
    }
    const allowedAttributes = new Set(ATTRIBUTES_BY_DOMAIN[entity.domain]);
    if (entity.projected_attributes.some((attribute) => !allowedAttributes.has(attribute))) {
      throw new HaRuntimeContractError(`projected attribute is not allowed for alias ${entity.alias}`);
    }
    const canonicalAttributes = ATTRIBUTES_BY_DOMAIN[entity.domain].filter((attribute) =>
      entity.projected_attributes.includes(attribute)
    );
    if (canonicalAttributes.some((attribute, index) => attribute !== entity.projected_attributes[index])) {
      throw new HaRuntimeContractError(`projected attributes are not canonical for alias ${entity.alias}`);
    }
  }
}

export function validateRobotHaPolicy(input: unknown): RobotHaPolicy {
  const validate = getPolicyValidator();
  if (!validate(input)) {
    throw new HaRuntimeContractError(`Robot HA Policy v1: ${formatErrors(validate.errors)}`);
  }
  const policy = structuredClone(input) as RobotHaPolicy;
  assertCanonicalPolicy(policy);
  return policy;
}

export function projectRobotHaCapabilities(policy: RobotHaPolicy): readonly RobotHaCapability[] {
  const validated = validateRobotHaPolicy(policy);
  return validated.entities.map((entity) => ({
    alias: entity.alias,
    domain: entity.domain,
    readable: true,
    write_actions: [...entity.write_actions],
  }));
}

function assertToolCatalog(catalog: HaToolCatalog): void {
  const expected = [
    ["home.get_entity", false],
    ["home.turn_on", true],
    ["home.turn_off", true],
    ["home.activate_scene", true],
  ] as const;
  if (
    catalog.schema_version !== 1
    || catalog.namespace !== "home"
    || catalog.tools.length !== expected.length
  ) {
    throw new HaRuntimeContractError("Robot HA Tool Catalog v1 metadata is invalid");
  }
  for (const [index, [name, sideEffect]] of expected.entries()) {
    const tool = catalog.tools[index];
    if (
      tool?.name !== name
      || tool.side_effect !== sideEffect
      || JSON.stringify(tool.parameters).includes("entity_id")
    ) {
      throw new HaRuntimeContractError(`Robot HA tool drifted at ${name}`);
    }
  }
  const serialized = JSON.stringify(catalog);
  for (const forbidden of ["call_service", "service_data", "\"domain\""]) {
    if (serialized.includes(forbidden)) {
      throw new HaRuntimeContractError(`Robot HA catalog exposes forbidden ${forbidden}`);
    }
  }
}

export function validateHaRuntimeContracts(): HaRuntimeContractReport {
  const readme = readFileSync(`${HA_CONTRACT_ROOT}/README.md`, "utf8");
  if (!readme.includes("frozen for Phase 4A")) {
    throw new HaRuntimeContractError("Robot HA contract must be frozen before runtime import");
  }
  validateRobotHaPolicy(
    readJson<unknown>(`${HA_CONTRACT_ROOT}/examples/valid/policy.json`),
  );
  const invalid = readJson<InvalidPolicyFixture[]>(
    `${HA_CONTRACT_ROOT}/examples/invalid/policies.json`,
  );
  for (const fixture of invalid) {
    try {
      validateRobotHaPolicy(fixture.policy);
    } catch (error) {
      if (error instanceof HaRuntimeContractError) {
        continue;
      }
      throw error;
    }
    throw new HaRuntimeContractError(`invalid Robot HA policy passed: ${fixture.name}`);
  }
  assertToolCatalog(readJson<HaToolCatalog>(`${HA_CONTRACT_ROOT}/tool-catalog.json`));
  return {
    policySchemaVersion: 1,
    toolSchemaVersion: 1,
    validPolicies: 1,
    invalidPolicies: invalid.length,
    tools: 4,
    allowedDomains: ROBOT_HA_DOMAINS.length,
  };
}
