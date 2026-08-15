# Agent Phase 1 — Text Agent Runtime Plan

> Status: `in_progress`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 0 complete

## 1. 目标

在不连接真实 P4 的前提下，建立可测试的 TypeScript Agent Runtime，跑通文本输入、Ollama 原生 Tool Calling、Mock Character Tool 和有限执行循环。

## 2. 实施步骤

1. 建立 Node.js 24 workspace 与 `apps/runtime`、`packages/core`、`contracts`、`provider-ollama`、`domain-p4home`、`storage-sqlite`；
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

## 3. 验证

- 单元测试：schema、budget、cancel、duplicate call、policy；
- 集成测试：Ollama 正常、不可达、超时、非法 ToolCall；
- 场景测试：至少 50 次中文意图，无不存在工具执行；
- 性能：记录首 ToolCall p50/p95、tokens、常驻内存；
- 安全：模型不可读取 token 或执行任意 HA/service/shell。

## 4. 完成定义

- [ ] 选定默认开发模型与降级模型；
- [ ] ToolCall schema 成功率达到约定门槛；
- [ ] timeout/cancel/budget 可重复验证；
- [ ] Runtime 无需真实 P4 即可完成全套测试；
- [ ] 用户 review 通过后启动 Phase 2。
