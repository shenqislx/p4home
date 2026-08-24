import type {
  Action,
  AgentProfile,
  Event,
  Message,
  Run,
  Session,
  ToolCall,
  ToolResult,
} from "@p4home/core";

export interface StoredToolCall extends ToolCall {
  readonly run_id: string;
  readonly status: "pending" | "success" | "error";
  readonly created_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly result: Record<string, unknown> | null;
  readonly error: ToolResult["error"];
}

export interface RunAuditTrace {
  readonly run: Run;
  readonly messages: readonly Message[];
  readonly tool_calls: readonly StoredToolCall[];
  readonly actions: readonly Action[];
  readonly events: readonly Event[];
}

export interface AuditToolCallWrite {
  readonly run_id: string;
  readonly call: ToolCall;
  readonly created_at_ms: number;
}

export interface AuditToolResultWrite {
  readonly run_id: string;
  readonly result: ToolResult;
  readonly completed_at_ms: number;
}

export interface AuditWriteBatch {
  readonly run?: Run;
  readonly messages?: readonly Message[];
  readonly tool_calls?: readonly AuditToolCallWrite[];
  readonly tool_results?: readonly AuditToolResultWrite[];
  readonly actions?: readonly Action[];
  readonly events?: readonly Event[];
}

export interface AuditStore {
  saveAgentProfile(profile: AgentProfile): Promise<void>;
  saveSession(session: Session): Promise<void>;
  saveRun(run: Run): Promise<void>;
  saveMessage(message: Message): Promise<void>;
  saveToolCall(runId: string, call: ToolCall, createdAtMs: number): Promise<void>;
  saveAction(action: Action): Promise<void>;
  saveToolResult(runId: string, result: ToolResult, completedAtMs: number): Promise<void>;
  appendEvent(event: Event): Promise<void>;
  writeBatch(batch: AuditWriteBatch): Promise<void>;
  getSessionAgentProfile(sessionId: string): Promise<AgentProfile | null>;
  getRunTrace(runId: string): Promise<RunAuditTrace | null>;
  listSessionMessages(sessionId: string): Promise<readonly Message[]>;
  listRunIdsForInteraction(interactionId: string): Promise<readonly string[]>;
}

export type MemoryKind = "conversation_summary" | "user_fact" | "task_outcome";
export type MemoryOwnerRole = "robot" | "human" | "cat";
export type MemoryVisibilityScope = "owner_only" | "explicit_roles";
export type MemoryProjectionStrategy = "private" | "shared_acl" | "hybrid";
export type MemorySensitivity = "normal" | "personal" | "restricted";
export type MemoryDeletionReason =
  | "user_request"
  | "privacy_request"
  | "correction"
  | "policy_violation";
export type MemorySource =
  | "user_explicit"
  | "model_derived"
  | "task_execution"
  | "system_event";

export interface MemoryRecord {
  readonly schema_version: 1;
  readonly memory_id: string;
  readonly revision: number;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly source: MemorySource;
  readonly source_interaction_id: string | null;
  readonly confidence: number;
  readonly sensitivity: MemorySensitivity;
  readonly owner_role: MemoryOwnerRole;
  readonly visibility_scope: MemoryVisibilityScope;
  readonly visible_to_roles: readonly MemoryOwnerRole[];
  readonly policy_revision: number;
  readonly tags: readonly string[];
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly expires_at_ms: number | null;
  readonly idempotency_key: string;
  readonly subject_key: string;
  readonly supersedes_memory_id: string | null;
}

export interface MemoryCreate {
  readonly schema_version: 1;
  readonly memory_id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly source: MemorySource;
  readonly source_interaction_id: string | null;
  readonly confidence: number;
  readonly sensitivity: MemorySensitivity;
  readonly owner_role: MemoryOwnerRole;
  readonly visibility_scope: MemoryVisibilityScope;
  readonly visible_to_roles: readonly MemoryOwnerRole[];
  readonly policy_revision: number;
  readonly tags: readonly string[];
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
  /** Required by the 6B canonical writer; legacy callers receive an ID-scoped default. */
  readonly idempotency_key?: string;
  /** Required by the 6B canonical writer; legacy callers receive an ID-scoped default. */
  readonly subject_key?: string;
  readonly supersedes_memory_id?: string | null;
}

export type CanonicalMemoryCreate = Omit<
  MemoryCreate,
  "idempotency_key" | "subject_key" | "supersedes_memory_id"
> & {
  readonly idempotency_key: string;
  readonly subject_key: string;
};

export interface MemoryDeletionRequest {
  readonly request_id: string;
  readonly memory_id: string;
  readonly requester_role: MemoryOwnerRole;
  readonly reason: MemoryDeletionReason;
  readonly requested_at_ms: number;
}

export interface MemoryDeletionResult {
  readonly request_id: string;
  readonly requester_role: MemoryOwnerRole;
  readonly reason: MemoryDeletionReason;
  readonly requested_at_ms: number;
  readonly memory_ids: readonly string[];
  readonly deleted_count: number;
}

export interface MemoryUpdate {
  readonly memory_id: string;
  readonly requester_role: MemoryOwnerRole;
  readonly expected_revision: number;
  readonly updated_at_ms: number;
  readonly kind?: MemoryKind;
  readonly content?: string;
  readonly source?: MemorySource;
  readonly source_interaction_id?: string | null;
  readonly confidence?: number;
  readonly sensitivity?: MemorySensitivity;
  readonly visibility_scope?: MemoryVisibilityScope;
  readonly visible_to_roles?: readonly MemoryOwnerRole[];
  readonly policy_revision?: number;
  readonly tags?: readonly string[];
  readonly expires_at_ms?: number | null;
}

export interface MemoryList {
  readonly requester_role: MemoryOwnerRole;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  readonly now_ms?: number;
}

export interface MemorySearch extends MemoryList {
  readonly query: string;
}

export interface MemoryRecall {
  readonly requester_role: MemoryOwnerRole;
  readonly strategy: MemoryProjectionStrategy;
  readonly approved_policy_revision: number;
  readonly query?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly now_ms?: number;
}

export interface MemoryRecallItem extends MemoryRecord {
  /** Larger values are more relevant. Zero denotes a non-FTS recall. */
  readonly recall_relevance: number;
}

export interface MemoryRecallResult {
  readonly items: readonly MemoryRecallItem[];
}

export interface MemoryListPage {
  readonly items: readonly MemoryRecord[];
  readonly next_offset: number | null;
}

export interface MemoryStore {
  createMemory(memory: MemoryCreate): Promise<MemoryRecord>;
  createCanonicalMemory(memory: CanonicalMemoryCreate): Promise<MemoryRecord>;
  getMemory(
    memoryId: string,
    requesterRole: MemoryOwnerRole,
    nowMs?: number,
  ): Promise<MemoryRecord | null>;
  updateMemory(update: MemoryUpdate): Promise<MemoryRecord>;
  listMemories(query: MemoryList): Promise<MemoryListPage>;
  searchMemories(query: MemorySearch): Promise<MemoryListPage>;
  recallMemories(query: MemoryRecall): Promise<MemoryRecallResult>;
  deleteMemory(memoryId: string, requesterRole: MemoryOwnerRole): Promise<boolean>;
  deleteMemoryCascade(request: MemoryDeletionRequest): Promise<MemoryDeletionResult>;
  getMemoryDeletionAudit(
    requestId: string,
    requesterRole: MemoryOwnerRole,
  ): Promise<MemoryDeletionResult | null>;
  purgeExpiredMemories(nowMs?: number, limit?: number): Promise<number>;
}
