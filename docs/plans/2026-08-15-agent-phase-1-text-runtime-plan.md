# Agent Phase 1 — Text Agent Runtime Plan

> Status: `in_progress`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 0 complete

## 1. 目标

在不连接真实 P4 的前提下，建立可测试的 TypeScript Agent Runtime，跑通文本输入、Ollama 原生 Tool Calling、Mock Character Tool 和有限执行循环。

## 2. 实施步骤

1. 建立 Node.js 24.19 LTS workspace 与 `apps/runtime`、`packages/core`、`contracts`、`provider-ollama`、`domain-p4home`、`storage-sqlite`；
2. 导入并验证 Phase 0 的 JSON Schema；
3. 实现 `AgentProfile / Session / Run / ToolCall / Action / Event` 类型；
4. 实现带 `AbortSignal`、相对 timeout、每轮最多 4 个顺序 ToolCall 的 Run Loop；
5. 实现 Ollama capability probe、generate、stream/cancel 能力边界；
6. 接入原生 tool calling 与 structured output 校验；
7. 实现 mock character tools 与安全 allowlist；
8. 用 SQLite 保存 session、run、message、tool call 和审计事件；
9. 增加结构化日志，贯通 `run_id → tool_call_id → action_id`；
10. 建立中文黄金场景 eval，比较 8B/14B/30B 候选的准确率与延迟；
11. 提供 CLI 或最小 HTTP 调试入口；
12. 文档化启动、配置、测试与故障排查。

## 3. 当前进展

- [x] 建立 Node.js 24.19 + pnpm 11 TypeScript workspace 与分层目录；
- [x] 使用 AJV 2020 导入并验证冻结的 Device Protocol v1 与 Tool Schema v1；
- [x] 定义 `AgentProfile / Session / Run / ToolCall / Action / Event` 核心类型；
- [x] 实现 `AbortSignal`、相对 timeout、重复 ID 拒绝和最多四项的顺序 Tool Loop；
- [x] 实现不连接真实 P4 的五工具 Mock、房间 allowlist 与精确错误码；
- [x] 实现 Ollama capability probe、generate、stream 与 cancel；
- [x] 接入 Ollama 原生 chat/tool calling、本地 structured output 校验与有限文本 Agent Loop；
- [ ] 实现 SQLite 审计存储与结构化日志；
- [ ] 建立模型 eval、性能基线与最小调试入口。

实际结果（2026-08-16）：Node runtime 已由 22.16 统一升级到 24.19 LTS，preflight 精确通过 `24.19.0`；AJV 报告 14 种消息、
17 条合法 fixture、6 条非法 fixture、5 个工具与 32 条 golden intents 全部符合冻结契约；
TypeScript 严格类型检查通过，首批 8 项测试覆盖顺序执行、失败即停止、重复 ID、四项上限、
相对超时、取消、Mock 房间移动/说话和未知房间拒绝。依赖锁已生成，pnpm 安装脚本 allowlist
仅包含 `esbuild`。升级后在 Node 24.19.0 下重新执行 runtime preflight、严格类型检查、契约校验
和 8 项 Agent 测试，并回归既有 30 项协议测试与 2 项 harness 测试，全部通过。

Ollama provider 里程碑（2026-08-16）：使用 Node 原生 `fetch` 实现 `/api/version`、
`/api/tags`、`/api/show` 的无模型加载 probe，以及 `/api/generate` 的非流式响应和 NDJSON
流式解析；外部取消、100–600,000 ms 相对 timeout、模型不存在、HTTP 失败、不可达与非法响应
均映射为稳定错误码并 fail closed。新增 11 项 provider 测试，覆盖传输分片、缺少终态、generate
和 stream 取消等边界。本机 Ollama `0.32.6` 使用已安装的 `qwen3:8b` 完成 1 项显式 live smoke，
probe 返回 `completion / tools / thinking`，冷启动 probe + generate 用例约 4.6 秒。该数字不是正式
性能基线；运行日志显示模型上下文被钳制到 40,960、KV cache 约 5.76 GiB，模型对比阶段必须
固定 `num_ctx` 后重新测量。

Tool Calling 里程碑（2026-08-16）：`/api/chat` 已支持 system/user/assistant/tool 历史、原生
function tools、tool calls、thinking、`format` 与固定 `num_ctx`。Runtime 从冻结 Tool Schema v1
生成模型可见的五工具目录；模型返回值先拒绝未知工具、非法参数和单轮超过四项，再生成稳定
`tool_call_id` 顺序调用 Mock 执行器；Tool Result v1 再校验通过后才会回送模型。整个文本 Run
最多四个 ToolCall、四个工具轮次，超预算 fail closed。structured output 即使由 Ollama `format`
约束，也会再次执行 JSON.parse + AJV 2020 本地校验。

新增后的确定性测试为 30 项，覆盖原生 chat 请求/响应、非法工具调用、冻结契约桥接、structured
output、完整 Mock 闭环及跨轮预算。本机 Ollama `0.32.6` + `qwen3:8b` 的 4 项显式 live 回归
全部通过：generate smoke 约 2.74 秒、原生 ToolCall 约 2.28 秒、structured output 约 0.61 秒，
“文本请求 → 去书房 Mock Tool → 最终回复”的有限闭环约 1.86 秒。该次服务最初未运行，启动
`ollama serve` 后通过；这些单次数字只作功能证据，不替代第 10 步的正式 p50/p95 模型评测。

下一项工作为 SQLite 审计存储与结构化日志，保持不接真实 P4。

## 4. 验证

- 单元测试：schema、budget、cancel、duplicate call、policy；
- 集成测试：Ollama 正常、不可达、超时、非法 ToolCall；
- 场景测试：至少 50 次中文意图，无不存在工具执行；
- 性能：记录首 ToolCall p50/p95、tokens、常驻内存；
- 安全：模型不可读取 token 或执行任意 HA/service/shell。

## 5. 完成定义

- [ ] 选定默认开发模型与降级模型；
- [ ] ToolCall schema 成功率达到约定门槛；
- [ ] timeout/cancel/budget 可重复验证；
- [ ] Runtime 无需真实 P4 即可完成全套测试；
- [ ] 用户 review 通过后启动 Phase 2。
