import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  OllamaHttpProvider,
  type OllamaChatRequest,
  type OllamaChatResult,
} from "@p4home/provider-ollama";
import {
  PythonSttProvider,
  STT_MODEL_REVISION,
  STT_PROVIDER_VERSION,
  SttProviderError,
  type SttFinalTranscript,
  type SttProvider,
} from "@p4home/provider-stt";
import {
  DEFAULT_OLLAMA_MODEL,
  RoleScheduler,
  RoleSessionRegistry,
  UnifiedVoiceRoleDispatcher,
  UnifiedVoiceRuntime,
  classifyPhase5ePrompt,
  createPrivateRoleMemoryRuntime,
  productionMemoryStoreOptions,
  readCurrentIdentity,
  requirePhase5eRestoredState,
  restoreRobotState,
  validatePhase5eSpeakerlessUiGate,
  waitForStableProjectedState,
  type Phase5ePromptSet,
  type Phase5eSpeakerlessUiGateInteraction,
  type RunRoleInteractionResult,
  type UserTextInteraction,
} from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import { RobotHaClient, loadRobotHaRuntimeConfig } from "@p4home/transport-ha";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function positivePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_agent_port");
  return port;
}

function captureMetricKey(value: {
  readonly session_id: string;
  readonly stream_id: number;
  readonly epoch: number;
}): string {
  return `${value.session_id}:${value.stream_id}:${value.epoch}`;
}

type ExpectedSttKind = "read" | "write" | "chat" | "unexpected";
type BoundedSttFailureCode =
  | "cancelled"
  | "invalid_response"
  | "model_unavailable"
  | "process_error"
  | "timeout"
  | "unknown";

function expectedSttKind(acceptedTranscripts: number): ExpectedSttKind {
  if (acceptedTranscripts === 0) return "read";
  if (acceptedTranscripts === 1) return "write";
  if (acceptedTranscripts === 2) return "chat";
  return "unexpected";
}

function emptySttFailureCounts(): Record<BoundedSttFailureCode, number> {
  return {
    cancelled: 0,
    invalid_response: 0,
    model_unavailable: 0,
    process_error: 0,
    timeout: 0,
    unknown: 0,
  };
}

