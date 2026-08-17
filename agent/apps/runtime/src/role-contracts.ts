export const ROLE_IDS = ["robot", "human", "cat"] as const;

export type RoleId = (typeof ROLE_IDS)[number];
export type UserRoutableRoleId = Extract<RoleId, "robot" | "human">;

export interface UserTextInteraction {
  readonly schema_version: 1;
  readonly interaction_id: string;
  readonly kind: "user_text";
  readonly text: string;
  readonly locale: "zh-CN";
  readonly source: "touch" | "voice" | "simulator";
  readonly received_at_ms: number;
}

export interface SourceSpan {
  /** JavaScript UTF-16 code-unit offset, inclusive. */
  readonly start: number;
  /** JavaScript UTF-16 code-unit offset, exclusive. */
  readonly end: number;
}

export interface RoleAssignment {
  readonly assignment_id: string;
  readonly role_id: UserRoutableRoleId;
  readonly source_span: SourceSpan;
  readonly mode: "respond" | "clarify";
}

export type RouteReason =
  | "model_human"
  | "model_robot"
  | "model_clarify"
  | "invalid_model_output"
  | "provider_error";

export interface RoutePlan {
  readonly schema_version: 1;
  readonly route_plan_id: string;
  readonly interaction_id: string;
  /** Phase 2 deliberately permits exactly one assignment. Phase 4 may widen this. */
  readonly assignments: readonly [RoleAssignment];
  readonly reason: RouteReason;
  readonly created_at_ms: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function assertContractId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value.length > 100) {
    throw new TypeError(`${label} must be a contract-safe identifier of at most 100 characters`);
  }
}

export function validateUserTextInteraction(interaction: UserTextInteraction): void {
  if (
    interaction.schema_version !== 1
    || interaction.kind !== "user_text"
    || interaction.locale !== "zh-CN"
    || !["touch", "voice", "simulator"].includes(interaction.source)
  ) {
    throw new TypeError("interaction envelope is invalid or unsupported");
  }
  assertContractId(interaction.interaction_id, "interaction_id");
  if (interaction.text.trim().length === 0 || interaction.text.length > 1_024) {
    throw new TypeError("interaction text must contain 1..1024 characters");
  }
  if (!Number.isSafeInteger(interaction.received_at_ms) || interaction.received_at_ms < 0) {
    throw new TypeError("received_at_ms must be a non-negative safe integer");
  }
}

export function validateRoutePlan(plan: RoutePlan, interaction: UserTextInteraction): void {
  if (plan.schema_version !== 1) {
    throw new TypeError("route plan schema_version is unsupported");
  }
  assertContractId(plan.route_plan_id, "route_plan_id");
  if (plan.interaction_id !== interaction.interaction_id) {
    throw new TypeError("route plan interaction_id does not match its interaction");
  }
  if (plan.assignments.length !== 1) {
    throw new TypeError("Phase 2 route plans must contain exactly one assignment");
  }
  const assignment = plan.assignments[0];
  assertContractId(assignment.assignment_id, "assignment_id");
  if (
    (assignment.role_id !== "human" && assignment.role_id !== "robot")
    || (assignment.mode !== "respond" && assignment.mode !== "clarify")
  ) {
    throw new TypeError("route assignment role or mode is invalid");
  }
  if (assignment.source_span.start !== 0 || assignment.source_span.end !== interaction.text.length) {
    throw new TypeError("Phase 2 assignment must cover the complete user text");
  }
  if (assignment.role_id === "robot" && assignment.mode !== "respond") {
    throw new TypeError("robot assignments cannot be used as a clarification fallback");
  }
  if (plan.reason === "model_robot" && assignment.role_id !== "robot") {
    throw new TypeError("model_robot reason requires a robot assignment");
  }
  if (plan.reason !== "model_robot" && assignment.role_id !== "human") {
    throw new TypeError("all non-robot route outcomes must fail closed to Human");
  }
  if (![
    "model_human",
    "model_robot",
    "model_clarify",
    "invalid_model_output",
    "provider_error",
  ].includes(plan.reason)) {
    throw new TypeError("route plan reason is invalid");
  }
  if (!Number.isSafeInteger(plan.created_at_ms) || plan.created_at_ms < 0) {
    throw new TypeError("created_at_ms must be a non-negative safe integer");
  }
}
