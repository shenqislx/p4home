import assert from "node:assert/strict";
import test from "node:test";

import type { RobotHaCapability, RobotHaWriteAction } from "@p4home/contracts";
import type { OllamaChatRequest, OllamaChatResult } from "@p4home/provider-ollama";
import {
  RoleSessionRegistry,
  createPrivateRoleMemoryRuntime,
  getRoleProfile,
  runAssignedRole,
  runRobotHaWrite,
  type RobotHaWriteAudit,
  type RoutePlan,
  type UserTextInteraction,
} from "@p4home/runtime";
import {
  SqliteAuditStore,
  type MemoryRecallResult,
} from "@p4home/storage-sqlite";
import type {
  RobotHaConnectionState,
  RobotHaMetrics,
  RobotHaProjectedState,
  RobotHaStateObservation,
  RobotHaWriteAttempt,
  RobotHaWriteClient,
} from "@p4home/transport-ha";

const CAPABILITIES: readonly RobotHaCapability[] = [
  {
    alias: "living_room_main_light",
    domain: "light",
    readable: true,
    write_actions: ["turn_on", "turn_off"],
  },
  {
    alias: "evening_scene",
    domain: "scene",
    readable: true,
    write_actions: ["activate_scene"],
  },
  {
    alias: "study_temperature",
    domain: "sensor",
    readable: true,
    write_actions: [],
  },
];

const METRICS: RobotHaMetrics = {
  connection_attempts: 1,
  successful_connections: 1,
  disconnects: 0,
  protocol_errors: 0,
  filtered_events: 0,
  state_events: 0,
  snapshot_loads: 1,
  pending_requests: 0,
  cached_entities: 3,
  last_ready_at_ms: 1_000,
  last_event_at_ms: null,
};

type WriteMode =
  | "completed"
  | "rejected"
  | "accepted_no_observation"
  | "pending"
  | "disconnect"
  | "stale_observation"
  | "wrong_generation"
  | "old_timestamp"
  | "mismatched_response"
  | "malformed_attempt";

