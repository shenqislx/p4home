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

export interface HumanAvatarAssignment {
  readonly assignment_id: string;
  readonly role_id: "human";
  readonly source_span: SourceSpan;
  readonly mode: "respond";
  readonly capability: "avatar";
}

export type RouteAssignment = RoleAssignment | HumanAvatarAssignment;

export type RouteReason =
  | "model_human"
  | "model_human_avatar"
  | "model_robot"
  | "model_mixed"
  | "model_clarify"
  | "invalid_model_output"
  | "provider_error";

export interface RoutePlanV1 {
  readonly schema_version: 1;
  readonly route_plan_id: string;
  readonly interaction_id: string;
  /** Phase 2 deliberately permits exactly one assignment. Phase 4 may widen this. */
  readonly assignments: readonly [RoleAssignment];
  readonly reason: RouteReason;
  readonly created_at_ms: number;
}

export interface RoutePlanV2 {
  readonly schema_version: 2;
  readonly route_plan_id: string;
  readonly interaction_id: string;
  /** One full-span assignment, or one Human and one Robot assignment. */
  readonly assignments: readonly [RoleAssignment] | readonly [RoleAssignment, RoleAssignment];
  readonly reason: RouteReason;
  readonly created_at_ms: number;
}

export interface RoutePlanV3 {
  readonly schema_version: 3;
  readonly route_plan_id: string;
  readonly interaction_id: string;
  /** RoutePlan v3 adds the isolated Human-avatar execution lane. */
  readonly assignments: readonly [HumanAvatarAssignment];
  readonly reason: "model_human_avatar";
  readonly created_at_ms: number;
}

export type RoutePlan = RoutePlanV1 | RoutePlanV2 | RoutePlanV3;

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
  if (plan.schema_version !== 1 && plan.schema_version !== 2 && plan.schema_version !== 3) {
    throw new TypeError("route plan schema_version is unsupported");
  }
  assertContractId(plan.route_plan_id, "route_plan_id");
  if (plan.interaction_id !== interaction.interaction_id) {
    throw new TypeError("route plan interaction_id does not match its interaction");
  }
  if (plan.schema_version === 1 && plan.assignments.length !== 1) {
    throw new TypeError("Phase 2 route plans must contain exactly one assignment");
  }
  if (![
    "model_human",
    "model_human_avatar",
    "model_robot",
    "model_mixed",
    "model_clarify",
    "invalid_model_output",
    "provider_error",
  ].includes(plan.reason)) {
    throw new TypeError("route plan reason is invalid");
  }
  if (!Number.isSafeInteger(plan.created_at_ms) || plan.created_at_ms < 0) {
    throw new TypeError("created_at_ms must be a non-negative safe integer");
  }

  if (plan.schema_version === 1) {
    validateV1Assignments(plan, interaction);
    return;
  }
  if (plan.schema_version === 3) {
    validateV3Assignments(plan, interaction);
    return;
  }
  validateV2Assignments(plan, interaction);
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF);
}

function validateAssignmentShape(assignment: RouteAssignment, interaction: UserTextInteraction): void {
  assertContractId(assignment.assignment_id, "assignment_id");
  if (
    (assignment.role_id !== "human" && assignment.role_id !== "robot")
    || (assignment.mode !== "respond" && assignment.mode !== "clarify")
  ) {
    throw new TypeError("route assignment role or mode is invalid");
  }
  const { start, end } = assignment.source_span;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end > interaction.text.length
    || start >= end
  ) {
    throw new TypeError("route assignment span must be a non-empty in-bounds UTF-16 range");
  }
  if (!isUtf16Boundary(interaction.text, start) || !isUtf16Boundary(interaction.text, end)) {
    throw new TypeError("route assignment span cannot split a UTF-16 surrogate pair");
  }
  if (interaction.text.slice(start, end).trim().length === 0) {
    throw new TypeError("route assignment span cannot contain only whitespace");
  }
  if (assignment.role_id === "robot" && assignment.mode !== "respond") {
    throw new TypeError("robot assignments cannot be used as a clarification fallback");
  }
}

