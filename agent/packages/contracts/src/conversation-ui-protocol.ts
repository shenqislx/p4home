export const CONVERSATION_UI_PROTOCOL_VERSION = 1 as const;
export const CONVERSATION_UI_MAX_USER_CHARS = 256;
export const CONVERSATION_UI_MAX_USER_BYTES = 1_024;
export const CONVERSATION_UI_MAX_RESPONSE_CHARS = 512;
export const CONVERSATION_UI_MAX_RESPONSE_BYTES = 2_048;

export type ConversationUiStage =
  | "listening"
  | "transcribing"
  | "thinking"
  | "completed"
  | "failed"
  | "cancelled";

export type ConversationUiResponseRole = "none" | "human" | "robot" | "mixed" | "system";
export type ConversationUiExecutionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "unknown"
  | "not_applicable";

export interface ConversationUiIdentity {
  readonly ui_protocol_version: 1;
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
  readonly revision: number;
}

export interface ConversationUiUpdate extends ConversationUiIdentity {
  readonly type: "ui.update";
  readonly stage: ConversationUiStage;
  readonly user_text: string;
  readonly response_text: string;
  readonly response_role: ConversationUiResponseRole;
  readonly execution_status: ConversationUiExecutionStatus;
}

export interface ConversationUiApplied extends ConversationUiIdentity {
  readonly type: "ui.applied";
}

export type ConversationUiMessage = ConversationUiUpdate | ConversationUiApplied;

export type ConversationUiProtocolErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_IDENTITY"
  | "INVALID_STAGE"
  | "LIMIT_EXCEEDED";

export class ConversationUiProtocolError extends Error {
  public constructor(
    public readonly code: ConversationUiProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConversationUiProtocolError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationUiProtocolError("INVALID_MESSAGE", "conversation UI message must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new ConversationUiProtocolError("INVALID_MESSAGE", "conversation UI message fields are not exact");
  }
}

function uint32(value: unknown, label: string, positive = true): number {
  if (!Number.isInteger(value) || (value as number) < (positive ? 1 : 0)
      || (value as number) > 0xffff_ffff) {
    throw new ConversationUiProtocolError("INVALID_IDENTITY", `${label} is outside uint32 range`);
  }
  return value as number;
}

function identity(value: Record<string, unknown>): ConversationUiIdentity {
  if (value.ui_protocol_version !== CONVERSATION_UI_PROTOCOL_VERSION
      || typeof value.session_id !== "string"
      || !/^[0-9a-f]{32}$/.test(value.session_id)
      || value.session_id === "0".repeat(32)) {
    throw new ConversationUiProtocolError("INVALID_IDENTITY", "conversation UI identity is invalid");
  }
  return {
    ui_protocol_version: CONVERSATION_UI_PROTOCOL_VERSION,
    session_id: value.session_id,
    stream_id: uint32(value.stream_id, "stream_id"),
    epoch: uint32(value.epoch, "epoch"),
    revision: uint32(value.revision, "revision"),
  };
}

function boundedText(
  value: unknown,
  label: string,
  maxChars: number,
  maxBytes: number,
): string {
  if (typeof value !== "string"
      || hasUnpairedSurrogate(value)
      || [...value].length > maxChars
      || Buffer.byteLength(value, "utf8") > maxBytes
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ConversationUiProtocolError("LIMIT_EXCEEDED", `${label} is not bounded display text`);
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ConversationUiProtocolError("INVALID_STAGE", `${label} is invalid`);
  }
  return value as T;
}

function validateStage(update: ConversationUiUpdate): void {
  const hasUser = update.user_text.trim().length > 0;
  const hasResponse = update.response_text.trim().length > 0;
  switch (update.stage) {
    case "listening":
      if (hasUser || hasResponse || update.response_role !== "none"
          || update.execution_status !== "not_applicable") {
        throw new ConversationUiProtocolError("INVALID_STAGE", "listening must not claim text or execution");
      }
      return;
    case "transcribing":
      if (hasResponse || update.response_role !== "none"
          || update.execution_status !== "not_applicable") {
        throw new ConversationUiProtocolError("INVALID_STAGE", "transcribing may contain only user text");
      }
      return;
    case "thinking":
      if (!hasUser || hasResponse || update.response_role !== "none"
          || update.execution_status !== "pending") {
        throw new ConversationUiProtocolError("INVALID_STAGE", "thinking requires final user text only");
      }
      return;
    case "completed":
      if (!hasUser || !hasResponse || update.response_role === "none"
          || update.response_role === "system" || update.execution_status === "pending") {
        throw new ConversationUiProtocolError("INVALID_STAGE", "completed requires user and role response text");
      }
      return;
    case "failed":
      if (!hasResponse || update.response_role !== "system"
          || !["failed", "unknown"].includes(update.execution_status)) {
        throw new ConversationUiProtocolError("INVALID_STAGE", "failed requires a system error response");
      }
      return;
    case "cancelled":
      if (!hasResponse || update.response_role !== "system"
          || update.execution_status !== "not_applicable") {
        throw new ConversationUiProtocolError("INVALID_STAGE", "cancelled requires a system response");
      }
  }
}

const IDENTITY_KEYS = [
  "ui_protocol_version", "type", "session_id", "stream_id", "epoch", "revision",
] as const;

export function validateConversationUiMessage(value: unknown): ConversationUiMessage {
  const input = record(value);
  if (input.type === "ui.applied") {
    exactKeys(input, IDENTITY_KEYS);
    return { ...identity(input), type: "ui.applied" };
  }
  if (input.type !== "ui.update") {
    throw new ConversationUiProtocolError("INVALID_MESSAGE", "conversation UI type is invalid");
  }
  exactKeys(input, [
    ...IDENTITY_KEYS,
    "stage", "user_text", "response_text", "response_role", "execution_status",
  ]);
  const update: ConversationUiUpdate = {
    ...identity(input),
    type: "ui.update",
    stage: oneOf(input.stage, [
      "listening", "transcribing", "thinking", "completed", "failed", "cancelled",
    ], "stage"),
    user_text: boundedText(
      input.user_text, "user_text", CONVERSATION_UI_MAX_USER_CHARS, CONVERSATION_UI_MAX_USER_BYTES,
    ),
    response_text: boundedText(
      input.response_text,
      "response_text",
      CONVERSATION_UI_MAX_RESPONSE_CHARS,
      CONVERSATION_UI_MAX_RESPONSE_BYTES,
    ),
    response_role: oneOf(input.response_role, ["none", "human", "robot", "mixed", "system"], "response_role"),
    execution_status: oneOf(input.execution_status, [
      "pending", "completed", "failed", "unknown", "not_applicable",
    ], "execution_status"),
  };
  validateStage(update);
  return update;
}

export function validateConversationUiUpdate(value: unknown): ConversationUiUpdate {
  const message = validateConversationUiMessage(value);
  if (message.type !== "ui.update") {
    throw new ConversationUiProtocolError("INVALID_MESSAGE", "conversation UI update is required");
  }
  return message;
}

export function validateConversationUiApplied(value: unknown): ConversationUiApplied {
  const message = validateConversationUiMessage(value);
  if (message.type !== "ui.applied") {
    throw new ConversationUiProtocolError("INVALID_MESSAGE", "conversation UI applied ack is required");
  }
  return message;
}
