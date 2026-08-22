import WebSocket from "ws";

import { parseRobotIdentity, type RobotIdentity } from "./phase4c-ha-gate-core.ts";

interface IdentityOptions {
  readonly attempts?: number;
  readonly close_grace_ms?: number;
  readonly timeout_ms?: number;
  readonly retry_delay_ms?: number;
  readonly create_socket?: (url: string) => WebSocket;
  readonly on_outbound_frame?: (frame: string) => void;
}

function websocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
    parsed.protocol = "ws:";
  } else {
    throw new Error("identity_protocol");
  }
  parsed.pathname = "/api/websocket";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function readCurrentIdentityOnce(
  haUrl: string,
  accessToken: string,
  timeoutMs: number,
  closeGraceMs: number,
  createSocket: (url: string) => WebSocket,
  onOutboundFrame?: (frame: string) => void,
): Promise<RobotIdentity> {
  return new Promise<RobotIdentity>((resolve, reject) => {
    const socket = createSocket(websocketUrl(haUrl));
    let phase: "awaiting_auth_required" | "awaiting_auth_ok" | "awaiting_result" =
      "awaiting_auth_required";
    let settled = false;
    let forceCloseTimer: NodeJS.Timeout | null = null;

    const ignoreLateError = (): void => undefined;
    const finish = (callback: () => void, terminate: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.on("error", ignoreLateError);

      let completed = false;
      const complete = (): void => {
        if (completed) {
          return;
        }
        completed = true;
        if (forceCloseTimer !== null) {
          clearTimeout(forceCloseTimer);
        }
        socket.off("error", ignoreLateError);
        callback();
      };
      socket.once("close", complete);

      if (socket.readyState === WebSocket.CLOSED) {
        complete();
      } else if (terminate) {
        socket.terminate();
      } else {
        socket.close(1000, "identity complete");
        forceCloseTimer = setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) {
            socket.terminate();
          }
        }, closeGraceMs);
      }
    };
    const onError = (): void => {
      finish(() => reject(new Error("identity_transport")), true);
    };
    const send = (frame: string): boolean => {
      try {
        onOutboundFrame?.(frame);
        socket.send(frame);
        return true;
      } catch {
        finish(() => reject(new Error("identity_protocol")), true);
        return false;
      }
    };
    const onMessage = (raw: WebSocket.RawData, binary: boolean): void => {
      if (binary) {
        finish(() => reject(new Error("identity_protocol")), true);
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        finish(() => reject(new Error("identity_protocol")), true);
        return;
      }
      if (message.type === "auth_required" && phase === "awaiting_auth_required") {
        phase = "awaiting_auth_ok";
        send(JSON.stringify({ type: "auth", access_token: accessToken }));
      } else if (message.type === "auth_invalid") {
        finish(() => reject(new Error("identity_auth")), true);
      } else if (message.type === "auth_ok" && phase === "awaiting_auth_ok") {
        phase = "awaiting_result";
        send(JSON.stringify({ id: 1, type: "auth/current_user" }));
      } else if (message.type === "result" && message.id === 1 && phase === "awaiting_result") {
        if (message.success !== true) {
          finish(() => reject(new Error("identity_protocol")), true);
          return;
        }
        try {
          const identity = parseRobotIdentity(message.result);
          finish(() => resolve(identity), false);
        } catch {
          finish(() => reject(new Error("identity_protocol")), true);
        }
      } else {
        finish(() => reject(new Error("identity_protocol")), true);
      }
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("identity_timeout")), true);
    }, timeoutMs);
    socket.once("error", onError);
    socket.on("message", onMessage);
  });
}

export async function readCurrentIdentity(
  haUrl: string,
  accessToken: string,
  options: IdentityOptions = {},
): Promise<RobotIdentity> {
  const attempts = options.attempts ?? 3;
  const closeGraceMs = options.close_grace_ms ?? 250;
  const timeoutMs = options.timeout_ms ?? 10_000;
  const retryDelayMs = options.retry_delay_ms ?? 250;
  const createSocket = options.create_socket
    ?? ((url: string) => new WebSocket(url, { perMessageDeflate: false }));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readCurrentIdentityOnce(
        haUrl,
        accessToken,
        timeoutMs,
        closeGraceMs,
        createSocket,
        options.on_outbound_frame,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "identity_transport";
      const retryable = reason === "identity_transport" || reason === "identity_timeout";
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw new Error("identity_transport");
}