function boundedSttFailureCode(error: unknown): BoundedSttFailureCode {
  if (!(error instanceof SttProviderError)) return "unknown";
  switch (error.code) {
    case "CANCELLED": return "cancelled";
    case "INVALID_RESPONSE": return "invalid_response";
    case "MODEL_UNAVAILABLE": return "model_unavailable";
    case "PROCESS_ERROR": return "process_error";
    case "TIMEOUT": return "timeout";
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function settledProgressSnapshot(runtime: UnifiedVoiceRuntime): {
  readonly schema_version: 1;
  readonly completed_interactions: number;
  readonly capture_attempts: number;
} {
  const pipelineResults = runtime.pipeline.results;
  return {
    schema_version: 1,
    // A coordinator result is visible just before dispatch_final returns and
    // the pipeline records its terminal result. Publishing that earlier count
    // can make the next capture mistake the previous terminal for its failure.
    completed_interactions: pipelineResults.filter(
      (result) => result.outcome === "dispatched",
    ).length,
    capture_attempts: pipelineResults.length,
  };
}

async function waitForResults(
  runtime: UnifiedVoiceRuntime,
  progressFile: string,
  inputDriverStatusFile: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let published = "";
  while (true) {
    if (signal.aborted) throw new Error("voice_ui_e2e_harness_stopped");
    const snapshot = settledProgressSnapshot(runtime);
    const serialized = JSON.stringify(snapshot);
    if (serialized !== published) {
      await atomicJson(progressFile, snapshot);
      published = serialized;
    }
    let inputDriverComplete = false;
    try {
      const inputStatus = (await readFile(inputDriverStatusFile, "ascii")).trim();
      if (inputStatus === "1") throw new Error("voice_ui_input_driver_failed");
      if (inputStatus !== "0") throw new Error("voice_ui_input_driver_status_invalid");
      inputDriverComplete = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // Publish the third settled interaction before accepting driver success.
    // A missing status means the driver has not completed that handshake yet.
    if (snapshot.completed_interactions >= 3 && inputDriverComplete) break;
    if (performance.now() >= deadline) throw new Error("voice_ui_e2e_result_timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await atomicJson(progressFile, settledProgressSnapshot(runtime));
}

async function main(): Promise<void> {
  if (requiredEnvironment("P4HOME_HARDWARE_PROFILE") !== "phase5e_ui") {
    throw new Error("unsupported_hardware_profile");
  }
  const deviceId = requiredEnvironment("P4HOME_AGENT_DEVICE_ID");
  const deviceToken = (await readFile(
    requiredEnvironment("P4HOME_AGENT_DEVICE_TOKEN_FILE"), "utf8",
  )).trim();
  const key = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_KEY_FILE"));
  const cert = await readFile(requiredEnvironment("P4HOME_AGENT_TLS_CERT_FILE"));
  const readyFile = requiredEnvironment("P4HOME_HARNESS_READY_FILE");
  const resultFile = requiredEnvironment("P4HOME_HARNESS_RESULT_FILE");
  const promptFile = requiredEnvironment("P4HOME_PHASE5E_PROMPT_FILE");
  const progressFile = requiredEnvironment("P4HOME_PHASE5E_PROGRESS_FILE");
  const inputDriverStatusFile = requiredEnvironment("P4HOME_PHASE5E_UI_INPUT_STATUS_FILE");
  const alias = process.env.P4HOME_PHASE4C_ALIAS?.trim() || "study_ceiling_light";
  const haUrl = requiredEnvironment("P4HOME_PHASE4C_HA_URL");
  const config = await loadRobotHaRuntimeConfig({
    url: haUrl,
    token_file: requiredEnvironment("P4HOME_PHASE4C_TOKEN_FILE"),
    policy_file: requiredEnvironment("P4HOME_PHASE4C_POLICY_FILE"),
    allow_insecure_ws: haUrl.startsWith("http://"),
  });
  const entity = config.policy.entities[0];
  const identity = await readCurrentIdentity(haUrl, config.access_token);
  if (identity.is_admin || identity.is_owner) throw new Error("robot_identity_privileged");
  if (config.policy.entities.length !== 1 || entity?.alias !== alias
      || !["light", "switch"].includes(entity.domain) || !entity.read
      || !entity.write_actions.includes("turn_on") || !entity.write_actions.includes("turn_off")) {
    throw new Error("policy_shape");
  }

  const scheduler = new RoleScheduler(1);
  await using store = new SqliteAuditStore(
    requiredEnvironment("P4HOME_PHASE5E_AUDIT_DB"), productionMemoryStoreOptions(),
  );
  const client = new RobotHaClient({
    config,
    handshake_timeout_ms: 10_000,
    request_timeout_ms: 10_000,
  });
  const shutdown = new AbortController();
  const requestShutdown = (): void => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  let runtime: UnifiedVoiceRuntime | null = null;
  let initialState: "off" | "on" | null = null;
  let writeMayHaveOccurred = false;
  let restoredState: string | null = null;
  try {
    await client.connect();
    const stable = await waitForStableProjectedState(client, alias, 60_000, 10_000);
    if (stable === null || (stable.state !== "on" && stable.state !== "off")) {
      throw new Error("unsafe_initial_state");
    }
    initialState = stable.state;
    const writeAction = initialState === "off" ? "turn_on" : "turn_off";
    const prompts: Phase5ePromptSet = {
      read: "请查看书房灯状态",
      write: writeAction === "turn_on" ? "请把书房灯打开" : "请把书房灯关闭",
      barge: "你好，请介绍一下你自己",
      followup: "你好还在吗",
    };
    const model = process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
    const realProvider = new OllamaHttpProvider({
      model,
      baseUrl: process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
      requestTimeoutMs: 120_000,
    });
    const capabilities = await realProvider.probe();
    if (!capabilities.modelAvailable || !capabilities.toolCalling) {
      throw new Error("ollama_model_unavailable_or_missing_tool_calling");
    }
    let realModelCalls = 0;
    const provider = {
      async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResult> {
        realModelCalls++;
        const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
        if (typeof lastUser?.content === "string"
            && classifyPhase5ePrompt(lastUser.content, prompts) === "write") {
          writeMayHaveOccurred = true;
        }
        return await realProvider.chat(request, signal);
      },
    };
    const sttDurations: number[] = [];
    const sttDurationByCapture = new Map<string, number>();
    const expectedKinds = ["read", "write", "barge"] as const;
    let acceptedTranscripts = 0;
    let transcriptMismatches = 0;
    const transcriptRejectionsByExpectedKind = {
      read: 0,
      write: 0,
      chat: 0,
      unexpected: 0,
    };
    const nonMismatchFailuresByExpectedKind = {
      read: emptySttFailureCounts(),
      write: emptySttFailureCounts(),
      chat: emptySttFailureCounts(),
      unexpected: emptySttFailureCounts(),
    };
    const pythonStt = new PythonSttProvider({
      python_executable: requiredEnvironment("P4HOME_STT_PYTHON"),
      worker_script: requiredEnvironment("P4HOME_STT_WORKER"),
      model_path: requiredEnvironment("P4HOME_STT_MODEL"),
      model_revision: STT_MODEL_REVISION,
      provider_version: STT_PROVIDER_VERSION,
      timeout_ms: 120_000,
    });
    await pythonStt.warmup({ signal: shutdown.signal });
    const measuredStt: SttProvider = {
      async transcribe(request, options): Promise<SttFinalTranscript> {
        const started = performance.now();
        let transcriptMismatch = false;
        try {
          const transcript = await pythonStt.transcribe(request, options);
          const kind = classifyPhase5ePrompt(transcript.text, prompts);
          if (kind === null || kind !== expectedKinds[acceptedTranscripts]) {
            transcriptMismatch = true;
            transcriptMismatches++;
            if (acceptedTranscripts === 0) transcriptRejectionsByExpectedKind.read++;
            else if (acceptedTranscripts === 1) transcriptRejectionsByExpectedKind.write++;
            else if (acceptedTranscripts === 2) transcriptRejectionsByExpectedKind.chat++;
            else transcriptRejectionsByExpectedKind.unexpected++;
            throw new SttProviderError(
              "INVALID_RESPONSE", "Phase 5E transcript did not match speakerless UI prompt",
            );
          }
          acceptedTranscripts++;
          return transcript;
        } catch (error) {
          if (!transcriptMismatch) {
            const expectedKind = expectedSttKind(acceptedTranscripts);
            const failureCode = boundedSttFailureCode(error);
            nonMismatchFailuresByExpectedKind[expectedKind][failureCode]++;
          }
          throw error;
        } finally {
          const durationMs = performance.now() - started;
          sttDurations.push(durationMs);
          sttDurationByCapture.set(captureMetricKey(request), durationMs);
        }
      },
    };
    const roleResults = new Map<string, {
      readonly interaction: UserTextInteraction;
      readonly result: RunRoleInteractionResult;
    }>();
    const dispatcher = new UnifiedVoiceRoleDispatcher({
      provider,
      sessions: new RoleSessionRegistry({
        robot: `phase5e-ui-robot:${randomUUID()}`,
        human: `phase5e-ui-human:${randomUUID()}`,
        cat: `phase5e-ui-cat:${randomUUID()}`,
      }),
      scheduler,
      timeout_ms: 120_000,
      audit: { store },
      robot_ha: { client, observation_timeout_ms: 10_000 },
      memory: createPrivateRoleMemoryRuntime({
        store,
        approved_policy_revision: 1,
        recall_timeout_ms: 5_000,
      }),
      on_result: (result, interaction) => {
        roleResults.set(interaction.interaction_id, { interaction, result });
      },
    });
    runtime = new UnifiedVoiceRuntime({
      server: {
        host: "0.0.0.0",
        port: positivePort(requiredEnvironment("P4HOME_AGENT_PORT")),
        tls: { key, cert },
        max_connections: 1,
        max_session_frames: 1_500,
        initial_credit_frames: 8,
      },
      device_tokens: { [deviceId]: deviceToken },
      stt: { provider: measuredStt, stt_timeout_ms: 120_000 },
      interaction: {
        dispatch_role: async (interaction, signal) => await dispatcher.dispatch(interaction, signal),
        ui_output: "required",
        audio_output: "disabled",
        stt_duration_ms: (context) => (
          sttDurationByCapture.get(captureMetricKey(context)) ?? null
        ),
      },
    });
    await runtime.start();
    await atomicJson(promptFile, { schema_version: 1, prompts });
    await atomicJson(progressFile, {
      schema_version: 1, completed_interactions: 0, capture_attempts: 0,
    });
    await writeFile(readyFile, "ready\n", { mode: 0o600 });
    process.stdout.write(
      "HARNESS:voice_ui_e2e_server:READY ui=required audio=deferred raw_audio_retained=false\n",
    );
    await waitForResults(
      runtime, progressFile, inputDriverStatusFile, 900_000, shutdown.signal,
    );
    await runtime.pipeline.drain();

    const voiceResults = runtime.coordinator.results;
    if (voiceResults.length !== 3 || roleResults.size !== 3) throw new Error("interaction_count");
    const interactions: Phase5eSpeakerlessUiGateInteraction[] = voiceResults.map((voice) => {
      const record = roleResults.get(voice.interaction_id);
      if (record === undefined) throw new Error("role_result_missing");
      const promptKind = classifyPhase5ePrompt(record.interaction.text, prompts);
      if (promptKind === null || promptKind === "followup") {
        throw new Error("holdout_transcript_mismatch");
      }
      const kind = promptKind === "barge" ? "chat" : promptKind;
      return { kind, voice, role: record.result };
    });
    await runtime.close();
    runtime = null;
    const restore = await restoreRobotState(client, alias, initialState, 10_000, 2_000);
    restoredState = requirePhase5eRestoredState(restore, initialState);
    const verdict = validatePhase5eSpeakerlessUiGate({
      interactions,
      write_action: writeAction,
      initial_state: initialState,
      restored_state: restoredState,
    });
    let auditEvents = 0;
    for (const record of roleResults.values()) {
      const trace = await store.getRunTrace(`run:${record.interaction.interaction_id}`);
      if (trace?.run.status !== "completed" || trace.events.length < 2) {
        throw new Error("audit_incomplete");
      }
      auditEvents += trace.events.length;
    }
    await atomicJson(resultFile, {
      schema_version: 2,
      profile: "phase5e_ui",
      passed: true,
      interaction_kinds: interactions.map((item) => item.kind),
      role_ids: interactions.map((item) => item.role.run.role_id),
      role_statuses: interactions.map((item) => item.role.run.status),
      voice_outcomes: interactions.map((item) => item.voice.outcome),
      ui_delivery_statuses: interactions.map((item) => item.voice.ui_delivery),
      audio_delivery_statuses: interactions.map((item) => item.voice.audio_delivery),
      interaction_metrics: interactions.map((item) => ({
        kind: item.kind,
        metrics: item.voice.metrics,
      })),
      stt_provider_version: STT_PROVIDER_VERSION,
      stt_model_revision: STT_MODEL_REVISION,
      stt_calls: sttDurations.length,
      stt_transcript_mismatches: transcriptMismatches,
      stt_rejections_by_expected_kind: transcriptRejectionsByExpectedKind,
      stt_non_mismatch_failures_by_expected_kind: nonMismatchFailuresByExpectedKind,
      stt_total_ms: Math.round(sttDurations.reduce((sum, value) => sum + value, 0)),
      real_model_calls: realModelCalls,
      audit_events: auditEvents,
      restored: true,
      ...verdict,
    });
    process.stdout.write(
      `VERIFY:phase5e:voice_ui_e2e:PASS interactions=3 stt_calls=${sttDurations.length} `
      + `model_calls=${realModelCalls} ui_applied=3 audio=deferred audit=persisted `
      + "restored=yes raw_audio_retained=false\n",
    );
  } finally {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
    let runtimeCloseFailure: unknown = null;
    let restoreFailure: unknown = null;
    try { await runtime?.close(); }
    catch (error) { runtimeCloseFailure = error; }
    if (initialState !== null && writeMayHaveOccurred && restoredState !== initialState) {
      try {
        restoredState = requirePhase5eRestoredState(
          await restoreRobotState(client, alias, initialState), initialState,
        );
      } catch {
        restoreFailure = new Error("restore_failed");
      }
    }
    scheduler.close();
    client.close();
    if (restoreFailure !== null) throw restoreFailure;
    if (runtimeCloseFailure !== null) throw runtimeCloseFailure;
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown_error";
  process.stdout.write(`VERIFY:phase5e:voice_ui_e2e:FAIL reason=${reason}\n`);
  process.exitCode = 1;
});
