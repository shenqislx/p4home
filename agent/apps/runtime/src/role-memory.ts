import type {
  MemoryKind,
  MemoryOwnerRole,
  MemoryProjectionStrategy,
  MemoryRecall,
  MemoryRecallItem,
  MemoryRecallResult,
} from "@p4home/storage-sqlite";
import type { OllamaChatMessage } from "@p4home/provider-ollama";

import { buildMemoryContext } from "./role-context-builder.ts";

export interface MemoryRecallStore {
  recallMemories(query: MemoryRecall): Promise<MemoryRecallResult>;
}

export interface TokenCounter {
  countTokens(text: string): number;
}

export interface MemoryRecallMetadata {
  readonly status: "ok" | "empty" | "timeout" | "error";
  readonly selected_memory_ids: readonly string[];
  readonly token_count: number;
  readonly token_count_method: "injected" | "conservative_estimate";
  readonly candidate_count: number;
}

export interface MemoryContextResult {
  readonly messages: readonly OllamaChatMessage[];
  readonly metadata: MemoryRecallMetadata;
}

export interface RoleMemoryRecallRequest {
  readonly role_id: MemoryOwnerRole;
  readonly query: string;
  readonly memory_token_budget: number;
  /** Conservative remaining profile input capacity after required context. */
  readonly context_token_budget?: number;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * Product runtime boundary. Implementations created by
 * createPrivateRoleMemoryRuntime always issue private projections.
 */
export interface RoleMemoryRuntime {
  readonly strategy: "private";
  recall(request: RoleMemoryRecallRequest): Promise<MemoryContextResult>;
}

export interface PrivateRoleMemoryRuntimeOptions {
  readonly store: MemoryRecallStore;
  readonly approved_policy_revision: number;
  readonly token_counter?: TokenCounter;
  readonly recall_timeout_ms?: number;
  readonly recall_limit?: number;
  readonly clock?: () => number;
}

export interface ExperimentalMemoryProjectionOptions
extends PrivateRoleMemoryRuntimeOptions, RoleMemoryRecallRequest {
  /**
   * Evaluator-only strategy selector. Product entry points do not accept this
   * field and therefore cannot enable cross-role recall through configuration.
   */
  readonly strategy: MemoryProjectionStrategy;
}

const MAX_RECALL_TIMEOUT_MS = 30_000;
const MAX_RECALL_LIMIT = 100;
const MAX_RECALL_QUERY_LENGTH = 512;
const MAX_RECALL_QUERY_TERMS = 16;
const MAX_MEMORY_CONTENT_LENGTH = 32_768;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_LENGTH = 64;
const PRIVATE_RUNTIMES = new WeakSet<object>();
const MEMORY_KINDS = new Set<MemoryKind>([
  "conversation_summary",
  "user_fact",
  "task_outcome",
]);
const MEMORY_ROLES = new Set<MemoryOwnerRole>(["robot", "human", "cat"]);
const MEMORY_SOURCES = new Set([
  "user_explicit",
  "model_derived",
  "task_execution",
]);
const MEMORY_SENSITIVITIES = new Set(["normal", "personal", "restricted"]);
const MEMORY_VISIBILITY_SCOPES = new Set(["owner_only", "explicit_roles"]);

const conservativeTokenCounter: TokenCounter = {
  countTokens(text: string): number {
    // One token per UTF-8 byte plus message overhead deliberately
    // overestimates ordinary model tokenization. This is not a tokenizer.
    return Buffer.byteLength(text, "utf8") + 16;
  },
};

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeRecallQuery(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("memory recall query must be text");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError("memory recall query must not be empty");
  }
  const terms = normalized.split(/\s+/u);
  if (
    normalized.length > MAX_RECALL_QUERY_LENGTH
    || terms.length > MAX_RECALL_QUERY_TERMS
  ) {
    throw new TypeError(
      `memory recall query must not exceed ${MAX_RECALL_QUERY_LENGTH} characters or ${MAX_RECALL_QUERY_TERMS} terms`,
    );
  }
  return normalized;
}

function normalizeKinds(value: readonly MemoryKind[] | undefined): readonly MemoryKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MEMORY_KINDS.size
    || new Set(value).size !== value.length
    || value.some((kind) => !MEMORY_KINDS.has(kind))
  ) {
    throw new TypeError("memory recall kinds must contain 1..3 unique supported kinds");
  }
  return [...value];
}

