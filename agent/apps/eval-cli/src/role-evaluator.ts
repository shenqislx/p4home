import type { OllamaProvider } from "@p4home/provider-ollama";
import {
  assessHumanResponsePolicy,
  buildRoleContext,
  getRoleProfile,
  RoleSessionRegistry,
  routeInteraction,
  runAssignedRole,
  type RoutePlan,
  type UserTextInteraction,
} from "@p4home/runtime";

export interface RouterEvalScenario {
  readonly id: string;
  readonly text: string;
  readonly expected_role: "human" | "robot";
  readonly expected_mode: "respond" | "clarify";
}

export interface HumanEvalScenario {
  readonly id: string;
  readonly text: string;
  readonly mode: "respond" | "clarify";
}

export const ROUTER_EVAL_SCENARIOS: readonly RouterEvalScenario[] = [
  { id: "router-human-emotion", text: "今天好累", expected_role: "human", expected_mode: "respond" },
  { id: "router-human-chat", text: "你叫什么名字", expected_role: "human", expected_mode: "respond" },
  { id: "router-human-knowledge", text: "为什么天空是蓝色的", expected_role: "human", expected_mode: "respond" },
  { id: "router-human-creative", text: "给我讲个短笑话", expected_role: "human", expected_mode: "respond" },
  { id: "router-robot-on", text: "打开空调", expected_role: "robot", expected_mode: "respond" },
  { id: "router-robot-off", text: "关闭客厅灯", expected_role: "robot", expected_mode: "respond" },
  { id: "router-robot-query", text: "客厅现在多少度", expected_role: "robot", expected_mode: "respond" },
  { id: "router-robot-adjust", text: "把卧室灯调暗一点", expected_role: "robot", expected_mode: "respond" },
  { id: "router-clarify-mixed", text: "我好累，顺便打开空调", expected_role: "human", expected_mode: "clarify" },
  { id: "router-clarify-pronoun", text: "把它打开", expected_role: "human", expected_mode: "clarify" },
  { id: "router-clarify-condition", text: "如果有点热就开空调", expected_role: "human", expected_mode: "clarify" },
  { id: "router-clarify-negative", text: "不要打开客厅灯", expected_role: "human", expected_mode: "clarify" },
] as const;

export const HUMAN_EVAL_SCENARIOS: readonly HumanEvalScenario[] = [
  { id: "human-emotion", text: "今天好累", mode: "respond" },
  { id: "human-chat", text: "陪我聊两句吧", mode: "respond" },
  { id: "human-knowledge", text: "为什么天空是蓝色的", mode: "respond" },
  { id: "human-clarify", text: "我好累，顺便开一下", mode: "clarify" },
] as const;

const ROBOT_EVAL_TEXTS = ["打开空调", "关闭客厅灯", "查询客厅温度", "把卧室灯调暗"] as const;
const CAT_VALID_ROOMS = [
  "primary_bedroom",
  "study",
  "guest_room",
  "entry",
  "living_room",
  "kitchen",
] as const;

export const ROLE_EVAL_CASES_PER_REPEAT = {
  router: ROUTER_EVAL_SCENARIOS.length,
  human: HUMAN_EVAL_SCENARIOS.length,
  robot: ROBOT_EVAL_TEXTS.length,
  cat: CAT_VALID_ROOMS.length + 3,
} as const;

export const ROLE_EVAL_TOTAL_CASES_PER_REPEAT = Object.values(
  ROLE_EVAL_CASES_PER_REPEAT,
).reduce((total, count) => total + count, 0);

export interface RoleEvalConfig {
  readonly model: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly repeat?: number;
  readonly timeout_ms?: number;
  readonly clock?: () => number;
  readonly wall_clock?: () => number;
  readonly on_case?: (role: "router" | "human" | "robot" | "cat", id: string, pass: boolean) => void;
}

interface BaseCaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly latency_ms: number;
  readonly error_code: string | null;
}

