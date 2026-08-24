import { createHash } from "node:crypto";

import type {
  AuditStore,
  MemoryRecord,
  MemoryStore,
  RunAuditTrace,
  StoredToolCall,
} from "@p4home/storage-sqlite";

import {
  evaluateMemoryCandidate,
  type MemoryCandidate,
  type MemoryEvidence,
  type MemoryPolicyRejectionCode,
  type TaskOutcomeEvidence,
  type UserStatementEvidence,
} from "./memory-policy.ts";

export type MemoryWriteResult =
  | {
    readonly accepted: true;
    readonly memory: MemoryRecord;
  }
  | {
    readonly accepted: false;
    readonly code: MemoryPolicyRejectionCode;
  };

export interface MemoryWriteCoordinatorStore
extends Pick<MemoryStore, "createCanonicalMemory">,
  Pick<AuditStore, "getRunTrace" | "listRunIdsForInteraction"> {}

export interface MemoryCandidateWriter {
  submit(
    candidate: MemoryCandidate,
    evidence: MemoryEvidence,
  ): Promise<MemoryWriteResult>;
}

export interface MemoryWriteBoundaries {
  readonly runtime: MemoryCandidateWriter;
  readonly model: MemoryCandidateWriter;
  readonly router: MemoryCandidateWriter;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function digestAuditedToolResult(tool: StoredToolCall): string {
  return createHash("sha256").update(stableJson({
    tool_call_id: tool.tool_call_id,
    name: tool.name,
    status: tool.status,
    result: tool.result,
    error: tool.error,
  }), "utf8").digest("hex");
}

function terminal(trace: RunAuditTrace): boolean {
  return ["completed", "failed", "cancelled", "timed_out"].includes(trace.run.status);
}

function traceHasIdentity(
  trace: RunAuditTrace,
  interactionId: string,
  roleId: MemoryCandidate["owner_role"],
): boolean {
  const starts = trace.events.filter((event) => event.type === "role.run.started");
  const terminals = trace.events.filter((event) =>
    event.type === `role.run.${trace.run.status}`);
  return terminal(trace)
    && trace.run.completed_at_ms !== null
    && starts.length === 1
    && starts[0]?.payload.interaction_id === interactionId
    && starts[0]?.payload.role_id === roleId
    && terminals.length === 1
    && terminals[0]?.payload.interaction_id === interactionId
    && terminals[0]?.payload.role_id === roleId
    && terminals[0]?.payload.status === trace.run.status;
}

function messageMetadataMatches(
  message: RunAuditTrace["messages"][number],
  expected: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(expected).every(([key, value]) => message.metadata[key] === value);
}

class AuditedMemoryWriteCoordinator implements MemoryCandidateWriter {
  readonly #store: MemoryWriteCoordinatorStore;

  public constructor(store: MemoryWriteCoordinatorStore) {
    this.#store = store;
  }

  public async submit(
    candidateInput: MemoryCandidate,
    evidenceInput: MemoryEvidence,
  ): Promise<MemoryWriteResult> {
    let candidate: MemoryCandidate;
    let evidence: MemoryEvidence;
    try {
      candidate = structuredClone(candidateInput);
      evidence = structuredClone(evidenceInput);
    } catch {
      return { accepted: false, code: "INVALID_CANDIDATE" };
    }
    const decision = evaluateMemoryCandidate(candidate, evidence);
    if (!decision.accepted) {
      return decision;
    }
    if (!await this.#evidenceIsAudited(candidate, evidence)) {
      return { accepted: false, code: "EVIDENCE_NOT_AUDITED" };
    }
    return {
      accepted: true,
      memory: await this.#store.createCanonicalMemory(decision.memory),
    };
  }

  async #evidenceIsAudited(
    candidate: MemoryCandidate,
    evidence: MemoryEvidence,
  ): Promise<boolean> {
    if (evidence.kind === "conversation_summary") {
      const runIds = await this.#store.listRunIdsForInteraction(evidence.interaction_id);
      if (!runIds.includes(evidence.run_id)) {
        return false;
      }
      const trace = await this.#store.getRunTrace(evidence.run_id);
      if (
        trace === null
        || trace.run.status !== "completed"
        || !traceHasIdentity(trace, evidence.interaction_id, evidence.role_id)
      ) {
        return false;
      }
      return trace.messages.some((message) =>
        message.message_id === evidence.summary_message_id
        && message.role === "assistant"
        && normalized(message.content) === normalized(candidate.content)
        && messageMetadataMatches(message, {
          interaction_id: evidence.interaction_id,
          role_id: evidence.role_id,
          memory_kind: "conversation_summary",
          summary_origin: "runtime_controlled",
        }));
    }
    if (evidence.kind === "task_outcome") {
      return await this.#taskEvidenceIsAudited(candidate, evidence);
    }
    for (const statement of evidence.statements) {
      if (!await this.#statementIsAudited(candidate, statement)) {
        return false;
      }
    }
    return true;
  }