function normalizeTags(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_MEMORY_TAGS
    || new Set(value).size !== value.length
    || value.some((tag) =>
      typeof tag !== "string"
      || tag.length === 0
      || tag.length > MAX_MEMORY_TAG_LENGTH
      || tag.trim() !== tag)
  ) {
    throw new TypeError("memory recall tags must contain 1..32 unique bounded tags");
  }
  return [...value];
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value;
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isWellFormedRecallItem(value: unknown): value is MemoryRecallItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<MemoryRecallItem>;
  if (
    item.schema_version !== 1
    || !isBoundedText(item.memory_id, 128)
    || !Number.isSafeInteger(item.revision)
    || (item.revision ?? 0) < 1
    || !MEMORY_KINDS.has(item.kind as MemoryKind)
    || !isBoundedText(item.content, MAX_MEMORY_CONTENT_LENGTH)
    || !MEMORY_SOURCES.has(item.source as string)
    || (
      item.source_interaction_id !== null
      && !isBoundedText(item.source_interaction_id, 128)
    )
    || typeof item.confidence !== "number"
    || !Number.isFinite(item.confidence)
    || item.confidence < 0
    || item.confidence > 1
    || !MEMORY_SENSITIVITIES.has(item.sensitivity as string)
    || !MEMORY_ROLES.has(item.owner_role as MemoryOwnerRole)
    || !MEMORY_VISIBILITY_SCOPES.has(item.visibility_scope as string)
    || !Array.isArray(item.visible_to_roles)
    || item.visible_to_roles.some((role) => !MEMORY_ROLES.has(role))
    || new Set(item.visible_to_roles).size !== item.visible_to_roles.length
    || item.visible_to_roles.includes(item.owner_role as MemoryOwnerRole)
    || !Number.isSafeInteger(item.policy_revision)
    || (item.policy_revision ?? 0) < 1
    || !Array.isArray(item.tags)
    || item.tags.length > MAX_MEMORY_TAGS
    || item.tags.some((tag) => !isBoundedText(tag, MAX_MEMORY_TAG_LENGTH))
    || new Set(item.tags).size !== item.tags.length
    || !isSafeTime(item.created_at_ms)
    || !isSafeTime(item.updated_at_ms)
    || item.updated_at_ms < item.created_at_ms
    || (item.expires_at_ms !== null && !isSafeTime(item.expires_at_ms))
    || !isBoundedText(item.idempotency_key, 128)
    || !isBoundedText(item.subject_key, 256)
    || (
      item.supersedes_memory_id !== null
      && !isBoundedText(item.supersedes_memory_id, 128)
    )
    || typeof item.recall_relevance !== "number"
    || !Number.isFinite(item.recall_relevance)
    || item.recall_relevance < 0
  ) {
    return false;
  }
  const expectedSource = {
    conversation_summary: "model_derived",
    user_fact: "user_explicit",
    task_outcome: "task_execution",
  } as const;
  return item.source === expectedSource[item.kind as MemoryKind]
    && (
      item.visibility_scope === "owner_only"
        ? item.visible_to_roles.length === 0
        : item.visible_to_roles.length > 0
    )
    && (item.sensitivity !== "restricted" || item.visibility_scope === "owner_only");
}

function recallItemAllowed(
  item: MemoryRecallItem,
  request: RoleMemoryRecallRequest,
  strategy: MemoryProjectionStrategy,
  approvedPolicyRevision: number,
  nowMs: number,
  kinds: readonly MemoryKind[] | undefined,
  tags: readonly string[] | undefined,
  queryTerms: readonly string[],
): boolean {
  if (
    (item.expires_at_ms !== null && item.expires_at_ms <= nowMs)
    || (kinds !== undefined && !kinds.includes(item.kind))
    || (tags !== undefined && tags.some((tag) => !item.tags.includes(tag)))
    || queryTerms.some((term) => !item.content.includes(term))
  ) {
    return false;
  }
  if (item.owner_role === request.role_id) {
    return true;
  }
  return strategy !== "private"
    && item.sensitivity !== "restricted"
    && item.visibility_scope === "explicit_roles"
    && item.visible_to_roles.includes(request.role_id)
    && item.policy_revision === approvedPolicyRevision
    && (strategy === "shared_acl" || item.kind === "user_fact");
}

function emptyResult(
  status: Extract<MemoryRecallMetadata["status"], "empty" | "timeout" | "error">,
  tokenCountMethod: MemoryRecallMetadata["token_count_method"],
): MemoryContextResult {
  return {
    messages: [],
    metadata: {
      status,
      selected_memory_ids: [],
      token_count: 0,
      token_count_method: tokenCountMethod,
      candidate_count: 0,
    },
  };
}