class FakeWriteClient implements RobotHaWriteClient {
  public state: RobotHaConnectionState = "ready";
  public readonly capabilities = structuredClone(CAPABILITIES);
  public readonly metrics = { ...METRICS };
  public mode: WriteMode = "completed";
  public on_dispatch: (() => void) | undefined;
  public reconciliation_state: RobotHaProjectedState | null = null;
  public reconciliation_error = false;
  public reconciliation_pending = false;
  public reconciliation_late_reject = false;
  public on_reconcile: (() => void) | undefined;
  public reconciliations = 0;
  public readonly writes: { readonly alias: string; readonly action: RobotHaWriteAction; readonly id: number }[] = [];
  readonly #listeners = new Set<(state: RobotHaProjectedState) => void>();
  readonly #observationListeners = new Set<(observation: RobotHaStateObservation) => void>();
  readonly #states = new Map<string, RobotHaProjectedState>([
    ["living_room_main_light", {
      alias: "living_room_main_light",
      domain: "light",
      state: "off",
      available: true,
      attributes: { brightness: 0 },
      updated_at_ms: 1_000,
    }],
    ["evening_scene", {
      alias: "evening_scene",
      domain: "scene",
      state: "2026-08-21T00:00:00Z",
      available: true,
      attributes: {},
      updated_at_ms: 1_000,
    }],
    ["study_temperature", {
      alias: "study_temperature",
      domain: "sensor",
      state: "24.5",
      available: true,
      attributes: { unit_of_measurement: "°C" },
      updated_at_ms: 1_000,
    }],
  ]);
  #nextId = 10;
  #sequence = 0;

  public setState(state: RobotHaProjectedState): void {
    this.#states.set(state.alias, structuredClone(state));
  }

  public getState(alias: string): RobotHaProjectedState | null {
    const state = this.#states.get(alias);
    return state === undefined ? null : structuredClone(state);
  }

  public listStates(): readonly RobotHaProjectedState[] {
    return [...this.#states.values()].map((state) => structuredClone(state));
  }

  public onState(listener: (state: RobotHaProjectedState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public onObservation(listener: (observation: RobotHaStateObservation) => void): () => void {
    this.#observationListeners.add(listener);
    return () => this.#observationListeners.delete(listener);
  }

  public async reconcileState(alias: string, signal: AbortSignal): Promise<RobotHaProjectedState> {
    this.reconciliations += 1;
    this.on_reconcile?.();
    if (signal.aborted || this.reconciliation_error) {
      throw new Error("reconciliation unavailable");
    }
    if (this.reconciliation_late_reject) {
      return await new Promise<RobotHaProjectedState>((_resolve, reject) => {
        setImmediate(() => reject(new Error("late reconciliation failure")));
      });
    }
    if (this.reconciliation_pending) {
      return await new Promise<RobotHaProjectedState>(() => undefined);
    }
    const state = this.reconciliation_state ?? this.getState(alias);
    if (state === null) {
      throw new Error("missing reconciliation state");
    }
    return structuredClone(state);
  }

  public emitObservation(
    state: RobotHaProjectedState,
    cursor: { readonly connection_generation?: number; readonly sequence?: number } = {},
  ): void {
    const sequence = cursor.sequence ?? ++this.#sequence;
    this.#sequence = Math.max(this.#sequence, sequence);
    const observation: RobotHaStateObservation = {
      connection_generation: cursor.connection_generation ?? 1,
      sequence,
      source: "subscribed_state_changed",
      state: structuredClone(state),
    };
    this.setState(state);
    for (const listener of this.#listeners) {
      listener(structuredClone(state));
    }
    for (const listener of this.#observationListeners) {
      listener(structuredClone(observation));
    }
  }

  public notifyObservation(observation: RobotHaStateObservation): void {
    for (const listener of this.#observationListeners) {
      listener(structuredClone(observation));
    }
  }

  public beginWrite(alias: string, action: RobotHaWriteAction): RobotHaWriteAttempt {
    const id = this.#nextId++;
    const dispatch_cursor = { connection_generation: 1, sequence: this.#sequence };
    this.writes.push({ alias, action, id });
    this.on_dispatch?.();
    if (this.mode === "pending") {
      return { request_id: id, dispatch_cursor, response: new Promise(() => undefined) };
    }
    if (this.mode === "disconnect") {
      this.state = "disconnected";
      return { request_id: id, dispatch_cursor, response: Promise.reject(new Error("disconnected")) };
    }
    if (this.mode === "rejected") {
      return { request_id: id, dispatch_cursor, response: Promise.resolve({ request_id: id, accepted: false }) };
    }
    if (this.mode === "accepted_no_observation") {
      return { request_id: id, dispatch_cursor, response: Promise.resolve({ request_id: id, accepted: true }) };
    }
    const next: RobotHaProjectedState = action === "activate_scene"
      ? {
          alias,
          domain: "scene",
          state: "2026-08-21T00:00:01Z",
          available: true,
          attributes: {},
          updated_at_ms: 2_000,
        }
      : {
          alias,
          domain: "light",
          state: action === "turn_on" ? "on" : "off",
          available: true,
          attributes: { brightness: action === "turn_on" ? 120 : 0 },
          updated_at_ms: 2_000,
        };
    if (this.mode === "malformed_attempt") {
      return {
        request_id: id,
        dispatch_cursor: { connection_generation: 0, sequence: 0 },
        response: Promise.resolve({ request_id: id, accepted: true }),
      };
    }
    if (this.mode === "mismatched_response") {
      return {
        request_id: id,
        dispatch_cursor,
        response: Promise.resolve({ request_id: id + 1, accepted: true }),
      };
    }
    if (["stale_observation", "wrong_generation", "old_timestamp"].includes(this.mode)) {
      return {
        request_id: id,
        dispatch_cursor,
        response: new Promise((resolve) => queueMicrotask(() => {
          this.notifyObservation({
            connection_generation: this.mode === "wrong_generation" ? 2 : 1,
            sequence: this.mode === "stale_observation" ? dispatch_cursor.sequence : dispatch_cursor.sequence + 1,
            source: "subscribed_state_changed",
            state: this.mode === "old_timestamp" ? { ...next, updated_at_ms: 900 } : next,
          });
          resolve({ request_id: id, accepted: true });
        })),
      };
    }
    return {
      request_id: id,
      dispatch_cursor,
      response: new Promise((resolve) => queueMicrotask(() => {
        this.emitObservation(next);
        resolve({ request_id: id, accepted: true });
      })),
    };
  }
}

function interaction(id: string, text: string): UserTextInteraction {
  return {
    schema_version: 1,
    interaction_id: id,
    kind: "user_text",
    text,
    locale: "zh-CN",
    source: "simulator",
    received_at_ms: 1_000,
  };
}

function plan(value: UserTextInteraction): RoutePlan {
  return {
    schema_version: 1,
    route_plan_id: `route:${value.interaction_id}`,
    interaction_id: value.interaction_id,
    assignments: [{
      assignment_id: `assignment:${value.interaction_id}`,
      role_id: "robot",
      source_span: { start: 0, end: value.text.length },
      mode: "respond",
    }],
    reason: "model_robot",
    created_at_ms: 1_001,
  };
}

function sessions(): RoleSessionRegistry {
  return new RoleSessionRegistry({
    robot: "session:phase4c:robot",
    human: "session:phase4c:human",
    cat: "session:phase4c:cat",
  }, () => 900);
}

function toolResponse(name: string, alias: string): OllamaChatResult {
  return {
    model: "fake",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ type: "function", function: { name, arguments: { alias } } }],
    },
  };
}

