import { createHash } from "node:crypto";

import type {
  CanonicalMemoryCreate,
  MemoryKind,
  MemoryOwnerRole,
  MemorySensitivity,
  MemoryVisibilityScope,
} from "@p4home/storage-sqlite";

export const MEMORY_POLICY_REVISION = 1;

export type MemoryDataClass =
  | "controlled_conversation_summary"
  | "user_statement"
  | "audited_task_result"
  | "credential"
  | "raw_audio"
  | "ha_entity_state"
  | "world_snapshot"
  | "sensitive_home_state";

export type MemoryPolicyRejectionCode =
  | "INVALID_CANDIDATE"
  | "ROUTER_WRITE_FORBIDDEN"
  | "DATA_CLASS_FORBIDDEN"
  | "KIND_EVIDENCE_MISMATCH"
  | "SUMMARY_NOT_COMPLETED"
  | "USER_FACT_EVIDENCE_INSUFFICIENT"
  | "TASK_AUDIT_REQUIRED"
  | "EVIDENCE_NOT_AUDITED"
  | "SECRET_DETECTED"
  | "SENSITIVE_HOME_STATE_FORBIDDEN";

export interface MemoryCandidate {
  readonly schema_version: 1;
  readonly candidate_id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly data_class: MemoryDataClass;
  readonly source_interaction_id: string;
  readonly owner_role: MemoryOwnerRole;
  readonly subject_key: string;
  readonly confidence: number;
  readonly sensitivity: MemorySensitivity;
  readonly visibility_scope: MemoryVisibilityScope;
  readonly visible_to_roles: readonly MemoryOwnerRole[];
  readonly tags: readonly string[];
  readonly created_at_ms: number;
  readonly expires_at_ms: number | null;
}

export interface ConversationSummaryEvidence {
  readonly schema_version: 1;
  readonly kind: "conversation_summary";
  readonly interaction_id: string;
  readonly run_id: string;
  readonly role_id: MemoryOwnerRole;
  readonly summary_message_id: string;
  readonly interaction_status: "completed";
  readonly run_status: "completed";
  readonly summary_origin: "runtime_controlled";
  readonly audit_finalized: true;
}

export interface UserStatementEvidence {
  readonly interaction_id: string;
  readonly run_id: string;
  readonly role_id: MemoryOwnerRole;
  readonly message_id: string;
  readonly text: string;
  readonly assertion: "explicit" | "confirmation";
}

export interface UserFactEvidence {
  readonly schema_version: 1;
  readonly kind: "user_fact";
  readonly statements: readonly UserStatementEvidence[];
}

export interface TaskOutcomeEvidence {
  readonly schema_version: 1;
  readonly kind: "task_outcome";
  readonly interaction_id: string;
  readonly run_id: string;
  readonly role_id: MemoryOwnerRole;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly tool_status: "success" | "error";
  readonly run_status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly summary_message_id: string;
  readonly audit_finalized: true;
  readonly result_digest: string;
  readonly summary_origin: "runtime_controlled";
}

export type MemoryEvidence =
  | ConversationSummaryEvidence
  | UserFactEvidence
  | TaskOutcomeEvidence;

export type MemoryPolicyDecision =
  | {
    readonly accepted: true;
    readonly memory: CanonicalMemoryCreate;
  }
  | {
    readonly accepted: false;
    readonly code: MemoryPolicyRejectionCode;
  };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MAX_CONTENT = 8_192;
const MAX_SUBJECT = 256;
const MAX_TAGS = 16;
const MAX_TAG = 64;
const MAX_EVIDENCE_STATEMENTS = 8;
const DATA_CLASS_BY_KIND: Readonly<Record<MemoryKind, MemoryDataClass>> = {
  conversation_summary: "controlled_conversation_summary",
  user_fact: "user_statement",
  task_outcome: "audited_task_result",
};

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reject(code: MemoryPolicyRejectionCode): MemoryPolicyDecision {
  return { accepted: false, code };
}

