import type { RoleAssignment, RoutePlan } from "./role-contracts.ts";
import type { RoleRunResult } from "./role-runner.ts";
import type { ToolResult } from "@p4home/core";

export interface AssignmentRunResult {
  readonly assignment: RoleAssignment;
  readonly run: RoleRunResult;
}

export interface ComposedResponsePart {
  readonly assignment_id: string;
  readonly role_id: "human" | "robot";
  readonly source_span: RoleAssignment["source_span"];
  readonly status: RoleRunResult["status"];
  readonly outcome: RoleRunResult["outcome"];
  readonly text: string;
  readonly error_code: string | null;
  /** Exact structured tool terminals; Human prose cannot replace these facts. */
  readonly tool_results: readonly ToolResult[];
}

export interface ComposedRoleResponse {
  readonly schema_version: 1;
  readonly status: "completed" | "partial" | "failed";
  readonly text: string;
  readonly parts: readonly ComposedResponsePart[];
}

function safeErrorCode(run: RoleRunResult): string {
  const code = run.error?.code ?? run.status.toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "INTERNAL";
}

function quotedSingleLine(text: string): string {
  return JSON.stringify(text)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/**
 * Deterministically compose terminal role runs. This boundary never invokes a
 * model and never infers that a device action occurred from Human prose.
 */
export function composeRoleResponse(
  plan: RoutePlan,
  assignmentRuns: readonly AssignmentRunResult[],
): ComposedRoleResponse {
  if (assignmentRuns.length !== plan.assignments.length) {
    throw new TypeError("composer requires one terminal result for every route assignment");
  }
  const byAssignment = new Map(
    assignmentRuns.map((item) => [item.assignment.assignment_id, item] as const),
  );
  if (byAssignment.size !== assignmentRuns.length) {
    throw new TypeError("composer assignment results must be unique");
  }

  const ordered = plan.assignments.map((assignment): AssignmentRunResult => {
    const item = byAssignment.get(assignment.assignment_id);
    if (
      item === undefined
      || item.assignment.role_id !== assignment.role_id
      || item.assignment.source_span.start !== assignment.source_span.start
      || item.assignment.source_span.end !== assignment.source_span.end
      || item.run.role_id !== assignment.role_id
    ) {
      throw new TypeError("composer result does not match its validated route assignment");
    }
    if (item.run.status === "completed" && item.run.final_text.trim().length === 0) {
      throw new TypeError("completed role run must contain final_text");
    }
    return item;
  });

  const completed = ordered.filter((item) => item.run.status === "completed").length;
  const status = completed === ordered.length
    ? "completed"
    : completed === 0
      ? "failed"
      : "partial";
  const parts = ordered.map(({ assignment, run }): ComposedResponsePart => ({
    assignment_id: assignment.assignment_id,
    role_id: assignment.role_id,
    source_span: assignment.source_span,
    status: run.status,
    outcome: run.outcome,
    text: run.status === "completed" ? run.final_text : "",
    error_code: run.status === "completed" ? null : safeErrorCode(run),
    tool_results: run.tool_results,
  }));
  const text = parts.length === 1 && parts[0]?.status === "completed"
    ? parts[0].text
    : parts.map((part) => {
        const label = part.role_id === "human" ? "Human" : "Robot";
        return part.status === "completed"
          ? `${label}：${quotedSingleLine(part.text)}`
          : `${label}：未完成（${part.error_code ?? "INTERNAL"}）`;
      }).join("\n");

  return { schema_version: 1, status, text, parts };
}
