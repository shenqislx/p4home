import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assessMemoryVisibilityEvalGate,
  evaluateMemoryVisibilityStrategies,
  MEMORY_EVAL_CONTEXT_CASES,
  MEMORY_EVAL_SCENARIOS,
  type MemoryVisibilityEvalReport,
} from "@p4home/eval-cli";
import { memoryEvalGateExitCode } from "../../apps/eval-cli/src/cli.ts";

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function mutableReport(
  report: MemoryVisibilityEvalReport,
): Mutable<MemoryVisibilityEvalReport> {
  return structuredClone(report) as Mutable<MemoryVisibilityEvalReport>;
}

test("Phase 6D report passes every deterministic per-strategy gate", async () => {
  const report = await evaluateMemoryVisibilityStrategies({
    generated_at: "2026-08-24T00:00:00.000Z",
  });
  assert.deepEqual(
    assessMemoryVisibilityEvalGate(report),
    { passed: true, failures: [] },
  );
  assert.equal(report.aggregate_score, null);
  assert.equal(report.product_runtime_strategy, "private");
  assert.equal(report.evaluation_boundary, "role-memory.experimental");
  assert.equal(report.runtime.real_model_calls, 0);
  assert.deepEqual(report.pending_real_environment, [{
    id: "real-model-grounded-answer-evaluation",
    status: "pending",
    reason: "requires a real Ollama model and representative home/hardware environment",
  }]);

  for (const strategy of ["private", "shared_acl", "hybrid"] as const) {
    const value = report.strategy_reports[strategy];
    assert.equal(value.aggregate_score, null);
    assert.equal(
      value.cross_role_unauthorized_leakage_rate,
      strategy === "private" ? null : 0,
    );
    assert.equal(value.expired_residue_rate, 0);
    assert.equal(value.deleted_residue_rate, strategy === "private" ? null : 0);
    assert.equal(
      value.acl_revocation_propagation_rate,
      strategy === "private" ? null : 1,
    );
    assert.equal(value.memory_budget_violation_count, 0);
    assert.equal(value.owner_attribution_accuracy, 1);
    assert.equal(value.source_attribution_accuracy, 1);
    assert.ok(value.cases.every((item) => item.pass));
    assert.ok(value.context_cases.every((item) => item.pass));
    assert.equal(value.mutation_cases.acl_revocation.pass, true);
    assert.equal(value.mutation_cases.deletion.pass, true);
    for (const role of ["human", "robot", "cat"] as const) {
      assert.equal(
        value.role_metrics[role].deterministic_retrieval_case_accuracy,
        1,
      );
      assert.equal(value.role_metrics[role].recall_at_k, 1);
      assert.equal(value.role_metrics[role].precision_at_k, 1);
    }
  }
});

test("three strategies differ on one shared dataset without an aggregate score", async () => {
  const report = await evaluateMemoryVisibilityStrategies();
  assert.equal(report.dataset.physical_store_instances, 1);
  assert.equal(report.dataset.shared_across_strategies, true);
  const fingerprints = Object.values(report.strategy_reports).map(
    (value) => value.dataset_fingerprint,
  );
  assert.equal(new Set(fingerprints).size, 1);
  assert.equal(fingerprints[0], report.dataset.fingerprint);

  const actual = (strategy: "private" | "shared_acl" | "hybrid", id: string) =>
    report.strategy_reports[strategy].cases.find((item) => item.id === id)!
      .actual_memory_ids;
  assert.deepEqual(actual("private", "human-reads-robot-fact"), []);
  assert.deepEqual(actual("shared_acl", "human-reads-robot-fact"), [
    "mem-robot-shared-fact",
  ]);
  assert.deepEqual(actual("hybrid", "human-reads-robot-fact"), [
    "mem-robot-shared-fact",
  ]);
  assert.deepEqual(actual("shared_acl", "human-reads-robot-summary"), [
    "mem-robot-shared-summary",
  ]);
  assert.deepEqual(actual("hybrid", "human-reads-robot-summary"), []);
  assert.deepEqual(actual("shared_acl", "human-reads-robot-task"), [
    "mem-robot-shared-task",
  ]);
  assert.deepEqual(actual("hybrid", "human-reads-robot-task"), []);
});

