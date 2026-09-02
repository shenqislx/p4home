import type { OllamaProvider } from "@p4home/provider-ollama";

import {
  runRoleInteraction,
  type RunRoleInteractionResult,
} from "./role-orchestrator.ts";
import type { UserTextInteraction } from "./role-contracts.ts";
import type { RoleRunAuditOptions } from "./role-audit.ts";
import { RoleScheduler } from "./role-scheduler.ts";
import { RoleSessionRegistry } from "./role-session.ts";
import type { RobotHaReadRuntime } from "./robot-ha-read-runner.ts";
import type { RobotHaWriteRuntime } from "./robot-ha-write-runner.ts";
import type { RoleMemoryRuntime } from "./role-memory.ts";
import type { LowPriorityCatRunRegistry } from "./low-priority-cat-run-registry.ts";
import type { RoleTaskCompletionNotice } from "./role-orchestrator.ts";
import type { HumanSpeechSegment } from "./role-runner.ts";

export interface UnifiedVoiceRoleDispatcherOptions {
  readonly provider: Pick<OllamaProvider, "chat">
    & Partial<Pick<OllamaProvider, "chatStream">>;
  readonly sessions: RoleSessionRegistry;
  readonly scheduler: RoleScheduler;
  readonly timeout_ms?: number;
  readonly audit?: RoleRunAuditOptions;
  readonly audit_finalize_timeout_ms?: number;
  readonly clock?: () => number;
  readonly robot_ha?: RobotHaReadRuntime | RobotHaWriteRuntime;
  readonly memory?: RoleMemoryRuntime;
  readonly human_only?: boolean;
  readonly cat_run_registry?: LowPriorityCatRunRegistry;
  readonly on_task_complete?: (notice: RoleTaskCompletionNotice) => void;
  readonly on_result?: (
    result: RunRoleInteractionResult,
    interaction: UserTextInteraction,
  ) => void | Promise<void>;
}

/**
 * Voice final transcripts enter the exact Phase 4 Router/Orchestrator here.
 * There is deliberately no Voice-specific role classifier or Cat entrypoint.
 */
export class UnifiedVoiceRoleDispatcher {
  readonly #options: UnifiedVoiceRoleDispatcherOptions;

  public constructor(options: UnifiedVoiceRoleDispatcherOptions) {
    this.#options = options;
  }

  public async dispatch(
    interaction: UserTextInteraction,
    signal: AbortSignal,
    onHumanSpeechSegment?: (
      segment: HumanSpeechSegment,
      signal: AbortSignal | undefined,
    ) => void | Promise<void>,
  ): Promise<RunRoleInteractionResult> {
    if (interaction.source !== "voice") {
      throw new TypeError("unified voice dispatcher accepts only voice interactions");
    }
    const result = await runRoleInteraction({
      interaction,
      route_plan_id: `route:${interaction.interaction_id}`,
      run_id: `run:${interaction.interaction_id}`,
      provider: this.#options.provider,
      sessions: this.#options.sessions,
      scheduler: this.#options.scheduler,
      signal,
      ...(this.#options.timeout_ms === undefined ? {} : { timeout_ms: this.#options.timeout_ms }),
      ...(this.#options.audit === undefined ? {} : { audit: this.#options.audit }),
      ...(this.#options.audit_finalize_timeout_ms === undefined
        ? {}
        : { audit_finalize_timeout_ms: this.#options.audit_finalize_timeout_ms }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      ...(this.#options.robot_ha === undefined ? {} : { robot_ha: this.#options.robot_ha }),
      ...(this.#options.memory === undefined ? {} : { memory: this.#options.memory }),
      ...(this.#options.human_only === undefined
        ? {}
        : { human_only: this.#options.human_only }),
      ...(this.#options.cat_run_registry === undefined
        ? {}
        : { cat_run_registry: this.#options.cat_run_registry }),
      ...(this.#options.on_task_complete === undefined
        ? {}
        : { on_task_complete: this.#options.on_task_complete }),
      ...(onHumanSpeechSegment === undefined
        ? {}
        : { on_human_speech_segment: onHumanSpeechSegment }),
    });
    await this.#options.on_result?.(result, interaction);
    return result;
  }
}
