import { validateFrozenContracts } from "@p4home/contracts";

export * from "./text-agent.ts";
export * from "./cat-event-policy.ts";
export * from "./cat-action-runner.ts";
export * from "./deterministic-fake-device.ts";
export * from "./device-action-adapter.ts";
export * from "./device-protocol.ts";
export * from "./device-websocket-server.ts";
export * from "./model-config.ts";
export * from "./role-contracts.ts";
export * from "./role-audit.ts";
export * from "./role-orchestrator.ts";
export * from "./role-profiles.ts";
export * from "./role-response-policy.ts";
export * from "./role-router.ts";
export * from "./role-runner.ts";
export * from "./role-scheduler.ts";
export * from "./role-session.ts";
export * from "./structured-logger.ts";
export * from "./text-agent-audit.ts";

export function runtimeHealth(): Record<string, unknown> {
  return {
    status: "ready",
    contracts: validateFrozenContracts(),
  };
}
