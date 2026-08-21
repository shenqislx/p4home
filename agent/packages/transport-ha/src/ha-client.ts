import {
  projectRobotHaCapabilities,
  validateRobotHaPolicy,
  type RobotHaPolicyEntity,
  type RobotHaWriteAction,
} from "@p4home/contracts";

import {
  assertRobotHaRuntimeConfigBoundary,
  type RobotHaRuntimeConfig,
} from "./config.ts";
import {
  projectRobotHaState,
  RestRobotHaEntityStateReader,
} from "./state-reader.ts";
import {
  RobotHaTransportError,
  type RobotHaAuditEvent,
  type RobotHaClientOptions,
  type RobotHaClientView,
  type RobotHaConnectionState,
  type RobotHaMetrics,
  type RobotHaProjectedState,
  type RobotHaSocket,
  type RobotHaStateObservation,
  type RobotHaWriteAttempt,
  type RobotHaWriteClient,
} from "./types.ts";
import { createRobotHaWebSocket } from "./ws-socket.ts";

const HANDSHAKE_TIMEOUT_DEFAULT_MS = 10_000;
const REQUEST_TIMEOUT_DEFAULT_MS = 8_000;
const MAX_PENDING_DEFAULT = 16;
const MAX_FRAME_DEFAULT_BYTES = 262_144;

