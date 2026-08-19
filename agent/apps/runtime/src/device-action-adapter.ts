import type { RoomId } from "@p4home/domain-p4home";

import {
  decodeDeviceMessage,
  encodeDeviceMessage,
  payloadOf,
  type ActionAcceptedPayload,
  type ActionCompletedPayload,
  type ActionFailedPayload,
  type ActionRequestPayload,
  type ActionStartedPayload,
  type DeviceActionError,
  type DeviceActionOrigin,
  type DeviceMessage,
  type DeviceToolName,
  type WorldSnapshotPayload,
} from "./device-protocol.ts";

export interface DeviceWebSocketConnection {
  readonly is_open: boolean;
  send(frame: string): Promise<void>;
  close(code: number, reason: string): void;
  onFrame(listener: (frame: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

export type DeviceAdapterActionStatus =
  | "requested"
  | "accepted"
  | "started"
  | "completed"
  | "failed"
  | "unknown";

export type DeviceActionOutcome =
  | Readonly<{
      status: "completed";
      action_id: string;
      tool: DeviceToolName;
      state_version: number;
      result: Record<string, unknown>;
      source: "lifecycle";
    }>
  | Readonly<{
      status: "failed";
      action_id: string;
      error: DeviceActionError;
    }>
  | Readonly<{
      status: "unknown";
      action_id: string;
      reason: "wait_timeout" | "disconnected" | "send_failed";
      replay_allowed: false;
      reconciliation: DeviceActionReconciliation | null;
    }>;

export interface DeviceActionReconciliation {
  readonly status: "state_satisfied" | "state_not_satisfied" | "not_observable";
  readonly snapshot_id: string;
  readonly state_version: number;
  readonly observed_at_ms: number;
}

export interface DeviceActionSpec {
  readonly action_id: string;
  readonly tool: DeviceToolName;
  readonly arguments: Record<string, unknown>;
  readonly timeout_ms: number;
  readonly origin?: DeviceActionOrigin;
  readonly wait_timeout_ms?: number;
  readonly signal?: AbortSignal;
}

export interface DeviceAdapterActionRecord {
  readonly request: ActionRequestPayload;
  readonly status: DeviceAdapterActionStatus;
  readonly baseline_state_version: number;
  readonly outcome: DeviceActionOutcome | null;
  readonly timing: Readonly<{
    accepted_latency_ms: number | null;
    started_latency_ms: number | null;
    terminal_latency_ms: number | null;
  }>;
}

export type DeviceActionAdapterErrorCode =
  | "NOT_READY"
  | "WAITER_CAPACITY_EXCEEDED"
  | "ACTION_RECORD_CAPACITY_EXCEEDED"
  | "ACTION_ID_CONFLICT"
  | "ACTION_NOT_FOUND"
  | "RECONCILIATION_REQUIRED";

export class DeviceActionAdapterError extends Error {
  public readonly code: DeviceActionAdapterErrorCode;

  public constructor(code: DeviceActionAdapterErrorCode, message: string) {
    super(message);
    this.name = "DeviceActionAdapterError";
    this.code = code;
  }
}

export interface DeviceActionAdapterOptions {
  readonly device_id: string;
  readonly now?: () => number;
  readonly monotonic_now?: () => number;
  readonly waiter_capacity?: number;
  readonly action_record_capacity?: number;
  readonly action_record_retention_ms?: number;
}

interface MutableActionRecord {
  readonly request: ActionRequestPayload;
  readonly fingerprint: string;
  readonly baselineStateVersion: number;
  terminalAtMonotonicMs: number | null;
  readonly requestedAtMonotonicMs: number;
  acceptedAtMonotonicMs: number | null;
  startedAtMonotonicMs: number | null;
  status: DeviceAdapterActionStatus;
  outcome: DeviceActionOutcome | null;
}

interface ActionWaiter {
  readonly promise: Promise<DeviceActionOutcome>;
  readonly resolve: (outcome: DeviceActionOutcome) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface ReconciliationWaiter {
  readonly resolve: (outcome: DeviceActionOutcome) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function fingerprint(request: ActionRequestPayload): string {
  return JSON.stringify(canonicalize({
    tool: request.tool,
    arguments: request.arguments,
  }));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export class DeviceWebSocketActionAdapter {
  readonly #connection: DeviceWebSocketConnection;
  readonly #deviceId: string;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #waiterCapacity: number;
  readonly #recordCapacity: number;
  readonly #recordRetentionMs: number;
  readonly #records = new Map<string, MutableActionRecord>();
  readonly #waiters = new Map<string, ActionWaiter>();
  readonly #reconciliationWaiters = new Map<string, ReconciliationWaiter>();
  #sessionId: string | null = null;
  #nextOutgoingSeq = 0;
  #nextIncomingSeq: number | null = null;
  #messageCounter = 0;
  #hasCapabilities = false;
  #ready = false;
  #resyncInFlight = false;
  #resyncRequestId: string | null = null;
  #lastSnapshot: WorldSnapshotPayload | null = null;
  #lastProtocolError: Error | null = null;

  public constructor(connection: DeviceWebSocketConnection, options: DeviceActionAdapterOptions) {
    if (!Number.isInteger(options.waiter_capacity ?? 16) || (options.waiter_capacity ?? 16) < 1) {
      throw new RangeError("waiter_capacity must be a positive integer");
    }
    this.#connection = connection;
    this.#deviceId = options.device_id;
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonic_now ?? (() => performance.now());
    this.#waiterCapacity = options.waiter_capacity ?? 16;
    this.#recordCapacity = options.action_record_capacity ?? 4_096;
    this.#recordRetentionMs = options.action_record_retention_ms ?? 600_000;
    if (!Number.isInteger(this.#recordCapacity) || this.#recordCapacity < 1) {
      throw new RangeError("action_record_capacity must be a positive integer");
    }
    if (!Number.isInteger(this.#recordRetentionMs) || this.#recordRetentionMs < 1) {
      throw new RangeError("action_record_retention_ms must be a positive integer");
    }
    connection.onFrame((frame) => this.#receiveFrame(frame));
    connection.onClose(() => this.#handleDisconnect());
  }

  public get is_ready(): boolean {
    return this.#ready && this.#connection.is_open;
  }

  public get pending_waiters(): number {
    return this.#waiters.size;
  }

  public get last_snapshot(): WorldSnapshotPayload | null {
    return this.#lastSnapshot === null ? null : structuredClone(this.#lastSnapshot);
  }

  public get last_protocol_error(): Error | null {
    return this.#lastProtocolError;
  }

  public getAction(actionId: string): DeviceAdapterActionRecord | undefined {
    this.#pruneRecords();
    const record = this.#records.get(actionId);
    if (record === undefined) {
      return undefined;
    }
    return {
      request: structuredClone(record.request),
      status: record.status,
      baseline_state_version: record.baselineStateVersion,
      outcome: record.outcome === null ? null : structuredClone(record.outcome),
      timing: {
        accepted_latency_ms: record.acceptedAtMonotonicMs === null
          ? null
          : record.acceptedAtMonotonicMs - record.requestedAtMonotonicMs,
        started_latency_ms: record.startedAtMonotonicMs === null
          ? null
          : record.startedAtMonotonicMs - record.requestedAtMonotonicMs,
        terminal_latency_ms: record.terminalAtMonotonicMs === null
          ? null
          : record.terminalAtMonotonicMs - record.requestedAtMonotonicMs,
      },
    };
  }

  public async executeAction(spec: DeviceActionSpec): Promise<DeviceActionOutcome> {
    if (spec.signal?.aborted === true) {
      return {
        status: "failed",
        action_id: spec.action_id,
        error: {
          code: "CANCELLED",
          message: "device action was cancelled before dispatch",
          retryable: false,
        },
      };
    }
    if (!this.is_ready || this.#sessionId === null || this.#lastSnapshot === null) {
      throw new DeviceActionAdapterError("NOT_READY", "device handshake is not complete");
    }
    this.#pruneRecords();
    const request: ActionRequestPayload = {
      action_id: spec.action_id,
      tool: spec.tool,
      arguments: structuredClone(spec.arguments),
      timeout_ms: spec.timeout_ms,
      origin: spec.origin ?? "agent",
    };
    this.#validateOutbound("action.request", request);
    const requestFingerprint = fingerprint(request);
    const existing = this.#records.get(spec.action_id);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new DeviceActionAdapterError(
          "ACTION_ID_CONFLICT",
          `action_id ${spec.action_id} was already used with a different request`,
        );
      }
      if (existing.outcome !== null) {
        return structuredClone(existing.outcome);
      }
      const existingWaiter = this.#waiters.get(spec.action_id);
      if (existingWaiter !== undefined) {
        return existingWaiter.promise;
      }
    }
    const waitTimeoutMs = spec.wait_timeout_ms ?? spec.timeout_ms + 1_000;
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1) {
      throw new RangeError("wait_timeout_ms must be a positive integer");
    }
    if (this.#waiters.size >= this.#waiterCapacity) {
      throw new DeviceActionAdapterError(
        "WAITER_CAPACITY_EXCEEDED",
        "device action waiter capacity is exhausted",
      );
    }
    while (
      existing === undefined
      && this.#records.size >= this.#recordCapacity
      && this.#evictOldestTerminalRecord()
    ) {
      // Keep evicting completed/failed records until one slot is available.
    }
    if (existing === undefined && this.#records.size >= this.#recordCapacity) {
      throw new DeviceActionAdapterError(
        "ACTION_RECORD_CAPACITY_EXCEEDED",
        "device action record capacity is exhausted",
      );
    }
    const record: MutableActionRecord = existing ?? {
      request,
      fingerprint: requestFingerprint,
      baselineStateVersion: this.#lastSnapshot.state_version,
      terminalAtMonotonicMs: null,
      requestedAtMonotonicMs: this.#monotonicNow(),
      acceptedAtMonotonicMs: null,
      startedAtMonotonicMs: null,
      status: "requested",
      outcome: null,
    };
    this.#records.set(spec.action_id, record);

    let resolveWaiter!: (outcome: DeviceActionOutcome) => void;
    const promise = new Promise<DeviceActionOutcome>((resolve) => {
      resolveWaiter = resolve;
    });
    const onAbort = spec.signal === undefined
      ? undefined
      : () => {
          void this.cancelAction(spec.action_id, "caller aborted").catch(() => undefined);
        };
    const timer = setTimeout(() => {
      this.#finish(spec.action_id, {
        status: "unknown",
        action_id: spec.action_id,
        reason: "wait_timeout",
        replay_allowed: false,
        reconciliation: null,
      });
    }, waitTimeoutMs);
    timer.unref();
    const waiter: ActionWaiter = {
      promise,
      resolve: resolveWaiter,
      timer,
      signal: spec.signal,
      onAbort,
    };
    this.#waiters.set(spec.action_id, waiter);
    spec.signal?.addEventListener("abort", onAbort!, { once: true });

    try {
      await this.#send("action.request", request);
    } catch (error) {
      this.#lastProtocolError = error instanceof Error ? error : new Error(String(error));
      this.#finish(spec.action_id, {
        status: "unknown",
        action_id: spec.action_id,
        reason: "send_failed",
        replay_allowed: false,
        reconciliation: null,
      });
      this.#connection.close(1011, "device send failed");
    }
    return promise;
  }

  public async cancelAction(actionId: string, reason: string): Promise<void> {
    if (!this.#records.has(actionId)) {
      throw new DeviceActionAdapterError("ACTION_NOT_FOUND", `unknown action_id ${actionId}`);
    }
    try {
      await this.#send("action.cancel", { action_id: actionId, reason });
    } catch (error) {
      this.#closeAfterSendFailure(error);
      throw error;
    }
  }

  public async waitForReconciliation(
    actionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<DeviceActionOutcome> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("reconciliation timeout must be a positive integer");
    }
    const record = this.#records.get(actionId);
    if (record?.outcome === null || record === undefined) {
      throw new DeviceActionAdapterError("ACTION_NOT_FOUND", `unknown action_id ${actionId}`);
    }
    if (record.outcome.status !== "unknown" || record.outcome.reconciliation !== null) {
      return structuredClone(record.outcome);
    }
    const existing = this.#reconciliationWaiters.get(actionId);
    if (existing !== undefined) {
      throw new DeviceActionAdapterError(
        "RECONCILIATION_REQUIRED",
        `action_id ${actionId} already has a reconciliation waiter`,
      );
    }
    return await new Promise<DeviceActionOutcome>((resolve) => {
      const finish = (): void => {
        const current = this.#records.get(actionId)?.outcome;
        if (current !== null && current !== undefined) {
          resolve(structuredClone(current));
        }
      };
      const timer = setTimeout(() => {
        this.#reconciliationWaiters.delete(actionId);
        signal?.removeEventListener("abort", onAbort);
        finish();
      }, timeoutMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.#reconciliationWaiters.delete(actionId);
        finish();
      };
      this.#reconciliationWaiters.set(actionId, { resolve, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }
    });
  }

  /**
   * Explicit at-least-once redelivery for a known action. Unknown outcomes are
   * deliberately blocked even after snapshot evidence is available, because v1
   * snapshots do not prove which action produced the observed state.
   */
  public async redeliverAction(actionId: string): Promise<void> {
    this.#pruneRecords();
    const record = this.#records.get(actionId);
    if (record === undefined) {
      throw new DeviceActionAdapterError("ACTION_NOT_FOUND", `unknown action_id ${actionId}`);
    }
    if (record.status === "unknown") {
      throw new DeviceActionAdapterError(
        "RECONCILIATION_REQUIRED",
        `action_id ${actionId} must be reconciled from a snapshot before redelivery`,
      );
    }
    try {
      await this.#send("action.request", record.request);
    } catch (error) {
      this.#closeAfterSendFailure(error);
      throw error;
    }
  }

  #allocateMessageId(): string {
    return `agent-message-${this.#messageCounter++}`;
  }

