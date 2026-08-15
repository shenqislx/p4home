# P4 Home 当前工作计划

> Current Focus: [P4 Home 本地 LLM Agent 化架构](../p4-local-agent-architecture.md)
> Updated: 2026-08-15

## 工作规则

- 本目录只保存当前架构主线尚未归档的计划；
- 任意时刻最多一个 Phase 标记为 `in_progress`；
- 后续 Phase 可以先定义边界，但只有前置退出门禁满足后才能启动；
- 每完成一个任务，都要把验证证据写回对应 Phase plan；
- Phase 完成并 review 后，计划移入 `docs/archive/plans/agent/`，长期结论更新到架构文档或正式技术记录；
- 旧 Smart Panel、M1–M6 计划均已归档，不再作为默认工作入口。

## 当前顺序

| 顺序 | Phase | 状态 | 主要结果 | 计划 |
|---|---|---|---|---|
| 0 | Baseline & Contract | `in_progress` | 可重复构建、运行期基线、协议 v1、Mock | [Phase 0](./2026-08-15-agent-phase-0-baseline-contract-plan.md) |
| 1 | Text Agent Runtime | `pending` | TypeScript Runtime、Ollama、有限 Tool Loop | [Phase 1](./2026-08-15-agent-phase-1-text-runtime-plan.md) |
| 2 | P4 Room-level World | `pending` | 房间级 Character Action 闭环 | [Phase 2](./2026-08-15-agent-phase-2-p4-room-world-plan.md) |
| 3 | Object-level World | `pending` | sofa 等对象锚点与交互动作 | [Phase 3](./2026-08-15-agent-phase-3-object-world-plan.md) |
| 4 | Home Assistant Tool | `pending` | Agent 直连 HA 的受限读写工具 | [Phase 4](./2026-08-15-agent-phase-4-ha-tool-plan.md) |
| 5 | Voice Pipeline | `pending` | ESP-SR → STT → Agent → TTS 闭环 | [Phase 5](./2026-08-15-agent-phase-5-voice-plan.md) |
| 6 | Memory | `pending` | 可追溯、可删除的长期记忆 | [Phase 6](./2026-08-15-agent-phase-6-memory-plan.md) |
| 7 | Autonomy | `pending` | 低频、可控、可审计自主行为 | [Phase 7](./2026-08-15-agent-phase-7-autonomy-plan.md) |

## 下一步

只执行 Phase 0：

1. ~~恢复 ESP-IDF v5.5.4 对应工具链~~（2026-08-15 完成）；
2. ~~从干净 build 目录验证 ESP32-C6 Hosted 配置可重建~~（2026-08-15 完成）；
3. 关闭 M6 剩余的真实灯具 `call_service → 物理动作 → state_changed` 验收；
4. ~~采集固件短时 heap、stack、HA 与 UI 基线，并修复 main task 栈余量~~（2026-08-15 完成）；
5. 连续运行现有 HA + Pixel Home 至少 2 小时，保存长跑日志；
6. 明确恢复自托管硬件 workflow/artifact contract，或把本地证据流程固化进 harness；
7. 澄清 `panel_data_store.rejected` 指标语义，拆分非白名单事件与真实拒绝；
8. review 并正式冻结已实现的 Device Protocol v1 与 Tool Schema v1；
9. ~~用 simulator/fake backend 建立协议合约测试~~（2026-08-15 完成）。

Phase 0 未通过前，不创建 `agent/` 生产实现，也不修改 P4 角色执行逻辑。

## 历史入口

- [归档说明](../archive/README.md)
- [旧计划](../archive/plans/legacy/)
- [旧项目里程碑记录](../archive/records/project/project-milestones-through-m6.md)
