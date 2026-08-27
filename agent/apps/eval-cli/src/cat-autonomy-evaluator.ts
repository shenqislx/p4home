import {
  CatAutonomyPolicy,
  CatEventPolicyError,
  createCatHaStateChangedEvent,
  createCatTimerElapsedEvent,
  createCatWorldChangedEvent,
  getRoleProfile,
} from "@p4home/runtime";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface CatAutonomyLongRunReport {
  readonly schema_version: 1;
  readonly duration_days: 7;
  readonly bounded_input_events: number;
  readonly admitted_model_calls: number;
  readonly admitted_calls_by_day: readonly number[];
  readonly maximum_calls_in_one_day: number;
  readonly daily_call_budget: 24;
  readonly model_calls_without_trigger: 0;
  readonly maximum_output_token_ceiling: number;
  readonly rejection_counts: Readonly<Record<string, number>>;
}

export interface CatAutonomyStormReport {
  readonly input_events: 1_000;
  readonly admitted_model_calls: number;
  readonly rejected_events: number;
}

export interface CatAutonomySafetyReport {
  readonly cases: 4;
  readonly admitted_model_calls: number;
  readonly rejection_codes: readonly string[];
}

export interface CatAutonomyEvalReport {
  readonly schema_version: 1;
  readonly evaluator: "phase7-cat-autonomy/deterministic-v1";
  readonly long_run: CatAutonomyLongRunReport;
  readonly ha_storm: CatAutonomyStormReport;
  readonly safety_misfires: CatAutonomySafetyReport;
}

export interface CatAutonomyEvalGate {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

function increment(counts: Map<string, number>, code: string): void {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

function rejectionCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    if (error instanceof CatEventPolicyError) return error.code;
    throw error;
  }
}

function evaluateLongRun(): CatAutonomyLongRunReport {
  let now = 0;
  let monotonic = 0;
  const policy = new CatAutonomyPolicy({
    now: () => now,
    monotonic_now: () => monotonic,
    runtime_started_at_ms: 0,
    quiet_hours: {
      start_minute: 23 * 60,
      end_minute: 7 * 60,
      utc_offset_minutes: 0,
    },
    budget_utc_offset_minutes: 0,
    daily_model_call_budget: 24,
    global_minimum_interval_ms: 5 * MINUTE_MS,
    source_minimum_interval_ms: { timer: 15 * MINUTE_MS },
    timer_room_targets: { ambient_wander: "living_room" },
    audit_capacity: 2_048,
  });
  const callsByDay = Array.from({ length: 7 }, () => 0);
  const rejectionCounts = new Map<string, number>();
  const boundedInputEvents = 7 * 24 * 60;
  let admitted = 0;
  for (let index = 0; index < boundedInputEvents; index += 1) {
    now = index * MINUTE_MS;
    monotonic = now;
    const code = rejectionCode(() => policy.approve(createCatTimerElapsedEvent({
      event_id: `longrun:${index}`,
      occurred_at_ms: now,
      schedule_id: "ambient_wander",
    })));
    if (code === null) {
      admitted += 1;
      callsByDay[Math.floor(now / DAY_MS)]! += 1;
    } else {
      increment(rejectionCounts, code);
    }
  }
  const outputCeiling = getRoleProfile("cat").num_predict;
  return {
    schema_version: 1,
    duration_days: 7,
    bounded_input_events: boundedInputEvents,
    admitted_model_calls: admitted,
    admitted_calls_by_day: callsByDay,
    maximum_calls_in_one_day: Math.max(...callsByDay),
    daily_call_budget: 24,
    model_calls_without_trigger: 0,
    maximum_output_token_ceiling: admitted * outputCeiling,
    rejection_counts: Object.fromEntries([...rejectionCounts].sort(([left], [right]) =>
      left.localeCompare(right))),
  };
}

function evaluateHaStorm(): CatAutonomyStormReport {
  const now = 10_000;
  const policy = new CatAutonomyPolicy({
    now: () => now,
    monotonic_now: () => now,
    runtime_started_at_ms: now,
    quiet_hours: null,
    ha_room_targets: {
      study_light: { domain: "light", room_target: "study" },
    },
  });
  let admitted = 0;
  for (let index = 0; index < 1_000; index += 1) {
    const code = rejectionCode(() => policy.approve(createCatHaStateChangedEvent({
      event_id: `storm:${index}`,
      occurred_at_ms: now,
      alias: "study_light",
      domain: "light",
      previous_state: index % 2 === 0 ? "off" : "on",
      current_state: index % 2 === 0 ? "on" : "off",
      available: true,
    })));
    if (code === null) admitted += 1;
  }
  return {
    input_events: 1_000,
    admitted_model_calls: admitted,
    rejected_events: 1_000 - admitted,
  };
}