  #validateOutbound(
    type: DeviceMessage["type"],
    payload: Record<string, unknown>,
  ): void {
    if (!this.#connection.is_open || this.#sessionId === null) {
      throw new DeviceActionAdapterError("NOT_READY", "device connection is not open");
    }
    encodeDeviceMessage({
      protocol_version: 1,
      message_id: `agent-validation-${this.#messageCounter}`,
      correlation_id: null,
      device_id: this.#deviceId,
      session_id: this.#sessionId,
      seq: this.#nextOutgoingSeq,
      sent_at_ms: this.#now(),
      type,
      payload,
    });
  }

  async #send(
    type: DeviceMessage["type"],
    payload: Record<string, unknown>,
    preparedMessageId?: string,
  ): Promise<void> {
    if (!this.#connection.is_open || this.#sessionId === null) {
      throw new DeviceActionAdapterError("NOT_READY", "device connection is not open");
    }
    const seq = this.#nextOutgoingSeq;
    const message: DeviceMessage = {
      protocol_version: 1,
      message_id: preparedMessageId ?? this.#allocateMessageId(),
      correlation_id: null,
      device_id: this.#deviceId,
      session_id: this.#sessionId,
      seq,
      sent_at_ms: this.#now(),
      type,
      payload,
    };
    // Local validation must succeed before the sender sequence is committed.
    const frame = encodeDeviceMessage(message);
    this.#nextOutgoingSeq = seq + 1;
    try {
      await this.#connection.send(frame);
    } catch (error) {
      // Delivery may be ambiguous after send() starts. Require a new handshake
      // instead of issuing another frame with a potentially gapped sequence.
      this.#ready = false;
      throw error;
    }
  }

  #receiveFrame(frame: string): void {
    try {
      const message = decodeDeviceMessage(frame);
      this.#applyMessage(message);
    } catch (error) {
      this.#lastProtocolError = error instanceof Error ? error : new Error(String(error));
      this.#ready = false;
      this.#connection.close(1002, "device protocol violation");
    }
  }

  #applyMessage(message: DeviceMessage): void {
    if (message.device_id !== this.#deviceId) {
      throw new TypeError("device message does not match the authenticated device_id");
    }
    if (message.type === "device.hello") {
      if (this.#sessionId !== null) {
        throw new TypeError("device.hello cannot reset a live transport session in-band");
      }
      if (message.seq !== 0) {
        throw new TypeError("device.hello must reset the device sequence to zero");
      }
      this.#sessionId = message.session_id;
      this.#nextIncomingSeq = message.seq + 1;
      this.#nextOutgoingSeq = 0;
      this.#hasCapabilities = false;
      this.#ready = false;
      this.#resyncInFlight = false;
      this.#resyncRequestId = null;
      return;
    }
    if (this.#sessionId === null || message.session_id !== this.#sessionId) {
      throw new TypeError("device message session_id does not match the current session");
    }
    if (this.#nextIncomingSeq === null || message.seq < this.#nextIncomingSeq) {
      throw new TypeError("device message sequence regressed");
    }
    if (message.seq > this.#nextIncomingSeq) {
      this.#nextIncomingSeq = message.seq + 1;
      this.#beginResync("seq_gap");
      return;
    }
    this.#nextIncomingSeq += 1;

    if (message.type === "device.capabilities") {
      this.#hasCapabilities = true;
      return;
    }
    if (message.type === "world.snapshot") {
      const snapshot = payloadOf<WorldSnapshotPayload & Record<string, unknown>>(message);
      if (
        this.#resyncInFlight
        && (
          snapshot.reason !== "resync"
          || message.correlation_id !== this.#resyncRequestId
        )
      ) {
        return;
      }
      this.#lastSnapshot = structuredClone(snapshot);
      this.#ready = this.#hasCapabilities;
      this.#resyncInFlight = false;
      this.#resyncRequestId = null;
      this.#reconcileUnknownActions(snapshot);
      return;
    }
    if (message.type === "world.changed") {
      if (this.#resyncInFlight) {
        return;
      }
      const changed = payloadOf<Record<string, unknown>>(message);
      if (
        this.#lastSnapshot !== null
        && typeof changed.state_version === "number"
        && changed.state_version === this.#lastSnapshot.state_version + 1
      ) {
        this.#lastSnapshot = {
          snapshot_id: this.#lastSnapshot.snapshot_id,
          reason: this.#lastSnapshot.reason,
          state_version: changed.state_version,
          observed_at_ms: Number(changed.observed_at_ms),
          character: changed.character as WorldSnapshotPayload["character"],
        };
      } else {
        this.#beginResync("state_version_gap");
      }
      return;
    }
    if (message.type === "action.accepted") {
      this.#setLifecycle(payloadOf<ActionAcceptedPayload & Record<string, unknown>>(message).action_id, "accepted");
      return;
    }
    if (message.type === "action.started") {
      this.#setLifecycle(payloadOf<ActionStartedPayload & Record<string, unknown>>(message).action_id, "started");
      return;
    }
    if (message.type === "action.completed") {
      const completed = payloadOf<ActionCompletedPayload & Record<string, unknown>>(message);
      this.#finish(completed.action_id, {
        status: "completed",
        action_id: completed.action_id,
        tool: completed.tool,
        state_version: completed.state_version,
        result: structuredClone(completed.result),
        source: "lifecycle",
      });
      return;
    }
    if (message.type === "action.failed") {
      const failed = payloadOf<ActionFailedPayload & Record<string, unknown>>(message);
      this.#finish(failed.action_id, {
        status: "failed",
        action_id: failed.action_id,
        error: structuredClone(failed.error),
      });
    }
  }

  #setLifecycle(actionId: string, status: "accepted" | "started"): void {
    const record = this.#records.get(actionId);
    if (
      record !== undefined
      && record.outcome === null
      && !(record.status === "started" && status === "accepted")
    ) {
      record.status = status;
      if (status === "accepted" && record.acceptedAtMonotonicMs === null) {
        record.acceptedAtMonotonicMs = this.#monotonicNow();
      }
      if (status === "started" && record.startedAtMonotonicMs === null) {
        record.startedAtMonotonicMs = this.#monotonicNow();
      }
    }
  }

  #finish(actionId: string, outcome: DeviceActionOutcome): void {
    const record = this.#records.get(actionId);
    if (record === undefined) {
      return;
    }
    if (
      outcome.status === "completed"
      && outcome.tool !== record.request.tool
    ) {
      throw new TypeError(
        `action ${actionId} completed with ${outcome.tool}, expected ${record.request.tool}`,
      );
    }
    if (outcome.status === "completed") {
      const expectedResult = record.request.tool === "character.go_to_room"
        ? { room_id: record.request.arguments.room_id }
        : record.request.tool === "character.set_activity"
          ? { activity: record.request.arguments.activity }
          : record.request.tool === "character.say"
            ? { text: record.request.arguments.text }
            : null;
      if (expectedResult !== null && !sameValue(outcome.result, expectedResult)) {
        throw new TypeError(`action ${actionId} completed with a result that contradicts its request`);
      }
    }
    if (record.status === "completed" || record.status === "failed") {
      if (record.outcome === null || !sameValue(record.outcome, outcome)) {
        throw new TypeError(`action ${actionId} terminal lifecycle changed after ${record.status}`);
      }
      return;
    }
    record.status = outcome.status;
    record.outcome = structuredClone(outcome);
    record.terminalAtMonotonicMs = this.#monotonicNow();
    this.#resolveReconciliation(actionId);
    const waiter = this.#waiters.get(actionId);
    if (waiter === undefined) {
      return;
    }
    clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    this.#waiters.delete(actionId);
    waiter.resolve(structuredClone(outcome));
  }

  #handleDisconnect(): void {
    this.#ready = false;
    this.#sessionId = null;
    this.#nextIncomingSeq = null;
    this.#hasCapabilities = false;
    this.#resyncInFlight = false;
    this.#resyncRequestId = null;
    for (const actionId of [...this.#waiters.keys()]) {
      this.#finish(actionId, {
        status: "unknown",
        action_id: actionId,
        reason: "disconnected",
        replay_allowed: false,
        reconciliation: null,
      });
    }
  }

  #beginResync(reason: "seq_gap" | "state_version_gap"): void {
    this.#ready = false;
    if (this.#resyncInFlight || !this.#connection.is_open || this.#sessionId === null) {
      return;
    }
    this.#resyncInFlight = true;
    const messageId = this.#allocateMessageId();
    this.#resyncRequestId = messageId;
    void this.#send("world.resync.request", {
      reason,
      last_applied_state_version: this.#lastSnapshot?.state_version ?? 0,
    }, messageId).catch((error: unknown) => {
      this.#resyncInFlight = false;
      this.#resyncRequestId = null;
      this.#closeAfterSendFailure(error);
    });
  }

  #closeAfterSendFailure(error: unknown): void {
    this.#lastProtocolError = error instanceof Error ? error : new Error(String(error));
    this.#ready = false;
    this.#connection.close(1011, "device send failed");
  }

  #reconcileUnknownActions(snapshot: WorldSnapshotPayload): void {
    for (const [actionId, record] of this.#records) {
      if (record.status !== "unknown" || record.outcome?.status !== "unknown") {
        continue;
      }
      const roomId = record.request.arguments.room_id;
      const reconciliationStatus = record.request.tool !== "character.go_to_room"
        ? "not_observable"
        : typeof roomId === "string"
          && snapshot.state_version > record.baselineStateVersion
          && snapshot.character.room_id === roomId as RoomId
          ? "state_satisfied"
          : "state_not_satisfied";
      record.outcome = {
        ...record.outcome,
        reconciliation: {
          status: reconciliationStatus,
          snapshot_id: snapshot.snapshot_id,
          state_version: snapshot.state_version,
          observed_at_ms: snapshot.observed_at_ms,
        },
      };
      record.terminalAtMonotonicMs = this.#monotonicNow();
      this.#resolveReconciliation(actionId);
    }
  }

  #resolveReconciliation(actionId: string): void {
    const waiter = this.#reconciliationWaiters.get(actionId);
    const outcome = this.#records.get(actionId)?.outcome;
    if (waiter === undefined || outcome === null || outcome === undefined) {
      return;
    }
    clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    this.#reconciliationWaiters.delete(actionId);
    waiter.resolve(structuredClone(outcome));
  }

  #pruneRecords(): void {
    const cutoff = this.#monotonicNow() - this.#recordRetentionMs;
    for (const [actionId, record] of this.#records) {
      if (
        record.terminalAtMonotonicMs !== null
        && record.terminalAtMonotonicMs <= cutoff
        && !this.#waiters.has(actionId)
        && !this.#reconciliationWaiters.has(actionId)
      ) {
        this.#records.delete(actionId);
      }
    }
  }

  #evictOldestTerminalRecord(): boolean {
    const oldest = [...this.#records]
      .filter(([, record]) =>
        (record.status === "completed" || record.status === "failed")
        && record.terminalAtMonotonicMs !== null
      )
      .sort(([, left], [, right]) =>
        left.terminalAtMonotonicMs! - right.terminalAtMonotonicMs!
      )[0];
    if (oldest === undefined) {
      return false;
    }
    this.#records.delete(oldest[0]);
    return true;
  }
}
