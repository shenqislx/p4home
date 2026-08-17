import { parseStructuredOutput } from "@p4home/contracts";
import {
  OllamaProviderError,
  type OllamaProvider,
} from "@p4home/provider-ollama";

import { QWEN_THINKING_ENABLED } from "./model-config.ts";
import {
  assertContractId,
  type RoutePlan,
  type RouteReason,
  type UserTextInteraction,
  validateRoutePlan,
  validateUserTextInteraction,
} from "./role-contracts.ts";

export const ROLE_ROUTER_SYSTEM_PROMPT = [
  "你是 P4 Home 的 Role Router，只做单标签分类，不回答用户，也没有任何工具。",
  "明确的 Home Assistant 家居查询或控制命令分类为 robot；普通对话、知识问答、情绪表达分类为 human；",
  "混合意图、含糊目标、否定或条件式命令、无法确定的输入分类为 clarify。",
  "输出必须严格等于以下三个单行 JSON 之一：{\"role\":\"human\"}、{\"role\":\"robot\"}、{\"role\":\"clarify\"}。",
  "禁止使用 intent、label 等其他字段，禁止 Markdown、解释或额外文本。",
].join("");

export const ROLE_ROUTER_DECISION_SCHEMA = {
  type: "object",
  required: ["role"],
  properties: {
    role: { enum: ["human", "robot", "clarify"] },
  },
  additionalProperties: false,
} as const;

export const ROLE_ROUTER_MODEL_OPTIONS = {
  temperature: 0,
  seed: 42,
  num_ctx: 4_096,
  num_predict: 32,
} as const;

interface RouterDecision {
  readonly role: "human" | "robot" | "clarify";
}

export interface RouteInteractionOptions {
  readonly interaction: UserTextInteraction;
  readonly route_plan_id: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
}

export interface RouteInteractionResult {
  readonly plan: RoutePlan;
  readonly model_output_accepted: boolean;
  readonly fallback_error_code: string | null;
}

function makePlan(
  options: RouteInteractionOptions,
  role: RouterDecision["role"],
  reason: RouteReason,
): RoutePlan {
  const humanFallback = role !== "robot";
  const plan: RoutePlan = {
    schema_version: 1,
    route_plan_id: options.route_plan_id,
    interaction_id: options.interaction.interaction_id,
    assignments: [{
      // Identity namespaces are carried by field names; reusing the safe plan
      // token avoids creating an over-length derived identifier.
      assignment_id: options.route_plan_id,
      role_id: humanFallback ? "human" : "robot",
      source_span: { start: 0, end: options.interaction.text.length },
      mode: role === "clarify" ? "clarify" : "respond",
    }],
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
    plan: makePlan(options, "clarify", reason),
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
  const reason: RouteReason = decision.role === "robot"
    ? "model_robot"
    : decision.role === "human"
      ? "model_human"
      : "model_clarify";
  return {
    plan: makePlan(options, decision.role, reason),
    model_output_accepted: true,
    fallback_error_code: null,
  };
}
