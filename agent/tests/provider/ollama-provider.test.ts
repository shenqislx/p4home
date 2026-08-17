import assert from "node:assert/strict";
import test from "node:test";
import {
  OllamaHttpProvider,
  OllamaProviderError,
  type OllamaFetch,
} from "@p4home/provider-ollama";

const MODEL = "qwen3:8b";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assertProviderError(error: unknown, code: OllamaProviderError["code"]): boolean {
  assert.ok(error instanceof OllamaProviderError);
  assert.equal(error.code, code);
  return true;
}

test("probe reports server, model and declared capabilities without loading the model", async () => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  const responses = [
    jsonResponse({ version: "0.32.6" }),
    jsonResponse({ models: [{ name: MODEL, model: MODEL }] }),
    jsonResponse({ capabilities: ["completion", "tools", "thinking"] }),
  ];
  const fetch: OllamaFetch = async (input, init) => {
    calls.push({ url: input.toString(), init });
    const response = responses.shift();
    assert.ok(response !== undefined);
    return response;
  };
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });

  const capabilities = await provider.probe();

  assert.deepEqual(capabilities, {
    serverVersion: "0.32.6",
    model: MODEL,
    modelAvailable: true,
    declaredCapabilities: ["completion", "tools", "thinking"],
    toolCalling: true,
    structuredOutput: false,
    structuredOutputApi: true,
    streaming: true,
    cancellation: true,
  });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/api/version", "/api/tags", "/api/show"],
  );
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    model: MODEL,
    verbose: false,
  });
});

test("probe reports a missing model without attempting show or generation", async () => {
  let callCount = 0;
  const fetch: OllamaFetch = async () => {
    callCount += 1;
    return callCount === 1
      ? jsonResponse({ version: "0.32.6" })
      : jsonResponse({ models: [{ name: "another:latest" }] });
  };
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });

  const capabilities = await provider.probe();

  assert.equal(callCount, 2);
  assert.equal(capabilities.modelAvailable, false);
  assert.equal(capabilities.toolCalling, false);
  assert.equal(capabilities.structuredOutput, false);
  assert.equal(capabilities.structuredOutputApi, false);
  assert.deepEqual(capabilities.declaredCapabilities, []);
});

test("generate sends a non-streaming request and normalizes usage metrics", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetch: OllamaFetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      model: MODEL,
      response: "你好",
      thinking: "",
      done: true,
      done_reason: "stop",
      total_duration: 12,
      prompt_eval_count: 5,
      eval_count: 2,
    });
  };
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });

  const result = await provider.generate({
    prompt: "打个招呼",
    system: "只说一句话",
    options: { temperature: 0 },
    think: false,
  });

  assert.deepEqual(requestBody, {
    model: MODEL,
    prompt: "打个招呼",
    system: "只说一句话",
    options: { temperature: 0 },
    think: false,
    stream: false,
  });
  assert.deepEqual(result, {
    model: MODEL,
    response: "你好",
    thinking: "",
    done_reason: "stop",
    total_duration_ns: 12,
    prompt_eval_count: 5,
    eval_count: 2,
  });
});

test("generate locally validates structured output", async () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
    additionalProperties: false,
  } as const;
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () =>
      jsonResponse({
        model: MODEL,
        response: '{"answer":1}',
        done: true,
      }),
  });

  await assert.rejects(
    provider.generate({ prompt: "回答", format: schema }),
    (error) => assertProviderError(error, "INVALID_RESPONSE"),
  );
});

test("chat sends native tools and normalizes terminal tool calls", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetch: OllamaFetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      model: MODEL,
      message: {
        role: "assistant",
        content: "",
        thinking: "需要移动角色",
        tool_calls: [
          {
            function: {
              index: 0,
              name: "character.go_to_room",
              arguments: { room_id: "study" },
            },
          },
        ],
      },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 30,
    });
  };
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });

  const result = await provider.chat({
    messages: [{ role: "user", content: "去书房" }],
    tools: [
      {
        type: "function",
        function: {
          name: "character.go_to_room",
          description: "移动到房间",
          parameters: {
            type: "object",
            required: ["room_id"],
            properties: { room_id: { enum: ["study"] } },
          },
        },
      },
    ],
    options: { temperature: 0, num_ctx: 8192 },
    think: false,
  });

  assert.deepEqual(requestBody, {
    model: MODEL,
    messages: [{ role: "user", content: "去书房" }],
    tools: [
      {
        type: "function",
        function: {
          name: "character.go_to_room",
          description: "移动到房间",
          parameters: {
            type: "object",
            required: ["room_id"],
            properties: { room_id: { enum: ["study"] } },
          },
        },
      },
    ],
    options: { temperature: 0, num_ctx: 8192 },
    think: false,
    stream: false,
  });
  assert.deepEqual(result, {
    model: MODEL,
    message: {
      role: "assistant",
      content: "",
      thinking: "需要移动角色",
      tool_calls: [
        {
          type: "function",
          function: {
            index: 0,
            name: "character.go_to_room",
            arguments: { room_id: "study" },
          },
        },
      ],
    },
    done_reason: "stop",
    prompt_eval_count: 30,
  });
});

