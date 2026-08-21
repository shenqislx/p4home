import type { OllamaProvider } from "@p4home/provider-ollama";

import type { RoleRunAuditOptions } from "./role-audit.ts";
import {
  assertContractId,
  type UserTextInteraction,
} from "./role-contracts.ts";
import {
  routeInteraction,
  type RouteInteractionResult,
} from "./role-router.ts";
import {
  runAssignedRole,
  type RoleRunResult,
} from "./role-runner.ts";
import { RoleScheduler } from "./role-scheduler.ts";
import { RoleSessionRegistry } from "./role-session.ts";
import type { RobotHaReadRuntime } from "./robot-ha-read-runner.ts";
import type { RobotHaWriteRuntime } from "./robot-ha-write-runner.ts";

export interface RunRoleInteractionOptions {
  readonly interaction: UserTextInteraction;
  readonly route_plan_id: string;
  readonly run_id: string;
  readonly provider: Pick<OllamaProvider, "chat">;
  readonly sessions: RoleSessionRegistry;
  readonly scheduler: RoleScheduler;
  readonly timeout_ms?: number;
  readonly signal?: AbortSignal;
  readonly audit?: RoleRunAuditOptions;
  readonly clock?: () => number;
  readonly robot_ha?: RobotHaReadRuntime | RobotHaWriteRuntime;
}

export interface RunRoleInteractionResult {
  readonly routing: RouteInteractionResult;
  readonly run: RoleRunResult;
}

/**
 * Product-facing Phase 2A composition boundary. Device and transport adapters
 * should enter through this function instead of calling runAssignedRole
 * directly, so bounded scheduling and role-specific sessions cannot be skipped.
 */
export async function runRoleInteraction(
  options: RunRoleInteractionOptions,
): Promise<RunRoleInteractionResult> {
  assertContractId(options.run_id, "run_id");
  if (
    options.timeout_ms !== undefined
    && (!Number.isInteger(options.timeout_ms) || options.timeout_ms < 100 || options.timeout_ms > 600_000)
  ) {
    throw new TypeError("timeout_ms must be an integer between 100 and 600000");
  }
  const routing = await routeInteraction({
    interaction: options.interaction,
    route_plan_id: options.route_plan_id,
    provider: options.provider,
    ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const assignment = routing.plan.assignments[0];
  const run = await options.scheduler.schedule({
    role_id: assignment.role_id,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    execute: async () => await runAssignedRole({
      run_id: options.run_id,
      interaction: options.interaction,
      plan: routing.plan,
      session: options.sessions.get(assignment.role_id),
      provider: options.provider,
      ...(options.timeout_ms === undefined ? {} : { timeout_ms: options.timeout_ms }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.audit === undefined ? {} : { audit: options.audit }),
      ...(options.robot_ha === undefined ? {} : { robot_ha: options.robot_ha }),
    }),
  });
  return { routing, run };
}
