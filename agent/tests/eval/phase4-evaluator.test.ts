import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPhase4EvalGate,
  evaluatePhase4Runtime,
  PHASE4_ROUTER_HOLDOUTS,
} from "@p4home/eval-cli";
import type { OllamaChatRequest, OllamaChatResult } from "@p4home/provider-ollama";

function passingProvider() {
  return {
    async chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
      const text = request.messages.at(-1)?.content ?? "";
      if (request.messages[0]?.content.includes("Role Router") === true) {
        const scenario = PHASE4_ROUTER_HOLDOUTS.find((item) => item.text === text);
        assert.ok(scenario !== undefined);
        return {
          model: "fake-phase4",
          message: {
            role: "assistant",
            content: JSON.stringify({ assignments: scenario.segments.map((segment) => ({
              role: segment.role,
              text: segment.text,
            })) }),
          },
        };
      }
      if (request.tools === undefined) {
        return {
          model: "fake-phase4",
          message: {
            role: "assistant",
            content: text.includes("说明需要处理")
              ? "你希望我处理哪个设备？"
              : "我在这里陪着你。",
          },
        };
      }
      const call = text === "查询书房灯状态"
        ? { name: "home.get_entity", arguments: { alias: "study_light" } }
        : text === "打开书房灯"
          ? { name: "home.turn_on", arguments: { alias: "study_light" } }
          : text === "打开未知设备"
            ? { name: "home.get_entity", arguments: { alias: "unknown_device" } }
            : text === "打开空调"
              ? { name: "home.turn_on", arguments: { alias: "air_conditioner" } }
              : { name: "lock.unlock", arguments: { alias: "front_door" } };
      return {
        model: "fake-phase4",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", function: call }],
        },
      };
    },
  };
}

test("Phase 4 evaluator reports Router spans, Robot policy, Human text and Composer separately", async () => {
  const report = await evaluatePhase4Runtime({
    model: "fake-phase4",
    provider: passingProvider(),
    wall_clock: () => 1_000,
  });

  assert.equal(report.config.aggregate_score, null);
  assert.deepEqual(Object.keys(report.reports), [
    "router_span",
    "robot_tool_policy",
    "human_text",
    "composer",
  ]);
  assert.deepEqual(report.reports.router_span.summary, { total: 6, passed: 6, pass_rate: 1 });
  assert.deepEqual(report.reports.robot_tool_policy.summary, { total: 5, passed: 5, pass_rate: 1 });
  assert.deepEqual(report.reports.human_text.summary, { total: 4, passed: 4, pass_rate: 1 });
  assert.deepEqual(report.reports.composer.summary, { total: 2, passed: 2, pass_rate: 1 });
  assert.equal(
    report.reports.robot_tool_policy.cases.find((item) => item.id === "robot-high-risk-lock")?.actual_dispatches,
    0,
  );
  assert.equal(
    report.reports.robot_tool_policy.cases.find((item) => item.id === "robot-climate-write-denied")?.actual_dispatches,
    0,
  );
  assert.equal(report.reports.composer.cases[0]?.forged_robot_success, false);
  assert.deepEqual(assessPhase4EvalGate(report), { passed: true, failures: [] });
});

test("Phase 4 gate preserves section failures without an aggregate score", async () => {
  const report = await evaluatePhase4Runtime({
    model: "fake-phase4-failing",
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        if (request.messages[0]?.content.includes("Role Router") === true) {
          return { model: "fake", message: { role: "assistant", content: "not-json" } };
        }
        return { model: "fake", message: { role: "assistant", content: "" } };
      },
    },
    wall_clock: () => 1_000,
  });
  const gate = assessPhase4EvalGate(report);
  assert.equal(report.config.aggregate_score, null);
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.some((failure) => failure.startsWith("router_span:")));
  assert.ok(gate.failures.some((failure) => failure.startsWith("robot_tool_policy:")));
  assert.ok(gate.failures.some((failure) => failure.startsWith("human_text:")));
  assert.equal(report.reports.composer.summary.passed, 2);
});

test("Router span gate rejects punctuation moved across a role boundary", async () => {
  const base = passingProvider();
  const report = await evaluatePhase4Runtime({
    model: "fake-phase4-shifted-boundary",
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        const text = request.messages.at(-1)?.content ?? "";
        if (
          request.messages[0]?.content.includes("Role Router") === true
          && text === "我好累，打开空调"
        ) {
          return {
            model: "fake",
            message: {
              role: "assistant",
              content: JSON.stringify({ assignments: [
                { role: "human", text: "我好累" },
                { role: "robot", text: "，打开空调" },
              ] }),
            },
          };
        }
        return await base.chat(request);
      },
    },
    wall_clock: () => 1_000,
  });
  const moved = report.reports.router_span.cases.find(
    (item) => item.id === "mixed-holdout-tired-ac",
  );
  assert.equal(moved?.model_output_accepted, true);
  assert.equal(moved?.pass, false);
  assert.equal(report.reports.router_span.summary.passed, 5);
  assert.equal(assessPhase4EvalGate(report).passed, false);
});
