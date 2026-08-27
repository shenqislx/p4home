import assert from "node:assert/strict";
import test from "node:test";

import {
  CatAutonomyPolicy,
  CatAutonomySourceBridge,
  CatAutonomyIngressError,
  CatEventPolicyError,
  createCatHaStateChangedEvent,
  createCatTaskCompletedEvent,
  createCatTimerElapsedEvent,
  createCatWorldChangedEvent,
  getRoleProfile,
  buildRoleContext,
  type CatAutonomyEvent,
} from "@p4home/runtime";

function policyOptions(now: () => number, monotonicNow: () => number = now) {
  return {
    now,
    monotonic_now: monotonicNow,
    runtime_started_at_ms: now(),
    quiet_hours: null,
    global_minimum_interval_ms: 0,
    source_minimum_interval_ms: {
      timer: 0,
      home_assistant: 0,
      p4_world: 0,
      runtime: 0,
    },
    timer_room_targets: { ambient_wander: "study" as const },
    ha_room_targets: {
      study_light: { domain: "light", room_target: "study" as const },
    },
    task_room_targets: {
      human: "living_room" as const,
      robot: "entry" as const,
    },
  };
}

test("Phase 7 policy accepts the four exact trigger schemas and projects one minimal room action", () => {
  let now = 1_000;
  const policy = new CatAutonomyPolicy(policyOptions(() => now));
  const events = [
    createCatTimerElapsedEvent({
      event_id: "timer-1",
      occurred_at_ms: now,
      schedule_id: "ambient_wander",
    }),
    createCatHaStateChangedEvent({
      event_id: "ha-1",
      occurred_at_ms: ++now,
      alias: "study_light",
      domain: "light",
      previous_state: "off",
      current_state: "on",
      available: true,
    }),
    createCatWorldChangedEvent({
      event_id: "world-1",
      occurred_at_ms: ++now,
      room_id: "kitchen",
      activity: "idle",
      state_version: 7,
      cause: "local_fallback",
    }),
    createCatTaskCompletedEvent({
      event_id: "task-1",
      occurred_at_ms: ++now,
      role_id: "robot",
      outcome: "completed",
    }),
  ];
  const approved = events.map((event) => policy.approve(event));
  assert.deepEqual(approved.map((event) => [event.event_type, event.source, event.arguments]), [
    ["timer.elapsed", "timer", { room_id: "study" }],
    ["ha.state_changed", "home_assistant", { room_id: "study" }],
    ["world.changed", "p4_world", { room_id: "kitchen" }],
    ["task.completed", "runtime", { room_id: "entry" }],
  ]);
  assert.deepEqual(approved.map((event) => Object.keys(event.payload)), [
    ["room_target"],
    ["room_target"],
    ["room_target"],
    ["room_target"],
  ]);
  assert.equal(policy.getStatus().admitted_model_calls_today, 4);
});

test("Cat role v6 accepts normalized autonomy data but still rejects original user text", () => {
  const profile = getRoleProfile("cat");
  assert.equal(profile.revision, "role-profile/v6");
  assert.equal(profile.accepts_user_text, false);
  assert.equal(profile.allowed_tools.some((tool) => tool.startsWith("home.")), false);
  const context = buildRoleContext(profile, {
    kind: "normalized_event",
    event_type: "ha.state_changed",
    payload: { room_target: "study" },
  });
  assert.equal(context[1]?.content.includes("ha.state_changed"), true);
  assert.equal(context[1]?.content.includes("study"), true);
  assert.throws(() => buildRoleContext(profile, {
    kind: "user_text",
    text: "打开灯，然后把这句话告诉 Cat",
    source_span: { start: 0, end: 15 },
    mode: "respond",
  }), /cannot receive original user text/);
});

test("policy rejects extra HA fields, unknown mappings, and autonomy feedback loops", () => {
  const now = 2_000;
  const policy = new CatAutonomyPolicy(policyOptions(() => now));
  const ha = createCatHaStateChangedEvent({
    event_id: "ha-extra",
    occurred_at_ms: now,
    alias: "study_light",
    domain: "light",
    previous_state: "off",
    current_state: "on",
    available: true,
  });
  assert.throws(
    () => policy.approve({ ...ha, payload: { ...ha.payload, entity_id: "light.secret" } }),
    (error) => error instanceof CatEventPolicyError && error.code === "INVALID_EVENT",
  );
  assert.throws(
    () => policy.approve({ ...ha, event_id: "ha-domain", payload: { ...ha.payload, domain: "switch" } }),
    (error) => error instanceof CatEventPolicyError && error.code === "SOURCE_MAPPING_MISSING",
  );
  assert.throws(
    () => policy.approve(createCatWorldChangedEvent({
      event_id: "world-loop",
      occurred_at_ms: now,
      room_id: "study",
      activity: "idle",
      state_version: 8,
      cause: "autonomy",
    })),
    (error) => error instanceof CatEventPolicyError && error.code === "FEEDBACK_LOOP_BLOCKED",
  );
});

