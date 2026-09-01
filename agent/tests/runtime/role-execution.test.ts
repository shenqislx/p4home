import assert from "node:assert/strict";
import test from "node:test";

import type {
  OllamaChatRequest,
  OllamaChatResult,
} from "@p4home/provider-ollama";
import { OllamaProviderError } from "@p4home/provider-ollama";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import {
  assessHumanResponsePolicy,
  ROBOT_CAPABILITY_UNAVAILABLE_TEXT,
  RoleScheduler,
  RoleSessionRegistry,
  LowPriorityCatRunRegistry,
  runAssignedRole,
  runRoleInteraction,
  type RoleTaskCompletionNotice,
  type RoutePlan,
  type UserTextInteraction,
} from "@p4home/runtime";

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

function plan(
  value: UserTextInteraction,
  roleId: "human" | "robot",
  mode: "respond" | "clarify" = "respond",
): RoutePlan {
  return {
    schema_version: 1,
    route_plan_id: `route:${value.interaction_id}`,
    interaction_id: value.interaction_id,
    assignments: [{
      assignment_id: `route:${value.interaction_id}`,
      role_id: roleId,
      source_span: { start: 0, end: value.text.length },
      mode,
    }],
    reason: roleId === "robot" ? "model_robot" : mode === "clarify" ? "model_clarify" : "model_human",
    created_at_ms: 1_001,
  };
}

function registry(): RoleSessionRegistry {
  return new RoleSessionRegistry({
    robot: "session:robot",
    human: "session:human",
    cat: "session:cat",
  });
}

test("Human runs without tools and retains history only inside the Human session", async () => {
  const sessions = registry();
  const requests: OllamaChatRequest[] = [];
  const responses = ["先休息一下吧。", "可以先喝点水。"];
  const provider = {
    async chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
      requests.push(request);
      const content = responses.shift();
      assert.ok(content !== undefined);
      return {
        model: "qwen3.8:27b-mlx",
        message: { role: "assistant", content, thinking: "" },
      };
    },
  };
  const first = interaction("interaction:human:1", "今天好累");
  const second = interaction("interaction:human:2", "还有点口渴");

  const firstResult = await runAssignedRole({
    run_id: "run:human:1",
    interaction: first,
    plan: plan(first, "human"),
    session: sessions.get("human"),
    provider,
  });
  const secondResult = await runAssignedRole({
    run_id: "run:human:2",
    interaction: second,
    plan: plan(second, "human"),
    session: sessions.get("human"),
    provider,
  });

  assert.equal(firstResult.status, "completed");
  assert.equal(secondResult.final_text, "可以先喝点水。");
  assert.equal(requests[0]?.tools, undefined);
  assert.equal(requests[0]?.think, false);
  assert.deepEqual(
    requests[1]?.messages.slice(1).map((message) => [message.role, message.content]),
    [
      ["user", "今天好累"],
      ["assistant", "先休息一下吧。"],
      ["user", "还有点口渴"],
    ],
  );
  assert.equal(sessions.get("human").history().length, 4);
  assert.deepEqual(sessions.get("robot").history(), []);
  assert.deepEqual(sessions.get("cat").history(), []);
});

