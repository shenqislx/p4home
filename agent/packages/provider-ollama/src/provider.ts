import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import { OllamaProviderError } from "./errors.ts";
import type {
  OllamaCapabilities,
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResult,
  OllamaChatStreamEvent,
  OllamaFetch,
  OllamaGenerateChunk,
  OllamaGenerateRequest,
  OllamaGenerateResult,
  OllamaHttpProviderOptions,
  OllamaProvider,
  OllamaToolCall,
  OllamaUsage,
} from "./types.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 600_000;
const MAX_NDJSON_LINE_BYTES = 1024 * 1024;

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

function optionalIndex(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new OllamaProviderError("INVALID_RESPONSE", `${field} must be a non-negative integer`);
  }
  return value as number;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function decodeNdjsonUtf8(
  decoder: TextDecoder,
  value: Uint8Array | undefined,
  stream: boolean,
  context: string,
): string {
  try {
    return value === undefined ? decoder.decode() : decoder.decode(value, { stream });
  } catch (error) {
    throw new OllamaProviderError(
      "INVALID_RESPONSE", `${context} contains invalid UTF-8`, { cause: error },
    );
  }
}

function assertBoundedNdjsonLine(line: string, context: string): void {
  if (Buffer.byteLength(line, "utf8") > MAX_NDJSON_LINE_BYTES) {
    throw new OllamaProviderError(
      "INVALID_RESPONSE", `${context} contains an oversized NDJSON line`,
    );
  }
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "unknown validation error";
  }
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function structuredOutputValidator(
  format: OllamaChatRequest["format"],
  context: string,
): ((content: string) => void) | undefined {
  if (format === undefined) {
    return undefined;
  }
  let validate: ValidateFunction | undefined;
  if (format !== "json") {
    try {
      validate = new Ajv2020({
        allErrors: true,
        strict: true,
        strictRequired: false,
        strictTypes: false,
      }).compile(format);
    } catch (error) {
      throw new TypeError(
        error instanceof Error
          ? `format is not a valid JSON Schema: ${error.message}`
          : "format is not a valid JSON Schema",
      );
    }
  }
  return (content: string): void => {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new OllamaProviderError(
        "INVALID_RESPONSE",
        `${context} is not valid JSON`,
      );
    }
    if (validate !== undefined && !validate(value)) {
      throw new OllamaProviderError(
        "INVALID_RESPONSE",
        `${context}: ${formatSchemaErrors(validate.errors)}`,
      );
    }
  };
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function validateKeepAlive(value: string | number): string | number {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length === 0) throw new TypeError("keep_alive must not be empty");
    return normalized;
  }
  if (!Number.isFinite(value)) throw new TypeError("keep_alive must be finite");
  return value;
}

function validateGenerateRequest(request: OllamaGenerateRequest): void {
  if (request.prompt.trim().length === 0) {
    throw new TypeError("prompt must not be empty");
  }
  if (request.timeout_ms !== undefined) {
    validateTimeout(request.timeout_ms);
  }
}

