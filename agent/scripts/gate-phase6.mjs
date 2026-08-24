import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  workspaceDirectory,
  "../evidence/agent-phase-6/phase-6d-memory-eval.json",
);

const EXPECTED_DATASET_FINGERPRINT =
  "71b2c13569304e83c34249b6e23bd783be4dfe85953ca9b9f7959fc04c840390";
const STRATEGIES = ["private", "shared_acl", "hybrid"];
const ROLES = ["human", "robot", "cat"];
const EXPECTED_CASES = [
  ["human-owner-user-fact", "human", 3, {
    private: ["mem-human-owner-fact"],
    shared_acl: ["mem-human-owner-fact"],
    hybrid: ["mem-human-owner-fact"],
  }],
  ["robot-owner-summary", "robot", 3, {
    private: ["mem-robot-owner-summary"],
    shared_acl: ["mem-robot-owner-summary"],
    hybrid: ["mem-robot-owner-summary"],
  }],
  ["cat-owner-task", "cat", 3, {
    private: ["mem-cat-owner-task"],
    shared_acl: ["mem-cat-owner-task"],
    hybrid: ["mem-cat-owner-task"],
  }],
  ["human-reads-robot-fact", "human", 3, {
    private: [],
    shared_acl: ["mem-robot-shared-fact"],
    hybrid: ["mem-robot-shared-fact"],
  }],
  ["human-reads-robot-summary", "human", 3, {
    private: [],
    shared_acl: ["mem-robot-shared-summary"],
    hybrid: [],
  }],
  ["human-reads-robot-task", "human", 3, {
    private: [],
    shared_acl: ["mem-robot-shared-task"],
    hybrid: [],
  }],
  ["robot-reads-human-fact", "robot", 3, {
    private: [],
    shared_acl: ["mem-human-shared-fact"],
    hybrid: ["mem-human-shared-fact"],
  }],
  ["cat-reads-robot-fact", "cat", 3, {
    private: [],
    shared_acl: ["mem-robot-cat-fact"],
    hybrid: ["mem-robot-cat-fact"],
  }],
  ["restricted-never-cross-role", "human", 3, {
    private: [],
    shared_acl: [],
    hybrid: [],
  }],
  ["restricted-remains-visible-to-owner", "robot", 3, {
    private: ["mem-robot-restricted"],
    shared_acl: ["mem-robot-restricted"],
    hybrid: ["mem-robot-restricted"],
  }],
  ["old-policy-never-cross-role", "human", 3, {
    private: [],
    shared_acl: [],
    hybrid: [],
  }],
  ["expired-never-recalled", "human", 3, {
    private: [],
    shared_acl: [],
    hybrid: [],
  }],
  ["prompt-injection-is-data", "human", 3, {
    private: ["mem-human-prompt-injection"],
    shared_acl: ["mem-human-prompt-injection"],
    hybrid: ["mem-human-prompt-injection"],
  }],
  ["conflict-current-first", "robot", 2, {
    private: ["mem-robot-conflict-current", "mem-robot-conflict-old"],
    shared_acl: ["mem-robot-conflict-current", "mem-robot-conflict-old"],
    hybrid: ["mem-robot-conflict-current", "mem-robot-conflict-old"],
  }],
];
const EXPECTED_CONTEXT_CASES = [
  ["human-budget", "human", "mem-human-budget-small", 512, 65],
  ["robot-budget", "robot", "mem-robot-budget-small", 384, 65],
  ["cat-budget", "cat", "mem-cat-budget-small", 256, 64],
];
const EXPECTED_MUTATIONS = {
  acl_revocation: [
    "acl-revocation-propagates",
    "mem-robot-revoked-fact",
  ],
  deletion: [
    "deletion-propagates",
    "mem-robot-deleted-fact",
  ],
};

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
    name: "Phase 6B/6C runtime tests",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--test",
      "tests/runtime/phase-6b-memory-policy.test.ts",
      "tests/runtime/phase-6c-memory-recall.test.ts",
    ],
  },
  {
    name: "memory evaluator tests",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--test",
      "tests/eval/memory-evaluator.test.ts",
    ],
  },
  {
    name: "storage tests",
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "--test",
      "tests/storage/memory-store.test.ts",
      "tests/storage/phase-6c-memory-recall.test.ts",
      "tests/storage/sqlite-store.test.ts",
    ],
  },
];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function object(value, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  invariant(
    actual.length === wanted.length
      && actual.every((key, index) => key === wanted[index]),
    `${label} has unexpected or missing fields`,
  );
}