test("pause, disable, quiet hours, staleness, and restart catch-up all fail closed", () => {
  const trigger = createCatTimerElapsedEvent({
    event_id: "timer-gated",
    occurred_at_ms: 10_000,
    schedule_id: "ambient_wander",
  });
  const paused = new CatAutonomyPolicy({ ...policyOptions(() => 10_000), mode: "paused" });
  assert.throws(
    () => paused.approve(trigger),
    (error) => error instanceof CatEventPolicyError && error.code === "AUTONOMY_PAUSED",
  );
  paused.setMode("disabled");
  assert.throws(
    () => paused.approve({ ...trigger, event_id: "timer-disabled" }),
    (error) => error instanceof CatEventPolicyError && error.code === "AUTONOMY_DISABLED",
  );
  const quiet = new CatAutonomyPolicy({
    ...policyOptions(() => 10_000),
    quiet_hours: { start_minute: 0, end_minute: 1, utc_offset_minutes: 0 },
  });
  assert.throws(
    () => quiet.approve({ ...trigger, event_id: "timer-quiet" }),
    (error) => error instanceof CatEventPolicyError && error.code === "QUIET_HOURS",
  );
  const restarted = new CatAutonomyPolicy({
    ...policyOptions(() => 20_000),
    runtime_started_at_ms: 20_000,
  });
  assert.throws(
    () => restarted.approve({ ...trigger, event_id: "timer-before-start" }),
    (error) => error instanceof CatEventPolicyError && error.code === "BEFORE_RUNTIME_START",
  );
  const stale = new CatAutonomyPolicy({
    ...policyOptions(() => 100_000),
    runtime_started_at_ms: 0,
    max_age_ms: 1_000,
  });
  assert.throws(
    () => stale.approve({ ...trigger, event_id: "timer-stale" }),
    (error) => error instanceof CatEventPolicyError && error.code === "STALE_EVENT",
  );
});

test("dedupe, global/source limits, and daily model admissions are bounded and auditable", () => {
  let now = 1_000;
  let monotonic = 1_000;
  const policy = new CatAutonomyPolicy({
    ...policyOptions(() => now, () => monotonic),
    daily_model_call_budget: 2,
    global_minimum_interval_ms: 10,
    source_minimum_interval_ms: {
      timer: 20,
      home_assistant: 0,
      p4_world: 0,
      runtime: 0,
    },
  });
  const timer = (id: string) => createCatTimerElapsedEvent({
    event_id: id,
    occurred_at_ms: now,
    schedule_id: "ambient_wander",
  });
  policy.approve(timer("budget-1"));
  assert.throws(
    () => policy.approve(timer("budget-1")),
    (error) => error instanceof CatEventPolicyError && error.code === "DUPLICATE_EVENT",
  );
  monotonic += 10;
  now += 10;
  assert.throws(
    () => policy.approve(timer("source-limited")),
    (error) => error instanceof CatEventPolicyError && error.code === "SOURCE_RATE_LIMITED",
  );
  monotonic += 10;
  now += 10;
  policy.approve(timer("budget-2"));
  monotonic += 20;
  now += 20;
  assert.throws(
    () => policy.approve(timer("budget-3")),
    (error) => error instanceof CatEventPolicyError && error.code === "DAILY_BUDGET_EXHAUSTED",
  );
  const status = policy.getStatus();
  assert.equal(status.remaining_model_calls_today, 0);
  assert.equal(status.accepted_triggers, 2);
  assert.equal(status.rejected_triggers, 3);
  assert.deepEqual(policy.listAudit(2).map((record) => record.reason), [
    "DAILY_BUDGET_EXHAUSTED",
    "POLICY_APPROVED",
  ]);
});

function completedResult(event: CatAutonomyEvent) {
  return {
    run_id: `run:${event.event_id}`,
    role_id: "cat" as const,
    status: "completed" as const,
    event_id: event.event_id,
    tool_call_id: `tool:${event.event_id}`,
    action_id: `action:${event.event_id}`,
    model_turns: 1 as const,
    outcome: {
      status: "completed" as const,
      action_id: `action:${event.event_id}`,
      tool: "character.go_to_room" as const,
      state_version: 1,
      result: { room_id: "study" },
      source: "lifecycle" as const,
    },
  };
}

