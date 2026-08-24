import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import {
  getFrozenGoldenIntents,
  getFrozenToolDefinitions,
} from "@p4home/contracts";
import { createMockP4HomeDomain } from "@p4home/domain-p4home";
import { OllamaHttpProvider } from "@p4home/provider-ollama";
import {
  createJsonLineLogger,
  DEFAULT_OLLAMA_MODEL,
  runTextAgent,
} from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";

import { evaluateToolCalling } from "./evaluator.ts";
import {
  assessPhase4EvalGate,
  evaluatePhase4Runtime,
} from "./phase4-evaluator.ts";
import {
  assessRoleEvalGate,
  evaluateRoleRuntime,
  ROLE_EVAL_TOTAL_CASES_PER_REPEAT,
} from "./role-evaluator.ts";
import {
  assessMemoryVisibilityEvalGate,
  evaluateMemoryVisibilityStrategies,
} from "./memory-evaluator.ts";
import {
  assessPhase6LiveMemoryGate,
  evaluatePhase6LiveMemory,
} from "./memory-live-evaluator.ts";

interface ParsedArguments {
  readonly command: string;
  readonly options: ReadonlyMap<string, readonly string[]>;
}

export interface EvalCliDependencies {
  readonly evaluateMemoryVisibilityStrategies:
    typeof evaluateMemoryVisibilityStrategies;
}

const DEFAULT_CLI_DEPENDENCIES: EvalCliDependencies = {
  evaluateMemoryVisibilityStrategies,
};

function parseArguments(argv: readonly string[]): ParsedArguments {
  const [command = "help", ...rawRest] = argv;
  const rest = rawRest[0] === "--" ? rawRest.slice(1) : rawRest;
  const options = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (key === undefined || !key.startsWith("--")) {
      throw new Error(`unexpected argument: ${key ?? ""}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} requires a value`);
    }
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
    index += 1;
  }
  return { command, options };
}

function values(argumentsValue: ParsedArguments, name: string): readonly string[] {
  return argumentsValue.options.get(name) ?? [];
}

function value(
  argumentsValue: ParsedArguments,
  name: string,
  fallback?: string,
): string | undefined {
  const found = values(argumentsValue, name);
  if (found.length > 1) {
    throw new Error(`${name} may be supplied only once`);
  }
  return found[0] ?? fallback;
}

function integer(
  argumentsValue: ParsedArguments,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = value(argumentsValue, name);
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function assertKnownOptions(
  argumentsValue: ParsedArguments,
  allowed: ReadonlySet<string>,
): void {
  for (const name of argumentsValue.options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`unknown option for ${argumentsValue.command}: ${name}`);
    }
  }
}

function printHelp(): void {
  process.stdout.write(`P4 Home Agent CLI

Eval:
  pnpm eval:ollama -- --model ${DEFAULT_OLLAMA_MODEL} [--case zh-018] [--limit 32] [--repeat 2] [--output FILE]

Phase 2 role eval (separate Router/Human/Robot/Cat reports, no aggregate score):
  pnpm eval:roles -- --model ${DEFAULT_OLLAMA_MODEL} [--repeat 2] [--output FILE]

Phase 4 eval (separate Router span/Robot policy/Human/Composer reports):
  pnpm eval:phase4 -- --model ${DEFAULT_OLLAMA_MODEL} [--output FILE]

Phase 6D deterministic visibility eval (no Ollama/model parameters):
  pnpm eval:phase6 -- [--database :memory:] [--output FILE]

Phase 6F real-model Memory gate (redacted fixture, no HA/P4 side effects):
  pnpm eval:phase6-live -- --model ${DEFAULT_OLLAMA_MODEL} [--output FILE] [--timeout-ms 300000]

Debug one text run:
  pnpm debug:agent -- --model ${DEFAULT_OLLAMA_MODEL} --text "去书房" [--database :memory:]
`);
}

