import { validateFrozenContracts } from "@p4home/contracts";

export function runtimeHealth(): Record<string, unknown> {
  return {
    status: "ready",
    contracts: validateFrozenContracts(),
  };
}