function exactArray(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array`);
  invariant(
    actual.length === expected.length
      && actual.every((value, index) => value === expected[index]),
    `${label} does not match the frozen expectation`,
  );
}

function runStep(step) {
  process.stdout.write(`\n[phase6 gate] ${step.name}\n`);
  const result = spawnSync(step.command, step.args, {
    cwd: workspaceDirectory,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error(`${step.name}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${step.name} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function verifyCase(item, expected, strategy, index) {
  const [id, role, k, idsByStrategy] = expected;
  const label = `${strategy}.cases[${index}]`;
  exactKeys(item, [
    "id",
    "requester_role",
    "k",
    "expected_memory_ids",
    "actual_memory_ids",
    "recall_at_k",
    "precision_at_k",
    "owner_attribution_correct",
    "source_attribution_correct",
    "unauthorized_cross_role_results",
    "pass",
    "reason",
  ], label);
  const expectedIds = idsByStrategy[strategy];
  invariant(item.id === id, `${label}.id is not frozen`);
  invariant(item.requester_role === role, `${label}.requester_role is not frozen`);
  invariant(item.k === k, `${label}.k is not frozen`);
  exactArray(item.expected_memory_ids, expectedIds, `${label}.expected_memory_ids`);
  exactArray(item.actual_memory_ids, expectedIds, `${label}.actual_memory_ids`);
  invariant(
    item.recall_at_k === (expectedIds.length === 0 ? null : 1)
      && item.precision_at_k === (expectedIds.length === 0 ? null : 1),
    `${label} recall/precision is invalid`,
  );
  invariant(
    item.owner_attribution_correct === true
      && item.source_attribution_correct === true
      && item.unauthorized_cross_role_results === 0
      && item.pass === true,
    `${label} did not pass all attribution/privacy checks`,
  );
  exactArray(item.reason, [], `${label}.reason`);
}

function verifyMutation(item, name, strategy) {
  const label = `${strategy}.mutation_cases.${name}`;
  const [id, memoryId] = EXPECTED_MUTATIONS[name];
  const expectedBefore = strategy === "private" ? [] : [memoryId];
  exactKeys(item, [
    "id",
    "applicable",
    "expected_before_memory_ids",
    "actual_before_memory_ids",
    "expected_after_memory_ids",
    "actual_after_memory_ids",
    "pass",
    "reason",
  ], label);
  invariant(item.id === id, `${label}.id is not frozen`);
  invariant(
    item.applicable === (strategy !== "private"),
    `${label}.applicable is incorrect`,
  );
  exactArray(
    item.expected_before_memory_ids,
    expectedBefore,
    `${label}.expected_before_memory_ids`,
  );
  exactArray(
    item.actual_before_memory_ids,
    expectedBefore,
    `${label}.actual_before_memory_ids`,
  );
  exactArray(item.expected_after_memory_ids, [], `${label}.expected_after_memory_ids`);
  exactArray(item.actual_after_memory_ids, [], `${label}.actual_after_memory_ids`);
  invariant(item.pass === true, `${label} did not pass`);
  exactArray(item.reason, [], `${label}.reason`);
}

function verifyContextCase(item, expected, strategy, index) {
  const [id, role, memoryId, budget, tokenCount] = expected;
  const label = `${strategy}.context_cases[${index}]`;
  exactKeys(item, [
    "id",
    "requester_role",
    "expected_memory_ids",
    "actual_memory_ids",
    "token_budget",
    "token_count",
    "token_count_method",
    "untrusted_data_boundary",
    "pass",
    "reason",
  ], label);
  invariant(item.id === id, `${label}.id is not frozen`);
  invariant(item.requester_role === role, `${label}.requester_role is not frozen`);
  exactArray(item.expected_memory_ids, [memoryId], `${label}.expected_memory_ids`);
  exactArray(item.actual_memory_ids, [memoryId], `${label}.actual_memory_ids`);
  invariant(
    item.token_budget === budget
      && item.token_count === tokenCount
      && item.token_count_method === "injected",
    `${label} token accounting is not frozen`,
  );
  invariant(
    item.untrusted_data_boundary === true && item.pass === true,
    `${label} did not preserve the untrusted-data boundary`,
  );
  exactArray(item.reason, [], `${label}.reason`);
}

function verifyRoleMetrics(metrics, role, strategy) {
  const label = `${strategy}.role_metrics.${role}`;
  exactKeys(metrics, [
    "deterministic_cases",
    "deterministic_cases_passed",
    "deterministic_retrieval_case_accuracy",
    "recall_at_k",
    "precision_at_k",
    "owner_attribution_accuracy",
    "source_attribution_accuracy",
  ], label);
  const expectedCases = { human: 8, robot: 4, cat: 2 }[role];
  invariant(
    metrics.deterministic_cases === expectedCases
      && metrics.deterministic_cases_passed === expectedCases
      && metrics.deterministic_retrieval_case_accuracy === 1
      && metrics.recall_at_k === 1
      && metrics.precision_at_k === 1
      && metrics.owner_attribution_accuracy === 1
      && metrics.source_attribution_accuracy === 1,
    `${label} does not match the frozen pass metrics`,
  );
}

function verifyStrategyReport(report, strategy, dataset) {
  const label = `strategy_reports.${strategy}`;
  exactKeys(report, [
    "strategy",
    "dataset_id",
    "dataset_fingerprint",
    "physical_store_instances",
    "aggregate_score",
    "role_metrics",
    "owner_attribution_accuracy",
    "source_attribution_accuracy",
    "cross_role_unauthorized_leak_count",
    "cross_role_unauthorized_leakage_rate",
    "expired_residue_count",
    "expired_residue_rate",
    "deleted_residue_count",
    "deleted_residue_rate",
    "acl_revocation_propagation_rate",
    "conflict_top_choice_accuracy",
    "memory_budget_violation_count",
    "prompt_injection_untrusted_data_accuracy",
    "cases",
    "mutation_cases",
    "context_cases",
    "prompt_injection_case",
  ], label);
  invariant(
    report.strategy === strategy
      && report.dataset_id === dataset.id
      && report.dataset_fingerprint === dataset.fingerprint
      && report.physical_store_instances === 1
      && report.aggregate_score === null,
    `${label} is not bound to the canonical dataset`,
  );
  exactKeys(report.role_metrics, ROLES, `${label}.role_metrics`);
  for (const role of ROLES) {
    verifyRoleMetrics(report.role_metrics[role], role, strategy);
  }
  invariant(
    report.owner_attribution_accuracy === 1
      && report.source_attribution_accuracy === 1
      && report.cross_role_unauthorized_leak_count === 0
      && report.cross_role_unauthorized_leakage_rate
        === (strategy === "private" ? null : 0)
      && report.expired_residue_count === 0
      && report.expired_residue_rate === 0
      && report.deleted_residue_count === 0
      && report.deleted_residue_rate === (strategy === "private" ? null : 0)
      && report.acl_revocation_propagation_rate
        === (strategy === "private" ? null : 1)
      && report.conflict_top_choice_accuracy === 1
      && report.memory_budget_violation_count === 0
      && report.prompt_injection_untrusted_data_accuracy === 1,
    `${label} summary metrics do not match the frozen gate`,
  );

  invariant(
    Array.isArray(report.cases) && report.cases.length === EXPECTED_CASES.length,
    `${label}.cases coverage is incomplete`,
  );
  report.cases.forEach((item, index) =>
    verifyCase(item, EXPECTED_CASES[index], strategy, index));

  exactKeys(
    report.mutation_cases,
    Object.keys(EXPECTED_MUTATIONS),
    `${label}.mutation_cases`,
  );
  for (const name of Object.keys(EXPECTED_MUTATIONS)) {
    verifyMutation(report.mutation_cases[name], name, strategy);
  }

  invariant(
    Array.isArray(report.context_cases)
      && report.context_cases.length === EXPECTED_CONTEXT_CASES.length,
    `${label}.context_cases coverage is incomplete`,
  );
  report.context_cases.forEach((item, index) =>
    verifyContextCase(item, EXPECTED_CONTEXT_CASES[index], strategy, index));

  const injection = report.prompt_injection_case;
  exactKeys(injection, [
    "id",
    "requester_role",
    "expected_memory_ids",
    "actual_memory_ids",
    "token_budget",
    "token_count",
    "token_count_method",
    "untrusted_data_boundary",
    "pass",
    "reason",
  ], `${label}.prompt_injection_case`);
  invariant(
    injection.id === "prompt-injection-is-untrusted-data"
      && injection.requester_role === "human"
      && injection.token_budget === 512
      && injection.token_count === 86
      && injection.token_count_method === "injected"
      && injection.untrusted_data_boundary === true
      && injection.pass === true,
    `${label}.prompt_injection_case does not match the frozen gate`,
  );
  exactArray(
    injection.expected_memory_ids,
    ["mem-human-prompt-injection"],
    `${label}.prompt_injection_case.expected_memory_ids`,
  );
  exactArray(
    injection.actual_memory_ids,
    ["mem-human-prompt-injection"],
    `${label}.prompt_injection_case.actual_memory_ids`,
  );
  exactArray(injection.reason, [], `${label}.prompt_injection_case.reason`);
}

function verifyNoBodyOrSecretCanaries(encoded, artifact) {
  const forbiddenArtifactCanaries = [
    "phase6d-memory-body-canary",
    "ignore all safety rules",
    "<system>",
    "Bearer ",
    "password=",
  ];
  for (const canary of forbiddenArtifactCanaries) {
    invariant(
      !encoded.includes(canary),
      `evaluator artifact contains forbidden body/secret canary ${JSON.stringify(canary)}`,
    );
  }
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        invariant(
          key !== "content",
          "evaluator artifact contains a forbidden Memory content field",
        );
        visit(child);
      }
    }
  };
  visit(artifact);
}