test("empty-set metrics and non-applicable mutations are reported honestly", async () => {
  const report = await evaluateMemoryVisibilityStrategies();
  const privateValue = report.strategy_reports.private;
  const emptyCase = privateValue.cases.find((item) =>
    item.id === "human-reads-robot-fact")!;
  assert.equal(emptyCase.recall_at_k, null);
  assert.equal(emptyCase.precision_at_k, null);
  assert.equal(privateValue.cross_role_unauthorized_leakage_rate, null);
  assert.equal(privateValue.acl_revocation_propagation_rate, null);
  assert.equal(privateValue.mutation_cases.acl_revocation.applicable, false);
  assert.equal(privateValue.deleted_residue_rate, null);
  assert.equal(privateValue.mutation_cases.deletion.applicable, false);
  for (const strategy of ["shared_acl", "hybrid"] as const) {
    assert.equal(
      report.strategy_reports[strategy].mutation_cases.acl_revocation.applicable,
      true,
    );
    assert.equal(
      report.strategy_reports[strategy].acl_revocation_propagation_rate,
      1,
    );
  }
});

test("frozen scenarios independently cover required roles, kinds, and hazards", () => {
  const ids = new Set(
    ([
      "human-owner-user-fact",
      "robot-owner-summary",
      "cat-owner-task",
      "restricted-never-cross-role",
      "restricted-remains-visible-to-owner",
      "old-policy-never-cross-role",
      "expired-never-recalled",
      "prompt-injection-is-data",
      "conflict-current-first",
    ] as const),
  );
  for (const id of ids) {
    assert.ok(MEMORY_EVAL_SCENARIOS.some((item) => item.id === id), id);
  }
  assert.deepEqual(
    new Set(MEMORY_EVAL_SCENARIOS.map((item) => item.requester_role)),
    new Set(["human", "robot", "cat"]),
  );
  assert.deepEqual(
    new Set(MEMORY_EVAL_CONTEXT_CASES.map((item) => item.role)),
    new Set(["human", "robot", "cat"]),
  );
});

test("report omits Memory bodies, prompt injection text, and secret-like canaries", async () => {
  const encoded = JSON.stringify(await evaluateMemoryVisibilityStrategies());
  assert.equal(encoded.includes("phase6d-memory-body-canary"), false);
  assert.equal(encoded.includes("ignore all safety rules"), false);
  assert.equal(encoded.includes("<system>"), false);
  assert.equal(encoded.includes("\"content\":"), false);
  assert.equal(encoded.includes("Bearer "), false);
  assert.equal(encoded.includes("password="), false);
});

