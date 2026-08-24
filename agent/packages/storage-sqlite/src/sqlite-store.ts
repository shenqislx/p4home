import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  Action,
  AgentProfile,
  Event,
  Message,
  Run,
  Session,
  ToolCall,
  ToolError,
  ToolResult,
} from "@p4home/core";

import type {
  AuditStore,
  AuditWriteBatch,
  CanonicalMemoryCreate,
  MemoryCreate,
  MemoryDeletionReason,
  MemoryDeletionRequest,
  MemoryDeletionResult,
  MemoryKind,
  MemoryList,
  MemoryListPage,
  MemoryOwnerRole,
  MemoryProjectionStrategy,
  MemoryRecall,
  MemoryRecallItem,
  MemoryRecallResult,
  MemoryRecord,
  MemorySearch,
  MemorySensitivity,
  MemorySource,
  MemoryStore,
  MemoryUpdate,
  MemoryVisibilityScope,
  RunAuditTrace,
  StoredToolCall,
} from "./types.ts";

const SCHEMA_VERSION = 4;
const MEMORY_SCHEMA_VERSION = 1;
const MAX_MEMORY_ID_LENGTH = 128;
const MAX_MEMORY_CONTENT_LENGTH = 32_768;
const MAX_INTERACTION_ID_LENGTH = 128;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_LENGTH = 64;
const MAX_MEMORY_PAGE_SIZE = 100;
const DEFAULT_MEMORY_PAGE_SIZE = 50;
const MAX_MEMORY_OFFSET = 10_000;
const MAX_MEMORY_SEARCH_LENGTH = 512;
const MAX_MEMORY_SEARCH_TERMS = 16;
const MAX_MEMORY_PURGE_SIZE = 1_000;
const MAX_MEMORY_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_MEMORY_SUBJECT_KEY_LENGTH = 256;
const MAX_DELETION_REQUEST_ID_LENGTH = 128;
const MAX_DELETION_DESCENDANTS = 1_000;
const MAX_LINEAGE_DEPTH = 256;

const MEMORY_KINDS = new Set<MemoryKind>([
  "conversation_summary",
  "user_fact",
  "task_outcome",
]);
const MEMORY_OWNER_ROLES = new Set<MemoryOwnerRole>(["robot", "human", "cat"]);
const MEMORY_SOURCES = new Set<MemorySource>([
  "user_explicit",
  "model_derived",
  "task_execution",
  "system_event",
]);
const MEMORY_SENSITIVITIES = new Set<MemorySensitivity>([
  "normal",
  "personal",
  "restricted",
]);
const MEMORY_VISIBILITY_SCOPES = new Set<MemoryVisibilityScope>([
  "owner_only",
  "explicit_roles",
]);
const MEMORY_DELETION_REASONS = new Set<MemoryDeletionReason>([
  "user_request",
  "privacy_request",
  "correction",
  "policy_violation",
]);
const MEMORY_PROJECTION_STRATEGIES = new Set<MemoryProjectionStrategy>([
  "private",
  "shared_acl",
  "hybrid",
]);

export interface SqliteAuditStoreOptions {
  readonly timeout_ms?: number;
  /**
   * Recover non-terminal records left by a previous Runtime process before
   * accepting new work. Disable only for a concurrent diagnostic reader.
   */
  readonly reconcile_on_open?: boolean;
}

export interface AuditRecoveryReport {
  readonly run_ids: readonly string[];
  readonly recovered_tool_calls: number;
  readonly recovered_actions: number;
}

export class AuditStorageError extends Error {
  public constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AuditStorageError";
  }
}

