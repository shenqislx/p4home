import {
  defaultLowPriorityCatRunRegistry,
  type LowPriorityCatRunRegistry,
} from "./low-priority-cat-run-registry.ts";
import {
  bindVoiceInteractionCoordinator,
  VoiceInteractionCoordinator,
  type VoiceInteractionCoordinatorOptions,
} from "./voice-interaction-coordinator.ts";
import { VoiceSttPipeline, type VoiceSttPipelineOptions, type VoiceSttResult } from "./voice-stt-pipeline.ts";
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
  #captures = new Map<string, VoiceCaptureSummary>();
  #terminalUi = new Map<string, AbortController>();
  #terminalWork = new Set<Promise<void>>();
  #uiEnabled: boolean;

  public constructor(options: UnifiedVoiceRuntimeOptions) {
    this.#uiEnabled = options.interaction.ui_output === "required";
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
        this.#terminalUi.get(summary.device_id)?.abort();
        this.#captures.set(summary.device_id, summary);
        options.on_capture_open?.(summary);
      },
      dispatch_final: bindings.dispatch_final,
      on_result: (result) => {
        this.#captureFinished(result);
        // Diagnostic callback failures cannot prevent the functional terminal.
        options.stt.on_result?.(result);
      },
    });
    server = new VoiceWebSocketServer({
      ...options.server,
      device_tokens: options.device_tokens,
      sink: this.pipeline,
      on_device_disconnect: (deviceId) => {
        this.#captures.delete(deviceId);
        this.#terminalUi.get(deviceId)?.abort();
        bindings.on_device_disconnect(deviceId);
      },
    });
    this.server = server;
  }

  #captureFinished(result: VoiceSttResult): void {
    const capture = this.#captures.get(result.device_id);
    if (capture === undefined || capture.epoch !== result.epoch
        || capture.session_id !== result.session_id || capture.stream_id !== result.stream_id) return;
    this.#captures.delete(result.device_id);
    if (this.#shutdownStarted || !this.#uiEnabled || result.outcome === "dispatched"
        || result.outcome === "stale" || result.outcome === "dispatch_failed") return;
    const cancelled = result.outcome === "cancelled";
    const response = result.outcome === "timed_out"
      ? "识别超时，请重新唤醒后再说一次。"
      : cancelled ? "本次识别已取消，请重新唤醒。"
        : result.outcome === "provider_error" ? "识别暂时不可用，请重新唤醒后重试。"
          : "没有听清，请重新唤醒后再说一次。";
    const controller = new AbortController();
    this.#terminalUi.set(result.device_id, controller);
    const work = (async () => {
      try {
        await this.server.presentConversationUi(result.device_id, {
          ui_protocol_version: 1, type: "ui.update", session_id: result.session_id,
          stream_id: result.stream_id, epoch: result.epoch, revision: 1,
          stage: cancelled ? "cancelled" : "failed", user_text: "", response_text: response,
          response_role: "system", execution_status: cancelled ? "not_applicable" : "failed",
        }, undefined, controller.signal);
      } catch {
        // Socket delivery has a bounded ACK deadline; device-local timeout is
        // the final fallback. Never start TTS or replay stale capture work.
      } finally {
        if (this.#terminalUi.get(result.device_id) === controller) {
          this.#terminalUi.delete(result.device_id);
        }
      }
    })();
    this.#terminalWork.add(work);
    void work.finally(() => this.#terminalWork.delete(work));
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
    this.#captures.clear();
    for (const controller of this.#terminalUi.values()) controller.abort();
    this.coordinator.close();
    this.cat_run_registry.cancelAll("shutdown");
    this.pipeline.close();
    const settled = await Promise.allSettled([
      Promise.resolve().then(async () => await this.server.close()),
      Promise.resolve().then(async () => await this.pipeline.drain()),
      Promise.all([...this.#terminalWork]),
    ]);
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "unified voice runtime cleanup failed");
  }
}
