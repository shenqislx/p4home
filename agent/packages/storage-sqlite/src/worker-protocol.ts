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

import type { AuditWriteBatch } from "./types.ts";
import type { SqliteAuditStoreOptions } from "./sqlite-store.ts";

export interface WorkerInit {
  readonly path: string;
  readonly options: SqliteAuditStoreOptions;
}

export type WorkerRequest =
  | { readonly id: number; readonly operation: "saveAgentProfile"; readonly args: [AgentProfile] }
  | { readonly id: number; readonly operation: "saveSession"; readonly args: [Session] }
  | { readonly id: number; readonly operation: "saveRun"; readonly args: [Run] }
  | { readonly id: number; readonly operation: "saveMessage"; readonly args: [Message] }
  | { readonly id: number; readonly operation: "saveToolCall"; readonly args: [string, ToolCall, number] }
  | { readonly id: number; readonly operation: "saveAction"; readonly args: [Action] }
  | { readonly id: number; readonly operation: "saveToolResult"; readonly args: [string, ToolResult, number] }
  | { readonly id: number; readonly operation: "appendEvent"; readonly args: [Event] }
  | { readonly id: number; readonly operation: "writeBatch"; readonly args: [AuditWriteBatch] }
  | { readonly id: number; readonly operation: "getSessionAgentProfile"; readonly args: [string] }
  | { readonly id: number; readonly operation: "getRunTrace"; readonly args: [string] }
  | { readonly id: number; readonly operation: "listSessionMessages"; readonly args: [string] }
  | { readonly id: number; readonly operation: "listRunIdsForInteraction"; readonly args: [string] }
  | { readonly id: number; readonly operation: "reconcileInterruptedRuns"; readonly args: [number] }
  | { readonly id: number; readonly operation: "close"; readonly args: [] };

export interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

export type WorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "init_error"; readonly error: SerializedWorkerError }
  | { readonly type: "result"; readonly id: number; readonly value: unknown }
  | { readonly type: "error"; readonly id: number; readonly error: SerializedWorkerError };
