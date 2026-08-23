import { readFile, writeFile } from "node:fs/promises";

import {
  PythonSttProvider,
  STT_MODEL_REVISION,
  STT_PROVIDER_VERSION,
  SttProviderError,
  type SttFinalTranscript,
  type SttProvider,
} from "@p4home/provider-stt";
import {
  RoleScheduler,
  RoleSessionRegistry,
  PHASE5C_EXPECTED_TRANSCRIPT_SHA256,
  PHASE5C_MAX_VOICE_ATTEMPTS,
  PHASE5C_TRANSCRIPT_NORMALIZATION,
  UnifiedVoiceRoleDispatcher,
  VoiceSttPipeline,
  VoiceWebSocketServer,
  phase5cTranscriptSha256,
  phase5cAttemptDecision,
  type RunRoleInteractionResult,
  type UserTextInteraction,
} from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";

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

async function waitUntilOrAbort(
  predicate: () => boolean,
  timeoutMs: number,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (signal.aborted) throw new Error("voice_stt_harness_stopped");
    if (performance.now() >= deadline) throw new Error(reason);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 20);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error("voice_stt_harness_stopped"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

async function main(): Promise<void> {
  if (requiredEnvironment("P4HOME_HARDWARE_PROFILE") !== "phase5c_stt") {
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
  const auditPath = requiredEnvironment("P4HOME_STT_AUDIT_DB");
  const scheduler = new RoleScheduler(1);
  await using store = new SqliteAuditStore(auditPath);
  const sessions = new RoleSessionRegistry({
    robot: "phase5c-session-robot",
    human: "phase5c-session-human",
    cat: "phase5c-session-cat",
  });
  let providerDurationMs: number | null = null;
  let transcriptSha256: string | null = null;
  let transcriptChars: number | null = null;
  let transcriptMismatches = 0;
  const pythonProvider = new PythonSttProvider({
    python_executable: requiredEnvironment("P4HOME_STT_PYTHON"),
    worker_script: requiredEnvironment("P4HOME_STT_WORKER"),
    model_path: requiredEnvironment("P4HOME_STT_MODEL"),
    model_revision: STT_MODEL_REVISION,
    provider_version: STT_PROVIDER_VERSION,
    timeout_ms: 120_000,
  });
  const measuredProvider: SttProvider = {
    async transcribe(request, options): Promise<SttFinalTranscript> {
      const started = performance.now();
      const transcript = await pythonProvider.transcribe(request, options);
      providerDurationMs = Math.round((performance.now() - started) * 1_000) / 1_000;
      transcriptSha256 = phase5cTranscriptSha256(transcript.text);
      if (transcriptSha256 !== PHASE5C_EXPECTED_TRANSCRIPT_SHA256) {
        transcriptMismatches++;
        throw new SttProviderError("INVALID_RESPONSE", "STT gate transcript mismatch");
      }
      transcriptChars = transcript.text.length;
      return transcript;
    },
  };
  let roleResult: RunRoleInteractionResult | null = null;
  let interaction: UserTextInteraction | null = null;
  let routerCalls = 0;
  const dispatcher = new UnifiedVoiceRoleDispatcher({
    sessions,
    scheduler,
    timeout_ms: 30_000,
    audit: { store },
    provider: {
      async chat(request) {
        routerCalls++;
        if (routerCalls === 1) {
          const text = request.messages.at(-1)?.content ?? "";
          return {
            model: "phase5c-deterministic-router",
            message: {
              role: "assistant",
              content: JSON.stringify({ assignments: [{ role: "human", text }] }),
            },
          };
        }
        return {
          model: "phase5c-deterministic-human",
          message: { role: "assistant", content: "我听到了。" },
        };
      },
    },
    on_result: (result, value) => {
      roleResult = result;
      interaction = value;
    },
  });
  const pipeline = new VoiceSttPipeline({
    provider: measuredProvider,
    dispatch_final: async (value, signal) => { await dispatcher.dispatch(value, signal); },
    stt_timeout_ms: 120_000,
  });
  const server = new VoiceWebSocketServer({
    host: "0.0.0.0",
    port: positivePort(requiredEnvironment("P4HOME_AGENT_PORT")),
    tls: { key, cert },
    device_tokens: { [deviceId]: deviceToken },
    max_connections: 1,
    max_session_frames: 1_500,
    initial_credit_frames: 8,
    sink: pipeline,
  });
  const shutdown = new AbortController();
  const requestShutdown = (): void => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  let started = false;
  try {
    await server.start();
    started = true;
    if (shutdown.signal.aborted) throw new Error("voice_stt_harness_stopped");
    await writeFile(readyFile, "ready\n", { mode: 0o600 });
    process.stdout.write("HARNESS:voice_stt_server:READY raw_audio_retained=false\n");
    await waitUntilOrAbort(
      () => phase5cAttemptDecision(
        pipeline.results.map((result) => result.outcome),
      ) !== "continue",
      300_000,
      "voice_stt_result_timeout",
      shutdown.signal,
    );
    await pipeline.drain();
    const attempts = pipeline.results;
    const voiceResult = attempts.find((result) => result.outcome === "dispatched");
    const completedRoleResult = roleResult as RunRoleInteractionResult | null;
    const completedInteraction = interaction as UserTextInteraction | null;
    if (
      voiceResult?.outcome !== "dispatched"
      || completedRoleResult === null
      || completedInteraction === null
      || completedRoleResult.run.status !== "completed"
      || completedRoleResult.run.role_id !== "human"
      || completedRoleResult.composition_audit_status !== "persisted"
      || sessions.get("cat").history().length !== 0
      || transcriptSha256 === null
      || transcriptChars === null
      || providerDurationMs === null
    ) {
      throw new Error(`voice_stt_attempts_exhausted:${attempts.length}`);
    }
    const trace = await store.getRunTrace(`run:${completedInteraction.interaction_id}`);
    if (trace?.run.status !== "completed" || trace.events.length < 2) {
      throw new Error("voice_stt_audit_incomplete");
    }
    await writeFile(resultFile, `${JSON.stringify({
      schema_version: 1,
      device_id: voiceResult.device_id,
      session_id: voiceResult.session_id,
      stream_id: voiceResult.stream_id,
      epoch: voiceResult.epoch,
      voice_outcome: voiceResult.outcome,
      pcm_bytes: voiceResult.pcm_bytes,
      speech_frames: voiceResult.speech_frames,
      partials_seen: voiceResult.partials_seen,
      stt_provider_version: STT_PROVIDER_VERSION,
      stt_model_revision: STT_MODEL_REVISION,
      stt_duration_ms: providerDurationMs,
      transcript_sha256: transcriptSha256,
      transcript_expected_sha256: PHASE5C_EXPECTED_TRANSCRIPT_SHA256,
      transcript_normalization: PHASE5C_TRANSCRIPT_NORMALIZATION,
      transcript_chars: transcriptChars,
      transcript_mismatches: transcriptMismatches,
      voice_attempts: attempts.length,
      voice_attempt_limit: PHASE5C_MAX_VOICE_ATTEMPTS,
      voice_attempt_outcomes: attempts.map((attempt) => attempt.outcome),
      role_id: completedRoleResult.run.role_id,
      role_status: completedRoleResult.run.status,
      audit_status: completedRoleResult.composition_audit_status,
      audit_events: trace.events.length,
      cat_history_messages: sessions.get("cat").history().length,
      raw_audio_retained: false,
    }, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      `VERIFY:phase5c:voice_stt_unified:PASS epoch=${voiceResult.epoch} `
      + `pcm_bytes=${voiceResult.pcm_bytes} speech_frames=${voiceResult.speech_frames} `
      + `stt_ms=${providerDurationMs} transcript_chars=${transcriptChars} `
      + `attempts=${attempts.length} mismatches=${transcriptMismatches} `
      + `role=human audit=persisted cat_history=0 raw_audio_retained=false\n`,
    );
  } finally {
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
    const serverClose = started ? server.close() : Promise.resolve();
    pipeline.close();
    await serverClose;
    await pipeline.drain();
    scheduler.close();
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "unknown_error";
  if (reason === "voice_stt_harness_stopped") {
    process.stdout.write("HARNESS:voice_stt_server:STOPPED\n");
    return;
  }
  process.stdout.write(`VERIFY:phase5c:voice_stt_unified:FAIL reason=${reason}\n`);
  process.exitCode = 1;
});
