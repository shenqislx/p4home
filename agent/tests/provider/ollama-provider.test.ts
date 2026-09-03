import assert from "node:assert/strict";
import test from "node:test";
import {
  OllamaHttpProvider,
  OllamaProviderError,
  type OllamaChatStreamEvent,
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

test("provider default keep_alive covers every generation and explicit requests override it", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: OllamaFetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const streaming = body.stream === true;
    const chat = new URL(input.toString()).pathname === "/api/chat";
    const value = chat
      ? { model: MODEL, message: { role: "assistant", content: "ok" }, done: true }
      : { model: MODEL, response: "ok", thinking: "", done: true };
    return new Response(streaming ? `${JSON.stringify(value)}\n` : JSON.stringify(value));
  };
  const provider = new OllamaHttpProvider({
    model: MODEL,
    defaultKeepAlive: " 30m ",
    fetch,
  });

  await provider.generate({ prompt: "generate" });
  await provider.chat({ messages: [{ role: "user", content: "chat" }] });
  for await (const _event of provider.chatStream({
    messages: [{ role: "user", content: "chat stream" }],
  })) {
    // Consume the terminal.
  }
  for await (const _chunk of provider.stream({ prompt: "generate stream" })) {
    // Consume the terminal.
  }
  await provider.chat({
    messages: [{ role: "user", content: "override" }],
    keep_alive: 0,
  });

  assert.deepEqual(bodies.map((body) => body.keep_alive), ["30m", "30m", "30m", "30m", 0]);
});

test("warmup performs one strict body-free model evaluation", async () => {
  let calls = 0;
  let request: Record<string, unknown> | undefined;
  const provider = new OllamaHttpProvider({
    model: MODEL,
    defaultKeepAlive: "30m",
    fetch: async (_input, init) => {
      calls++;
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        model: MODEL,
        message: { role: "assistant", content: "private warmup output", thinking: "" },
        done: true,
      });
    },
  });

  await Promise.all([provider.warmup(), provider.warmup()]);
  await provider.warmup();

  assert.equal(calls, 1);
  assert.equal(request?.think, false);
  assert.equal(request?.keep_alive, "30m");
  assert.equal(request?.tools, undefined);
  assert.equal(request?.stream, false);
});

test("capture refresh warmup coalesces concurrent work but refreshes a later keep-alive window", async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = new OllamaHttpProvider({
    model: MODEL,
    defaultKeepAlive: "10m",
    fetch: async () => {
      calls++;
      if (calls === 1) await gate;
      return jsonResponse({
        model: MODEL,
        message: { role: "assistant", content: "ok", thinking: "" },
        done: true,
      });
    },
  });

  const first = provider.refreshWarmup();
  const concurrent = provider.refreshWarmup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.notEqual(release, null);
  (release as unknown as () => void)();
  await Promise.all([first, concurrent]);
  await provider.refreshWarmup();

  assert.equal(calls, 2);
});

test("warmup fails readiness closed on identity thinking or tool output", async (context) => {
  const invalid = [
    {
      name: "empty content",
      response: { model: MODEL, message: { role: "assistant", content: "  " }, done: true },
    },
    {
      name: "model identity",
      response: { model: "other:latest", message: { role: "assistant", content: "ok" }, done: true },
    },
    {
      name: "thinking",
      response: {
        model: MODEL,
        message: { role: "assistant", content: "ok", thinking: "private" },
        done: true,
      },
    },
    {
      name: "tool call",
      response: {
        model: MODEL,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "unexpected", arguments: {} } }],
        },
        done: true,
      },
    },
  ] as const;
  for (const fixture of invalid) {
    await context.test(fixture.name, async () => {
      let calls = 0;
      const provider = new OllamaHttpProvider({
        model: MODEL,
        fetch: async () => {
          calls++;
          return jsonResponse(fixture.response);
        },
      });
      await assert.rejects(provider.warmup(), (error) => (
        assertProviderError(error, "INVALID_RESPONSE")
      ));
      await assert.rejects(provider.warmup(), (error) => (
        assertProviderError(error, "INVALID_RESPONSE")
      ));
      assert.equal(calls, 1);
    });
  }
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

