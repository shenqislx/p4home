export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  readonly level: StructuredLogLevel;
  readonly event: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly tool_call_id?: string;
  readonly action_id?: string;
  readonly status?: string;
  readonly data?: Record<string, unknown>;
}

export interface StructuredLogger {
  log(entry: StructuredLogEntry): void;
}

export interface JsonLineLoggerOptions {
  readonly sink?: (line: string) => void;
  readonly clock?: () => number;
}

const SECRET_KEY =
  /(?:^|[_-])(?:authorization|api[_-]?key|password|secret|(?:api|access|refresh|device|auth|bearer)?[_-]?token)$/i;

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, seen),
    ]),
  );
}

export function createJsonLineLogger(options: JsonLineLoggerOptions = {}): StructuredLogger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const clock = options.clock ?? Date.now;
  return {
    log(entry): void {
      const safeEntry = redact(entry, new WeakSet()) as Record<string, unknown>;
      sink(JSON.stringify({ occurred_at_ms: clock(), ...safeEntry }));
    },
  };
}
