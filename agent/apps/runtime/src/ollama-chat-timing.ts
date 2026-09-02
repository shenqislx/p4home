import {
  OllamaProviderError,
  type OllamaChatRequest,
  type OllamaChatResult,
  type OllamaChatStreamEvent,
  type OllamaProvider,
} from "@p4home/provider-ollama";

export const OLLAMA_CHAT_USAGE_FIELDS = [
  "total_duration_ns",
  "load_duration_ns",
  "prompt_eval_count",
  "prompt_eval_duration_ns",
  "eval_count",
  "eval_duration_ns",
] as const;

export type OllamaChatUsageField = (typeof OLLAMA_CHAT_USAGE_FIELDS)[number];
export type OllamaChatCallStatus = "cancelled" | "completed" | "failed" | "timed_out";

export const OLLAMA_CHAT_MAX_CALLS = 4_096;
export const OLLAMA_CHAT_MAX_REQUEST_DURATION_MS = 600_000;
export const OLLAMA_CHAT_USAGE_MAXIMUMS: Readonly<Record<OllamaChatUsageField, number>> = {
  total_duration_ns: 600_000_000_000,
  load_duration_ns: 600_000_000_000,
  prompt_eval_count: 1_000_000_000,
  prompt_eval_duration_ns: 600_000_000_000,
  eval_count: 1_000_000_000,
  eval_duration_ns: 600_000_000_000,
};

export type OllamaChatUsageSnapshot = Readonly<Record<OllamaChatUsageField, number | null>>;

export interface OllamaChatCallTiming {
  readonly schema_version: 1;
  readonly status: OllamaChatCallStatus;
  /** Agent-observed wall time around the complete provider.chat request. */
  readonly request_duration_ms: number;
  /** Server-reported Ollama counters. Null means the terminal did not report the field. */
  readonly ollama: OllamaChatUsageSnapshot;
}

export interface OllamaChatTimingSummary {
  readonly schema_version: 1;
  readonly calls: number;
  readonly completed_calls: number;
  readonly failed_calls: number;
  readonly cancelled_calls: number;
  readonly timed_out_calls: number;
  readonly usage_complete_calls: number;
  readonly usage_missing_calls: number;
  readonly request_total_ms: number;
  /** Sums only reported values; usage_missing_calls makes partial coverage explicit. */
  readonly ollama_totals: Readonly<Record<OllamaChatUsageField, number>>;
  readonly call_details: readonly OllamaChatCallTiming[];
  readonly content_retained: false;
}

export interface MeasuredOllamaChatProvider {
  readonly provider: Pick<OllamaProvider, "chat" | "chatStream">;
  snapshot(): OllamaChatTimingSummary;
}

function emptyUsage(): Record<OllamaChatUsageField, number | null> {
  return {
    total_duration_ns: null,
    load_duration_ns: null,
    prompt_eval_count: null,
    prompt_eval_duration_ns: null,
    eval_count: null,
    eval_duration_ns: null,
  };
}

function usageFrom(result: OllamaChatResult): OllamaChatUsageSnapshot {
  const output = emptyUsage();
  for (const field of OLLAMA_CHAT_USAGE_FIELDS) {
    const value = result[field];
    // Metrics must remain observational. A malformed custom provider result is
    // represented as missing instead of changing the interaction outcome.
    output[field] = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      && value <= OLLAMA_CHAT_USAGE_MAXIMUMS[field]
      ? value
      : null;
  }
  return output;
}

function statusFrom(error: unknown, signal: AbortSignal | undefined): OllamaChatCallStatus {
  const reasonName = typeof signal?.reason === "object" && signal.reason !== null
    && "name" in signal.reason ? String(signal.reason.name) : "";
  if (error instanceof OllamaProviderError) {
    if (error.code === "TIMEOUT") return "timed_out";
    if (error.code === "CANCELLED") {
      // A provider may flatten caller aborts into CANCELLED. Preserve the
      // deadline cause without reclassifying an unrelated provider failure
      // merely because the signal aborted just after that failure won.
      return signal?.aborted === true && reasonName === "TimeoutError"
        ? "timed_out"
        : "cancelled";
    }
  }
  const errorName = typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
  if (signal?.aborted === true && errorName === "AbortError") {
    return reasonName === "TimeoutError" ? "timed_out" : "cancelled";
  }
  return "failed";
}

function durationMs(startedAt: number, now: () => number): number {
  const value = now() - startedAt;
  const rounded = Math.round(Number.isFinite(value) ? Math.max(0, value) : 0);
  return Number.isSafeInteger(rounded)
    ? Math.min(rounded, OLLAMA_CHAT_MAX_REQUEST_DURATION_MS)
    : OLLAMA_CHAT_MAX_REQUEST_DURATION_MS;
}

