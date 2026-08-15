import { OllamaProviderError } from "./errors.ts";
import type {
  OllamaCapabilities,
  OllamaFetch,
  OllamaGenerateChunk,
  OllamaGenerateRequest,
  OllamaGenerateResult,
  OllamaHttpProviderOptions,
  OllamaProvider,
  OllamaUsage,
} from "./types.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;

interface RequestScope {
  readonly signal: AbortSignal;
  readonly timeoutSignal: AbortSignal;
  readonly controller: AbortController;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new OllamaProviderError("INVALID_RESPONSE", `${context} must be a JSON object`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new OllamaProviderError("INVALID_RESPONSE", `${field} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OllamaProviderError(
      "INVALID_RESPONSE",
      `${field} must be a non-negative finite number`,
    );
  }
  return value;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function validateGenerateRequest(request: OllamaGenerateRequest): void {
  if (request.prompt.trim().length === 0) {
    throw new TypeError("prompt must not be empty");
  }
  if (request.timeout_ms !== undefined) {
    validateTimeout(request.timeout_ms);
  }
}

function usageFrom(record: Record<string, unknown>): OllamaUsage {
  return compact({
    total_duration_ns: optionalNumber(record.total_duration, "total_duration"),
    load_duration_ns: optionalNumber(record.load_duration, "load_duration"),
    prompt_eval_count: optionalNumber(record.prompt_eval_count, "prompt_eval_count"),
    prompt_eval_duration_ns: optionalNumber(
      record.prompt_eval_duration,
      "prompt_eval_duration",
    ),
    eval_count: optionalNumber(record.eval_count, "eval_count"),
    eval_duration_ns: optionalNumber(record.eval_duration, "eval_duration"),
  }) as OllamaUsage;
}

function generateBody(model: string, request: OllamaGenerateRequest, stream: boolean): string {
  return JSON.stringify(
    compact({
      model,
      prompt: request.prompt,
      system: request.system,
      format: request.format,
      options: request.options,
      keep_alive: request.keep_alive,
      stream,
    }),
  );
}

function parseGenerateChunk(value: unknown): OllamaGenerateChunk {
  const record = requireRecord(value, "Ollama generate response");
  if (typeof record.done !== "boolean") {
    throw new OllamaProviderError("INVALID_RESPONSE", "done must be a boolean");
  }
  const doneReason = optionalString(record.done_reason, "done_reason");
  const base = {
    model: requireString(record.model, "model"),
    response: requireString(record.response, "response"),
    thinking: optionalString(record.thinking, "thinking") ?? "",
    done: record.done,
    ...usageFrom(record),
  } satisfies OllamaGenerateChunk;
  return doneReason === undefined ? base : { ...base, done_reason: doneReason };
}

function parseGenerateResult(value: unknown): OllamaGenerateResult {
  const chunk = parseGenerateChunk(value);
  if (!chunk.done) {
    throw new OllamaProviderError(
      "INVALID_RESPONSE",
      "non-streaming generate response must be terminal",
    );
  }
  const { done: _done, ...result } = chunk;
  return result;
}

async function parseJson(response: Response, context: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new OllamaProviderError("INVALID_RESPONSE", `${context} returned invalid JSON`);
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = requireRecord(await response.json(), "Ollama error response");
    return typeof payload.error === "string"
      ? payload.error.slice(0, 512)
      : `Ollama returned HTTP ${response.status}`;
  } catch {
    return `Ollama returned HTTP ${response.status}`;
  }
}

function asTransportError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): OllamaProviderError {
  if (timeoutSignal.aborted) {
    return new OllamaProviderError("TIMEOUT", "Ollama request timeout elapsed", {
      retryable: true,
    });
  }
  if (externalSignal?.aborted === true) {
    return new OllamaProviderError("CANCELLED", "Ollama request was cancelled");
  }
  if (error instanceof OllamaProviderError) {
    return error;
  }
  return new OllamaProviderError(
    "UNREACHABLE",
    error instanceof Error ? `Ollama is unreachable: ${error.message}` : "Ollama is unreachable",
    { retryable: true },
  );
}

export class OllamaHttpProvider implements OllamaProvider {
  readonly #model: string;
  readonly #baseUrl: URL;
  readonly #requestTimeoutMs: number;
  readonly #fetch: OllamaFetch;

  public constructor(options: OllamaHttpProviderOptions) {
    const model = options.model.trim();
    if (model.length === 0) {
      throw new TypeError("model must not be empty");
    }
    const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new TypeError("baseUrl must use http or https");
    }
    if (baseUrl.username.length > 0 || baseUrl.password.length > 0) {
      throw new TypeError("baseUrl must not contain credentials");
    }
    this.#model = model;
    this.#baseUrl = new URL(baseUrl.origin);
    this.#requestTimeoutMs = validateTimeout(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#fetch = options.fetch ?? fetch;
  }

  public async probe(signal?: AbortSignal): Promise<OllamaCapabilities> {
    const version = requireRecord(
      await this.#jsonRequest("/api/version", { method: "GET" }, signal),
      "Ollama version response",
    );
    const serverVersion = requireString(version.version, "version");
    const tags = requireRecord(
      await this.#jsonRequest("/api/tags", { method: "GET" }, signal),
      "Ollama tags response",
    );
    if (!Array.isArray(tags.models)) {
      throw new OllamaProviderError("INVALID_RESPONSE", "models must be an array");
    }
    const modelAvailable = tags.models.some((entry) => {
      if (!isRecord(entry)) {
        return false;
      }
      return entry.name === this.#model || entry.model === this.#model;
    });

    let declaredCapabilities: readonly string[] = [];
    if (modelAvailable) {
      const shown = requireRecord(
        await this.#jsonRequest(
          "/api/show",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: this.#model, verbose: false }),
          },
          signal,
        ),
        "Ollama show response",
      );
      if (
        !Array.isArray(shown.capabilities) ||
        !shown.capabilities.every((entry) => typeof entry === "string")
      ) {
        throw new OllamaProviderError("INVALID_RESPONSE", "capabilities must be a string array");
      }
      declaredCapabilities = [...shown.capabilities];
    }

    const completion = declaredCapabilities.includes("completion");
    return {
      serverVersion,
      model: this.#model,
      modelAvailable,
      declaredCapabilities,
      toolCalling: declaredCapabilities.includes("tools"),
      structuredOutput: completion,
      streaming: true,
      cancellation: true,
    };
  }

  public async generate(
    request: OllamaGenerateRequest,
    signal?: AbortSignal,
  ): Promise<OllamaGenerateResult> {
    validateGenerateRequest(request);
    const result = await this.#jsonRequest(
      "/api/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: generateBody(this.#model, request, false),
      },
      signal,
      request.timeout_ms,
    );
    return parseGenerateResult(result);
  }

  public async *stream(
    request: OllamaGenerateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OllamaGenerateChunk> {
    validateGenerateRequest(request);
    const scope = this.#scope(signal, request.timeout_ms);
    let response: Response;
    try {
      response = await this.#fetch(this.#url("/api/generate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: generateBody(this.#model, request, true),
        signal: scope.signal,
      });
    } catch (error) {
      throw asTransportError(error, signal, scope.timeoutSignal);
    }
    if (!response.ok) {
      scope.controller.abort(new Error("request failed"));
      throw await this.#httpError(response, true);
    }
    if (response.body === null) {
      scope.controller.abort(new Error("response body missing"));
      throw new OllamaProviderError("INVALID_RESPONSE", "stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal = false;
    try {
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          throw asTransportError(error, signal, scope.timeoutSignal);
        }
        if (readResult.done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(readResult.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          const chunk = this.#parseStreamLine(line);
          terminal ||= chunk.done;
          yield chunk;
        }
      }
      if (buffer.trim().length > 0) {
        const chunk = this.#parseStreamLine(buffer);
        terminal ||= chunk.done;
        yield chunk;
      }
      if (!terminal) {
        throw new OllamaProviderError(
          "INVALID_RESPONSE",
          "Ollama stream ended without a terminal chunk",
        );
      }
    } finally {
      scope.controller.abort(new Error("stream consumer closed"));
      try {
        await reader.cancel();
      } catch {
        // The body may already be errored or fully consumed.
      }
    }
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }

  #scope(externalSignal?: AbortSignal, timeoutMs?: number): RequestScope {
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(
      validateTimeout(timeoutMs ?? this.#requestTimeoutMs),
    );
    const signals =
      externalSignal === undefined
        ? [controller.signal, timeoutSignal]
        : [controller.signal, timeoutSignal, externalSignal];
    return {
      controller,
      timeoutSignal,
      signal: AbortSignal.any(signals),
    };
  }

  async #jsonRequest(
    path: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const scope = this.#scope(externalSignal, timeoutMs);
    try {
      const response = await this.#fetch(this.#url(path), { ...init, signal: scope.signal });
      if (!response.ok) {
        throw await this.#httpError(
          response,
          path === "/api/generate" || path === "/api/show",
        );
      }
      return await parseJson(response, path);
    } catch (error) {
      throw asTransportError(error, externalSignal, scope.timeoutSignal);
    } finally {
      scope.controller.abort(new Error("request completed"));
    }
  }

  async #httpError(response: Response, modelScoped: boolean): Promise<OllamaProviderError> {
    const message = await errorMessage(response);
    if (modelScoped && response.status === 404) {
      return new OllamaProviderError("MODEL_NOT_FOUND", message, { status: response.status });
    }
    return new OllamaProviderError("HTTP_ERROR", message, {
      retryable: response.status >= 500,
      status: response.status,
    });
  }

  #parseStreamLine(line: string): OllamaGenerateChunk {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new OllamaProviderError("INVALID_RESPONSE", "Ollama stream contains invalid NDJSON");
    }
    if (isRecord(value) && typeof value.error === "string") {
      throw new OllamaProviderError("HTTP_ERROR", value.error.slice(0, 512));
    }
    return parseGenerateChunk(value);
  }
}
