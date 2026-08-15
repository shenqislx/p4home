import { validateFrozenContracts } from "./index.ts";

process.stdout.write(`${JSON.stringify(validateFrozenContracts(), null, 2)}\n`);
