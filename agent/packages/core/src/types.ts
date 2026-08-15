export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type ActionStatus = "requested" | "accepted" | "started" | "completed" | "failed";

export interface AgentProfile {
  readonly agent_profile_id: string;
  readonly name: string;
  readonly locale: "zh-CN";
  readonly allowed_tools: readonly string[];
}

export interface Session {
  readonly session_id: string;
  readonly agent_profile_id: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface Run {
  readonly run_id: string;
  readonly session_id: string;
  readonly status: RunStatus;
  readonly started_at_ms: number;
  readonly completed_at_ms: number | null;
}

export interface ToolCall {
  readonly tool_call_id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface Action {
  readonly action_id: string;
  readonly run_id: string;
  readonly tool_call_id: string;
  readonly status: ActionStatus;
  readonly created_at_ms: number;
}

export interface Event {
  readonly event_id: string;
  readonly run_id: string;
  readonly type: string;
  readonly occurred_at_ms: number;
  readonly payload: Record<string, unknown>;
}

export type ToolErrorCode =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_TOOL"
  | "UNKNOWN_ROOM"
  | "DEVICE_OFFLINE"
  | "QUEUE_FULL"
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "DEVICE_BUSY"
  | "ACTION_ID_CONFLICT"
  | "INTERNAL";

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface ToolSuccessResult {
  readonly schema_version: 1;
  readonly tool_call_id: string;
  readonly name: string;
  readonly status: "success";
  readonly result: Record<string, unknown>;
  readonly error: null;
}

export interface ToolFailureResult {
  readonly schema_version: 1;
  readonly tool_call_id: string;
  readonly name: string;
  readonly status: "error";
  readonly result: null;
  readonly error: ToolError;
}

export type ToolResult = ToolSuccessResult | ToolFailureResult;

export interface ToolExecutionContext {
  readonly run_id: string;
  readonly tool_call_id: string;
  readonly signal: AbortSignal;
}

export interface ToolDefinition {
  readonly name: string;
  execute(
    argumentsValue: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<Record<string, unknown>>;
}

export interface ToolLoopResult {
  readonly status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "timed_out">;
  readonly results: readonly ToolResult[];
}