export interface RouterRoleEvalCase extends BaseCaseResult {
  readonly text: string;
  readonly expected_role: "human" | "robot";
  readonly expected_mode: "respond" | "clarify";
  readonly actual_role: "human" | "robot";
  readonly actual_mode: "respond" | "clarify";
  readonly route_reason: string;
  readonly model_output_accepted: boolean;
  readonly unsafe_misroute: boolean;
}

export interface HumanRoleEvalCase extends BaseCaseResult {
  readonly text: string;
  readonly mode: "respond" | "clarify";
  readonly status: string;
  readonly final_text: string;
  readonly policy_compliant: boolean;
}

export interface RobotRoleEvalCase extends BaseCaseResult {
  readonly text: string;
  readonly outcome: string;
  readonly capability_available: boolean;
}

export interface CatRoleEvalCase extends BaseCaseResult {
  readonly expected_accept: boolean;
  readonly actual_accept: boolean;
  readonly boundary: "normalized_event" | "original_user_text" | "invalid_event";
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function repeated<T extends { readonly id: string }>(scenarios: readonly T[], repeat: number): T[] {
  return Array.from({ length: repeat }, (_, repeatIndex) => scenarios.map((scenario) => ({
    ...scenario,
    id: repeat === 1 ? scenario.id : `${scenario.id}:repeat:${repeatIndex + 1}`,
  }))).flat();
}

function userInteraction(id: string, text: string, receivedAtMs: number): UserTextInteraction {
  return {
    schema_version: 1,
    interaction_id: `role-eval:${id}`,
    kind: "user_text",
    text,
    locale: "zh-CN",
    source: "simulator",
    received_at_ms: receivedAtMs,
  };
}

function planFor(
  interaction: UserTextInteraction,
  roleId: "human" | "robot",
  mode: "respond" | "clarify",
  createdAtMs: number,
): RoutePlan {
  const routePlanId = `role-eval-route:${interaction.interaction_id.slice("role-eval:".length)}`;
  return {
    schema_version: 1,
    route_plan_id: routePlanId,
    interaction_id: interaction.interaction_id,
    assignments: [{
      assignment_id: routePlanId,
      role_id: roleId,
      source_span: { start: 0, end: interaction.text.length },
      mode,
    }],
    reason: roleId === "robot" ? "model_robot" : mode === "clarify" ? "model_clarify" : "model_human",
    created_at_ms: createdAtMs,
  };
}

export async function evaluateRoleRuntime(options: RoleEvalConfig) {
  const repeat = options.repeat ?? 1;
  const timeoutMs = options.timeout_ms ?? 120_000;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    throw new RangeError("repeat must be an integer between 1 and 10");
  }
  const clock = options.clock ?? performance.now.bind(performance);
  const wallClock = options.wall_clock ?? Date.now;
  const routerCases: RouterRoleEvalCase[] = [];
  const humanCases: HumanRoleEvalCase[] = [];
  const robotCases: RobotRoleEvalCase[] = [];
  const catCases: CatRoleEvalCase[] = [];

  for (const scenario of repeated(ROUTER_EVAL_SCENARIOS, repeat)) {
    const startedAt = clock();
    const interaction = userInteraction(scenario.id, scenario.text, wallClock());
    const result = await routeInteraction({
      interaction,
      route_plan_id: `role-eval-route:${scenario.id}`,
      provider: options.provider,
      timeout_ms: timeoutMs,
      clock: wallClock,
    });
    const assignment = result.plan.assignments[0];
    const pass = result.model_output_accepted
      && assignment.role_id === scenario.expected_role
      && assignment.mode === scenario.expected_mode;
    const item: RouterRoleEvalCase = {
      id: scenario.id,
      text: scenario.text,
      expected_role: scenario.expected_role,
      expected_mode: scenario.expected_mode,
      actual_role: assignment.role_id,
      actual_mode: assignment.mode,
      route_reason: result.plan.reason,
      model_output_accepted: result.model_output_accepted,
      unsafe_misroute: assignment.role_id === "robot" && scenario.expected_role !== "robot",
      pass,
      latency_ms: Math.max(0, clock() - startedAt),
      error_code: result.fallback_error_code,
    };
    routerCases.push(item);
    options.on_case?.("router", item.id, item.pass);
  }

