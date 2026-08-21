import type {
  RobotHaCapability,
  RobotHaDomain,
  RobotHaPolicyEntity,
  RobotHaProjectedAttribute,
} from "@p4home/contracts";

import type { RobotHaRuntimeConfig } from "./config.ts";
import {
  RobotHaTransportError,
  type RobotHaEntityStateReader,
  type RobotHaProjectedState,
} from "./types.ts";

const MAX_ENTITY_STATE_BYTES = 65_536;

const PROJECTED_ATTRIBUTES_BY_DOMAIN: Readonly<
  Record<RobotHaDomain, readonly RobotHaProjectedAttribute[]>
> = {
  light: ["brightness", "color_temp_kelvin"],
  switch: [],
  scene: [],
  climate: ["current_temperature", "temperature", "hvac_action"],
  sensor: ["unit_of_measurement", "device_class"],
  binary_sensor: ["device_class"],
};

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > MAX_ENTITY_STATE_BYTES
  ) {
    throw new RobotHaTransportError("STATE_LOAD_FAILED", "allowlisted state response is oversized");
  }
  if (response.body === null) {
    throw new RobotHaTransportError("STATE_LOAD_FAILED", "allowlisted state response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_ENTITY_STATE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RobotHaTransportError("STATE_LOAD_FAILED", "allowlisted state response is oversized");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RobotHaTransportError) {
      throw error;
    }
    throw new RobotHaTransportError("STATE_LOAD_FAILED", "allowlisted state response read failed");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch {
    throw new RobotHaTransportError("STATE_LOAD_FAILED", "allowlisted state response is not JSON");
  }
}

function safeAttribute(
  name: RobotHaProjectedAttribute,
  value: unknown,
): string | number | null | undefined {
  if (value === null) {
    return null;
  }
  switch (name) {
    case "brightness":
      return typeof value === "number"
        && Number.isInteger(value)
        && value >= 0
        && value <= 255
        ? value
        : undefined;
    case "color_temp_kelvin":
      return typeof value === "number"
        && Number.isFinite(value)
        && value >= 1_000
        && value <= 20_000
        ? value
        : undefined;
    case "current_temperature":
    case "temperature":
      return typeof value === "number"
        && Number.isFinite(value)
        && value >= -100
        && value <= 100
        ? value
        : undefined;
    case "hvac_action":
      return typeof value === "string"
        && ["off", "heating", "cooling", "drying", "idle", "fan"].includes(value)
        ? value
        : undefined;
    case "device_class":
      return typeof value === "string" && /^[a-z0-9_]{1,32}$/.test(value)
        ? value
        : undefined;
    case "unit_of_measurement":
      return typeof value === "string"
        && ["°C", "°F", "%", "ppm", "lx", "W", "kW", "V", "A", "Hz"].includes(value)
        ? value
        : undefined;
  }
}

function safeState(domain: RobotHaDomain, value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    return null;
  }
  const binaryState = ["on", "off", "unavailable", "unknown"].includes(value);
  const climateState = [
    "off",
    "heat",
    "cool",
    "heat_cool",
    "auto",
    "dry",
    "fan_only",
    "unavailable",
    "unknown",
  ].includes(value);
  const sensorState = /^-?\d+(?:\.\d+)?$/.test(value)
    || value === "unavailable"
    || value === "unknown";
  const sceneTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
  const sceneState = value === "unavailable"
    || value === "unknown"
    || (sceneTimestamp.test(value) && Number.isFinite(Date.parse(value)));
  const accepted = domain === "light" || domain === "switch" || domain === "binary_sensor"
    ? binaryState
    : domain === "climate"
      ? climateState
      : domain === "scene"
        ? sceneState
        : sensorState;
  return accepted ? value : null;
}

