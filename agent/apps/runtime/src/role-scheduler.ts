import type { RoleId } from "./role-contracts.ts";

export type RoleSchedulerErrorCode = "QUEUE_FULL" | "CANCELLED" | "CLOSED";

export class RoleSchedulerError extends Error {
  public readonly code: RoleSchedulerErrorCode;

  public constructor(code: RoleSchedulerErrorCode, message: string) {
    super(message);
    this.name = "RoleSchedulerError";
    this.code = code;
  }
}

export interface RoleScheduledTask<T> {
  readonly role_id: RoleId;
  readonly signal?: AbortSignal;
  readonly execute: () => Promise<T>;
}

interface PendingTask<T = unknown> extends RoleScheduledTask<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

export class RoleScheduler {
  readonly #capacity: number;
  readonly #queues: Record<RoleId, PendingTask[]> = {
    robot: [],
    human: [],
    cat: [],
  };
  #running = false;
  #closed = false;
  #lastUserRole: "robot" | "human" = "human";

  public constructor(capacity = 16) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_024) {
      throw new RangeError("scheduler capacity must be an integer between 1 and 1024");
    }
    this.#capacity = capacity;
  }

  public get pending(): number {
    return this.#queues.robot.length + this.#queues.human.length + this.#queues.cat.length;
  }

  public schedule<T>(task: RoleScheduledTask<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new RoleSchedulerError("CLOSED", "role scheduler is closed"));
    }
    if (task.signal?.aborted === true) {
      return Promise.reject(new RoleSchedulerError("CANCELLED", "role task was already cancelled"));
    }
    if (task.role_id !== "robot" && task.role_id !== "human" && task.role_id !== "cat") {
      return Promise.reject(new TypeError("role task has an invalid role_id"));
    }
    if (this.pending >= this.#capacity) {
      return Promise.reject(new RoleSchedulerError("QUEUE_FULL", "role scheduler queue is full"));
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask<T> = {
        ...task,
        resolve,
        reject,
        onAbort: () => {
          const queue = this.#queues[task.role_id];
          const index = queue.indexOf(pending as PendingTask);
          if (index >= 0) {
            queue.splice(index, 1);
            reject(new RoleSchedulerError("CANCELLED", "queued role task was cancelled"));
          }
        },
      };
      task.signal?.addEventListener("abort", pending.onAbort, { once: true });
      this.#queues[task.role_id].push(pending as PendingTask);
      this.#drain();
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const queue of Object.values(this.#queues)) {
      for (const task of queue.splice(0)) {
        task.signal?.removeEventListener("abort", task.onAbort);
        task.reject(new RoleSchedulerError("CLOSED", "role scheduler closed before task start"));
      }
    }
  }

  #next(): PendingTask | undefined {
    const preferred = this.#lastUserRole === "human" ? "robot" : "human";
    const alternate = preferred === "robot" ? "human" : "robot";
    let role: RoleId | undefined;
    if (this.#queues[preferred].length > 0) {
      role = preferred;
    } else if (this.#queues[alternate].length > 0) {
      role = alternate;
    } else if (this.#queues.cat.length > 0) {
      role = "cat";
    }
    if (role === undefined) {
      return undefined;
    }
    if (role === "human" || role === "robot") {
      this.#lastUserRole = role;
    }
    return this.#queues[role].shift();
  }

  #drain(): void {
    if (this.#running) {
      return;
    }
    const task = this.#next();
    if (task === undefined) {
      return;
    }
    this.#running = true;
    task.signal?.removeEventListener("abort", task.onAbort);
    void Promise.resolve().then(task.execute).then(task.resolve, task.reject).finally(() => {
      this.#running = false;
      this.#drain();
    });
  }
}
