import { parseStructuredOutput } from "@p4home/contracts";
import { createHash } from "node:crypto";
import {
  OllamaProviderError,
  type OllamaProvider,
} from "@p4home/provider-ollama";

import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import {
  assertContractId,
  type RoleAssignment,
  type RoutePlanV2,
  type RouteReason,
  type UserRoutableRoleId,
  type UserTextInteraction,
  validateRoutePlan,
  validateUserTextInteraction,
} from "./role-contracts.ts";

export const ROLE_ROUTER_SYSTEM_PROMPT = [
  "你是 P4 Home 的 Role Router，只切分和分类，不回答用户，也没有任何工具。",
  "Home Assistant 家居查询或控制属于 robot；普通对话、知识问答、情绪表达属于 human。",
  "输出一个或两个 assignment；text 必须逐字复制对应的原始用户文本子串，不能改写、增删或规范化字符。",
  "assignment 必须按原文顺序、非空、无重叠无遗漏地覆盖全文；标点、空格、连接词和 emoji 也必须归入相邻一段。",
  "单意图也输出一个 assignment，text 必须等于完整原始文本。",
  "混合意图最多输出一段 human 和一段 robot；不能安全切分、含糊目标、否定或条件式命令时输出唯一 full-span clarify assignment。",
  "唯一允许的 JSON 形状是 {\"assignments\":[{\"role\":\"human|robot|clarify\",\"text\":\"原文精确子串\"}]}，不得输出自然语言。",
  "禁止 Cat、第三段、Markdown、解释、工具调用、thinking 或其他字段。",
].join("");

