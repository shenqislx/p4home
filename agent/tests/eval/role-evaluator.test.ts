import assert from "node:assert/strict";
import test from "node:test";

import {
  assessRoleEvalGate,
  evaluateRoleRuntime,
  ROUTER_EVAL_SCENARIOS,
} from "@p4home/eval-cli";
import type {
  OllamaChatRequest,
  OllamaChatResult,
} from "@p4home/provider-ollama";

function routerDecision(text: string): string {
  const scenario = ROUTER_EVAL_SCENARIOS.find((item) => item.text === text);
  assert.ok(scenario !== undefined);
  return scenario.expected_mode === "clarify"
    ? JSON.stringify({ assignments: [{ role: "clarify", text }] })
    : JSON.stringify({ assignments: [{
        role: scenario.expected_role,
        text,
      }] });
}

test("role evaluator emits four separate reports without an aggregate score", async () => {
  const requests: OllamaChatRequest[] = [];
  let tick = 0;
  const report = await evaluateRoleRuntime({
    model: "fake-role-model",
    repeat: 1,
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        requests.push(request);
        const text = request.messages.at(-1)?.content ?? "";
        const router = request.messages[0]?.content.includes("Role Router") === true;
        const content = router
          ? routerDecision(text)
          : text.includes("顺便")
            ? "你希望我先回应心情，还是说明要处理的设备？"
            : "这是一个简短且没有工具调用的 Human 回复。";
        return {
          model: "fake-role-model",
          message: { role: "assistant", content, thinking: "" },
        };
      },
    },
    clock: () => {
      tick += 1;
      return tick * 10;
    },
    wall_clock: () => 1_000,
  });

  assert.equal(report.config.aggregate_score, null);
  assert.deepEqual(Object.keys(report.reports), ["router", "human", "robot", "cat"]);
  assert.deepEqual(report.reports.router.summary, {
    total: 12,
    passed: 12,
    accuracy: 1,
    model_outputs_accepted: 12,
    safe_fallbacks: 0,
    unsafe_misroutes: 0,
    latency_p50_ms: 10,
    latency_p95_ms: 10,
  });
  assert.equal(report.reports.human.summary.total, 4);
  assert.equal(report.reports.human.summary.passed, 4);
  assert.equal(report.reports.human.summary.policy_failures, 0);
  assert.deepEqual(report.reports.robot.summary, {
    total: 4,
    passed: 4,
    capability_unavailable_rate: 1,
    model_calls: 0,
    tool_calls: 0,
  });
  assert.deepEqual(report.reports.cat.summary, {
    total: 9,
    passed: 9,
    contract_accuracy: 1,
    original_user_text_rejections: 1,
    tool_calls: 0,
  });
  assert.equal(requests.length, 16);
  assert.ok(requests.every((request) => request.tools === undefined));
  assert.ok(requests.every((request) => request.think === false));
  assert.deepEqual(assessRoleEvalGate(report), { passed: true, failures: [] });
});

test("router fallbacks and Human policy failures stay in their own summaries", async () => {
  const report = await evaluateRoleRuntime({
    model: "fake-failing-role-model",
    repeat: 1,
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        const router = request.messages[0]?.content.includes("Role Router") === true;
        return router
          ? { model: "fake", message: { role: "assistant", content: "not-json" } }
          : {
              model: "fake",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  type: "function",
                  function: { name: "shell.exec", arguments: {} },
                }],
              },
            };
      },
    },
    wall_clock: () => 1_000,
  });

  assert.equal(report.reports.router.summary.passed, 0);
  assert.equal(report.reports.router.summary.safe_fallbacks, 12);
  assert.equal(report.reports.router.summary.unsafe_misroutes, 0);
  assert.equal(report.reports.human.summary.passed, 0);
  assert.equal(report.reports.human.summary.policy_failures, 4);
  assert.equal(report.reports.robot.summary.passed, 4);
  assert.equal(report.reports.cat.summary.passed, 9);
  assert.equal(assessRoleEvalGate(report).passed, false);
});

test("Human textual execution claims fail both runtime policy and the role gate", async () => {
  const report = await evaluateRoleRuntime({
    model: "fake-claiming-role-model",
    repeat: 1,
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        const text = request.messages.at(-1)?.content ?? "";
        const router = request.messages[0]?.content.includes("Role Router") === true;
        return {
          model: "fake",
          message: {
            role: "assistant",
            content: router
              ? routerDecision(text)
              : "空调已经打开了。",
          },
        };
      },
    },
    wall_clock: () => 1_000,
  });

  assert.equal(report.reports.human.summary.passed, 0);
  assert.equal(report.reports.human.summary.policy_failures, 4);
  assert.ok(report.reports.human.cases.every((item) => !item.policy_compliant));
  assert.equal(assessRoleEvalGate(report).passed, false);
});