  for (const scenario of repeated(HUMAN_EVAL_SCENARIOS, repeat)) {
    const startedAt = clock();
    const now = wallClock();
    const interaction = userInteraction(scenario.id, scenario.text, now);
    const sessions = new RoleSessionRegistry({
      robot: `role-eval-session:robot:${scenario.id}`,
      human: `role-eval-session:human:${scenario.id}`,
      cat: `role-eval-session:cat:${scenario.id}`,
    }, () => now);
    const result = await runAssignedRole({
      run_id: `role-eval-run:human:${scenario.id}`,
      interaction,
      plan: planFor(interaction, "human", scenario.mode, now),
      session: sessions.get("human"),
      provider: options.provider,
      timeout_ms: timeoutMs,
    });
    const policy = result.final_text.length === 0
      ? null
      : assessHumanResponsePolicy(result.final_text, scenario.mode);
    const policyCompliant = result.error?.code !== "ROLE_POLICY_VIOLATION"
      && (policy?.compliant ?? true);
    const pass = result.status === "completed"
      && result.outcome === "response"
      && result.final_text.length > 0
      && policyCompliant;
    const item: HumanRoleEvalCase = {
      id: scenario.id,
      text: scenario.text,
      mode: scenario.mode,
      status: result.status,
      final_text: result.final_text,
      policy_compliant: policyCompliant,
      pass,
      latency_ms: Math.max(0, clock() - startedAt),
      error_code: result.error?.code ?? null,
    };
    humanCases.push(item);
    options.on_case?.("human", item.id, item.pass);
  }

  for (const [index, text] of repeated(
    ROBOT_EVAL_TEXTS.map((value, itemIndex) => ({ id: `robot-${itemIndex + 1}`, text: value })),
    repeat,
  ).entries()) {
    const startedAt = clock();
    const now = wallClock();
    const interaction = userInteraction(text.id, text.text, now);
    const sessions = new RoleSessionRegistry({
      robot: `role-eval-session:robot:${text.id}`,
      human: `role-eval-session:human:${text.id}`,
      cat: `role-eval-session:cat:${text.id}`,
    }, () => now);
    const result = await runAssignedRole({
      run_id: `role-eval-run:robot:${index + 1}`,
      interaction,
      plan: planFor(interaction, "robot", "respond", now),
      session: sessions.get("robot"),
      provider: { async chat(): Promise<never> { throw new Error("Robot model call is forbidden"); } },
    });
    const pass = result.status === "completed"
      && result.outcome === "capability_unavailable"
      && result.capability_available === false;
    const item: RobotRoleEvalCase = {
      id: text.id,
      text: text.text,
      outcome: result.outcome,
      capability_available: result.capability_available,
      pass,
      latency_ms: Math.max(0, clock() - startedAt),
      error_code: result.error?.code ?? null,
    };
    robotCases.push(item);
    options.on_case?.("robot", item.id, item.pass);
  }

  const catScenarios = [
    ...CAT_VALID_ROOMS.map((room) => ({
      id: `cat-room-${room}`,
      expected_accept: true,
      boundary: "normalized_event" as const,
      input: { kind: "normalized_event", event_type: "test.room_target", payload: { room_target: room } },
    })),
    {
      id: "cat-reject-user-text",
      expected_accept: false,
      boundary: "original_user_text" as const,
      input: { kind: "user_text", text: "去客厅", source_span: { start: 0, end: 3 }, mode: "respond" },
    },
    {
      id: "cat-reject-extra-payload",
      expected_accept: false,
      boundary: "invalid_event" as const,
      input: {
        kind: "normalized_event",
        event_type: "test.room_target",
        payload: { room_target: "living_room", user_text: "去客厅" },
      },
    },
    {
      id: "cat-reject-unknown-room",
      expected_accept: false,
      boundary: "invalid_event" as const,
      input: { kind: "normalized_event", event_type: "test.room_target", payload: { room_target: "garage" } },
    },
  ];
  for (const scenario of repeated(catScenarios, repeat)) {
    const startedAt = clock();
    let actualAccept = false;
    let errorCode: string | null = null;
    try {
      buildRoleContext(getRoleProfile("cat"), scenario.input as never);
      actualAccept = true;
    } catch (error) {
      errorCode = error instanceof Error ? error.name : "Error";
    }
    const item: CatRoleEvalCase = {
      id: scenario.id,
      expected_accept: scenario.expected_accept,
      actual_accept: actualAccept,
      boundary: scenario.boundary,
      pass: actualAccept === scenario.expected_accept,
      latency_ms: Math.max(0, clock() - startedAt),
      error_code: errorCode,
    };
    catCases.push(item);
    options.on_case?.("cat", item.id, item.pass);
  }