test("product role entrypoint composes routing, bounded scheduling and the assigned session", async () => {
  const sessions = registry();
  const scheduler = new RoleScheduler(2);
  const value = interaction("interaction:orchestrated", "今天好累");
  const requests: OllamaChatRequest[] = [];
  const result = await runRoleInteraction({
    interaction: value,
    route_plan_id: "route:orchestrated",
    run_id: "run:orchestrated",
    sessions,
    scheduler,
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        requests.push(request);
        const router = request.messages[0]?.content.includes("Role Router") === true;
        return router
          ? {
              model: "fake",
              message: { role: "assistant", content: '{"assignments":[{"role":"human","text":"今天好累"}]}' },
              total_duration_ns: 10,
              load_duration_ns: 1,
              prompt_eval_count: 2,
              prompt_eval_duration_ns: 3,
              eval_count: 4,
              eval_duration_ns: 5,
            }
          : {
              model: "fake",
              message: { role: "assistant", content: "辛苦了，先休息一下吧。" },
              total_duration_ns: 20,
              load_duration_ns: 2,
              prompt_eval_count: 3,
              prompt_eval_duration_ns: 4,
              eval_count: 5,
              eval_duration_ns: 6,
            };
      },
    },
    clock: () => 1_001,
  });

  assert.equal(result.routing.plan.assignments[0].role_id, "human");
  assert.equal(result.run.status, "completed");
  assert.equal(requests.length, 2);
  assert.equal(sessions.get("human").history().length, 2);
  assert.deepEqual(sessions.get("robot").history(), []);
  assert.equal(result.model_timing.calls, 2);
  assert.equal(result.model_timing.usage_complete_calls, 2);
  assert.deepEqual(result.model_timing.ollama_totals, {
    total_duration_ns: 30,
    load_duration_ns: 3,
    prompt_eval_count: 5,
    prompt_eval_duration_ns: 7,
    eval_count: 9,
    eval_duration_ns: 11,
  });
  scheduler.close();
});

test("a new user interaction cancels Cat first and emits only body-free task completion metadata", async () => {
  const catRegistry = new LowPriorityCatRunRegistry();
  const catLease = catRegistry.begin("cat-active-before-user");
  const notices: RoleTaskCompletionNotice[] = [];
  const value = interaction("interaction:cat-preemption", "今天好累");
  const result = await runRoleInteraction({
    interaction: value,
    route_plan_id: "route:cat-preemption",
    run_id: "run:cat-preemption",
    sessions: registry(),
    scheduler: new RoleScheduler(),
    cat_run_registry: catRegistry,
    on_task_complete: (notice) => { notices.push(notice); },
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        const router = request.messages[0]?.content.includes("Role Router") === true;
        return router
          ? { model: "fake", message: { role: "assistant", content: '{"assignments":[{"role":"human","text":"今天好累"}]}' } }
          : { model: "fake", message: { role: "assistant", content: "先休息一下吧。" } };
      },
    },
    clock: () => 2_000,
  });
  assert.equal(catLease.signal.aborted, true);
  assert.equal(result.run.status, "completed");
  assert.deepEqual(notices, [{
    run_id: "run:cat-preemption",
    role_id: "human",
    outcome: "completed",
    occurred_at_ms: 2_000,
  }]);
  assert.equal(JSON.stringify(notices).includes(value.text), false);
  catLease.release();
  catRegistry.close();
});

test("product role entrypoint accounts for failed model calls without retaining errors", async () => {
  let calls = 0;
  const scheduler = new RoleScheduler();
  const result = await runRoleInteraction({
    interaction: interaction("interaction:model-metric-failure", "今天好累"),
    route_plan_id: "route:model-metric-failure",
    run_id: "run:model-metric-failure",
    sessions: registry(),
    scheduler,
    provider: {
      async chat(): Promise<OllamaChatResult> {
        calls++;
        if (calls === 1) {
          return {
            model: "fake",
            message: {
              role: "assistant",
              content: '{"assignments":[{"role":"human","text":"今天好累"}]}',
            },
          };
        }
        throw new Error("private provider failure detail");
      },
    },
  });

  assert.equal(result.run.status, "failed");
  assert.deepEqual({
    calls: result.model_timing.calls,
    completed: result.model_timing.completed_calls,
    failed: result.model_timing.failed_calls,
    missing: result.model_timing.usage_missing_calls,
  }, { calls: 2, completed: 1, failed: 1, missing: 2 });
  assert.equal(JSON.stringify(result.model_timing).includes("private provider"), false);
  scheduler.close();
});

