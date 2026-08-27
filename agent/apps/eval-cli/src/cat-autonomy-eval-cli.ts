import {
  assessCatAutonomyEvalGate,
  evaluateCatAutonomyDeterministically,
} from "./cat-autonomy-evaluator.ts";

const report = evaluateCatAutonomyDeterministically();
const gate = assessCatAutonomyEvalGate(report);
process.stdout.write(`${JSON.stringify({ ...report, gate }, null, 2)}\n`);
if (!gate.passed) process.exitCode = 2;
