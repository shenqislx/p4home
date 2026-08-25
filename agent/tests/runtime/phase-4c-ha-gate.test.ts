import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  waitForStableProjectedState,
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

test("initial HA state must be available and stable before the gate dispatches", async () => {
  let state = { ...projected("off"), available: false };
  let unsubscribed = false;
  const client = {
    state: "ready" as const,
    getState() {
      return structuredClone(state);
    },
    onState(candidate: (value: ReturnType<typeof projected>) => void) {
      setTimeout(() => {
        state = projected("on");
        candidate(structuredClone(state));
      }, 1);
      return () => { unsubscribed = true; };
    },
  } as unknown as Pick<RobotHaWriteClient, "getState" | "onState" | "state">;

  const pending = waitForStableProjectedState(client, alias, 100, 5);
  const result = await pending;
  assert.equal(result?.available, true);
  assert.equal(result?.state, "on");
  assert.equal(unsubscribed, true);
});

test("initial HA stabilization restarts when the projected state changes", async () => {
  let state = projected("on");
  const client = {
    state: "ready" as const,
    getState() {
      return structuredClone(state);
    },
    onState(candidate: (value: ReturnType<typeof projected>) => void) {
      setTimeout(() => {
        state = projected("off");
        candidate(structuredClone(state));
      }, 5);
      return () => undefined;
    },
  } as unknown as Pick<RobotHaWriteClient, "getState" | "onState" | "state">;

  const pending = waitForStableProjectedState(client, alias, 100, 10);
  const result = await pending;
  assert.equal(result?.state, "off");
});

test("initial HA stabilization fails closed when availability never recovers", async () => {
  const unavailable = { ...projected("off"), available: false };
  const client = {
    state: "ready" as const,
    getState() {
      return structuredClone(unavailable);
    },
    onState() {
      return () => undefined;
    },
  } as unknown as Pick<RobotHaWriteClient, "getState" | "onState" | "state">;

  assert.equal(await waitForStableProjectedState(client, alias, 5, 0), null);
});

test("initial HA stabilization rejects a disconnected client whose cache cleared silently", async () => {
  let connectionState: "ready" | "error" = "ready";
  let state: ReturnType<typeof projected> | null = projected("on");
  const client = {
    get state() {
      return connectionState;
    },
    getState() {
      return state === null ? null : structuredClone(state);
    },
    onState() {
      setTimeout(() => {
        connectionState = "error";
        state = null;
      }, 5);
      return () => undefined;
    },
  } as unknown as Pick<RobotHaWriteClient, "getState" | "onState" | "state">;

  assert.equal(await waitForStableProjectedState(client, alias, 30, 10), null);
});

test("zero-settle synchronous state delivery unsubscribes its listener", async () => {
  let activeListeners = 0;
  const client = {
    state: "ready" as const,
    getState() {
      return projected("off");
    },
    onState(candidate: (value: ReturnType<typeof projected>) => void) {
      activeListeners += 1;
      candidate(projected("off"));
      return () => {
        activeListeners -= 1;
      };
    },
  } as unknown as Pick<RobotHaWriteClient, "getState" | "onState" | "state">;

  assert.equal((await waitForStableProjectedState(client, alias, 20, 0))?.state, "off");
  assert.equal(activeListeners, 0);
});

test("causal write ignores cache and observations at the dispatch cursor", async () => {
  const stale = await dispatchCausalWrite(causalClient(1), alias, "turn_on", "on", 5);
  assert.deepEqual(stale, { accepted: true, observed: false });

  const fresh = await dispatchCausalWrite(causalClient(2), alias, "turn_on", "on", 5);
  assert.deepEqual(fresh, { accepted: true, observed: true });
});

test("causal write does not set the dispatch latch when beginWrite fails", async () => {
  let dispatched = false;
  const client = {
    onObservation() {
      return () => undefined;
    },
    beginWrite() {
      throw new Error("disconnected before dispatch");
    },
  } as unknown as RobotHaWriteClient;

  await assert.rejects(
    dispatchCausalWrite(client, alias, "turn_on", "on", 5, () => {
      dispatched = true;
    }),
    /disconnected before dispatch/,
  );
  assert.equal(dispatched, false);
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
  assert.equal(result.attempts, 1);
  assert.equal(result.error, null);
  assert.equal(result.restored, true);
  assert.equal(result.final_state?.state, "off");
});

