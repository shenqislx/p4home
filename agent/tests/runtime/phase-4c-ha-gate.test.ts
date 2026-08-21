import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import type {
  RobotHaStateObservation,
  RobotHaWriteClient,
} from "@p4home/transport-ha";

import {
  dispatchCausalWrite,
  parseRobotIdentity,
  restoreRobotState,
} from "../../apps/runtime/src/phase4c-ha-gate-core.ts";

const alias = "study_ceiling_light";

function projected(state: "on" | "off") {
  return {
    alias,
    domain: "switch" as const,
    state,
    available: true,
    attributes: {},
    updated_at_ms: 1_000,
  };
}

function causalClient(sequence: number): RobotHaWriteClient {
  let listener: ((observation: RobotHaStateObservation) => void) | null = null;
  return {
    onObservation(candidate: (observation: RobotHaStateObservation) => void) {
      listener = candidate;
      return () => {
        listener = null;
      };
    },
    beginWrite() {
      const cursor = { connection_generation: 1, sequence: 1 };
      queueMicrotask(() => listener?.({
        ...cursor,
        sequence,
        source: "subscribed_state_changed",
        state: projected("on"),
      }));
      return {
        request_id: 7,
        dispatch_cursor: cursor,
        response: Promise.resolve({ request_id: 7, accepted: true }),
      };
    },
  } as unknown as RobotHaWriteClient;
}

test("identity gate rejects absent or non-boolean privilege fields", () => {
  assert.throws(() => parseRobotIdentity({}), /identity_protocol/);
  assert.throws(
    () => parseRobotIdentity({ is_admin: false, is_owner: "false" }),
    /identity_protocol/,
  );
  assert.deepEqual(
    parseRobotIdentity({ is_admin: false, is_owner: false, name: "Robot" }),
    { is_admin: false, is_owner: false },
  );
});

test("causal write ignores cache and observations at the dispatch cursor", async () => {
  const stale = await dispatchCausalWrite(causalClient(1), alias, "turn_on", "on", 5);
  assert.deepEqual(stale, { accepted: true, observed: false });

  const fresh = await dispatchCausalWrite(causalClient(2), alias, "turn_on", "on", 5);
  assert.deepEqual(fresh, { accepted: true, observed: true });
});

test("restoration always dispatches and performs an independent final read", async () => {
  let writes = 0;
  let reconciliations = 0;
  const client = {
    onObservation() {
      return () => undefined;
    },
    beginWrite() {
      writes += 1;
      return {
        request_id: writes,
        dispatch_cursor: { connection_generation: 1, sequence: 0 },
        response: Promise.resolve({ request_id: writes, accepted: true }),
      };
    },
    async reconcileState() {
      reconciliations += 1;
      return projected("off");
    },
    getState() {
      return projected("off");
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 1);
  assert.equal(reconciliations, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.observed, false);
  assert.equal(result.restored, true);
  assert.equal(result.final_state.state, "off");
});

test("gate entrypoint consumes the workflow result variable and writes a sanitized failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4home-phase4c-entry-"));
  const resultPath = join(directory, "result.json");
  try {
    const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/runtime/src/phase4c-ha-gate.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            P4HOME_PHASE4C_HA_URL: "http://127.0.0.1:8123",
            P4HOME_PHASE4C_TOKEN_FILE: join(directory, "missing.token"),
            P4HOME_PHASE4C_POLICY_FILE: join(directory, "missing-policy.json"),
            AGENT_HARNESS_RESULT_FILE: resultPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(outcome.code, 1);
    assert.doesNotMatch(outcome.stderr, /AGENT_HARNESS_RESULT_FILE/);
    assert.match(outcome.stdout, /VERIFY:phase4c:robot_write:FAIL reason=transport_error/);
    const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
    assert.equal(result.passed, false);
    assert.equal(result.reason, "transport_error");
    assert.equal(JSON.stringify(result).includes("access_token"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
