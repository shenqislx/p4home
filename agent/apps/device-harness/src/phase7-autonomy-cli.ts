import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  OllamaHttpProvider,
  type OllamaChatRequest,
  type OllamaChatResult,
} from "@p4home/provider-ollama";
import {
  DEFAULT_OLLAMA_MODEL,
  DeviceRuntimeHub,
  ProductCatAutonomyRuntime,
  RoleScheduler,
  parseProductCatAutonomyConfig,
  readCurrentIdentity,
  type ProductCatAutonomyExecutionRecord,
} from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import {
  RobotHaClient,
  createRobotHaWebSocket,
  loadRobotHaRuntimeConfig,
  type RobotHaProjectedState,
  type RobotHaSocketFactory,
} from "@p4home/transport-ha";

const TIMER_INTERVAL_MS = 60_000;
const STABILITY_OBSERVATION_MS = 60_000;
const MODEL_TIMEOUT_MS = 240_000;
const MODEL_PROBE_TIMEOUT_MS = 30_000;
const HARNESS_DEADLINE_MS = 1_200_000;
const RSS_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024;

interface FrameCounters {
  invalid: number;
  service_calls: number;
  total: number;
}

interface Phase7AutonomyResult {
  readonly schema_version: 1;
  readonly profile: "phase7_autonomy";
  readonly passed: boolean;
  readonly model: string;
  readonly real_model_calls: number;
  readonly protocol_version: 2;
  readonly timer_action_completed: boolean;
  readonly ha_projected_action_completed: boolean;
  readonly ha_projection_origin: "isolated_transition_from_real_allowlist_snapshot";
  readonly p4_actions_completed: number;
  readonly p4_reconnect_snapshot_verified: boolean;
  readonly p4_state_version: number;
  readonly ha_client_ready: boolean;
  readonly ha_policy_aliases: number;
  readonly agent_ha_service_calls_dispatched: number;
  readonly agent_ha_invalid_outbound_frames: number;
  readonly robot_non_admin: boolean;
  readonly robot_non_owner: boolean;
  readonly pause_blocked_model_calls: boolean;
  readonly disable_blocked_model_calls: boolean;
  readonly stability_observation_ms: number;
  readonly rss_peak_growth_bytes: number;
  readonly rss_growth_limit_bytes: number;
  readonly heap_peak_growth_bytes: number;
  readonly execution_terminal_records: number;
  readonly request_contains_ha_token: boolean;
  readonly request_contains_entity_id: boolean;
  readonly reason: "ok" | "gate_failed";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function positivePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid_agent_port");
  }
  return port;
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
  if (typeof type !== "string") counters.invalid += 1;
  if (type === "call_service") counters.service_calls += 1;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  reason: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (signal?.aborted === true) throw signal.reason;
    if (performance.now() >= deadline) throw new Error(reason);
    await delay(50, undefined, signal === undefined ? {} : { signal });
  }
}

function terminalFor(
  records: readonly ProductCatAutonomyExecutionRecord[],
  source: "timer" | "home_assistant",
): ProductCatAutonomyExecutionRecord | undefined {
  return records.find((record) =>
    record.source === source
    && record.decision === "terminal"
    && record.run_status === "completed"
    && record.outcome_status === "completed"
  );
}

