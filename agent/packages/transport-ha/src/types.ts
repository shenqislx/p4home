import type {
  RobotHaCapability,
  RobotHaDomain,
  RobotHaPolicyEntity,
  RobotHaProjectedAttribute,
} from "@p4home/contracts";

import type { RobotHaRuntimeConfig } from "./config.ts";

export type RobotHaTransportErrorCode =
  | "AUTH_INVALID"
  | "CLOSED"
  | "DISCONNECTED"
  | "HANDSHAKE_TIMEOUT"
  | "PENDING_CAPACITY"
  | "PROTOCOL_ERROR"
  | "REQUEST_TIMEOUT"
  | "STATE_LOAD_FAILED";

export class RobotHaTransportError extends Error {
  public readonly code: RobotHaTransportErrorCode;

  public constructor(code: RobotHaTransportErrorCode, message: string) {
    super(message);
    this.name = "RobotHaTransportError";
    this.code = code;
  }
}

export type RobotHaConnectionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "subscribing"
  | "ready"
  | "disconnected"
  | "error"
  | "closed";

export interface RobotHaProjectedState {
  readonly alias: string;
  readonly domain: RobotHaDomain;
  readonly state: string | null;
  readonly available: boolean;
  readonly attributes: Readonly<Partial<Record<RobotHaProjectedAttribute, string | number | null>>>;
  readonly updated_at_ms: number | null;
}

export interface RobotHaMetrics {
  readonly connection_attempts: number;
  readonly successful_connections: number;
  readonly disconnects: number;
  readonly protocol_errors: number;
  readonly filtered_events: number;
  readonly state_events: number;
  readonly snapshot_loads: number;
  readonly pending_requests: number;
  readonly cached_entities: number;
  readonly last_ready_at_ms: number | null;
  readonly last_event_at_ms: number | null;
}

export interface RobotHaAuditEvent {
  readonly type:
    | "ha.connection.started"
    | "ha.auth.completed"
    | "ha.subscription.ready"
    | "ha.snapshot.loaded"
    | "ha.state.changed"
    | "ha.connection.disconnected"
    | "ha.protocol.error";
  readonly occurred_at_ms: number;
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

export type RobotHaAuditSink = (event: RobotHaAuditEvent) => void | Promise<void>;

export interface RobotHaSocket {
  readonly is_open: boolean;
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  onOpen(listener: () => void): () => void;
  onMessage(listener: (frame: string, binary: boolean) => void): () => void;
  onClose(listener: (code: number, reason: string) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export type RobotHaSocketFactory = (url: string, maxFrameBytes: number) => RobotHaSocket;

export interface RobotHaEntityStateReader {
  read(
    config: RobotHaRuntimeConfig,
    entities: readonly RobotHaPolicyEntity[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, unknown>>;
}

export interface RobotHaClientOptions {
  readonly config: RobotHaRuntimeConfig;
  readonly socket_factory?: RobotHaSocketFactory;
  readonly state_reader?: RobotHaEntityStateReader;
  readonly audit_sink?: RobotHaAuditSink;
  readonly clock?: () => number;
  readonly handshake_timeout_ms?: number;
  readonly request_timeout_ms?: number;
  readonly max_pending_requests?: number;
  readonly max_frame_bytes?: number;
}

export interface RobotHaClientView {
  readonly state: RobotHaConnectionState;
  readonly capabilities: readonly RobotHaCapability[];
  readonly metrics: RobotHaMetrics;
  getState(alias: string): RobotHaProjectedState | null;
  listStates(): readonly RobotHaProjectedState[];
}
