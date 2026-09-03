import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { DecodedVoiceFrame } from "@p4home/contracts";
import {
  PythonSttProvider,
  STT_MODEL_REVISION,
  STT_PROVIDER_VERSION,
} from "@p4home/provider-stt";
import type { OllamaChatResult } from "@p4home/provider-ollama";
import {
  RoleScheduler,
  RoleSessionRegistry,
  UnifiedVoiceRoleDispatcher,
  VoiceSttPipeline,
  phase5cTranscriptMatches,
  type VoiceCaptureSummary,
} from "@p4home/runtime";
import { SqliteAuditStore } from "@p4home/storage-sqlite";

const liveTest = process.env.P4HOME_STT_LIVE === "1" ? test : test.skip;
const SESSION_ID = "0123456789abcdeffedcba9876543210";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`missing ${name}`);
  return value;
}

function summary(status: VoiceCaptureSummary["status"], eos: boolean): VoiceCaptureSummary {
  return {
    device_id: "phase5c-prerecorded",
    session_id: SESSION_ID,
    stream_id: 1,
    epoch: 1,
    status,
    frames: 0,
    bytes: 0,
    dropped_frames: 0,
    peak_abs: 0,
    eos,
  };
}

function frame(sequence: number, payload: Uint8Array): DecodedVoiceFrame {
  return {
    header: {
      kind: "capture_pcm",
      flags: 0,
      sessionId: Buffer.from(SESSION_ID, "hex"),
      streamId: 1,
      epoch: 1,
      sequence,
      captureTimeUs: BigInt(sequence * 20_000),
      payloadBytes: 640,
      sampleRateHz: 16_000,
      frameSamples: 320,
      channels: 1,
      bitsPerSample: 16,
    },
    payload,
  };
}

liveTest("pinned MLX Whisper prerecorded final enters the audited unified Human runtime", async () => {
  const pcm = await readFile(requiredEnvironment("P4HOME_STT_PCM_FILE"));
  assert.ok(pcm.byteLength > 0 && pcm.byteLength <= 640_000 && pcm.byteLength % 2 === 0);
  const provider = new PythonSttProvider({
    python_executable: requiredEnvironment("P4HOME_STT_PYTHON"),
    worker_script: requiredEnvironment("P4HOME_STT_WORKER"),
    model_path: requiredEnvironment("P4HOME_STT_MODEL"),
    model_revision: STT_MODEL_REVISION,
    provider_version: STT_PROVIDER_VERSION,
    timeout_ms: 120_000,
  });
  using store = new SqliteAuditStore(":memory:");
  const sessions = new RoleSessionRegistry({
    robot: "phase5c-live-robot",
    human: "phase5c-live-human",
    cat: "phase5c-live-cat",
  });
  const scheduler = new RoleScheduler(1);
  let calls = 0;
  const dispatcher = new UnifiedVoiceRoleDispatcher({
    sessions,
    scheduler,
    audit: { store },
    provider: {
      async chat(request): Promise<OllamaChatResult> {
        calls++;
        if (calls === 1) {
          return {
            model: "phase5c-live-router",
            message: {
              role: "assistant",
              content: JSON.stringify({
                assignments: [{ role: "human", text: request.messages.at(-1)?.content ?? "" }],
              }),
            },
          };
        }
        return {
          model: "phase5c-live-human",
          message: { role: "assistant", content: "我听到了。" },
        };
      },
    },
  });
  const pipeline = new VoiceSttPipeline({
    provider,
    stt_timeout_ms: 120_000,
    dispatch_final: async (interaction, signal) => {
      assert.equal(phase5cTranscriptMatches(interaction.text), true,
        "the fixed prerecorded gate transcript must match before role dispatch");
      const result = await dispatcher.dispatch(interaction, signal);
      assert.equal(result.run.role_id, "human");
      assert.equal(result.run.status, "completed");
      assert.equal(result.composition_audit_status, "persisted");
      assert.equal((await store.getRunTrace(`run:${interaction.interaction_id}`))?.run.status,
        "completed");
    },
  });

  const active = summary("active", false);
  pipeline.onSessionOpen(active);
  let sequence = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 640, sequence++) {
    const payload = new Uint8Array(640);
    payload.set(pcm.subarray(offset, Math.min(offset + 640, pcm.byteLength)));
    pipeline.onFrame(active, frame(sequence, payload));
  }
  for (let index = 0; index < 40; index++, sequence++) {
    pipeline.onFrame(active, frame(sequence, new Uint8Array(640)));
  }
  pipeline.onSessionClosed(summary("completed", true));
  await pipeline.drain();

  assert.equal(pipeline.results.at(-1)?.outcome, "dispatched");
  assert.equal(calls, 2);
  assert.equal(sessions.get("robot").history().length, 0);
  assert.equal(sessions.get("cat").history().length, 0);
  provider.close();
  scheduler.close();
});