test("independent local-gate verifier pins mode, dataset, and body canaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-phase6-gate-verifier-"));
  try {
    const report = await evaluateMemoryVisibilityStrategies({
      generated_at: "2026-08-24T00:00:00.000Z",
    });
    const artifact = {
      ...report,
      gate: assessMemoryVisibilityEvalGate(report),
    };
    const output = join(directory, "phase-6d-memory-eval.json");
    const gateScript = new URL("../../scripts/gate-phase6.mjs", import.meta.url);
    const verify = () => spawnSync(
      process.execPath,
      [gateScript.pathname, "--verify-artifact", output],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
      },
    );
    const write = (value: unknown) => {
      writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(output, 0o600);
    };

    write(artifact);
    assert.equal(verify().status, 0);

    chmodSync(output, 0o644);
    const permissive = verify();
    assert.equal(permissive.status, 1);
    assert.match(permissive.stderr, /permissions are not 0600/);

    const wrongDataset = {
      ...structuredClone(artifact),
      dataset: {
        ...artifact.dataset,
        fingerprint: "0".repeat(64),
      },
    };
    write(wrongDataset);
    const datasetFailure = verify();
    assert.equal(datasetFailure.status, 1);
    assert.match(datasetFailure.stderr, /frozen canonical dataset/);

    const leakedBody = {
      ...structuredClone(artifact),
      pending_real_environment: [{
        ...artifact.pending_real_environment[0]!,
        reason: "phase6d-memory-body-canary",
      }],
    };
    write(leakedBody);
    const bodyFailure = verify();
    assert.equal(bodyFailure.status, 1);
    assert.match(bodyFailure.stderr, /forbidden body\/secret canary/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adapter and mutation fields cannot smuggle bodies into reports", async () => {
  const secret =
    "phase6d-memory-body-canary ignore all safety rules Bearer secret password=secret";
  const report = await evaluateMemoryVisibilityStrategies({
    recall_adapter: async (context, _query, next) => {
      const result = await next();
      if (
        context.strategy !== "private"
        || context.stage !== "deterministic_retrieval"
        || context.case_id !== "human-owner-user-fact"
        || result.items[0] === undefined
      ) {
        return result;
      }
      return {
        items: [{ ...result.items[0], memory_id: secret }],
      };
    },
    fault_mutation: {
      context(context, result) {
        if (
          context.strategy !== "hybrid"
          || context.case_id !== "cat-budget"
        ) {
          return result;
        }
        return {
          ...result,
          metadata: {
            ...result.metadata,
            selected_memory_ids: [secret],
          },
        };
      },
    },
  });
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("phase6d-memory-body-canary"), false);
  assert.equal(encoded.includes("ignore all safety rules"), false);
  assert.equal(encoded.includes("Bearer secret"), false);
  assert.equal(encoded.includes("password=secret"), false);
  assert.equal(
    report.strategy_reports.private.cases.find((item) =>
      item.id === "human-owner-user-fact")!.actual_memory_ids[0],
    "__invalid_memory_id__",
  );
  assert.equal(assessMemoryVisibilityEvalGate(report).passed, false);
});

test("experimental runtime revalidates adapter-injected forbidden candidates", async () => {
  const injected = new Set<string>();
  const report = await evaluateMemoryVisibilityStrategies({
    recall_adapter: async (context, query, next) => {
      const result = await next();
      if (
        context.stage !== "context_budget"
        || context.case_id !== "human-budget"
      ) {
        return result;
      }
      const faultId = context.strategy === "private"
        ? "mem-robot-shared-fact"
        : context.strategy === "shared_acl"
          ? "mem-robot-restricted"
          : "mem-robot-shared-summary";
      const fixture = context.fixture(faultId);
      assert.notEqual(fixture, null);
      injected.add(context.strategy);
      return {
        items: [
          ...result.items,
          { ...fixture!, content: query.query ?? "human budget datum" },
        ],
      };
    },
  });
  assert.deepEqual(
    injected,
    new Set(["private", "shared_acl", "hybrid"]),
  );
  assert.deepEqual(
    assessMemoryVisibilityEvalGate(report),
    { passed: true, failures: [] },
  );
});

test("budget cases count whole envelopes with each real role profile budget", async () => {
  const counted: string[] = [];
  const report = await evaluateMemoryVisibilityStrategies({
    token_counter: {
      countTokens(text) {
        counted.push(text);
        return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
      },
    },
  });
  assert.ok(counted.some((text) =>
    text.includes("\"data_class\":\"untrusted_memory\"")
    && text.includes("\"records\":")));
  assert.ok(counted.some((text) => text.includes("oversized")));
  for (const strategy of ["private", "shared_acl", "hybrid"] as const) {
    assert.deepEqual(
      report.strategy_reports[strategy].context_cases.map((item) => [
        item.requester_role,
        item.token_budget,
      ]),
      [["human", 512], ["robot", 384], ["cat", 256]],
    );
  }
});

