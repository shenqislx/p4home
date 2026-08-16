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

- `apps/runtime`：进程入口与健康状态；
- `packages/contracts`：AJV 加载并验证仓库根目录冻结的两份 v1 契约；
- `packages/core`：核心实体类型、取消、相对 timeout、最多四项的顺序 Tool Loop；
- `packages/domain-p4home`：无需真实设备的五工具 Mock 与 allowlist；
- `packages/provider-ollama`：原生 HTTP capability probe、generate、chat/tool calling、NDJSON
  stream、`AbortSignal` 取消和相对 timeout；
- `apps/runtime`：将冻结工具目录、Ollama chat、Mock 执行器和最终回复串成有限文本 Agent Loop；
- `packages/storage-sqlite`：审计存储接口，SQLite 实现待补充。

Phase 1 不得导入真实 P4 WebSocket 执行链，也不得把 token 暴露给模型或日志。

## Ollama Provider

`OllamaHttpProvider` 默认连接 `http://127.0.0.1:11434`，不依赖 Ollama SDK：

- `probe()` 依次读取 `/api/version`、`/api/tags`，仅在模型存在时调用 `/api/show`；
  probe 本身不会加载模型；
- `generate()` 使用 `/api/generate` 的 `stream: false` 响应；
- `chat()` 使用 `/api/chat` 的原生 `tools`、`tool_calls` 与 `format` 字段；
- `stream()` 按 NDJSON 增量解析并要求出现 `done: true` 终态；
- 不可达、超时、取消、模型不存在、HTTP 错误和非法响应使用稳定错误码；
- Ollama 返回的 ToolCall 必须再次通过冻结 Tool Schema v1；structured output 即使使用 API
  `format`，也必须由本地 AJV 重新校验；
- `runTextAgent()` 每个 Run 最多执行 4 个工具、最多 4 个工具轮次，并在每次回送模型前校验
  Tool Result v1。未知工具、非法参数、超预算和非法结果全部 fail closed。

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
