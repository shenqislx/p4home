import { validateHaRuntimeContracts } from "./ha-runtime-contracts.ts";

process.stdout.write(`${JSON.stringify(validateHaRuntimeContracts(), null, 2)}\n`);