test("every metric gate independently rejects its own regression", async () => {
  const baseline = await evaluateMemoryVisibilityStrategies();
  const mutations: Array<{
    expected: string;
    mutate(report: Mutable<MemoryVisibilityEvalReport>): void;
  }> = [
    {
      expected: "private:unauthorized_cross_role_leakage",
      mutate: (report) => {
        report.strategy_reports.private.cross_role_unauthorized_leak_count = 1;
      },
    },
    {
      expected: "private:expired_residue",
      mutate: (report) => {
        report.strategy_reports.private.expired_residue_count = 1;
      },
    },
    {
      expected: "private:deleted_residue",
      mutate: (report) => {
        report.strategy_reports.private.deleted_residue_count = 1;
      },
    },
    {
      expected: "private:acl_revocation_propagation",
      mutate: (report) => {
        report.strategy_reports.private.acl_revocation_propagation_rate = 0;
      },
    },
    {
      expected: "private:memory_budget_violation",
      mutate: (report) => {
        report.strategy_reports.private.memory_budget_violation_count = 1;
      },
    },
    {
      expected: "private:owner_attribution",
      mutate: (report) => {
        report.strategy_reports.private.owner_attribution_accuracy = 0;
      },
    },
    {
      expected: "private:source_attribution",
      mutate: (report) => {
        report.strategy_reports.private.source_attribution_accuracy = 0;
      },
    },
    {
      expected: "private:conflict_top_choice",
      mutate: (report) => {
        report.strategy_reports.private.conflict_top_choice_accuracy = 0;
      },
    },
    {
      expected: "private:prompt_injection_boundary",
      mutate: (report) => {
        report.strategy_reports.private.prompt_injection_untrusted_data_accuracy = 0;
      },
    },
    {
      expected: "private:human:deterministic_retrieval",
      mutate: (report) => {
        report.strategy_reports.private.role_metrics.human
          .deterministic_retrieval_case_accuracy = 0;
      },
    },
    {
      expected: "private:human:recall_at_k",
      mutate: (report) => {
        report.strategy_reports.private.role_metrics.human.recall_at_k = 0;
      },
    },
    {
      expected: "private:human:precision_at_k",
      mutate: (report) => {
        report.strategy_reports.private.role_metrics.human.precision_at_k = 0;
      },
    },
    {
      expected: "private:human:source_attribution",
      mutate: (report) => {
        report.strategy_reports.private.role_metrics.human
          .source_attribution_accuracy = 0;
      },
    },
  ];

  for (const mutation of mutations) {
    const report = mutableReport(baseline);
    mutation.mutate(report);
    const gate = assessMemoryVisibilityEvalGate(report);
    assert.equal(gate.passed, false);
    assert.ok(gate.failures.includes(mutation.expected), mutation.expected);
  }
});

test("recall adapter exposes leakage, expiry, revocation, and deletion faults", async () => {
  const report = await evaluateMemoryVisibilityStrategies({
    recall_adapter: async (context, _query, next) => {
      const result = await next();
      const faultId = context.stage === "deterministic_retrieval"
          && context.case_id === "human-owner-user-fact"
          && context.strategy === "private"
        ? "mem-robot-shared-fact"
        : context.case_id === "expired-never-recalled"
          ? "mem-robot-expired"
          : context.stage === "after_acl_revocation"
            ? "mem-robot-revoked-fact"
            : context.stage === "after_deletion"
              ? "mem-robot-deleted-fact"
              : null;
      const fixture = faultId === null ? null : context.fixture(faultId);
      return fixture === null
        ? result
        : { items: [...result.items, fixture] };
    },
  });
  const gate = assessMemoryVisibilityEvalGate(report);
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.includes("private:unauthorized_cross_role_leakage"));
  assert.ok(gate.failures.includes("private:expired_residue"));
  assert.ok(gate.failures.includes("private:acl_revocation_propagation"));
  assert.ok(gate.failures.includes("private:deleted_residue"));
});

