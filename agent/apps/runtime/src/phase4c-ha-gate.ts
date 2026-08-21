import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  RobotHaClient,
  loadRobotHaRuntimeConfig,
  type RobotHaRuntimeConfig,
} from "@p4home/transport-ha";
import type { RobotHaWriteAction } from "@p4home/contracts";

import {
  dispatchCausalWrite,
  restoreRobotState,
} from "./phase4c-ha-gate-core.ts";
import { readCurrentIdentity } from "./phase4c-ha-identity.ts";

const HA_URL = requiredEnv("P4HOME_PHASE4C_HA_URL");
const TOKEN_FILE = requiredEnv("P4HOME_PHASE4C_TOKEN_FILE");
const POLICY_FILE = requiredEnv("P4HOME_PHASE4C_POLICY_FILE");
const RESULT_FILE = requiredEnv("AGENT_HARNESS_RESULT_FILE");
const ALIAS = process.env.P4HOME_PHASE4C_ALIAS?.trim() || "study_ceiling_light";

interface GateResult {
  readonly schema_version: 1;
  readonly profile: "phase4c_ha";
  readonly passed: boolean;
  readonly reason: string;
  readonly robot_non_admin: boolean;
  readonly policy_entities: number;
  readonly alias: string;
  readonly initial_state: string | null;
  readonly target_state: string | null;
  readonly target_accepted: boolean;
  readonly target_observed: boolean;
  readonly restore_accepted: boolean;
  readonly restore_observed: boolean;
  readonly restored: boolean;
  readonly final_state: string | null;
  readonly state_change_events: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment: ${name}`);
  }
  return value;
}

function safeFailureReason(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const stableReasons = new Set([
    "identity_auth",
    "identity_protocol",
    "identity_timeout",
    "identity_transport",
    "policy_shape",
    "robot_identity_privileged",
    "unsafe_initial_state",
    "target_not_observed",
    "target_rejected",
  ]);
  return stableReasons.has(error.message) ? error.message : fallback;
}

async function writeResult(result: GateResult): Promise<void> {
  await mkdir(dirname(RESULT_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${RESULT_FILE}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, RESULT_FILE);
}

function createClient(
  config: RobotHaRuntimeConfig,
  onStateChange: () => void,
): RobotHaClient {
  return new RobotHaClient({
    config,
    audit_sink: (event) => {
      if (event.type === "ha.state.changed") {
        onStateChange();
      }
    },
    handshake_timeout_ms: 10_000,
    request_timeout_ms: 10_000,
  });
}

async function main(): Promise<number> {
  let reason = "transport_error";
  let config: RobotHaRuntimeConfig | null = null;
  let client: RobotHaClient | null = null;
  let robotNonAdmin = false;
  let policyEntities = 0;
  let initialState: "on" | "off" | null = null;
  let targetState: string | null = null;
  let targetAccepted = false;
  let targetObserved = false;
  let targetAttempted = false;
  let restoreAccepted = false;
  let restoreObserved = false;
  let restored = false;
  let finalState: string | null = null;
  let stateChangeEvents = 0;

  try {
    config = await loadRobotHaRuntimeConfig({
      url: HA_URL,
      token_file: TOKEN_FILE,
      policy_file: POLICY_FILE,
      allow_insecure_ws: HA_URL.startsWith("http://"),
    });
    policyEntities = config.policy.entities.length;
    const identity = await readCurrentIdentity(HA_URL, config.access_token);
    robotNonAdmin = identity.is_admin === false && identity.is_owner === false;
    if (!robotNonAdmin) {
      reason = "robot_identity_privileged";
      throw new Error(reason);
    }
    const entity = config.policy.entities[0];
    if (
      policyEntities !== 1
      || entity?.alias !== ALIAS
      || !["light", "switch"].includes(entity.domain)
      || entity.read !== true
      || !entity.write_actions.includes("turn_on")
      || !entity.write_actions.includes("turn_off")
    ) {
      reason = "policy_shape";
      throw new Error(reason);
    }
    console.log("VERIFY:phase4c:robot_identity:PASS admin=no owner=no policy_entities=1");

    client = createClient(config, () => {
      stateChangeEvents += 1;
    });
    await client.connect();
    const observedInitialState = client.getState(ALIAS)?.state ?? null;
    if (observedInitialState !== "on" && observedInitialState !== "off") {
      reason = "unsafe_initial_state";
      throw new Error(reason);
    }
    initialState = observedInitialState;
    targetState = initialState === "off" ? "on" : "off";
    const targetAction: RobotHaWriteAction = targetState === "on" ? "turn_on" : "turn_off";
    targetAttempted = true;
    const target = await dispatchCausalWrite(client, ALIAS, targetAction, targetState);
    targetAccepted = target.accepted;
    targetObserved = target.observed;
    if (!targetAccepted) {
      reason = "target_rejected";
      throw new Error(reason);
    }
    if (!targetObserved) {
      reason = "target_not_observed";
      throw new Error(reason);
    }
    console.log(
      `VERIFY:phase4c:robot_write:PASS alias=${ALIAS} from=${initialState} to=${targetState} accepted=yes observed=yes`,
    );
    reason = "restore_pending";
  } catch (error) {
    reason = safeFailureReason(error, reason);
    // The stable reason is reported after the restoration attempt.
  } finally {
    if (client !== null && config !== null && initialState !== null && targetAttempted) {
      let restoreClient = client;
      try {
        if (restoreClient.state !== "ready") {
          try {
            await restoreClient.connect();
          } catch {
            restoreClient.close();
            restoreClient = createClient(config, () => {
              stateChangeEvents += 1;
            });
            client = restoreClient;
            await restoreClient.connect();
          }
        }
        const restore = await restoreRobotState(restoreClient, ALIAS, initialState);
        restoreAccepted = restore.accepted;
        restoreObserved = restore.observed;
        finalState = restore.final_state.state;
        restored = restore.restored;
      } catch {
        restored = false;
      } finally {
        restoreClient.close();
      }
    }
  }

  const passed = robotNonAdmin && targetAccepted && targetObserved && restored;
  if (passed) {
    reason = "ok";
    console.log(`VERIFY:phase4c:robot_restore:PASS alias=${ALIAS} state=${initialState}`);
  } else {
    if (!restored && reason === "restore_pending") {
      reason = "restore_failed";
    }
    console.log(`VERIFY:phase4c:robot_write:FAIL reason=${reason}`);
  }
  await writeResult({
    schema_version: 1,
    profile: "phase4c_ha",
    passed,
    reason,
    robot_non_admin: robotNonAdmin,
    policy_entities: policyEntities,
    alias: ALIAS,
    initial_state: initialState,
    target_state: targetState,
    target_accepted: targetAccepted,
    target_observed: targetObserved,
    restore_accepted: restoreAccepted,
    restore_observed: restoreObserved,
    restored,
    final_state: finalState,
    state_change_events: stateChangeEvents,
  });
  return passed ? 0 : 1;
}

process.exitCode = await main();