test("product role entrypoint times out promptly when the provider ignores abort", async () => {
  let underlyingCalls = 0;
  const scheduler = new RoleScheduler();
  const startedAt = Date.now();
  const result = await runRoleInteraction({
    interaction: interaction("interaction:model-metric-timeout", "今天好累"),
    route_plan_id: "route:model-metric-timeout",
    run_id: "run:model-metric-timeout",
    sessions: registry(),
    scheduler,
    timeout_ms: 100,
    provider: {
      async chat(): Promise<OllamaChatResult> {
        underlyingCalls++;
        return await new Promise(() => undefined);
      },
    },
  });

  assert.equal(Date.now() - startedAt < 1_000, true);
  assert.equal(underlyingCalls, 1);
  assert.equal(result.run.status, "timed_out");
  assert.deepEqual({
    calls: result.model_timing.calls,
    completed: result.model_timing.completed_calls,
    failed: result.model_timing.failed_calls,
    cancelled: result.model_timing.cancelled_calls,
    timedOut: result.model_timing.timed_out_calls,
  }, { calls: 1, completed: 0, failed: 0, cancelled: 0, timedOut: 1 });
  scheduler.close();
});

test("product role entrypoint rejects invalid timeout before routing", async () => {
  const scheduler = new RoleScheduler();
  const value = interaction("interaction:orchestrated:invalid", "今天好累");
  let providerCalls = 0;
  await assert.rejects(
    runRoleInteraction({
      interaction: value,
      route_plan_id: "route:orchestrated:invalid",
      run_id: "run:orchestrated:invalid",
      sessions: registry(),
      scheduler,
      timeout_ms: 99,
      provider: {
        async chat(): Promise<never> {
          providerCalls += 1;
          throw new Error("unreachable");
        },
      },
    }),
    /timeout_ms must be an integer between 100 and 600000/,
  );
  assert.equal(providerCalls, 0);
  scheduler.close();
});

test("Robot returns a deterministic Phase 4 unavailable response without calling a model", async () => {
  const sessions = registry();
  const value = interaction("interaction:robot:1", "打开空调");
  let providerCalls = 0;
  const result = await runAssignedRole({
    run_id: "run:robot:1",
    interaction: value,
    plan: plan(value, "robot"),
    session: sessions.get("robot"),
    provider: {
      async chat(): Promise<never> {
        providerCalls += 1;
        throw new Error("Robot must not call the model before Phase 4");
      },
    },
  });

  assert.equal(providerCalls, 0);
  assert.deepEqual(result, {
    run_id: "run:robot:1",
    role_id: "robot",
    status: "completed",
    final_text: ROBOT_CAPABILITY_UNAVAILABLE_TEXT,
    model_turns: 0,
    capability_available: false,
    outcome: "capability_unavailable",
    tool_results: [],
    error: null,
  });
  assert.equal(sessions.get("robot").history().length, 2);
  assert.deepEqual(sessions.get("human").history(), []);
});

test("role assignments cannot cross sessions and invalid Human output is not committed", async () => {
  const sessions = registry();
  const value = interaction("interaction:human:invalid", "聊聊天");
  await assert.rejects(
    runAssignedRole({
      run_id: "run:wrong-session",
      interaction: value,
      plan: plan(value, "human"),
      session: sessions.get("robot"),
      provider: { async chat(): Promise<never> { throw new Error("unreachable"); } },
    }),
    /cannot execute in robot session/,
  );

  const result = await runAssignedRole({
    run_id: "run:human:invalid",
    interaction: value,
    plan: plan(value, "human"),
    session: sessions.get("human"),
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "qwen3.8:27b-mlx",
          message: {
            role: "assistant",
            content: "已执行",
            tool_calls: [{
              type: "function",
              function: { name: "character.go_to_room", arguments: { room_id: "study" } },
            }],
          },
        };
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "ROLE_POLICY_VIOLATION");
  assert.deepEqual(sessions.get("human").history(), []);
});