export function validateRobotHaProjectedState(
  input: unknown,
  capability: Pick<RobotHaCapability, "alias" | "domain">,
): RobotHaProjectedState {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(input);
  } catch {
    throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA projected state is not cloneable");
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA projected state is invalid");
  }
  const state = snapshot as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const expectedKeys = ["alias", "attributes", "available", "domain", "state", "updated_at_ms"];
  const projectedState = state.state === null ? null : safeState(capability.domain, state.state);
  const expectedAvailable = projectedState !== null
    && projectedState !== "unavailable"
    && projectedState !== "unknown";
  if (
    keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || state.alias !== capability.alias
    || state.domain !== capability.domain
    || (state.state !== null && projectedState === null)
    || state.available !== expectedAvailable
    || (
      state.updated_at_ms !== null
      && (!Number.isSafeInteger(state.updated_at_ms) || Number(state.updated_at_ms) < 0)
    )
    || state.attributes === null
    || typeof state.attributes !== "object"
    || Array.isArray(state.attributes)
  ) {
    throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA projected state is invalid");
  }
  const attributes = state.attributes as Record<string, unknown>;
  const allowedAttributes = PROJECTED_ATTRIBUTES_BY_DOMAIN[capability.domain];
  for (const [name, value] of Object.entries(attributes)) {
    if (
      !allowedAttributes.includes(name as RobotHaProjectedAttribute)
      || !Object.is(safeAttribute(name as RobotHaProjectedAttribute, value), value)
    ) {
      throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA projected attributes are invalid");
    }
  }
  return snapshot as RobotHaProjectedState;
}

export function projectRobotHaState(
  entity: RobotHaPolicyEntity,
  input: unknown,
): RobotHaProjectedState {
  if (input === null) {
    return {
      alias: entity.alias,
      domain: entity.domain,
      state: null,
      available: false,
      attributes: {},
      updated_at_ms: null,
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new RobotHaTransportError("PROTOCOL_ERROR", "Home Assistant state must be an object or null");
  }
  const raw = input as Record<string, unknown>;
  if (raw.entity_id !== entity.entity_id) {
    throw new RobotHaTransportError("PROTOCOL_ERROR", "Home Assistant state entity does not match policy");
  }
  const state = safeState(entity.domain, raw.state);
  const rawAttributes = raw.attributes !== null
    && typeof raw.attributes === "object"
    && !Array.isArray(raw.attributes)
    ? raw.attributes as Record<string, unknown>
    : {};
  const attributes: Partial<Record<RobotHaProjectedAttribute, string | number | null>> = {};
  for (const name of entity.projected_attributes) {
    const projected = safeAttribute(name, rawAttributes[name]);
    if (projected !== undefined) {
      attributes[name] = projected;
    }
  }
  const timestamp = typeof raw.last_updated === "string" ? Date.parse(raw.last_updated) : Number.NaN;
  return {
    alias: entity.alias,
    domain: entity.domain,
    state,
    available: state !== null && state !== "unavailable" && state !== "unknown",
    attributes,
    updated_at_ms: Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null,
  };
}

export class RestRobotHaEntityStateReader implements RobotHaEntityStateReader {
  public async read(
    config: RobotHaRuntimeConfig,
    entities: readonly RobotHaPolicyEntity[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, unknown>> {
    const states = new Map<string, unknown>();
    for (const entity of entities) {
      if (signal.aborted) {
        throw new RobotHaTransportError("DISCONNECTED", "state load was cancelled");
      }
      let response: Response;
      try {
        response = await fetch(
          `${config.rest_base_url}/${encodeURIComponent(entity.entity_id)}`,
          {
            headers: { Authorization: `Bearer ${config.access_token}` },
            redirect: "error",
            signal,
          },
        );
      } catch {
        throw new RobotHaTransportError("STATE_LOAD_FAILED", "allowlisted state request failed");
      }
      if (response.status === 404) {
        states.set(entity.entity_id, null);
        continue;
      }
      if (!response.ok) {
        throw new RobotHaTransportError(
          "STATE_LOAD_FAILED",
          `allowlisted state request returned HTTP ${response.status}`,
        );
      }
      let state: unknown;
      state = await readBoundedJson(response);
      states.set(entity.entity_id, state);
    }
    return states;
  }
}
