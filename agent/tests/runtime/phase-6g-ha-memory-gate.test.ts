import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPhase6gHaMemoryGate,
  type Phase6gAssessmentInput,
} from "../../apps/runtime/src/phase6g-ha-memory-gate.ts";

const passing: Phase6gAssessmentInput = {
  execution_status: "completed",
  memory_status: "ok",
  selected_memory_ids: ["memory:phase6g:robot:stale-ha-state"],
  real_model_calls: 1,
  tool_result_status: "success",
  stale_memory_signal_in_final_text: false,
  ha_projected_state_in_final_text: true,
  service_calls_dispatched: 0,
  invalid_outbound_frames: 0,
  model_request_contains_token: false,
  model_request_contains_entity_id: false,
  runtime_result_contains_token: false,
  runtime_result_contains_entity_id: false,
};

test("Phase 6G HA Memory gate accepts only a read-only HA-truth result", () => {
  assert.equal(assessPhase6gHaMemoryGate(passing), true);
  const mutations: readonly Phase6gAssessmentInput[] = [
    { ...passing, selected_memory_ids: [] },
    { ...passing, stale_memory_signal_in_final_text: true },
    { ...passing, ha_projected_state_in_final_text: false },
    { ...passing, service_calls_dispatched: 1 },
    { ...passing, model_request_contains_token: true },
    { ...passing, runtime_result_contains_entity_id: true },
  ];
  for (const mutation of mutations) {
    assert.equal(assessPhase6gHaMemoryGate(mutation), false);
  }
});
