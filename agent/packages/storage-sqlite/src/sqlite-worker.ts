import { parentPort, workerData } from "node:worker_threads";

import { SynchronousSqliteAuditStore } from "./sqlite-store.ts";
import type {
  SerializedWorkerError,
  WorkerInit,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.ts";

if (parentPort === null) {
  throw new Error("sqlite-worker must run inside a Worker");
}
const port = parentPort;

function serializedError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(code === undefined ? {} : { code }),
    };
  }
  return { name: "Error", message: String(error) };
}

function assertNever(value: never): never {
  throw new Error(`unsupported SQLite worker request: ${JSON.stringify(value)}`);
}

const send = (response: WorkerResponse): void => port.postMessage(response);
const init = workerData as WorkerInit;

let store: SynchronousSqliteAuditStore | undefined;
try {
  store = new SynchronousSqliteAuditStore(init.path, init.options);
  send({ type: "ready" });
} catch (error) {
  send({ type: "init_error", error: serializedError(error) });
  port.close();
}

if (store !== undefined) {
  const auditStore = store;
  const handleRequest = async (request: WorkerRequest): Promise<void> => {
    try {
      let value: unknown;
      switch (request.operation) {
        case "saveAgentProfile":
          value = await auditStore.saveAgentProfile(...request.args);
          break;
        case "saveSession":
          value = await auditStore.saveSession(...request.args);
          break;
        case "saveRun":
          value = await auditStore.saveRun(...request.args);
          break;
        case "saveMessage":
          value = await auditStore.saveMessage(...request.args);
          break;
        case "saveToolCall":
          value = await auditStore.saveToolCall(...request.args);
          break;
        case "saveAction":
          value = await auditStore.saveAction(...request.args);
          break;
        case "saveToolResult":
          value = await auditStore.saveToolResult(...request.args);
          break;
        case "appendEvent":
          value = await auditStore.appendEvent(...request.args);
          break;
        case "writeBatch":
          value = await auditStore.writeBatch(...request.args);
          break;
        case "getSessionAgentProfile":
          value = await auditStore.getSessionAgentProfile(...request.args);
          break;
        case "getRunTrace":
          value = await auditStore.getRunTrace(...request.args);
          break;
        case "listSessionMessages":
          value = await auditStore.listSessionMessages(...request.args);
          break;
        case "listRunIdsForInteraction":
          value = await auditStore.listRunIdsForInteraction(...request.args);
          break;
        case "reconcileInterruptedRuns":
          value = auditStore.reconcileInterruptedRuns(...request.args);
          break;
        case "createMemory":
          value = await auditStore.createMemory(...request.args);
          break;
        case "createCanonicalMemory":
          value = await auditStore.createCanonicalMemory(...request.args);
          break;
        case "getMemory":
          value = await auditStore.getMemory(...request.args);
          break;
        case "updateMemory":
          value = await auditStore.updateMemory(...request.args);
          break;
        case "listMemories":
          value = await auditStore.listMemories(...request.args);
          break;
        case "searchMemories":
          value = await auditStore.searchMemories(...request.args);
          break;
        case "recallMemories":
          value = await auditStore.recallMemories(...request.args);
          break;
        case "deleteMemory":
          value = await auditStore.deleteMemory(...request.args);
          break;
        case "deleteMemoryCascade":
          value = await auditStore.deleteMemoryCascade(...request.args);
          break;
        case "getMemoryDeletionAudit":
          value = await auditStore.getMemoryDeletionAudit(...request.args);
          break;
        case "purgeExpiredMemories":
          value = await auditStore.purgeExpiredMemories(...request.args);
          break;
        case "backup":
          value = await auditStore.backup(...request.args);
          break;
        case "close":
          auditStore.close();
          value = undefined;
          break;
        default:
          value = assertNever(request);
      }
      send({ type: "result", id: request.id, value });
      if (request.operation === "close") {
        port.close();
      }
    } catch (error) {
      send({ type: "error", id: request.id, error: serializedError(error) });
    }
  };
  let requestQueue = Promise.resolve();
  port.on("message", (request: WorkerRequest) => {
    requestQueue = requestQueue.then(
      () => handleRequest(request),
      () => handleRequest(request),
    );
  });
}
