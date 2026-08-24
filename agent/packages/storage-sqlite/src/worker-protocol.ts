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

import type {
  AuditWriteBatch,
  CanonicalMemoryCreate,
  MemoryCreate,
  MemoryDeletionRequest,
  MemoryList,
  MemoryOwnerRole,
  MemoryRecall,
  MemorySearch,
  MemoryUpdate,
} from "./types.ts";
import type { SqliteAuditStoreOptions } from "./sqlite-store.ts";

export interface WorkerInit {
  readonly path: string;
  readonly options: SqliteAuditStoreOptions;
}

export interface WorkerOperationArgs {
  readonly saveAgentProfile: [AgentProfile];
  readonly saveSession: [Session];
  readonly saveRun: [Run];
  readonly saveMessage: [Message];
  readonly saveToolCall: [string, ToolCall, number];
  readonly saveAction: [Action];
  readonly saveToolResult: [string, ToolResult, number];
  readonly appendEvent: [Event];
  readonly writeBatch: [AuditWriteBatch];
  readonly getSessionAgentProfile: [string];
  readonly getRunTrace: [string];
  readonly listSessionMessages: [string];
  readonly listRunIdsForInteraction: [string];
  readonly reconcileInterruptedRuns: [number];
  readonly createMemory: [MemoryCreate];
  readonly createCanonicalMemory: [CanonicalMemoryCreate];
  readonly getMemory: [string, MemoryOwnerRole, number];
  readonly updateMemory: [MemoryUpdate];
  readonly listMemories: [MemoryList];
  readonly searchMemories: [MemorySearch];
  readonly recallMemories: [MemoryRecall];
  readonly deleteMemory: [string, MemoryOwnerRole];
  readonly deleteMemoryCascade: [MemoryDeletionRequest];
  readonly getMemoryDeletionAudit: [string, MemoryOwnerRole];
  readonly purgeExpiredMemories: [number, number];
  readonly backup: [string];
  readonly close: [];
}

export type WorkerOperation = keyof WorkerOperationArgs;

export type WorkerRequest = {
  readonly [Operation in WorkerOperation]: {
    readonly id: number;
    readonly operation: Operation;
    readonly args: WorkerOperationArgs[Operation];
  };
}[WorkerOperation];

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
