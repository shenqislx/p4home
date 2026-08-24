import { Worker } from "node:worker_threads";

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

import {
  AuditStorageError,
  type AuditRecoveryReport,
  type SqliteAuditStoreOptions,
} from "./sqlite-store.ts";
import type {
  AuditStore,
  AuditWriteBatch,
  CanonicalMemoryCreate,
  MemoryCreate,
  MemoryDeletionRequest,
  MemoryDeletionResult,
  MemoryList,
  MemoryListPage,
  MemoryOwnerRole,
  MemoryRecall,
  MemoryRecallResult,
  MemoryRecord,
  MemorySearch,
  MemoryStore,
  MemoryUpdate,
  RunAuditTrace,
} from "./types.ts";
import type {
  SerializedWorkerError,
  WorkerInit,
  WorkerOperation,
  WorkerOperationArgs,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.ts";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function workerError(error: SerializedWorkerError): AuditStorageError {
  const wrapped = new AuditStorageError(error.message);
  wrapped.name = error.name === "Error" ? "AuditStorageError" : error.name;
  if (error.stack !== undefined) {
    wrapped.stack = `${wrapped.stack ?? wrapped.message}\nWorker stack:\n${error.stack}`;
  }
  if (error.code !== undefined) {
    Object.defineProperty(wrapped, "code", { value: error.code, enumerable: true });
  }
  return wrapped;
}