  async #statementIsAudited(
    candidate: MemoryCandidate,
    statement: UserStatementEvidence,
  ): Promise<boolean> {
    const runIds = await this.#store.listRunIdsForInteraction(statement.interaction_id);
    if (!runIds.includes(statement.run_id)) {
      return false;
    }
    const trace = await this.#store.getRunTrace(statement.run_id);
    return trace !== null
      && traceHasIdentity(trace, statement.interaction_id, statement.role_id)
      && statement.role_id === candidate.owner_role
      && trace.messages.some((message) =>
        message.message_id === statement.message_id
        && message.role === "user"
        && normalized(message.content) === normalized(statement.text)
        && messageMetadataMatches(message, {
          interaction_id: statement.interaction_id,
          role_id: statement.role_id,
          memory_assertion: statement.assertion,
        }));
  }

  async #taskEvidenceIsAudited(
    candidate: MemoryCandidate,
    evidence: TaskOutcomeEvidence,
  ): Promise<boolean> {
    const runIds = await this.#store.listRunIdsForInteraction(evidence.interaction_id);
    if (!runIds.includes(evidence.run_id)) {
      return false;
    }
    const trace = await this.#store.getRunTrace(evidence.run_id);
    if (
      trace === null
      || trace.run.status !== evidence.run_status
      || !traceHasIdentity(trace, evidence.interaction_id, evidence.role_id)
      || evidence.role_id !== candidate.owner_role
    ) {
      return false;
    }
    const tool = trace.tool_calls.find((candidate) =>
      candidate.tool_call_id === evidence.tool_call_id
      && candidate.name === evidence.tool_name);
    if (
      tool === undefined
      || tool.status !== evidence.tool_status
      || digestAuditedToolResult(tool) !== evidence.result_digest
    ) {
      return false;
    }
    if (
      (evidence.outcome === "cancelled" && tool.error?.code !== "CANCELLED")
      || (evidence.outcome === "timed_out" && tool.error?.code !== "DEADLINE_EXCEEDED")
    ) {
      return false;
    }
    const toolMessageMatches = trace.messages.some((message) => {
      if (
        message.role !== "tool"
        || message.tool_name !== tool.name
        || !messageMetadataMatches(message, {
          interaction_id: evidence.interaction_id,
          role_id: evidence.role_id,
          tool_call_id: tool.tool_call_id,
          status: tool.status,
        })
      ) {
        return false;
      }
      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        return stableJson(parsed) === stableJson({
          schema_version: 1,
          tool_call_id: tool.tool_call_id,
          name: tool.name,
          status: tool.status,
          result: tool.result,
          error: tool.error,
        });
      } catch {
        return false;
      }
    });
    const summaryMatches = trace.messages.some((message) =>
      message.message_id === evidence.summary_message_id
      && message.role === "assistant"
      && normalized(message.content) === normalized(candidate.content)
      && messageMetadataMatches(message, {
        interaction_id: evidence.interaction_id,
        role_id: evidence.role_id,
        memory_kind: "task_outcome",
        summary_origin: "runtime_controlled",
        tool_call_id: evidence.tool_call_id,
        result_digest: evidence.result_digest,
        outcome: evidence.outcome,
      }));
    return toolMessageMatches && summaryMatches;
  }
}

export function createMemoryWriteBoundaries(
  store: MemoryWriteCoordinatorStore,
): MemoryWriteBoundaries {
  const audited = new AuditedMemoryWriteCoordinator(store);
  const rejectRouter: MemoryCandidateWriter = {
    async submit(): Promise<MemoryWriteResult> {
      return { accepted: false, code: "ROUTER_WRITE_FORBIDDEN" };
    },
  };
  return Object.freeze({
    runtime: audited,
    model: audited,
    router: Object.freeze(rejectRouter),
  });
}
