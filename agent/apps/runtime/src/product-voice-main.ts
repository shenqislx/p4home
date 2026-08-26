import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

import { OllamaHttpProvider } from "@p4home/provider-ollama";
import {
  PythonSttProvider,
  STT_MODEL_REVISION,
  STT_PROVIDER_VERSION,
} from "@p4home/provider-stt";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import { RobotHaClient, loadRobotHaRuntimeConfig } from "@p4home/transport-ha";

import { DEFAULT_OLLAMA_MODEL } from "./model-config.ts";
import { productionMemoryStoreOptions } from "./memory-storage-policy.ts";
import {
  productVoiceAllowsRobot,
  resolveProductVoiceRoleMode,
} from "./product-voice-config.ts";
import { createPrivateRoleMemoryRuntime } from "./role-memory.ts";
import { RoleScheduler } from "./role-scheduler.ts";
import { RoleSessionRegistry } from "./role-session.ts";
import { UnifiedVoiceRoleDispatcher } from "./voice-role-dispatcher.ts";
import { UnifiedVoiceRuntime } from "./unified-voice-runtime.ts";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function optionalInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function absolutePath(name: string): string {
  const value = requiredEnvironment(name);
  if (!isAbsolute(value)) throw new Error(`${name.toLowerCase()}_must_be_absolute`);
  return value;
}

