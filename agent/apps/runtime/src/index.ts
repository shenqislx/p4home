import { validateFrozenContracts } from "@p4home/contracts";

export * from "./text-agent.ts";
export * from "./cat-event-policy.ts";
export * from "./cat-autonomy-policy.ts";
export * from "./cat-autonomy-runtime.ts";
export * from "./product-cat-autonomy.ts";
export * from "./cat-autonomy-control-server.ts";
export * from "./cat-action-runner.ts";
export * from "./cat-object-event-policy.ts";
export * from "./cat-object-action-runner.ts";
export * from "./low-priority-cat-run-registry.ts";
export * from "./deterministic-fake-device.ts";
export * from "./device-action-adapter.ts";
export * from "./device-protocol.ts";
export * from "./device-websocket-server.ts";
export * from "./voice-websocket-server.ts";
export * from "./voice-playback-sender.ts";
export * from "./voice-interaction-coordinator.ts";
export * from "./unified-voice-runtime.ts";
export * from "./voice-stt-pipeline.ts";
export * from "./voice-role-dispatcher.ts";
export * from "./phase5c-stt-gate.ts";
export * from "./phase5e-voice-gate.ts";
export * from "./phase4c-ha-gate-core.ts";
export * from "./phase4c-ha-identity.ts";
export * from "./role-aware-tts.ts";
export * from "./model-config.ts";
export * from "./ollama-chat-timing.ts";
export * from "./product-voice-config.ts";
export * from "./role-contracts.ts";
export * from "./role-audit.ts";
export * from "./role-orchestrator.ts";
export * from "./role-profiles.ts";
export * from "./role-response-policy.ts";
export * from "./role-response-composer.ts";
export * from "./role-router.ts";
export * from "./robot-ha-read-runner.ts";
export * from "./robot-ha-write-runner.ts";
export * from "./role-runner.ts";
export * from "./role-scheduler.ts";
export * from "./role-session.ts";
export * from "./structured-logger.ts";
export * from "./text-agent-audit.ts";
export * from "./memory-policy.ts";
export * from "./memory-storage-policy.ts";
export * from "./memory-write-coordinator.ts";
export * from "./role-memory.ts";
export * from "./role-context-builder.ts";

export function runtimeHealth(): Record<string, unknown> {
  return {
    status: "ready",
    contracts: validateFrozenContracts(),
  };
}