export class SqliteAuditStore
implements AuditStore, MemoryStore, Disposable, AsyncDisposable {
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closing: Promise<void> | undefined;
  #failure: Error | undefined;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;

  public constructor(path: string, options: SqliteAuditStoreOptions = {}) {
    const timeoutMs = options.timeout_ms ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
      throw new RangeError("timeout_ms must be an integer between 0 and 120000");
    }
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const init: WorkerInit = { path, options };
    this.#worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url), {
      workerData: init,
    });
    this.#worker.on("message", (response: WorkerResponse) => this.#onMessage(response));
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed && this.#failure === undefined) {
        this.#fail(new AuditStorageError(`SQLite worker exited with code ${code}`));
      }
    });
  }

  public async saveAgentProfile(profile: AgentProfile): Promise<void> {
    await this.#request("saveAgentProfile", [profile]);
  }

  public async saveSession(session: Session): Promise<void> {
    await this.#request("saveSession", [session]);
  }

  public async saveRun(run: Run): Promise<void> {
    await this.#request("saveRun", [run]);
  }

  public async saveMessage(message: Message): Promise<void> {
    await this.#request("saveMessage", [message]);
  }

  public async saveToolCall(runId: string, call: ToolCall, createdAtMs: number): Promise<void> {
    await this.#request("saveToolCall", [runId, call, createdAtMs]);
  }

  public async saveAction(action: Action): Promise<void> {
    await this.#request("saveAction", [action]);
  }

  public async saveToolResult(runId: string, result: ToolResult, completedAtMs: number): Promise<void> {
    await this.#request("saveToolResult", [runId, result, completedAtMs]);
  }

  public async appendEvent(event: Event): Promise<void> {
    await this.#request("appendEvent", [event]);
  }

  public async writeBatch(batch: AuditWriteBatch): Promise<void> {
    await this.#request("writeBatch", [batch]);
  }

  public async getSessionAgentProfile(sessionId: string): Promise<AgentProfile | null> {
    return await this.#request("getSessionAgentProfile", [sessionId]) as AgentProfile | null;
  }

  public async getRunTrace(runId: string): Promise<RunAuditTrace | null> {
    return await this.#request("getRunTrace", [runId]) as RunAuditTrace | null;
  }

  public async listSessionMessages(sessionId: string): Promise<readonly Message[]> {
    return await this.#request("listSessionMessages", [sessionId]) as readonly Message[];
  }

  public async listRunIdsForInteraction(interactionId: string): Promise<readonly string[]> {
    return await this.#request("listRunIdsForInteraction", [interactionId]) as readonly string[];
  }

  public async reconcileInterruptedRuns(recoveredAtMs = Date.now()): Promise<AuditRecoveryReport> {
    return await this.#request("reconcileInterruptedRuns", [recoveredAtMs]) as AuditRecoveryReport;
  }

  public async createMemory(memory: MemoryCreate): Promise<MemoryRecord> {
    return await this.#request("createMemory", [memory]) as MemoryRecord;
  }

  public async createCanonicalMemory(memory: CanonicalMemoryCreate): Promise<MemoryRecord> {
    return await this.#request("createCanonicalMemory", [memory]) as MemoryRecord;
  }

  public async getMemory(
    memoryId: string,
    requesterRole: MemoryOwnerRole,
    nowMs = Date.now(),
  ): Promise<MemoryRecord | null> {
    return await this.#request(
      "getMemory",
      [memoryId, requesterRole, nowMs],
    ) as MemoryRecord | null;
  }

  public async updateMemory(update: MemoryUpdate): Promise<MemoryRecord> {
    return await this.#request("updateMemory", [update]) as MemoryRecord;
  }

  public async listMemories(query: MemoryList): Promise<MemoryListPage> {
    return await this.#request("listMemories", [query]) as MemoryListPage;
  }

  public async searchMemories(query: MemorySearch): Promise<MemoryListPage> {
    return await this.#request("searchMemories", [query]) as MemoryListPage;
  }

  public async recallMemories(query: MemoryRecall): Promise<MemoryRecallResult> {
    return await this.#request("recallMemories", [query]) as MemoryRecallResult;
  }

  public async deleteMemory(
    memoryId: string,
    requesterRole: MemoryOwnerRole,
  ): Promise<boolean> {
    return await this.#request("deleteMemory", [memoryId, requesterRole]) as boolean;
  }

  public async deleteMemoryCascade(
    request: MemoryDeletionRequest,
  ): Promise<MemoryDeletionResult> {
    return await this.#request("deleteMemoryCascade", [request]) as MemoryDeletionResult;
  }

  public async getMemoryDeletionAudit(
    requestId: string,
    requesterRole: MemoryOwnerRole,
  ): Promise<MemoryDeletionResult | null> {
    return await this.#request(
      "getMemoryDeletionAudit",
      [requestId, requesterRole],
    ) as MemoryDeletionResult | null;
  }

  public async purgeExpiredMemories(
    nowMs = Date.now(),
    limit = 1_000,
  ): Promise<number> {
    return await this.#request("purgeExpiredMemories", [nowMs, limit]) as number;
  }

  public close(): void {
    void this.closeAsync().catch(() => undefined);
  }

  public async closeAsync(): Promise<void> {
    if (this.#closing !== undefined) {
      return await this.#closing;
    }
    this.#closed = true;
    if (this.#failure !== undefined) {
      this.#closing = this.#worker.terminate().then(() => undefined);
      return await this.#closing;
    }
    this.#closing = this.#ready.then(
      async () => {
        try {
          await this.#requestAfterReady("close", []);
        } finally {
          await this.#worker.terminate();
        }
      },
      async () => {
        await this.#worker.terminate();
      },
    );
    return await this.#closing;
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.closeAsync();
  }

  async #request<Operation extends WorkerOperation>(
    operation: Operation,
    args: WorkerOperationArgs[Operation],
  ): Promise<unknown> {
    this.#assertOpen();
    await this.#ready;
    return await this.#requestAfterReady(operation, args);
  }

  async #requestAfterReady<Operation extends WorkerOperation>(
    operation: Operation,
    args: WorkerOperationArgs[Operation],
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      this.#worker.postMessage({ id, operation, args } as WorkerRequest);
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return await result;
  }

  #onMessage(response: WorkerResponse): void {
    if (response.type === "ready") {
      this.#readyResolve();
      return;
    }
    if (response.type === "init_error") {
      const error = workerError(response.error);
      this.#failure = error;
      this.#readyReject(error);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.id);
    if (response.type === "error") {
      pending.reject(workerError(response.error));
    } else {
      pending.resolve(response.value);
    }
  }

  #fail(error: Error): void {
    const failure = this.#failure ?? error;
    this.#failure = failure;
    this.#readyReject(failure);
    for (const pending of this.#pending.values()) {
      pending.reject(failure);
    }
    this.#pending.clear();
  }

  #assertOpen(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#closed) {
      throw new AuditStorageError("audit store is closed");
    }
  }
}
