import { ROOM_IDS, type CharacterActivity, type RoomId } from "@p4home/domain-p4home";

import type { DeviceWebSocketConnection } from "./device-action-adapter.ts";
import {
  DEVICE_ACTION_QUEUE_CAPACITY,
  decodeDeviceMessage,
  encodeDeviceMessage,
  payloadOf,
  type ActionAcceptedPayload,
  type ActionCompletedPayload,
  type ActionFailedPayload,
  type ActionRequestPayload,
  type ActionStartedPayload,
  type CharacterState,
  type DeviceActionError,
  type DeviceActionErrorCode,
  type DeviceMessage,
  type DeviceObjectCapability,
  type DeviceObjectState,
  type DeviceProtocolVersion,
  type DeviceToolName,
  type ObjectAction,
  type ObjectId,
  type ObjectRuntimeCharacterState,
  type WorldSnapshotPayload,
} from "./device-protocol.ts";

export interface DeterministicFakeDeviceOptions {
  readonly device_id?: string;
  readonly protocol_version?: DeviceProtocolVersion;
  readonly now?: () => number;
  readonly monotonic_now?: () => number;
  readonly auto_execute?: boolean;
  readonly auto_resync?: boolean;
  readonly initial_room?: RoomId;
  readonly initial_activity?: CharacterActivity;
  readonly idempotency_retention_ms?: number;
  readonly idempotency_capacity?: number;
}

const OBJECT_CAPABILITIES: readonly DeviceObjectCapability[] = [
  { object_id: "living_room.sofa", room_id: "living_room", supported_actions: ["go_to", "sit", "look_at", "interact"], available: true },
  { object_id: "study.desk", room_id: "study", supported_actions: ["go_to", "look_at", "interact"], available: true },
  { object_id: "living_room.window", room_id: "living_room", supported_actions: ["go_to", "look_at", "interact"], available: true },
];

const OBJECT_ACTION_BY_TOOL: Readonly<Partial<Record<DeviceToolName, ObjectAction>>> = {
  "character.go_to": "go_to",
  "character.sit": "sit",
  "character.look_at": "look_at",
  "character.interact": "interact",
};

type MutableFakeCharacterState = {
  room_id: RoomId;
  activity: CharacterActivity;
  speaking: boolean;
  target_object_id: ObjectId | null;
  pose: "standing" | "sitting";
};

type FakeActionLifecycleType =
  | "action.accepted"
  | "action.started"
  | "action.completed"
  | "action.failed";

interface FakeActionRecord {
  readonly request: ActionRequestPayload;
  readonly fingerprint: string;
  readonly acceptedAtMs: number;
  readonly correlationId: string;
  status: "accepted" | "started" | "completed" | "failed";
  terminalAtMonotonicMs: number | null;
  latestType: FakeActionLifecycleType;
  latestPayload: Record<string, unknown>;
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

function requestFingerprint(request: ActionRequestPayload): string {
  return JSON.stringify(canonicalize({
    tool: request.tool,
    arguments: request.arguments,
  }));
}

export class DeterministicFakeDeviceSocket implements DeviceWebSocketConnection {
  readonly #device: DeterministicFakeDevice;
  readonly #frameListeners = new Set<(frame: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  #open = false;

  public constructor(device: DeterministicFakeDevice) {
    this.#device = device;
    device.attachSocket(this);
  }

  public get is_open(): boolean {
    return this.#open;
  }

  public connect(reason: "boot" | "reconnect" | "manual" | "test" = "test"): void {
    if (this.#open) {
      throw new Error("fake device socket is already open");
    }
    this.#open = true;
    this.#device.openSession(reason);
  }

  public disconnect(): void {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    for (const listener of this.#closeListeners) {
      listener();
    }
  }

  public async send(frame: string): Promise<void> {
    if (!this.#open) {
      throw new Error("fake device socket is closed");
    }
    this.#device.receiveFrame(frame);
  }

  public close(_code: number, _reason: string): void {
    this.disconnect();
  }