function writePrivateArtifact(path: string, content: string): void {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (existing !== undefined && !existing.isSymbolicLink()) {
    if (!existing.isFile()) {
      throw new Error("artifact output exists and is not a regular file");
    }
    const existingDescriptor = openSync(outputPath, "r");
    try {
      const header = Buffer.alloc(16);
      const bytesRead = readSync(
        existingDescriptor,
        header,
        0,
        header.length,
        0,
      );
      if (
        bytesRead === header.length
        && header.toString("utf8") === "SQLite format 3\u0000"
      ) {
        throw new Error(
          "refusing to overwrite an existing SQLite database with an artifact",
        );
      }
    } finally {
      closeSync(existingDescriptor);
    }
  }
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    chmodSync(temporaryPath, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, outputPath);
    chmodSync(outputPath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function memoryEvalGateExitCode(
  gate: { readonly passed: boolean },
): 0 | 2 {
  return gate.passed ? 0 : 2;
}

async function phase6EvalCommand(
  argumentsValue: ParsedArguments,
  dependencies: EvalCliDependencies,
): Promise<void> {
  assertKnownOptions(argumentsValue, new Set(["--database", "--output"]));
  const database = value(argumentsValue, "--database", ":memory:") ?? ":memory:";
  const output = value(argumentsValue, "--output");
  if (database.trim().length === 0) {
    throw new Error("--database must not be empty");
  }
  const databasePath = database === ":memory:" ? database : resolve(database);
  const outputPath = output === undefined ? undefined : resolve(output);
  if (
    databasePath !== ":memory:"
    && outputPath !== undefined
    && [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ].includes(outputPath)
  ) {
    throw new Error("--output must not alias the evaluator database or its sidecars");
  }
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  }
  const report = await dependencies.evaluateMemoryVisibilityStrategies({
    database_path: databasePath,
  });
  if (databasePath !== ":memory:") {
    chmodSync(databasePath, 0o600);
  }
  const gate = assessMemoryVisibilityEvalGate(report);
  const artifact = { ...report, gate };
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  if (outputPath !== undefined) {
    writePrivateArtifact(outputPath, encoded);
    process.stderr.write(`phase6 eval report: ${outputPath}\n`);
  }
  process.stdout.write(encoded);
  const gateExitCode = memoryEvalGateExitCode(gate);
  if (gateExitCode !== 0) {
    process.stderr.write(`phase6 eval gate failed: ${gate.failures.join(", ")}\n`);
    process.exitCode = gateExitCode;
  }
}

async function phase4EvalCommand(argumentsValue: ParsedArguments): Promise<void> {
  assertKnownOptions(argumentsValue, new Set(["--model", "--output", "--timeout-ms"]));
  const model = value(argumentsValue, "--model", process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL);
  if (model === undefined || model.trim().length === 0) {
    throw new Error("--model is required");
  }
  const timeoutMs = integer(argumentsValue, "--timeout-ms", 120_000, 100, 600_000);
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: timeoutMs });
  const capabilities = await provider.probe();
  if (!capabilities.modelAvailable || !capabilities.toolCalling) {
    throw new Error(`model ${model} is unavailable or does not declare tool calling`);
  }
  const report = await evaluatePhase4Runtime({
    model,
    provider,
    timeout_ms: timeoutMs,
    on_case(section, id, pass): void {
      process.stderr.write(`[${section}] ${id} ${pass ? "pass" : "fail"}\n`);
    },
  });
  const artifact = {
    generated_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    ...report,
  };
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  const output = value(argumentsValue, "--output");
  if (output !== undefined) {
    const outputPath = resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, encoded, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
    process.stderr.write(`phase4 eval report: ${outputPath}\n`);
  }
  process.stdout.write(encoded);
  const gate = assessPhase4EvalGate(report);
  if (!gate.passed) {
    process.stderr.write(`phase4 eval gate failed: ${gate.failures.join(", ")}\n`);
    process.exitCode = 2;
  }
}

async function phase6LiveEvalCommand(argumentsValue: ParsedArguments): Promise<void> {
  assertKnownOptions(argumentsValue, new Set(["--model", "--output", "--timeout-ms"]));
  const model = value(
    argumentsValue,
    "--model",
    process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
  );
  if (model === undefined || model.trim().length === 0) {
    throw new Error("--model is required");
  }
  const timeoutMs = integer(argumentsValue, "--timeout-ms", 300_000, 100, 600_000);
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: timeoutMs });
  const capabilities = await provider.probe();
  if (!capabilities.modelAvailable) {
    throw new Error(`model ${model} is unavailable`);
  }
  const report = await evaluatePhase6LiveMemory({
    model,
    provider,
    timeout_ms: timeoutMs,
  });
  const gate = assessPhase6LiveMemoryGate(report);
  const artifact = {
    generated_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    ...report,
    gate,
  };
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  const output = value(argumentsValue, "--output");
  if (output !== undefined) {
    const outputPath = resolve(output);
    writePrivateArtifact(outputPath, encoded);
    process.stderr.write(`phase6 live eval report: ${outputPath}\n`);
  }
  process.stdout.write(encoded);
  if (!gate.passed) {
    process.stderr.write(`phase6 live eval gate failed: ${gate.failures.join(", ")}\n`);
    process.exitCode = 2;
  }
}

