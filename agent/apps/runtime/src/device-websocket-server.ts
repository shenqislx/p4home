import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  DeviceWebSocketActionAdapter,
  type DeviceActionAdapterOptions,
  type DeviceWebSocketConnection,
} from "./device-action-adapter.ts";
import { DEVICE_MAX_JSON_FRAME_BYTES } from "./device-protocol.ts";

const DEVICE_WEBSOCKET_PATH = "/v1/device";
const DEVICE_TOKEN_MIN_BYTES = 32;
const DEVICE_TOKEN_MAX_BYTES = 255;

export interface DeviceWebSocketServerTlsOptions {
  readonly key: HttpsServerOptions["key"];
  readonly cert: HttpsServerOptions["cert"];
}

export interface DeviceWebSocketServerOptions {
  readonly host: string;
  readonly port: number;
  readonly device_tokens: Readonly<Record<string, string>>;
  readonly tls?: DeviceWebSocketServerTlsOptions;
  readonly allow_insecure_loopback_test?: boolean;
  readonly path?: string;
  readonly max_connections?: number;
}

export interface DeviceWebSocketServerAddress {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly path: string;
}

export type DeviceConnectionListener = (
  deviceId: string,
  connection: DeviceWebSocketConnection,
) => void;

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function fixedTimeTokenMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

class AcceptedDeviceWebSocketConnection implements DeviceWebSocketConnection {
  #socket: WebSocket | null = null;
  readonly #frameListeners = new Set<(frame: string) => void>();
  readonly #closeListeners = new Set<() => void>();