test("Human rejects textual device execution claims and counts the attempted model turn", async () => {
  for (const [index, claim] of [
    "空调已经打开了。",
    "我把空调打开了。",
    "我打开了客厅灯。",
    "我关闭了空调。",
    "我刚才打开了客厅灯。",
    "我刚替你关闭了空调。",
    "我刚才按你的要求打开客厅灯。",
    "我刚才按你的要求打开客厅灯，是否还要关闭？",
    "我刚才按你的要求打开客厅灯，然后想问是否还要关闭？",
    "已经按计划把客厅灯打开，是否恢复？",
    "我打开过客厅灯。",
    "客厅灯我打开过。",
    "我曾经关闭空调。",
    "成功将客厅灯打开。",
    "完成了客厅灯关闭。",
    "我已经打开客厅灯是否需要恢复？",
    "客厅灯亮了是否需要关闭？",
    "我没有犹豫就打开了客厅灯。",
    "我不打算关闭空调但已经打开客厅灯。",
    "我想了想然后打开了客厅灯。",
    "我没想到竟然打开了客厅灯。",
    "我没有丝毫犹豫便打开了客厅灯。",
    "我不打算关闭空调接着已经打开客厅灯。",
    "我想了想又打开了客厅灯。",
    "我之前就关闭空调。",
    "我刚才便打开客厅灯。",
    "我刚才竟然打开客厅灯。",
    "已把客厅灯打开。",
    "已经把空调关闭。",
    "我已把客厅灯打开。",
    "已为你关闭客厅灯。",
    "客厅灯关了。",
    "I've turned on the air conditioner.",
    "I just turned on the light.",
  ].entries()) {
    const sessions = registry();
    const value = interaction(`interaction:human:false-claim:${index + 1}`, "陪我聊聊");
    const result = await runAssignedRole({
      run_id: `run:human:false-claim:${index + 1}`,
      interaction: value,
      plan: plan(value, "human"),
      session: sessions.get("human"),
      provider: {
        async chat(): Promise<OllamaChatResult> {
          return {
            model: "qwen3.8:27b-mlx",
            message: { role: "assistant", content: claim },
          };
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "ROLE_POLICY_VIOLATION");
    assert.equal(result.model_turns, 1);
    assert.deepEqual(sessions.get("human").history(), []);
  }
});

test("Human clarification can name a requested device action without claiming it executed", async () => {
  const sessions = registry();
  const value = interaction("interaction:human:clarify-action", "请说明要处理哪个设备");
  const result = await runAssignedRole({
    run_id: "run:human:clarify-action",
    interaction: value,
    plan: plan(value, "human", "clarify"),
    session: sessions.get("human"),
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "qwen3.8:27b-mlx",
          message: {
            role: "assistant",
            content: "请告诉我您想要控制或查询的具体设备名称。",
          },
        };
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
});

test("Human intent and future-tense clarifications are not execution claims", async () => {
  for (const [index, clarification] of [
    "我会打开哪个灯？",
    "我刚才想打开哪个灯？",
  ].entries()) {
    const sessions = registry();
    const value = interaction(`interaction:human:clarify-intent:${index}`, "请说明要处理哪个设备");
    const result = await runAssignedRole({
      run_id: `run:human:clarify-intent:${index}`,
      interaction: value,
      plan: plan(value, "human", "clarify"),
      session: sessions.get("human"),
      provider: {
        async chat(): Promise<OllamaChatResult> {
          return {
            model: "qwen3.8:27b-mlx",
            message: { role: "assistant", content: clarification },
          };
        },
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.error, null);
  }
});

test("Human negated device statements are not execution claims", () => {
  for (const statement of [
    "我刚才没有打开客厅灯。",
    "我刚才并未关闭空调。",
    "我并没有成功打开客厅灯。",
    "空调未成功关闭。",
    "我没有按照你的要求成功打开客厅灯。",
    "客厅灯不亮了。",
    "客厅灯不再亮了。",
    "客厅灯没再亮了。",
    "我曾经打开过哪个灯？",
  ]) {
    assert.deepEqual(assessHumanResponsePolicy(statement, "respond"), {
      compliant: true,
      violation: null,
    });
  }
});

test("Human provider failures retain the attempted model turn", async () => {
  const sessions = registry();
  const value = interaction("interaction:human:timeout", "陪我聊聊");
  const result = await runAssignedRole({
    run_id: "run:human:timeout",
    interaction: value,
    plan: plan(value, "human"),
    session: sessions.get("human"),
    provider: {
      async chat(): Promise<never> {
        throw new OllamaProviderError("TIMEOUT", "model timed out", { retryable: true });
      },
    },
  });

  assert.equal(result.status, "timed_out");
  assert.equal(result.model_turns, 1);
});

test("concurrent runs in one RoleSession are serialized with ordered history", async () => {
  const sessions = registry();
  const humanSession = sessions.get("human");
  const first = interaction("interaction:human:concurrent:1", "第一条消息");
  const second = interaction("interaction:human:concurrent:2", "第二条消息");
  const requests: OllamaChatRequest[] = [];
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider = {
    async chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
      requests.push(request);
      if (requests.length === 1) {
        markFirstStarted?.();
        await firstMayFinish;
        return { model: "fake", message: { role: "assistant", content: "第一条回复" } };
      }
      return { model: "fake", message: { role: "assistant", content: "第二条回复" } };
    },
  };

  const firstRun = runAssignedRole({
    run_id: "run:human:concurrent:1",
    interaction: first,
    plan: plan(first, "human"),
    session: humanSession,
    provider,
  });
  const secondRun = runAssignedRole({
    run_id: "run:human:concurrent:2",
    interaction: second,
    plan: plan(second, "human"),
    session: humanSession,
    provider,
  });

  await firstStarted;
  await Promise.resolve();
  assert.equal(requests.length, 1);
  releaseFirst?.();
  await Promise.all([firstRun, secondRun]);

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1]?.messages.slice(1).map((message) => [message.role, message.content]),
    [
      ["user", "第一条消息"],
      ["assistant", "第一条回复"],
      ["user", "第二条消息"],
    ],
  );
});

test("clarification assignments add a fail-closed instruction to Human context", async () => {
  const sessions = registry();
  const value = interaction("interaction:clarify", "我好累，顺便开一下");
  let request: OllamaChatRequest | undefined;
  await runAssignedRole({
    run_id: "run:clarify",
    interaction: value,
    plan: plan(value, "human", "clarify"),
    session: sessions.get("human"),
    provider: {
      async chat(input): Promise<OllamaChatResult> {
        request = input;
        return {
          model: "qwen3.8:27b-mlx",
          message: { role: "assistant", content: "你想打开哪个设备？" },
        };
      },
    },
  });

  assert.match(request?.messages[0]?.content ?? "", /只能请求用户澄清/);
});

test("role audit links interaction, route plan, role, session and run", async () => {
  using store = new SqliteAuditStore(":memory:");
  const sessions = new RoleSessionRegistry({
    robot: "audit-session:robot",
    human: "audit-session:human",
    cat: "audit-session:cat",
  }, () => 900);
  const value = interaction("interaction:audit", "今天好吗");
  const routePlan = plan(value, "human");

  const result = await runAssignedRole({
    run_id: "run:audit:human",
    interaction: value,
    plan: routePlan,
    session: sessions.get("human"),
    provider: {
      async chat(): Promise<OllamaChatResult> {
        return {
          model: "qwen3.8:27b-mlx",
          message: { role: "assistant", content: "今天挺好的。" },
        };
      },
    },
    audit: { store, clock: () => 1_100 },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(await store.listRunIdsForInteraction(value.interaction_id), ["run:audit:human"]);
  const trace = await store.getRunTrace("run:audit:human");
  assert.ok(trace !== null);
  assert.equal(trace.run.session_id, "audit-session:human");
  assert.deepEqual(
    trace.events.map((event) => event.type),
    ["role.run.started", "role.run.completed"],
  );
  assert.deepEqual(trace.events[0]?.payload, {
    interaction_id: "interaction:audit",
    route_plan_id: "route:interaction:audit",
    assignment_id: "route:interaction:audit",
    role_id: "human",
    role_profile_revision: "role-profile/v2",
    route_reason: "model_human",
    assignment_mode: "respond",
    source_span: { start: 0, end: value.text.length },
  });
  assert.equal(trace.messages[2]?.content, "今天挺好的。");
});