interface PendingRequest {
  readonly expected: "result" | "pong";
  readonly resolve: (message: Record<string, unknown>) => void;
  readonly reject: (error: RobotHaTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface MutableMetrics {
  connection_attempts: number;
  successful_connections: number;
  disconnects: number;
  protocol_errors: number;
  filtered_events: number;
  state_events: number;
  snapshot_loads: number;
  last_ready_at_ms: number | null;
  last_event_at_ms: number | null;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < minimum || actual > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return actual;
}

function sanitizedReason(reason: string): string {
  const clean = reason.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  return clean.length === 0 ? "unspecified" : clean;
}

export class RobotHaClient implements RobotHaClientView, RobotHaWriteClient {
  readonly #config: RobotHaRuntimeConfig;
  readonly #socketFactory;
  readonly #stateReader;
  readonly #auditSink;
  readonly #clock;
  readonly #handshakeTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maxPending: number;
  readonly #maxFrameBytes: number;
  readonly #entityById = new Map<string, RobotHaPolicyEntity>();
  readonly #entityByAlias = new Map<string, RobotHaPolicyEntity>();
  readonly #states = new Map<string, RobotHaProjectedState>();
  readonly #snapshotEvents = new Map<string, RobotHaProjectedState>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #stateListeners = new Set<(state: RobotHaProjectedState) => void>();
  readonly #observationListeners = new Set<(observation: RobotHaStateObservation) => void>();
  readonly #metrics: MutableMetrics = {
    connection_attempts: 0,
    successful_connections: 0,
    disconnects: 0,
    protocol_errors: 0,
    filtered_events: 0,
    state_events: 0,
    snapshot_loads: 0,
    last_ready_at_ms: null,
    last_event_at_ms: null,
  };
  #state: RobotHaConnectionState = "idle";
  #socket: RobotHaSocket | null = null;
  #socketUnsubscribers: (() => void)[] = [];
  #snapshotController: AbortController | null = null;
  #nextRequestId = 1;
  #connectionGeneration = 0;
  #observationSequence = 0;
  #subscriptionId: number | null = null;
  #authSent = false;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #connectPromise: Promise<void> | null = null;
  #connectResolve: (() => void) | null = null;
  #connectReject: ((error: RobotHaTransportError) => void) | null = null;

  public constructor(options: RobotHaClientOptions) {
    assertRobotHaRuntimeConfigBoundary(options.config);
    const policy = validateRobotHaPolicy(options.config.policy);
    this.#config = { ...options.config, policy };
    this.#socketFactory = options.socket_factory ?? createRobotHaWebSocket;
    this.#stateReader = options.state_reader ?? new RestRobotHaEntityStateReader();
    this.#auditSink = options.audit_sink;
    this.#clock = options.clock ?? Date.now;
    this.#handshakeTimeoutMs = integerOption(
      options.handshake_timeout_ms,
      HANDSHAKE_TIMEOUT_DEFAULT_MS,
      100,
      60_000,
      "handshake_timeout_ms",
    );
    this.#requestTimeoutMs = integerOption(
      options.request_timeout_ms,
      REQUEST_TIMEOUT_DEFAULT_MS,
      100,
      60_000,
      "request_timeout_ms",
    );
    this.#maxPending = integerOption(
      options.max_pending_requests,
      MAX_PENDING_DEFAULT,
      1,
      64,
      "max_pending_requests",
    );
    this.#maxFrameBytes = integerOption(
      options.max_frame_bytes,
      MAX_FRAME_DEFAULT_BYTES,
      1_024,
      1_048_576,
      "max_frame_bytes",
    );
    for (const entity of policy.entities) {
      this.#entityById.set(entity.entity_id, entity);
      this.#entityByAlias.set(entity.alias, entity);
    }
  }

  public get state(): RobotHaConnectionState {
    return this.#state;
  }

  public get capabilities() {
    return projectRobotHaCapabilities(this.#config.policy);
  }

  public get metrics(): RobotHaMetrics {
    return {
      ...this.#metrics,
      pending_requests: this.#pending.size,
      cached_entities: this.#states.size,
    };
  }

  public getState(alias: string): RobotHaProjectedState | null {
    const state = this.#states.get(alias);
    return state === undefined ? null : structuredClone(state);
  }

  public listStates(): readonly RobotHaProjectedState[] {
    return this.#config.policy.entities.map((entity) =>
      structuredClone(this.#states.get(entity.alias) ?? projectRobotHaState(entity, null))
    );
  }

  public onState(listener: (state: RobotHaProjectedState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  public onObservation(listener: (observation: RobotHaStateObservation) => void): () => void {
    this.#observationListeners.add(listener);
    return () => this.#observationListeners.delete(listener);
  }

  public connect(): Promise<void> {
    if (this.#state === "closed") {
      return Promise.reject(new RobotHaTransportError("CLOSED", "Robot HA client is closed"));
    }
    if (this.#connectPromise !== null) {
      return this.#connectPromise;
    }
    if (["connecting", "authenticating", "subscribing", "ready"].includes(this.#state)) {
      return this.#state === "ready"
        ? Promise.resolve()
        : Promise.reject(new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA connection is already active"));
    }
    this.#clearSocketListeners();
    if (!Number.isSafeInteger(this.#connectionGeneration + 1)) {
      return Promise.reject(new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA connection generation is exhausted"));
    }
    this.#connectionGeneration += 1;
    this.#snapshotController?.abort();
    this.#snapshotController = new AbortController();
    this.#invalidateStates();
    this.#snapshotEvents.clear();
    this.#subscriptionId = null;
    this.#authSent = false;
    this.#state = "connecting";
    this.#metrics.connection_attempts += 1;
    this.#emitAudit("ha.connection.started", {
      policy_id: this.#config.policy.policy_id,
      transport_security: this.#config.transport_security,
      allowlisted_entities: this.#config.policy.entities.length,
    });
    let socket: RobotHaSocket;
    try {
      socket = this.#socketFactory(this.#config.websocket_url, this.#maxFrameBytes);
    } catch {
      this.#state = "error";
      return Promise.reject(new RobotHaTransportError("DISCONNECTED", "Robot HA socket creation failed"));
    }
    this.#socket = socket;
    this.#socketUnsubscribers = [
      socket.onOpen(() => this.#handleOpen(socket)),
      socket.onMessage((frame, binary) => this.#handleMessage(socket, frame, binary)),
      socket.onClose((code, reason) => this.#handleClose(socket, code, reason)),
      socket.onError(() => this.#handleSocketError(socket)),
    ];
    this.#connectPromise = new Promise<void>((resolve, reject) => {
      this.#connectResolve = resolve;
      this.#connectReject = reject;
    });
    this.#handshakeTimer = setTimeout(() => {
      this.#failConnection(
        socket,
        new RobotHaTransportError("HANDSHAKE_TIMEOUT", "Robot HA handshake timed out"),
        1002,
      );
    }, this.#handshakeTimeoutMs);
    const promise = this.#connectPromise;
    void promise.finally(() => {
      if (this.#connectPromise === promise) {
        this.#connectPromise = null;
      }
    }).catch(() => undefined);
    return promise;
  }

  public async ping(): Promise<void> {
    if (this.#state !== "ready") {
      throw new RobotHaTransportError("DISCONNECTED", "Robot HA client is not ready");
    }
    await this.#sendRequest({ type: "ping" }, "pong");
  }

  public beginWrite(alias: string, action: RobotHaWriteAction): RobotHaWriteAttempt {
    if (this.#state !== "ready") {
      throw new RobotHaTransportError("DISCONNECTED", "Robot HA client is not ready");
    }
    const entity = this.#entityByAlias.get(alias);
    if (
      entity === undefined
      || !entity.write_actions.includes(action)
      || !["light", "switch", "scene"].includes(entity.domain)
      || (action === "activate_scene") !== (entity.domain === "scene")
    ) {
      throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA write is not allowlisted");
    }
    const service = action === "activate_scene" ? "turn_on" : action;
    const dispatchCursor = {
      connection_generation: this.#connectionGeneration,
      sequence: this.#observationSequence,
    };
    const { id, response } = this.#sendRequestWithId({
      type: "call_service",
      domain: entity.domain,
      service,
      target: { entity_id: entity.entity_id },
    }, "result");
    return {
      request_id: id,
      dispatch_cursor: dispatchCursor,
      response: response.then((message) => ({
        request_id: id,
        accepted: message.success === true,
      })),
    };
  }

  public async reconcileState(alias: string, signal: AbortSignal): Promise<RobotHaProjectedState> {
    if (this.#state === "closed") {
      throw new RobotHaTransportError("CLOSED", "Robot HA client is closed");
    }
    const entity = this.#entityByAlias.get(alias);
    if (entity === undefined) {
      throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA reconciliation alias is not allowlisted");
    }
    const rawStates = await this.#stateReader.read(this.#config, [entity], signal);
    if (
      rawStates.size !== 1
      || !rawStates.has(entity.entity_id)
      || [...rawStates.keys()].some((entityId) => entityId !== entity.entity_id)
    ) {
      throw new RobotHaTransportError("STATE_LOAD_FAILED", "Robot HA reconciliation returned an invalid entity set");
    }
    return structuredClone(projectRobotHaState(entity, rawStates.get(entity.entity_id)));
  }

  public close(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#clearHandshakeTimer();
    this.#snapshotController?.abort();
    this.#snapshotController = null;
    this.#snapshotEvents.clear();
    this.#invalidateStates();
    const error = new RobotHaTransportError("CLOSED", "Robot HA client was closed");
    this.#rejectPending(error);
    this.#rejectConnect(error);
    try {
      this.#socket?.close(1000, "client close");
    } catch {
      try {
        this.#socket?.terminate();
      } catch {
        // The local lifecycle is already closed.
      }
    }
  }

  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Robot HA clock must return a non-negative safe integer");
    }
    return now;
  }

  #emitAudit(type: RobotHaAuditEvent["type"], data: RobotHaAuditEvent["data"]): void {
    if (this.#auditSink === undefined) {
      return;
    }
    try {
      const event: RobotHaAuditEvent = { type, occurred_at_ms: this.#now(), data };
      void Promise.resolve(this.#auditSink(event)).catch(() => undefined);
    } catch {
      // Audit export is best-effort here. Phase 4B persists run-correlated facts separately.
    }
  }

  #handleOpen(socket: RobotHaSocket): void {
    if (socket !== this.#socket || this.#state !== "connecting") {
      return;
    }
    this.#state = "authenticating";
  }

  #handleMessage(socket: RobotHaSocket, frame: string, binary: boolean): void {
    if (socket !== this.#socket || this.#state === "closed") {
      return;
    }
    if (binary || Buffer.byteLength(frame, "utf8") > this.#maxFrameBytes) {
      this.#fatalProtocol(socket, "binary or oversized Home Assistant frame");
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(frame) as unknown;
    } catch {
      this.#fatalProtocol(socket, "Home Assistant frame is not JSON");
      return;
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      this.#fatalProtocol(socket, "Home Assistant frame must be an object");
      return;
    }
    const message = input as Record<string, unknown>;
    if (typeof message.type !== "string") {
      this.#fatalProtocol(socket, "Home Assistant frame type is missing");
      return;
    }
    const authMessage = message.type === "auth_required"
      || message.type === "auth_ok"
      || message.type === "auth_invalid";
    if (this.#state === "authenticating" && !authMessage) {
      this.#fatalProtocol(socket, "command message arrived during Home Assistant authentication");
      return;
    }
    if (
      (message.type === "result" || message.type === "pong" || message.type === "event")
      && this.#state !== "subscribing"
      && this.#state !== "ready"
    ) {
      this.#fatalProtocol(socket, "Home Assistant command response arrived outside command phase");
      return;
    }
    switch (message.type) {
      case "auth_required":
        if (this.#state !== "authenticating" || this.#authSent) {
          this.#fatalProtocol(socket, "unexpected auth_required");
          return;
        }
        this.#authSent = true;
        try {
          socket.send(JSON.stringify({ type: "auth", access_token: this.#config.access_token }));
        } catch {
          this.#failConnection(
            socket,
            new RobotHaTransportError("DISCONNECTED", "Robot HA auth send failed"),
          );
        }
        return;
      case "auth_ok":
        if (this.#state !== "authenticating" || !this.#authSent) {
          this.#fatalProtocol(socket, "unexpected auth_ok");
          return;
        }
        this.#state = "subscribing";
        this.#emitAudit("ha.auth.completed", { policy_id: this.#config.policy.policy_id });
        void this.#finishAuthentication(socket);
        return;
      case "auth_invalid":
        this.#failConnection(
          socket,
          new RobotHaTransportError("AUTH_INVALID", "Robot HA authentication was rejected"),
          1008,
        );
        return;
      case "result":
        this.#handleResponse(message, "result");
        return;
      case "pong":
        this.#handleResponse(message, "pong");
        return;
      case "event":
        this.#handleEvent(message);
        return;
      default:
        this.#recordProtocolError("unexpected Home Assistant message type");
    }
  }

  async #finishAuthentication(socket: RobotHaSocket): Promise<void> {
    try {
      const { id, response } = this.#sendRequestWithId(
        { type: "subscribe_events", event_type: "state_changed" },
        "result",
      );
      // Reserve the known correlation id before awaiting the acknowledgement. A server can
      // deliver the result and first event in the same network turn.
      this.#subscriptionId = id;
      const result = await response;
      if (result.success !== true) {
        throw new RobotHaTransportError("PROTOCOL_ERROR", "state_changed subscription was rejected");
      }
      if (socket !== this.#socket || this.#state !== "subscribing") {
        return;
      }
      this.#emitAudit("ha.subscription.ready", { subscription_id: id });
      const controller = this.#snapshotController;
      if (controller === null) {
        throw new RobotHaTransportError("DISCONNECTED", "state snapshot was cancelled");
      }
      const rawStates = await this.#stateReader.read(
        this.#config,
        this.#config.policy.entities,
        controller.signal,
      );
      if (socket !== this.#socket || this.#state !== "subscribing") {
        return;
      }
      for (const entityId of rawStates.keys()) {
        if (!this.#entityById.has(entityId)) {
          throw new RobotHaTransportError("STATE_LOAD_FAILED", "state reader returned a non-allowlisted entity");
        }
      }
      const snapshot = new Map<string, RobotHaProjectedState>();
      for (const entity of this.#config.policy.entities) {
        if (!rawStates.has(entity.entity_id)) {
          throw new RobotHaTransportError("STATE_LOAD_FAILED", "state reader omitted an allowlisted entity");
        }
        const state = projectRobotHaState(entity, rawStates.get(entity.entity_id));
        snapshot.set(state.alias, state);
      }
      for (const eventState of this.#snapshotEvents.values()) {
        const snapshotState = snapshot.get(eventState.alias);
        if (snapshotState === undefined || this.#isEventStateNewer(eventState, snapshotState)) {
          snapshot.set(eventState.alias, eventState);
        }
      }
      this.#snapshotEvents.clear();
      this.#states.clear();
      for (const state of snapshot.values()) {
        this.#storeState(state, false);
      }
      this.#metrics.snapshot_loads += 1;
      this.#metrics.successful_connections += 1;
      this.#metrics.last_ready_at_ms = this.#now();
      this.#state = "ready";
      this.#clearHandshakeTimer();
      this.#emitAudit("ha.snapshot.loaded", {
        policy_id: this.#config.policy.policy_id,
        entity_count: this.#states.size,
      });
      this.#connectResolve?.();
      this.#connectResolve = null;
      this.#connectReject = null;
    } catch (error) {
      const normalized = error instanceof RobotHaTransportError
        ? error
        : new RobotHaTransportError("STATE_LOAD_FAILED", "Robot HA state initialization failed");
      this.#failConnection(socket, normalized, 1002);
    }
  }

  #sendRequest(
    command: Readonly<Record<string, unknown>>,
    expected: PendingRequest["expected"],
  ): Promise<Record<string, unknown>> {
    return this.#sendRequestWithId(command, expected).response;
  }

  #sendRequestWithId(
    command: Readonly<Record<string, unknown>>,
    expected: PendingRequest["expected"],
  ): { readonly id: number; readonly response: Promise<Record<string, unknown>> } {
    const socket = this.#socket;
    if (socket === null || !socket.is_open) {
      throw new RobotHaTransportError("DISCONNECTED", "Robot HA socket is not open");
    }
    if (this.#pending.size >= this.#maxPending) {
      throw new RobotHaTransportError("PENDING_CAPACITY", "Robot HA pending request capacity is full");
    }
    const id = this.#nextRequestId;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new RobotHaTransportError("PROTOCOL_ERROR", "Robot HA request id capacity is exhausted");
    }
    this.#nextRequestId += 1;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RobotHaTransportError("REQUEST_TIMEOUT", "Robot HA request timed out"));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { expected, resolve, reject, timer });
    });
    try {
      socket.send(JSON.stringify({ ...command, id }));
    } catch {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new RobotHaTransportError("DISCONNECTED", "Robot HA request send failed"));
      }
    }
    return { id, response };
  }

  #handleResponse(message: Record<string, unknown>, kind: PendingRequest["expected"]): void {
    const id = message.id;
    if (!Number.isSafeInteger(id) || (id as number) < 1) {
      this.#recordProtocolError("Home Assistant response id is invalid");
      return;
    }
    const pending = this.#pending.get(id as number);
    if (pending === undefined) {
      this.#recordProtocolError("duplicate or unknown Home Assistant response id");
      return;
    }
    if (pending.expected !== kind || (kind === "result" && typeof message.success !== "boolean")) {
      clearTimeout(pending.timer);
      this.#pending.delete(id as number);
      pending.reject(new RobotHaTransportError("PROTOCOL_ERROR", "Home Assistant response shape is invalid"));
      this.#recordProtocolError("Home Assistant response kind does not match request");
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(id as number);
    pending.resolve(message);
  }

  #handleEvent(message: Record<string, unknown>): void {
    if (message.id !== this.#subscriptionId || this.#subscriptionId === null) {
      this.#recordProtocolError("Home Assistant event has an unknown subscription id");
      return;
    }
    const event = message.event;
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      this.#recordProtocolError("Home Assistant event envelope is invalid");
      return;
    }
    const envelope = event as Record<string, unknown>;
    if (envelope.event_type !== "state_changed") {
      this.#metrics.filtered_events += 1;
      return;
    }
    const data = envelope.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      this.#recordProtocolError("Home Assistant state_changed data is invalid");
      return;
    }
    const record = data as Record<string, unknown>;
    const entityId = record.entity_id;
    if (typeof entityId !== "string") {
      this.#recordProtocolError("Home Assistant state_changed entity_id is invalid");
      return;
    }
    const entity = this.#entityById.get(entityId);
    if (entity === undefined) {
      this.#metrics.filtered_events += 1;
      return;
    }
    try {
      const state = projectRobotHaState(entity, record.new_state ?? null);
      this.#metrics.state_events += 1;
      this.#metrics.last_event_at_ms = this.#now();
      if (this.#state === "subscribing") {
        this.#snapshotEvents.set(state.alias, structuredClone(state));
        return;
      }
      this.#storeState(state, true);
    } catch {
      this.#recordProtocolError("allowlisted Home Assistant state projection failed");
    }
  }

  #storeState(state: RobotHaProjectedState, notify: boolean): void {
    this.#states.set(state.alias, structuredClone(state));
    if (notify) {
      if (!Number.isSafeInteger(this.#observationSequence + 1)) {
        const socket = this.#socket;
        if (socket !== null) {
          this.#fatalProtocol(socket, "Robot HA observation sequence is exhausted");
        }
        return;
      }
      this.#observationSequence += 1;
      const observation: RobotHaStateObservation = {
        connection_generation: this.#connectionGeneration,
        sequence: this.#observationSequence,
        source: "subscribed_state_changed",
        state: structuredClone(state),
      };
      this.#emitAudit("ha.state.changed", {
        alias: state.alias,
        domain: state.domain,
        available: state.available,
      });
      for (const listener of this.#stateListeners) {
        try {
          listener(structuredClone(state));
        } catch {
          // A local observer cannot change transport state or suppress other observers.
        }
      }
      for (const listener of this.#observationListeners) {
        try {
          listener(structuredClone(observation));
        } catch {
          // A local observer cannot change transport state or suppress others.
        }
      }
    }
  }

  #handleClose(socket: RobotHaSocket, code: number, _reason: string): void {
    if (socket !== this.#socket) {
      return;
    }
    this.#clearHandshakeTimer();
    this.#snapshotController?.abort();
    this.#snapshotController = null;
    this.#snapshotEvents.clear();
    this.#invalidateStates();
    this.#rejectPending(new RobotHaTransportError("DISCONNECTED", "Robot HA socket disconnected"));
    if (this.#state !== "closed" && this.#state !== "error") {
      this.#state = "disconnected";
      this.#rejectConnect(new RobotHaTransportError("DISCONNECTED", "Robot HA socket disconnected"));
    }
    this.#metrics.disconnects += 1;
    this.#emitAudit("ha.connection.disconnected", {
      code,
      state: this.#state,
    });
  }

  #handleSocketError(socket: RobotHaSocket): void {
    if (
      socket !== this.#socket
      || this.#state === "ready"
      || this.#state === "error"
      || this.#state === "closed"
    ) {
      return;
    }
    this.#failConnection(
      socket,
      new RobotHaTransportError("DISCONNECTED", "Robot HA socket failed"),
    );
  }

  #fatalProtocol(socket: RobotHaSocket, message: string): void {
    this.#recordProtocolError(message);
    this.#failConnection(socket, new RobotHaTransportError("PROTOCOL_ERROR", message), 1002);
  }

  #recordProtocolError(message: string): void {
    this.#metrics.protocol_errors += 1;
    this.#emitAudit("ha.protocol.error", {
      code: "PROTOCOL_ERROR",
      message: sanitizedReason(message),
    });
  }

  #failConnection(socket: RobotHaSocket, error: RobotHaTransportError, closeCode = 1011): void {
    if (socket !== this.#socket || this.#state === "closed") {
      return;
    }
    this.#state = "error";
    this.#clearHandshakeTimer();
    this.#snapshotController?.abort();
    this.#snapshotController = null;
    this.#snapshotEvents.clear();
    this.#invalidateStates();
    this.#rejectPending(error);
    this.#rejectConnect(error);
    try {
      socket.close(closeCode, error.code);
    } catch {
      // Termination below is the authoritative fail-closed cleanup.
    } finally {
      try {
        socket.terminate();
      } catch {
        // The attempt is already terminal even if an injected adapter misbehaves.
      }
    }
  }

  #rejectPending(error: RobotHaTransportError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #rejectConnect(error: RobotHaTransportError): void {
    this.#connectReject?.(error);
    this.#connectResolve = null;
    this.#connectReject = null;
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }

  #clearSocketListeners(): void {
    for (const unsubscribe of this.#socketUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // An adapter cleanup failure cannot block a new bounded connection attempt.
      }
    }
    this.#socketUnsubscribers = [];
  }

  #invalidateStates(): void {
    this.#states.clear();
  }

  #isEventStateNewer(
    eventState: RobotHaProjectedState,
    snapshotState: RobotHaProjectedState,
  ): boolean {
    if (eventState.updated_at_ms === null) {
      return true;
    }
    return snapshotState.updated_at_ms === null
      || eventState.updated_at_ms >= snapshotState.updated_at_ms;
  }
}
