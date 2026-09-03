import {
  defaultLowPriorityCatRunRegistry,
  type LowPriorityCatRunRegistry,
} from "./low-priority-cat-run-registry.ts";
import {
  bindVoiceInteractionCoordinator,
  VoiceInteractionCoordinator,
  type VoiceInteractionCoordinatorOptions,
} from "./voice-interaction-coordinator.ts";
import { VoiceSttPipeline, type VoiceSttPipelineOptions } from "./voice-stt-pipeline.ts";
import {
  VoiceWebSocketServer,
  type VoiceWebSocketServerAddress,
  type VoiceWebSocketServerOptions,
  type VoiceCaptureSummary,
} from "./voice-websocket-server.ts";

export interface UnifiedVoiceRuntimeOptions {
  readonly server: Omit<
    VoiceWebSocketServerOptions,
    "device_tokens" | "sink" | "on_device_disconnect"
  >;
  readonly device_tokens: Readonly<Record<string, string>>;
  readonly stt: Omit<VoiceSttPipelineOptions, "dispatch_final" | "on_capture_open">;
  readonly interaction: Omit<
    VoiceInteractionCoordinatorOptions,
    "device_ids" | "playback" | "playback_stream" | "present_ui" | "cancel_low_priority_cat"
  >;
  readonly cat_run_registry?: LowPriorityCatRunRegistry;
  readonly on_capture_open?: (summary: VoiceCaptureSummary) => void;
}

/**
 * Product assembly for capture -> STT -> Role -> TTS -> playback. It also
 * shares the Cat lease registry used by both Cat product entrypoints so a new
 * capture fences low-priority work before the new voice interaction dispatches.
 */
export class UnifiedVoiceRuntime {
  public readonly server: VoiceWebSocketServer;
  public readonly pipeline: VoiceSttPipeline;
  public readonly coordinator: VoiceInteractionCoordinator;
  public readonly cat_run_registry: LowPriorityCatRunRegistry;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #shutdownStarted = false;

  public constructor(options: UnifiedVoiceRuntimeOptions) {
    const deviceIds = Object.keys(options.device_tokens);
    this.cat_run_registry = options.cat_run_registry ?? defaultLowPriorityCatRunRegistry;
    let server: VoiceWebSocketServer;
    this.coordinator = new VoiceInteractionCoordinator({
      ...options.interaction,
      device_ids: deviceIds,
      playback: async (deviceId, pcm, signal) => await server.playback(deviceId, pcm, signal),
      ...(options.interaction.render_tts_stream === undefined
        ? {}
        : {
            playback_stream: async (
              deviceId: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal,
            ) => await server.playbackStream(deviceId, source, signal),
          }),
      present_ui: async (deviceId, update, signal) => {
        if (signal.aborted) throw signal.reason;
        return await server.presentConversationUi(deviceId, update, undefined, signal);
      },
      cancel_low_priority_cat: () => { this.cat_run_registry.cancelAll("barge_in"); },
      stt_duration_ms: (context) => this.pipeline.takeProviderDurationMs(context),
    });
    const bindings = bindVoiceInteractionCoordinator(this.coordinator);
    this.pipeline = new VoiceSttPipeline({
      ...options.stt,
      on_capture_open: (summary) => {
        bindings.on_capture_open(summary);
        options.on_capture_open?.(summary);
      },
      dispatch_final: bindings.dispatch_final,
    });
    server = new VoiceWebSocketServer({
      ...options.server,
      device_tokens: options.device_tokens,
      sink: this.pipeline,
      on_device_disconnect: bindings.on_device_disconnect,
    });
    this.server = server;
  }

  public async start(): Promise<VoiceWebSocketServerAddress> {
    if (this.#shutdownStarted) throw new TypeError("unified voice runtime is closed");
    return await this.server.start();
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closePromise !== null) return await this.#closePromise;
    this.#shutdownStarted = true;
    const operation = this.#cleanup();
    this.#closePromise = operation;
    try {
      await operation;
      this.#closed = true;
    } finally {
      if (this.#closePromise === operation) this.#closePromise = null;
    }
  }

  async #cleanup(): Promise<void> {
    this.coordinator.close();
    this.cat_run_registry.cancelAll("shutdown");
    this.pipeline.close();
    const settled = await Promise.allSettled([
      Promise.resolve().then(async () => await this.server.close()),
      Promise.resolve().then(async () => await this.pipeline.drain()),
    ]);
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "unified voice runtime cleanup failed");
  }
}