test("chat passes structured-output format and rejects malformed tool calls", async () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
    additionalProperties: false,
  } as const;
  let requestBody: Record<string, unknown> | undefined;
  const structured = new OllamaHttpProvider({
    model: MODEL,
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        model: MODEL,
        message: { role: "assistant", content: '{"answer":"ok"}' },
        done: true,
      });
    },
  });

  await structured.chat({
    messages: [{ role: "user", content: "回答" }],
    format: schema,
  });
  assert.deepEqual(requestBody?.format, schema);

  const invalidJson = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () =>
      jsonResponse({
        model: MODEL,
        message: { role: "assistant", content: "not-json" },
        done: true,
      }),
  });
  await assert.rejects(
    invalidJson.chat({ messages: [{ role: "user", content: "回答" }], format: schema }),
    (error) => assertProviderError(error, "INVALID_RESPONSE"),
  );

  const schemaMismatch = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () =>
      jsonResponse({
        model: MODEL,
        message: { role: "assistant", content: '{"answer":1}' },
        done: true,
      }),
  });
  await assert.rejects(
    schemaMismatch.chat({ messages: [{ role: "user", content: "回答" }], format: schema }),
    (error) => assertProviderError(error, "INVALID_RESPONSE"),
  );

  const malformed = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () =>
      jsonResponse({
        model: MODEL,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "character.say", arguments: "not-an-object" } }],
        },
        done: true,
      }),
  });
  await assert.rejects(
    malformed.chat({ messages: [{ role: "user", content: "说话" }] }),
    (error) => assertProviderError(error, "INVALID_RESPONSE"),
  );
});

test("structured format allows an empty content field while the model requests a tool", async () => {
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () =>
      jsonResponse({
        model: MODEL,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "character.get_state", arguments: {} } },
          ],
        },
        done: true,
      }),
  });

  const result = await provider.chat({
    messages: [{ role: "user", content: "状态" }],
    tools: [
      {
        type: "function",
        function: {
          name: "character.get_state",
          description: "读取状态",
          parameters: { type: "object", additionalProperties: false },
        },
      },
    ],
    format: {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string" } },
    },
  });

  assert.equal(result.message.tool_calls?.[0]?.function.name, "character.get_state");
});

test("chat validates tool messages and supports cancellation", async () => {
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal !== undefined && signal !== null);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });

  await assert.rejects(
    provider.chat({ messages: [{ role: "tool", content: "done" }] }),
    /tool messages must include tool_name/,
  );

  const controller = new AbortController();
  const pending = provider.chat(
    { messages: [{ role: "user", content: "等待" }] },
    controller.signal,
  );
  controller.abort(new Error("test cancellation"));
  await assert.rejects(pending, (error) => assertProviderError(error, "CANCELLED"));
});

test("stream parses NDJSON across transport chunk boundaries", async () => {
  const encoder = new TextEncoder();
  const payload = [
    JSON.stringify({ model: MODEL, response: "你", thinking: "", done: false }),
    JSON.stringify({
      model: MODEL,
      response: "好",
      thinking: "",
      done: true,
      done_reason: "stop",
      eval_count: 2,
    }),
  ].join("\n");
  const fetch: OllamaFetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload.slice(0, 37)));
          controller.enqueue(encoder.encode(payload.slice(37)));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });

  const chunks = [];
  for await (const chunk of provider.stream({ prompt: "打个招呼" })) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 2);
  assert.equal(chunks.map((chunk) => chunk.response).join(""), "你好");
  assert.equal(chunks[1]?.done, true);
  assert.equal(chunks[1]?.eval_count, 2);
});

