import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  OllamaHttpProvider,
  type OllamaChatRequest,
  type OllamaChatResult,
} from "@p4home/provider-ollama";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import {
  RobotHaClient,
  createRobotHaWebSocket,
  loadRobotHaRuntimeConfig,
  type RobotHaClientView,
  type RobotHaSocketFactory,
} from "@p4home/transport-ha";

import { DEFAULT_OLLAMA_MODEL } from "./model-config.ts";
import { readCurrentIdentity } from "./phase4c-ha-identity.ts";
import type { RoutePlan, UserTextInteraction } from "./role-contracts.ts";
import { createPrivateRoleMemoryRuntime } from "./role-memory.ts";
import { RoleSessionRegistry } from "./role-session.ts";
import { runAssignedRole } from "./role-runner.ts";

const execFileAsync = promisify(execFile);
const STALE_MEMORY_SIGNAL = "memory_stale_unknown";
const MEMORY_ID = "memory:phase6g:robot:stale-ha-state";

interface FrameCounters {
  invalid: number;
  service_calls: number;
  total: number;
}

interface Phase6gResult {
  readonly schema_version: 1;
  readonly profile: "phase6g_ha_memory_read";
  readonly passed: boolean;
  readonly generated_at: string;
  readonly git_sha: string;
  readonly worktree_clean: boolean;
  readonly worktree_status_sha256: string;
  readonly evidence_scope: "local_precommit" | "commit_bound";
  readonly model: string;
  readonly real_model_calls: number;
  readonly robot_non_admin: boolean;
  readonly robot_non_owner: boolean;
  readonly policy_entities: number;
  readonly memory_recall_status: string | null;
  readonly selected_memory_ids: readonly string[];
  readonly stale_memory_signal_in_final_text: boolean;
  readonly ha_projected_state_in_final_text: boolean;
  readonly tool_result_status: string | null;
  readonly service_calls_dispatched: number;
  readonly invalid_outbound_frames: number;
  readonly model_request_contains_token: boolean;
  readonly model_request_contains_entity_id: boolean;
  readonly runtime_result_contains_token: boolean;
  readonly runtime_result_contains_entity_id: boolean;
  readonly reason: string;
}

export interface Phase6gAssessmentInput {
  readonly execution_status: string;
  readonly memory_status: string | null;
  readonly selected_memory_ids: readonly string[];
  readonly real_model_calls: number;
  readonly tool_result_status: string | null;
  readonly stale_memory_signal_in_final_text: boolean;
  readonly ha_projected_state_in_final_text: boolean;
  readonly service_calls_dispatched: number;
  readonly invalid_outbound_frames: number;
  readonly model_request_contains_token: boolean;
  readonly model_request_contains_entity_id: boolean;
  readonly runtime_result_contains_token: boolean;
  readonly runtime_result_contains_entity_id: boolean;
}

