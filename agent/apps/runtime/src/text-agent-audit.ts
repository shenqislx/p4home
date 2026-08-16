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
    this.#startedAtMs = this.#clock();
    await this.#store.saveRun({
      run_id: this.#runId,
      session_id: this.#sessionId,
      status: "running",
      started_at_ms: this.#startedAtMs,
      completed_at_ms: null,
    });
    await this.#message("system", systemPrompt, null, {});
    await this.#message("user", userText, null, {});
    await this.#event("run.started", { status: "running" });
  }

  public async modelRequested(modelTurn: number): Promise<void> {
    await this.#event("model.requested", { model_turn: modelTurn });
  }

  public async modelCompleted(message: OllamaChatMessage, modelTurn: number): Promise<void> {
    await this.#message("assistant", message.content, null, {
      model_turn: modelTurn,
      tool_calls: message.tool_calls ?? [],
    });
    await this.#event("model.completed", {
      model_turn: modelTurn,
      tool_call_count: message.tool_calls?.length ?? 0,
      content_length: message.content.length,
    });
  }

  public async toolCalls(calls: readonly ToolCall[], modelTurn: number): Promise<void> {
    for (const call of calls) {
      const occurredAtMs = this.#clock();
      await this.#store.saveToolCall(this.#runId, call, occurredAtMs);
      await this.#event(
        "tool.requested",
        { model_turn: modelTurn, name: call.name },
        { tool_call_id: call.tool_call_id },
      );
    }
  }

  public async toolResult(result: ToolResult, modelTurn: number): Promise<void> {
    const occurredAtMs = this.#clock();
    await this.#store.saveToolResult(this.#runId, result, occurredAtMs);
    await this.#message("tool", JSON.stringify(result), result.name, {
      model_turn: modelTurn,
      tool_call_id: result.tool_call_id,
      status: result.status,
    });
    await this.#event(
      result.status === "success" ? "tool.completed" : "tool.failed",
      {
        model_turn: modelTurn,
        name: result.name,
        status: result.status,
        error_code: result.error?.code ?? null,
      },
      { tool_call_id: result.tool_call_id, status: result.status },
    );
  }

  public async finish(result: TextAgentRunResult): Promise<void> {
    const completedAtMs = this.#clock();
    await this.#store.saveRun({
      run_id: this.#runId,
      session_id: this.#sessionId,
      status: result.status,
      started_at_ms: this.#startedAtMs,
      completed_at_ms: completedAtMs,
    });
    await this.#event("run.completed", {
      status: result.status,
      model_turns: result.model_turns,
      tool_call_count: result.tool_results.length,
      error_code: result.error?.code ?? null,
    }, { status: result.status });
  }

  public async fail(error: unknown): Promise<void> {
    const completedAtMs = this.#clock();
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "INTERNAL";
    await this.#store.saveRun({
      run_id: this.#runId,
      session_id: this.#sessionId,
      status: "failed",
      started_at_ms: this.#startedAtMs,
      completed_at_ms: completedAtMs,
    });
    await this.#event("run.failed", { status: "failed", error_code: code }, { status: "failed" });
  }

  async #message(
    role: Message["role"],
    content: string,
    toolName: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.#messageOrdinal += 1;
    await this.#store.saveMessage({
      message_id: `${this.#runId}:message:${String(this.#messageOrdinal).padStart(4, "0")}`,
      session_id: this.#sessionId,
      run_id: this.#runId,
      role,
      content,
      tool_name: toolName,
      created_at_ms: this.#clock(),
      metadata,
    });
  }

  async #event(
    type: string,
    payload: Record<string, unknown>,
    context: Pick<StructuredLogEntry, "tool_call_id" | "status"> = {},
  ): Promise<void> {
    this.#eventOrdinal += 1;
    const event: Event = {
      event_id: `${this.#runId}:event:${String(this.#eventOrdinal).padStart(4, "0")}`,
      run_id: this.#runId,
      type,
      occurred_at_ms: this.#clock(),
      payload,
    };
    await this.#store.appendEvent(event);
    try {
      this.#logger?.log({
        level: type.endsWith("failed") ? "error" : "info",
        event: type,
        run_id: this.#runId,
        session_id: this.#sessionId,
        ...context,
        data: payload,
      });
    } catch {
      // SQLite is the audit source of truth; an optional log sink must not alter Run semantics.
    }
  }
}