  public onFrame(listener: (frame: string) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  public onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public deliverFromDevice(frame: string): void {
    if (!this.#open) {
      return;
    }
    for (const listener of this.#frameListeners) {
      listener(frame);
    }
  }
}

export class DeterministicFakeDevice {
  readonly #deviceId: string;
  readonly #protocolVersion: DeviceProtocolVersion;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #autoExecute: boolean;
  readonly #autoResync: boolean;
  readonly #idempotencyRetentionMs: number;
  readonly #idempotencyCapacity: number;
  readonly #records = new Map<string, FakeActionRecord>();
  readonly #queue: string[] = [];
  readonly #executionCounts = new Map<string, number>();
  #socket: DeterministicFakeDeviceSocket | null = null;
  #sessionId = "fake-session-0";
  #sessionCounter = 0;
  #nextOutgoingSeq = 0;
  #nextIncomingSeq = 0;
  #messageCounter = 0;
  #snapshotCounter = 0;
  #activeActionId: string | null = null;
  #stateVersion = 1;
  #state: MutableFakeCharacterState;
  #objects: DeviceObjectState[] = OBJECT_CAPABILITIES.map((object) => ({
    object_id: object.object_id,
    room_id: object.room_id,
    available: object.available,
    occupied: false,
  }));
  readonly #externalOccupied = new Set<ObjectId>();
  #characterOccupiedObjectId: ObjectId | null = null;
  readonly #forcedObjectErrors = new Map<string, DeviceActionError>();
  #receivedActionRequests = 0;
  #pendingResyncCorrelationId: string | null = null;
  readonly #bootStartedAtMonotonicMs: number;

  public constructor(options: DeterministicFakeDeviceOptions = {}) {
    this.#deviceId = options.device_id ?? "p4-fake-2b";
    this.#protocolVersion = options.protocol_version ?? 1;
    if (this.#protocolVersion !== 1 && this.#protocolVersion !== 2) {
      throw new RangeError("protocol_version must be 1 or 2");
    }
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonic_now ?? options.now ?? (() => performance.now());
    this.#autoExecute = options.auto_execute ?? true;
    this.#autoResync = options.auto_resync ?? true;
    this.#idempotencyRetentionMs = options.idempotency_retention_ms ?? 600_000;
    this.#idempotencyCapacity = options.idempotency_capacity ?? 4_096;
    if (!Number.isInteger(this.#idempotencyRetentionMs) || this.#idempotencyRetentionMs < 600_000) {
      throw new RangeError("idempotency_retention_ms must be at least 600000");
    }
    if (!Number.isInteger(this.#idempotencyCapacity) || this.#idempotencyCapacity < 1) {
      throw new RangeError("idempotency_capacity must be a positive integer");
    }
    this.#state = {
      room_id: options.initial_room ?? "living_room",
      activity: options.initial_activity ?? "idle",
      speaking: false,
      target_object_id: null,
      pose: "standing",
    };
    this.#bootStartedAtMonotonicMs = this.#monotonicNow();
  }

  public get device_id(): string {
    return this.#deviceId;
  }

  public get queue_length(): number {
    return this.#queue.length + (this.#activeActionId === null ? 0 : 1);
  }

  public get received_action_requests(): number {
    return this.#receivedActionRequests;
  }

  public get state_version(): number {
    return this.#stateVersion;
  }

  public getState(): CharacterState {
    const base: CharacterState = {
      room_id: this.#state.room_id,
      activity: this.#state.activity,
      speaking: this.#state.speaking,
      active_action_id: this.#activeActionId,
    };
    return this.#protocolVersion === 2
      ? {
          ...base,
          target_object_id: this.#state.target_object_id,
          pose: this.#state.pose,
        } as ObjectRuntimeCharacterState
      : base;
  }

  public setObjectAvailable(objectId: ObjectId, available: boolean): void {
    const object = this.#objectState(objectId);
    if (object.available === available) {
      return;
    }
    this.#objects = this.#objects.map((candidate) =>
      candidate.object_id === objectId ? { ...candidate, available } : candidate
    );
    if (!available && this.#state.target_object_id === objectId) {
      this.#releaseCharacterOccupancy();
      this.#state = { ...this.#state, target_object_id: null, pose: "standing" };
    }
    this.#stateVersion += 1;
    this.#emitWorldChanged();
  }

  public setObjectOccupied(objectId: ObjectId, occupied: boolean): void {
    if (occupied) {
      this.#externalOccupied.add(objectId);
    } else {
      this.#externalOccupied.delete(objectId);
    }
    if (occupied && this.#state.target_object_id === objectId) {
      this.#releaseCharacterOccupancy();
      this.#state = { ...this.#state, target_object_id: null, pose: "standing" };
    }
    this.#refreshObjectOccupancy(objectId);
    this.#stateVersion += 1;
    this.#emitWorldChanged();
  }

  public forceObjectError(
    tool: "character.go_to" | "character.sit" | "character.look_at" | "character.interact",
    objectId: ObjectId,
    code: Extract<DeviceActionErrorCode,
      "UNKNOWN_OBJECT" | "UNSUPPORTED_OBJECT_ACTION" | "OBJECT_UNAVAILABLE" |
      "OBJECT_OCCUPIED" | "OBJECT_NOT_REACHED">,
  ): void {
    this.#forcedObjectErrors.set(`${tool}:${objectId}`, {
      code,
      message: `forced fake-device ${code}`,
      retryable: code === "OBJECT_UNAVAILABLE" || code === "OBJECT_OCCUPIED",
    });
  }

  public executionCount(actionId: string): number {
    return this.#executionCounts.get(actionId) ?? 0;
  }

  public attachSocket(socket: DeterministicFakeDeviceSocket): void {
    if (this.#socket !== null) {
      throw new Error("fake device supports exactly one socket");
    }
    this.#socket = socket;
  }

  public openSession(reason: "boot" | "reconnect" | "manual" | "test"): void {
    this.#sessionCounter += 1;
    this.#sessionId = `fake-session-${this.#sessionCounter}`;
    this.#nextOutgoingSeq = 0;
    this.#nextIncomingSeq = 0;
    this.#emit("device.hello", {
      boot_id: "fake-boot-1",
      firmware_version: this.#protocolVersion === 2 ? "phase-3c-fake" : "phase-2b-fake",
      protocol_versions: this.#protocolVersion === 2 ? [1, 2] : [1],
      connection_reason: reason,
    });
    this.#emit("device.capabilities", {
      selected_protocol_version: this.#protocolVersion,
      rooms: [...ROOM_IDS],
      actions: this.#protocolVersion === 2 ? [
        "character.get_state",
        "character.go_to_room",
        "character.set_activity",
        "character.say",
        "world.get_snapshot",
        "character.go_to",
        "character.sit",
        "character.look_at",
        "character.interact",
      ] : [
        "character.get_state",
        "character.go_to_room",
        "character.set_activity",
        "character.say",
        "world.get_snapshot",
      ],
      ...(this.#protocolVersion === 2
        ? { objects: this.#capabilitySnapshot() }
        : {}),
      limits: {
        max_json_frame_bytes: 16_384,
        action_queue_capacity: DEVICE_ACTION_QUEUE_CAPACITY,
        say_text_max_chars: 256,
        action_timeout_min_ms: 100,
        action_timeout_max_ms: 120_000,
        idempotency_retention_ms: 600_000,
      },
    });
    this.#emitSnapshot(reason === "reconnect" ? "reconnect" : "connect", null);
  }

  public heartbeat(): void {
    this.#emit("heartbeat", {
      uptime_ms: Math.max(0, Math.floor(this.#monotonicNow() - this.#bootStartedAtMonotonicMs)),
      last_rx_seq: Math.max(0, this.#nextIncomingSeq - 1),
      state_version: this.#stateVersion,
    });
  }

  public emitInBandHelloForTest(): void {
    this.#emit("device.hello", {
      boot_id: "fake-boot-1",
      firmware_version: this.#protocolVersion === 2 ? "phase-3c-fake" : "phase-2b-fake",
      protocol_versions: this.#protocolVersion === 2 ? [1, 2] : [1],
      connection_reason: "manual",
    });
  }

  public emitContradictoryCompletionForTest(actionId: string): void {
    const record = this.#records.get(actionId);
    if (record === undefined) {
      throw new Error(`fake device has no action ${actionId}`);
    }
    this.#emit("action.completed", {
      action_id: actionId,
      tool: record.request.tool,
      completed_at_ms: this.#now(),
      state_version: this.#stateVersion,
      result: record.request.tool === "character.go_to_room"
        ? { room_id: record.request.arguments.room_id === "study" ? "kitchen" : "study" }
        : {},
    }, record.correlationId);
  }

  public injectStateVersionGapForTest(): void {
    this.#emit("world.changed", {
      state_version: this.#stateVersion + 2,
      observed_at_ms: this.#now(),
      character: this.getState(),
      ...(this.#protocolVersion === 2 ? { objects: this.#objectSnapshot() } : {}),
    });
  }

  public emitUncorrelatedSnapshotForTest(): void {
    this.#emitSnapshot("requested", null);
  }

  public respondToPendingResyncForTest(): void {
    if (this.#pendingResyncCorrelationId === null) {
      throw new Error("fake device has no pending resync request");
    }
    const correlationId = this.#pendingResyncCorrelationId;
    this.#pendingResyncCorrelationId = null;
    this.#emitSnapshot("resync", correlationId);
  }

  public receiveFrame(frame: string): void {
    const message = decodeDeviceMessage(frame);
    if (message.protocol_version !== this.#protocolVersion) {
      throw new TypeError("agent frame protocol_version does not match fake device");
    }
    if (message.device_id !== this.#deviceId) {
      throw new TypeError("agent frame device_id does not match fake device");
    }
    if (message.session_id !== this.#sessionId) {
      throw new TypeError("agent frame session_id does not match fake session");
    }
    if (message.seq !== this.#nextIncomingSeq) {
      throw new TypeError("agent frame seq is not gap-free");
    }
    this.#nextIncomingSeq += 1;
    if (message.type === "action.request") {
      this.#receiveActionRequest(
        message,
        payloadOf<ActionRequestPayload & Record<string, unknown>>(message),
      );
      return;
    }
    if (message.type === "action.cancel") {
      const payload = payloadOf<Record<string, unknown>>(message);
      this.#cancelAction(String(payload.action_id), message.message_id);
      return;
    }
    if (message.type === "world.resync.request") {
      if (this.#autoResync) {
        this.#emitSnapshot("resync", message.message_id);
      } else {
        this.#pendingResyncCorrelationId = message.message_id;
      }
    }
  }

  public startNext(): boolean {
    if (this.#activeActionId !== null) {
      return false;
    }
    const actionId = this.#queue.shift();
    if (actionId === undefined) {
      return false;
    }
    const record = this.#records.get(actionId)!;
    if (this.#isExpired(record)) {
      this.#fail(record, {
        code: "DEADLINE_EXCEEDED",
        message: "action deadline elapsed before execution",
        retryable: false,
      });
      return true;
    }
    const objectError = this.#objectRequestError(record.request);
    if (objectError !== null) {
      this.#fail(record, objectError);
      return true;
    }
    this.#activeActionId = actionId;
    record.status = "started";
    const payload: ActionStartedPayload & Record<string, unknown> = {
      action_id: actionId,
      started_at_ms: this.#now(),
    };
    record.latestType = "action.started";
    record.latestPayload = payload;
    this.#emit("action.started", payload, record.correlationId);
    return true;
  }

  public completeActive(): boolean {
    const actionId = this.#activeActionId;
    if (actionId === null) {
      return false;
    }
    const record = this.#records.get(actionId)!;
    if (this.#isExpired(record)) {
      this.#activeActionId = null;
      this.#fail(record, {
        code: "DEADLINE_EXCEEDED",
        message: "action deadline elapsed before side effect",
        retryable: false,
      });
      return true;
    }
    const objectError = this.#objectRequestError(record.request);
    if (objectError !== null) {
      this.#activeActionId = null;
      this.#stateVersion += 1;
      this.#fail(record, objectError);
      this.#emitWorldChanged();
      return true;
    }
    this.#activeActionId = null;
    const previousStateVersion = this.#stateVersion;
    const result = this.#execute(record.request.tool, record.request.arguments);
    this.#executionCounts.set(actionId, (this.#executionCounts.get(actionId) ?? 0) + 1);
    record.status = "completed";
    record.terminalAtMonotonicMs = this.#monotonicNow();
    const payload: ActionCompletedPayload & Record<string, unknown> = {
      action_id: actionId,
      tool: record.request.tool,
      completed_at_ms: this.#now(),
      state_version: this.#stateVersion,
      result,
    };
    record.latestType = "action.completed";
    record.latestPayload = payload;
    this.#emit("action.completed", payload, record.correlationId);
    if (this.#stateVersion > previousStateVersion) {
      this.#emit("world.changed", {
        state_version: this.#stateVersion,
        observed_at_ms: this.#now(),
        character: this.getState(),
        ...(this.#protocolVersion === 2 ? { objects: this.#objectSnapshot() } : {}),
      });
    }
    return true;
  }

  public drain(): void {
    while (this.startNext()) {
      if (this.#activeActionId !== null) {
        this.completeActive();
      }
    }
  }

  #receiveActionRequest(message: DeviceMessage, request: ActionRequestPayload): void {
    this.#receivedActionRequests += 1;
    this.#pruneActionRecords();
    const existing = this.#records.get(request.action_id);
    const fingerprint = requestFingerprint(request);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        const payload: ActionFailedPayload & Record<string, unknown> = {
          action_id: request.action_id,
          failed_at_ms: this.#now(),
          error: {
            code: "ACTION_ID_CONFLICT",
            message: "action_id was reused with a different request",
            retryable: false,
          },
        };
        this.#emit("action.failed", payload, message.message_id);
        return;
      }
      this.#emit(existing.latestType, existing.latestPayload, message.message_id);
      return;
    }
    if (this.#records.size >= this.#idempotencyCapacity) {
      throw new Error("fake device idempotency capacity is exhausted");
    }
    const objectError = this.#objectRequestError(request);
    if (objectError !== null) {
      const record: FakeActionRecord = {
        request: structuredClone(request),
        fingerprint,
        acceptedAtMs: this.#monotonicNow(),
        correlationId: message.message_id,
        status: "failed",
        terminalAtMonotonicMs: null,
        latestType: "action.failed",
        latestPayload: {},
      };
      this.#records.set(request.action_id, record);
      this.#fail(record, objectError, message.message_id);
      return;
    }
    if (this.queue_length >= DEVICE_ACTION_QUEUE_CAPACITY) {
      const record: FakeActionRecord = {
        request: structuredClone(request),
        fingerprint,
        acceptedAtMs: this.#monotonicNow(),
        correlationId: message.message_id,
        status: "failed",
        terminalAtMonotonicMs: null,
        latestType: "action.failed",
        latestPayload: {},
      };
      this.#records.set(request.action_id, record);
      this.#fail(record, {
        code: "QUEUE_FULL",
        message: "fake device action queue is full",
        retryable: true,
      }, message.message_id);
      return;
    }
    const accepted: ActionAcceptedPayload & Record<string, unknown> = {
      action_id: request.action_id,
      queue_position: this.queue_length,
      accepted_at_ms: this.#now(),
    };
    const record: FakeActionRecord = {
      request: structuredClone(request),
      fingerprint,
      acceptedAtMs: this.#monotonicNow(),
      correlationId: message.message_id,
      status: "accepted",
      terminalAtMonotonicMs: null,
      latestType: "action.accepted",
      latestPayload: accepted,
    };
    this.#records.set(request.action_id, record);
    this.#queue.push(request.action_id);
    this.#emit("action.accepted", accepted, message.message_id);
    if (this.#autoExecute) {
      this.drain();
    }
  }

  #cancelAction(actionId: string, correlationId: string): void {
    const record = this.#records.get(actionId);
    if (record === undefined) {
      this.#emit("error", {
        code: "ACTION_NOT_FOUND",
        message: "cancel target is unknown",
        retryable: false,
        details: { action_id: actionId },
      }, correlationId);
      return;
    }
    if (record.status === "completed" || record.status === "failed") {
      this.#emit(record.latestType, record.latestPayload, correlationId);
      return;
    }
    const queueIndex = this.#queue.indexOf(actionId);
    if (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1);
    }
    if (this.#activeActionId === actionId) {
      this.#activeActionId = null;
    }
    this.#fail(record, {
      code: "CANCELLED",
      message: "action cancellation confirmed",
      retryable: false,
    }, correlationId);
  }

  #isExpired(record: FakeActionRecord): boolean {
    return this.#monotonicNow() - record.acceptedAtMs >= record.request.timeout_ms;
  }

  #fail(
    record: FakeActionRecord,
    error: DeviceActionError,
    correlationId: string | null = record.correlationId,
  ): void {
    record.status = "failed";
    record.terminalAtMonotonicMs = this.#monotonicNow();
    const payload: ActionFailedPayload & Record<string, unknown> = {
      action_id: record.request.action_id,
      failed_at_ms: this.#now(),
      error,
    };
    record.latestType = "action.failed";
    record.latestPayload = payload;
    this.#emit("action.failed", payload, correlationId);
  }

  #pruneActionRecords(): void {
    const cutoff = this.#monotonicNow() - this.#idempotencyRetentionMs;
    for (const [actionId, record] of this.#records) {
      if (record.terminalAtMonotonicMs !== null && record.terminalAtMonotonicMs < cutoff) {
        this.#records.delete(actionId);
        this.#executionCounts.delete(actionId);
      }
    }
  }

  #execute(tool: DeviceToolName, argumentsValue: Record<string, unknown>): Record<string, unknown> {
    if (tool === "character.get_state") {
      return this.getState();
    }
    if (tool === "character.go_to_room") {
      const roomId = argumentsValue.room_id as RoomId;
      this.#releaseCharacterOccupancy();
      this.#state = {
        ...this.#state,
        room_id: roomId,
        target_object_id: null,
        pose: "standing",
      };
      this.#stateVersion += 1;
      return { room_id: roomId };
    }
    if (tool === "character.set_activity") {
      const activity = argumentsValue.activity as CharacterActivity;
      this.#state = { ...this.#state, activity };
      this.#stateVersion += 1;
      return { activity };
    }
    if (tool === "character.say") {
      this.#stateVersion += 1;
      return { text: String(argumentsValue.text) };
    }
    const objectAction = OBJECT_ACTION_BY_TOOL[tool];
    if (objectAction !== undefined) {
      const objectId = argumentsValue.target_id as ObjectId;
      const capability = this.#objectCapability(objectId);
      if (objectAction === "go_to") {
        this.#releaseCharacterOccupancy();
        this.#state = {
          ...this.#state,
          room_id: capability.room_id,
          activity: "idle",
          target_object_id: objectId,
          pose: "standing",
        };
      } else if (objectAction === "sit") {
        this.#releaseCharacterOccupancy();
        this.#characterOccupiedObjectId = objectId;
        this.#refreshObjectOccupancy(objectId);
        this.#state = { ...this.#state, pose: "sitting" };
      }
      this.#stateVersion += 1;
      return {
        object_id: objectId,
        action: objectAction,
        pose: this.#state.pose,
      };
    }
    return {
      state_version: this.#stateVersion,
      observed_at_ms: this.#now(),
      character: this.getState(),
      ...(this.#protocolVersion === 2 ? { objects: this.#objectSnapshot() } : {}),
    };
  }

  #objectRequestError(request: ActionRequestPayload): DeviceActionError | null {
    const action = OBJECT_ACTION_BY_TOOL[request.tool];
    if (action === undefined) {
      return null;
    }
    const objectId = request.arguments.target_id as ObjectId;
    const forced = this.#forcedObjectErrors.get(`${request.tool}:${objectId}`);
    if (forced !== undefined) {
      return structuredClone(forced);
    }
    const capability = OBJECT_CAPABILITIES.find((object) => object.object_id === objectId);
    if (capability === undefined) {
      return { code: "UNKNOWN_OBJECT", message: "object is not registered", retryable: false };
    }
    if (!capability.supported_actions.includes(action)) {
      return {
        code: "UNSUPPORTED_OBJECT_ACTION",
        message: "object does not support the action",
        retryable: false,
      };
    }
    const state = this.#objectState(objectId);
    if (!state.available) {
      return { code: "OBJECT_UNAVAILABLE", message: "object is unavailable", retryable: true };
    }
    if (this.#externalOccupied.has(objectId)) {
      return { code: "OBJECT_OCCUPIED", message: "object is occupied", retryable: true };
    }
    if (action !== "go_to" && this.#state.target_object_id !== objectId) {
      return { code: "OBJECT_NOT_REACHED", message: "object was not reached", retryable: false };
    }
    return null;
  }

  #objectCapability(objectId: ObjectId): DeviceObjectCapability {
    const capability = OBJECT_CAPABILITIES.find((object) => object.object_id === objectId);
    if (capability === undefined) {
      throw new Error(`fake object capability is missing: ${objectId}`);
    }
    return capability;
  }

  #objectState(objectId: ObjectId): DeviceObjectState {
    const state = this.#objects.find((object) => object.object_id === objectId);
    if (state === undefined) {
      throw new Error(`fake object state is missing: ${objectId}`);
    }
    return state;
  }

  #objectSnapshot(): readonly DeviceObjectState[] {
    return structuredClone(this.#objects);
  }

  #capabilitySnapshot(): readonly DeviceObjectCapability[] {
    return OBJECT_CAPABILITIES.map((capability) => ({
      ...capability,
      supported_actions: [...capability.supported_actions],
      available: this.#objectState(capability.object_id).available,
    }));
  }

  #releaseCharacterOccupancy(): void {
    const occupied = this.#characterOccupiedObjectId;
    if (occupied === null) {
      return;
    }
    this.#characterOccupiedObjectId = null;
    this.#refreshObjectOccupancy(occupied);
  }

  #refreshObjectOccupancy(objectId: ObjectId): void {
    const occupied = this.#externalOccupied.has(objectId)
      || this.#characterOccupiedObjectId === objectId;
    this.#objects = this.#objects.map((object) =>
      object.object_id === objectId ? { ...object, occupied } : object
    );
  }

  #emitWorldChanged(): void {
    if (this.#protocolVersion !== 2 || this.#socket?.is_open !== true) {
      return;
    }
    this.#emit("world.changed", {
      state_version: this.#stateVersion,
      observed_at_ms: this.#now(),
      character: this.getState(),
      objects: this.#objectSnapshot(),
    });
  }

  #emitSnapshot(
    reason: WorldSnapshotPayload["reason"],
    correlationId: string | null,
  ): void {
    const payload: WorldSnapshotPayload & Record<string, unknown> = {
      snapshot_id: `fake-snapshot-${this.#snapshotCounter++}`,
      reason,
      state_version: this.#stateVersion,
      observed_at_ms: this.#now(),
      character: this.getState(),
      ...(this.#protocolVersion === 2 ? { objects: this.#objectSnapshot() } : {}),
    };
    this.#emit("world.snapshot", payload, correlationId);
  }

  #emit(
    type: DeviceMessage["type"],
    payload: Record<string, unknown>,
    correlationId: string | null = null,
  ): void {
    const message: DeviceMessage = {
      protocol_version: this.#protocolVersion,
      message_id: `fake-message-${this.#messageCounter++}`,
      correlation_id: correlationId,
      device_id: this.#deviceId,
      session_id: this.#sessionId,
      seq: this.#nextOutgoingSeq++,
      sent_at_ms: this.#now(),
      type,
      payload,
    };
    this.#socket?.deliverFromDevice(encodeDeviceMessage(message));
  }
}
