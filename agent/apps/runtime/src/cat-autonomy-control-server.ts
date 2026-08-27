import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { CatAutonomyMode, CatAutonomyAuditRecord } from "./cat-autonomy-policy.ts";
import type { ProductCatAutonomyRuntimeStatus } from "./product-cat-autonomy.ts";
import type { ProductCatAutonomyExecutionRecord } from "./product-cat-autonomy.ts";

const MAX_BODY_BYTES = 1_024;
const TOKEN_MIN_BYTES = 32;
const TOKEN_MAX_BYTES = 255;

export interface CatAutonomyControlTarget {
  getStatus(): ProductCatAutonomyRuntimeStatus;
  listAudit(limit?: number): readonly CatAutonomyAuditRecord[];
  listExecutionAudit(limit?: number): readonly ProductCatAutonomyExecutionRecord[];
  setMode(mode: CatAutonomyMode): void;
}

export interface CatAutonomyControlServerOptions {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly token: Uint8Array;
  readonly target: CatAutonomyControlTarget;
}

export interface CatAutonomyControlAddress {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

function tokenDigest(value: Uint8Array | string): Buffer {
  return createHash("sha256").update(value).digest();
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.byteLength,
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError("content_type_required");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) throw new RangeError("request_body_too_large");
    chunks.push(chunk);
  }
  if (total === 0) throw new TypeError("request_body_required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Loopback-only, bearer-authenticated product control and bounded audit query endpoint. */
export class CatAutonomyControlServer {
  readonly #options: Omit<CatAutonomyControlServerOptions, "token">;
  readonly #tokenDigest: Buffer;
  #server: Server | null = null;

  public constructor(options: CatAutonomyControlServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new RangeError("Cat autonomy control port must be between 0 and 65535");
    }
    if (options.token.byteLength < TOKEN_MIN_BYTES || options.token.byteLength > TOKEN_MAX_BYTES) {
      throw new TypeError("Cat autonomy control token must contain 32 to 255 bytes");
    }
    this.#options = {
      host: options.host,
      port: options.port,
      target: options.target,
    };
    this.#tokenDigest = tokenDigest(options.token);
  }

  public async start(): Promise<CatAutonomyControlAddress> {
    if (this.#server !== null) throw new TypeError("Cat autonomy control server is already started");
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) json(response, 500, { error: "internal_error" });
        else response.destroy();
      });
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxHeadersCount = 32;
    this.#server = server;
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
    const address = server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error("Cat autonomy control server did not bind a TCP address");
    }
    return { host: this.#options.host, port: address.port };
  }

  public async close(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#authorized(request)) {
      response.setHeader("www-authenticate", "Bearer");
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/autonomy/status") {
      json(response, 200, this.#options.target.getStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/autonomy/audit") {
      const rawLimit = url.searchParams.get("limit") ?? "50";
      const limit = Number(rawLimit);
      if (!/^\d{1,4}$/u.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        json(response, 400, { error: "invalid_limit" });
        return;
      }
      json(response, 200, {
        decisions: this.#options.target.listAudit(limit),
        executions: this.#options.target.listExecutionAudit(limit),
      });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/v1/autonomy/mode") {
      let input: unknown;
      try {
        input = await readJsonBody(request);
      } catch (error) {
        json(response, error instanceof RangeError ? 413 : 400, {
          error: error instanceof RangeError ? "request_body_too_large" : "invalid_json",
        });
        return;
      }
      if (
        input === null
        || typeof input !== "object"
        || Array.isArray(input)
        || Object.keys(input).length !== 1
        || !("mode" in input)
        || !(["enabled", "paused", "disabled"] as const).includes(
          (input as { mode?: unknown }).mode as CatAutonomyMode,
        )
      ) {
        json(response, 400, { error: "invalid_mode" });
        return;
      }
      const mode = (input as { mode: CatAutonomyMode }).mode;
      this.#options.target.setMode(mode);
      json(response, 200, this.#options.target.getStatus());
      return;
    }
    json(response, 404, { error: "not_found" });
  }

  #authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length);
    return timingSafeEqual(tokenDigest(token), this.#tokenDigest);
  }
}