async function roleEvalCommand(argumentsValue: ParsedArguments): Promise<void> {
  assertKnownOptions(argumentsValue, new Set([
    "--model",
    "--output",
    "--repeat",
    "--timeout-ms",
  ]));
  const model = value(
    argumentsValue,
    "--model",
    process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
  );
  if (model === undefined || model.trim().length === 0) {
    throw new Error("--model is required");
  }
  const repeat = integer(argumentsValue, "--repeat", 2, 1, 10);
  const timeoutMs = integer(argumentsValue, "--timeout-ms", 120_000, 100, 600_000);
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: timeoutMs });
  const capabilities = await provider.probe();
  if (!capabilities.modelAvailable) {
    throw new Error(`model ${model} is unavailable`);
  }
  let completed = 0;
  const total = repeat * ROLE_EVAL_TOTAL_CASES_PER_REPEAT;
  const report = await evaluateRoleRuntime({
    model,
    provider,
    repeat,
    timeout_ms: timeoutMs,
    on_case(role, id, pass): void {
      completed += 1;
      process.stderr.write(`[${role}] ${completed}/${total} ${id} ${pass ? "pass" : "fail"}\n`);
    },
  });
  const artifact = {
    generated_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    ...report,
  };
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  const output = value(argumentsValue, "--output");
  if (output !== undefined) {
    const outputPath = resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, encoded, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
    process.stderr.write(`role eval report: ${outputPath}\n`);
  }
  process.stdout.write(encoded);
  const gate = assessRoleEvalGate(report);
  if (!gate.passed) {
    process.stderr.write(`role eval gate failed: ${gate.failures.join(", ")}\n`);
    process.exitCode = 2;
  }
}

async function evalCommand(argumentsValue: ParsedArguments): Promise<void> {
  assertKnownOptions(argumentsValue, new Set([
    "--case",
    "--limit",
    "--model",
    "--num-ctx",
    "--num-predict",
    "--output",
    "--repeat",
    "--seed",
    "--timeout-ms",
  ]));
  const modelArguments = values(argumentsValue, "--model");
  const models = modelArguments.length === 0
    ? [process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL]
    : modelArguments.flatMap((item) => item.split(",")).filter((item) => item.length > 0);
  if (models.length === 0 || new Set(models).size !== models.length) {
    throw new Error("--model must contain one or more unique model names");
  }
  const frozenScenarios = getFrozenGoldenIntents();
  const requestedCases = values(argumentsValue, "--case")
    .flatMap((item) => item.split(","))
    .filter((item) => item.length > 0);
  if (requestedCases.length > 0 && values(argumentsValue, "--limit").length > 0) {
    throw new Error("--case and --limit cannot be used together");
  }
  const scenariosById = new Map(frozenScenarios.map((scenario) => [scenario.id, scenario]));
  const baseScenarios = requestedCases.length === 0
    ? frozenScenarios.slice(
      0,
      integer(argumentsValue, "--limit", 32, 1, frozenScenarios.length),
    )
    : requestedCases.map((id) => {
      const scenario = scenariosById.get(id);
      if (scenario === undefined) {
        throw new Error(`unknown golden case: ${id}`);
      }
      return scenario;
    });
  const repeat = integer(argumentsValue, "--repeat", 1, 1, 10);
  const scenarios = Array.from({ length: repeat }, (_, repeatIndex) =>
    baseScenarios.map((scenario) => ({
      ...scenario,
      id: repeat === 1 ? scenario.id : `${scenario.id}#${repeatIndex + 1}`,
    })),
  ).flat();
  const numCtx = integer(argumentsValue, "--num-ctx", 8_192, 1_024, 131_072);
  const numPredict = integer(argumentsValue, "--num-predict", 256, 32, 4_096);
  const timeoutMs = integer(argumentsValue, "--timeout-ms", 300_000, 100, 600_000);
  const seed = integer(argumentsValue, "--seed", 42, 0, 2_147_483_647);
  const reports = [];

  for (const model of models) {
    const provider = new OllamaHttpProvider({ model, requestTimeoutMs: timeoutMs });
    const capabilities = await provider.probe();
    if (!capabilities.modelAvailable || !capabilities.toolCalling) {
      throw new Error(`model ${model} is unavailable or does not declare tool calling`);
    }
    let completed = 0;
    const report = await evaluateToolCalling({
      model,
      provider,
      scenarios,
      num_ctx: numCtx,
      num_predict: numPredict,
      timeout_ms: timeoutMs,
      seed,
      keep_alive: "10m",
      on_case(result): void {
        completed += 1;
        process.stderr.write(
          `[${model}] ${completed}/${scenarios.length} ${result.id} ${result.outcome} `
          + `${Math.round(result.latency_ms)}ms\n`,
        );
      },
    });
    reports.push(report);
  }

  const artifact = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    suite: {
      frozen_scenarios: baseScenarios.length,
      repeat,
      total_cases_per_model: scenarios.length,
    },
    reports,
  } as const;
  const encoded = `${JSON.stringify(artifact, null, 2)}\n`;
  const output = value(argumentsValue, "--output");
  if (output !== undefined) {
    const outputPath = resolve(output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, encoded, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
    process.stderr.write(`eval report: ${outputPath}\n`);
  }
  process.stdout.write(encoded);
}