test("restoration performs one bounded correction after a confirmed rebound", async () => {
  let writes = 0;
  let reconciliations = 0;
  let listener: ((observation: RobotHaStateObservation) => void) | null = null;
  const client = {
    onObservation(candidate: (observation: RobotHaStateObservation) => void) {
      listener = candidate;
      return () => {
        listener = null;
      };
    },
    beginWrite() {
      writes += 1;
      const sequence = writes * 2;
      queueMicrotask(() => listener?.({
        connection_generation: 1,
        sequence: sequence + 1,
        source: "subscribed_state_changed",
        state: projected("off"),
      }));
      return {
        request_id: writes,
        dispatch_cursor: { connection_generation: 1, sequence },
        response: Promise.resolve({ request_id: writes, accepted: true }),
      };
    },
    async reconcileState() {
      reconciliations += 1;
      return projected(reconciliations === 1 ? "on" : "off");
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 2);
  assert.equal(reconciliations, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.accepted, true);
  assert.equal(result.observed, true);
  assert.equal(result.error, null);
  assert.equal(result.restored, true);
  assert.equal(result.final_state?.state, "off");
});

test("restoration never retries a rejected compensation", async () => {
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
        dispatch_cursor: { connection_generation: 1, sequence: writes },
        response: Promise.resolve({ request_id: writes, accepted: false }),
      };
    },
    async reconcileState() {
      reconciliations += 1;
      return projected("on");
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 1);
  assert.equal(reconciliations, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.restored, false);
});

test("restoration never corrects an unavailable final state", async () => {
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
        dispatch_cursor: { connection_generation: 1, sequence: writes },
        response: Promise.resolve({ request_id: writes, accepted: true }),
      };
    },
    async reconcileState() {
      reconciliations += 1;
      return { ...projected("on"), available: false };
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 1);
  assert.equal(reconciliations, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.error, null);
  assert.equal(result.restored, false);
});

