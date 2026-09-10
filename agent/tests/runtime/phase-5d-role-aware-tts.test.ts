import assert from "node:assert/strict";
import test from "node:test";
import type { ToolErrorCode } from "@p4home/core";

import {
  TTS_ROLE_VOICES,
  QWEN3_TTS_ROLE_VOICES,
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
  assert.equal(provider.requests[0]?.text, "请求已发出，但没有确认设备是否完成操作。请先核对设备状态，系统不会自动重试。");
  assert.equal(result.segments[0]?.robot_tool_terminals[0]?.error_code, "HA_OUTCOME_UNKNOWN");
});

test("Robot failure speech explains structured causes without speaking server messages or success prose", async () => {
  const response = mixedResponse();
  const cases = [
    ["UNAUTHORIZED_HA_ACTION", "控制权限"], ["UNKNOWN_ENTITY", "设备名称"],
    ["HA_OFFLINE", "未连接"], ["HA_REJECTED", "拒绝"],
    ["HA_STATE_MISSING", "没有读取到"], ["HA_STATE_INVALID", "状态异常"],
    ["INVALID_HA_TOOL_CALL", "设备指令"], ["ROLE_POLICY_VIOLATION", "设备指令"],
    ["TIMEOUT", "超时"], ["DEADLINE_EXCEEDED", "超时"], ["CANCELLED", "取消"],
    ["UNREACHABLE", "模型服务"], ["MODEL_NOT_FOUND", "模型服务"],
    ["HTTP_ERROR", "模型服务"], ["INVALID_RESPONSE", "模型服务"],
    ["UNEXPECTED_PROVIDER_ERROR", "模型服务"], ["NEW_UNKNOWN_ERROR", "没有提供"],
  ];
  for (const [code, expected] of cases) {
    for (const terminalError of [true, false]) {
      const provider = new FakeTtsProvider();
      await new RoleAwareTtsPipeline(provider).render("voice:failure:reason", {
        ...response,
        parts: [{
          ...response.parts[1]!, status: "failed", error_code: code!, text: "设备已经成功打开。",
          tool_results: terminalError ? [{
            schema_version: 2, tool_call_id: "tool:failure", name: "home.turn_on",
            status: "error", result: null,
            // Include unexpected boundary codes to check the safe fallback.
            error: { code: code as ToolErrorCode, message: "private-server-detail", retryable: false },
          }] : [],
        }],
      });
      const text = provider.requests[0]!.text;
      assert.ok(text.includes(expected!), code);
      assert.doesNotMatch(text, /private-server-detail|成功打开/);
    }
  }
});

test("mixed Robot terminals preserve partial success, unknown outcome and skipped operations", async () => {
  const response = mixedResponse();
  const provider = new FakeTtsProvider();
  const result = await new RoleAwareTtsPipeline(provider).render("voice:failure:mixed", {
    ...response, parts: [{
      ...response.parts[1]!, status: "failed", error_code: "HA_OUTCOME_UNKNOWN",
      tool_results: [response.parts[1]!.tool_results[0]!, ...(["HA_OUTCOME_UNKNOWN", "CANCELLED"] as const).map((code, index) => ({
        schema_version: 2 as const, tool_call_id: `tool:error:${index}`, name: "home.turn_on",
        status: "error" as const, result: null,
        error: { code, message: "not spoken", retryable: false },
      }))],
    }],
  });
  assert.match(result.segments[0]!.text, /^部分设备请求已完成。请求已发出/);
  assert.match(result.segments[0]!.text, /不会自动重试。后续操作已取消。$/);
  assert.equal(result.segments[0]!.robot_tool_terminals.length, 3);
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

test("Human avatar completion can speak with Human voice and cannot become Robot evidence", async () => {
  const provider = new FakeTtsProvider();
  const response: ComposedRoleResponse = {
    schema_version: 1, status: "completed", text: "已到书房。",
    parts: [{
      assignment_id: "avatar:1", role_id: "human", source_span: { start: 0, end: 5 },
      status: "completed", outcome: "response", text: "已到书房。", error_code: null,
      tool_results: [{ schema_version: 3, tool_call_id: "avatar:move:1", name: "character.go_to_room",
        status: "success", result: { room_id: "study" }, error: null }],
    }],
  };
  const result = await new RoleAwareTtsPipeline(provider).render("voice:avatar:1", response);
  assert.equal(provider.requests[0]?.role_id, "human");
  assert.equal(provider.requests[0]?.text, "已到书房。");
  assert.deepEqual(result.segments[0]?.robot_tool_terminals, []);
  const invalid = structuredClone(response);
  Object.assign(invalid.parts[0]!.tool_results[0]!, { result: { room_id: "unknown" } });
  await assert.rejects(new RoleAwareTtsPipeline(new FakeTtsProvider()).render("voice:avatar:2", invalid),
    (error: unknown) => error instanceof RoleAwareTtsError && error.code === "INVALID_COMPOSITION");
});


test("Qwen3 role projection changes voices without changing text or HA terminals", async () => {
  const provider = new FakeTtsProvider();
  const response = mixedResponse();
  const result = await new RoleAwareTtsPipeline(provider, QWEN3_TTS_ROLE_VOICES)
    .render("voice:qwen3:roles", response);
  assert.deepEqual(result.segments.map(s => s.voice), ["Serena", "Vivian"]);
  assert.equal(result.segments[0]!.text, response.parts[0]!.text);
  assert.equal(result.segments[1]!.robot_tool_terminals[0]!.name, "home.turn_on");
  for (const segment of result.segments) segment.pcm.fill(0);
});
