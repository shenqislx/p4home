import type {
  ToolCall,
  ToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolFailureResult,
  ToolLoopResult,
  ToolResult,
} from "./types.ts";

export const TOOL_CALLS_PER_RUN_MAX = 4;
export const TOOL_TIMEOUT_MIN_MS = 100;
export const TOOL_TIMEOUT_MAX_MS = 120_000;
export const TOOL_ERROR_MESSAGE_MAX_LENGTH = 256;

export interface ToolLoopOptions {
  readonly run_id: string;
  readonly calls: readonly ToolCall[];
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
}

export class ToolExecutionError extends Error {
  public readonly code: ToolErrorCode;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: ToolErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ToolLoopConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolLoopConfigurationError";
  }
}

class AbortedExecution extends Error {}

function failure(call: ToolCall, error: ToolError): ToolFailureResult {
  return {
    schema_version: 1,
    tool_call_id: call.tool_call_id,
    name: call.name,
    status: "error",
    result: null,
    error,
  };
}

function validateOptions(options: ToolLoopOptions): number {
  if (options.calls.length > TOOL_CALLS_PER_RUN_MAX) {
    throw new ToolLoopConfigurationError(
      `one run may contain at most ${TOOL_CALLS_PER_RUN_MAX} tool calls`,
    );
  }
  const ids = new Set<string>();
  for (const call of options.calls) {
    if (ids.has(call.tool_call_id)) {
      throw new ToolLoopConfigurationError(`duplicate tool_call_id: ${call.tool_call_id}`);
    }
    ids.add(call.tool_call_id);
  }
  const timeoutMs = options.timeout_ms ?? 10_000;
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < TOOL_TIMEOUT_MIN_MS
    || timeoutMs > TOOL_TIMEOUT_MAX_MS
  ) {
    throw new ToolLoopConfigurationError(
      `timeout_ms must be between ${TOOL_TIMEOUT_MIN_MS} and ${TOOL_TIMEOUT_MAX_MS}`,
    );
  }
  return timeoutMs;
}

function normalizeErrorMessage(message: string, fallback: string): string {
  const normalized = message.trim().length === 0 ? fallback : message;
  return normalized.slice(0, TOOL_ERROR_MESSAGE_MAX_LENGTH);
}

function asToolError(error: unknown): ToolError {
  if (error instanceof ToolExecutionError) {
    const base = {
      code: error.code,
      message: normalizeErrorMessage(error.message, "tool execution failed"),
      retryable: error.retryable,
    } satisfies ToolError;
    return error.details === undefined ? base : { ...base, details: error.details };
  }
  return {
    code: "INTERNAL",
    message:
      error instanceof Error
        ? normalizeErrorMessage(error.message, "unexpected tool failure")
        : "unknown tool failure",
    retryable: false,
  };
}

async function executeOne(
  options: ToolLoopOptions,
  call: ToolCall,
  tool: ToolDefinition,
  timeoutMs: number,
): Promise<{ readonly result: ToolResult; readonly terminal: "success" | "failed" | "cancelled" | "timed_out" }> {
  const controller = new AbortController();
  let timedOut = false;
  const executionSignal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("tool timeout elapsed"));
  }, timeoutMs);

  if (executionSignal.aborted) {
    clearTimeout(timeout);
    return {
      terminal: "cancelled",
      result: failure(call, {
        code: "CANCELLED",
        message: "run was cancelled",
        retryable: false,
      }),
    };
  }

  const aborted = new Promise<never>((_resolve, reject) => {
    if (executionSignal.aborted) {
      reject(new AbortedExecution());
      return;
    }
    executionSignal.addEventListener("abort", () => reject(new AbortedExecution()), { once: true });
  });

  try {
    const result = await Promise.race([
      tool.execute(call.arguments, {
        run_id: options.run_id,
        tool_call_id: call.tool_call_id,
        signal: executionSignal,
      }),
      aborted,
    ]);
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new ToolExecutionError("INTERNAL", "tool returned a non-object result");
    }
    return {
      terminal: "success",
      result: {
        schema_version: 1,
        tool_call_id: call.tool_call_id,
        name: call.name,
        status: "success",
        result,
        error: null,
      },
    };
  } catch (error) {
    if (error instanceof AbortedExecution) {
      const code = timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED";
      return {
        terminal: timedOut ? "timed_out" : "cancelled",
        result: failure(call, {
          code,
          message: timedOut ? "relative tool timeout elapsed" : "run was cancelled",
          retryable: false,
        }),
      };
    }
    return { terminal: "failed", result: failure(call, asToolError(error)) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSequentialToolCalls(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const timeoutMs = validateOptions(options);
  const results: ToolResult[] = [];

  for (const call of options.calls) {
    if (options.signal?.aborted === true) {
      return { status: "cancelled", results };
    }
    const tool = options.tools.get(call.name);
    if (tool === undefined) {
      results.push(
        failure(call, {
          code: "UNSUPPORTED_TOOL",
          message: `tool ${call.name} is not allowed`,
          retryable: false,
        }),
      );
      return { status: "failed", results };
    }

    const execution = await executeOne(options, call, tool, timeoutMs);
    results.push(execution.result);
    if (execution.terminal !== "success") {
      return {
        status: execution.terminal === "failed" ? "failed" : execution.terminal,
        results,
      };
    }
  }

  return { status: "completed", results };
}