function json(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError("value is not JSON serializable");
    }
    return encoded;
  } catch (error) {
    throw new AuditStorageError(`${label} is not JSON serializable`, { cause: error });
  }
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") {
    throw new AuditStorageError(`${label} is not stored as JSON text`);
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new AuditStorageError(`${label} contains invalid JSON`, { cause: error });
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AuditStorageError(`${label} is not text`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AuditStorageError(`${label} is not a safe integer`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : numberValue(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuditStorageError(`${label} is not a finite number`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
  ) {
    throw new AuditStorageError(
      `${label} must be non-empty trimmed text of at most ${maxLength} characters`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AuditStorageError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AuditStorageError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new AuditStorageError(`${label} is invalid`);
  }
  return value as T;
}

function memoryRole(value: unknown, label: string): MemoryOwnerRole {
  return enumValue(value, MEMORY_OWNER_ROLES, label);
}

function memoryRoles(value: unknown, label: string): readonly MemoryOwnerRole[] {
  if (!Array.isArray(value) || value.length > MEMORY_OWNER_ROLES.size) {
    throw new AuditStorageError(`${label} must contain at most three roles`);
  }
  const roles = value.map((role, index) => memoryRole(role, `${label}[${index}]`));
  if (new Set(roles).size !== roles.length) {
    throw new AuditStorageError(`${label} must contain unique roles`);
  }
  return roles.sort();
}

function memoryTags(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_TAGS) {
    throw new AuditStorageError(`${label} must contain at most ${MAX_MEMORY_TAGS} tags`);
  }
  const tags = value.map((tag, index) =>
    boundedText(tag, `${label}[${index}]`, MAX_MEMORY_TAG_LENGTH));
  if (new Set(tags).size !== tags.length) {
    throw new AuditStorageError(`${label} must contain unique tags`);
  }
  return tags.sort();
}

function memoryKinds(value: unknown, label: string): readonly MemoryKind[] {
  if (!Array.isArray(value) || value.length > MEMORY_KINDS.size) {
    throw new AuditStorageError(`${label} must contain at most three kinds`);
  }
  const kinds = value.map((kind, index) =>
    enumValue(kind, MEMORY_KINDS, `${label}[${index}]`));
  if (new Set(kinds).size !== kinds.length) {
    throw new AuditStorageError(`${label} must contain unique kinds`);
  }
  return kinds;
}

function memoryConfidence(value: unknown): number {
  const confidence = finiteNumber(value, "memory.confidence");
  if (confidence < 0 || confidence > 1) {
    throw new AuditStorageError("memory.confidence must be between 0 and 1");
  }
  return confidence;
}

function validateMemoryVisibility(
  ownerRole: MemoryOwnerRole,
  sensitivity: MemorySensitivity,
  visibilityScope: MemoryVisibilityScope,
  visibleToRoles: readonly MemoryOwnerRole[],
): void {
  if (visibilityScope === "owner_only" && visibleToRoles.length !== 0) {
    throw new AuditStorageError(
      "memory.visible_to_roles must be empty for owner_only visibility",
    );
  }
  if (visibilityScope === "explicit_roles" && visibleToRoles.length === 0) {
    throw new AuditStorageError(
      "memory.visible_to_roles must not be empty for explicit_roles visibility",
    );
  }
  if (visibleToRoles.includes(ownerRole)) {
    throw new AuditStorageError(
      "memory.visible_to_roles cannot include memory.owner_role",
    );
  }
  if (sensitivity === "restricted" && visibilityScope !== "owner_only") {
    throw new AuditStorageError(
      "restricted memory must use owner_only visibility",
    );
  }
}

function validateMemoryKindSource(kind: MemoryKind, source: MemorySource): void {
  const expected: Readonly<Record<MemoryKind, MemorySource>> = {
    conversation_summary: "model_derived",
    user_fact: "user_explicit",
    task_outcome: "task_execution",
  };
  if (source !== expected[kind]) {
    throw new AuditStorageError(`memory.source is invalid for memory.kind ${kind}`);
  }
}

interface ValidatedMemoryCreate extends MemoryCreate {
  readonly idempotency_key: string;
  readonly subject_key: string;
  readonly supersedes_memory_id: string | null;
}

function validatedMemoryCreate(memory: MemoryCreate): ValidatedMemoryCreate {
  if (memory.schema_version !== MEMORY_SCHEMA_VERSION) {
    throw new AuditStorageError(
      `memory.schema_version must be ${MEMORY_SCHEMA_VERSION}`,
    );
  }
  const createdAtMs = nonNegativeInteger(memory.created_at_ms, "memory.created_at_ms");
  const expiresAtMs = memory.expires_at_ms === null
    ? null
    : nonNegativeInteger(memory.expires_at_ms, "memory.expires_at_ms");
  if (expiresAtMs !== null && expiresAtMs < createdAtMs) {
    throw new AuditStorageError("memory.expires_at_ms cannot precede created_at_ms");
  }
  const visibilityScope = enumValue(
    memory.visibility_scope,
    MEMORY_VISIBILITY_SCOPES,
    "memory.visibility_scope",
  );
  const ownerRole = memoryRole(memory.owner_role, "memory.owner_role");
  const sensitivity = enumValue(
    memory.sensitivity,
    MEMORY_SENSITIVITIES,
    "memory.sensitivity",
  );
  const visibleToRoles = memoryRoles(memory.visible_to_roles, "memory.visible_to_roles");
  validateMemoryVisibility(ownerRole, sensitivity, visibilityScope, visibleToRoles);
  const memoryId = boundedText(memory.memory_id, "memory.memory_id", MAX_MEMORY_ID_LENGTH);
  const kind = enumValue(memory.kind, MEMORY_KINDS, "memory.kind");
  const source = enumValue(memory.source, MEMORY_SOURCES, "memory.source");
  validateMemoryKindSource(kind, source);
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    memory_id: memoryId,
    kind,
    content: boundedText(memory.content, "memory.content", MAX_MEMORY_CONTENT_LENGTH),
    source,
    source_interaction_id: memory.source_interaction_id === null
      ? null
      : boundedText(
        memory.source_interaction_id,
        "memory.source_interaction_id",
        MAX_INTERACTION_ID_LENGTH,
      ),
    confidence: memoryConfidence(memory.confidence),
    sensitivity,
    owner_role: ownerRole,
    visibility_scope: visibilityScope,
    visible_to_roles: visibleToRoles,
    policy_revision: positiveInteger(memory.policy_revision, "memory.policy_revision"),
    tags: memoryTags(memory.tags, "memory.tags"),
    created_at_ms: createdAtMs,
    expires_at_ms: expiresAtMs,
    idempotency_key: boundedText(
      memory.idempotency_key ?? `legacy:${memoryId}`,
      "memory.idempotency_key",
      MAX_MEMORY_IDEMPOTENCY_KEY_LENGTH,
    ),
    subject_key: boundedText(
      memory.subject_key ?? `legacy:${memoryId}`,
      "memory.subject_key",
      MAX_MEMORY_SUBJECT_KEY_LENGTH,
    ),
    supersedes_memory_id: memory.supersedes_memory_id === undefined
      || memory.supersedes_memory_id === null
      ? null
      : boundedText(
        memory.supersedes_memory_id,
        "memory.supersedes_memory_id",
        MAX_MEMORY_ID_LENGTH,
      ),
  };
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameMutableMemoryFields(left: MemoryCreate, right: MemoryCreate): boolean {
  return left.kind === right.kind
    && left.content === right.content
    && left.source === right.source
    && left.source_interaction_id === right.source_interaction_id
    && left.confidence === right.confidence
    && left.sensitivity === right.sensitivity
    && left.visibility_scope === right.visibility_scope
    && sameStringArray(left.visible_to_roles, right.visible_to_roles)
    && left.policy_revision === right.policy_revision
    && sameStringArray(left.tags, right.tags)
    && left.expires_at_ms === right.expires_at_ms
    && left.idempotency_key === right.idempotency_key
    && left.subject_key === right.subject_key
    && left.supersedes_memory_id === right.supersedes_memory_id;
}

function sameCanonicalCreate(left: MemoryRecord, right: ValidatedMemoryCreate): boolean {
  return left.schema_version === right.schema_version
    && left.memory_id === right.memory_id
    && left.owner_role === right.owner_role
    && left.created_at_ms === right.created_at_ms
    && left.kind === right.kind
    && left.content === right.content
    && left.source === right.source
    && left.source_interaction_id === right.source_interaction_id
    && left.confidence === right.confidence
    && left.sensitivity === right.sensitivity
    && left.visibility_scope === right.visibility_scope
    && sameStringArray(left.visible_to_roles, right.visible_to_roles)
    && left.policy_revision === right.policy_revision
    && sameStringArray(left.tags, right.tags)
    && left.expires_at_ms === right.expires_at_ms
    && left.idempotency_key === right.idempotency_key
    && left.subject_key === right.subject_key;
}

function pagination(
  limitValue: unknown,
  offsetValue: unknown,
): { readonly limit: number; readonly offset: number } {
  const limit = limitValue === undefined
    ? DEFAULT_MEMORY_PAGE_SIZE
    : positiveInteger(limitValue, "memory query limit");
  const offset = offsetValue === undefined
    ? 0
    : nonNegativeInteger(offsetValue, "memory query offset");
  if (limit > MAX_MEMORY_PAGE_SIZE) {
    throw new AuditStorageError(`memory query limit cannot exceed ${MAX_MEMORY_PAGE_SIZE}`);
  }
  if (offset > MAX_MEMORY_OFFSET) {
    throw new AuditStorageError(`memory query offset cannot exceed ${MAX_MEMORY_OFFSET}`);
  }
  return { limit, offset };
}

function memorySearchTerms(value: unknown): readonly string[] {
  const query = boundedText(value, "memory search query", MAX_MEMORY_SEARCH_LENGTH);
  const terms = query.split(/\s+/u);
  if (terms.length > MAX_MEMORY_SEARCH_TERMS) {
    throw new AuditStorageError(
      `memory search query cannot exceed ${MAX_MEMORY_SEARCH_TERMS} terms`,
    );
  }
  return terms;
}

function safeFtsQuery(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
}

function memoryFromRow(
  row: Record<string, unknown>,
  visibleToRoles: readonly MemoryOwnerRole[],
  tags: readonly string[],
): MemoryRecord {
  const schemaVersion = numberValue(row.schema_version, "memories.schema_version");
  if (schemaVersion !== MEMORY_SCHEMA_VERSION) {
    throw new AuditStorageError(`unsupported memory schema version ${schemaVersion}`);
  }
  const createdAtMs = numberValue(row.created_at_ms, "memories.created_at_ms");
  const updatedAtMs = numberValue(row.updated_at_ms, "memories.updated_at_ms");
  const value = validatedMemoryCreate({
    schema_version: MEMORY_SCHEMA_VERSION,
    memory_id: stringValue(row.memory_id, "memories.memory_id"),
    kind: enumValue(row.kind, MEMORY_KINDS, "memories.kind"),
    content: stringValue(row.content, "memories.content"),
    source: enumValue(row.source, MEMORY_SOURCES, "memories.source"),
    source_interaction_id: row.source_interaction_id === null
      ? null
      : stringValue(row.source_interaction_id, "memories.source_interaction_id"),
    confidence: memoryConfidence(row.confidence),
    sensitivity: enumValue(
      row.sensitivity,
      MEMORY_SENSITIVITIES,
      "memories.sensitivity",
    ),
    owner_role: memoryRole(row.owner_role, "memories.owner_role"),
    visibility_scope: enumValue(
      row.visibility_scope,
      MEMORY_VISIBILITY_SCOPES,
      "memories.visibility_scope",
    ),
    visible_to_roles: visibleToRoles,
    policy_revision: positiveInteger(row.policy_revision, "memories.policy_revision"),
    tags,
    created_at_ms: createdAtMs,
    expires_at_ms: nullableNumber(row.expires_at_ms, "memories.expires_at_ms"),
    idempotency_key: stringValue(row.idempotency_key, "memories.idempotency_key"),
    subject_key: stringValue(row.subject_key, "memories.subject_key"),
    supersedes_memory_id: row.supersedes_memory_id === null
      ? null
      : stringValue(row.supersedes_memory_id, "memories.supersedes_memory_id"),
  });
  if (updatedAtMs < createdAtMs) {
    throw new AuditStorageError("memories.updated_at_ms cannot precede created_at_ms");
  }
  return {
    ...value,
    revision: positiveInteger(row.revision, "memories.revision"),
    updated_at_ms: updatedAtMs,
  };
}

function allowedTools(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw new AuditStorageError(`${label} must be an array of unique non-empty strings`);
  }
  return value;
}

function messageFromRow(row: Record<string, unknown>): Message {
  const toolName = row.tool_name;
  if (toolName !== null && typeof toolName !== "string") {
    throw new AuditStorageError("messages.tool_name is invalid");
  }
  return {
    message_id: stringValue(row.message_id, "messages.message_id"),
    session_id: stringValue(row.session_id, "messages.session_id"),
    run_id: stringValue(row.run_id, "messages.run_id"),
    role: stringValue(row.role, "messages.role") as Message["role"],
    content: stringValue(row.content, "messages.content"),
    tool_name: toolName,
    created_at_ms: numberValue(row.created_at_ms, "messages.created_at_ms"),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, "messages.metadata_json"),
  };
}

function actionFromRow(row: Record<string, unknown>): Action {
  return {
    action_id: stringValue(row.action_id, "actions.action_id"),
    run_id: stringValue(row.run_id, "actions.run_id"),
    tool_call_id: stringValue(row.tool_call_id, "actions.tool_call_id"),
    status: stringValue(row.status, "actions.status") as Action["status"],
    created_at_ms: numberValue(row.created_at_ms, "actions.created_at_ms"),
  };
}

function eventFromRow(row: Record<string, unknown>): Event {
  return {
    event_id: stringValue(row.event_id, "events.event_id"),
    run_id: stringValue(row.run_id, "events.run_id"),
    type: stringValue(row.type, "events.type"),
    occurred_at_ms: numberValue(row.occurred_at_ms, "events.occurred_at_ms"),
    payload: parseJson<Record<string, unknown>>(row.payload_json, "events.payload_json"),
  };
}

function toolCallFromRow(row: Record<string, unknown>): StoredToolCall {
  const result = row.result_json === null
    ? null
    : parseJson<Record<string, unknown>>(row.result_json, "tool_calls.result_json");
  const error = row.error_json === null
    ? null
    : parseJson<ToolError>(row.error_json, "tool_calls.error_json");
  return {
    tool_call_id: stringValue(row.tool_call_id, "tool_calls.tool_call_id"),
    run_id: stringValue(row.run_id, "tool_calls.run_id"),
    name: stringValue(row.name, "tool_calls.name"),
    arguments: parseJson<Record<string, unknown>>(
      row.arguments_json,
      "tool_calls.arguments_json",
    ),
    status: stringValue(row.status, "tool_calls.status") as StoredToolCall["status"],
    created_at_ms: numberValue(row.created_at_ms, "tool_calls.created_at_ms"),
    completed_at_ms: nullableNumber(row.completed_at_ms, "tool_calls.completed_at_ms"),
    result,
    error,
  };
}