function syntheticTransition(state: RobotHaProjectedState): RobotHaProjectedState {
  return {
    ...state,
    state: state.state === "phase7_probe" ? "phase7_probe_alt" : "phase7_probe",
    available: true,
    updated_at_ms: Date.now(),
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function safeReason(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    return String((error as { code: unknown }).code).slice(0, 64);
  }
  return error instanceof Error ? error.name.slice(0, 64) : "unknown_error";
}

async function main(): Promise<number> {
  if (requiredEnvironment("P4HOME_HARDWARE_PROFILE") !== "phase7_autonomy") {
    throw new Error("unsupported_hardware_profile");
  }
  const deviceId = requiredEnvironment("P4HOME_AGENT_DEVICE_ID");
  const deviceToken = (
    await readFile(requiredEnvironment("P4HOME_AGENT_DEVICE_TOKEN_FILE"), "utf8")
  ).trim();
  const key = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_KEY_FILE"));
  const cert = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_CERT_FILE"));
  const readyFile = requiredEnvironment("P4HOME_HARNESS_READY_FILE");
  const resultFile = requiredEnvironment("P4HOME_HARNESS_RESULT_FILE");
  const port = positivePort(requiredEnvironment("P4HOME_AGENT_PORT"));
  const haUrl = requiredEnvironment("P4HOME_PHASE7_HA_URL");
  const model = process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  assert.equal(model, DEFAULT_OLLAMA_MODEL, "phase7_model_override_forbidden");
  const hub = new DeviceRuntimeHub({
    server: {
      host: "0.0.0.0",
      port,
      tls: { key, cert },
      device_tokens: { [deviceId]: deviceToken },
      max_connections: 1,
    },
    adapter: { protocol_version: 2 },
    handshake_timeout_ms: 30_000,
  });
  const scheduler = new RoleScheduler();
  let autonomy: ProductCatAutonomyRuntime | null = null;
  let haClient: RobotHaClient | null = null;
  let deadlineTimer: NodeJS.Timeout | null = null;
  let memorySampler: NodeJS.Timeout | null = null;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    if (memorySampler !== null) clearInterval(memorySampler);
    await autonomy?.close();
    scheduler.close();
    haClient?.close();
    await hub.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());

  try {
    await hub.start();
    await writeFile(readyFile, "ready\n", { mode: 0o600 });
    process.stdout.write("HARNESS:phase7:agent_server:READY\n");
    const deadlineController = new AbortController();
    deadlineTimer = setTimeout(() => {
      const error = new Error("Phase 7 harness deadline elapsed");
      error.name = "Phase7HarnessDeadlineError";
      deadlineController.abort(error);
    }, HARNESS_DEADLINE_MS);

    const haConfig = await loadRobotHaRuntimeConfig({
      url: haUrl,
      token_file: requiredEnvironment("P4HOME_PHASE7_TOKEN_FILE"),
      policy_file: requiredEnvironment("P4HOME_PHASE7_POLICY_FILE"),
      allow_insecure_ws: haUrl.startsWith("http://") || haUrl.startsWith("ws://"),
    });
    const identity = await readCurrentIdentity(haUrl, haConfig.access_token);
    const frames: FrameCounters = { invalid: 0, service_calls: 0, total: 0 };
    const socketFactory: RobotHaSocketFactory = (url, maxFrameBytes) => {
      const socket = createRobotHaWebSocket(url, maxFrameBytes);
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
    haClient = new RobotHaClient({
      config: haConfig,
      socket_factory: socketFactory,
      handshake_timeout_ms: 10_000,
      request_timeout_ms: 10_000,
    });
    await haClient.connect();
    await haClient.ping();
    const realHaStates = haClient.listStates();
    assert.ok(realHaStates.length > 0, "phase7_ha_allowlist_empty");
    const selectedHaState = realHaStates[0]!;

    const probeProvider = new OllamaHttpProvider({
      model,
      requestTimeoutMs: MODEL_PROBE_TIMEOUT_MS,
    });
    const modelCapabilities = await probeProvider.probe(deadlineController.signal);
    assert.equal(modelCapabilities.modelAvailable, true, "phase7_model_unavailable");
    assert.equal(modelCapabilities.toolCalling, true, "phase7_model_tools_unavailable");
    const realProvider = new OllamaHttpProvider({
      model,
      requestTimeoutMs: MODEL_TIMEOUT_MS,
    });
    const capturedRequests: OllamaChatRequest[] = [];
    let realModelCalls = 0;
    const provider = {
      async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResult> {
        realModelCalls += 1;
        capturedRequests.push(structuredClone(request));
        const boundedSignal = signal === undefined
          ? deadlineController.signal
          : AbortSignal.any([signal, deadlineController.signal]);
        return await realProvider.chat(request, boundedSignal);
      },
    };
    let injectedHaListener: ((state: RobotHaProjectedState) => void) | null = null;
    const getInjectedHaListener = (): ((state: RobotHaProjectedState) => void) | null =>
      injectedHaListener;
    const isolatedHaProjection = {
      listStates: () => haClient?.listStates() ?? [],
      onState(listener: (state: RobotHaProjectedState) => void) {
        injectedHaListener = listener;
        return () => { injectedHaListener = null; };
      },
    };
    const rawConfig = {
      schema_version: 1,
      initial_mode: "paused",
      timer: {
        schedule_id: "phase7_real_timer",
        interval_ms: TIMER_INTERVAL_MS,
        room_target: "living_room",
      },
      ha_room_targets: {
        [selectedHaState.alias]: {
          domain: selectedHaState.domain,
          room_target: "study",
        },
      },
      task_room_targets: { human: "entry", robot: "study" },
      quiet_hours: null,
      daily_model_call_budget: 8,
      global_minimum_interval_ms: 0,
      source_minimum_interval_ms: {
        timer: 86_400_000,
        home_assistant: 0,
        p4_world: 0,
        runtime: 0,
      },
    };
    using store = new SqliteAuditStore(":memory:");
    autonomy = new ProductCatAutonomyRuntime({
      device_id: deviceId,
      device_hub: hub,
      ha_client: isolatedHaProjection,
      config: parseProductCatAutonomyConfig(rawConfig, realHaStates),
      provider,
      scheduler,
      audit_store: store,
      execution_audit_capacity: 128,
    });
    autonomy.start();
    await waitUntil(() => autonomy?.getStatus().product_ready === true, 180_000,
      "phase7_p4_handshake_timeout", deadlineController.signal);
    const adapter = hub.getAdapter(deviceId);
    assert.ok(adapter !== undefined, "phase7_device_adapter_missing");
    assert.equal(adapter.protocol_version, 2, "phase7_protocol_version_mismatch");
    const haProjectionListener = getInjectedHaListener();
    assert.ok(haProjectionListener !== null, "phase7_ha_projection_not_bound");
    const baselineMemory = process.memoryUsage();
    let peakRss = baselineMemory.rss;
    let peakHeap = baselineMemory.heapUsed;
    memorySampler = setInterval(() => {
      const sample = process.memoryUsage();
      peakRss = Math.max(peakRss, sample.rss);
      peakHeap = Math.max(peakHeap, sample.heapUsed);
    }, 1_000);
    memorySampler.unref();
    autonomy.setMode("enabled");
    process.stdout.write(
      `VERIFY:phase7:product_ready:PASS protocol=2 model=${model} ha_aliases=${realHaStates.length}\n`,
    );

    await waitUntil(() => terminalFor(autonomy?.listExecutionAudit(128) ?? [], "timer") !== undefined,
      MODEL_TIMEOUT_MS + TIMER_INTERVAL_MS + 30_000, "phase7_timer_action_timeout",
      deadlineController.signal);
    const timerRecord = terminalFor(autonomy.listExecutionAudit(128), "timer");
    assert.ok(timerRecord !== undefined);
    process.stdout.write(
      `VERIFY:phase7:timer_action:PASS action_id=${timerRecord.action_id} model_calls=${realModelCalls}\n`,
    );

    autonomy.setMode("paused");
    autonomy.setMode("enabled");
    haProjectionListener(syntheticTransition(selectedHaState));
    await waitUntil(() =>
      terminalFor(autonomy?.listExecutionAudit(128) ?? [], "home_assistant") !== undefined,
    MODEL_TIMEOUT_MS + 30_000, "phase7_ha_projection_action_timeout",
    deadlineController.signal);
    const haRecord = terminalFor(autonomy.listExecutionAudit(128), "home_assistant");
    assert.ok(haRecord !== undefined);
    process.stdout.write(
      "VERIFY:phase7:ha_projection_action:PASS "
      + "origin=isolated_transition_from_real_allowlist_snapshot\n",
    );

    const beforeReconnectVersion = adapter.last_snapshot?.state_version ?? 0;
    assert.equal(hub.server.disconnectDevice(deviceId), true, "phase7_disconnect_failed");
    await waitUntil(() => !adapter.is_ready, 10_000, "phase7_disconnect_timeout",
      deadlineController.signal);
    await waitUntil(() => adapter.is_ready, 60_000, "phase7_reconnect_timeout",
      deadlineController.signal);
    const reconnectVersion = adapter.last_snapshot?.state_version ?? 0;
    const reconnectVerified = reconnectVersion >= beforeReconnectVersion;
    assert.equal(reconnectVerified, true, "phase7_reconnect_snapshot_regressed");
    process.stdout.write(
      `VERIFY:phase7:p4_reconnect:PASS state_version=${reconnectVersion}\n`,
    );

    autonomy.setMode("paused");
    const callsBeforePause = realModelCalls;
    autonomy.taskCompletionSink()({
      run_id: "phase7-pause-probe",
      role_id: "human",
      outcome: "completed",
      occurred_at_ms: Date.now(),
    });
    await waitUntil(() => autonomy?.listAudit(128).some(
      (record) => record.reason === "AUTONOMY_PAUSED",
    ) === true, 5_000, "phase7_pause_rejection_timeout", deadlineController.signal);
    await delay(STABILITY_OBSERVATION_MS, undefined, { signal: deadlineController.signal });
    const pauseBlocked = realModelCalls === callsBeforePause;
    assert.equal(pauseBlocked, true, "phase7_pause_model_call_leak");

    autonomy.setMode("disabled");
    const callsBeforeDisable = realModelCalls;
    autonomy.taskCompletionSink()({
      run_id: "phase7-disable-probe",
      role_id: "robot",
      outcome: "completed",
      occurred_at_ms: Date.now(),
    });
    await waitUntil(() => autonomy?.listAudit(128).some(
      (record) => record.reason === "AUTONOMY_DISABLED",
    ) === true, 5_000, "phase7_disable_rejection_timeout", deadlineController.signal);
    await delay(STABILITY_OBSERVATION_MS, undefined, { signal: deadlineController.signal });
    const disableBlocked = realModelCalls === callsBeforeDisable;
    assert.equal(disableBlocked, true, "phase7_disable_model_call_leak");
    process.stdout.write(
      "VERIFY:phase7:pause_disable:PASS pause_seconds=60 disable_seconds=60 "
      + "model_calls_while_blocked=0\n",
    );

    await haClient.ping();
    if (memorySampler !== null) clearInterval(memorySampler);
    memorySampler = null;
    const finalMemory = process.memoryUsage();
    peakRss = Math.max(peakRss, finalMemory.rss);
    peakHeap = Math.max(peakHeap, finalMemory.heapUsed);
    const rssGrowth = Math.max(0, peakRss - baselineMemory.rss);
    const heapGrowth = Math.max(0, peakHeap - baselineMemory.heapUsed);
    const executionRecords = autonomy.listExecutionAudit(128);
    const terminalRecords = executionRecords.filter((record) =>
      record.decision === "terminal" && record.run_status === "completed"
    ).length;
    const requestText = JSON.stringify(capturedRequests);
    const entityIds = haConfig.policy.entities.map((entity) => entity.entity_id);
    const requestContainsToken = requestText.includes(haConfig.access_token);
    const requestContainsEntityId = entityIds.some((entityId) => requestText.includes(entityId));
    const resourceStable = rssGrowth <= RSS_GROWTH_LIMIT_BYTES && adapter.is_ready;
    const passed = realModelCalls === 2
      && terminalRecords === 2
      && frames.service_calls === 0
      && frames.invalid === 0
      && haClient.state === "ready"
      && identity.is_admin === false
      && identity.is_owner === false
      && pauseBlocked
      && disableBlocked
      && reconnectVerified
      && resourceStable
      && !requestContainsToken
      && !requestContainsEntityId;
    const result: Phase7AutonomyResult = {
      schema_version: 1,
      profile: "phase7_autonomy",
      passed,
      model,
      real_model_calls: realModelCalls,
      protocol_version: 2,
      timer_action_completed: timerRecord.outcome_status === "completed",
      ha_projected_action_completed: haRecord.outcome_status === "completed",
      ha_projection_origin: "isolated_transition_from_real_allowlist_snapshot",
      p4_actions_completed: terminalRecords,
      p4_reconnect_snapshot_verified: reconnectVerified,
      p4_state_version: reconnectVersion,
      ha_client_ready: haClient.state === "ready",
      ha_policy_aliases: realHaStates.length,
      agent_ha_service_calls_dispatched: frames.service_calls,
      agent_ha_invalid_outbound_frames: frames.invalid,
      robot_non_admin: identity.is_admin === false,
      robot_non_owner: identity.is_owner === false,
      pause_blocked_model_calls: pauseBlocked,
      disable_blocked_model_calls: disableBlocked,
      stability_observation_ms: STABILITY_OBSERVATION_MS * 2,
      rss_peak_growth_bytes: rssGrowth,
      rss_growth_limit_bytes: RSS_GROWTH_LIMIT_BYTES,
      heap_peak_growth_bytes: heapGrowth,
      execution_terminal_records: terminalRecords,
      request_contains_ha_token: requestContainsToken,
      request_contains_entity_id: requestContainsEntityId,
      reason: passed ? "ok" : "gate_failed",
    };
    await atomicJson(resultFile, result);
    process.stdout.write(
      `VERIFY:phase7:resource_stability:${resourceStable ? "PASS" : "FAIL"} `
      + `observation_seconds=120 rss_peak_growth_bytes=${rssGrowth} `
      + `rss_limit_bytes=${RSS_GROWTH_LIMIT_BYTES} p4_ready=${adapter.is_ready}\n`,
    );
    process.stdout.write(
      `VERIFY:phase7:ha_read_only:${frames.service_calls === 0 ? "PASS" : "FAIL"} `
      + `agent_service_calls=${frames.service_calls} agent_invalid_frames=${frames.invalid}\n`,
    );
    await close();
    process.stdout.write("HARNESS:phase7:agent_offline:STARTED\n");
    return passed ? 0 : 1;
  } finally {
    await close();
  }
}

void main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  process.stdout.write(
    `VERIFY:phase7:hardware_harness:FAIL reason=${safeReason(error)}\n`,
  );
  process.exitCode = 1;
});
