# P4 Home Agent Runtime

Phase 1 的 TypeScript workspace。当前纵切运行冻结契约、Ollama 原生 Tool Calling、有限文本
Agent Loop 与 Mock P4 Home 工具；不连接真实 P4 或 Home Assistant。确定性测试不要求 Ollama
服务，真实模型回归必须显式启用。

## 环境

- Node.js 24.19 或更新的 Node 24 LTS 版本；
- pnpm 11.19.0；
- 安装脚本 allowlist 仅允许 `esbuild`，用于 `tsx` 测试加载器。

```bash
cd agent
pnpm install --frozen-lockfile
pnpm typecheck
pnpm validate:contracts
pnpm test
```

所有验证入口都会先执行 Node 主版本 preflight，避免 pnpm 管理进程与实际 Runtime 使用不同
Node 主版本时产生假通过。

## 当前分层

- `apps/runtime`：有限文本 Agent Loop、SQLite 审计接入与 JSON Lines 结构化日志；
- `packages/contracts`：AJV 加载并验证仓库根目录冻结的两份 v1 契约；
- `packages/core`：核心实体类型、取消、相对 timeout、最多四项的顺序 Tool Loop；
- `packages/domain-p4home`：无需真实设备的五工具 Mock 与 allowlist；
- `packages/provider-ollama`：原生 HTTP capability probe、generate、chat/tool calling、NDJSON
  stream、`AbortSignal` 取消和相对 timeout；
- `packages/storage-sqlite`：基于 Node 24 内置 `node:sqlite` 的审计存储、schema migration 与关联查询。

Phase 1 不得导入真实 P4 WebSocket 执行链，也不得把 token 暴露给模型或日志。

## SQLite 审计与结构化日志

`SqliteAuditStore` 使用 schema version 1、WAL、STRICT table、外键和 JSON 有效性约束，保存
AgentProfile、Session、Run、Message、ToolCall、Action 与 Event。Run、Session、Action 的身份字段
不可重写，终态 Run/Action 不可回退；一个 ToolCall 只能从 `pending` 写入一次终态结果。查询
`getRunTrace(runId)` 可获得同一 Run 下的完整关联记录。

调用 `runTextAgent()` 前必须先保存 AgentProfile 和 Session，再通过可选 `audit` 参数接入存储。
审计启用后，system/user/assistant/tool 消息、模型轮次、ToolCall/ToolResult 和 Run 终态都会持久化：

```ts
using store = new SqliteAuditStore("./data/p4home-agent.sqlite");
await store.saveAgentProfile(profile);
await store.saveSession(session);

const result = await runTextAgent({
  run_id: "run-001",
  user_text: "去书房",
  provider,
  tools,
  audit: {
    store,
    session_id: session.session_id,
    logger: createJsonLineLogger(),
  },
});
```

JSON Lines 日志固定携带 `run_id / session_id`，并在对应阶段携带 `tool_call_id / action_id`；
常见凭证字段会递归脱敏，token 计数等非凭证指标保留。Phase 1 Mock 工具不产生设备 Action，
因此实际 Mock trace 终止于 `tool_call_id`；Phase 2 设备适配器写入 `Action` 后可继续关联
`action_id`，无需修改 schema。SQLite 是审计事实源；可选日志 sink 故障不会改变已持久化的
Run 结果。

## Ollama Provider

`OllamaHttpProvider` 默认连接 `http://127.0.0.1:11434`，不依赖 Ollama SDK：

- `probe()` 依次读取 `/api/version`、`/api/tags`，仅在模型存在时调用 `/api/show`；
  probe 本身不会加载模型；
- `generate()` 使用 `/api/generate` 的 `stream: false` 响应；
- `chat()` 使用 `/api/chat` 的原生 `tools`、`tool_calls` 与 `format` 字段；
- `stream()` 按 NDJSON 增量解析并要求出现 `done: true` 终态；
- 不可达、超时、取消、模型不存在、HTTP 错误和非法响应使用稳定错误码；Runtime 将 provider
  失败映射为可审计的 `failed / cancelled / timed_out` 终态；
- Ollama 返回的 ToolCall 必须再次通过冻结 Tool Schema v1；`generate()` 或 `chat()` 只要携带
  `format`，provider 就会强制执行 JSON.parse 和本地 AJV 校验；
- `runTextAgent()` 每个 Run 最多执行 4 个工具、最多 4 个工具轮次，并在每次回送模型前校验
  Tool Result v1。模型只看到冻结目录与当前执行 allowlist 的交集；空最终回复、未知工具、非法
  参数、超预算和非法结果全部 fail closed；
- Core 严格拒绝非有限数或小数 timeout，使用组合 `AbortSignal` 消除取消竞态，并把工具错误
  规范到 Tool Result v1 的 256 字符上限。

确定性测试不要求 Ollama 服务。真实本机 smoke 必须显式启用：

```bash
P4HOME_OLLAMA_LIVE=1 OLLAMA_MODEL=qwen3:8b pnpm test:ollama-live
```

若 smoke 返回 `UNREACHABLE`，先检查服务而不是重试模型请求：

```bash
curl http://127.0.0.1:11434/api/version
ollama serve
```

本机 Ollama `0.32.6` + `qwen3:8b` 已验证 generate、原生 ToolCall、structured output，以及
“文本请求 → Mock 工具执行 → 最终文本回复”的完整有限闭环。

接口依据：[Ollama API](https://docs.ollama.com/api/introduction)、
[model details](https://docs.ollama.com/api-reference/show-model-details)、
[generate](https://docs.ollama.com/api/generate)、[chat](https://docs.ollama.com/api/chat)、
[tool calling](https://docs.ollama.com/capabilities/tool-calling)、
[structured outputs](https://docs.ollama.com/capabilities/structured-outputs) 和
[streaming](https://docs.ollama.com/api/streaming)。