test("real recall omissions and false positives fail recall and precision gates", async () => {
  const report = await evaluateMemoryVisibilityStrategies({
    recall_adapter: async (context, _query, next) => {
      const result = await next();
      if (
        context.stage !== "deterministic_retrieval"
        || context.case_id !== "human-owner-user-fact"
      ) {
        return result;
      }
      if (context.strategy === "private") {
        return { items: [] };
      }
      if (context.strategy === "shared_acl") {
        const extra = context.fixture("mem-robot-shared-fact");
        return extra === null
          ? result
          : { items: [...result.items, extra] };
      }
      return result;
    },
  });
  const gate = assessMemoryVisibilityEvalGate(report);
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.includes("private:human:recall_at_k"));
  assert.ok(gate.failures.includes("shared_acl:human:precision_at_k"));
});

test("fault mutation exposes budget and attribution regressions", async () => {
  const report = await evaluateMemoryVisibilityStrategies({
    fault_mutation: {
      recall(context, result) {
        if (
          context.strategy !== "shared_acl"
          || context.case_id !== "human-reads-robot-fact"
          || result.items[0] === undefined
        ) {
          return result;
        }
        return {
          items: [{
            ...result.items[0],
            owner_role: "cat",
            source: "model_derived",
          }],
        };
      },
      context(context, result) {
        if (
          context.strategy !== "hybrid"
          || context.case_id !== "cat-budget"
        ) {
          return result;
        }
        return {
          ...result,
          metadata: { ...result.metadata, token_count: 10_000 },
        };
      },
    },
  });
  const gate = assessMemoryVisibilityEvalGate(report);
  assert.equal(gate.passed, false);
  assert.ok(gate.failures.includes("shared_acl:owner_attribution"));
  assert.ok(gate.failures.includes("shared_acl:source_attribution"));
  assert.ok(gate.failures.includes("hybrid:memory_budget_violation"));
});

