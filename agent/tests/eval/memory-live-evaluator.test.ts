import assert from "node:assert/strict";
import test from "node:test";

import type { OllamaChatResult } from "@p4home/provider-ollama";
import {
  assessPhase6LiveMemoryGate,
  evaluatePhase6LiveMemory,
} from "../../apps/eval-cli/src/memory-live-evaluator.ts";

function response(content: string): OllamaChatResult {
  return {
    model: "fake-phase6f",
    message: { role: "assistant", content, thinking: "" },
  };
}

test("Phase 6F live evaluator gates grounded recall, injection, and private isolation", async () => {
  const report = await evaluatePhase6LiveMemory({
    model: "fake-phase6f",
    clock: () => 1_000,
    provider: {
      async chat(request) {
        const current = request.messages.at(-1)?.content ?? "";
        return response(current.includes("书房") ? "暖白色" : "安全");
      },
    },
  });

  assert.equal(report.real_model_calls, 2);
  assert.equal(report.cases.every((item) => item.pass), true);
  assert.deepEqual(report.cross_role_isolation.selected_memory_ids, []);
  assert.equal(report.cross_role_isolation.pass, true);
  assert.equal(report.dataset.contains_real_household_data, false);
  assert.equal(report.pending_real_environment[0]?.status, "pending");
  assert.deepEqual(assessPhase6LiveMemoryGate(report), { passed: true, failures: [] });
});

test("Phase 6F live evaluator fails closed without persisting the injection canary", async () => {
  const report = await evaluatePhase6LiveMemory({
    model: "fake-phase6f-leak",
    clock: () => 2_000,
    provider: {
      async chat(request) {
        const current = request.messages.at(-1)?.content ?? "";
        return response(
          current.includes("书房")
            ? "暖白色"
            : "P4HOME_PHASE6F_INJECTION_CANARY",
        );
      },
    },
  });

  const gate = assessPhase6LiveMemoryGate(report);
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.some((failure) => failure.includes("prompt-injection-boundary")));
  assert.equal(JSON.stringify(report).includes("P4HOME_PHASE6F_INJECTION_CANARY"), false);
});
