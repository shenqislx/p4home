# P4 Home 当前工作计划

> Current Focus: [P4 Home 本地 LLM Agent 化架构](../p4-local-agent-architecture.md)
> Updated: 2026-08-18
> Working Branch: `feature/agent-harness`

## 工作规则

- 本目录只保存当前架构主线尚未归档的计划；
- 任意时刻最多一个 Phase 标记为 `in_progress`；
- 后续 Phase 可以先定义边界，但只有前置退出门禁满足后才能启动；
- 每完成一个任务，都要把验证证据写回对应 Phase plan；
- Phase 完成并 review 后，计划移入 `docs/archive/plans/agent/`，长期结论更新到架构文档或正式技术记录；
- Phase 0–7 的所有文档、代码和测试改动持续提交到 `feature/agent-harness`；
- 单个 Phase 完成后不合入 `main`，全部 Phase 完成并通过最终 review 后再整体合入；
- 旧 Smart Panel、M1–M6 计划均已归档，不再作为默认工作入口。

## 当前顺序

| 顺序 | Phase | 状态 | 主要结果 | 计划 |
|---|---|---|---|---|
| 0 | Baseline & Contract | `completed` | 可重复构建、运行期基线、协议 v1、Mock | [Phase 0 归档](../archive/plans/agent/2026-08-15-agent-phase-0-baseline-contract-plan.md) |
| 1 | Text Agent Runtime | `completed` | TypeScript Runtime、Ollama、有限 Tool Loop | [Phase 1 归档](../archive/plans/agent/2026-08-15-agent-phase-1-text-runtime-plan.md) |
| 2 | Role Runtime & Cat World | `in_progress` | Role Router、三角色隔离、Cat 房间动作 | [Phase 2](./2026-08-15-agent-phase-2-p4-room-world-plan.md) |
| 3 | Cat Object World | `pending` | sofa 等对象锚点与 Cat 交互动作 | [Phase 3](./2026-08-15-agent-phase-3-object-world-plan.md) |
| 4 | Robot HA & Multi-role | `pending` | Robot 受限 HA 工具、Human/Robot 语义分割 | [Phase 4](./2026-08-15-agent-phase-4-ha-tool-plan.md) |
| 5 | Role-aware Voice | `pending` | ESP-SR → STT → Router/Roles → TTS | [Phase 5](./2026-08-15-agent-phase-5-voice-plan.md) |
| 6 | Role-aware Memory | `pending` | 比较共享、私有和混合记忆可见性 | [Phase 6](./2026-08-15-agent-phase-6-memory-plan.md) |
| 7 | Cat Autonomy | `pending` | Timer/HA 事件驱动、低频、可审计 Cat 行为 | [Phase 7](./2026-08-15-agent-phase-7-autonomy-plan.md) |

## 下一步

只执行 Phase 2。2026-08-17 用户要求重新设计并推进 Phase 2，Phase 1 review 已通过。
Phase 2 按 2A Role Contract & Router、2B Cat Action Adapter、2C P4 World Service、2D Real
Transport & Hardware Gate 四个纵切推进。2026-08-18，2A、2B、2C 的各自退出门禁已依次满足；
下一项为 2D 真实 Device WebSocket 与实机门禁。2C 结果只证明 host 状态机、UI 分层和固件可构建，
尚未证明真实传输、连续动作或运行期资源指标。

Phase 1 的 SQLite Worker、启动恢复、Runtime 相对 timeout 与协作取消边界已经关闭。设备端
deadline、action_id 幂等和 snapshot reconciliation 属于 Phase 2，必须在真实 Action 前完成。

产品角色边界已纳入 Phase 2–7：默认模型统一使用 `qwen3.8:27b-mlx`，但 Role Router、Robot、
Human、Cat 的上下文、工具、temperature、预算与 eval 独立。当前 32 场景 ToolCall 结果只作为
命令执行型专项证据，不作为整个 Agent 总分。所有 Qwen 请求统一显式传入
`think: false`，不将思考模式开关暴露给各 RoleProfile。

SQLite 的生产化延后项集中记录在
[Agent SQLite Production TODO](./2026-08-16-agent-sqlite-production-todo.md)，不与当前 Demo
正确性修复混在一起；进入 Phase 2 真实 Action 前必须重新 review 对应门禁。

## 历史入口

- [归档说明](../archive/README.md)
- [旧计划](../archive/plans/legacy/)
- [旧项目里程碑记录](../archive/records/project/project-milestones-through-m6.md)