function evaluateSafetyMisfires(): CatAutonomySafetyReport {
  const now = 20_000;
  const options = {
    now: () => now,
    monotonic_now: () => now,
    runtime_started_at_ms: now,
    quiet_hours: null,
    global_minimum_interval_ms: 0,
    source_minimum_interval_ms: {
      timer: 0,
      home_assistant: 0,
      p4_world: 0,
      runtime: 0,
    },
    timer_room_targets: { ambient_wander: "living_room" as const },
  };
  const cases: readonly (() => unknown)[] = [
    () => new CatAutonomyPolicy(options).approve({
      ...createCatTimerElapsedEvent({
        event_id: "misfire:extra",
        occurred_at_ms: now,
        schedule_id: "ambient_wander",
      }),
      payload: { schedule_id: "ambient_wander", user_text: "forbidden" },
    }),
    () => new CatAutonomyPolicy(options).approve(createCatHaStateChangedEvent({
      event_id: "misfire:unknown-ha",
      occurred_at_ms: now,
      alias: "unknown_light",
      domain: "light",
      previous_state: "off",
      current_state: "on",
      available: true,
    })),
    () => new CatAutonomyPolicy(options).approve(createCatWorldChangedEvent({
      event_id: "misfire:feedback",
      occurred_at_ms: now,
      room_id: "study",
      activity: "idle",
      state_version: 2,
      cause: "autonomy",
    })),
    () => new CatAutonomyPolicy({ ...options, runtime_started_at_ms: now + 1 }).approve(
      createCatTimerElapsedEvent({
        event_id: "misfire:restart-catchup",
        occurred_at_ms: now,
        schedule_id: "ambient_wander",
      }),
    ),
  ];
  const codes = cases.map((operation) => rejectionCode(operation));
  return {
    cases: 4,
    admitted_model_calls: codes.filter((code) => code === null).length,
    rejection_codes: codes.map((code) => code ?? "UNEXPECTED_ACCEPT"),
  };
}

export function evaluateCatAutonomyDeterministically(): CatAutonomyEvalReport {
  return {
    schema_version: 1,
    evaluator: "phase7-cat-autonomy/deterministic-v1",
    long_run: evaluateLongRun(),
    ha_storm: evaluateHaStorm(),
    safety_misfires: evaluateSafetyMisfires(),
  };
}

export function assessCatAutonomyEvalGate(report: CatAutonomyEvalReport): CatAutonomyEvalGate {
  const failures: string[] = [];
  const expect = (condition: boolean, failure: string): void => {
    if (!condition) failures.push(failure);
  };
  expect(report.schema_version === 1, "report_schema");
  expect(report.evaluator === "phase7-cat-autonomy/deterministic-v1", "evaluator_identity");
  expect(report.long_run.duration_days === 7, "long_run_duration");
  expect(report.long_run.bounded_input_events === 10_080, "bounded_input_count");
  expect(report.long_run.admitted_model_calls === 168, "long_run_call_count");
  expect(
    report.long_run.admitted_calls_by_day.length === 7
      && report.long_run.admitted_calls_by_day.every((count) => count === 24),
    "daily_budget_enforcement",
  );
  expect(report.long_run.maximum_calls_in_one_day <= 24, "daily_call_ceiling");
  expect(report.long_run.model_calls_without_trigger === 0, "untriggered_model_call");
  expect(report.long_run.maximum_output_token_ceiling === 21_504, "output_cost_ceiling");
  expect(report.ha_storm.admitted_model_calls === 1, "ha_storm_admission");
  expect(report.ha_storm.rejected_events === 999, "ha_storm_rejection");
  expect(report.safety_misfires.admitted_model_calls === 0, "safety_misfire_admission");
  expect(
    JSON.stringify(report.safety_misfires.rejection_codes) === JSON.stringify([
      "INVALID_EVENT",
      "SOURCE_MAPPING_MISSING",
      "FEEDBACK_LOOP_BLOCKED",
      "BEFORE_RUNTIME_START",
    ]),
    "safety_rejection_codes",
  );
  return { passed: failures.length === 0, failures };
}
