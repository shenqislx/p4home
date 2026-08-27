import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assessCatAutonomyEvalGate,
  evaluateCatAutonomyDeterministically,
} from "../apps/eval-cli/src/cat-autonomy-evaluator.ts";

const workspaceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  workspaceDirectory,
  "../evidence/agent-phase-7/phase-7b-autonomy-eval.json",
);

const steps = [
  {
    name: "runtime preflight",
    command: process.execPath,
    args: ["scripts/check-runtime.mjs"],
  },
  {
    name: "typecheck",
    command: "pnpm",
    args: ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"],
  },
  {
    name: "Phase 7 runtime and preemption tests",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--test",
      "tests/runtime/phase-7a-cat-autonomy-policy.test.ts",
      "tests/runtime/phase-7c-product-autonomy.test.ts",
      "tests/runtime/phase-2b.test.ts",
      "tests/runtime/phase-2d-transport.test.ts",
      "tests/runtime/role-execution.test.ts",
      "tests/runtime/role-scheduler.test.ts",
    ],
  },
  {
    name: "Phase 7 deterministic evaluator tests",
    command: process.execPath,
    args: ["--import", "tsx", "--test", "tests/eval/cat-autonomy-evaluator.test.ts"],
  },
];

const runtimeSourcePaths = [
  "apps/runtime/src/cat-autonomy-policy.ts",
  "apps/runtime/src/cat-autonomy-runtime.ts",
  "apps/runtime/src/product-cat-autonomy.ts",
  "apps/runtime/src/cat-action-runner.ts",
  "apps/runtime/src/role-scheduler.ts",
];

function runStep(step) {
  process.stdout.write(`\n[phase7 gate] ${step.name}\n`);
  const result = spawnSync(step.command, step.args, {
    cwd: workspaceDirectory,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${step.name} exited with status ${result.status ?? "unknown"}`);
  }
}

function assertNoPollingLoop() {
  const findings = [];
  for (const relativePath of runtimeSourcePaths) {
    const source = readFileSync(resolve(workspaceDirectory, relativePath), "utf8");
    if (/while\s*\(\s*true\s*\)/u.test(source)) findings.push(`${relativePath}:while_true`);
    if (/setInterval\s*\(/u.test(source)) findings.push(`${relativePath}:set_interval`);
    if (/ask_llm/u.test(source)) findings.push(`${relativePath}:ask_llm`);
  }
  if (findings.length > 0) {
    throw new Error(`Phase 7 polling-loop gate failed: ${findings.join(", ")}`);
  }
  return {
    inspected_files: runtimeSourcePaths,
    while_true_count: 0,
    set_interval_count: 0,
    ask_llm_loop_count: 0,
  };
}

function writePrivateArtifact(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = resolve(dirname(path), `.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

for (const step of steps) runStep(step);
const staticRuntime = assertNoPollingLoop();
const report = evaluateCatAutonomyDeterministically();
const gate = assessCatAutonomyEvalGate(report);
if (!gate.passed) {
  throw new Error(`Phase 7 deterministic gate failed: ${gate.failures.join(", ")}`);
}
const artifact = {
  ...report,
  static_runtime: staticRuntime,
  gate,
};
writePrivateArtifact(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`\n[phase7 gate] PASS\nartifact: ${artifactPath}\n`);