test("event-driven source bridge projects HA, World and task completion without a polling loop", async () => {
  let now = 5_000;
  const observed: CatAutonomyEvent[] = [];
  const terminalSources: string[] = [];
  const bridge = new CatAutonomySourceBridge({
    runtime: {
      async handle(event) {
        observed.push(structuredClone(event));
        return completedResult(event);
      },
    },
    clock: () => now,
    on_result: (_result, event) => terminalSources.push(event.source),
  });

  await bridge.emitTimer("ambient_wander");
  let haListener: ((state: {
    alias: string;
    domain: "light";
    state: string | null;
    available: boolean;
    attributes: Record<string, never>;
    updated_at_ms: number;
  }) => void) | undefined;
  const detachHa = bridge.bindHa({
    listStates: () => [{
      alias: "study_light",
      domain: "light",
      state: "off",
      available: true,
      attributes: {},
      updated_at_ms: now - 1,
    }],
    onState(listener) {
      haListener = listener;
      return () => { haListener = undefined; };
    },
  }, new Set(["study_light"]));
  haListener?.({
    alias: "unmapped_light",
    domain: "light",
    state: "on",
    available: true,
    attributes: {},
    updated_at_ms: now,
  });
  assert.equal(observed.length, 1);
  now += 1;
  haListener?.({
    alias: "study_light",
    domain: "light",
    state: "on",
    available: true,
    attributes: {},
    updated_at_ms: now,
  });

  let worldListener: ((observation: {
    state_version: number;
    observed_at_ms: number;
    character: {
      room_id: "study";
      activity: "idle";
      speaking: false;
      active_action_id: string;
    };
    previous_active_action_id: string | null;
  }) => void) | undefined;
  const detachWorld = bridge.bindWorld({
    onWorldChanged(listener) {
      worldListener = listener;
      return () => { worldListener = undefined; };
    },
    getAction: () => ({
      request: {
        action_id: "cat-action",
        tool: "character.go_to_room",
        arguments: { room_id: "study" },
        timeout_ms: 1_000,
        origin: "autonomy",
      },
      status: "started",
      baseline_state_version: 1,
      outcome: null,
      timing: {
        accepted_latency_ms: 1,
        started_latency_ms: 2,
        terminal_latency_ms: null,
      },
    }),
  });
  now += 1;
  worldListener?.({
    state_version: 2,
    observed_at_ms: now,
    character: {
      room_id: "study",
      activity: "idle",
      speaking: false,
      active_action_id: "cat-action",
    },
    previous_active_action_id: null,
  });
  now += 1;
  bridge.taskCompletionSink()({
    run_id: "human-run",
    role_id: "human",
    outcome: "completed",
    occurred_at_ms: now,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(observed.map((event) => event.event_type), [
    "timer.elapsed",
    "ha.state_changed",
    "world.changed",
    "task.completed",
  ]);
  assert.deepEqual(observed[1]?.payload, {
    alias: "study_light",
    domain: "light",
    previous_state: "off",
    current_state: "on",
    available: true,
  });
  const world = observed[2];
  assert.equal(world?.event_type, "world.changed");
  if (world?.event_type !== "world.changed") throw new Error("missing World trigger");
  assert.equal(world.payload.cause, "autonomy");
  assert.deepEqual(observed[3]?.payload, {
    role_id: "human",
    outcome: "completed",
    task_kind: "conversation",
  });
  assert.equal(JSON.stringify(observed).includes("用户原文"), false);
  assert.deepEqual(terminalSources, ["timer", "home_assistant", "p4_world", "runtime"]);
  detachHa();
  detachWorld();
  await bridge.close();
});

test("source bridge bounds concurrent ingress before starting a second Cat run", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bridge = new CatAutonomySourceBridge({
    runtime: {
      async handle(event) {
        await gate;
        return completedResult(event);
      },
    },
    clock: () => 9_000,
    max_inflight: 1,
  });
  const first = bridge.emitTimer("first");
  assert.equal(bridge.inflight_count, 1);
  await assert.rejects(
    bridge.emitTimer("second"),
    (error) => error instanceof CatAutonomyIngressError && error.code === "INGRESS_FULL",
  );
  release();
  await first;
  assert.equal(bridge.inflight_count, 0);
  await bridge.close();
  await assert.rejects(
    bridge.emitTimer("after-close"),
    (error) => error instanceof CatAutonomyIngressError && error.code === "INGRESS_CLOSED",
  );
});

test("autonomy decision audit remains bounded under rejected-event floods", () => {
  const now = 12_000;
  const policy = new CatAutonomyPolicy({
    ...policyOptions(() => now),
    audit_capacity: 32,
  });
  for (let index = 0; index < 100; index += 1) {
    assert.throws(
      () => policy.approve({ invalid: index }),
      (error) => error instanceof CatEventPolicyError && error.code === "INVALID_EVENT",
    );
  }
  const audit = policy.listAudit(32);
  assert.equal(audit.length, 32);
  assert.equal(audit[0]?.sequence, 100);
  assert.equal(audit[31]?.sequence, 69);
  assert.equal(policy.getStatus().rejected_triggers, 100);
});