function robotMemory(marker: string) {
  return createPrivateRoleMemoryRuntime({
    store: {
      async recallMemories(query): Promise<MemoryRecallResult> {
        return {
          items: [{
            schema_version: 1,
            memory_id: `memory-${marker}`,
            revision: 1,
            kind: "user_fact",
            content: `${query.query} ${marker}`,
            source: "user_explicit",
            source_interaction_id: "memory-source",
            confidence: 1,
            sensitivity: "normal",
            owner_role: "robot",
            visibility_scope: "owner_only",
            visible_to_roles: [],
            policy_revision: 2,
            tags: [],
            created_at_ms: 1,
            updated_at_ms: 1,
            expires_at_ms: null,
            idempotency_key: `idempotency-${marker}`,
            subject_key: `subject-${marker}`,
            supersedes_memory_id: null,
            recall_relevance: 1,
          }],
        };
      },
    },
    approved_policy_revision: 2,
    token_counter: { countTokens: () => 10 },
    clock: () => 1_000,
  });
}

async function run(
  id: string,
  client: FakeWriteClient,
  name: string,
  alias: string,
  options: { readonly signal?: AbortSignal; readonly audit?: SqliteAuditStore } = {},
) {
  const value = interaction(`interaction:${id}`, "执行家居动作");
  return await runAssignedRole({
    run_id: `run:${id}`,
    interaction: value,
    plan: plan(value),
    session: sessions().get("robot"),
    provider: { async chat(): Promise<OllamaChatResult> { return toolResponse(name, alias); } },
    robot_ha: { client, observation_timeout_ms: 100 },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.audit === undefined ? {} : { audit: { store: options.audit, clock: () => 1_100 } }),
  });
}

function directAudit(overrides: Partial<RobotHaWriteAudit> = {}): RobotHaWriteAudit {
  return {
    async modelRequested() {},
    async modelCompleted() {},
    async modelToolRejected() {},
    async toolCalls() {},
    async haPolicyDecision() {},
    async haReadRequested() {},
    async haWriteDispatched() {},
    async haWriteObservation() {},
    async haWriteOutcome() {},
    async toolResult() {},
    ...overrides,
  };
}

