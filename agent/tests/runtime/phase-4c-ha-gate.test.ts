import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

import type {
  RobotHaStateObservation,
  RobotHaWriteClient,
} from "@p4home/transport-ha";

import {
  dispatchCausalWrite,
  parseRobotIdentity,
  restoreRobotState,
} from "../../apps/runtime/src/phase4c-ha-gate-core.ts";
import { readCurrentIdentity } from "../../apps/runtime/src/phase4c-ha-identity.ts";

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

async function withIdentityServer(
  behavior: "stall" | "auth_invalid" | "protocol_error",
  run: (url: string, counts: { connections: number; closes: number }) => Promise<void>,
): Promise<void> {
  const server = createServer();
  const webSockets = new WebSocketServer({ server, path: "/api/websocket" });
  const counts = { connections: 0, closes: 0 };
  webSockets.on("connection", (socket) => {
    counts.connections += 1;
    socket.once("close", () => {
      counts.closes += 1;
    });
    if (behavior === "stall") {
      return;
    }
    if (behavior === "protocol_error") {
      socket.send(JSON.stringify({ type: "unexpected" }));
      return;
    }
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "auth_invalid", message: "denied" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address !== null && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, counts);
  } finally {
    for (const socket of webSockets.clients) {
      socket.terminate();
    }
    const webSocketsClosed = once(webSockets, "close");
    const serverClosed = once(server, "close");
    webSockets.close();
    server.close();
    await Promise.all([webSocketsClosed, serverClosed]);
  }
}

async function waitForCloses(
  counts: { closes: number },
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100 && counts.closes !== expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(counts.closes, expected);
}

test("identity timeout retries three times, closes old sockets, and redacts token", async () => {
  await withIdentityServer("stall", async (url, counts) => {
    const token = "test-secret-token-must-not-escape";
    await assert.rejects(
      readCurrentIdentity(url, token, {
        attempts: 3,
        timeout_ms: 20,
        retry_delay_ms: 1,
      }),
      (error: Error) => {
        assert.equal(error.message, "identity_timeout");
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
    assert.equal(counts.connections, 3);
    await waitForCloses(counts, 3);
  });
});

test("identity auth and protocol failures do not retry", async () => {
  for (const behavior of ["auth_invalid", "protocol_error"] as const) {
    await withIdentityServer(behavior, async (url, counts) => {
      await assert.rejects(
        readCurrentIdentity(url, "test-token", {
          attempts: 3,
          timeout_ms: 100,
          retry_delay_ms: 1,
        }),
        new RegExp(behavior === "auth_invalid" ? "identity_auth" : "identity_protocol"),
      );
      assert.equal(counts.connections, 1);
      await waitForCloses(counts, 1);
    });
  }
});

class ControlledIdentitySocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  terminateCalls = 0;

  constructor(private readonly behavior: "success" | "transport_error") {
    super();
    queueMicrotask(() => {
      if (this.behavior === "success") {
        this.emit("message", Buffer.from(JSON.stringify({ type: "auth_required" })), false);
      } else {
        this.emit("error", new Error("transport failed"));
      }
    });
  }

  send(raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (message.type === "auth") {
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "auth_ok" })), false);
      });
    } else if (message.type === "auth/current_user") {
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          id: 1,
          type: "result",
          success: true,
          result: { is_admin: false, is_owner: false },
        })), false);
      });
    }
  }

  close(): void {
    // Intentionally ignore the graceful close handshake.
  }

  terminate(): void {
    this.terminateCalls += 1;
    setTimeout(() => {
      this.emit("error", new Error("late close error"));
      this.readyState = WebSocket.CLOSED;
      this.emit("close");
    }, 5);
  }
}

test("identity completion force-closes a peer that ignores graceful close", async () => {
  const socket = new ControlledIdentitySocket("success");
  const identity = await readCurrentIdentity("http://127.0.0.1:8123", "test-token", {
    attempts: 1,
    close_grace_ms: 1,
    timeout_ms: 100,
    create_socket: () => socket as unknown as WebSocket,
  });
  assert.deepEqual(identity, { is_admin: false, is_owner: false });
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("identity retry starts only after the prior transport socket closes", async () => {
  const sockets: ControlledIdentitySocket[] = [];
  let overlap = false;
  await assert.rejects(
    readCurrentIdentity("http://127.0.0.1:8123", "test-token", {
      attempts: 3,
      close_grace_ms: 1,
      retry_delay_ms: 1,
      timeout_ms: 100,
      create_socket: () => {
        if (sockets.some((socket) => socket.readyState !== WebSocket.CLOSED)) {
          overlap = true;
        }
        const socket = new ControlledIdentitySocket("transport_error");
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    }),
    /identity_transport/,
  );
  assert.equal(overlap, false);
  assert.equal(sockets.length, 3);
  assert.deepEqual(sockets.map((socket) => socket.terminateCalls), [1, 1, 1]);
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
