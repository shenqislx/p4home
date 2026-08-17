import { validateFrozenContracts } from "@p4home/contracts";

export * from "./text-agent.ts";
export * from "./model-config.ts";
export * from "./structured-logger.ts";
export * from "./text-agent-audit.ts";

export function runtimeHealth(): Record<string, unknown> {
  return {
    status: "ready",
    contracts: validateFrozenContracts(),
  };
}
