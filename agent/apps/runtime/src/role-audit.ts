import type { Event, Message, Run } from "@p4home/core";
import type { AuditStore } from "@p4home/storage-sqlite";

import type {
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
  readonly #session: RoleSession;
  #startedAtMs = 0;
  #lastTime = -1;
  #messageOrdinal = 0;
  #eventOrdinal = 0;

  public constructor(
    runId: string,
    interaction: UserTextInteraction,
    plan: RoutePlan,
    session: RoleSession,
    options: RoleRunAuditOptions,
  ) {
    this.#runId = runId;
    this.#interaction = interaction;
    this.#plan = plan;
    this.#session = session;
    this.#store = options.store;
    this.#clock = options.clock ?? Date.now;
    this.#lastTime = session.created_at_ms;
  }

  public async start(input: RoleInput): Promise<void> {
    const profile = getRoleProfile(this.#session.role_id);
    this.#startedAtMs = this.#now();
    await this.#store.saveAgentProfile({
      agent_profile_id: `role-profile-v1:${profile.role_id}`,
      name: `P4 Home ${profile.role_id}`,
      locale: "zh-CN",
      allowed_tools: profile.allowed_tools,
    });
    await this.#store.saveSession({
      session_id: this.#session.session_id,
      agent_profile_id: `role-profile-v1:${profile.role_id}`,
      created_at_ms: this.#session.created_at_ms,
      updated_at_ms: this.#startedAtMs,
    });
    const context = buildRoleContext(profile, input);
    const assignment = this.#plan.assignments[0];
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
    const event = this.#event("role.run.started", correlation);
    await this.#store.writeBatch({
      run: this.#run("running", null),
      messages,
      events: [event],
    });
  }

  public async finish(result: RoleRunResult): Promise<void> {
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
      assignment_id: this.#plan.assignments[0].assignment_id,
      role_id: result.role_id,
      status: result.status,
      outcome: result.outcome,
      model_turns: result.model_turns,
      capability_available: result.capability_available,
      error_code: result.error?.code ?? null,
    });
    await this.#store.writeBatch({
      messages,
      events: [event],
      run: this.#run(result.status, completedAtMs),
    });
  }

  public async fail(error: unknown): Promise<void> {
    const completedAtMs = this.#now();
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "INTERNAL";
    const event = this.#event("role.run.failed", {
      interaction_id: this.#interaction.interaction_id,
      route_plan_id: this.#plan.route_plan_id,
      assignment_id: this.#plan.assignments[0].assignment_id,
      role_id: this.#session.role_id,
      status: "failed",
      outcome: "error",
      error_code: code,
    });
    await this.#store.writeBatch({
      events: [event],
      run: this.#run("failed", completedAtMs),
    });
  }

  #run(status: Run["status"], completedAtMs: number | null): Run {
    return {
      run_id: this.#runId,
      session_id: this.#session.session_id,
      status,
      started_at_ms: this.#startedAtMs,
      completed_at_ms: completedAtMs,
    };
  }

  #message(
    role: Extract<Message["role"], "system" | "user" | "assistant">,
    content: string,
    metadata: Record<string, unknown>,
  ): Message {
    this.#messageOrdinal += 1;
    return {
      message_id: `${this.#runId}:message:${this.#messageOrdinal}`,
      session_id: this.#session.session_id,
      run_id: this.#runId,
      role,
      content,
      tool_name: null,
      created_at_ms: this.#now(),
      metadata,
    };
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
    this.#lastTime = Math.max(this.#lastTime, value);
    return this.#lastTime;
  }
}