export class SynchronousSqliteAuditStore implements AuditStore, MemoryStore, Disposable {
  readonly #database: DatabaseSync;
  #closed = false;

  public constructor(path: string, options: SqliteAuditStoreOptions = {}) {
    const timeoutMs = options.timeout_ms ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
      throw new RangeError("timeout_ms must be an integer between 0 and 120000");
    }
    this.#database = new DatabaseSync(path, {
      timeout: timeoutMs,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });
    try {
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      this.#migrate();
      if (options.reconcile_on_open !== false) {
        this.reconcileInterruptedRuns(Date.now());
      }
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  public async saveAgentProfile(profile: AgentProfile): Promise<void> {
    this.#assertOpen();
    const profileAllowedTools = allowedTools(profile.allowed_tools, "allowed_tools");
    this.#database.prepare(`
      INSERT INTO agent_profiles (agent_profile_id, name, locale, allowed_tools_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_profile_id) DO UPDATE SET
        name = excluded.name,
        locale = excluded.locale,
        allowed_tools_json = excluded.allowed_tools_json
    `).run(
      profile.agent_profile_id,
      profile.name,
      profile.locale,
      json(profileAllowedTools, "allowed_tools"),
    );
  }

  public async saveSession(session: Session): Promise<void> {
    this.#assertOpen();
    const write = this.#database.prepare(`
      INSERT INTO sessions (
        session_id, agent_profile_id, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms
      WHERE sessions.agent_profile_id = excluded.agent_profile_id
        AND sessions.created_at_ms = excluded.created_at_ms
        AND excluded.updated_at_ms >= sessions.updated_at_ms
    `).run(
      session.session_id,
      session.agent_profile_id,
      session.created_at_ms,
      session.updated_at_ms,
    );
    if (Number(write.changes) !== 1) {
      throw new AuditStorageError(`session ${session.session_id} conflicts with stored identity or time`);
    }
  }

  public async saveRun(run: Run): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeRun(run));
  }

  public async saveMessage(message: Message): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeMessage(message));
  }

  public async saveToolCall(runId: string, call: ToolCall, createdAtMs: number): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeToolCall(runId, call, createdAtMs));
  }

  public async saveAction(action: Action): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeAction(action));
  }

  public async saveToolResult(
    runId: string,
    result: ToolResult,
    completedAtMs: number,
  ): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeToolResult(runId, result, completedAtMs));
  }

  public async appendEvent(event: Event): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => this.#writeEvent(event));
  }

  public async writeBatch(batch: AuditWriteBatch): Promise<void> {
    this.#assertOpen();
    this.#transaction(() => {
      const terminalRun = batch.run !== undefined
        && !["pending", "running"].includes(batch.run.status);
      const createsTerminalRun = terminalRun
        && this.#database.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(batch.run?.run_id) === undefined;
      if (createsTerminalRun && batch.run !== undefined) {
        this.#writeRun({
          ...batch.run,
          status: "running",
          completed_at_ms: null,
        });
      }
      if (batch.run !== undefined && !terminalRun) {
        this.#writeRun(batch.run);
      }
      for (const message of batch.messages ?? []) {
        this.#writeMessage(message);
      }
      for (const write of batch.tool_calls ?? []) {
        this.#writeToolCall(write.run_id, write.call, write.created_at_ms);
      }
      for (const write of batch.tool_results ?? []) {
        this.#writeToolResult(write.run_id, write.result, write.completed_at_ms);
      }
      for (const action of batch.actions ?? []) {
        this.#writeAction(action);
      }
      for (const event of batch.events ?? []) {
        this.#writeEvent(event);
      }
      if (batch.run !== undefined && terminalRun) {
        this.#writeRun(batch.run);
      }
    });
  }

  public async getSessionAgentProfile(sessionId: string): Promise<AgentProfile | null> {
    this.#assertOpen();
    const row = this.#database.prepare(`
      SELECT p.agent_profile_id, p.name, p.locale, p.allowed_tools_json
      FROM sessions AS s
      JOIN agent_profiles AS p ON p.agent_profile_id = s.agent_profile_id
      WHERE s.session_id = ?
    `).get(sessionId);
    if (row === undefined) {
      return null;
    }
    return {
      agent_profile_id: stringValue(row.agent_profile_id, "agent_profiles.agent_profile_id"),
      name: stringValue(row.name, "agent_profiles.name"),
      locale: stringValue(row.locale, "agent_profiles.locale") as AgentProfile["locale"],
      allowed_tools: allowedTools(
        parseJson<unknown>(row.allowed_tools_json, "agent_profiles.allowed_tools_json"),
        "agent_profiles.allowed_tools_json",
      ),
    };
  }

  public async getRunTrace(runId: string): Promise<RunAuditTrace | null> {
    this.#assertOpen();
    return this.#readTransaction(() => {
      const runRow = this.#database.prepare(`
        SELECT run_id, session_id, status, started_at_ms, completed_at_ms
        FROM runs WHERE run_id = ?
      `).get(runId);
      if (runRow === undefined) {
        return null;
      }
      const run: Run = {
        run_id: stringValue(runRow.run_id, "runs.run_id"),
        session_id: stringValue(runRow.session_id, "runs.session_id"),
        status: stringValue(runRow.status, "runs.status") as Run["status"],
        started_at_ms: numberValue(runRow.started_at_ms, "runs.started_at_ms"),
        completed_at_ms: nullableNumber(runRow.completed_at_ms, "runs.completed_at_ms"),
      };
      return {
        run,
        messages: this.#database.prepare(`
          SELECT * FROM messages WHERE run_id = ? ORDER BY created_at_ms, message_id
        `).all(runId).map(messageFromRow),
        tool_calls: this.#database.prepare(`
          SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at_ms, tool_call_id
        `).all(runId).map(toolCallFromRow),
        actions: this.#database.prepare(`
          SELECT * FROM actions WHERE run_id = ? ORDER BY created_at_ms, action_id
        `).all(runId).map(actionFromRow),
        events: this.#database.prepare(`
          SELECT * FROM events WHERE run_id = ? ORDER BY occurred_at_ms, event_id
        `).all(runId).map(eventFromRow),
      };
    });
  }

  public async listSessionMessages(sessionId: string): Promise<readonly Message[]> {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY created_at_ms, message_id
    `).all(sessionId).map(messageFromRow);
  }

  public async listRunIdsForInteraction(interactionId: string): Promise<readonly string[]> {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT run_id, MIN(occurred_at_ms) AS first_started_at_ms
      FROM events
      WHERE type = 'role.run.started'
        AND json_extract(payload_json, '$.interaction_id') = ?
      GROUP BY run_id
      ORDER BY first_started_at_ms, run_id
    `).all(interactionId).map((row) => stringValue(row.run_id, "events.run_id"));
  }

  public async createMemory(memory: MemoryCreate): Promise<MemoryRecord> {
    this.#assertOpen();
    const value = validatedMemoryCreate(memory);
    return this.#transactionWithResult(() => {
      this.#insertMemory(value);
      return this.#readMemoryById(value.memory_id);
    });
  }

  public async createCanonicalMemory(memory: CanonicalMemoryCreate): Promise<MemoryRecord> {
    this.#assertOpen();
    if (memory.idempotency_key === undefined || memory.subject_key === undefined) {
      throw new AuditStorageError(
        "canonical memory requires idempotency_key and subject_key",
      );
    }
    const value = validatedMemoryCreate(memory);
    return this.#transactionWithResult(() => {
      const retry = this.#database.prepare(`
        SELECT * FROM memories WHERE idempotency_key = ?
      `).get(value.idempotency_key);
      if (retry !== undefined) {
        const existing = this.#memoryFromRow(retry);
        if (!sameCanonicalCreate(existing, value)) {
          throw new AuditStorageError(
            `memory idempotency key ${value.idempotency_key} conflicts with stored payload`,
          );
        }
        return existing;
      }
      if (this.#database.prepare(`
        SELECT 1 FROM memories WHERE memory_id = ?
      `).get(value.memory_id) !== undefined) {
        throw new AuditStorageError(
          `memory_id ${value.memory_id} conflicts with a different canonical write`,
        );
      }
      const canonicalRow = this.#database.prepare(`
        SELECT candidate.*
        FROM memories AS candidate
        WHERE candidate.owner_role = ?
          AND candidate.kind = ?
          AND candidate.subject_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM memories AS child
            WHERE child.supersedes_memory_id = candidate.memory_id
          )
        ORDER BY candidate.created_at_ms DESC, candidate.memory_id DESC
        LIMIT 1
      `).get(value.owner_role, value.kind, value.subject_key);
      let supersedesMemoryId: string | null = null;
      if (canonicalRow !== undefined) {
        const existing = this.#memoryFromRow(canonicalRow);
        if (value.created_at_ms <= existing.created_at_ms) {
          throw new AuditStorageError(
            `canonical memory ${value.memory_id} is stale for subject ${value.subject_key}`,
          );
        }
        supersedesMemoryId = existing.memory_id;
      }
      this.#insertMemory({ ...value, supersedes_memory_id: supersedesMemoryId });
      return this.#readMemoryById(value.memory_id);
    });
  }

  public async getMemory(
    memoryId: string,
    requesterRole: MemoryOwnerRole,
    nowMs = Date.now(),
  ): Promise<MemoryRecord | null> {
    this.#assertOpen();
    const id = boundedText(memoryId, "memoryId", MAX_MEMORY_ID_LENGTH);
    const role = memoryRole(requesterRole, "requesterRole");
    const now = nonNegativeInteger(nowMs, "nowMs");
    return this.#readTransaction(() => {
      const row = this.#database.prepare(`
        SELECT *
        FROM memories
        WHERE memory_id = ?
          AND owner_role = ?
          AND (expires_at_ms IS NULL OR expires_at_ms > ?)
      `).get(id, role, now);
      return row === undefined ? null : this.#memoryFromRow(row);
    });
  }

  public async updateMemory(update: MemoryUpdate): Promise<MemoryRecord> {
    this.#assertOpen();
    const memoryId = boundedText(update.memory_id, "memory.memory_id", MAX_MEMORY_ID_LENGTH);
    const requesterRole = memoryRole(update.requester_role, "memory.requester_role");
    const expectedRevision = positiveInteger(
      update.expected_revision,
      "memory.expected_revision",
    );
    const updatedAtMs = nonNegativeInteger(update.updated_at_ms, "memory.updated_at_ms");
    const hasChange = [
      update.kind,
      update.content,
      update.source,
      update.source_interaction_id,
      update.confidence,
      update.sensitivity,
      update.visibility_scope,
      update.visible_to_roles,
      update.policy_revision,
      update.tags,
      update.expires_at_ms,
    ].some((value) => value !== undefined);
    if (!hasChange) {
      throw new AuditStorageError("memory update must change at least one field");
    }

    return this.#transactionWithResult(() => {
      const row = this.#database.prepare(`
        SELECT *
        FROM memories
        WHERE memory_id = ?
          AND owner_role = ?
          AND (expires_at_ms IS NULL OR expires_at_ms > ?)
      `).get(memoryId, requesterRole, updatedAtMs);
      if (row === undefined) {
        throw new AuditStorageError(`memory ${memoryId} is not visible to requester`);
      }
      const existing = this.#memoryFromRow(row);
      if (!existing.idempotency_key.startsWith("legacy:")) {
        throw new AuditStorageError(
          `canonical memory ${memoryId} is immutable; create a superseding record`,
        );
      }
      if (existing.revision !== expectedRevision) {
        throw new AuditStorageError(
          `memory ${memoryId} has revision ${existing.revision}, expected ${expectedRevision}`,
        );
      }
      if (updatedAtMs < existing.updated_at_ms) {
        throw new AuditStorageError("memory.updated_at_ms cannot move backwards");
      }
      const value = validatedMemoryCreate({
        schema_version: MEMORY_SCHEMA_VERSION,
        memory_id: existing.memory_id,
        kind: update.kind === undefined ? existing.kind : update.kind,
        content: update.content === undefined ? existing.content : update.content,
        source: update.source === undefined ? existing.source : update.source,
        source_interaction_id: update.source_interaction_id === undefined
          ? existing.source_interaction_id
          : update.source_interaction_id,
        confidence: update.confidence === undefined ? existing.confidence : update.confidence,
        sensitivity: update.sensitivity === undefined
          ? existing.sensitivity
          : update.sensitivity,
        owner_role: existing.owner_role,
        visibility_scope: update.visibility_scope === undefined
          ? existing.visibility_scope
          : update.visibility_scope,
        visible_to_roles: update.visible_to_roles === undefined
          ? existing.visible_to_roles
          : update.visible_to_roles,
        policy_revision: update.policy_revision === undefined
          ? existing.policy_revision
          : update.policy_revision,
        tags: update.tags === undefined ? existing.tags : update.tags,
        created_at_ms: existing.created_at_ms,
        expires_at_ms: update.expires_at_ms === undefined
          ? existing.expires_at_ms
          : update.expires_at_ms,
        idempotency_key: existing.idempotency_key,
        subject_key: existing.subject_key,
        supersedes_memory_id: existing.supersedes_memory_id,
      });
      if (value.policy_revision < existing.policy_revision) {
        throw new AuditStorageError("memory.policy_revision cannot move backwards");
      }
      if (sameMutableMemoryFields(existing, value)) {
        throw new AuditStorageError("memory update must change at least one field");
      }
      if (
        existing.visible_to_roles.length > 0
        && (
          value.visibility_scope !== existing.visibility_scope
          || value.sensitivity !== existing.sensitivity
        )
      ) {
        // Remove the old ACL before tightening the parent row. The transaction
        // restores it if the subsequent optimistic update fails.
        this.#replaceMemoryRoles(memoryId, []);
      }
      const write = this.#database.prepare(`
        UPDATE memories SET
          revision = revision + 1,
          kind = ?,
          content = ?,
          source = ?,
          source_interaction_id = ?,
          confidence = ?,
          sensitivity = ?,
          visibility_scope = ?,
          policy_revision = ?,
          updated_at_ms = ?,
          expires_at_ms = ?
        WHERE memory_id = ? AND owner_role = ? AND revision = ?
      `).run(
        value.kind,
        value.content,
        value.source,
        value.source_interaction_id,
        value.confidence,
        value.sensitivity,
        value.visibility_scope,
        value.policy_revision,
        updatedAtMs,
        value.expires_at_ms,
        memoryId,
        requesterRole,
        expectedRevision,
      );
      if (Number(write.changes) !== 1) {
        throw new AuditStorageError(`memory ${memoryId} revision changed concurrently`);
      }
      this.#replaceMemoryRoles(memoryId, value.visible_to_roles);
      this.#replaceMemoryTags(memoryId, value.tags);
      return this.#readMemoryById(memoryId);
    });
  }

  public async listMemories(query: MemoryList): Promise<MemoryListPage> {
    this.#assertOpen();
    const { limit, offset } = pagination(query.limit, query.offset);
    return this.#readTransaction(() => {
      const parameters: Array<string | number | null> = [];
      const where = this.#memoryFilter(query, parameters);
      const rows = this.#database.prepare(`
        SELECT m.*
        FROM memories AS m
        WHERE ${where}
        ORDER BY m.updated_at_ms DESC, m.memory_id ASC
        LIMIT ? OFFSET ?
      `).all(...parameters, limit + 1, offset);
      return this.#memoryPage(rows, limit, offset);
    });
  }

  public async searchMemories(query: MemorySearch): Promise<MemoryListPage> {
    this.#assertOpen();
    const { limit, offset } = pagination(query.limit, query.offset);
    const terms = memorySearchTerms(query.query);
    return this.#readTransaction(() => {
      if (terms.some((term) => Array.from(term).length < 3)) {
        const parameters: Array<string | number | null> = [...terms];
        const where = this.#memoryFilter(query, parameters);
        const contentFilter = terms.map(() => "instr(m.content, ?) > 0").join(" AND ");
        const rows = this.#database.prepare(`
          SELECT m.*
          FROM memories AS m
          WHERE ${contentFilter} AND ${where}
          ORDER BY m.updated_at_ms DESC, m.memory_id ASC
          LIMIT ? OFFSET ?
        `).all(...parameters, limit + 1, offset);
        return this.#memoryPage(rows, limit, offset);
      }
      const match = safeFtsQuery(terms);
      const parameters: Array<string | number | null> = [match];
      const where = this.#memoryFilter(query, parameters);
      const rows = this.#database.prepare(`
        SELECT m.*
        FROM memories_fts
        JOIN memories AS m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ? AND ${where}
        ORDER BY bm25(memories_fts), m.updated_at_ms DESC, m.memory_id ASC
        LIMIT ? OFFSET ?
      `).all(...parameters, limit + 1, offset);
      return this.#memoryPage(rows, limit, offset);
    });
  }

  public async recallMemories(query: MemoryRecall): Promise<MemoryRecallResult> {
    this.#assertOpen();
    const { limit } = pagination(query.limit, 0);
    const strategy = enumValue(
      query.strategy,
      MEMORY_PROJECTION_STRATEGIES,
      "memory recall strategy",
    );
    const approvedPolicyRevision = positiveInteger(
      query.approved_policy_revision,
      "memory recall approved_policy_revision",
    );
    const requesterRole = memoryRole(
      query.requester_role,
      "memory recall requester_role",
    );
    const nowMs = query.now_ms === undefined
      ? Date.now()
      : nonNegativeInteger(query.now_ms, "memory recall now_ms");
    const terms = query.query === undefined
      ? null
      : memorySearchTerms(query.query);
    return this.#readTransaction(() => {
      const parameters: Array<string | number | null> = [];
      const relevance = terms === null
        ? "0.0"
        : terms.some((term) => Array.from(term).length < 3)
          ? "1.0"
          : "-bm25(memories_fts)";
      const from = terms === null || terms.some((term) => Array.from(term).length < 3)
        ? "memories AS m"
        : "memories_fts JOIN memories AS m ON m.rowid = memories_fts.rowid";
      const parts: string[] = [];
      if (terms !== null) {
        if (terms.some((term) => Array.from(term).length < 3)) {
          parts.push(terms.map(() => "instr(m.content, ?) > 0").join(" AND "));
          parameters.push(...terms);
        } else {
          parts.push("memories_fts MATCH ?");
          parameters.push(safeFtsQuery(terms));
        }
      }
      parts.push(`
        (
          m.owner_role = ?
          OR (
            ? != 'private'
            AND m.owner_role != ?
            AND m.sensitivity != 'restricted'
            AND m.visibility_scope = 'explicit_roles'
            AND m.policy_revision = ?
            AND (? = 'shared_acl' OR m.kind = 'user_fact')
            AND EXISTS (
              SELECT 1
              FROM memory_visible_roles AS recall_acl
              WHERE recall_acl.memory_id = m.memory_id
                AND recall_acl.visible_role = ?
            )
          )
        )
      `);
      parameters.push(
        requesterRole,
        strategy,
        requesterRole,
        approvedPolicyRevision,
        strategy,
        requesterRole,
      );
      parts.push("(m.expires_at_ms IS NULL OR m.expires_at_ms > ?)");
      parameters.push(nowMs);
      this.#appendMemoryKindAndTagFilters(query, parts, parameters);
      const rows = this.#database.prepare(`
        SELECT m.*, ${relevance} AS recall_relevance
        FROM ${from}
        WHERE ${parts.join(" AND ")}
        ORDER BY recall_relevance DESC, m.confidence DESC,
          m.updated_at_ms DESC, m.memory_id ASC
        LIMIT ?
      `).all(...parameters, limit);
      return {
        items: rows.map((row): MemoryRecallItem => ({
          ...this.#memoryFromRow(row),
          recall_relevance: finiteNumber(
            row.recall_relevance,
            "memory recall relevance",
          ),
        })),
      };
    });
  }

  public async deleteMemory(
    memoryId: string,
    requesterRole: MemoryOwnerRole,
  ): Promise<boolean> {
    this.#assertOpen();
    const id = boundedText(memoryId, "memoryId", MAX_MEMORY_ID_LENGTH);
    const role = memoryRole(requesterRole, "requesterRole");
    const write = this.#database.prepare(`
      DELETE FROM memories
      WHERE memory_id = ? AND owner_role = ?
    `).run(id, role);
    return Number(write.changes) === 1;
  }

  public async deleteMemoryCascade(
    request: MemoryDeletionRequest,
  ): Promise<MemoryDeletionResult> {
    this.#assertOpen();
    const requestId = boundedText(
      request.request_id,
      "memory deletion request_id",
      MAX_DELETION_REQUEST_ID_LENGTH,
    );
    const memoryId = boundedText(
      request.memory_id,
      "memory deletion memory_id",
      MAX_MEMORY_ID_LENGTH,
    );
    const requesterRole = memoryRole(
      request.requester_role,
      "memory deletion requester_role",
    );
    const reason = enumValue(
      request.reason,
      MEMORY_DELETION_REASONS,
      "memory deletion reason",
    );
    const requestedAtMs = nonNegativeInteger(
      request.requested_at_ms,
      "memory deletion requested_at_ms",
    );
    return this.#transactionWithResult(() => {
      const prior = this.#readDeletionResult(requestId);
      if (prior !== null) {
        if (
          prior.requester_role !== requesterRole
          || prior.reason !== reason
          || prior.requested_at_ms !== requestedAtMs
          || this.#database.prepare(`
            SELECT target_memory_id FROM memory_deletion_requests WHERE request_id = ?
          `).get(requestId)?.target_memory_id !== memoryId
        ) {
          throw new AuditStorageError(
            `memory deletion request ${requestId} conflicts with stored request`,
          );
        }
        return prior;
      }
      const target = this.#database.prepare(`
        SELECT owner_role FROM memories WHERE memory_id = ?
      `).get(memoryId);
      if (
        target === undefined
        || memoryRole(target.owner_role, "memories.owner_role") !== requesterRole
      ) {
        throw new AuditStorageError("memory deletion target is not owned by requester");
      }
      const rows = this.#database.prepare(`
        WITH RECURSIVE descendants(memory_id, idempotency_key, depth) AS (
          SELECT memory_id, idempotency_key, 0 FROM memories WHERE memory_id = ?
          UNION ALL
          SELECT child.memory_id, child.idempotency_key, parent.depth + 1
          FROM memories AS child
          JOIN descendants AS parent
            ON child.supersedes_memory_id = parent.memory_id
          WHERE parent.depth <= ?
        )
        SELECT memory_id, idempotency_key, depth
        FROM descendants
        ORDER BY memory_id
        LIMIT ?
      `).all(memoryId, MAX_LINEAGE_DEPTH, MAX_DELETION_DESCENDANTS + 1);
      const memoryIds = rows.map((row) =>
        stringValue(row.memory_id, "memory deletion memory_id"));
      if (memoryIds.length === 0 || memoryIds.length > MAX_DELETION_DESCENDANTS) {
        throw new AuditStorageError("memory deletion descendant set is invalid or too large");
      }
      if (rows.some((row) =>
        numberValue(row.depth, "memory deletion depth") > MAX_LINEAGE_DEPTH)) {
        throw new AuditStorageError("memory deletion lineage is too deep");
      }
      this.#database.prepare(`
        INSERT INTO memory_deletion_requests (
          request_id, target_memory_id, requester_role, reason, requested_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(requestId, memoryId, requesterRole, reason, requestedAtMs);
      const insertItem = this.#database.prepare(`
        INSERT INTO memory_deletion_items (request_id, memory_id, idempotency_key)
        VALUES (?, ?, ?)
      `);
      for (const row of rows) {
        insertItem.run(
          requestId,
          stringValue(row.memory_id, "memory deletion memory_id"),
          stringValue(row.idempotency_key, "memory deletion idempotency_key"),
        );
      }
      const placeholders = memoryIds.map(() => "?").join(", ");
      const write = this.#database.prepare(`
        DELETE FROM memories
        WHERE owner_role = ? AND memory_id IN (${placeholders})
      `).run(requesterRole, ...memoryIds);
      if (Number(write.changes) !== memoryIds.length) {
        throw new AuditStorageError("memory deletion ownership changed during transaction");
      }
      return {
        request_id: requestId,
        requester_role: requesterRole,
        reason,
        requested_at_ms: requestedAtMs,
        memory_ids: memoryIds,
        deleted_count: memoryIds.length,
      };
    });
  }

  public async getMemoryDeletionAudit(
    requestId: string,
    requesterRole: MemoryOwnerRole,
  ): Promise<MemoryDeletionResult | null> {
    this.#assertOpen();
    const id = boundedText(
      requestId,
      "memory deletion request_id",
      MAX_DELETION_REQUEST_ID_LENGTH,
    );
    const role = memoryRole(requesterRole, "memory deletion requester_role");
    const result = this.#readTransaction(() => this.#readDeletionResult(id));
    return result?.requester_role === role ? result : null;
  }

  public async purgeExpiredMemories(
    nowMs = Date.now(),
    limit = MAX_MEMORY_PURGE_SIZE,
  ): Promise<number> {
    this.#assertOpen();
    const now = nonNegativeInteger(nowMs, "nowMs");
    const boundedLimit = positiveInteger(limit, "limit");
    if (boundedLimit > MAX_MEMORY_PURGE_SIZE) {
      throw new AuditStorageError(`limit cannot exceed ${MAX_MEMORY_PURGE_SIZE}`);
    }
    const write = this.#database.prepare(`
      DELETE FROM memories
      WHERE rowid IN (
        SELECT rowid
        FROM memories
        WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?
        ORDER BY expires_at_ms, memory_id
        LIMIT ?
      )
    `).run(now, boundedLimit);
    return Number(write.changes);
  }

  public reconcileInterruptedRuns(recoveredAtMs: number): AuditRecoveryReport {
    this.#assertOpen();
    if (!Number.isSafeInteger(recoveredAtMs) || recoveredAtMs < 0) {
      throw new RangeError("recoveredAtMs must be a non-negative safe integer");
    }
    return this.#transactionWithResult(() => {
      const rows = this.#database.prepare(`
        SELECT run_id, started_at_ms
        FROM runs
        WHERE status IN ('pending', 'running')
        ORDER BY started_at_ms, run_id
      `).all();
      const runIds: string[] = [];
      let recoveredToolCalls = 0;
      let recoveredActions = 0;

      for (const row of rows) {
        const runId = stringValue(row.run_id, "runs.run_id");
        const startedAtMs = numberValue(row.started_at_ms, "runs.started_at_ms");
        const maxTimeRow = this.#database.prepare(`
          SELECT MAX(value) AS max_time FROM (
            SELECT ? AS value
            UNION ALL SELECT created_at_ms FROM tool_calls WHERE run_id = ?
            UNION ALL SELECT created_at_ms FROM actions WHERE run_id = ?
            UNION ALL SELECT occurred_at_ms FROM events WHERE run_id = ?
          )
        `).get(startedAtMs, runId, runId, runId);
        const completedAtMs = Math.max(
          recoveredAtMs,
          numberValue(maxTimeRow?.max_time, "recovery.max_time"),
        );
        const toolError = json({
          code: "INTERNAL",
          message: "tool outcome is unknown after Runtime restart",
          retryable: false,
          details: {
            outcome: "unknown",
            recovery: "process_restart",
            replay_allowed: false,
          },
        }, "recovery.tool_error");
        const toolWrite = this.#database.prepare(`
          UPDATE tool_calls SET
            status = 'error',
            completed_at_ms = MAX(created_at_ms, ?),
            result_json = NULL,
            error_json = ?
          WHERE run_id = ? AND status = 'pending'
        `).run(completedAtMs, toolError, runId);
        const actionWrite = this.#database.prepare(`
          UPDATE actions SET status = 'failed'
          WHERE run_id = ? AND status NOT IN ('completed', 'failed')
        `).run(runId);
        this.#database.prepare(`
          INSERT INTO events (event_id, run_id, type, occurred_at_ms, payload_json)
          VALUES (?, ?, 'run.recovered', ?, ?)
        `).run(
          `recovery:${randomUUID()}`,
          runId,
          completedAtMs,
          json({
            status: "failed",
            previous_outcome: "unknown",
            reason: "process_restart",
            replay_allowed: false,
            recovered_tool_calls: Number(toolWrite.changes),
            recovered_actions: Number(actionWrite.changes),
          }, "recovery.event"),
        );
        this.#database.prepare(`
          UPDATE runs SET status = 'failed', completed_at_ms = ?
          WHERE run_id = ? AND status IN ('pending', 'running')
        `).run(completedAtMs, runId);
        runIds.push(runId);
        recoveredToolCalls += Number(toolWrite.changes);
        recoveredActions += Number(actionWrite.changes);
      }

      return {
        run_ids: runIds,
        recovered_tool_calls: recoveredToolCalls,
        recovered_actions: recoveredActions,
      };
    });
  }

  public close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  #memoryFilter(
    query: MemoryList,
    parameters: Array<string | number | null>,
  ): string {
    const requesterRole = memoryRole(query.requester_role, "memory query requester_role");
    const nowMs = query.now_ms === undefined
      ? Date.now()
      : nonNegativeInteger(query.now_ms, "memory query now_ms");
    const parts = [
      "m.owner_role = ?",
      "(m.expires_at_ms IS NULL OR m.expires_at_ms > ?)",
    ];
    parameters.push(requesterRole, nowMs);

    this.#appendMemoryKindAndTagFilters(query, parts, parameters);
    return parts.join(" AND ");
  }

  #appendMemoryKindAndTagFilters(
    query: Pick<MemoryList, "kinds" | "tags">,
    parts: string[],
    parameters: Array<string | number | null>,
  ): void {
    if (query.kinds !== undefined) {
      const kinds = memoryKinds(query.kinds, "memory query kinds");
      if (kinds.length === 0) {
        throw new AuditStorageError("memory query kinds must not be empty");
      }
      parts.push(`m.kind IN (${kinds.map(() => "?").join(", ")})`);
      parameters.push(...kinds);
    }
    if (query.tags !== undefined) {
      const tags = memoryTags(query.tags, "memory query tags");
      if (tags.length === 0) {
        throw new AuditStorageError("memory query tags must not be empty");
      }
      for (const tag of tags) {
        parts.push(`
          EXISTS (
            SELECT 1 FROM memory_tags AS filter_tags
            WHERE filter_tags.memory_id = m.memory_id
              AND filter_tags.tag = ?
          )
        `);
        parameters.push(tag);
      }
    }
  }

  #memoryPage(
    rows: readonly Record<string, unknown>[],
    limit: number,
    offset: number,
  ): MemoryListPage {
    const pageRows = rows.slice(0, limit);
    const candidateNextOffset = offset + limit;
    return {
      items: pageRows.map((row) => this.#memoryFromRow(row)),
      next_offset: rows.length > limit && candidateNextOffset <= MAX_MEMORY_OFFSET
        ? candidateNextOffset
        : null,
    };
  }

  #memoryFromRow(row: Record<string, unknown>): MemoryRecord {
    const memoryId = stringValue(row.memory_id, "memories.memory_id");
    const roles = this.#database.prepare(`
      SELECT visible_role
      FROM memory_visible_roles
      WHERE memory_id = ?
      ORDER BY visible_role
    `).all(memoryId).map((roleRow) =>
      memoryRole(roleRow.visible_role, "memory_visible_roles.visible_role"));
    const tags = this.#database.prepare(`
      SELECT tag
      FROM memory_tags
      WHERE memory_id = ?
      ORDER BY tag
    `).all(memoryId).map((tagRow) =>
      stringValue(tagRow.tag, "memory_tags.tag"));
    return memoryFromRow(
      row,
      memoryRoles(roles, "memory_visible_roles"),
      memoryTags(tags, "memory_tags"),
    );
  }

  #readMemoryById(memoryId: string): MemoryRecord {
    const row = this.#database.prepare(`
      SELECT * FROM memories WHERE memory_id = ?
    `).get(memoryId);
    if (row === undefined) {
      throw new AuditStorageError(`memory ${memoryId} disappeared during write`);
    }
    return this.#memoryFromRow(row);
  }

  #insertMemory(value: ValidatedMemoryCreate): void {
    this.#database.prepare(`
      INSERT INTO memories (
        schema_version, memory_id, revision, kind, content, source,
        source_interaction_id, confidence, sensitivity, owner_role,
        visibility_scope, policy_revision, created_at_ms, updated_at_ms,
        expires_at_ms, idempotency_key, subject_key, supersedes_memory_id
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.schema_version,
      value.memory_id,
      value.kind,
      value.content,
      value.source,
      value.source_interaction_id,
      value.confidence,
      value.sensitivity,
      value.owner_role,
      value.visibility_scope,
      value.policy_revision,
      value.created_at_ms,
      value.created_at_ms,
      value.expires_at_ms,
      value.idempotency_key,
      value.subject_key,
      value.supersedes_memory_id,
    );
    this.#replaceMemoryRoles(value.memory_id, value.visible_to_roles);
    this.#replaceMemoryTags(value.memory_id, value.tags);
  }

  #readDeletionResult(requestId: string): MemoryDeletionResult | null {
    const row = this.#database.prepare(`
      SELECT request_id, requester_role, reason, requested_at_ms
      FROM memory_deletion_requests WHERE request_id = ?
    `).get(requestId);
    if (row === undefined) {
      return null;
    }
    const memoryIds = this.#database.prepare(`
      SELECT memory_id FROM memory_deletion_items
      WHERE request_id = ? ORDER BY memory_id
    `).all(requestId).map((item) =>
      stringValue(item.memory_id, "memory_deletion_items.memory_id"));
    return {
      request_id: stringValue(row.request_id, "memory_deletion_requests.request_id"),
      requester_role: memoryRole(
        row.requester_role,
        "memory_deletion_requests.requester_role",
      ),
      reason: enumValue(
        row.reason,
        MEMORY_DELETION_REASONS,
        "memory_deletion_requests.reason",
      ),
      requested_at_ms: numberValue(
        row.requested_at_ms,
        "memory_deletion_requests.requested_at_ms",
      ),
      memory_ids: memoryIds,
      deleted_count: memoryIds.length,
    };
  }

  #replaceMemoryRoles(
    memoryId: string,
    roles: readonly MemoryOwnerRole[],
  ): void {
    this.#database.prepare(`
      DELETE FROM memory_visible_roles WHERE memory_id = ?
    `).run(memoryId);
    const insert = this.#database.prepare(`
      INSERT INTO memory_visible_roles (memory_id, visible_role)
      VALUES (?, ?)
    `);
    for (const role of roles) {
      insert.run(memoryId, role);
    }
  }

  #replaceMemoryTags(memoryId: string, tags: readonly string[]): void {
    this.#database.prepare(`
      DELETE FROM memory_tags WHERE memory_id = ?
    `).run(memoryId);
    const insert = this.#database.prepare(`
      INSERT INTO memory_tags (memory_id, tag)
      VALUES (?, ?)
    `);
    for (const tag of tags) {
      insert.run(memoryId, tag);
    }
  }

  #writeRun(run: Run): void {
    const write = this.#database.prepare(`
      INSERT INTO runs (
        run_id, session_id, status, started_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        completed_at_ms = excluded.completed_at_ms
      WHERE runs.session_id = excluded.session_id
        AND runs.started_at_ms = excluded.started_at_ms
        AND (
          (runs.status = 'pending') OR
          (runs.status = 'running' AND excluded.status != 'pending') OR
          (
            runs.status IN ('completed', 'failed', 'cancelled', 'timed_out')
            AND excluded.status = runs.status
            AND excluded.completed_at_ms IS runs.completed_at_ms
          )
        )
    `).run(
      run.run_id,
      run.session_id,
      run.status,
      run.started_at_ms,
      run.completed_at_ms,
    );
    if (Number(write.changes) !== 1) {
      throw new AuditStorageError(`run ${run.run_id} conflicts with stored identity or lifecycle`);
    }
    if (!["pending", "running"].includes(run.status)) {
      const unfinished = this.#database.prepare(`
        SELECT
          EXISTS(
            SELECT 1 FROM tool_calls
            WHERE run_id = ? AND status = 'pending'
          ) AS pending_tool_calls,
          EXISTS(
            SELECT 1 FROM actions
            WHERE run_id = ? AND status NOT IN ('completed', 'failed')
          ) AS pending_actions
      `).get(run.run_id, run.run_id);
      if (
        numberValue(unfinished?.pending_tool_calls, "pending_tool_calls") !== 0
        || numberValue(unfinished?.pending_actions, "pending_actions") !== 0
      ) {
        throw new AuditStorageError(`run ${run.run_id} cannot terminate with unfinished work`);
      }
    }
  }

  #writeMessage(message: Message): void {
    this.#assertRunWritable(message.run_id);
    this.#database.prepare(`
      INSERT INTO messages (
        message_id, session_id, run_id, role, content, tool_name, created_at_ms, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.message_id,
      message.session_id,
      message.run_id,
      message.role,
      message.content,
      message.tool_name,
      message.created_at_ms,
      json(message.metadata, "message.metadata"),
    );
  }

  #writeToolCall(runId: string, call: ToolCall, createdAtMs: number): void {
    this.#assertRunWritable(runId);
    this.#database.prepare(`
      INSERT INTO tool_calls (
        tool_call_id, run_id, name, arguments_json, status, created_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      call.tool_call_id,
      runId,
      call.name,
      json(call.arguments, "tool_call.arguments"),
      createdAtMs,
    );
  }

  #writeAction(action: Action): void {
    this.#assertRunWritable(action.run_id);
    const write = this.#database.prepare(`
      INSERT INTO actions (action_id, run_id, tool_call_id, status, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET status = excluded.status
      WHERE actions.run_id = excluded.run_id
        AND actions.tool_call_id = excluded.tool_call_id
        AND actions.created_at_ms = excluded.created_at_ms
        AND (
          (actions.status = 'requested') OR
          (actions.status = 'accepted' AND excluded.status IN ('accepted', 'started', 'completed', 'failed')) OR
          (actions.status = 'started' AND excluded.status IN ('started', 'completed', 'failed')) OR
          (actions.status IN ('completed', 'failed') AND excluded.status = actions.status)
        )
    `).run(
      action.action_id,
      action.run_id,
      action.tool_call_id,
      action.status,
      action.created_at_ms,
    );
    if (Number(write.changes) !== 1) {
      throw new AuditStorageError(
        `action ${action.action_id} conflicts with stored identity or lifecycle`,
      );
    }
  }

  #writeToolResult(runId: string, result: ToolResult, completedAtMs: number): void {
    const update = this.#database.prepare(`
      UPDATE tool_calls SET
        status = ?,
        completed_at_ms = ?,
        result_json = ?,
        error_json = ?
      WHERE tool_call_id = ? AND run_id = ? AND name = ? AND status = 'pending'
    `).run(
      result.status,
      completedAtMs,
      result.result === null ? null : json(result.result, "tool_result.result"),
      result.error === null ? null : json(result.error, "tool_result.error"),
      result.tool_call_id,
      runId,
      result.name,
    );
    if (Number(update.changes) !== 1) {
      throw new AuditStorageError(
        `pending tool call not found for result ${result.tool_call_id}`,
      );
    }
  }

  #writeEvent(event: Event): void {
    this.#assertRunWritable(event.run_id);
    this.#database.prepare(`
      INSERT INTO events (event_id, run_id, type, occurred_at_ms, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.run_id,
      event.type,
      event.occurred_at_ms,
      json(event.payload, "event.payload"),
    );
  }

  #assertRunWritable(runId: string): void {
    const row = this.#database.prepare(`
      SELECT status FROM runs WHERE run_id = ?
    `).get(runId);
    const status = row === undefined ? null : stringValue(row.status, "runs.status");
    if (status !== "pending" && status !== "running") {
      throw new AuditStorageError(`run ${runId} is not writable`);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AuditStorageError("audit store is closed");
    }
  }

  #transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #transactionWithResult<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    this.#transaction(() => this.#migrateLocked());
  }

  #migrateLocked(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get();
    let currentVersion = numberValue(versionRow?.user_version, "PRAGMA user_version");
    if (currentVersion > SCHEMA_VERSION) {
      throw new AuditStorageError(
        `database schema version ${currentVersion} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (currentVersion === SCHEMA_VERSION) {
      return;
    }
    if (
      currentVersion !== 0
      && currentVersion !== 1
      && currentVersion !== 2
      && currentVersion !== 3
    ) {
      throw new AuditStorageError(`database schema version ${currentVersion} cannot be migrated`);
    }
    if (currentVersion === 1 || currentVersion === 2 || currentVersion === 3) {
      if (currentVersion === 1) {
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS events_role_interaction_idx
            ON events(type, json_extract(payload_json, '$.interaction_id'), occurred_at_ms, run_id);
          PRAGMA user_version = 2;
        `);
        currentVersion = 2;
      }
      if (currentVersion === 2) {
        this.#createMemorySchema();
        this.#database.exec("PRAGMA user_version = 3");
        currentVersion = 3;
      }
      if (currentVersion !== 3) {
        throw new AuditStorageError(
          `database schema version ${currentVersion} cannot be migrated to 4`,
        );
      }
      this.#upgradeMemorySchemaV4();
      this.#database.exec("PRAGMA user_version = 4");
      return;
    }
    this.#database.exec(`
        CREATE TABLE agent_profiles (
          agent_profile_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          locale TEXT NOT NULL CHECK (locale = 'zh-CN'),
          allowed_tools_json TEXT NOT NULL CHECK (json_valid(allowed_tools_json))
        ) STRICT;

        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(agent_profile_id),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
        ) STRICT;

        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(session_id),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
          ),
          started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
          completed_at_ms INTEGER CHECK (
            completed_at_ms IS NULL OR completed_at_ms >= started_at_ms
          ),
          CHECK (
            (status IN ('pending', 'running') AND completed_at_ms IS NULL) OR
            (status IN ('completed', 'failed', 'cancelled', 'timed_out') AND completed_at_ms IS NOT NULL)
          ),
          UNIQUE (run_id, session_id)
        ) STRICT;

        CREATE TABLE messages (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
          content TEXT NOT NULL,
          tool_name TEXT,
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
          CHECK (
            (role = 'tool' AND tool_name IS NOT NULL) OR
            (role != 'tool' AND tool_name IS NULL)
          ),
          FOREIGN KEY (run_id, session_id) REFERENCES runs(run_id, session_id)
        ) STRICT;

        CREATE TABLE tool_calls (
          tool_call_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          name TEXT NOT NULL,
          arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
          status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'error')),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          completed_at_ms INTEGER,
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
          CHECK (
            (status = 'pending' AND completed_at_ms IS NULL AND result_json IS NULL AND error_json IS NULL) OR
            (status = 'success' AND completed_at_ms IS NOT NULL AND result_json IS NOT NULL AND error_json IS NULL) OR
            (status = 'error' AND completed_at_ms IS NOT NULL AND result_json IS NULL AND error_json IS NOT NULL)
          ),
          CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
          UNIQUE (tool_call_id, run_id)
        ) STRICT;

        CREATE TABLE actions (
          action_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          tool_call_id TEXT NOT NULL REFERENCES tool_calls(tool_call_id),
          status TEXT NOT NULL CHECK (
            status IN ('requested', 'accepted', 'started', 'completed', 'failed')
          ),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
          FOREIGN KEY (tool_call_id, run_id) REFERENCES tool_calls(tool_call_id, run_id)
        ) STRICT;

        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id),
          type TEXT NOT NULL,
          occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        ) STRICT;

        CREATE INDEX messages_session_time_idx
          ON messages(session_id, created_at_ms, message_id);
        CREATE INDEX messages_run_time_idx
          ON messages(run_id, created_at_ms, message_id);
        CREATE INDEX tool_calls_run_time_idx
          ON tool_calls(run_id, created_at_ms, tool_call_id);
        CREATE INDEX actions_run_time_idx
          ON actions(run_id, created_at_ms, action_id);
        CREATE INDEX events_run_time_idx
          ON events(run_id, occurred_at_ms, event_id);
        CREATE INDEX events_role_interaction_idx
          ON events(type, json_extract(payload_json, '$.interaction_id'), occurred_at_ms, run_id);
    `);
    this.#createMemorySchema();
    this.#upgradeMemorySchemaV4();
    this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  #createMemorySchema(): void {
    this.#database.exec(`
      CREATE TABLE memories (
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        memory_id TEXT PRIMARY KEY
          CHECK (length(memory_id) BETWEEN 1 AND ${MAX_MEMORY_ID_LENGTH}),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        kind TEXT NOT NULL CHECK (
          kind IN ('conversation_summary', 'user_fact', 'task_outcome')
        ),
        content TEXT NOT NULL
          CHECK (length(content) BETWEEN 1 AND ${MAX_MEMORY_CONTENT_LENGTH}),
        source TEXT NOT NULL CHECK (
          source IN ('user_explicit', 'model_derived', 'task_execution', 'system_event')
        ),
        source_interaction_id TEXT CHECK (
          source_interaction_id IS NULL
          OR length(source_interaction_id) BETWEEN 1 AND ${MAX_INTERACTION_ID_LENGTH}
        ),
        confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
        sensitivity TEXT NOT NULL CHECK (
          sensitivity IN ('normal', 'personal', 'restricted')
        ),
        owner_role TEXT NOT NULL CHECK (owner_role IN ('robot', 'human', 'cat')),
        visibility_scope TEXT NOT NULL CHECK (
          visibility_scope IN ('owner_only', 'explicit_roles')
        ),
        policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        expires_at_ms INTEGER CHECK (
          expires_at_ms IS NULL OR expires_at_ms >= created_at_ms
        ),
        CHECK (sensitivity != 'restricted' OR visibility_scope = 'owner_only'),
        CHECK (
          (kind = 'conversation_summary' AND source = 'model_derived')
          OR (kind = 'user_fact' AND source = 'user_explicit')
          OR (kind = 'task_outcome' AND source = 'task_execution')
        )
      ) STRICT;

      CREATE TABLE memory_visible_roles (
        memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
        visible_role TEXT NOT NULL CHECK (visible_role IN ('robot', 'human', 'cat')),
        PRIMARY KEY (memory_id, visible_role)
      ) STRICT;

      CREATE TABLE memory_tags (
        memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
        tag TEXT NOT NULL
          CHECK (length(tag) BETWEEN 1 AND ${MAX_MEMORY_TAG_LENGTH}),
        PRIMARY KEY (memory_id, tag)
      ) STRICT;

      CREATE TRIGGER memory_visible_roles_insert_guard
      BEFORE INSERT ON memory_visible_roles
      WHEN EXISTS (
        SELECT 1
        FROM memories
        WHERE memory_id = new.memory_id
          AND (
            visibility_scope != 'explicit_roles'
            OR sensitivity = 'restricted'
            OR owner_role = new.visible_role
          )
      ) BEGIN
        SELECT RAISE(ABORT, 'invalid memory visibility ACL');
      END;

      CREATE TRIGGER memory_visible_roles_update_guard
      BEFORE UPDATE ON memory_visible_roles
      WHEN EXISTS (
        SELECT 1
        FROM memories
        WHERE memory_id = new.memory_id
          AND (
            visibility_scope != 'explicit_roles'
            OR sensitivity = 'restricted'
            OR owner_role = new.visible_role
          )
      ) BEGIN
        SELECT RAISE(ABORT, 'invalid memory visibility ACL');
      END;

      CREATE TRIGGER memories_visibility_update_guard
      BEFORE UPDATE OF owner_role, visibility_scope, sensitivity ON memories
      WHEN EXISTS (
        SELECT 1
        FROM memory_visible_roles
        WHERE memory_id = old.memory_id
          AND (
            new.visibility_scope != 'explicit_roles'
            OR new.sensitivity = 'restricted'
            OR visible_role = new.owner_role
          )
      ) BEGIN
        SELECT RAISE(ABORT, 'invalid memory visibility ACL');
      END;

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        content = 'memories',
        content_rowid = 'rowid',
        tokenize = 'trigram'
      );

      CREATE TRIGGER memories_fts_insert
      AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER memories_fts_delete
      AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER memories_fts_update
      AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE INDEX memories_owner_updated_idx
        ON memories(owner_role, updated_at_ms DESC, memory_id);
      CREATE INDEX memories_expiry_idx
        ON memories(expires_at_ms, memory_id)
        WHERE expires_at_ms IS NOT NULL;
      CREATE INDEX memory_visible_roles_role_idx
        ON memory_visible_roles(visible_role, memory_id);
      CREATE INDEX memory_tags_tag_idx
        ON memory_tags(tag, memory_id);
    `);
  }

  #upgradeMemorySchemaV4(): void {
    this.#database.exec(`
      ALTER TABLE memories ADD COLUMN idempotency_key TEXT;
      ALTER TABLE memories ADD COLUMN subject_key TEXT;
      ALTER TABLE memories ADD COLUMN supersedes_memory_id TEXT
        REFERENCES memories(memory_id);

      UPDATE memories
      SET idempotency_key = 'legacy:' || memory_id,
          subject_key = 'legacy:' || memory_id;

      CREATE UNIQUE INDEX memories_idempotency_key_unique
        ON memories(idempotency_key);
      CREATE INDEX memories_subject_canonical_idx
        ON memories(owner_role, kind, subject_key, created_at_ms DESC, memory_id);
      CREATE INDEX memories_supersedes_idx
        ON memories(supersedes_memory_id);
      CREATE UNIQUE INDEX memories_single_successor_unique
        ON memories(supersedes_memory_id)
        WHERE supersedes_memory_id IS NOT NULL;

      CREATE TRIGGER memories_v4_insert_required
      BEFORE INSERT ON memories
      WHEN new.idempotency_key IS NULL
        OR length(new.idempotency_key) NOT BETWEEN 1 AND ${MAX_MEMORY_IDEMPOTENCY_KEY_LENGTH}
        OR new.subject_key IS NULL
        OR length(new.subject_key) NOT BETWEEN 1 AND ${MAX_MEMORY_SUBJECT_KEY_LENGTH}
      BEGIN
        SELECT RAISE(ABORT, 'invalid memory v4 metadata');
      END;

      CREATE TRIGGER memories_v4_update_immutable
      BEFORE UPDATE OF idempotency_key, subject_key, supersedes_memory_id, owner_role, kind
      ON memories
      WHEN new.idempotency_key IS NOT old.idempotency_key
        OR new.subject_key IS NOT old.subject_key
        OR new.supersedes_memory_id IS NOT old.supersedes_memory_id
        OR new.owner_role IS NOT old.owner_role
        OR new.kind IS NOT old.kind
      BEGIN
        SELECT RAISE(ABORT, 'memory v4 identity and lineage are immutable');
      END;

      CREATE TRIGGER memories_canonical_content_immutable
      BEFORE UPDATE OF
        content, source, source_interaction_id, confidence, sensitivity,
        visibility_scope, policy_revision, expires_at_ms
      ON memories
      WHEN old.idempotency_key NOT GLOB 'legacy:*'
        AND (
          new.content IS NOT old.content
          OR new.source IS NOT old.source
          OR new.source_interaction_id IS NOT old.source_interaction_id
          OR new.confidence IS NOT old.confidence
          OR new.sensitivity IS NOT old.sensitivity
          OR new.visibility_scope IS NOT old.visibility_scope
          OR new.policy_revision IS NOT old.policy_revision
          OR new.expires_at_ms IS NOT old.expires_at_ms
        )
      BEGIN
        SELECT RAISE(ABORT, 'canonical memory content is immutable');
      END;

      CREATE TRIGGER memories_lineage_insert_guard
      BEFORE INSERT ON memories
      WHEN new.supersedes_memory_id IS NOT NULL
        AND (
          new.supersedes_memory_id = new.memory_id
          OR NOT EXISTS (
            SELECT 1 FROM memories AS parent
            WHERE parent.memory_id = new.supersedes_memory_id
              AND parent.owner_role = new.owner_role
              AND parent.kind = new.kind
              AND parent.subject_key = new.subject_key
          )
          OR EXISTS (
            WITH RECURSIVE ancestors(memory_id) AS (
              SELECT supersedes_memory_id
              FROM memories
              WHERE memory_id = new.supersedes_memory_id
              UNION ALL
              SELECT parent.supersedes_memory_id
              FROM memories AS parent
              JOIN ancestors ON parent.memory_id = ancestors.memory_id
              WHERE ancestors.memory_id IS NOT NULL
            )
            SELECT 1 FROM ancestors WHERE memory_id = new.memory_id
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid memory supersession lineage');
      END;

      CREATE TABLE memory_deletion_requests (
        request_id TEXT PRIMARY KEY
          CHECK (length(request_id) BETWEEN 1 AND ${MAX_DELETION_REQUEST_ID_LENGTH}),
        target_memory_id TEXT NOT NULL
          CHECK (length(target_memory_id) BETWEEN 1 AND ${MAX_MEMORY_ID_LENGTH}),
        requester_role TEXT NOT NULL CHECK (requester_role IN ('robot', 'human', 'cat')),
        reason TEXT NOT NULL CHECK (
          reason IN ('user_request', 'privacy_request', 'correction', 'policy_violation')
        ),
        requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0)
      ) STRICT;

      CREATE TABLE memory_deletion_items (
        request_id TEXT NOT NULL
          REFERENCES memory_deletion_requests(request_id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL
          CHECK (length(memory_id) BETWEEN 1 AND ${MAX_MEMORY_ID_LENGTH}),
        idempotency_key TEXT NOT NULL
          CHECK (
            length(idempotency_key)
            BETWEEN 1 AND ${MAX_MEMORY_IDEMPOTENCY_KEY_LENGTH}
          ),
        PRIMARY KEY (request_id, memory_id)
      ) STRICT;

      CREATE UNIQUE INDEX memory_deletion_items_memory_unique
        ON memory_deletion_items(memory_id);
      CREATE UNIQUE INDEX memory_deletion_items_idempotency_unique
        ON memory_deletion_items(idempotency_key);

      CREATE TRIGGER memories_v4_kind_source_insert_guard
      BEFORE INSERT ON memories
      WHEN NOT (
        (new.kind = 'conversation_summary' AND new.source = 'model_derived')
        OR (new.kind = 'user_fact' AND new.source = 'user_explicit')
        OR (new.kind = 'task_outcome' AND new.source = 'task_execution')
      ) BEGIN
        SELECT RAISE(ABORT, 'invalid memory kind/source binding');
      END;

      CREATE TRIGGER memories_v4_kind_source_update_guard
      BEFORE UPDATE OF source ON memories
      WHEN NOT (
        (new.kind = 'conversation_summary' AND new.source = 'model_derived')
        OR (new.kind = 'user_fact' AND new.source = 'user_explicit')
        OR (new.kind = 'task_outcome' AND new.source = 'task_execution')
      ) BEGIN
        SELECT RAISE(ABORT, 'invalid memory kind/source binding');
      END;

      CREATE TRIGGER memories_deleted_idempotency_guard
      BEFORE INSERT ON memories
      WHEN EXISTS (
        SELECT 1 FROM memory_deletion_items
        WHERE idempotency_key = new.idempotency_key
          OR memory_id = new.memory_id
      ) BEGIN
        SELECT RAISE(ABORT, 'memory identity was explicitly deleted');
      END;
    `);
  }
}