export function assessPhase6gHaMemoryGate(input: Phase6gAssessmentInput): boolean {
  return input.execution_status === "completed"
    && input.memory_status === "ok"
    && input.selected_memory_ids.length === 1
    && input.selected_memory_ids[0] === MEMORY_ID
    && input.real_model_calls === 1
    && input.tool_result_status === "success"
    && !input.stale_memory_signal_in_final_text
    && input.ha_projected_state_in_final_text
    && input.service_calls_dispatched === 0
    && input.invalid_outbound_frames === 0
    && !input.model_request_contains_token
    && !input.model_request_contains_entity_id
    && !input.runtime_result_contains_token
    && !input.runtime_result_contains_entity_id;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment: ${name}`);
  return value;
}

function inspectFrame(frame: string, counters: FrameCounters): void {
  counters.total += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame) as unknown;
  } catch {
    counters.invalid += 1;
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    counters.invalid += 1;
    return;
  }
  const type = (parsed as Record<string, unknown>).type;
  if (typeof type !== "string") {
    counters.invalid += 1;
  } else if (type === "call_service") {
    counters.service_calls += 1;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<number> {
  const resultFile = requiredEnv("P4HOME_PHASE6G_RESULT_FILE");
  const url = (await readFile(requiredEnv("P4HOME_PHASE6G_HA_URL_FILE"), "utf8")).trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("invalid_ha_url");
  }
  const model = process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  const timeoutMs = Number(process.env.P4HOME_PHASE6G_TIMEOUT_MS ?? "300000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
    throw new Error("invalid_timeout");
  }
  const repoRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })).stdout.trim();
  const gitSha = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  })).stdout.trim();
  const worktreeStatus = (await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repoRoot, encoding: "utf8" },
  )).stdout;
  const worktreeClean = worktreeStatus.trim().length === 0;

  const config = await loadRobotHaRuntimeConfig({
    url,
    token_file: requiredEnv("P4HOME_PHASE6G_TOKEN_FILE"),
    policy_file: requiredEnv("P4HOME_PHASE6G_POLICY_FILE"),
    allow_insecure_ws: url.startsWith("http://"),
  });
  const identity = await readCurrentIdentity(url, config.access_token);
  const robotNonAdmin = identity.is_admin === false;
  const robotNonOwner = identity.is_owner === false;
  assert.equal(robotNonAdmin, true);
  assert.equal(robotNonOwner, true);

  const frames: FrameCounters = { invalid: 0, service_calls: 0, total: 0 };
  const socketFactory: RobotHaSocketFactory = (socketUrl, maxFrameBytes) => {
    const socket = createRobotHaWebSocket(socketUrl, maxFrameBytes);
    return {
      get is_open() { return socket.is_open; },
      send(frame) {
        inspectFrame(frame, frames);
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
  const client = new RobotHaClient({
    config,
    socket_factory: socketFactory,
    handshake_timeout_ms: 10_000,
    request_timeout_ms: 10_000,
  });

  let evidence: Phase6gResult | null = null;
  try {
    await client.connect();
    assert.equal(client.capabilities.length, 1);
    const capability = client.capabilities[0];
    assert.ok(capability !== undefined);
    const projected = client.getState(capability.alias);
    assert.ok(projected !== null);
    const readView: RobotHaClientView = Object.freeze({
      get state() { return client.state; },
      get capabilities() { return client.capabilities; },
      get metrics() { return client.metrics; },
      getState(alias: string) { return client.getState(alias); },
      listStates() { return client.listStates(); },
    });

    await using store = new SqliteAuditStore(":memory:");
    const nowMs = Date.now();
    const query = "查询已授权测试灯的当前状态";
    await store.createCanonicalMemory({
      schema_version: 1,
      memory_id: MEMORY_ID,
      kind: "task_outcome",
      content: `${query}：旧记录为 ${STALE_MEMORY_SIGNAL}。当前状态必须重新查询 HA。`,
      source: "task_execution",
      source_interaction_id: "interaction:phase6g:seed",
      confidence: 1,
      sensitivity: "normal",
      owner_role: "robot",
      visibility_scope: "owner_only",
      visible_to_roles: [],
      policy_revision: 1,
      tags: ["phase6g", "ha-truth"],
      created_at_ms: nowMs,
      expires_at_ms: null,
      idempotency_key: "phase6g:seed:stale-ha-state",
      subject_key: "phase6g:subject:ha-state",
    });
    const memory = createPrivateRoleMemoryRuntime({
      store,
      approved_policy_revision: 1,
      recall_timeout_ms: 5_000,
      clock: () => nowMs + 1,
    });
    const interaction: UserTextInteraction = {
      schema_version: 1,
      interaction_id: "interaction:phase6g:ha-memory-read",
      kind: "user_text",
      text: query,
      locale: "zh-CN",
      source: "simulator",
      received_at_ms: nowMs + 2,
    };
    const plan: RoutePlan = {
      schema_version: 1,
      route_plan_id: "route:phase6g:ha-memory-read",
      interaction_id: interaction.interaction_id,
      assignments: [{
        assignment_id: "assignment:phase6g:ha-memory-read",
        role_id: "robot",
        source_span: { start: 0, end: query.length },
        mode: "respond",
      }],
      reason: "model_robot",
      created_at_ms: nowMs + 3,
    };
    const sessions = new RoleSessionRegistry({
      robot: "session:phase6g:robot",
      human: "session:phase6g:human",
      cat: "session:phase6g:cat",
    }, () => nowMs + 4);
    const realProvider = new OllamaHttpProvider({ model, requestTimeoutMs: timeoutMs });
    const capabilities = await realProvider.probe();
    assert.equal(capabilities.modelAvailable, true);
    let capturedRequest: OllamaChatRequest | null = null;
    let realModelCalls = 0;
    const provider = {
      async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResult> {
        realModelCalls += 1;
        capturedRequest = structuredClone(request);
        return await realProvider.chat(request, signal);
      },
    };
    const execution = await runAssignedRole({
      run_id: "run:phase6g:ha-memory-read",
      interaction,
      plan,
      session: sessions.get("robot"),
      provider,
      robot_ha: { client: readView },
      timeout_ms: timeoutMs,
      memory,
    });
    const requestText = JSON.stringify(capturedRequest);
    const executionText = JSON.stringify(execution);
    const entityIds = config.policy.entities.map((entity) => entity.entity_id);
    const currentState = projected.available && typeof projected.state === "string"
      ? projected.state
      : "不可用";
    const selectedMemoryIds = execution.memory?.selected_memory_ids ?? [];
    const staleMemorySignalInFinalText = execution.final_text.includes(STALE_MEMORY_SIGNAL);
    const haProjectedStateInFinalText = execution.final_text.includes(currentState);
    const modelRequestContainsToken = requestText.includes(config.access_token);
    const modelRequestContainsEntityId = entityIds.some((entityId) => requestText.includes(entityId));
    const runtimeResultContainsToken = executionText.includes(config.access_token);
    const runtimeResultContainsEntityId = entityIds.some((entityId) => executionText.includes(entityId));
    const toolResultStatus = execution.tool_results[0]?.status ?? null;
    const passed = assessPhase6gHaMemoryGate({
      execution_status: execution.status,
      memory_status: execution.memory?.status ?? null,
      selected_memory_ids: selectedMemoryIds,
      real_model_calls: realModelCalls,
      tool_result_status: toolResultStatus,
      stale_memory_signal_in_final_text: staleMemorySignalInFinalText,
      ha_projected_state_in_final_text: haProjectedStateInFinalText,
      service_calls_dispatched: frames.service_calls,
      invalid_outbound_frames: frames.invalid,
      model_request_contains_token: modelRequestContainsToken,
      model_request_contains_entity_id: modelRequestContainsEntityId,
      runtime_result_contains_token: runtimeResultContainsToken,
      runtime_result_contains_entity_id: runtimeResultContainsEntityId,
    });
    evidence = {
      schema_version: 1,
      profile: "phase6g_ha_memory_read",
      passed,
      generated_at: new Date().toISOString(),
      git_sha: gitSha,
      worktree_clean: worktreeClean,
      worktree_status_sha256: hash(worktreeStatus),
      evidence_scope: worktreeClean ? "commit_bound" : "local_precommit",
      model,
      real_model_calls: realModelCalls,
      robot_non_admin: robotNonAdmin,
      robot_non_owner: robotNonOwner,
      policy_entities: client.capabilities.length,
      memory_recall_status: execution.memory?.status ?? null,
      selected_memory_ids: selectedMemoryIds,
      stale_memory_signal_in_final_text: staleMemorySignalInFinalText,
      ha_projected_state_in_final_text: haProjectedStateInFinalText,
      tool_result_status: toolResultStatus,
      service_calls_dispatched: frames.service_calls,
      invalid_outbound_frames: frames.invalid,
      model_request_contains_token: modelRequestContainsToken,
      model_request_contains_entity_id: modelRequestContainsEntityId,
      runtime_result_contains_token: runtimeResultContainsToken,
      runtime_result_contains_entity_id: runtimeResultContainsEntityId,
      reason: passed ? "ok" : "gate_failed",
    };
    await atomicJson(resultFile, evidence);
    process.stdout.write(
      `VERIFY:phase6g:ha_memory_truth:${passed ? "PASS" : "FAIL"} `
      + `model=${model} memory_selected=${selectedMemoryIds.length} `
      + `tool_status=${toolResultStatus ?? "none"} service_calls=${frames.service_calls}\n`,
    );
    return passed ? 0 : 1;
  } finally {
    client.close();
    if (evidence === null) {
      process.stdout.write("VERIFY:phase6g:ha_memory_truth:FAIL reason=exception\n");
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      void error;
      process.stderr.write("VERIFY:phase6g:ha_memory_truth:FAIL reason=unexpected_error\n");
      process.exitCode = 1;
    },
  );
}