function validateV1Assignments(plan: RoutePlanV1, interaction: UserTextInteraction): void {
  const assignment = plan.assignments[0];
  validateAssignmentShape(assignment, interaction);
  if (assignment.source_span.start !== 0 || assignment.source_span.end !== interaction.text.length) {
    throw new TypeError("Phase 2 assignment must cover the complete user text");
  }
  if (plan.reason === "model_mixed") {
    throw new TypeError("Phase 2 route plans cannot use model_mixed reason");
  }
  if (plan.reason === "model_robot" && assignment.role_id !== "robot") {
    throw new TypeError("model_robot reason requires a robot assignment");
  }
  if (plan.reason !== "model_robot" && assignment.role_id !== "human") {
    throw new TypeError("all non-robot route outcomes must fail closed to Human");
  }
  if ("capability" in assignment || plan.reason === "model_human_avatar") {
    throw new TypeError("Phase 2 route plans do not support Human avatar actions");
  }
}

function validateV2Assignments(plan: RoutePlanV2, interaction: UserTextInteraction): void {
  if (plan.assignments.length < 1 || plan.assignments.length > 2) {
    throw new TypeError("Phase 4 route plans must contain one or two assignments");
  }
  const ids = new Set<string>();
  const roles = new Set<UserRoutableRoleId>();
  let expectedStart = 0;
  for (const assignment of plan.assignments) {
    if ("capability" in assignment) {
      throw new TypeError("RoutePlan v2 assignments cannot carry execution capabilities");
    }
    validateAssignmentShape(assignment, interaction);
    if (ids.has(assignment.assignment_id)) {
      throw new TypeError("route assignment_id values must be unique");
    }
    if (roles.has(assignment.role_id)) {
      throw new TypeError("a two-assignment route plan must contain one Human and one Robot assignment");
    }
    if (assignment.source_span.start !== expectedStart) {
      throw new TypeError("Phase 4 assignment spans must be ordered and continuously cover the input");
    }
    ids.add(assignment.assignment_id);
    roles.add(assignment.role_id);
    expectedStart = assignment.source_span.end;
  }
  if (expectedStart !== interaction.text.length) {
    throw new TypeError("Phase 4 assignment spans must cover the complete user text");
  }

  const clarification = plan.assignments.some((assignment) => assignment.mode === "clarify");
  if (clarification) {
    const assignment = plan.assignments[0];
    const validReason = plan.reason === "model_clarify"
      || plan.reason === "invalid_model_output"
      || plan.reason === "provider_error";
    if (
      plan.assignments.length !== 1
      || assignment.role_id !== "human"
      || assignment.source_span.start !== 0
      || assignment.source_span.end !== interaction.text.length
      || !validReason
    ) {
      throw new TypeError("Phase 4 clarification must fail closed to one full-span Human assignment");
    }
    return;
  }
  if (plan.assignments.length === 2 && plan.reason !== "model_mixed") {
    throw new TypeError("two assignments require model_mixed reason");
  }
  if (plan.reason === "model_human_avatar") {
    throw new TypeError("Human avatar routes require RoutePlan v3");
  }
  if (plan.assignments.length === 1) {
    const role = plan.assignments[0].role_id;
    if (
      (role === "human"
        && plan.reason !== "model_human")
      || (role === "robot" && plan.reason !== "model_robot")
    ) {
      throw new TypeError("single assignment reason must match its role");
    }
  }
}

function validateV3Assignments(plan: RoutePlanV3, interaction: UserTextInteraction): void {
  if (plan.assignments.length !== 1 || plan.reason !== "model_human_avatar") {
    throw new TypeError("RoutePlan v3 requires one Human avatar assignment");
  }
  const assignment = plan.assignments[0];
  validateAssignmentShape(assignment, interaction);
  if (
    assignment.role_id !== "human"
    || assignment.mode !== "respond"
    || assignment.capability !== "avatar"
    || assignment.source_span.start !== 0
    || assignment.source_span.end !== interaction.text.length
  ) {
    throw new TypeError("RoutePlan v3 Human avatar assignment must cover the complete user text");
  }
}

export function isHumanAvatarAssignment(
  assignment: RouteAssignment,
): assignment is HumanAvatarAssignment {
  return "capability" in assignment && assignment.capability === "avatar";
}