test("chatStream preserves UTF-8 deltas and returns one complete terminal result", async () => {
  const encoder = new TextEncoder();
  const payload = [
    JSON.stringify({
      model: MODEL,
      message: { role: "assistant", content: "你", thinking: "想" },
      done: false,
    }),
    JSON.stringify({
      model: MODEL,
      message: {
        role: "assistant",
        content: "好",
        thinking: "好了",
        tool_calls: [
          { function: { index: 0, name: "character.say", arguments: { text: "你好" } } },
        ],
      },
      done: false,
    }),
    JSON.stringify({
      model: MODEL,
      message: { role: "assistant", content: "！" },
      done: true,
      done_reason: "stop",
      total_duration: 20,
      load_duration: 2,
      prompt_eval_count: 4,
      prompt_eval_duration: 5,
      eval_count: 3,
      eval_duration: 7,
    }),
  ].join("\n");
  const bytes = encoder.encode(payload);
  const multibyteStart = bytes.findIndex((byte) => byte >= 0x80);
  assert.notEqual(multibyteStart, -1);
  let requestBody: Record<string, unknown> | undefined;
  const fetch: OllamaFetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, multibyteStart + 1));
        controller.enqueue(bytes.slice(multibyteStart + 1));
        controller.close();
      },
    }));
  };
  const provider = new OllamaHttpProvider({ model: MODEL, fetch });

  const events: OllamaChatStreamEvent[] = [];
  for await (const event of provider.chatStream({
    messages: [{ role: "user", content: "打个招呼" }],
    think: false,
  })) {
    events.push(event);
  }

  assert.equal(requestBody?.stream, true);
  assert.deepEqual(events.slice(0, 3), [
    { kind: "content_delta", model: MODEL, content: "你" },
    { kind: "content_delta", model: MODEL, content: "好" },
    { kind: "content_delta", model: MODEL, content: "！" },
  ]);
  assert.deepEqual(events[3], {
    kind: "terminal",
    result: {
      model: MODEL,
      message: {
        role: "assistant",
        content: "你好！",
        thinking: "想好了",
        tool_calls: [
          {
            type: "function",
            function: {
              index: 0,
              name: "character.say",
              arguments: { text: "你好" },
            },
          },
        ],
      },
      done_reason: "stop",
      total_duration_ns: 20,
      load_duration_ns: 2,
      prompt_eval_count: 4,
      prompt_eval_duration_ns: 5,
      eval_count: 3,
      eval_duration_ns: 7,
    },
  });
});

test("chatStream fails closed on invalid UTF-8", async () => {
  const prefix = Buffer.from(
    `{"model":"${MODEL}","message":{"role":"assistant","content":"`,
    "utf8",
  );
  const suffix = Buffer.from('"},"done":true}\n', "utf8");
  const invalid = Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]);
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(invalid);
        controller.close();
      },
    })),
  });

  await assert.rejects(async () => {
    for await (const _event of provider.chatStream({
      messages: [{ role: "user", content: "回答" }],
    })) {
      // Consume through EOF so the fatal decoder validates every byte.
    }
  }, (error) => assertProviderError(error, "INVALID_RESPONSE"));
});

test("chatStream fails closed on identity and terminal framing violations", async (context) => {
  const consume = async (provider: OllamaHttpProvider): Promise<void> => {
    for await (const _event of provider.chatStream({
      messages: [{ role: "user", content: "回答" }],
    })) {
      // Consume through EOF so framing validation runs.
    }
  };

  await context.test("model identity mismatch", async () => {
    const provider = new OllamaHttpProvider({
      model: MODEL,
      fetch: async () => new Response(`${JSON.stringify({
        model: "other:latest",
        message: { role: "assistant", content: "wrong" },
        done: true,
      })}\n`),
    });
    await assert.rejects(consume(provider), (error) => assertProviderError(error, "INVALID_RESPONSE"));
  });

  await context.test("missing terminal", async () => {
    const provider = new OllamaHttpProvider({
      model: MODEL,
      fetch: async () => new Response(`${JSON.stringify({
        model: MODEL,
        message: { role: "assistant", content: "partial" },
        done: false,
      })}\n`),
    });
    await assert.rejects(consume(provider), (error) => assertProviderError(error, "INVALID_RESPONSE"));
  });

  await context.test("data after terminal", async () => {
    const provider = new OllamaHttpProvider({
      model: MODEL,
      fetch: async () => new Response([
        JSON.stringify({
          model: MODEL,
          message: { role: "assistant", content: "done" },
          done: true,
        }),
        JSON.stringify({
          model: MODEL,
          message: { role: "assistant", content: "late" },
          done: false,
        }),
      ].join("\n")),
    });
    await assert.rejects(consume(provider), (error) => assertProviderError(error, "INVALID_RESPONSE"));
  });
});

test("chatStream validates aggregated structured output before terminal", async () => {
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => new Response([
      JSON.stringify({
        model: MODEL,
        message: { role: "assistant", content: '{"answer":' },
        done: false,
      }),
      JSON.stringify({
        model: MODEL,
        message: { role: "assistant", content: "1}" },
        done: true,
      }),
    ].join("\n")),
  });
  const events: OllamaChatStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of provider.chatStream({
      messages: [{ role: "user", content: "回答" }],
      format: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
        additionalProperties: false,
      },
    })) {
      events.push(event);
    }
  }, (error) => assertProviderError(error, "INVALID_RESPONSE"));
  assert.equal(events.some((event) => event.kind === "terminal"), false);
});

test("closing chatStream early cancels its response reader", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const provider = new OllamaHttpProvider({
    model: MODEL,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({
          model: MODEL,
          message: { role: "assistant", content: "first" },
          done: false,
        })}\n`));
      },
      cancel() {
        cancelled = true;
      },
    })),
  });
  const iterator = provider.chatStream({
    messages: [{ role: "user", content: "等待" }],
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.kind, "content_delta");
  await iterator.return?.();
  assert.equal(cancelled, true);
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
