import assert from "node:assert/strict";
import test from "node:test";

import {
  TTS_ROLE_VOICES,
  type TtsProvider,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "@p4home/provider-tts";
import {
  RoleAwareTtsError,
  RoleAwareTtsPipeline,
  type ComposedRoleResponse,
} from "@p4home/runtime";

class FakeTtsProvider implements TtsProvider {
  readonly requests: TtsSynthesisRequest[] = [];
  readonly generated: Uint8Array[] = [];
  failAt = -1;

  public async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
    this.requests.push(structuredClone(request));
    if (request.segment_index === this.failAt) throw new Error("injected provider failure");
    const pcm = new Uint8Array(640);
    pcm.fill(request.role_id === "human" ? 1 : 2);
    this.generated.push(pcm);
    return {
      schema_version: 1,
      kind: "final_pcm",
      interaction_id: request.interaction_id,
      assignment_id: request.assignment_id,
      segment_index: request.segment_index,
      role_id: request.role_id,
      voice: request.voice,
      pcm,
      sample_rate_hz: 16_000,
      channels: 1,
      sample_bits: 16,
      samples: 320,
      duration_ms: 20,
    };
  }
}

function mixedResponse(): ComposedRoleResponse {
  return {
    schema_version: 1,
    status: "completed",
    text: "Human：\"Robot：灯已打开。\"\nRobot：\"书房灯已打开。\"",
    parts: [{
      assignment_id: "assignment:human:1",
      role_id: "human",
      source_span: { start: 0, end: 4 },
      status: "completed",
      outcome: "response",
      text: "Robot：灯已打开。",
      error_code: null,
      tool_results: [],
    }, {
      assignment_id: "assignment:robot:2",
      role_id: "robot",
      source_span: { start: 4, end: 9 },
      status: "completed",
      outcome: "response",
      text: "书房灯已打开。",
      error_code: null,
      tool_results: [{
        schema_version: 2,
        tool_call_id: "tool:1",
        name: "home.turn_on",
        status: "success",
        result: { state_changed: true },
        error: null,
      }],
    }],
  };
}

test("structured Composer parts render sequentially with distinguishable frozen role voices", async () => {
  const provider = new FakeTtsProvider();
  const response = mixedResponse();
  const result = await new RoleAwareTtsPipeline(provider).render("voice:interaction:1", response);

  assert.deepEqual(provider.requests.map((request) => ({
    role_id: request.role_id,
    voice: request.voice,
    text: request.text,
  })), [{
    role_id: "human",
    voice: TTS_ROLE_VOICES.human,
    text: "Robot：灯已打开。",
  }, {
    role_id: "robot",
    voice: TTS_ROLE_VOICES.robot,
    text: "书房灯已打开。",
  }]);
  assert.deepEqual(result.segments.map((segment) => segment.role_id), ["human", "robot"]);
  assert.equal(result.segments[0]?.pcm[0], 1);
  assert.equal(result.segments[1]?.pcm[0], 2);
  assert.equal(result.segments[0]?.robot_tool_terminals.length, 0);
  assert.equal(result.segments[1]?.robot_tool_terminals[0]?.status, "success");
  assert.equal(result.pcm_bytes, 1_280);
  assert.deepEqual(result.role_response, response);
  assert.notEqual(result.role_response, response);
});

test("Human prose cannot create a Robot voice segment or forge Robot execution provenance", async () => {
  const provider = new FakeTtsProvider();
  const response = mixedResponse();
  const humanOnly: ComposedRoleResponse = {
    ...response,
    parts: [response.parts[0]!],
  };
  const result = await new RoleAwareTtsPipeline(provider).render("voice:interaction:2", humanOnly);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.role_id, "human");
  assert.equal(result.segments[0]?.voice, TTS_ROLE_VOICES.human);
  assert.equal(result.segments[0]?.robot_tool_terminals.length, 0);
});