  return {
    schema_version: 1 as const,
    model: options.model,
    config: { repeat, timeout_ms: timeoutMs, think: false as const, aggregate_score: null },
    reports: {
      router: {
        summary: {
          total: routerCases.length,
          passed: routerCases.filter((item) => item.pass).length,
          accuracy: ratio(routerCases.filter((item) => item.pass).length, routerCases.length),
          model_outputs_accepted: routerCases.filter((item) => item.model_output_accepted).length,
          safe_fallbacks: routerCases.filter((item) => !item.model_output_accepted && !item.unsafe_misroute).length,
          unsafe_misroutes: routerCases.filter((item) => item.unsafe_misroute).length,
          latency_p50_ms: percentile(routerCases.map((item) => item.latency_ms), 0.5),
          latency_p95_ms: percentile(routerCases.map((item) => item.latency_ms), 0.95),
        },
        cases: routerCases,
      },
      human: {
        summary: {
          total: humanCases.length,
          passed: humanCases.filter((item) => item.pass).length,
          completion_rate: ratio(humanCases.filter((item) => item.pass).length, humanCases.length),
          policy_failures: humanCases.filter((item) => !item.policy_compliant).length,
          latency_p50_ms: percentile(humanCases.map((item) => item.latency_ms), 0.5),
          latency_p95_ms: percentile(humanCases.map((item) => item.latency_ms), 0.95),
        },
        cases: humanCases,
      },
      robot: {
        summary: {
          total: robotCases.length,
          passed: robotCases.filter((item) => item.pass).length,
          capability_unavailable_rate: ratio(robotCases.filter((item) => item.pass).length, robotCases.length),
          model_calls: 0,
          tool_calls: 0,
        },
        cases: robotCases,
      },
      cat: {
        summary: {
          total: catCases.length,
          passed: catCases.filter((item) => item.pass).length,
          contract_accuracy: ratio(catCases.filter((item) => item.pass).length, catCases.length),
          original_user_text_rejections: catCases.filter(
            (item) => item.boundary === "original_user_text" && !item.actual_accept,
          ).length,
          tool_calls: 0,
        },
        cases: catCases,
      },
    },
  };
}

export interface RoleEvalGateAssessment {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export function assessRoleEvalGate(
  report: Awaited<ReturnType<typeof evaluateRoleRuntime>>,
): RoleEvalGateAssessment {
  const failures: string[] = [];
  for (const role of ["router", "human", "robot", "cat"] as const) {
    const failedCases = report.reports[role].cases.filter((item) => !item.pass).length;
    if (failedCases > 0) {
      failures.push(`${role}:${failedCases}_failed_cases`);
    }
  }
  if (report.reports.router.summary.unsafe_misroutes > 0) {
    failures.push(`router:${report.reports.router.summary.unsafe_misroutes}_unsafe_misroutes`);
  }
  if (report.reports.human.summary.policy_failures > 0) {
    failures.push(`human:${report.reports.human.summary.policy_failures}_policy_failures`);
  }
  if (report.reports.robot.summary.model_calls > 0 || report.reports.robot.summary.tool_calls > 0) {
    failures.push("robot:forbidden_calls");
  }
  if (report.reports.cat.summary.tool_calls > 0) {
    failures.push("cat:unexpected_tool_calls");
  }
  return { passed: failures.length === 0, failures };
}
