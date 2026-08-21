import assert from "node:assert/strict";
import test from "node:test";

import {
  OllamaProviderError,
  type OllamaChatRequest,
  type OllamaChatResult,
} from "@p4home/provider-ollama";
import {
  CAT_WORLD_TOOLS,
  QWEN_THINKING_ENABLED,
  ROLE_ROUTER_DECISION_SCHEMA,
  buildRoleContext,
  getRoleProfile,
  routeInteraction,
  assertRoleToolAuthorization,
  validateRoutePlan,
  type UserTextInteraction,
} from "@p4home/runtime";

const INTERACTION: UserTextInteraction = {
  schema_version: 1,
  interaction_id: "interaction-001",
  kind: "user_text",
  text: "打开客厅灯",
  locale: "zh-CN",
  source: "simulator",
  received_at_ms: 1_000,
};

function providerReturning(
  content: string,
  overrides: Partial<OllamaChatResult["message"]> = {},
  capture?: (request: OllamaChatRequest) => void,
) {
  return {
    async chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
      capture?.(request);
      return {
        model: "qwen3.8:27b-mlx",
        message: { role: "assistant", content, ...overrides },
      };
    },
  };
}

test("role profiles keep user text and tool namespaces isolated", () => {
  const human = getRoleProfile("human");
  const robot = getRoleProfile("robot");
  const cat = getRoleProfile("cat");

  assert.deepEqual(human.allowed_tools, []);
  assert.deepEqual(robot.allowed_tools, [
    "home.get_entity",
    "home.turn_on",
    "home.turn_off",
    "home.activate_scene",
  ]);
  assert.deepEqual(cat.allowed_tools, CAT_WORLD_TOOLS);
  assert.equal(robot.allowed_tools.every((tool) => tool.startsWith("home.")), true);
  assert.equal(human.allowed_tools.length, 0);
  assert.equal(cat.allowed_tools.some((tool) => tool.startsWith("home.")), false);
  assert.equal(cat.accepts_user_text, false);
  assert.equal(cat.queue_priority, "background");
  assert.doesNotThrow(() => assertRoleToolAuthorization(cat, ["character.go_to_room"]));
  assert.throws(
    () => assertRoleToolAuthorization(
      { ...human, allowed_tools: ["character.go_to_room"] },
      ["character.go_to_room"],
    ),
    /does not match its frozen revision/,
  );
  assert.throws(
    () => buildRoleContext(cat, {
      kind: "user_text",
      text: "去客厅",
      source_span: { start: 0, end: 3 },
      mode: "respond",
    }),
    /cannot receive original user text/,
  );
  const messages = buildRoleContext(cat, {
    kind: "normalized_event",
    event_type: "test.room_target",
    payload: { room_target: "living_room" },
  });
  assert.equal(messages[1]?.role, "user");
  assert.match(messages[1]?.content ?? "", /test\.room_target/);
  assert.throws(
    () => buildRoleContext(cat, {
      kind: "normalized_event",
      event_type: "test.room_target",
      payload: { room_target: "living_room", user_text: "去客厅" },
    } as never),
    /not allowed/,
  );
});

test("router emits one full-span Robot assignment without exposing tools", async () => {
  let captured: OllamaChatRequest | undefined;
  const result = await routeInteraction({
    interaction: INTERACTION,
    route_plan_id: "route-001",
    provider: providerReturning('{"assignments":[{"role":"robot","text":"打开客厅灯"}]}', {}, (request) => {
      captured = request;
    }),
    clock: () => 1_001,
  });

  assert.equal(result.model_output_accepted, true);
  assert.equal(result.plan.reason, "model_robot");
  assert.deepEqual(result.plan.assignments, [{
    assignment_id: "route-001",
    role_id: "robot",
    source_span: { start: 0, end: INTERACTION.text.length },
    mode: "respond",
  }]);
  validateRoutePlan(result.plan, INTERACTION);
  assert.equal(captured?.tools, undefined);
  assert.deepEqual(captured?.format, ROLE_ROUTER_DECISION_SCHEMA);
  assert.equal(captured?.think, QWEN_THINKING_ENABLED);
  assert.equal(captured?.options?.temperature, 0);
});

test("human and clarify decisions can never create Cat or Robot fallback work", async () => {
  const human = await routeInteraction({
    interaction: { ...INTERACTION, text: "今天好累" },
    route_plan_id: "route-human",
    provider: providerReturning('{"assignments":[{"role":"human","text":"今天好累"}]}'),
    clock: () => 1_002,
  });
  const clarify = await routeInteraction({
    interaction: { ...INTERACTION, text: "我好累，顺便打开空调" },
    route_plan_id: "route-clarify",
    provider: providerReturning('{"assignments":[{"role":"clarify","text":"我好累，顺便打开空调"}]}'),
    clock: () => 1_003,
  });

  assert.equal(human.plan.assignments[0].role_id, "human");
  assert.equal(human.plan.assignments[0].mode, "respond");
  assert.equal(clarify.plan.assignments[0].role_id, "human");
  assert.equal(clarify.plan.assignments[0].mode, "clarify");
});

test("invalid, tool-bearing, thinking and provider failures fail closed to Human clarification", async () => {
  const cases = [
    providerReturning("not-json"),
    providerReturning('{"role":"robot"}', {
      tool_calls: [{ type: "function", function: { name: "shell.exec", arguments: {} } }],
    }),
    providerReturning('{"role":"robot"}', { thinking: "应该执行" }),
    {
      async chat(): Promise<never> {
        throw new OllamaProviderError("TIMEOUT", "router timed out", { retryable: true });
      },
    },
  ];

  for (const [index, provider] of cases.entries()) {
    const result = await routeInteraction({
      interaction: INTERACTION,
      route_plan_id: `route-fallback-${index}`,
      provider,
      clock: () => 2_000 + index,
    });
    assert.equal(result.model_output_accepted, false);
    assert.equal(result.plan.assignments[0].role_id, "human");
    assert.equal(result.plan.assignments[0].mode, "clarify");
    assert.notEqual(result.fallback_error_code, null);
  }
});
