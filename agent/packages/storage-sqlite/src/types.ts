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
}