async function recallProjection(
  options: ExperimentalMemoryProjectionOptions,
): Promise<MemoryContextResult> {
  const approvedPolicyRevision = positiveInteger(
    options.approved_policy_revision,
    "approved_policy_revision",
    Number.MAX_SAFE_INTEGER,
  );
  const timeoutMs = positiveInteger(
    options.recall_timeout_ms ?? 500,
    "recall_timeout_ms",
    MAX_RECALL_TIMEOUT_MS,
  );
  const limit = positiveInteger(
    options.recall_limit ?? 50,
    "recall_limit",
    MAX_RECALL_LIMIT,
  );
  const budget = nonNegativeInteger(
    options.memory_token_budget,
    "memory_token_budget",
  );
  const contextBudget = nonNegativeInteger(
    options.context_token_budget ?? Number.MAX_SAFE_INTEGER,
    "context_token_budget",
  );
  const counter = options.token_counter ?? conservativeTokenCounter;
  const tokenCountMethod = options.token_counter === undefined
    ? "conservative_estimate"
    : "injected";
  const query = normalizeRecallQuery(options.query);
  const queryTerms = query.split(/\s+/u);
  const kinds = normalizeKinds(options.kinds);
  const tags = normalizeTags(options.tags);
  const nowMs = (options.clock ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("memory recall clock must return a non-negative safe integer");
  }
  if (budget === 0 || contextBudget === 0) {
    return emptyResult("empty", tokenCountMethod);
  }
  if (options.signal?.aborted === true) {
    return emptyResult("error", tokenCountMethod);
  }

  const timeout = Symbol("memory-recall-timeout");
  const aborted = Symbol("memory-recall-aborted");
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const recalled = await Promise.race([
      options.store.recallMemories({
        requester_role: options.role_id,
        strategy: options.strategy,
        approved_policy_revision: approvedPolicyRevision,
        query,
        ...(kinds === undefined ? {} : { kinds }),
        ...(tags === undefined ? {} : { tags }),
        limit,
        now_ms: nowMs,
      }),
      new Promise<typeof timeout>((resolve) => {
        timer = setTimeout(() => resolve(timeout), timeoutMs);
      }),
      new Promise<typeof aborted>((resolve) => {
        if (options.signal !== undefined) {
          onAbort = () => resolve(aborted);
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
    if (recalled === timeout) {
      return emptyResult("timeout", tokenCountMethod);
    }
    if (recalled === aborted) {
      return emptyResult("error", tokenCountMethod);
    }
    if (!Array.isArray(recalled.items)) {
      return emptyResult("error", tokenCountMethod);
    }
    const safeItems = recalled.items
      .filter(isWellFormedRecallItem)
      .filter((item) => recallItemAllowed(
        item,
        options,
        options.strategy,
        approvedPolicyRevision,
        nowMs,
        kinds,
        tags,
        queryTerms,
      ))
      .slice(0, limit);
    if (safeItems.length === 0) {
      return emptyResult("empty", tokenCountMethod);
    }
    return buildMemoryContext(
      safeItems,
      budget,
      counter,
      tokenCountMethod,
      contextBudget,
    );
  } catch {
    return emptyResult("error", tokenCountMethod);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function createPrivateRoleMemoryRuntime(
  options: PrivateRoleMemoryRuntimeOptions,
): RoleMemoryRuntime {
  const runtime = Object.freeze({
    strategy: "private" as const,
    recall: async (request: RoleMemoryRecallRequest): Promise<MemoryContextResult> =>
      await recallProjection({
        store: options.store,
        approved_policy_revision: options.approved_policy_revision,
        ...(options.token_counter === undefined ? {} : { token_counter: options.token_counter }),
        ...(options.recall_timeout_ms === undefined
          ? {}
          : { recall_timeout_ms: options.recall_timeout_ms }),
        ...(options.recall_limit === undefined ? {} : { recall_limit: options.recall_limit }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        role_id: request.role_id,
        query: request.query,
        memory_token_budget: request.memory_token_budget,
        ...(request.context_token_budget === undefined
          ? {}
          : { context_token_budget: request.context_token_budget }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        ...(request.tags === undefined ? {} : { tags: request.tags }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        strategy: "private",
      }),
  });
  PRIVATE_RUNTIMES.add(runtime);
  return runtime;
}

export async function recallPrivateRoleMemory(
  runtime: RoleMemoryRuntime,
  request: RoleMemoryRecallRequest,
): Promise<MemoryContextResult> {
  if (runtime.strategy !== "private" || !PRIVATE_RUNTIMES.has(runtime)) {
    throw new TypeError(
      "product RoleMemoryRuntime must be an authentic private runtime created by the factory",
    );
  }
  return await runtime.recall(request);
}

/**
 * Explicit evaluator boundary for Phase 6 visibility experiments. Product
 * runners intentionally accept RoleMemoryRuntime instead of these options.
 */
export async function recallExperimentalMemoryProjection(
  options: ExperimentalMemoryProjectionOptions,
): Promise<MemoryContextResult> {
  return await recallProjection(options);
}
