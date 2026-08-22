import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type {
  OllamaChatRequest,
  OllamaChatResult,
} from "@p4home/provider-ollama";
import {
  RobotHaClient,
  createRobotHaWebSocket,
  loadRobotHaRuntimeConfig,
  type RobotHaClientView,
  type RobotHaSocket,
  type RobotHaSocketFactory,
} from "@p4home/transport-ha";

import {
  RoleSessionRegistry,
  getRoleProfile,
  runAssignedRole,
  type RoutePlan,
  type UserTextInteraction,
} from "./index.ts";
import { readCurrentIdentity } from "./phase4c-ha-identity.ts";

const execFileAsync = promisify(execFile);

interface FrameCounters {
  invalid: number;
  service_calls: number;
  total: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment: ${name}`);
  return value;
}

function fetchPath(input: string | URL | Request): string | null {
  try {
    const raw = input instanceof Request ? input.url : input.toString();
    return new URL(raw).pathname;
  } catch {
    return null;
  }
}

function inspectOutboundFrame(frame: string, counters: FrameCounters): void {
  counters.total += 1;
  let input: unknown;
  try {
    input = JSON.parse(frame) as unknown;
  } catch {
    counters.invalid += 1;
    return;
  }
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || typeof (input as Record<string, unknown>).type !== "string"
  ) {
    counters.invalid += 1;
    return;
  }
  if ((input as Record<string, unknown>).type === "call_service") {
    counters.service_calls += 1;
  }
}

async function closesWithin(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  return result;
}

async function writeEvidence(path: string, evidence: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function main(): Promise<void> {
  const url = requiredEnv("P4HOME_PHASE4B_HA_URL");
  const resultFile = requiredEnv("P4HOME_PHASE4B_RESULT_FILE");
  const { stdout: repoRootOutput } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const repoRoot = repoRootOutput.trim();
  const [{ stdout: gitShaOutput }, { stdout: agentTreeOutput }, { stdout: agentStatus }] =
    await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }),
      execFileAsync("git", ["rev-parse", "HEAD:agent"], { cwd: repoRoot, encoding: "utf8" }),
      execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all", "--", "agent"],
        { cwd: repoRoot, encoding: "utf8" },
      ),
    ]);
  assert.equal(agentStatus.trim(), "");
  const gitSha = gitShaOutput.trim();
  const agentTreeSha = agentTreeOutput.trim();
  const config = await loadRobotHaRuntimeConfig({
    url,
    token_file: requiredEnv("P4HOME_PHASE4B_TOKEN_FILE"),
    policy_file: requiredEnv("P4HOME_PHASE4B_POLICY_FILE"),
    allow_insecure_ws: url.startsWith("http://"),
  });
  const identityFrames: FrameCounters = { invalid: 0, service_calls: 0, total: 0 };
  const identity = await readCurrentIdentity(url, config.access_token, {
    on_outbound_frame: (frame) => inspectOutboundFrame(frame, identityFrames),
  });
  assert.equal(identity.is_admin, false);
  assert.equal(identity.is_owner, false);
  assert.equal(identityFrames.invalid, 0);
  assert.equal(identityFrames.service_calls, 0);

  const originalFetch = globalThis.fetch;
  let perEntityStateRequests = 0;
  let fullStateRequests = 0;
  const robotFrames: FrameCounters = { invalid: 0, service_calls: 0, total: 0 };
  globalThis.fetch = async (input, init) => {
    const path = fetchPath(input);
    if (path === "/api/states") {
      fullStateRequests += 1;
    } else if (path?.startsWith("/api/states/") === true) {
      perEntityStateRequests += 1;
    }
    return await originalFetch(input, init);
  };

  const transport: {
    socket: RobotHaSocket | null;
    closed: Promise<void> | null;
  } = { socket: null, closed: null };
  const socketFactory: RobotHaSocketFactory = (socketUrl, maxFrameBytes) => {
    const socket = createRobotHaWebSocket(socketUrl, maxFrameBytes);
    assert.equal(transport.socket, null);
    transport.socket = socket;
    transport.closed = new Promise<void>((resolve) => {
      socket.onClose(() => resolve());
    });
    return {
      get is_open() { return socket.is_open; },
      send(frame) {
        inspectOutboundFrame(frame, robotFrames);
        socket.send(frame);
      },
      close(code, reason) { socket.close(code, reason); },
      terminate() { socket.terminate(); },
      onOpen(listener) { return socket.onOpen(listener); },
      onMessage(listener) { return socket.onMessage(listener); },
      onClose(listener) { return socket.onClose(listener); },
      onError(listener) { return socket.onError(listener); },
    };
  };
  let client: RobotHaClient | null = null;
  try {
    client = new RobotHaClient({
      config,
      socket_factory: socketFactory,
      handshake_timeout_ms: 10_000,
      request_timeout_ms: 10_000,
    });
    await client.connect();
    const activeClient = client;
    assert.equal(activeClient.capabilities.length, 1);
    const capability = activeClient.capabilities[0];
    assert.ok(capability !== undefined);
    assert.equal(capability.readable, true);
    assert.equal(perEntityStateRequests, activeClient.capabilities.length);
    assert.equal(fullStateRequests, 0);
    const projected = activeClient.getState(capability.alias);
    assert.ok(projected !== null);

    const readView: RobotHaClientView = Object.freeze({
      get state() { return activeClient.state; },
      get capabilities() { return activeClient.capabilities; },
      get metrics() { return activeClient.metrics; },
      getState(alias: string) { return activeClient.getState(alias); },
      listStates() { return activeClient.listStates(); },
    });
    assert.equal("beginWrite" in readView, false);
    assert.equal("reconcileState" in readView, false);

    const interaction: UserTextInteraction = {
      schema_version: 1,
      interaction_id: "interaction:phase4b:real-read",
      kind: "user_text",
      text: "查询已授权测试灯的当前状态",
      locale: "zh-CN",
      source: "simulator",
      received_at_ms: Date.now(),
    };
    const plan: RoutePlan = {
      schema_version: 1,
      route_plan_id: "route:phase4b:real-read",
      interaction_id: interaction.interaction_id,
      assignments: [{
        assignment_id: "assignment:phase4b:real-read",
        role_id: "robot",
        source_span: { start: 0, end: interaction.text.length },
        mode: "respond",
      }],
      reason: "model_robot",
      created_at_ms: interaction.received_at_ms + 1,
    };
    const sessions = new RoleSessionRegistry({
      robot: "session:phase4b:real-read:robot",
      human: "session:phase4b:real-read:human",
      cat: "session:phase4b:real-read:cat",
    });
    let capturedRequest: OllamaChatRequest | null = null;
    const provider = {
      async chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
        capturedRequest = structuredClone(request);
        return {
          model: "deterministic-live-gate",
          message: {
            role: "assistant",
            content: "",
            thinking: "",
            tool_calls: [{
              type: "function",
              function: {
                name: "home.get_entity",
                arguments: { alias: capability.alias },
              },
            }],
          },
        };
      },
    };
    const execution = await runAssignedRole({
      run_id: "run:phase4b:real-read",
      interaction,
      plan,
      session: sessions.get("robot"),
      provider,
      robot_ha: { client: readView },
      timeout_ms: 10_000,
    });

    assert.equal(execution.status, "completed");
    assert.equal(execution.tool_results.length, 1);
    assert.equal(execution.tool_results[0]?.name, "home.get_entity");
    assert.equal(execution.tool_results[0]?.status, "success");
    assert.ok(capturedRequest !== null);
    const request = capturedRequest as OllamaChatRequest;
    assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["home.get_entity"]);
    const requestText = JSON.stringify(request);
    assert.equal(requestText.includes("entity_id"), false);
    assert.equal(requestText.includes("long_lived_access_token"), false);
    assert.equal(requestText.includes("Authorization"), false);
    for (const key of Object.keys(projected.attributes)) {
      assert.equal(requestText.includes(key), false);
    }
    const executionText = JSON.stringify(execution);
    assert.equal(executionText.includes("entity_id"), false);
    assert.equal(executionText.includes("long_lived_access_token"), false);
    const entityIds = config.policy.entities.map((entity) => entity.entity_id);
    const modelRequestContainsToken = requestText.includes(config.access_token);
    const modelRequestContainsEntityId = entityIds.some((entityId) => requestText.includes(entityId));
    const runtimeResultContainsToken = executionText.includes(config.access_token);
    const runtimeResultContainsEntityId = entityIds.some((entityId) => executionText.includes(entityId));
    assert.equal(modelRequestContainsToken, false);
    assert.equal(modelRequestContainsEntityId, false);
    assert.equal(runtimeResultContainsToken, false);
    assert.equal(runtimeResultContainsEntityId, false);
    assert.equal(perEntityStateRequests, activeClient.capabilities.length);
    assert.equal(fullStateRequests, 0);
    assert.equal(identityFrames.service_calls, 0);
    assert.equal(identityFrames.invalid, 0);
    assert.equal(robotFrames.service_calls, 0);
    assert.equal(robotFrames.invalid, 0);

    const evidence = {
      schema_version: 1,
      profile: "phase4b_real_read",
      passed: true,
      generated_at: new Date().toISOString(),
      git_sha: gitSha,
      agent_tree_sha: agentTreeSha,
      agent_tree_clean: true,
      role_profile_revision: getRoleProfile("robot").revision,
      robot_non_admin: true,
      robot_non_owner: true,
      connection_state: activeClient.state,
      policy_entities: activeClient.capabilities.length,
      per_entity_state_requests: perEntityStateRequests,
      full_state_requests: fullStateRequests,
      identity_outbound_frames: identityFrames.total,
      identity_service_calls_dispatched: identityFrames.service_calls,
      robot_outbound_frames: robotFrames.total,
      robot_service_calls_dispatched: robotFrames.service_calls,
      invalid_outbound_frames: identityFrames.invalid + robotFrames.invalid,
      write_client_exposed_to_runtime: false,
      model_turns: execution.model_turns,
      tools_exposed_to_model: request.tools?.map((tool) => tool.function.name) ?? [],
      tool_result_name: execution.tool_results[0]?.name ?? null,
      tool_result_status: execution.tool_results[0]?.status ?? null,
      projected_domain: projected.domain,
      projected_available: projected.available,
      projected_attribute_keys: Object.keys(projected.attributes).sort(),
      model_request_contains_entity_id: modelRequestContainsEntityId,
      model_request_contains_token: modelRequestContainsToken,
      runtime_result_contains_entity_id: runtimeResultContainsEntityId,
      runtime_result_contains_token: runtimeResultContainsToken,
    };
    await writeEvidence(resultFile, evidence);
    console.log(
      `VERIFY:phase4b:real_read:PASS profile=${evidence.role_profile_revision} tool=home.get_entity state_projected=yes`,
    );
  } finally {
    try {
      client?.close();
      const socket = transport.socket;
      const closed = transport.closed;
      if (socket !== null && closed !== null) {
        if (!(await closesWithin(closed, 250))) {
          socket.terminate();
          assert.equal(await closesWithin(closed, 250), true);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}

void main().catch(() => {
  console.error("VERIFY:phase4b:real_read:FAIL");
  process.exitCode = 1;
});
