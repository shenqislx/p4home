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
import {
  PythonTtsProvider,
  TTS_MODEL_REVISION,
  TTS_PROVIDER_VERSION,
} from "@p4home/provider-tts";
import { SqliteAuditStore } from "@p4home/storage-sqlite";
import { RobotHaClient, loadRobotHaRuntimeConfig } from "@p4home/transport-ha";

import { DEFAULT_OLLAMA_MODEL } from "./model-config.ts";
import { CatAutonomyControlServer } from "./cat-autonomy-control-server.ts";
import {
  parseProductCatAutonomyConfig,
  ProductCatAutonomyRuntime,
} from "./product-cat-autonomy.ts";
import { DeviceRuntimeHub } from "./device-websocket-server.ts";
import { LowPriorityCatRunRegistry } from "./low-priority-cat-run-registry.ts";
import { productionMemoryStoreOptions } from "./memory-storage-policy.ts";
import {
  productVoiceAllowsRobot,
  resolveProductVoiceRoleMode,
} from "./product-voice-config.ts";
import { createPrivateRoleMemoryRuntime } from "./role-memory.ts";
import { RoleAwareTtsPipeline } from "./role-aware-tts.ts";
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

function optionalFlag(name: string): boolean {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`invalid_${name.toLowerCase()}`);
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
  let deviceHub: DeviceRuntimeHub | null = null;
  let autonomy: ProductCatAutonomyRuntime | null = null;
  let autonomyControl: CatAutonomyControlServer | null = null;
  let autonomyControlTokenBytes: Buffer | null = null;
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
    const catRunRegistry = new LowPriorityCatRunRegistry();
    const autonomyEnabled = optionalFlag("P4HOME_CAT_AUTONOMY_ENABLED");
    let autonomyDevicePort: number | null = null;
    let autonomyControlPort: number | null = null;
    if (autonomyEnabled) {
      if (haClient === null) throw new Error("cat_autonomy_requires_robot_ha_mode");
      const configBytes = await readBoundedFile(
        "P4HOME_CAT_AUTONOMY_CONFIG_FILE", 65_536, false,
      );
      let rawConfig: unknown;
      try {
        rawConfig = JSON.parse(configBytes.toString("utf8"));
      } catch {
        throw new Error("p4home_cat_autonomy_config_file_is_not_valid_json");
      }
      const autonomyConfig = parseProductCatAutonomyConfig(rawConfig, haClient.listStates());
      deviceHub = new DeviceRuntimeHub({
        server: {
          host: process.env.P4HOME_DEVICE_HOST?.trim()
            || process.env.P4HOME_AGENT_HOST?.trim()
            || "0.0.0.0",
          port: optionalInteger("P4HOME_DEVICE_PORT", 8_444, 1, 65_535),
          tls: { key, cert },
          device_tokens: { [deviceId]: deviceToken },
          max_connections: 1,
        },
        adapter: { protocol_version: 2 },
      });
      autonomy = new ProductCatAutonomyRuntime({
        device_id: deviceId,
        device_hub: deviceHub,
        ha_client: haClient,
        config: autonomyConfig,
        provider,
        scheduler,
        audit_store: store,
        memory,
        cat_run_registry: catRunRegistry,
        on_log: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
      });
      autonomyControlTokenBytes = await readBoundedFile(
        "P4HOME_CAT_AUTONOMY_CONTROL_TOKEN_FILE", 4_096, true,
      );
      const trimmedControlToken = Buffer.from(
        autonomyControlTokenBytes.toString("utf8").trim(),
        "utf8",
      );
      autonomyControl = new CatAutonomyControlServer({
        host: "127.0.0.1",
        port: optionalInteger("P4HOME_CAT_AUTONOMY_CONTROL_PORT", 9_477, 1, 65_535),
        token: trimmedControlToken,
        target: autonomy,
      });
      trimmedControlToken.fill(0);
      const deviceAddress = await deviceHub.start();
      autonomyDevicePort = deviceAddress.port;
      autonomy.start();
      const controlAddress = await autonomyControl.start();
      autonomyControlPort = controlAddress.port;
    }
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
      cat_run_registry: catRunRegistry,
      ...(autonomy === null ? {} : { on_task_complete: autonomy.taskCompletionSink() }),
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
    const tts = new PythonTtsProvider({
      python_executable: absolutePath("P4HOME_TTS_PYTHON"),
      worker_script: absolutePath("P4HOME_TTS_WORKER"),
      model_path: absolutePath("P4HOME_TTS_MODEL"),
      model_revision: TTS_MODEL_REVISION,
      provider_version: TTS_PROVIDER_VERSION,
      timeout_ms: optionalInteger("P4HOME_TTS_TIMEOUT_MS", 120_000, 1_000, 120_000),
    });
    const ttsPipeline = new RoleAwareTtsPipeline(tts);
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
        render_tts: async (interactionId, response, signal) => (
          await ttsPipeline.render(interactionId, response, signal)
        ),
        ui_output: "required",
        audio_output: "required",
      },
      cat_run_registry: catRunRegistry,
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
      audio_output: "required",
      raw_audio_retained: false,
      cat_autonomy_enabled: autonomyEnabled,
      cat_autonomy_ready: autonomy?.getStatus().product_ready ?? false,
      cat_autonomy_device_port: autonomyDevicePort,
      cat_autonomy_control_host: autonomyControl === null ? null : "127.0.0.1",
      cat_autonomy_control_port: autonomyControlPort,
    })}\n`);
    await waitForShutdown(shutdown.signal);
  } finally {
    await autonomyControl?.close().catch(() => undefined);
    const runtimeClose = runtime?.close().catch(() => undefined);
    const autonomyClose = autonomy?.close().catch(() => undefined);
    await Promise.all([runtimeClose, autonomyClose]);
    await deviceHub?.close().catch(() => undefined);
    await store?.closeAsync().catch(() => undefined);
    scheduler?.close();
    haClient?.close();
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    deviceTokenBytes.fill(0);
    autonomyControlTokenBytes?.fill(0);
    key.fill(0);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown_product_voice_error";
  process.stderr.write(`product voice runtime failed: ${message.slice(0, 256)}\n`);
  process.exitCode = 1;
});