async function runDirect(
  id: string,
  client: FakeWriteClient,
  name: string,
  alias: string,
  audit: RobotHaWriteAudit,
  signal?: AbortSignal,
) {
  return await runRobotHaWrite({
    run_id: `run:${id}`,
    messages: [
      { role: "system", content: "Robot test" },
      { role: "user", content: "执行家居动作" },
    ],
    profile: getRoleProfile("robot"),
    provider: { async chat(): Promise<OllamaChatResult> { return toolResponse(name, alias); } },
    client,
    observation_timeout_ms: 100,
    audit,
    ...(signal === undefined ? {} : { signal }),
  });
}

test("Robot exposes only capability-derived low-risk tools and completes only after state observation", async () => {
  using store = new SqliteAuditStore(":memory:");
  const client = new FakeWriteClient();
  const requests: OllamaChatRequest[] = [];
  const value = interaction("interaction:phase4c:completed", "打开客厅灯");
  const result = await runAssignedRole({
    run_id: "run:phase4c:completed",
    interaction: value,
    plan: plan(value),
    session: sessions().get("robot"),
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        requests.push(request);
        return toolResponse("home.turn_on", "living_room_main_light");
      },
    },
    robot_ha: { client, observation_timeout_ms: 100 },
    audit: { store, clock: () => 1_100 },
    memory: robotMemory("robot-write-memory-marker"),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.tool_results[0]?.status, "success");
  assert.equal(result.tool_results[0]?.result.outcome, "completed");
  assert.equal(result.tool_results[0]?.result.request_id, 10);
  assert.equal(result.tool_results[0]?.result.replay_allowed, false);
  assert.deepEqual(client.writes, [{ alias: "living_room_main_light", action: "turn_on", id: 10 }]);
  assert.deepEqual(requests[0]?.tools?.map((tool) => tool.function.name), [
    "home.get_entity",
    "home.turn_on",
    "home.turn_off",
    "home.activate_scene",
  ]);
  const requestText = JSON.stringify(requests[0]);
  assert.equal(requestText.includes("entity_id"), false);
  assert.equal(requestText.includes("call_service"), false);
  assert.equal(requestText.includes("service_data"), false);
  assert.match(requestText, /robot-write-memory-marker/);
  assert.equal(result.memory?.status, "ok");
  const trace = await store.getRunTrace("run:phase4c:completed");
  assert.ok(trace !== null);
  assert.equal(JSON.stringify(trace).includes("robot-write-memory-marker"), false);
  assert.deepEqual(trace.events.map((event) => event.type), [
    "role.run.started",
    "role.model.requested",
    "role.model.completed",
    "role.tool.requested",
    "role.ha.policy_decided",
    "role.ha.write.dispatched",
    "role.ha.write.accepted",
    "role.ha.write.observed",
    "role.ha.write.completed",
    "role.tool.completed",
    "role.run.completed",
  ]);
  const observedEvent = trace.events.find((event) => event.type === "role.ha.write.observed");
  assert.equal(observedEvent?.payload.observation_source, "subscribed_state_changed");
  assert.equal(observedEvent?.payload.connection_generation, 1);
  assert.equal(observedEvent?.payload.observation_sequence, 1);
});

