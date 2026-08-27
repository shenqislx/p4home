const MAX_CAT_RUNS = 1_024;
const CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LowPriorityCatRunLease {
  readonly run_id: string;
  readonly signal: AbortSignal;
  release(): void;
}

interface CatRunEntry {
  readonly controller: AbortController;
  readonly detachUpstream: () => void;
}

/**
 * Owns cancellation for low-priority Cat work. Cat runners consume the lease
 * signal; a voice capture fence calls cancelAll before the new interaction runs.
 */
export class LowPriorityCatRunRegistry {
  readonly #capacity: number;
  readonly #active = new Map<string, CatRunEntry>();
  #closed = false;

  public constructor(capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAT_RUNS) {
      throw new RangeError("Cat cancellation registry capacity must be between 1 and 1024");
    }
    this.#capacity = capacity;
  }

  public begin(runId: string, upstreamSignal?: AbortSignal): LowPriorityCatRunLease {
    if (this.#closed) throw new TypeError("Cat cancellation registry is closed");
    if (!CONTRACT_ID.test(runId)) throw new TypeError("Cat run_id is invalid");
    if (this.#active.has(runId)) throw new TypeError("Cat run_id is already active");
    if (this.#active.size >= this.#capacity) throw new RangeError("Cat cancellation registry is full");
    const controller = new AbortController();
    const onUpstreamAbort = (): void => controller.abort(upstreamSignal?.reason);
    upstreamSignal?.addEventListener("abort", onUpstreamAbort, { once: true });
    if (upstreamSignal?.aborted === true) onUpstreamAbort();
    const detachUpstream = (): void => upstreamSignal?.removeEventListener("abort", onUpstreamAbort);
    const entry = { controller, detachUpstream };
    this.#active.set(runId, entry);
    let released = false;
    return {
      run_id: runId,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        if (this.#active.get(runId) === entry) this.#active.delete(runId);
        detachUpstream();
      },
    };
  }

  public cancelAll(
    reason: "barge_in" | "user_interaction" | "autonomy_paused" | "autonomy_disabled" | "shutdown",
  ): number {
    let cancelled = 0;
    for (const entry of this.#active.values()) {
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort(new DOMException(reason, "AbortError"));
      cancelled++;
    }
    return cancelled;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cancelAll("shutdown");
  }

  public get active_count(): number {
    return this.#active.size;
  }
}

/** Shared process registry used by every Cat product entrypoint and voice assembly. */
export const defaultLowPriorityCatRunRegistry = new LowPriorityCatRunRegistry();