test("streaming Human segment validates identity and transfers PCM chunks incrementally", async () => {
  const requests: TtsSynthesisRequest[] = [];
  const generated = [new Uint8Array(320).fill(3), new Uint8Array(640).fill(4)];
  const provider: TtsProvider = {
    async synthesize(): Promise<TtsSynthesisResult> { throw new Error("unused"); },
    async *stream(request) {
      requests.push(structuredClone(request));
      for (const [chunkIndex, pcm] of generated.entries()) {
        yield {
          schema_version: 1,
          kind: "pcm_chunk",
          interaction_id: request.interaction_id,
          assignment_id: request.assignment_id,
          segment_index: request.segment_index,
          role_id: request.role_id,
          voice: request.voice,
          chunk_index: chunkIndex,
          pcm,
          sample_rate_hz: 16_000,
          channels: 1,
          sample_bits: 16,
          samples: pcm.byteLength / 2,
          duration_ms: pcm.byteLength / 2 / 16_000 * 1_000,
          final: false,
        };
      }
    },
  };
  const received: Uint8Array[] = [];
  for await (const pcm of new RoleAwareTtsPipeline(provider).streamHumanSegment(
    "voice:interaction:stream",
    {
      schema_version: 1,
      interaction_id: "voice:interaction:stream",
      assignment_id: "assignment:human:stream",
      segment_index: 2,
      role_id: "human",
      text: "现在就开始说。",
    },
  )) {
    received.push(pcm.slice());
    pcm.fill(0);
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.voice, TTS_ROLE_VOICES.human);
  assert.equal(requests[0]?.text, "现在就开始说。");
  assert.deepEqual(received.map((pcm) => pcm.byteLength), [320, 640]);
  assert.ok(generated.every((pcm) => pcm.every((value) => value === 0)));
});

test("Robot error and unknown terminals override model prose with deterministic truth", async () => {
  const provider = new FakeTtsProvider();
  const response = mixedResponse();
  const robot = response.parts[1]!;
  const unknownResponse: ComposedRoleResponse = {
    ...response,
    parts: [{
      ...robot,
      text: "设备已经成功打开。",
      tool_results: [{
        schema_version: 2,
        tool_call_id: "tool:unknown",
        name: "home.turn_on",
        status: "error",
        result: null,
        error: {
          code: "HA_OUTCOME_UNKNOWN",
          message: "outcome unknown",
          retryable: false,
        },
      }],
    }],
  };
  const result = await new RoleAwareTtsPipeline(provider).render("voice:interaction:3", unknownResponse);
  assert.equal(provider.requests[0]?.text, "设备操作结果尚不确定。");
  assert.equal(result.segments[0]?.robot_tool_terminals[0]?.error_code, "HA_OUTCOME_UNKNOWN");
});

test("provider failure discards the render result without rewriting the Role execution truth", async () => {
  const provider = new FakeTtsProvider();
  provider.failAt = 1;
  const response = mixedResponse();
  const before = structuredClone(response);
  await assert.rejects(
    new RoleAwareTtsPipeline(provider).render("voice:interaction:4", response),
    (error: unknown) => error instanceof RoleAwareTtsError && error.code === "PROVIDER_ERROR",
  );
  assert.deepEqual(response, before);
  assert.equal(response.parts[1]?.tool_results[0]?.status, "success");
  assert.ok(provider.generated.every((pcm) => pcm.every((sample) => sample === 0)));
});

test("invalid composition, Human tool terminals and pre-aborted renders fail closed", async () => {
  const response = mixedResponse();
  const invalidResponse: ComposedRoleResponse = {
    ...response,
    parts: [{ ...response.parts[0]!, tool_results: response.parts[1]!.tool_results }],
  };
  await assert.rejects(
    new RoleAwareTtsPipeline(new FakeTtsProvider()).render("voice:interaction:5", invalidResponse),
    (error: unknown) => error instanceof RoleAwareTtsError && error.code === "INVALID_COMPOSITION",
  );

  const controller = new AbortController();
  controller.abort(new Error("barge in"));
  await assert.rejects(
    new RoleAwareTtsPipeline(new FakeTtsProvider()).render(
      "voice:interaction:6", mixedResponse(), controller.signal,
    ),
    (error: unknown) => error instanceof RoleAwareTtsError && error.code === "CANCELLED",
  );
});

test("provider identity and PCM geometry are revalidated and malformed PCM is wiped", async () => {
  const generated = new Uint8Array(640);
  generated.fill(7);
  const provider: TtsProvider = {
    async synthesize(request): Promise<TtsSynthesisResult> {
      return {
        schema_version: 1,
        kind: "final_pcm",
        interaction_id: request.interaction_id,
        assignment_id: "foreign-assignment",
        segment_index: request.segment_index,
        role_id: request.role_id,
        voice: request.voice,
        pcm: generated,
        sample_rate_hz: 16_000,
        channels: 1,
        sample_bits: 16,
        samples: 319,
        duration_ms: 20,
      };
    },
  };
  await assert.rejects(
    new RoleAwareTtsPipeline(provider).render("voice:interaction:invalid-provider", mixedResponse()),
    (error: unknown) => error instanceof RoleAwareTtsError && error.code === "PROVIDER_ERROR",
  );
  assert.ok(generated.every((sample) => sample === 0));
});