test("already-satisfied writes complete without sending a service request", async () => {
  using store = new SqliteAuditStore(":memory:");
  const client = new FakeWriteClient();
  client.setState({
    alias: "living_room_main_light",
    domain: "light",
    state: "on",
    available: true,
    attributes: { brightness: 120 },
    updated_at_ms: 1_000,
  });
  const result = await run(
    "phase4c:already",
    client,
    "home.turn_on",
    "living_room_main_light",
    { audit: store },
  );
  assert.equal(result.status, "completed");
  const toolResult = result.tool_results[0];
  assert.equal(toolResult?.status, "success");
  assert.equal(toolResult?.status === "success" ? toolResult.result.already_satisfied : null, true);
  assert.equal(toolResult?.status === "success" ? toolResult.result.request_id : "missing", null);
  assert.deepEqual(client.writes, []);
  const trace = await store.getRunTrace("run:phase4c:already");
  assert.ok(trace !== null);
  const observed = trace.events.find((event) => event.type === "role.ha.write.observed");
  assert.equal(observed?.payload.observation_source, "already_satisfied_cache");
  assert.deepEqual(trace.events.slice(-4).map((event) => event.type), [
    "role.ha.write.observed",
    "role.ha.write.completed",
    "role.tool.completed",
    "role.run.completed",
  ]);
});

test("HA rejection is distinct from completion and is never replayed", async () => {
  const client = new FakeWriteClient();
  client.mode = "rejected";
  const result = await run("phase4c:rejected", client, "home.turn_on", "living_room_main_light");
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HA_REJECTED");
  assert.equal(result.tool_results[0]?.error?.details?.outcome, "rejected");
  assert.equal(result.tool_results[0]?.error?.details?.replay_allowed, false);
  assert.match(result.final_text, /拒绝/);
  assert.equal(client.writes.length, 1);
});

