# P4 Home 当前工作计划

> Current Focus: [P4 Home 本地 LLM Agent 化架构](../p4-local-agent-architecture.md)
> Updated: 2026-08-17
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
| 1 | Text Agent Runtime | `in_progress` | TypeScript Runtime、Ollama、有限 Tool Loop | [Phase 1](./2026-08-15-agent-phase-1-text-runtime-plan.md) |
| 2 | P4 Room-level World | `pending` | 房间级 Character Action 闭环 | [Phase 2](./2026-08-15-agent-phase-2-p4-room-world-plan.md) |
| 3 | Object-level World | `pending` | sofa 等对象锚点与交互动作 | [Phase 3](./2026-08-15-agent-phase-3-object-world-plan.md) |
| 4 | Home Assistant Tool | `pending` | Agent 直连 HA 的受限读写工具 | [Phase 4](./2026-08-15-agent-phase-4-ha-tool-plan.md) |
| 5 | Voice Pipeline | `pending` | ESP-SR → STT → Agent → TTS 闭环 | [Phase 5](./2026-08-15-agent-phase-5-voice-plan.md) |
| 6 | Memory | `pending` | 可追溯、可删除的长期记忆 | [Phase 6](./2026-08-15-agent-phase-6-memory-plan.md) |
| 7 | Autonomy | `pending` | 低频、可控、可审计自主行为 | [Phase 7](./2026-08-15-agent-phase-7-autonomy-plan.md) |

## 下一步

只执行 Phase 1：

1. 完成用户 review；
2. review 通过后归档 Phase 1，再启动 Phase 2。

Phase 1 不修改 P4 固件角色执行链，也不提前引入 Phase 2 的真实 WebSocket 控制。

Phase 1 的 SQLite Worker、启动恢复、Runtime 相对 timeout 与协作取消边界已经关闭。设备端
deadline、action_id 幂等和 snapshot reconciliation 属于 Phase 2，必须在真实 Action 前完成。

SQLite 的生产化延后项集中记录在
[Agent SQLite Production TODO](./2026-08-16-agent-sqlite-production-todo.md)，不与当前 Demo
正确性修复混在一起；进入 Phase 2 真实 Action 前必须重新 review 对应门禁。

## 历史入口

- [归档说明](../archive/README.md)
- [旧计划](../archive/plans/legacy/)
- [旧项目里程碑记录](../archive/records/project/project-milestones-through-m6.md)
