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
- [ ] 实现 Ollama capability probe、generate、stream 与 cancel；
- [ ] 实现 SQLite 审计存储与结构化日志；
- [ ] 建立模型 eval、性能基线与最小调试入口。

实际结果（2026-08-16）：Node runtime 已由 22.16 统一升级到 24.19 LTS，preflight 精确通过 `24.19.0`；AJV 报告 14 种消息、
17 条合法 fixture、6 条非法 fixture、5 个工具与 32 条 golden intents 全部符合冻结契约；
TypeScript 严格类型检查通过，首批 8 项测试覆盖顺序执行、失败即停止、重复 ID、四项上限、
相对超时、取消、Mock 房间移动/说话和未知房间拒绝。依赖锁已生成，pnpm 安装脚本 allowlist
仅包含 `esbuild`。升级后在 Node 24.19.0 下重新执行 runtime preflight、严格类型检查、契约校验
和 8 项 Agent 测试，并回归既有 30 项协议测试与 2 项 harness 测试，全部通过。

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
