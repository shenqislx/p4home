import { validateObjectRuntimeContracts } from "./object-runtime-contracts.ts";

process.stdout.write(`${JSON.stringify(validateObjectRuntimeContracts(), null, 2)}\n`);
