# P4 Home 当前里程碑

> Updated: 2026-08-17
> Current Architecture: [P4 Local Agent Architecture](./p4-local-agent-architecture.md)
> Active Work: [Agent Phase Plans](./plans/README.md)

## 1. 当前结论

项目当前工作重点切换为 M7：本地语音、LLM 与 Agent Runtime。

- M0–M5 已形成固件、显示、触摸、音频/ESP-SR 骨架、HA 读侧和 UI 基线；
- M6 已实现 HA `call_service` 与主要控制 UI；2026-08-15 已恢复 P4 串口、Wi-Fi、HA READY 与
  `state_changed` 接收，并完成书房吸顶灯的隔离实机闭环；更广泛的米家设备覆盖仍作为
  Phase 2 前需明确边界的延期项；
- M7.0 候选提交 `b0aa443` 已通过 7,200 秒 HA + Pixel Home 实机稳定性回归，workflow、artifact
  完整性与功能判定均通过；
- 旧里程碑全文已归档到 [project-milestones-through-m6.md](./archive/records/project/project-milestones-through-m6.md)。

## 2. M7 分阶段里程碑

| Milestone | 状态 | 退出结果 |
|---|---|---|
| M7.0 Baseline & Contract | `completed` | 可重复构建、实机资源基线、冻结协议 v1、Mock 合约测试 |
| M7.1 Text Agent Runtime | `completed` | Ollama + 有限 Tool Loop + SQLite + eval |
| M7.2 Role Runtime & Cat World | `in_progress` | Role Router、三角色隔离、Cat 房间动作闭环 |
| M7.3 Cat Object World | `pending` | sofa/window/desk 等 Cat 对象级动作 |
| M7.4 Robot HA & Multi-role | `pending` | Robot 受限 HA 工具、Human/Robot 语义分割 |
| M7.5 Role-aware Voice | `pending` | 本地唤醒、STT、Router/Roles、TTS 闭环 |
| M7.6 Role-aware Memory | `pending` | 评测共享、私有与混合角色记忆 |
| M7.7 Cat Autonomy | `pending` | Timer/HA 事件驱动、低优先级、可关闭 Cat 行为 |

## 3. M6 遗留裁决

| 项目 | 2026-08-15 状态 | 处理 |
|---|---|---|
| HAOS 服务 | `reachable` | `192.168.71.4:8123` TCP 成功、HTTP 200 |
| P4 串口 | `available` | `/dev/cu.usbserial-210`，已完成多轮烧录与原始串口采集 |
| P4 网络与 HA | `ready` | DHCP 地址 `192.168.110.87`，HA 首次同步完成且持续接收事件 |
| 真实灯具点击与状态回刷 | `passed` | 书房吸顶灯隔离回归完成：初始灭、单次 `turn_on`、用户确认已亮，计数差对应 1 条受跟踪实体回刷 |
| 米家闭环 | `deferred` | 代表性小米灯具已通过；更广泛设备覆盖不移出范围，Phase 2 前维持独立债务裁决 |

代表性真实灯具的 M6 控制闭环已经通过；这不等于所有米家设备均已验收。Phase 2 若涉及
更广泛设备覆盖，仍须维持独立验证边界，不得在未隔离风险时同时改动 HA 主链和新的
Agent WebSocket。

## 4. 当前唯一允许推进的工作

执行 [Phase 2 plan](./plans/2026-08-15-agent-phase-2-p4-room-world-plan.md)。2026-08-17 已重新设计为
2A–2D 四个纵切。2A Role Contract & Router 的 Role Contract、三个 RoleProfile、Cat
原文隔离、fail-closed Router、独立 Session、Human/Robot 入口、有界调度与路由审计已落地并通过
92 项确定性测试。2026-08-18 review 修复后，Human 文本策略、本地 eval gate、Session 串行、模型
轮次审计、SQLite schema v2 关联索引和统一 Role 组合入口均有回归覆盖；四角色两轮 v2 eval 分别为
Router 24/24、Human 8/8、Robot 8/8、Cat 18/18，且无综合分。2A、2B、2C 已依次满足退出门禁。
2026-08-19，2D 真实 WSS 软件链、P4 `agent_transport` 与硬件 harness 已通过软件回归和
Agent-enabled 固件构建；Phase 2 仍等待实机 100 次动作、重连、两小时离线和资源 artifact 判定。

## 5. 状态更新规则

- 具体 checkbox 和证据写入 Phase plan；
- 本文件只记录 Phase 状态和退出结果；
- 一个 Phase 未通过退出门禁，下一 Phase 不得改为 `in_progress`；
- Phase 完成后先 review，再归档计划并更新本文件。
