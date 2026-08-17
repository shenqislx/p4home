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
  RunAuditTrace,
} from "./types.ts";
import type {
  SerializedWorkerError,
  WorkerInit,
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

export class SqliteAuditStore implements AuditStore, Disposable, AsyncDisposable {
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closing: Promise<void> | undefined;
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
      if (!this.#closed) {
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

  public close(): void {
    void this.closeAsync().catch(() => undefined);
  }

  public async closeAsync(): Promise<void> {
    if (this.#closing !== undefined) {
      return await this.#closing;
    }
    this.#closed = true;
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

  async #request(
    operation: WorkerRequest["operation"],
    args: WorkerRequest["args"],
  ): Promise<unknown> {
    this.#assertOpen();
    await this.#ready;
    this.#assertOpen();
    return await this.#requestAfterReady(operation, args);
  }

  async #requestAfterReady(
    operation: WorkerRequest["operation"],
    args: WorkerRequest["args"],
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    // Public methods establish the operation/argument tuple correlation; the
    // generic transport intentionally erases it after that boundary.
    this.#worker.postMessage({ id, operation, args } as WorkerRequest);
    return await result;
  }

  #onMessage(response: WorkerResponse): void {
    if (response.type === "ready") {
      this.#readyResolve();
      return;
    }
    if (response.type === "init_error") {
      this.#readyReject(workerError(response.error));
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
    this.#readyReject(error);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AuditStorageError("audit store is closed");
    }
  }
}