test("accepted without state confirmation remains unknown and is not replayed", async () => {
  using store = new SqliteAuditStore(":memory:");
  const client = new FakeWriteClient();
  client.mode = "accepted_no_observation";
  const result = await run(
    "phase4c:unknown",
    client,
    "home.turn_on",
    "living_room_main_light",
    { audit: store },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
  assert.equal(result.tool_results[0]?.error?.details?.outcome, "unknown");
  assert.equal(result.tool_results[0]?.error?.details?.accepted, true);
  assert.equal(result.tool_results[0]?.error?.details?.replay_allowed, false);
  assert.equal(result.tool_results[0]?.error?.details?.reconciliation_attempted, true);
  assert.equal(result.tool_results[0]?.error?.details?.reconciliation_matches_target, false);
  assert.match(result.final_text, /不会自动重试/);
  assert.equal(client.writes.length, 1);
  assert.equal(client.reconciliations, 1);
  const trace = await store.getRunTrace("run:phase4c:unknown");
  assert.ok(trace !== null);
  assert.equal(trace.events.some((event) => event.type === "role.ha.write.accepted"), true);
  assert.equal(trace.events.some((event) => event.type === "role.ha.write.unknown"), true);
  assert.equal(trace.events.some((event) => event.type === "role.ha.write.completed"), false);
});

test("one reconciliation read can corroborate target state but cannot invent causal completion", async () => {
  using store = new SqliteAuditStore(":memory:");
  const client = new FakeWriteClient();
  client.mode = "accepted_no_observation";
  client.reconciliation_state = {
    alias: "living_room_main_light",
    domain: "light",
    state: "on",
    available: true,
    attributes: { brightness: 120 },
    updated_at_ms: 2_000,
  };
  const result = await run(
    "phase4c:reconciliation-match",
    client,
    "home.turn_on",
    "living_room_main_light",
    { audit: store },
  );
  assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
  assert.equal(result.tool_results[0]?.error?.details?.reconciliation_attempted, true);
  assert.equal(result.tool_results[0]?.error?.details?.reconciliation_matches_target, true);
  assert.equal(client.reconciliations, 1);
  const trace = await store.getRunTrace("run:phase4c:reconciliation-match");
  assert.ok(trace !== null);
  const reconciled = trace.events.find((event) =>
    event.type === "role.ha.write.observed"
    && event.payload.observation_source === "reconciliation_read"
  );
  assert.ok(reconciled !== undefined);
  assert.equal(trace.events.some((event) => event.type === "role.ha.write.completed"), false);
});

test("an uncooperative reconciliation read is bounded and attempted only once", async () => {
  const client = new FakeWriteClient();
  client.mode = "accepted_no_observation";
  client.reconciliation_pending = true;
  const started = Date.now();
  const result = await run(
    "phase4c:reconciliation-timeout",
    client,
    "home.turn_on",
    "living_room_main_light",
  );
  assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
  assert.equal(result.tool_results[0]?.error?.details?.reconciliation_attempted, true);
  assert.equal(result.tool_results[0]?.error?.details?.reconciliation_matches_target, null);
  assert.equal(client.reconciliations, 1);
  assert.equal(Date.now() - started < 1_000, true);
});

test("unknown audit failure cannot trigger a second reconciliation query", async () => {
  const client = new FakeWriteClient();
  client.mode = "accepted_no_observation";
  await assert.rejects(
    runDirect(
      "phase4c:reconciliation-audit-failure",
      client,
      "home.turn_on",
      "living_room_main_light",
      directAudit({
        async haWriteOutcome(_toolCallId, _alias, _action, _requestId, outcome) {
          if (outcome === "unknown") {
            throw new Error("audit unavailable");
          }
        },
      }),
    ),
    /audit unavailable/,
  );
  assert.equal(client.reconciliations, 1);
  assert.equal(client.writes.length, 1);
});

test("cancellation during reconciliation returns promptly and handles a late rejection", async () => {
  const client = new FakeWriteClient();
  const controller = new AbortController();
  client.mode = "accepted_no_observation";
  client.reconciliation_late_reject = true;
  client.on_reconcile = () => queueMicrotask(() => controller.abort());
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const result = await run(
      "phase4c:reconciliation-cancel",
      client,
      "home.turn_on",
      "living_room_main_light",
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
    assert.equal(result.tool_results[0]?.error?.details?.reconciliation_attempted, true);
    assert.equal(result.tool_results[0]?.error?.details?.reconciliation_matches_target, null);
    assert.equal(client.reconciliations, 1);
    assert.equal(client.writes.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("only a causally newer same-connection observation can prove completion", async () => {
  for (const mode of ["stale_observation", "wrong_generation", "old_timestamp"] as const) {
    const client = new FakeWriteClient();
    client.mode = mode;
    const result = await run(`phase4c:${mode}`, client, "home.turn_on", "living_room_main_light");
    assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN", mode);
    assert.equal(result.tool_results[0]?.status, "error", mode);
    assert.equal(client.writes.length, 1, mode);
  }
});

test("malformed attempts and mismatched response ids remain unknown after dispatch", async () => {
  for (const mode of ["malformed_attempt", "mismatched_response"] as const) {
    const client = new FakeWriteClient();
    client.mode = mode;
    const result = await run(`phase4c:${mode}`, client, "home.turn_on", "living_room_main_light");
    assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN", mode);
    assert.equal(result.tool_results[0]?.error?.details?.replay_allowed, false, mode);
    assert.equal(client.writes.length, 1, mode);
  }
});

test("response rejection is handled before a post-dispatch audit failure", async () => {
  const client = new FakeWriteClient();
  client.mode = "disconnect";
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const result = await runDirect(
      "phase4c:audit-failure",
      client,
      "home.turn_on",
      "living_room_main_light",
      directAudit({ async haWriteDispatched() { throw new Error("audit unavailable"); } }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("synchronous dispatch cancellation still handles a later response rejection", async () => {
  const client = new FakeWriteClient();
  const controller = new AbortController();
  client.mode = "disconnect";
  client.on_dispatch = () => controller.abort();
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const result = await run(
      "phase4c:cancel-reject",
      client,
      "home.turn_on",
      "living_room_main_light",
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("policy-audit cancellation wins over the already-satisfied no-op path", async () => {
  const client = new FakeWriteClient();
  client.setState({
    alias: "living_room_main_light",
    domain: "light",
    state: "on",
    available: true,
    attributes: { brightness: 120 },
    updated_at_ms: 1_000,
  });
  const controller = new AbortController();
  const result = await runDirect(
    "phase4c:no-op-cancel",
    client,
    "home.turn_on",
    "living_room_main_light",
    directAudit({ async haPolicyDecision() { controller.abort(); } }),
    controller.signal,
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "CANCELLED");
  assert.deepEqual(client.writes, []);
});

test("write runtime rechecks cancellation and connectivity after read audit", async () => {
  const cancelledClient = new FakeWriteClient();
  const controller = new AbortController();
  const cancelled = await runDirect(
    "phase4c:read-cancel",
    cancelledClient,
    "home.get_entity",
    "study_temperature",
    directAudit({ async haReadRequested() { controller.abort(); } }),
    controller.signal,
  );
  assert.equal(cancelled.error?.code, "CANCELLED");

  const disconnectedClient = new FakeWriteClient();
  const disconnected = await runDirect(
    "phase4c:read-disconnect",
    disconnectedClient,
    "home.get_entity",
    "study_temperature",
    directAudit({ async haReadRequested() { disconnectedClient.state = "disconnected"; } }),
  );
  assert.equal(disconnected.error?.code, "HA_OFFLINE");
});

test("cancellation after dispatch preserves unknown truth and sends exactly once", async () => {
  const controller = new AbortController();
  const client = new FakeWriteClient();
  client.mode = "pending";
  client.on_dispatch = () => controller.abort();
  const result = await run(
    "phase4c:cancelled",
    client,
    "home.turn_on",
    "living_room_main_light",
    { signal: controller.signal },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "HA_OUTCOME_UNKNOWN");
  assert.equal(result.tool_results[0]?.error?.details?.replay_allowed, false);
  assert.equal(client.writes.length, 1);
  assert.equal(client.reconciliations, 0);
});

test("disconnect after dispatch is unknown while unauthorized targets execute zero writes", async () => {
  const disconnected = new FakeWriteClient();
  disconnected.mode = "disconnect";
  const unknown = await run("phase4c:disconnect", disconnected, "home.turn_on", "living_room_main_light");
  assert.equal(unknown.error?.code, "HA_OUTCOME_UNKNOWN");
  assert.equal(disconnected.writes.length, 1);
  assert.equal(disconnected.reconciliations, 1);

  const unauthorized = new FakeWriteClient();
  const denied = await run("phase4c:denied", unauthorized, "home.turn_on", "study_temperature");
  assert.equal(denied.error?.code, "UNAUTHORIZED_HA_ACTION");
  assert.deepEqual(unauthorized.writes, []);
});

test("climate writes stay hidden and denied even when a capability tries to advertise them", async () => {
  const client = new FakeWriteClient();
  (client.capabilities as RobotHaCapability[]).push({
    alias: "bedroom_climate",
    domain: "climate",
    readable: true,
    write_actions: ["turn_on", "turn_off"],
  });
  const requests: OllamaChatRequest[] = [];
  const value = interaction("interaction:phase4c:climate", "打开卧室空调");
  const result = await runAssignedRole({
    run_id: "run:phase4c:climate",
    interaction: value,
    plan: plan(value),
    session: sessions().get("robot"),
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        requests.push(request);
        return toolResponse("home.turn_on", "bedroom_climate");
      },
    },
    robot_ha: { client, observation_timeout_ms: 100 },
  });
  assert.equal(result.error?.code, "UNAUTHORIZED_HA_ACTION");
  assert.deepEqual(client.writes, []);
  const context = requests[0]?.messages[0]?.content ?? "";
  const capabilityJson = context.split("当前能力：")[1]?.split("。只能原样选择")[0];
  assert.ok(capabilityJson !== undefined);
  const projected = JSON.parse(capabilityJson) as { alias: string; tools: string[] }[];
  assert.deepEqual(projected.find((item) => item.alias === "bedroom_climate")?.tools, ["home.get_entity"]);
});

test("an incomplete legacy write adapter fails closed to the read-only runtime", async () => {
  const client = new FakeWriteClient();
  const incomplete = {
    get state() { return client.state; },
    capabilities: client.capabilities,
    metrics: client.metrics,
    getState: client.getState.bind(client),
    listStates: client.listStates.bind(client),
    beginWrite: client.beginWrite.bind(client),
    onState: client.onState.bind(client),
    onObservation: client.onObservation.bind(client),
  };
  const value = interaction("interaction:phase4c:legacy-adapter", "打开客厅灯");
  const result = await runAssignedRole({
    run_id: "run:phase4c:legacy-adapter",
    interaction: value,
    plan: plan(value),
    session: sessions().get("robot"),
    provider: { async chat(): Promise<OllamaChatResult> {
      return toolResponse("home.turn_on", "living_room_main_light");
    } },
    robot_ha: { client: incomplete },
  });
  assert.equal(result.error?.code, "INVALID_HA_TOOL_CALL");
  assert.deepEqual(client.writes, []);
  assert.equal(client.reconciliations, 0);
});

test("multiple writes execute in model order and a rejection skips every later call", async () => {
  const completedClient = new FakeWriteClient();
  const value = interaction("interaction:phase4c:multi", "打开灯并激活场景");
  const completed = await runAssignedRole({
    run_id: "run:phase4c:multi",
    interaction: value,
    plan: plan(value),
    session: sessions().get("robot"),
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { type: "function", function: { name: "home.turn_on", arguments: { alias: "living_room_main_light" } } },
              { type: "function", function: { name: "home.activate_scene", arguments: { alias: "evening_scene" } } },
            ],
          },
        };
      },
    },
    robot_ha: { client: completedClient, observation_timeout_ms: 100 },
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completedClient.writes.map((write) => [write.alias, write.action, write.id]), [
    ["living_room_main_light", "turn_on", 10],
    ["evening_scene", "activate_scene", 11],
  ]);

  const rejectedClient = new FakeWriteClient();
  rejectedClient.mode = "rejected";
  const rejected = await runAssignedRole({
    run_id: "run:phase4c:multi-rejected",
    interaction: value,
    plan: { ...plan(value), route_plan_id: "route:phase4c:multi-rejected" },
    session: sessions().get("robot"),
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { type: "function", function: { name: "home.turn_on", arguments: { alias: "living_room_main_light" } } },
              { type: "function", function: { name: "home.activate_scene", arguments: { alias: "evening_scene" } } },
            ],
          },
        };
      },
    },
    robot_ha: { client: rejectedClient, observation_timeout_ms: 100 },
  });
  assert.equal(rejected.status, "failed");
  assert.equal(rejectedClient.writes.length, 1);
  assert.deepEqual(rejected.tool_results.map((result) => result.status === "error" ? result.error.code : "success"), [
    "HA_REJECTED",
    "CANCELLED",
  ]);
});

test("arbitrary high-risk tool names are rejected before policy or transport execution", async () => {
  using store = new SqliteAuditStore(":memory:");
  const client = new FakeWriteClient();
  const value = interaction("interaction:phase4c:high-risk", "解锁大门");
  const result = await runAssignedRole({
    run_id: "run:phase4c:high-risk",
    interaction: value,
    plan: plan(value),
    session: sessions().get("robot"),
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return toolResponse("home.unlock", "front_door");
      },
    },
    robot_ha: { client, observation_timeout_ms: 100 },
    audit: { store, clock: () => 1_100 },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "INVALID_HA_TOOL_CALL");
  assert.deepEqual(client.writes, []);
  const trace = await store.getRunTrace("run:phase4c:high-risk");
  assert.ok(trace !== null);
  assert.equal(trace.events.some((event) => event.type === "role.ha.policy_rejected"), true);
  assert.equal(trace.events.some((event) => event.type === "role.ha.write.dispatched"), false);
});