async function readBoundedFile(
  name: string,
  maximumBytes: number,
  privateFile: boolean,
): Promise<Buffer> {
  const path = absolutePath(name);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${name.toLowerCase()}_cannot_be_opened_safely`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > maximumBytes) {
      throw new Error(`${name.toLowerCase()}_has_invalid_type_or_size`);
    }
    if (privateFile && ((stats.mode & 0o077) !== 0
        || (process.getuid !== undefined && stats.uid !== process.getuid()))) {
      throw new Error(`${name.toLowerCase()}_must_be_owned_and_mode_0600_or_stricter`);
    }
    const output = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < output.byteLength) {
      const { bytesRead } = await handle.read(output, offset, output.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== output.byteLength) throw new Error(`${name.toLowerCase()}_short_read`);
    return output;
  } finally {
    await handle.close();
  }
}

async function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {
    once: true,
  }));
}

async function main(): Promise<void> {
  const deviceId = requiredEnvironment("P4HOME_AGENT_DEVICE_ID");
  const deviceTokenBytes = await readBoundedFile(
    "P4HOME_AGENT_DEVICE_TOKEN_FILE", 4_096, true,
  );
  const deviceToken = deviceTokenBytes.toString("utf8").trim();
  const key = await readBoundedFile("P4HOME_AGENT_TLS_KEY_FILE", 65_536, true);
  const cert = await readBoundedFile("P4HOME_AGENT_TLS_CERT_FILE", 65_536, false);
  const shutdown = new AbortController();
  const requestShutdown = (): void => shutdown.abort();
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  let runtime: UnifiedVoiceRuntime | null = null;
  let store: SqliteAuditStore | null = null;
  let haClient: RobotHaClient | null = null;
  let scheduler: RoleScheduler | null = null;
  try {
    const roleMode = resolveProductVoiceRoleMode(process.env.P4HOME_PRODUCT_ROLE_MODE);
    const robotEnabled = productVoiceAllowsRobot(roleMode);
    const databasePath = absolutePath("P4HOME_PRODUCT_AUDIT_DB");
    const model = process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
    const modelTimeoutMs = optionalInteger(
      "P4HOME_OLLAMA_TIMEOUT_MS", 120_000, 100, 600_000,
    );
    const provider = new OllamaHttpProvider({
      model,
      baseUrl: process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
      requestTimeoutMs: modelTimeoutMs,
    });
    const capabilities = await provider.probe();
    if (!capabilities.modelAvailable || !capabilities.toolCalling) {
      throw new Error("ollama_model_unavailable_or_missing_tool_calling");
    }
    if (robotEnabled) {
      const haConfig = await loadRobotHaRuntimeConfig({
        url: requiredEnvironment("P4HOME_HA_URL"),
        token_file: absolutePath("P4HOME_HA_TOKEN_FILE"),
        policy_file: absolutePath("P4HOME_HA_POLICY_FILE"),
        allow_insecure_ws: process.env.P4HOME_HA_ALLOW_INSECURE === "1",
      });
      haClient = new RobotHaClient({
        config: haConfig,
        handshake_timeout_ms: 10_000,
        request_timeout_ms: 10_000,
      });
      await haClient.connect();
    }
    scheduler = new RoleScheduler(16);
    store = new SqliteAuditStore(databasePath, {
      ...productionMemoryStoreOptions(),
    });
    const memory = createPrivateRoleMemoryRuntime({
      store,
      approved_policy_revision: 1,
      recall_timeout_ms: 5_000,
    });
    const processId = randomUUID().replaceAll("-", "").slice(0, 16);
    const dispatcher = new UnifiedVoiceRoleDispatcher({
      provider,
      sessions: new RoleSessionRegistry({
        robot: `product:voice:robot:${processId}`,
        human: `product:voice:human:${processId}`,
        cat: `product:voice:cat:${processId}`,
      }),
      scheduler,
      timeout_ms: modelTimeoutMs,
      audit: { store },
      ...(haClient === null
        ? { human_only: true }
        : { robot_ha: { client: haClient, observation_timeout_ms: 10_000 } }),
      memory,
      on_result: (result) => {
        process.stdout.write(`${JSON.stringify({
          event: "voice_role_completed",
          role: result.run.role_id,
          run_status: result.run.status,
          response_status: result.response.status,
          composition_audit_status: result.composition_audit_status,
        })}\n`);
      },
    });
    const stt = new PythonSttProvider({
      python_executable: absolutePath("P4HOME_STT_PYTHON"),
      worker_script: absolutePath("P4HOME_STT_WORKER"),
      model_path: absolutePath("P4HOME_STT_MODEL"),
      model_revision: STT_MODEL_REVISION,
      provider_version: STT_PROVIDER_VERSION,
      timeout_ms: optionalInteger("P4HOME_STT_TIMEOUT_MS", 120_000, 1_000, 120_000),
    });
    runtime = new UnifiedVoiceRuntime({
      server: {
        host: process.env.P4HOME_AGENT_HOST?.trim() || "0.0.0.0",
        port: optionalInteger("P4HOME_AGENT_PORT", 8443, 1, 65_535),
        tls: { key, cert },
        max_connections: 1,
        max_session_frames: 1_500,
        initial_credit_frames: 8,
      },
      device_tokens: { [deviceId]: deviceToken },
      stt: {
        provider: stt,
        stt_timeout_ms: optionalInteger(
          "P4HOME_STT_TIMEOUT_MS", 120_000, 1_000, 120_000,
        ),
      },
      interaction: {
        dispatch_role: async (interaction, signal) => await dispatcher.dispatch(interaction, signal),
        ui_output: "required",
        audio_output: "disabled",
      },
    });
    const address = await runtime.start();
    process.stdout.write(`${JSON.stringify({
      event: "product_voice_ready",
      host: address.host,
      port: address.port,
      model,
      role_mode: roleMode,
      ha_entities: haClient?.capabilities.length ?? 0,
      ui_output: "required",
      audio_output: "deferred",
      raw_audio_retained: false,
    })}\n`);
    await waitForShutdown(shutdown.signal);
  } finally {
    await runtime?.close().catch(() => undefined);
    await store?.closeAsync().catch(() => undefined);
    scheduler?.close();
    haClient?.close();
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    deviceTokenBytes.fill(0);
    key.fill(0);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown_product_voice_error";
  process.stderr.write(`product voice runtime failed: ${message.slice(0, 256)}\n`);
  process.exitCode = 1;
});