function normalizeCall(value: OllamaChatCallTiming): OllamaChatCallTiming {
  const statuses: readonly OllamaChatCallStatus[] = [
    "cancelled", "completed", "failed", "timed_out",
  ];
  const status = statuses.includes(value.status) ? value.status : "failed";
  const requestDuration = Number.isSafeInteger(value.request_duration_ms)
    && value.request_duration_ms >= 0
    ? Math.min(value.request_duration_ms, OLLAMA_CHAT_MAX_REQUEST_DURATION_MS)
    : 0;
  const ollama = emptyUsage();
  for (const field of OLLAMA_CHAT_USAGE_FIELDS) {
    const metric = value.ollama?.[field];
    ollama[field] = typeof metric === "number" && Number.isSafeInteger(metric)
      && metric >= 0 && metric <= OLLAMA_CHAT_USAGE_MAXIMUMS[field]
      ? metric
      : null;
  }
  return {
    schema_version: 1,
    status,
    request_duration_ms: requestDuration,
    ollama,
  };
}

export function summarizeOllamaChatTimings(
  values: readonly OllamaChatCallTiming[],
): OllamaChatTimingSummary {
  if (values.length > OLLAMA_CHAT_MAX_CALLS) {
    throw new RangeError(`model timing exceeds ${OLLAMA_CHAT_MAX_CALLS} calls`);
  }
  // Reconstruct the exact body-free schema instead of cloning possibly forged
  // enumerable properties from a caller into an evidence artifact.
  const calls = values.map(normalizeCall);
  const totals: Record<OllamaChatUsageField, number> = {
    total_duration_ns: 0,
    load_duration_ns: 0,
    prompt_eval_count: 0,
    prompt_eval_duration_ns: 0,
    eval_count: 0,
    eval_duration_ns: 0,
  };
  let usageCompleteCalls = 0;
  for (const call of calls) {
    const complete = OLLAMA_CHAT_USAGE_FIELDS.every((field) => call.ollama[field] !== null);
    if (complete) usageCompleteCalls++;
    for (const field of OLLAMA_CHAT_USAGE_FIELDS) {
      totals[field] += call.ollama[field] ?? 0;
    }
  }
  return {
    schema_version: 1,
    calls: calls.length,
    completed_calls: calls.filter((call) => call.status === "completed").length,
    failed_calls: calls.filter((call) => call.status === "failed").length,
    cancelled_calls: calls.filter((call) => call.status === "cancelled").length,
    timed_out_calls: calls.filter((call) => call.status === "timed_out").length,
    usage_complete_calls: usageCompleteCalls,
    usage_missing_calls: calls.length - usageCompleteCalls,
    request_total_ms: calls.reduce((total, call) => total + call.request_duration_ms, 0),
    ollama_totals: totals,
    call_details: calls,
    content_retained: false,
  };
}

export function measureOllamaChatProvider(
  provider: Pick<OllamaProvider, "chat"> & Partial<Pick<OllamaProvider, "chatStream">>,
  now: () => number = () => performance.now(),
): MeasuredOllamaChatProvider {
  const calls: OllamaChatCallTiming[] = [];
  const recordCompleted = (startedAt: number, result: OllamaChatResult): void => {
    calls.push({
      schema_version: 1,
      status: "completed",
      request_duration_ms: durationMs(startedAt, now),
      ollama: usageFrom(result),
    });
  };
  const recordFailed = (
    startedAt: number,
    error: unknown,
    signal: AbortSignal | undefined,
  ): void => {
    calls.push({
      schema_version: 1,
      status: statusFrom(error, signal),
      request_duration_ms: durationMs(startedAt, now),
      ollama: emptyUsage(),
    });
  };
  return {
    provider: {
      async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResult> {
        const startedAt = now();
        try {
          const result = await provider.chat(request, signal);
          recordCompleted(startedAt, result);
          return result;
        } catch (error) {
          recordFailed(startedAt, error, signal);
          throw error;
        }
      },
      async *chatStream(
        request: OllamaChatRequest,
        signal?: AbortSignal,
      ): AsyncIterable<OllamaChatStreamEvent> {
        const startedAt = now();
        let recorded = false;
        let terminal = false;
        try {
          const stream = provider.chatStream === undefined
            ? (async function* (): AsyncIterable<OllamaChatStreamEvent> {
                const result = await provider.chat(request, signal);
                yield { kind: "terminal", result };
              })()
            : provider.chatStream(request, signal);
          for await (const event of stream) {
            if (terminal) {
              throw new OllamaProviderError(
                "INVALID_RESPONSE",
                "Ollama chat stream contains data after its terminal event",
              );
            }
            if (event.kind === "terminal") {
              terminal = true;
              recordCompleted(startedAt, event.result);
              recorded = true;
            }
            yield event;
          }
          if (!terminal) {
            throw new OllamaProviderError(
              "INVALID_RESPONSE",
              "Ollama chat stream ended without a terminal event",
            );
          }
        } catch (error) {
          if (!recorded) {
            recordFailed(startedAt, error, signal);
            recorded = true;
          }
          throw error;
        } finally {
          if (!recorded) {
            calls.push({
              schema_version: 1,
              status: "cancelled",
              request_duration_ms: durationMs(startedAt, now),
              ollama: emptyUsage(),
            });
          }
        }
      },
    },
    snapshot: () => summarizeOllamaChatTimings(calls),
  };
}