async function debugCommand(argumentsValue: ParsedArguments): Promise<void> {
  assertKnownOptions(argumentsValue, new Set([
    "--database",
    "--model",
    "--text",
    "--timeout-ms",
  ]));
  const text = value(argumentsValue, "--text");
  if (text === undefined || text.trim().length === 0) {
    throw new Error("--text is required");
  }
  const model = value(
    argumentsValue,
    "--model",
    process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
  );
  if (model === undefined) {
    throw new Error("--model is required");
  }
  const timeoutMs = integer(argumentsValue, "--timeout-ms", 300_000, 100, 600_000);
  const databasePath = value(argumentsValue, "--database", ":memory:") ?? ":memory:";
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }
  await using store = new SqliteAuditStore(databasePath);
  const provider = new OllamaHttpProvider({ model, requestTimeoutMs: timeoutMs });
  const domain = createMockP4HomeDomain();
  const createdAtMs = Date.now();
  const suffix = randomUUID();
  const profileId = `debug-profile-${suffix}`;
  const sessionId = `debug-session-${suffix}`;
  const runId = `debug-run-${suffix}`;
  await store.saveAgentProfile({
    agent_profile_id: profileId,
    name: "P4 Home Debug",
    locale: "zh-CN",
    allowed_tools: getFrozenToolDefinitions().map((tool) => tool.name),
  });
  await store.saveSession({
    session_id: sessionId,
    agent_profile_id: profileId,
    created_at_ms: createdAtMs,
    updated_at_ms: createdAtMs,
  });

  const result = await runTextAgent({
    run_id: runId,
    user_text: text,
    provider,
    tools: domain.tools,
    model_timeout_ms: timeoutMs,
    audit: {
      store,
      session_id: sessionId,
      logger: createJsonLineLogger({ sink: (line) => process.stderr.write(`${line}\n`) }),
    },
  });
  const trace = await store.getRunTrace(runId);
  process.stdout.write(`${JSON.stringify({ result, state: domain.getState(), trace }, null, 2)}\n`);
  if (result.status !== "completed") {
    process.exitCode = 2;
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: EvalCliDependencies = DEFAULT_CLI_DEPENDENCIES,
): Promise<void> {
  const argumentsValue = parseArguments(argv);
  if (argumentsValue.command === "eval") {
    await evalCommand(argumentsValue);
    return;
  }
  if (argumentsValue.command === "run") {
    await debugCommand(argumentsValue);
    return;
  }
  if (argumentsValue.command === "roles") {
    await roleEvalCommand(argumentsValue);
    return;
  }
  if (argumentsValue.command === "phase4") {
    await phase4EvalCommand(argumentsValue);
    return;
  }
  if (argumentsValue.command === "phase6") {
    await phase6EvalCommand(argumentsValue, dependencies);
    return;
  }
  if (argumentsValue.command === "phase6-live") {
    await phase6LiveEvalCommand(argumentsValue);
    return;
  }
  if (argumentsValue.command === "help") {
    printHelp();
    return;
  }
  throw new Error(`unknown command: ${argumentsValue.command}`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