export const ROLE_ROUTER_DECISION_SCHEMA = {
  type: "object",
  required: ["assignments"],
  properties: {
    assignments: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        required: ["role", "text"],
        properties: {
          role: { enum: ["human", "robot", "clarify"] },
          text: { type: "string", minLength: 1, maxLength: 1_024 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export const ROLE_ROUTER_MODEL_OPTIONS = {
  temperature: 0,
  seed: 42,
  num_ctx: 4_096,
  num_predict: 128,
} as const;

interface SpanRouterDecision {
  readonly assignments: readonly {
    readonly role: UserRoutableRoleId | "clarify";
    readonly text: string;
  }[];
}

type RouterDecision = SpanRouterDecision;

export interface RouteInteractionOptions {
  readonly interaction: UserTextInteraction;
  readonly route_plan_id: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
  /**
   * Product safety mode for deployments that intentionally expose only the
   * tool-free Human role. The Router still classifies the original text, but
   * any Robot or mixed decision fails closed to one full-span Human
   * clarification assignment.
   */
  readonly human_only?: boolean;
}

export interface RouteInteractionResult {
  readonly plan: RoutePlanV2;
  readonly model_output_accepted: boolean;
  readonly fallback_error_code: string | null;
}

function makePlan(
  options: RouteInteractionOptions,
  assignments: readonly Omit<RoleAssignment, "assignment_id" | "mode">[],
  reason: RouteReason,
  mode: "respond" | "clarify" = "respond",
): RoutePlanV2 {
  const assignmentId = (index: number): string => {
    if (assignments.length === 1) {
      return options.route_plan_id;
    }
    const suffix = `:${index + 1}`;
    if (options.route_plan_id.length + suffix.length <= 100) {
      return `${options.route_plan_id}${suffix}`;
    }
    const digest = createHash("sha256")
      .update(`${options.route_plan_id}\0${index + 1}`)
      .digest("hex")
      .slice(0, 12);
    const tail = `:${digest}${suffix}`;
    return `${options.route_plan_id.slice(0, 100 - tail.length)}${tail}`;
  };
  const normalized = assignments.map((assignment, index): RoleAssignment => ({
    assignment_id: assignmentId(index),
    role_id: assignment.role_id,
    source_span: assignment.source_span,
    mode,
  }));
  const plan: RoutePlanV2 = {
    schema_version: 2,
    route_plan_id: options.route_plan_id,
    interaction_id: options.interaction.interaction_id,
    assignments: normalized as [RoleAssignment] | [RoleAssignment, RoleAssignment],
    reason,
    created_at_ms: (options.clock ?? Date.now)(),
  };
  validateRoutePlan(plan, options.interaction);
  return plan;
}

function fallback(
  options: RouteInteractionOptions,
  reason: Extract<RouteReason, "invalid_model_output" | "provider_error">,
  code: string,
): RouteInteractionResult {
  return {
    plan: makePlan(options, [{
      role_id: "human",
      source_span: { start: 0, end: options.interaction.text.length },
    }], reason, "clarify"),
    model_output_accepted: false,
    fallback_error_code: code,
  };
}

export async function routeInteraction(
  options: RouteInteractionOptions,
): Promise<RouteInteractionResult> {
  validateUserTextInteraction(options.interaction);
  assertContractId(options.route_plan_id, "route_plan_id");
  let response;
  try {
    response = await options.provider.chat({
      messages: [
        { role: "system", content: ROLE_ROUTER_SYSTEM_PROMPT },
        { role: "user", content: options.interaction.text },
      ],
      options: ROLE_ROUTER_MODEL_OPTIONS,
      format: ROLE_ROUTER_DECISION_SCHEMA,
      think: QWEN_THINKING_ENABLED,
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    }, options.signal);
  } catch (error) {
    if (error instanceof OllamaProviderError) {
      return fallback(options, "provider_error", error.code);
    }
    return fallback(options, "provider_error", "UNEXPECTED_PROVIDER_ERROR");
  }

  if (
    (response.message.tool_calls?.length ?? 0) > 0
    || (response.message.thinking?.trim().length ?? 0) > 0
  ) {
    return fallback(options, "invalid_model_output", "ROUTER_POLICY_VIOLATION");
  }

  let decision: RouterDecision;
  try {
    decision = parseStructuredOutput<RouterDecision>(
      ROLE_ROUTER_DECISION_SCHEMA,
      response.message.content,
    );
  } catch {
    return fallback(options, "invalid_model_output", "INVALID_ROUTE_DECISION");
  }
  let plan: RoutePlanV2;
  try {
    const clarify = decision.assignments.find((assignment) => assignment.role === "clarify");
    if (clarify !== undefined) {
      if (
        decision.assignments.length !== 1
        || clarify.text !== options.interaction.text
      ) {
        throw new TypeError("clarify must be the only full-span assignment");
      }
      plan = makePlan(options, [{
        role_id: "human",
        source_span: { start: 0, end: options.interaction.text.length },
      }], "model_clarify", "clarify");
    } else {
      let offset = 0;
      const assignments = decision.assignments.map((assignment) => {
        if (assignment.role === "clarify") {
          throw new TypeError("clarify cannot be mixed with another assignment");
        }
        const start = offset;
        const end = start + assignment.text.length;
        if (options.interaction.text.slice(start, end) !== assignment.text) {
          throw new TypeError("assignment text must be an exact ordered source substring");
        }
        offset = end;
        return {
          role_id: assignment.role,
          source_span: { start, end },
        };
      });
      if (offset !== options.interaction.text.length) {
        throw new TypeError("assignment text must cover the complete source interaction");
      }
      const reason: RouteReason = assignments.length === 2
        ? "model_mixed"
        : assignments[0]?.role_id === "robot"
          ? "model_robot"
          : "model_human";
      plan = makePlan(options, assignments, reason);
    }
  } catch {
    return fallback(options, "invalid_model_output", "INVALID_ROUTE_PLAN");
  }
  if (
    options.human_only === true
    && plan.assignments.some((assignment) => assignment.role_id !== "human")
  ) {
    return fallback(options, "invalid_model_output", "ROBOT_ROLE_DISABLED");
  }
  return {
    plan,
    model_output_accepted: true,
    fallback_error_code: null,
  };
}
