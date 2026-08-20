import type {
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
): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    if (name === "brightness" && (!Number.isInteger(value) || value < 0 || value > 255)) {
      return undefined;
    }
    if (name === "color_temp_kelvin" && (value < 1_000 || value > 20_000)) {
      return undefined;
    }
    if (
      (name === "current_temperature" || name === "temperature")
      && (value < -100 || value > 100)
    ) {
      return undefined;
    }
    return value;
  }
  if (typeof value !== "string" || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  if (name === "hvac_action") {
    return ["off", "heating", "cooling", "drying", "idle", "fan"].includes(value)
      ? value
      : undefined;
  }
  if (name === "device_class") {
    return /^[a-z0-9_]{1,32}$/.test(value) ? value : undefined;
  }
  if (name === "unit_of_measurement") {
    return ["°C", "°F", "%", "ppm", "lx", "W", "kW", "V", "A", "Hz"].includes(value)
      ? value
      : undefined;
  }
  return undefined;
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
  const rawState = raw.state;
  let state: string | null = null;
  if (typeof rawState === "string" && rawState.length >= 1 && rawState.length <= 128) {
    const binaryState = ["on", "off", "unavailable", "unknown"].includes(rawState);
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
    ].includes(rawState);
    const sensorState = /^-?\d+(?:\.\d+)?$/.test(rawState)
      || rawState === "unavailable"
      || rawState === "unknown";
    const sceneState = rawState === "unavailable"
      || rawState === "unknown"
      || (rawState.length <= 40 && Number.isFinite(Date.parse(rawState)));
    const accepted = entity.domain === "light"
      || entity.domain === "switch"
      || entity.domain === "binary_sensor"
      ? binaryState
      : entity.domain === "climate"
        ? climateState
        : entity.domain === "scene"
          ? sceneState
          : sensorState;
    state = accepted ? rawState : null;
  }
  const rawAttributes = raw.attributes !== null
    && typeof raw.attributes === "object"
    && !Array.isArray(raw.attributes)
    ? raw.attributes as Record<string, unknown>
    : {};
  const attributes: Partial<Record<RobotHaProjectedAttribute, string | number | boolean | null>> = {};
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