  public attach(socket: WebSocket): void {
    if (this.#socket !== null && this.#socket.readyState !== WebSocket.CLOSED) {
      this.#socket.terminate();
    }
    this.#socket = socket;
    socket.on("message", (data, isBinary) => {
      if (this.#socket !== socket) {
        return;
      }
      if (isBinary) {
        socket.close(1003, "binary frames are not supported by protocol v1");
        return;
      }
      const frame = typeof data === "string" ? data : data.toString("utf8");
      for (const listener of this.#frameListeners) {
        listener(frame);
      }
    });
    socket.once("close", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = null;
      for (const listener of this.#closeListeners) {
        listener();
      }
    });
  }

  public get is_open(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  public async send(frame: string): Promise<void> {
    if (!this.is_open) {
      throw new Error("device WebSocket is closed");
    }
    if (Buffer.byteLength(frame, "utf8") > DEVICE_MAX_JSON_FRAME_BYTES) {
      throw new RangeError("device frame exceeds the frozen 16 KiB limit");
    }
    const socket = this.#socket;
    if (socket === null) {
      throw new Error("device WebSocket is closed");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(frame, { binary: false }, (error) => {
        if (error == null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  public close(code: number, reason: string): void {
    this.#socket?.close(code, reason);
  }

  public onFrame(listener: (frame: string) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  public onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }
}

export class DeviceWebSocketServer {
  readonly #options: DeviceWebSocketServerOptions;
  readonly #deviceTokens: ReadonlyMap<string, string>;
  readonly #path: string;
  readonly #maxConnections: number;
  readonly #listeners = new Set<DeviceConnectionListener>();
  readonly #connections = new Map<string, WebSocket>();
  readonly #deviceChannels = new Map<string, AcceptedDeviceWebSocketConnection>();
  readonly #webSocketServer: WebSocketServer;
  #server: HttpServer | HttpsServer | null = null;
  #address: DeviceWebSocketServerAddress | null = null;

  public constructor(options: DeviceWebSocketServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError("port must be an integer between 0 and 65535");
    }
    if (
      options.tls === undefined
      && !(options.allow_insecure_loopback_test === true && isLoopbackHost(options.host))
    ) {
      throw new TypeError("Device WebSocket requires TLS outside explicit loopback tests");
    }
    const entries = Object.entries(options.device_tokens);
    if (entries.length === 0) {
      throw new TypeError("at least one paired device token is required");
    }
    for (const [deviceId, token] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) {
        throw new TypeError(`invalid paired device_id ${deviceId}`);
      }
      const tokenBytes = typeof token === "string" ? Buffer.byteLength(token, "utf8") : 0;
      if (tokenBytes < DEVICE_TOKEN_MIN_BYTES || tokenBytes > DEVICE_TOKEN_MAX_BYTES) {
        throw new TypeError(`device token for ${deviceId} must contain 32 to 255 bytes`);
      }
    }
    this.#options = options;
    this.#deviceTokens = new Map(entries);
    this.#path = options.path ?? DEVICE_WEBSOCKET_PATH;
    if (this.#path !== DEVICE_WEBSOCKET_PATH) {
      throw new TypeError(`Device WebSocket path is frozen at ${DEVICE_WEBSOCKET_PATH}`);
    }
    this.#maxConnections = options.max_connections ?? entries.length;
    if (!Number.isInteger(this.#maxConnections) || this.#maxConnections < 1) {
      throw new RangeError("max_connections must be a positive integer");
    }
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: DEVICE_MAX_JSON_FRAME_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  public get address(): DeviceWebSocketServerAddress | null {
    return this.#address;
  }

  public get connection_count(): number {
    return this.#connections.size;
  }

  public onDeviceConnection(listener: DeviceConnectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public disconnectDevice(
    deviceId: string,
    code = 1012,
    reason = "device reconnect requested",
  ): boolean {
    const connection = this.#connections.get(deviceId);
    if (connection === undefined) {
      return false;
    }
    connection.close(code, reason);
    return true;
  }

  public async start(): Promise<DeviceWebSocketServerAddress> {
    if (this.#server !== null) {
      throw new Error("Device WebSocket server is already started");
    }
    const requestHandler = (_request: unknown, response: { writeHead(status: number): void; end(): void }): void => {
      response.writeHead(404);
      response.end();
    };
    const server = this.#options.tls === undefined
      ? createHttpServer(requestHandler)
      : createHttpsServer({ ...this.#options.tls, minVersion: "TLSv1.2" }, requestHandler);
    this.#server = server;
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== this.#path) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const deviceHeader = request.headers["x-p4-device-id"];
      const deviceId = Array.isArray(deviceHeader) ? deviceHeader[0] : deviceHeader;
      const expectedToken = deviceId === undefined ? undefined : this.#deviceTokens.get(deviceId);
      const authorization = request.headers.authorization;
      const bearer = authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length)
        : null;
      if (
        deviceId === undefined
        || expectedToken === undefined
        || bearer === null
        || !fixedTimeTokenMatch(bearer, expectedToken)
      ) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      if (!this.#connections.has(deviceId) && this.#connections.size >= this.#maxConnections) {
        rejectUpgrade(socket, 409, "Conflict");
        return;
      }
      this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.#connections.set(deviceId, webSocket);
        let connection = this.#deviceChannels.get(deviceId);
        if (connection === undefined) {
          connection = new AcceptedDeviceWebSocketConnection();
          this.#deviceChannels.set(deviceId, connection);
        }
        // A board reset can leave the previous TCP socket half-open until the
        // kernel timeout expires. Valid credentials for the same paired
        // device identity replace that stale socket; a different device still
        // consumes a separate max-connections slot.
        connection.attach(webSocket);
        for (const listener of this.#listeners) {
          listener(deviceId, connection);
        }
        webSocket.once("close", () => {
          if (this.#connections.get(deviceId) === webSocket) {
            this.#connections.delete(deviceId);
          }
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#options.port, this.#options.host);
      });
    } catch (error) {
      this.#server = null;
      throw error;
    }
    const bound = server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("Device WebSocket server did not bind a TCP address");
    }
    this.#address = {
      host: this.#options.host,
      port: bound.port,
      secure: this.#options.tls !== undefined,
      path: this.#path,
    };
    return this.#address;
  }

  public async close(): Promise<void> {
    const server = this.#server;
    if (server === null) {
      return;
    }
    for (const connection of this.#connections.values()) {
      connection.terminate();
    }
    this.#connections.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.#server = null;
    this.#address = null;
  }
}

export interface DeviceRuntimeHubOptions {
  readonly server: DeviceWebSocketServerOptions;
  readonly adapter?: Omit<DeviceActionAdapterOptions, "device_id">;
  readonly handshake_timeout_ms?: number;
}

/**
 * Production-facing registry that gives Cat Runtime one stable adapter per
 * paired P4. The underlying socket may reconnect, but action records and the
 * last authoritative snapshot remain attached to the device identity.
 */
export class DeviceRuntimeHub {
  public readonly server: DeviceWebSocketServer;
  readonly #adapters = new Map<string, DeviceWebSocketActionAdapter>();
  readonly #handshakeCleanups = new Map<string, () => void>();
  readonly #handshakeTimeoutMs: number;

  public constructor(options: DeviceRuntimeHubOptions) {
    this.#handshakeTimeoutMs = options.handshake_timeout_ms ?? 5_000;
    if (!Number.isInteger(this.#handshakeTimeoutMs) || this.#handshakeTimeoutMs < 1) {
      throw new RangeError("handshake_timeout_ms must be a positive integer");
    }
    this.server = new DeviceWebSocketServer(options.server);
    this.server.onDeviceConnection((deviceId, connection) => {
      let adapter = this.#adapters.get(deviceId);
      if (adapter === undefined) {
        adapter = new DeviceWebSocketActionAdapter(connection, {
          ...options.adapter,
          device_id: deviceId,
        });
        this.#adapters.set(deviceId, adapter);
      }
      const previousCleanup = this.#handshakeCleanups.get(deviceId);
      if (previousCleanup !== undefined) {
        previousCleanup();
      }
      let removeFrameListener = (): void => undefined;
      let removeCloseListener = (): void => undefined;
      const timer = setTimeout(() => {
        if (connection.is_open && adapter?.is_ready !== true) {
          connection.close(1008, "device handshake timeout");
        }
        cleanup();
      }, this.#handshakeTimeoutMs);
      timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        removeFrameListener();
        removeCloseListener();
        if (this.#handshakeCleanups.get(deviceId) === cleanup) {
          this.#handshakeCleanups.delete(deviceId);
        }
      };
      removeFrameListener = connection.onFrame(() => {
        if (adapter?.is_ready === true) {
          cleanup();
        }
      });
      removeCloseListener = connection.onClose(cleanup);
      this.#handshakeCleanups.set(deviceId, cleanup);
    });
  }

  public get adapter_count(): number {
    return this.#adapters.size;
  }

  public getAdapter(deviceId: string): DeviceWebSocketActionAdapter | undefined {
    return this.#adapters.get(deviceId);
  }

  public async start(): Promise<DeviceWebSocketServerAddress> {
    return await this.server.start();
  }

  public async close(): Promise<void> {
    for (const cleanup of [...this.#handshakeCleanups.values()]) {
      cleanup();
    }
    await this.server.close();
  }
}
