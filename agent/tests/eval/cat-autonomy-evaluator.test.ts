import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCatAutonomyEvalGate,
  evaluateCatAutonomyDeterministically,
} from "../../apps/eval-cli/src/cat-autonomy-evaluator.ts";

test("Phase 7 deterministic long-run gate bounds frequency, cost, storms and misfires", () => {
  const report = evaluateCatAutonomyDeterministically();
  const gate = assessCatAutonomyEvalGate(report);
  assert.equal(gate.passed, true, gate.failures.join(", "));
  assert.deepEqual(report.long_run.admitted_calls_by_day, [24, 24, 24, 24, 24, 24, 24]);
  assert.equal(report.long_run.rejection_counts.QUIET_HOURS, 3_360);
  assert.equal(report.long_run.maximum_output_token_ceiling, 21_504);
  assert.equal(report.ha_storm.admitted_model_calls, 1);
  assert.equal(report.safety_misfires.admitted_model_calls, 0);
});

test("each Phase 7 gate metric independently reports its regression", () => {
  const report = evaluateCatAutonomyDeterministically();
  for (const [failure, mutation] of [
    ["long_run_call_count", { long_run: { ...report.long_run, admitted_model_calls: 169 } }],
    ["daily_call_ceiling", { long_run: { ...report.long_run, maximum_calls_in_one_day: 25 } }],
    ["untriggered_model_call", { long_run: { ...report.long_run, model_calls_without_trigger: 1 } }],
    ["ha_storm_admission", { ha_storm: { ...report.ha_storm, admitted_model_calls: 2 } }],
    ["safety_misfire_admission", {
      safety_misfires: { ...report.safety_misfires, admitted_model_calls: 1 },
    }],
  ] as const) {
    const mutated = { ...report, ...mutation } as typeof report;
    const gate = assessCatAutonomyEvalGate(mutated);
    assert.equal(gate.passed, false);
    assert.equal(gate.failures.includes(failure), true, failure);
  }
});