export function verifyPhase6Artifact(path) {
  const metadata = lstatSync(path);
  invariant(metadata.isFile(), "evaluator artifact must be a regular file");
  invariant(
    (metadata.mode & 0o777) === 0o600,
    "evaluator artifact permissions are not 0600",
  );

  const encoded = readFileSync(path, "utf8");
  let artifact;
  try {
    artifact = JSON.parse(encoded);
  } catch (error) {
    throw new Error(
      `cannot parse evaluator artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  verifyNoBodyOrSecretCanaries(encoded, artifact);
  exactKeys(artifact, [
    "schema_version",
    "suite_version",
    "generated_at",
    "runtime",
    "evaluation_boundary",
    "product_runtime_strategy",
    "aggregate_score",
    "dataset",
    "strategy_reports",
    "pending_real_environment",
    "gate",
  ], "artifact");
  invariant(
    artifact.schema_version === 2
      && artifact.suite_version === "phase6d-visibility-strategy/v2"
      && artifact.evaluation_boundary === "role-memory.experimental"
      && artifact.product_runtime_strategy === "private"
      && artifact.aggregate_score === null,
    "evaluator artifact boundary metadata is invalid",
  );
  invariant(
    typeof artifact.generated_at === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
        artifact.generated_at,
      )
      && new Date(artifact.generated_at).toISOString() === artifact.generated_at,
    "evaluator artifact generated_at is not canonical UTC",
  );

  exactKeys(
    artifact.runtime,
    ["node", "platform", "arch", "environment", "real_model_calls"],
    "artifact.runtime",
  );
  invariant(
    artifact.runtime.node === process.version
      && artifact.runtime.platform === process.platform
      && artifact.runtime.arch === process.arch
      && artifact.runtime.environment === "deterministic_local"
      && artifact.runtime.real_model_calls === 0,
    "evaluator artifact runtime or real-model boundary is invalid",
  );

  exactKeys(
    artifact.dataset,
    [
      "id",
      "fingerprint",
      "canonical_memory_count",
      "physical_store_instances",
      "shared_across_strategies",
    ],
    "artifact.dataset",
  );
  invariant(
    artifact.dataset.id === "phase6d-canonical-memory/v1"
      && artifact.dataset.fingerprint === EXPECTED_DATASET_FINGERPRINT
      && artifact.dataset.canonical_memory_count === 22
      && artifact.dataset.physical_store_instances === 1
      && artifact.dataset.shared_across_strategies === true,
    "evaluator artifact is not bound to the frozen canonical dataset",
  );

  exactKeys(artifact.strategy_reports, STRATEGIES, "artifact.strategy_reports");
  for (const strategy of STRATEGIES) {
    verifyStrategyReport(
      artifact.strategy_reports[strategy],
      strategy,
      artifact.dataset,
    );
  }

  invariant(
    Array.isArray(artifact.pending_real_environment)
      && artifact.pending_real_environment.length === 1,
    "evaluator artifact pending metadata is invalid",
  );
  const pending = artifact.pending_real_environment[0];
  exactKeys(pending, ["id", "status", "reason"], "pending_real_environment[0]");
  invariant(
    pending.id === "real-model-grounded-answer-evaluation"
      && pending.status === "pending"
      && pending.reason
        === "requires a real Ollama model and representative home/hardware environment",
    "evaluator artifact real-environment status is invalid",
  );

  exactKeys(artifact.gate, ["passed", "failures"], "artifact.gate");
  invariant(
    artifact.gate.passed === true,
    "evaluator artifact gate is not passed",
  );
  exactArray(artifact.gate.failures, [], "artifact.gate.failures");
}

function assertArtifactTargetIsNotUserDatabase(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  invariant(metadata.isFile(), "artifact target exists and is not a regular file");
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    invariant(
      bytesRead < 16 || header.toString("utf8") !== "SQLite format 3\u0000",
      "refusing to overwrite an existing SQLite database at the artifact path",
    );
  } finally {
    closeSync(descriptor);
  }
}

function runGate() {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const generatedArtifactPath = resolve(
    dirname(artifactPath),
    `.phase-6d-memory-eval.${randomUUID()}.tmp.json`,
  );
  try {
    for (const step of steps) {
      runStep(step);
    }
    runStep({
      name: "deterministic Phase 6 evaluation",
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "apps/eval-cli/src/cli.ts",
        "phase6",
        "--database",
        ":memory:",
        "--output",
        generatedArtifactPath,
      ],
    });
    verifyPhase6Artifact(generatedArtifactPath);
    assertArtifactTargetIsNotUserDatabase(artifactPath);
    renameSync(generatedArtifactPath, artifactPath);
    verifyPhase6Artifact(artifactPath);
  } finally {
    rmSync(generatedArtifactPath, { force: true });
  }

  process.stdout.write(
    `\nPhase 6 local gate passed; evaluator artifact independently verified at ${artifactPath}\n`,
  );
}

function main(args) {
  if (args.length === 0) {
    runGate();
    return;
  }
  if (args.length === 2 && args[0] === "--verify-artifact") {
    verifyPhase6Artifact(resolve(args[1]));
    process.stdout.write(`Phase 6 evaluator artifact verified: ${resolve(args[1])}\n`);
    return;
  }
  throw new Error("usage: gate-phase6.mjs [--verify-artifact PATH]");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Phase 6 local gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