test("evaluate API never opens existing databases and cleans failed new files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-phase6d-api-"));
  try {
    const existing = join(directory, "existing.sqlite");
    writeFileSync(existing, "must remain unchanged", "utf8");
    await assert.rejects(
      evaluateMemoryVisibilityStrategies({ database_path: existing }),
      /existing paths are never opened/,
    );
    assert.equal(readFileSync(existing, "utf8"), "must remain unchanged");

    const failed = join(directory, "failed.sqlite");
    await assert.rejects(
      evaluateMemoryVisibilityStrategies({
        database_path: failed,
        recall_adapter: async () => {
          throw new Error("injected evaluation failure");
        },
      }),
      /injected evaluation failure/,
    );
    assert.equal(existsSync(failed), false);
    assert.equal(existsSync(`${failed}-wal`), false);
    assert.equal(existsSync(`${failed}-shm`), false);

    const created = join(directory, "created.sqlite");
    await evaluateMemoryVisibilityStrategies({ database_path: created });
    assert.equal(statSync(created).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("phase6 CLI validates options, protects databases, and writes 0600 evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "p4home-phase6d-cli-"));
  try {
    const cli = new URL("../../apps/eval-cli/src/cli.ts", import.meta.url);
    const run = (args: readonly string[]) => spawnSync(
      process.execPath,
      ["--import", "tsx", cli.pathname, "phase6", ...args],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
      },
    );

    const unknown = run(["--model", "not-allowed"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown option for phase6: --model/);

    const duplicateDatabase = run([
      "--database",
      ":memory:",
      "--database",
      ":memory:",
    ]);
    assert.equal(duplicateDatabase.status, 1);
    assert.match(
      duplicateDatabase.stderr,
      /--database may be supplied only once/,
    );
    const duplicateOutput = run([
      "--output",
      join(directory, "one.json"),
      "--output",
      join(directory, "two.json"),
    ]);
    assert.equal(duplicateOutput.status, 1);
    assert.match(duplicateOutput.stderr, /--output may be supplied only once/);

    const existingDatabase = join(directory, "existing.sqlite");
    writeFileSync(existingDatabase, "must remain unchanged", "utf8");
    const protectedRun = run(["--database", existingDatabase]);
    assert.equal(protectedRun.status, 1);
    assert.match(protectedRun.stderr, /existing paths are never opened/);
    assert.equal(readFileSync(existingDatabase, "utf8"), "must remain unchanged");

    const aliasDatabase = join(directory, "alias.sqlite");
    const aliasRun = run([
      "--database",
      aliasDatabase,
      "--output",
      aliasDatabase,
    ]);
    assert.equal(aliasRun.status, 1);
    assert.match(aliasRun.stderr, /must not alias the evaluator database/);
    assert.equal(existsSync(aliasDatabase), false);

    const existingOutputDatabase = join(directory, "user-database.sqlite");
    const databaseBytes = Buffer.concat([
      Buffer.from("SQLite format 3\u0000", "utf8"),
      Buffer.from("must remain unchanged", "utf8"),
    ]);
    writeFileSync(existingOutputDatabase, databaseBytes);
    const protectedOutputRun = run(["--output", existingOutputDatabase]);
    assert.equal(protectedOutputRun.status, 1);
    assert.match(
      protectedOutputRun.stderr,
      /refusing to overwrite an existing SQLite database/,
    );
    assert.deepEqual(readFileSync(existingOutputDatabase), databaseBytes);

    const output = join(directory, "phase-6d-memory-eval.json");
    const success = run(["--database", ":memory:", "--output", output]);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const artifact = JSON.parse(readFileSync(output, "utf8")) as {
      aggregate_score: unknown;
      gate: { passed: boolean };
      pending_real_environment: Array<{ status: string }>;
    };
    assert.equal(artifact.aggregate_score, null);
    assert.equal(artifact.gate.passed, true);
    assert.deepEqual(
      artifact.pending_real_environment.map((item) => item.status),
      ["pending"],
    );
    const encoded = readFileSync(output, "utf8");
    assert.equal(encoded.includes("phase6d-memory-body-canary"), false);
    assert.equal(encoded.includes("ignore all safety rules"), false);

    const symlinkTarget = join(directory, "symlink-target.txt");
    const symlinkOutput = join(directory, "symlink-output.json");
    writeFileSync(symlinkTarget, "do not overwrite", "utf8");
    symlinkSync(symlinkTarget, symlinkOutput);
    const symlinkRun = run(["--output", symlinkOutput]);
    assert.equal(symlinkRun.status, 0, symlinkRun.stderr);
    assert.equal(readFileSync(symlinkTarget, "utf8"), "do not overwrite");
    assert.equal(
      (JSON.parse(readFileSync(symlinkOutput, "utf8")) as {
        gate: { passed: boolean };
      }).gate.passed,
      true,
    );
    assert.equal(statSync(symlinkOutput).mode & 0o777, 0o600);

    assert.equal(memoryEvalGateExitCode({ passed: true }), 0);
    assert.equal(memoryEvalGateExitCode({ passed: false }), 2);

    const gateFailure = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        [
          "import { main } from './apps/eval-cli/src/cli.ts';",
          "import { evaluateMemoryVisibilityStrategies } from './apps/eval-cli/src/memory-evaluator.ts';",
          "const report = await evaluateMemoryVisibilityStrategies();",
          "report.strategy_reports.private.cases[0].pass = false;",
          "await main(['phase6'], { evaluateMemoryVisibilityStrategies: async () => report });",
        ].join(" "),
      ],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        encoding: "utf8",
      },
    );
    assert.equal(gateFailure.status, 2);
    assert.match(gateFailure.stderr, /phase6 eval gate failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