test("restoration records a dispatched first response that becomes unknown", async () => {
  let writes = 0;
  const client = {
    onObservation() {
      return () => undefined;
    },
    beginWrite() {
      writes += 1;
      return {
        request_id: writes,
        dispatch_cursor: { connection_generation: 1, sequence: writes },
        response: Promise.reject(new Error("disconnect")),
      };
    },
    async reconcileState() {
      return projected("off");
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.error, "dispatch_unknown");
  assert.equal(result.final_state?.state, "off");
  assert.equal(result.restored, false);
});

test("restoration records a dispatched correction response that becomes unknown", async () => {
  let writes = 0;
  let reconciliations = 0;
  let listener: ((observation: RobotHaStateObservation) => void) | null = null;
  const client = {
    onObservation(candidate: (observation: RobotHaStateObservation) => void) {
      listener = candidate;
      return () => {
        listener = null;
      };
    },
    beginWrite() {
      writes += 1;
      const requestId = writes;
      const sequence = requestId * 2;
      if (requestId === 1) {
        queueMicrotask(() => listener?.({
          connection_generation: 1,
          sequence: sequence + 1,
          source: "subscribed_state_changed",
          state: projected("off"),
        }));
      }
      return {
        request_id: requestId,
        dispatch_cursor: { connection_generation: 1, sequence },
        response: requestId === 1
          ? Promise.resolve({ request_id: requestId, accepted: true })
          : Promise.reject(new Error("disconnect")),
      };
    },
    async reconcileState() {
      reconciliations += 1;
      return projected(reconciliations === 1 ? "on" : "off");
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 2);
  assert.equal(reconciliations, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.error, "dispatch_unknown");
  assert.equal(result.restored, false);
});

test("restoration records attempts when final reconciliation is unknown", async () => {
  let writes = 0;
  const client = {
    onObservation() {
      return () => undefined;
    },
    beginWrite() {
      writes += 1;
      return {
        request_id: writes,
        dispatch_cursor: { connection_generation: 1, sequence: writes },
        response: Promise.resolve({ request_id: writes, accepted: true }),
      };
    },
    async reconcileState() {
      throw new Error("rest transport failed");
    },
  } as unknown as RobotHaWriteClient;

  const result = await restoreRobotState(client, alias, "off", 5, 0);
  assert.equal(writes, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.error, "reconcile_unknown");
  assert.equal(result.final_state, null);
  assert.equal(result.restored, false);
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
  const outboundTypes: string[] = [];
  const identity = await readCurrentIdentity("http://127.0.0.1:8123", "test-token", {
    attempts: 1,
    close_grace_ms: 1,
    timeout_ms: 100,
    create_socket: () => socket as unknown as WebSocket,
    on_outbound_frame: (frame) => {
      const message = JSON.parse(frame) as Record<string, unknown>;
      outboundTypes.push(String(message.type));
    },
  });
  assert.deepEqual(identity, { is_admin: false, is_owner: false });
  assert.deepEqual(outboundTypes, ["auth", "auth/current_user"]);
  assert.equal(socket.terminateCalls, 1);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("identity URL normalization never downgrades wss transport", async () => {
  const socket = new ControlledIdentitySocket("success");
  let connectedUrl = "";
  const identity = await readCurrentIdentity(
    "wss://ha.example.test/api/websocket",
    "test-token",
    {
      attempts: 1,
      close_grace_ms: 1,
      timeout_ms: 100,
      create_socket: (url) => {
        connectedUrl = url;
        return socket as unknown as WebSocket;
      },
    },
  );

  assert.deepEqual(identity, { is_admin: false, is_owner: false });
  assert.equal(connectedUrl, "wss://ha.example.test/api/websocket");
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

test("gate entrypoint times out an unavailable real socket, sends no write, and closes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p4home-phase4c-unavailable-"));
  const resultPath = join(directory, "result.json");
  const tokenPath = join(directory, "robot.token");
  const policyPath = join(directory, "robot-policy.json");
  const timerPreloadPath = join(directory, "bounded-timers.mjs");
  const token = "phase4c-test-token-0123456789abcdef";
  const entityId = "switch.phase4c_unavailable_fixture";
  let connections = 0;
  let closes = 0;
  let serviceCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === `/api/states/${entityId}`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        entity_id: entityId,
        state: "unavailable",
        attributes: {},
        last_updated: "2026-08-23T00:00:00.000Z",
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const webSockets = new WebSocketServer({ server, path: "/api/websocket" });
  webSockets.on("connection", (socket) => {
    connections += 1;
    socket.once("close", () => {
      closes += 1;
    });
    socket.send(JSON.stringify({ type: "auth_required" }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({ type: "auth_ok" }));
      } else if (message.type === "auth/current_user") {
        socket.send(JSON.stringify({
          id: message.id,
          type: "result",
          success: true,
          result: { is_admin: false, is_owner: false },
        }));
      } else if (message.type === "subscribe_events") {
        socket.send(JSON.stringify({
          id: message.id,
          type: "result",
          success: true,
          result: null,
        }));
      } else if (message.type === "call_service") {
        serviceCalls += 1;
      }
    });
  });

  try {
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await writeFile(policyPath, `${JSON.stringify({
      schema_version: 1,
      policy_id: "phase4c.unavailable-fixture",
      entities: [{
        alias,
        entity_id: entityId,
        domain: "switch",
        read: true,
        write_actions: ["turn_on", "turn_off"],
        projected_attributes: [],
      }],
    })}\n`);
    await writeFile(
      timerPreloadPath,
      "const realSetTimeout = globalThis.setTimeout;\n"
        + "globalThis.setTimeout = (callback, delay, ...args) => "
        + "realSetTimeout(callback, Math.min(Number(delay), 100), ...args);\n",
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address !== null && typeof address === "object");

    const outcome = await new Promise<{
      code: number | null;
      stdout: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/runtime/src/phase4c-ha-gate.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            P4HOME_PHASE4C_HA_URL: `http://127.0.0.1:${address.port}`,
            P4HOME_PHASE4C_TOKEN_FILE: tokenPath,
            P4HOME_PHASE4C_POLICY_FILE: policyPath,
            AGENT_HARNESS_RESULT_FILE: resultPath,
            NODE_OPTIONS: `--import=${timerPreloadPath}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, stdout, timedOut: true });
      }, 2_000);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, timedOut: false });
      });
    });

    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.code, 1);
    assert.match(outcome.stdout, /VERIFY:phase4c:robot_write:FAIL reason=unsafe_initial_state/);
    assert.equal(serviceCalls, 0);
    assert.equal(connections, 2);
    for (let attempt = 0; attempt < 100 && closes < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(closes, 2);
    const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
    assert.equal(result.passed, false);
    assert.equal(result.reason, "unsafe_initial_state");
    assert.equal(result.restore_attempts, 0);
  } finally {
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
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