function validId(value: unknown, max = 128): value is string {
  return typeof value === "string"
    && value.length <= max
    && SAFE_ID.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCandidate(candidate: unknown): candidate is MemoryCandidate {
  if (!isRecord(candidate)) {
    return false;
  }
  const content = candidate.content;
  const subjectKey = candidate.subject_key;
  const confidence = candidate.confidence;
  const createdAtMs = candidate.created_at_ms;
  const expiresAtMs = candidate.expires_at_ms;
  return candidate.schema_version === 1
    && typeof candidate.kind === "string"
    && ["conversation_summary", "user_fact", "task_outcome"].includes(candidate.kind)
    && [
      "controlled_conversation_summary",
      "user_statement",
      "audited_task_result",
      "credential",
      "raw_audio",
      "ha_entity_state",
      "world_snapshot",
      "sensitive_home_state",
    ].includes(typeof candidate.data_class === "string" ? candidate.data_class : "")
    && ["robot", "human", "cat"].includes(
      typeof candidate.owner_role === "string" ? candidate.owner_role : "",
    )
    && ["normal", "personal", "restricted"].includes(
      typeof candidate.sensitivity === "string" ? candidate.sensitivity : "",
    )
    && ["owner_only", "explicit_roles"].includes(
      typeof candidate.visibility_scope === "string" ? candidate.visibility_scope : "",
    )
    && validId(candidate.candidate_id)
    && validId(candidate.source_interaction_id)
    && typeof content === "string"
    && normalized(content).length > 0
    && normalized(content).length <= MAX_CONTENT
    && typeof subjectKey === "string"
    && normalized(subjectKey).length > 0
    && normalized(subjectKey).length <= MAX_SUBJECT
    && typeof confidence === "number"
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1
    && Number.isSafeInteger(createdAtMs)
    && (createdAtMs as number) >= 0
    && (
      expiresAtMs === null
      || (
        Number.isSafeInteger(expiresAtMs)
        && (expiresAtMs as number) >= (createdAtMs as number)
      )
    )
    && Array.isArray(candidate.tags)
    && candidate.tags.length <= MAX_TAGS
    && candidate.tags.every((tag) =>
      typeof tag === "string"
      && normalized(tag) === tag
      && tag.length > 0
      && tag.length <= MAX_TAG)
    && new Set(candidate.tags).size === candidate.tags.length
    && Array.isArray(candidate.visible_to_roles)
    && candidate.visible_to_roles.length <= 2
    && candidate.visible_to_roles.every((role) =>
      ["robot", "human", "cat"].includes(role))
    && new Set(candidate.visible_to_roles).size === candidate.visible_to_roles.length
    && !candidate.visible_to_roles.includes(candidate.owner_role);
}

function containsSecret(content: string): boolean {
  const probes = [
    /\b(?:authorization|proxy-authorization)\s*:\s*\S+/iu,
    /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/iu,
    /\b(?:api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret)\s*(?::|=|is|equals?)\s*\S+/iu,
    /(?:\btoken\b|令牌)\s*(?::|：|=|is|equals?|是|为)\s*\S+/iu,
    /(?:password|passwd|pwd|密码|口令)\s*(?::|：|=|is|equals?|是|为)\s*\S+/iu,
    /(?:wi-?fi|wlan|无线网络)\s*(?:password|key|密码|密钥)\s*(?:[:：=]|是|为)\s*\S+/iu,
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/u,
  ];
  return probes.some((probe) => probe.test(content));
}

function containsSensitiveHomeState(content: string): boolean {
  return /(?:门锁|门窗|摄像头|camera|lock|presence|occupancy|在家|离家).{0,24}(?:状态|state|当前|现在|实时|有人|无人|开|关|锁定|解锁|locked|unlocked|open|closed|home|away)/iu
    .test(content)
    || /(?:当前|现在|实时|currently|now).{0,24}(?:门锁|门窗|摄像头|camera|lock|presence|occupancy|在家|离家|有人|无人)/iu
      .test(content);
}

function containsForbiddenLiveOrAudioPayload(content: string): boolean {
  return /(?:\b(?:pcm_s16le|audio\/pcm|raw[\s_-]?audio|audio[\s_-]?(?:samples?|bytes?|waveform))\b|原始音频|音频(?:采样|字节|波形)|PCM\s*(?:samples?|数据|字节))/iu
    .test(content)
    || /(?:\bentity[\s_-]?id\s*[:=]|(?:home assistant|\bHA\b).{0,20}(?:entity|state|实体|状态))/iu
      .test(content)
    || /(?:\bworld[\s_-]?(?:snapshot|state)\b|世界状态快照|实时世界状态)/iu.test(content)
    || /(?:当前|现在|实时|currently|right now).{0,24}(?:灯|空调|温控|传感器|light|thermostat|sensor).{0,16}(?:开|关|状态|on|off|state)/iu
      .test(content);
}

function validTaskSemantics(evidence: TaskOutcomeEvidence): boolean {
  if (evidence.outcome === "succeeded") {
    return evidence.run_status === "completed" && evidence.tool_status === "success";
  }
  if (evidence.outcome === "cancelled") {
    return evidence.run_status === "cancelled" && evidence.tool_status === "error";
  }
  if (evidence.outcome === "timed_out") {
    return evidence.run_status === "timed_out" && evidence.tool_status === "error";
  }
  return ["completed", "failed"].includes(evidence.run_status)
    && evidence.tool_status === "error";
}

function evidenceMatches(
  candidate: MemoryCandidate,
  evidence: MemoryEvidence,
): MemoryPolicyRejectionCode | null {
  if (!isRecord(evidence) || evidence.schema_version !== 1) {
    return "INVALID_CANDIDATE";
  }
  if (candidate.kind !== evidence.kind) {
    return "KIND_EVIDENCE_MISMATCH";
  }
  if (evidence.kind === "conversation_summary") {
    return candidate.data_class === DATA_CLASS_BY_KIND.conversation_summary
      && evidence.interaction_id === candidate.source_interaction_id
      && validId(evidence.run_id)
      && evidence.role_id === candidate.owner_role
      && validId(evidence.summary_message_id)
      && evidence.interaction_status === "completed"
      && evidence.run_status === "completed"
      && evidence.summary_origin === "runtime_controlled"
      && evidence.audit_finalized === true
      ? null
      : "SUMMARY_NOT_COMPLETED";
  }
  if (evidence.kind === "task_outcome") {
    return candidate.data_class === DATA_CLASS_BY_KIND.task_outcome
      && evidence.interaction_id === candidate.source_interaction_id
      && validId(evidence.run_id)
      && evidence.role_id === candidate.owner_role
      && validId(evidence.tool_call_id)
      && validId(evidence.tool_name)
      && validId(evidence.summary_message_id)
      && /^[a-f0-9]{64}$/u.test(evidence.result_digest)
      && validTaskSemantics(evidence)
      && evidence.summary_origin === "runtime_controlled"
      && evidence.audit_finalized === true
      ? null
      : "TASK_AUDIT_REQUIRED";
  }
  if (
    candidate.data_class !== DATA_CLASS_BY_KIND.user_fact
    || !Array.isArray(evidence.statements)
    || evidence.statements.length < 1
    || evidence.statements.length > MAX_EVIDENCE_STATEMENTS
  ) {
    return "USER_FACT_EVIDENCE_INSUFFICIENT";
  }
  const content = normalized(candidate.content);
  const usable = evidence.statements.filter((statement) =>
    isRecord(statement)
    && validId(statement.interaction_id)
    && validId(statement.run_id)
    && statement.role_id === candidate.owner_role
    && validId(statement.message_id)
    && typeof statement.text === "string"
    && normalized(statement.text).length > 0
    && normalized(statement.text).length <= MAX_CONTENT
    && normalized(statement.text) === content);
  const explicit = usable.some((statement) => statement.assertion === "explicit");
  const confirmations = new Set(
    usable
      .filter((statement) => statement.assertion === "confirmation")
      .map((statement) => statement.interaction_id),
  );
  const includesSourceInteraction = usable.some((statement) =>
    statement.interaction_id === candidate.source_interaction_id);
  return includesSourceInteraction && (explicit || confirmations.size >= 2)
    ? null
    : "USER_FACT_EVIDENCE_INSUFFICIENT";
}

export function evaluateMemoryCandidate(
  candidateInput: MemoryCandidate,
  evidenceInput: MemoryEvidence,
): MemoryPolicyDecision {
  if (!validCandidate(candidateInput) || !isRecord(evidenceInput)) {
    return reject("INVALID_CANDIDATE");
  }
  const candidate = candidateInput;
  const evidence = evidenceInput;
  if ([
    "credential",
    "raw_audio",
    "ha_entity_state",
    "world_snapshot",
  ].includes(candidate.data_class)) {
    return reject("DATA_CLASS_FORBIDDEN");
  }
  if (candidate.data_class !== DATA_CLASS_BY_KIND[candidate.kind]) {
    return reject("KIND_EVIDENCE_MISMATCH");
  }
  const content = normalized(candidate.content);
  if (containsForbiddenLiveOrAudioPayload(content)) {
    return reject("DATA_CLASS_FORBIDDEN");
  }
  if (
    candidate.data_class === "sensitive_home_state"
    || containsSensitiveHomeState(content)
  ) {
    return reject("SENSITIVE_HOME_STATE_FORBIDDEN");
  }
  if (containsSecret([
    content,
    normalized(candidate.subject_key),
    ...candidate.tags,
  ].join("\n"))) {
    return reject("SECRET_DETECTED");
  }
  const evidenceFailure = evidenceMatches(candidate, evidence);
  if (evidenceFailure !== null) {
    return reject(evidenceFailure);
  }
  const subjectKey = normalized(candidate.subject_key).toLocaleLowerCase("zh-CN");
  const idempotencyKey = digest([
    candidate.source_interaction_id,
    candidate.owner_role,
    candidate.kind,
    content,
  ].join("\u0000"));
  const restricted = candidate.sensitivity === "restricted";
  const visibilityScope = restricted ? "owner_only" : candidate.visibility_scope;
  const visibleToRoles = restricted ? [] : [...candidate.visible_to_roles].sort();
  if (
    (visibilityScope === "owner_only" && visibleToRoles.length !== 0)
    || (visibilityScope === "explicit_roles" && visibleToRoles.length === 0)
  ) {
    return reject("INVALID_CANDIDATE");
  }
  return {
    accepted: true,
    memory: {
      schema_version: 1,
      memory_id: `memory:${idempotencyKey}`,
      kind: candidate.kind,
      content,
      source: candidate.kind === "user_fact"
        ? "user_explicit"
        : candidate.kind === "task_outcome"
          ? "task_execution"
          : "model_derived",
      source_interaction_id: candidate.source_interaction_id,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      owner_role: candidate.owner_role,
      visibility_scope: visibilityScope,
      visible_to_roles: visibleToRoles,
      policy_revision: MEMORY_POLICY_REVISION,
      tags: [...candidate.tags].sort(),
      created_at_ms: candidate.created_at_ms,
      expires_at_ms: candidate.expires_at_ms,
      idempotency_key: idempotencyKey,
      subject_key: subjectKey,
    },
  };
}