function validateChatRequest(request: OllamaChatRequest): void {
  if (request.messages.length === 0) {
    throw new TypeError("messages must not be empty");
  }
  if (request.timeout_ms !== undefined) {
    validateTimeout(request.timeout_ms);
  }
  const toolNames = new Set<string>();
  for (const tool of request.tools ?? []) {
    const name = tool.function.name.trim();
    if (tool.type !== "function" || name.length === 0) {
      throw new TypeError("tools must contain named function definitions");
    }
    if (toolNames.has(name)) {
      throw new TypeError(`duplicate tool definition: ${name}`);
    }
    toolNames.add(name);
  }
  for (const message of request.messages) {
    if (message.role === "tool" && (message.tool_name?.trim().length ?? 0) === 0) {
      throw new TypeError("tool messages must include tool_name");
    }
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

function generateBody(
  model: string,
  request: OllamaGenerateRequest,
  stream: boolean,
  defaultKeepAlive: string | number | undefined,
): string {
  return JSON.stringify(
    compact({
      model,
      prompt: request.prompt,
      system: request.system,
      format: request.format,
      options: request.options,
      think: request.think,
      keep_alive: request.keep_alive ?? defaultKeepAlive,
      stream,
    }),
  );
}

function chatBody(
  model: string,
  request: OllamaChatRequest,
  stream: boolean,
  defaultKeepAlive: string | number | undefined,
): string {
  return JSON.stringify(
    compact({
      model,
      messages: request.messages,
      tools: request.tools,
      format: request.format,
      options: request.options,
      think: request.think,
      keep_alive: request.keep_alive ?? defaultKeepAlive,
      stream,
    }),
  );
}

function parseToolCall(value: unknown, index: number): OllamaToolCall {
  const record = requireRecord(value, `message.tool_calls[${index}]`);
  if (record.type !== undefined && record.type !== "function") {
    throw new OllamaProviderError(
      "INVALID_RESPONSE",
      `message.tool_calls[${index}].type must be function`,
    );
  }
  const functionRecord = requireRecord(
    record.function,
    `message.tool_calls[${index}].function`,
  );
  const callIndex = optionalIndex(
    functionRecord.index,
    `message.tool_calls[${index}].function.index`,
  );
  const parsed = {
    type: "function",
    function: {
      name: requireString(functionRecord.name, `message.tool_calls[${index}].function.name`),
      arguments: requireRecord(
        functionRecord.arguments,
        `message.tool_calls[${index}].function.arguments`,
      ),
    },
  } satisfies OllamaToolCall;
  return callIndex === undefined
    ? parsed
    : { ...parsed, function: { ...parsed.function, index: callIndex } };
}

function parseChatMessage(value: unknown): OllamaChatMessage & { readonly role: "assistant" } {
  const record = requireRecord(value, "message");
  if (record.role !== "assistant") {
    throw new OllamaProviderError("INVALID_RESPONSE", "message.role must be assistant");
  }
  let toolCalls: readonly OllamaToolCall[] | undefined;
  if (record.tool_calls !== undefined) {
    if (!Array.isArray(record.tool_calls)) {
      throw new OllamaProviderError("INVALID_RESPONSE", "message.tool_calls must be an array");
    }
    toolCalls = record.tool_calls.map(parseToolCall);
  }
  const base = {
    role: "assistant",
    content: requireString(record.content, "message.content"),
  } satisfies OllamaChatMessage & { readonly role: "assistant" };
  const thinking = optionalString(record.thinking, "message.thinking");
  return {
    ...base,
    ...(thinking === undefined ? {} : { thinking }),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  };
}

function parseChatResult(value: unknown): OllamaChatResult {
  const record = requireRecord(value, "Ollama chat response");
  if (record.done !== true) {
    throw new OllamaProviderError(
      "INVALID_RESPONSE",
      "non-streaming chat response must be terminal",
    );
  }
  const base = {
    model: requireString(record.model, "model"),
    message: parseChatMessage(record.message),
    ...usageFrom(record),
  } satisfies OllamaChatResult;
  const doneReason = optionalString(record.done_reason, "done_reason");
  return doneReason === undefined ? base : { ...base, done_reason: doneReason };
}

interface OllamaChatWireChunk extends OllamaUsage {
  readonly model: string;
  readonly message: OllamaChatMessage & { readonly role: "assistant" };
  readonly done: boolean;
  readonly done_reason?: string;
}

function parseChatChunk(value: unknown): OllamaChatWireChunk {
  const record = requireRecord(value, "Ollama chat stream response");
  if (typeof record.done !== "boolean") {
    throw new OllamaProviderError("INVALID_RESPONSE", "done must be a boolean");
  }
  const base = {
    model: requireString(record.model, "model"),
    message: parseChatMessage(record.message),
    done: record.done,
    ...usageFrom(record),
  } satisfies OllamaChatWireChunk;
  const doneReason = optionalString(record.done_reason, "done_reason");
  return doneReason === undefined ? base : { ...base, done_reason: doneReason };
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
  requestSignal: AbortSignal,
): OllamaProviderError {
  if (
    externalSignal?.aborted === true
    && requestSignal.aborted
    && requestSignal.reason === externalSignal.reason
  ) {
    return new OllamaProviderError("CANCELLED", "Ollama request was cancelled");
  }
  if (
    timeoutSignal.aborted
    && requestSignal.aborted
    && requestSignal.reason === timeoutSignal.reason
  ) {
    return new OllamaProviderError("TIMEOUT", "Ollama request timeout elapsed", {
      retryable: true,
    });
  }
  if (externalSignal?.aborted === true) {
    return new OllamaProviderError("CANCELLED", "Ollama request was cancelled");
  }
  if (timeoutSignal.aborted) {
    return new OllamaProviderError("TIMEOUT", "Ollama request timeout elapsed", {
      retryable: true,
    });
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
  readonly #defaultKeepAlive: string | number | undefined;
  readonly #fetch: OllamaFetch;
  #warmupPromise: Promise<void> | null = null;

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
    this.#defaultKeepAlive = options.defaultKeepAlive === undefined
      ? undefined
      : validateKeepAlive(options.defaultKeepAlive);
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Forces a real model evaluation before product readiness. The fulfilled
   * promise retains no model output, and callers can safely share one warmup.
   */
  public warmup(signal?: AbortSignal): Promise<void> {
    this.#warmupPromise ??= this.#runWarmup(signal);
    return this.#warmupPromise;
  }

  async #runWarmup(signal: AbortSignal | undefined): Promise<void> {
    const result = await this.chat({
      messages: [{ role: "user", content: "Reply with one short greeting." }],
      options: { temperature: 0, num_predict: 4 },
      think: false,
    }, signal);
    if (result.model !== this.#model) {
      throw new OllamaProviderError(
        "INVALID_RESPONSE", `Ollama warmup model identity mismatch: expected ${this.#model}`,
      );
    }
    if (result.message.content.trim().length === 0) {
      throw new OllamaProviderError("INVALID_RESPONSE", "Ollama warmup returned empty content");
    }
    if ((result.message.thinking?.trim().length ?? 0) > 0) {
      throw new OllamaProviderError("INVALID_RESPONSE", "Ollama warmup returned thinking content");
    }
    if ((result.message.tool_calls?.length ?? 0) > 0) {
      throw new OllamaProviderError("INVALID_RESPONSE", "Ollama warmup returned tool calls");
    }
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
      structuredOutput: false,
      structuredOutputApi: completion,
      streaming: true,
      cancellation: true,
    };
  }

  public async generate(
    request: OllamaGenerateRequest,
    signal?: AbortSignal,
  ): Promise<OllamaGenerateResult> {
    validateGenerateRequest(request);
    const validateStructuredOutput = structuredOutputValidator(
      request.format,
      "structured generate response",
    );
    const result = await this.#jsonRequest(
      "/api/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: generateBody(this.#model, request, false, this.#defaultKeepAlive),
      },
      signal,
      request.timeout_ms,
    );
    const parsed = parseGenerateResult(result);
    validateStructuredOutput?.(parsed.response);
    return parsed;
  }

  public async chat(
    request: OllamaChatRequest,
    signal?: AbortSignal,
  ): Promise<OllamaChatResult> {
    validateChatRequest(request);
    const validateStructuredOutput = structuredOutputValidator(
      request.format,
      "structured chat response",
    );
    const result = await this.#jsonRequest(
      "/api/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(this.#model, request, false, this.#defaultKeepAlive),
      },
      signal,
      request.timeout_ms,
    );
    const parsed = parseChatResult(result);
    if ((parsed.message.tool_calls?.length ?? 0) === 0) {
      validateStructuredOutput?.(parsed.message.content);
    }
    return parsed;
  }

  public async *chatStream(
    request: OllamaChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OllamaChatStreamEvent> {
    validateChatRequest(request);
    const validateStructuredOutput = structuredOutputValidator(
      request.format,
      "structured chat stream response",
    );
    const scope = this.#scope(signal, request.timeout_ms);
    let response: Response;
    try {
      response = await this.#fetch(this.#url("/api/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(this.#model, request, true, this.#defaultKeepAlive),
        signal: scope.signal,
      });
    } catch (error) {
      throw asTransportError(error, signal, scope.timeoutSignal, scope.signal);
    }
    if (!response.ok) {
      scope.controller.abort(new Error("request failed"));
      throw await this.#httpError(response, true);
    }
    if (response.body === null) {
      scope.controller.abort(new Error("response body missing"));
      throw new OllamaProviderError("INVALID_RESPONSE", "chat stream response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let terminalChunk: OllamaChatWireChunk | undefined;
    let content = "";
    let thinking = "";
    let sawThinking = false;
    const toolCalls: OllamaToolCall[] = [];

    const consumeLine = (line: string): OllamaChatStreamEvent | undefined => {
      if (terminalChunk !== undefined) {
        throw new OllamaProviderError(
          "INVALID_RESPONSE",
          "Ollama chat stream contains data after its terminal chunk",
        );
      }
      const chunk = this.#parseChatStreamLine(line);
      if (chunk.model !== this.#model) {
        throw new OllamaProviderError(
          "INVALID_RESPONSE",
          `Ollama chat stream model identity mismatch: expected ${this.#model}`,
        );
      }
      content += chunk.message.content;
      if (chunk.message.thinking !== undefined) {
        sawThinking = true;
        thinking += chunk.message.thinking;
      }
      if (chunk.message.tool_calls !== undefined) {
        toolCalls.push(...chunk.message.tool_calls);
      }
      if (chunk.done) {
        terminalChunk = chunk;
      }
      return chunk.message.content.length === 0
        ? undefined
        : {
            kind: "content_delta",
            model: chunk.model,
            content: chunk.message.content,
          };
    };

    try {
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          throw asTransportError(error, signal, scope.timeoutSignal, scope.signal);
        }
        if (readResult.done) {
          buffer += decodeNdjsonUtf8(decoder, undefined, false, "Ollama chat stream");
          break;
        }
        buffer += decodeNdjsonUtf8(
          decoder, readResult.value, true, "Ollama chat stream",
        );
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        assertBoundedNdjsonLine(buffer, "Ollama chat stream");
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          assertBoundedNdjsonLine(line, "Ollama chat stream");
          const event = consumeLine(line);
          if (event !== undefined) yield event;
        }
      }
      if (buffer.trim().length > 0) {
        assertBoundedNdjsonLine(buffer, "Ollama chat stream");
        const event = consumeLine(buffer);
        if (event !== undefined) yield event;
      }
      if (terminalChunk === undefined) {
        throw new OllamaProviderError(
          "INVALID_RESPONSE",
          "Ollama chat stream ended without a terminal chunk",
        );
      }
      const message = {
        role: "assistant",
        content,
        ...(sawThinking ? { thinking } : {}),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      } satisfies OllamaChatMessage & { readonly role: "assistant" };
      const resultBase = {
        model: terminalChunk.model,
        message,
        ...compact({
          total_duration_ns: terminalChunk.total_duration_ns,
          load_duration_ns: terminalChunk.load_duration_ns,
          prompt_eval_count: terminalChunk.prompt_eval_count,
          prompt_eval_duration_ns: terminalChunk.prompt_eval_duration_ns,
          eval_count: terminalChunk.eval_count,
          eval_duration_ns: terminalChunk.eval_duration_ns,
        }),
      } satisfies OllamaChatResult;
      const result = terminalChunk.done_reason === undefined
        ? resultBase
        : { ...resultBase, done_reason: terminalChunk.done_reason };
      if (toolCalls.length === 0) {
        validateStructuredOutput?.(content);
      }
      yield { kind: "terminal", result };
    } finally {
      scope.controller.abort(new Error("chat stream consumer closed"));
      void reader.cancel().catch(() => undefined);
    }
  }

  public async *stream(
    request: OllamaGenerateRequest,
    signal?: AbortSignal,
  ): AsyncIterable<OllamaGenerateChunk> {
    validateGenerateRequest(request);
    const validateStructuredOutput = structuredOutputValidator(
      request.format,
      "structured stream response",
    );
    const scope = this.#scope(signal, request.timeout_ms);
    let response: Response;
    try {
      response = await this.#fetch(this.#url("/api/generate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: generateBody(this.#model, request, true, this.#defaultKeepAlive),
        signal: scope.signal,
      });
    } catch (error) {
      throw asTransportError(error, signal, scope.timeoutSignal, scope.signal);
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
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let terminal = false;
    let responseText = "";
    try {
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          throw asTransportError(error, signal, scope.timeoutSignal, scope.signal);
        }
        if (readResult.done) {
          buffer += decodeNdjsonUtf8(decoder, undefined, false, "Ollama stream");
          break;
        }
        buffer += decodeNdjsonUtf8(decoder, readResult.value, true, "Ollama stream");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        assertBoundedNdjsonLine(buffer, "Ollama stream");
        for (const line of lines) {
          if (line.trim().length === 0) {
            continue;
          }
          if (terminal) {
            throw new OllamaProviderError(
              "INVALID_RESPONSE",
              "Ollama stream contains data after its terminal chunk",
            );
          }
          assertBoundedNdjsonLine(line, "Ollama stream");
          const chunk = this.#parseStreamLine(line);
          responseText += chunk.response;
          if (chunk.done) {
            terminal = true;
            validateStructuredOutput?.(responseText);
          }
          yield chunk;
        }
      }
      if (buffer.trim().length > 0) {
        assertBoundedNdjsonLine(buffer, "Ollama stream");
        if (terminal) {
          throw new OllamaProviderError(
            "INVALID_RESPONSE",
            "Ollama stream contains data after its terminal chunk",
          );
        }
        const chunk = this.#parseStreamLine(buffer);
        responseText += chunk.response;
        if (chunk.done) {
          terminal = true;
          validateStructuredOutput?.(responseText);
        }
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
      void reader.cancel().catch(() => undefined);
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
          path === "/api/generate" || path === "/api/chat" || path === "/api/show",
        );
      }
      return await parseJson(response, path);
    } catch (error) {
      throw asTransportError(error, externalSignal, scope.timeoutSignal, scope.signal);
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

  #parseChatStreamLine(line: string): OllamaChatWireChunk {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new OllamaProviderError(
        "INVALID_RESPONSE",
        "Ollama chat stream contains invalid NDJSON",
      );
    }
    if (isRecord(value) && typeof value.error === "string") {
      throw new OllamaProviderError("HTTP_ERROR", value.error.slice(0, 512));
    }
    return parseChatChunk(value);
  }
}
