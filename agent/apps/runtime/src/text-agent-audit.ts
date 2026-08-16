import type {
  Event,
  Message,
  ToolCall,
  ToolResult,
} from "@p4home/core";
import type { OllamaChatMessage } from "@p4home/provider-ollama";
import type { AuditStore } from "@p4home/storage-sqlite";

import type {
  StructuredLogEntry,
  StructuredLogger,
} from "./structured-logger.ts";
import type { TextAgentRunResult } from "./text-agent.ts";

export interface TextAgentAuditOptions {
  readonly store: AuditStore;
  readonly session_id: string;
  readonly logger?: StructuredLogger;
  readonly clock?: () => number;
}

export class TextAgentAuditTrail {
  readonly #runId: string;
  readonly #sessionId: string;
  readonly #store: AuditStore;
  readonly #logger: StructuredLogger | undefined;
  readonly #clock: () => number;
  #startedAtMs = 0;
  #lastOccurredAtMs = -1;
  #messageOrdinal = 0;
  #eventOrdinal = 0;

  public constructor(runId: string, options: TextAgentAuditOptions) {
    this.#runId = runId;
    this.#sessionId = options.session_id;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#clock = options.clock ?? Date.now;
  }

  public async start(systemPrompt: string, userText: string): Promise<void> {
    this.#startedAtMs = this.#now();
    const messages = [
      this.#newMessage("system", systemPrompt, null, {}),
      this.#newMessage("user", userText, null, {}),
    ];
    const event = this.#newEvent("run.started", { status: "running" });
    await this.#store.writeBatch({
      run: {
        run_id: this.#runId,
        session_id: this.#sessionId,
        status: "running",
        started_at_ms: this.#startedAtMs,
        completed_at_ms: null,
      },
      messages,
      events: [event],
    });
    this.#logEvent(event);
  }

  public async modelRequested(modelTurn: number): Promise<void> {
    await this.#event("model.requested", { model_turn: modelTurn });
  }

  public async modelCompleted(message: OllamaChatMessage, modelTurn: number): Promise<void> {
    const storedMessage = this.#newMessage("assistant", message.content, null, {
      model_turn: modelTurn,
      tool_calls: message.tool_calls ?? [],
    });
    const event = this.#newEvent("model.completed", {
      model_turn: modelTurn,
      tool_call_count: message.tool_calls?.length ?? 0,
      content_length: message.content.length,
    });
    await this.#store.writeBatch({ messages: [storedMessage], events: [event] });
    this.#logEvent(event);
  }

  public async toolCalls(calls: readonly ToolCall[], modelTurn: number): Promise<void> {
    const writes = calls.map((call) => ({
      run_id: this.#runId,
      call,
      created_at_ms: this.#now(),
    }));
    const events = calls.map((call) => this.#newEvent("tool.requested", {
      model_turn: modelTurn,
      tool_call_id: call.tool_call_id,
      name: call.name,
    }));
    await this.#store.writeBatch({ tool_calls: writes, events });
    calls.forEach((call, index) => {
      const event = events[index];
      if (event !== undefined) {
        this.#logEvent(event, { tool_call_id: call.tool_call_id });
      }
    });
  }

  public async toolResult(result: ToolResult, modelTurn: number): Promise<void> {
    const occurredAtMs = this.#now();
    const message = this.#newMessage("tool", JSON.stringify(result), result.name, {
      model_turn: modelTurn,
      tool_call_id: result.tool_call_id,
      status: result.status,
    });
    const event = this.#newEvent(
      result.status === "success" ? "tool.completed" : "tool.failed",
      {
        model_turn: modelTurn,
        tool_call_id: result.tool_call_id,
        name: result.name,
        status: result.status,
        error_code: result.error?.code ?? null,
      },
    );
    await this.#store.writeBatch({
      messages: [message],
      tool_results: [{ run_id: this.#runId, result, completed_at_ms: occurredAtMs }],
      events: [event],
    });
    this.#logEvent(event, { tool_call_id: result.tool_call_id, status: result.status });
  }

  public async finish(result: TextAgentRunResult): Promise<void> {
    const completedAtMs = this.#now();
    const eventType = result.status === "completed" ? "run.completed" : `run.${result.status}`;
    const event = this.#newEvent(eventType, {
      status: result.status,
      model_turns: result.model_turns,
      tool_call_count: result.tool_results.length,
      error_code: result.error?.code ?? null,
    });
    await this.#store.writeBatch({
      run: {
        run_id: this.#runId,
        session_id: this.#sessionId,
        status: result.status,
        started_at_ms: this.#startedAtMs,
        completed_at_ms: completedAtMs,
      },
      events: [event],
    });
    this.#logEvent(event, { status: result.status });
  }

  public async fail(error: unknown): Promise<void> {
    const completedAtMs = this.#now();
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "INTERNAL";
    const event = this.#newEvent("run.failed", { status: "failed", error_code: code });
    await this.#store.writeBatch({
      run: {
        run_id: this.#runId,
        session_id: this.#sessionId,
        status: "failed",
        started_at_ms: this.#startedAtMs,
        completed_at_ms: completedAtMs,
      },
      events: [event],
    });
    this.#logEvent(event, { status: "failed" });
  }

  #newMessage(
    role: Message["role"],
    content: string,
    toolName: string | null,
    metadata: Record<string, unknown>,
  ): Message {
    this.#messageOrdinal += 1;
    return {
      message_id: `${this.#runId}:message:${String(this.#messageOrdinal).padStart(4, "0")}`,
      session_id: this.#sessionId,
      run_id: this.#runId,
      role,
      content,
      tool_name: toolName,
      created_at_ms: this.#now(),
      metadata,
    };
  }

  #newEvent(
    type: string,
    payload: Record<string, unknown>,
  ): Event {
    this.#eventOrdinal += 1;
    return {
      event_id: `${this.#runId}:event:${String(this.#eventOrdinal).padStart(4, "0")}`,
      run_id: this.#runId,
      type,
      occurred_at_ms: this.#now(),
      payload,
    };
  }

  async #event(type: string, payload: Record<string, unknown>): Promise<void> {
    const event = this.#newEvent(type, payload);
    await this.#store.appendEvent(event);
    this.#logEvent(event);
  }

  #logEvent(
    event: Event,
    context: Pick<StructuredLogEntry, "tool_call_id" | "action_id" | "status"> = {},
  ): void {
    try {
      this.#logger?.log({
        level: event.type.endsWith("failed")
          ? "error"
          : event.type.endsWith("cancelled") || event.type.endsWith("timed_out")
            ? "warn"
            : "info",
        event: event.type,
        run_id: this.#runId,
        session_id: this.#sessionId,
        ...context,
        data: event.payload,
      });
    } catch {
      // SQLite is the audit source of truth; an optional log sink must not alter Run semantics.
    }
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("audit clock must return a non-negative safe integer");
    }
    this.#lastOccurredAtMs = Math.max(this.#lastOccurredAtMs, value);
    return this.#lastOccurredAtMs;
  }
}
