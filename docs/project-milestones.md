# P4 Home 当前里程碑

> Updated: 2026-08-15
> Current Architecture: [P4 Local Agent Architecture](./p4-local-agent-architecture.md)
> Active Work: [Agent Phase Plans](./plans/README.md)

## 1. 当前结论

项目当前工作重点切换为 M7：本地语音、LLM 与 Agent Runtime。

- M0–M5 已形成固件、显示、触摸、音频/ESP-SR 骨架、HA 读侧和 UI 基线；
- M6 已实现 HA `call_service` 与主要控制 UI；2026-08-15 确认 HA 服务从开发机可达，
  但 P4 未连接串口且既有地址离线，因此真实设备点击、状态回刷和米家闭环明确延期，
  必须在 Phase 2 修改 P4 实时链路前补验；
- 旧里程碑全文已归档到 [project-milestones-through-m6.md](./archive/records/project/project-milestones-through-m6.md)。

## 2. M7 分阶段里程碑

| Milestone | 状态 | 退出结果 |
|---|---|---|
| M7.0 Baseline & Contract | `in_progress` | 可重复构建、实机资源基线、协议 v1、Mock 合约测试 |
| M7.1 Text Agent Runtime | `pending` | Ollama + 有限 Tool Loop + SQLite + eval |
| M7.2 P4 Room-level World | `pending` | 房间级角色动作完整反馈闭环 |
| M7.3 Object-level World | `pending` | sofa/window/desk 等对象级动作 |
| M7.4 Home Assistant Tool | `pending` | Agent 直连 HA 的受限读写工具 |
| M7.5 Voice Pipeline | `pending` | 本地唤醒、STT、Agent、TTS 闭环 |
| M7.6 Memory | `pending` | 可追溯、可删除的长期记忆 |
| M7.7 Autonomy | `pending` | 低频、低优先级、可关闭的自主行为 |

## 3. M6 遗留裁决

| 项目 | 2026-08-15 状态 | 处理 |
|---|---|---|
| HAOS 服务 | `reachable` | `192.168.71.4:8123` TCP 成功、HTTP 200 |
| P4 串口 | `unavailable` | 当前只有系统虚拟串口，无 P4 USB 串口 |
| P4 既有 IP | `offline/unknown` | `192.168.110.87` 单包探测无响应 |
| 真实灯具点击与状态回刷 | `deferred` | 板卡可用后在 Phase 0 硬件窗口补验 |
| 米家闭环 | `deferred` | 不移出范围；Phase 2 前形成完成证据或独立债务裁决 |

本裁决允许继续完成纯合约和 Mock 工作，但不等于 M6 实机闭环通过，也不允许
Phase 2 在未隔离风险时同时改动 HA 主链和新的 Agent WebSocket。

## 4. 当前唯一允许推进的工作

执行 [Phase 0 plan](./plans/2026-08-15-agent-phase-0-baseline-contract-plan.md)：

1. 恢复与 ESP-IDF v5.5.4 匹配的构建工具链；
2. 验证干净构建可恢复 ESP32-C6 Hosted 配置；
3. 处理或登记 M6 真实设备遗留项；
4. 采集运行期 heap/stack/网络/UI 基线；
5. 冻结 Device Protocol v1 与 Tool Schema v1；
6. 建立不依赖 Ollama 和实机的合约测试。

## 5. 状态更新规则

- 具体 checkbox 和证据写入 Phase plan；
- 本文件只记录 Phase 状态和退出结果；
- 一个 Phase 未通过退出门禁，下一 Phase 不得改为 `in_progress`；
- Phase 完成后先 review，再归档计划并更新本文件。
