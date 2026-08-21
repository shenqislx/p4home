import { createHash } from "node:crypto";

import type {
  Event,
  Message,
  Run,
  ToolCall,
  ToolFailureResult,
  ToolResult,
} from "@p4home/core";
import type { OllamaChatMessage } from "@p4home/provider-ollama";
import type { RobotHaWriteAction } from "@p4home/contracts";
import type { RobotHaObservationCursor } from "@p4home/transport-ha";
import type { AuditStore } from "@p4home/storage-sqlite";

import type {
  RoleAssignment,
  RoutePlan,
  UserTextInteraction,
} from "./role-contracts.ts";
import { buildRoleContext, getRoleProfile, type RoleInput } from "./role-profiles.ts";
import type { RoleRunResult } from "./role-runner.ts";
import type { RoleSession } from "./role-session.ts";

export interface RoleRunAuditOptions {
  readonly store: AuditStore;
  readonly clock?: () => number;
}

export class RoleRunAuditTrail {
  readonly #store: AuditStore;
  readonly #clock: () => number;
  readonly #runId: string;
  readonly #interaction: UserTextInteraction;
  readonly #plan: RoutePlan;
  readonly #assignment: RoleAssignment;
  readonly #session: RoleSession;
  #auditSessionId: string;
  #sessionMigration: {
    readonly from_session_id: string;
    readonly from_agent_profile_id: string;
  } | null = null;
  #startedAtMs = 0;
  #lastTime = -1;
  #messageOrdinal = 0;
  #eventOrdinal = 0;

  public constructor(
    runId: string,
    interaction: UserTextInteraction,
    plan: RoutePlan,
    assignment: RoleAssignment,
    session: RoleSession,
    options: RoleRunAuditOptions,
  ) {
    this.#runId = runId;
    this.#interaction = interaction;
    this.#plan = plan;
    this.#assignment = assignment;
    this.#session = session;
    this.#auditSessionId = session.session_id;
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
    this.#lastTime = session.created_at_ms;
  }

  public async start(input: RoleInput): Promise<void> {
    const profile = getRoleProfile(this.#session.role_id);
    const profileId = `${profile.revision.replace("/", "-")}:${profile.role_id}`;
    const storedProfile = await this.#store.getSessionAgentProfile(this.#session.session_id);
    if (storedProfile !== null && storedProfile.agent_profile_id !== profileId) {
      const suffix = createHash("sha256")
        .update(`${this.#session.session_id}\0${profileId}`)
        .digest("hex")
        .slice(0, 16);
      this.#auditSessionId = `role-session:${profile.role_id}:${profile.revision.replace("/", "-")}:${suffix}`;
      this.#sessionMigration = {
        from_session_id: this.#session.session_id,
        from_agent_profile_id: storedProfile.agent_profile_id,
      };
    }
    this.#startedAtMs = this.#now();
    await this.#store.saveAgentProfile({
      agent_profile_id: profileId,
      name: `P4 Home ${profile.role_id}`,
      locale: "zh-CN",
      allowed_tools: profile.allowed_tools,
    });
    await this.#store.saveSession({
      session_id: this.#auditSessionId,
      agent_profile_id: profileId,
      created_at_ms: this.#session.created_at_ms,
      updated_at_ms: this.#startedAtMs,
    });
    const context = buildRoleContext(profile, input);
    const assignment = this.#assignment;
    const correlation = {
      interaction_id: this.#interaction.interaction_id,
      route_plan_id: this.#plan.route_plan_id,
      assignment_id: assignment.assignment_id,
      role_id: assignment.role_id,
      role_profile_revision: profile.revision,
      route_reason: this.#plan.reason,
      assignment_mode: assignment.mode,
      source_span: assignment.source_span,
    } as const;
    const messages: Message[] = [
      this.#message("system", context[0]?.content ?? profile.system_prompt, { ...correlation }),
      this.#message("user", context.at(-1)?.content ?? this.#interaction.text, { ...correlation }),
    ];
    const migrationEvents = this.#sessionMigration === null
      ? []
      : [this.#event("role.audit.session_migrated", {
          ...this.#sessionMigration,
          to_session_id: this.#auditSessionId,
          to_agent_profile_id: profileId,
          role_profile_revision: profile.revision,
        })];
    const event = this.#event("role.run.started", {
      ...correlation,
      ...(this.#sessionMigration === null
        ? {}
        : {
            runtime_session_id: this.#session.session_id,
            audit_session_id: this.#auditSessionId,
          }),
    });
    await this.#store.writeBatch({
      run: this.#run("running", null),
      messages,
      events: [...migrationEvents, event],
    });
  }

  public async modelRequested(modelTurn: number): Promise<void> {
    await this.#store.appendEvent(this.#event("role.model.requested", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      model_turn: modelTurn,
    }));
  }

  public async modelCompleted(message: OllamaChatMessage, modelTurn: number): Promise<void> {
    const stored = this.#message("assistant", message.content, {
      role_id: this.#session.role_id,
      model_turn: modelTurn,
      tool_calls: this.#safeToolCallSummaries(message),
    });
    const event = this.#event("role.model.completed", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      model_turn: modelTurn,
      tool_call_count: message.tool_calls?.length ?? 0,
      content_length: message.content.length,
    });
    await this.#store.writeBatch({ messages: [stored], events: [event] });
  }

  public async modelToolRejected(message: OllamaChatMessage, reason: string): Promise<void> {
    await this.#store.appendEvent(this.#event("role.ha.policy_rejected", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      attempt_id: `${this.#runId}:model-tool-rejection:1`,
      reason,
      tool_call_count: message.tool_calls?.length ?? 0,
      tool_names: this.#safeToolCallSummaries(message).map((call) => call.name),
    }));
  }

  public async toolCalls(calls: readonly ToolCall[], modelTurn: number): Promise<void> {
    await this.#store.writeBatch({
      tool_calls: calls.map((call) => ({
        run_id: this.#runId,
        call,
        created_at_ms: this.#now(),
      })),
      events: calls.map((call) => this.#event("role.tool.requested", {
        interaction_id: this.#interaction.interaction_id,
        assignment_id: this.#assignment.assignment_id,
        role_id: this.#session.role_id,
        model_turn: modelTurn,
        tool_call_id: call.tool_call_id,
        name: call.name,
      })),
    });
  }

  public async haPolicyDecision(
    toolCallId: string,
    alias: string,
    allowed: boolean,
    reason: string,
  ): Promise<void> {
    await this.#store.appendEvent(this.#event("role.ha.policy_decided", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      tool_call_id: toolCallId,
      alias,
      allowed,
      reason,
    }));
  }

  public async haReadRequested(toolCallId: string, alias: string): Promise<void> {
    await this.#store.appendEvent(this.#event("role.ha.read.requested", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      tool_call_id: toolCallId,
      alias,
      request_kind: "allowlisted_cache",
    }));
  }

  public async haWriteDispatched(
    toolCallId: string,
    alias: string,
    action: RobotHaWriteAction,
    requestId: number,
  ): Promise<void> {
    await this.#store.appendEvent(this.#event("role.ha.write.dispatched", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      tool_call_id: toolCallId,
      alias,
      action,
      request_id: requestId,
      replay_allowed: false,
    }));
  }

  public async haWriteOutcome(
    toolCallId: string,
    alias: string,
    action: RobotHaWriteAction,
    requestId: number | null,
    outcome: "accepted" | "completed" | "rejected" | "unknown",
    accepted: boolean | null,
  ): Promise<void> {
    await this.#store.appendEvent(this.#event(`role.ha.write.${outcome}`, {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      tool_call_id: toolCallId,
      alias,
      action,
      request_id: requestId,
      accepted,
      outcome,
      replay_allowed: false,
    }));
  }

  public async haWriteObservation(
    toolCallId: string,
    alias: string,
    action: RobotHaWriteAction,
    requestId: number | null,
    source: "subscribed_state_changed" | "already_satisfied_cache" | "reconciliation_read",
    cursor: RobotHaObservationCursor | null,
  ): Promise<void> {
    await this.#store.appendEvent(this.#event("role.ha.write.observed", {
      interaction_id: this.#interaction.interaction_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      tool_call_id: toolCallId,
      alias,
      action,
      request_id: requestId,
      observation_source: source,
      connection_generation: cursor?.connection_generation ?? null,
      observation_sequence: cursor?.sequence ?? null,
      replay_allowed: false,
    }));
  }

  public async toolResult(result: ToolResult, modelTurn: number): Promise<void> {
    const completedAtMs = this.#now();
    const message = this.#message("tool", JSON.stringify(result), {
      role_id: this.#session.role_id,
      model_turn: modelTurn,
      tool_call_id: result.tool_call_id,
      status: result.status,
    }, result.name);
    const isReadObservation = result.status === "success" && result.name === "home.get_entity";
    const event = this.#event(
      result.status === "error"
        ? "role.tool.failed"
        : isReadObservation
          ? "role.ha.observation"
          : "role.tool.completed",
      {
        interaction_id: this.#interaction.interaction_id,
        assignment_id: this.#assignment.assignment_id,
        role_id: this.#session.role_id,
        model_turn: modelTurn,
        tool_call_id: result.tool_call_id,
        name: result.name,
        status: result.status,
        error_code: result.error?.code ?? null,
        observation_source: isReadObservation ? "allowlisted_cache" : null,
      },
    );
    await this.#store.writeBatch({
      messages: [message],
      tool_results: [{ run_id: this.#runId, result, completed_at_ms: completedAtMs }],
      events: [event],
    });
  }

  public async finish(result: RoleRunResult): Promise<void> {
    const pending = await this.#pendingToolFailures(result.status);
    if (result.status === "completed" && pending.results.length > 0) {
      throw new Error("completed role run still has pending tool calls");
    }
    const completedAtMs = this.#now();
    const messages = result.final_text.length === 0
      ? []
      : [this.#message("assistant", result.final_text, {
          role_id: result.role_id,
          outcome: result.outcome,
          capability_available: result.capability_available,
        })];
    const event = this.#event(`role.run.${result.status}`, {
      interaction_id: this.#interaction.interaction_id,
      route_plan_id: this.#plan.route_plan_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: result.role_id,
      status: result.status,
      outcome: result.outcome,
      model_turns: result.model_turns,
      tool_call_count: result.tool_results.length,
      capability_available: result.capability_available,
      error_code: result.error?.code ?? null,
    });
    await this.#store.writeBatch({
      messages: [...pending.messages, ...messages],
      tool_results: pending.results.map((toolResult) => ({
        run_id: this.#runId,
        result: toolResult,
        completed_at_ms: completedAtMs,
      })),
      events: [...pending.events, event],
      run: this.#run(result.status, completedAtMs),
    });
  }

  public async fail(error: unknown): Promise<void> {
    const completedAtMs = this.#now();
    const pending = await this.#pendingToolFailures("failed");
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "INTERNAL";
    const event = this.#event("role.run.failed", {
      interaction_id: this.#interaction.interaction_id,
      route_plan_id: this.#plan.route_plan_id,
      assignment_id: this.#assignment.assignment_id,
      role_id: this.#session.role_id,
      status: "failed",
      outcome: "error",
      error_code: code,
    });
    await this.#store.writeBatch({
      messages: pending.messages,
      tool_results: pending.results.map((toolResult) => ({
        run_id: this.#runId,
        result: toolResult,
        completed_at_ms: completedAtMs,
      })),
      events: [...pending.events, event],
      run: this.#run("failed", completedAtMs),
    });
  }

  #run(status: Run["status"], completedAtMs: number | null): Run {
    return {
      run_id: this.#runId,
      session_id: this.#auditSessionId,
      status,
      started_at_ms: this.#startedAtMs,
      completed_at_ms: completedAtMs,
    };
  }

  #message(
    role: Message["role"],
    content: string,
    metadata: Record<string, unknown>,
    toolName: string | null = null,
  ): Message {
    this.#messageOrdinal += 1;
    return {
      message_id: `${this.#runId}:message:${this.#messageOrdinal}`,
      session_id: this.#auditSessionId,
      run_id: this.#runId,
      role,
      content,
      tool_name: toolName,
      created_at_ms: this.#now(),
      metadata,
    };
  }

  async #pendingToolFailures(
    status: RoleRunResult["status"],
  ): Promise<{
    readonly results: readonly ToolFailureResult[];
    readonly messages: readonly Message[];
    readonly events: readonly Event[];
  }> {
    const trace = await this.#store.getRunTrace(this.#runId);
    const pendingCalls = trace?.tool_calls.filter((call) => call.status === "pending") ?? [];
    const code = status === "cancelled"
      ? "CANCELLED"
      : status === "timed_out"
        ? "DEADLINE_EXCEEDED"
        : "INTERNAL";
    const results = pendingCalls.map((call): ToolFailureResult => ({
      schema_version: 1,
      tool_call_id: call.tool_call_id,
      name: call.name,
      status: "error",
      result: null,
      error: {
        code,
        message: `role tool call was not completed because the run ${status}`,
        retryable: false,
      },
    }));
    return {
      results,
      messages: results.map((result) => this.#message("tool", JSON.stringify(result), {
        role_id: this.#session.role_id,
        tool_call_id: result.tool_call_id,
        status: result.status,
        synthesized: true,
      }, result.name)),
      events: results.map((result) => this.#event("role.tool.failed", {
        interaction_id: this.#interaction.interaction_id,
        assignment_id: this.#assignment.assignment_id,
        role_id: this.#session.role_id,
        tool_call_id: result.tool_call_id,
        name: result.name,
        status: result.status,
        error_code: result.error.code,
        synthesized: true,
      })),
    };
  }

  #safeToolCallSummaries(message: OllamaChatMessage): readonly {
    readonly type: "function";
    readonly name: string;
  }[] {
    return (message.tool_calls ?? []).slice(0, 4).map((call) => ({
      type: "function",
      name: /^[a-z][a-z0-9_.]{0,127}$/.test(call.function.name)
        ? call.function.name
        : "<invalid>",
    }));
  }

  #event(type: string, payload: Record<string, unknown>): Event {
    this.#eventOrdinal += 1;
    return {
      event_id: `${this.#runId}:event:${this.#eventOrdinal}`,
      run_id: this.#runId,
      type,
      occurred_at_ms: this.#now(),
      payload,
    };
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("role audit clock must return a non-negative safe integer");
    }
    const next = Math.max(value, this.#lastTime + 1);
    if (!Number.isSafeInteger(next)) {
      throw new TypeError("role audit clock exhausted the safe integer range");
    }
    this.#lastTime = next;
    return this.#lastTime;
  }
}
