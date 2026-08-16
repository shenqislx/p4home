import { validateFrozenContracts } from "@p4home/contracts";

export * from "./text-agent.ts";

export function runtimeHealth(): Record<string, unknown> {
  return {
    status: "ready",
    contracts: validateFrozenContracts(),
  };
}