test("stream locally validates complete structured output", async () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string" } },
    additionalProperties: false,
  } as const;
  const lines = [
    JSON.stringify({ model: MODEL, response: '{"answer":', done: false }),
    JSON.stringify({ model: MODEL, response: "1}", done: true }),
  ].join("\n");
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => new Response(lines),
  });

  await assert.rejects(
    async () => {
      for await (const _chunk of provider.stream({ prompt: "回答", format: schema })) {
        // Consume the stream so final structured-output validation runs.
      }
    },
    (error) => assertProviderError(error, "INVALID_RESPONSE"),
  );
});

test("stream rejects data after a terminal chunk", async () => {
  const lines = [
    JSON.stringify({ model: MODEL, response: "done", done: true }),
    JSON.stringify({ model: MODEL, response: "late", done: false }),
  ].join("\n");
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => new Response(lines),
  });

  await assert.rejects(
    async () => {
      for await (const _chunk of provider.stream({ prompt: "回答" })) {
        // Consume the complete response to validate terminal framing.
      }
    },
    (error) => assertProviderError(error, "INVALID_RESPONSE"),
  );
});

test("an external AbortSignal cancels an active generation", async () => {
  const fetch: OllamaFetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal !== undefined && signal !== null);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });
  const controller = new AbortController();

  const pending = provider.generate({ prompt: "等待" }, controller.signal);
  controller.abort(new Error("test cancellation"));

  await assert.rejects(pending, (error) => assertProviderError(error, "CANCELLED"));
});

test("relative timeout terminates a transport that honors AbortSignal", async () => {
  const fetch: OllamaFetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal !== undefined && signal !== null);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const provider = new OllamaHttpProvider({ model: MODEL, fetch, requestTimeoutMs: 100 });

  await assert.rejects(
    provider.generate({ prompt: "等待" }),
    (error) => assertProviderError(error, "TIMEOUT"),
  );
});

test("the first abort source determines cancellation versus timeout", async () => {
  const fetch: OllamaFetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal !== undefined && signal !== null);
      signal.addEventListener("abort", () => {
        setTimeout(() => reject(signal.reason), 120);
      }, { once: true });
    });
  const provider = new OllamaHttpProvider({ model: MODEL, fetch, requestTimeoutMs: 100 });
  const controller = new AbortController();
  const pending = provider.generate({ prompt: "等待" }, controller.signal);
  controller.abort(new Error("user cancelled first"));

  await assert.rejects(pending, (error) => assertProviderError(error, "CANCELLED"));
});

test("an external AbortSignal cancels an active NDJSON stream", async () => {
  const encoder = new TextEncoder();
  const fetch: OllamaFetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal !== undefined && signal !== null);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                model: MODEL,
                response: "first",
                thinking: "",
                done: false,
              })}\n`,
            ),
          );
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }),
    );
  };
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });
  const controller = new AbortController();
  const iterator = provider.stream({ prompt: "等待" }, controller.signal)[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value?.response, "first");
  controller.abort(new Error("test cancellation"));

  await assert.rejects(iterator.next(), (error) => assertProviderError(error, "CANCELLED"));
});

test("transport and HTTP failures use stable provider error codes", async () => {
  const unreachable = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    unreachable.probe(),
    (error) => assertProviderError(error, "UNREACHABLE"),
  );

  const missing = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => jsonResponse({ error: `model '${MODEL}' not found` }, 404),
  });
  await assert.rejects(
    missing.generate({ prompt: "你好" }),
    (error) => assertProviderError(error, "MODEL_NOT_FOUND"),
  );

  const missingApi = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => jsonResponse({ error: "route not found" }, 404),
  });
  await assert.rejects(
    missingApi.probe(),
    (error) => assertProviderError(error, "HTTP_ERROR"),
  );
});

test("malformed or unterminated responses fail closed", async (context) => {
  await context.test("non-streaming response", async () => {
    const provider = new OllamaHttpProvider({
      model: MODEL,
      fetch: async () => jsonResponse({ model: MODEL, response: "partial", done: false }),
    });
    await assert.rejects(
      provider.generate({ prompt: "你好" }),
      (error) => assertProviderError(error, "INVALID_RESPONSE"),
    );
  });

  await context.test("stream without a terminal chunk", async () => {
    const line = `${JSON.stringify({
      model: MODEL,
      response: "partial",
      thinking: "",
      done: false,
    })}\n`;
    const provider = new OllamaHttpProvider({
      model: MODEL,
      fetch: async () => new Response(line),
    });
    await assert.rejects(
      async () => {
        for await (const _chunk of provider.stream({ prompt: "你好" })) {
          // Consume the stream so terminal validation runs.
        }
      },
      (error) => assertProviderError(error, "INVALID_RESPONSE"),
    );
  });
});
