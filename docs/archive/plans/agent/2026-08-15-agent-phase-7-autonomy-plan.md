# Agent Phase 7 — Cat Autonomy Plan

> Status: `completed`
> Started: 2026-08-26
> Completed: 2026-08-27
> Reviewed: 2026-08-27
> Closure: 7A–7C 编码、本地/实机门禁和逐段 bugs review 均通过；用户最终 review 通过
> Architecture: [P4 Local Agent Architecture](../../../p4-local-agent-architecture.md)
> Depends on: Phase 2、4、6 complete; 安全与稳定性门禁通过

2026-08-26，用户明确授权启动 Phase 7，并要求先完成 feature 编码。2026-08-27，7A/7B/7C
编码、本地门禁、逐段独立 bugs review 与真实 P4/HA/模型门禁均已完成；同日用户最终 review
通过，Phase 7 随后关闭并归档。

## 1. 目标

为 Cat 增加 Timer/HA/World/task-complete 事件驱动、低频、低优先级、可审计并可由用户完全关闭
的自主行为。Robot/Human 不因此获得后台自主执行能力。

## 2. 实施步骤

1. 定义 timer/world/HA/task-complete Cat trigger schema；HA 事件只投影 allowlist 字段；
2. 增加 Event Policy、去重、过期、quiet hours、每日调用预算和全局开关；
3. Cat autonomy 使用独立 RoleProfile revision、专属 Context 与最小 P4 World 工具权限；
4. Cat autonomy action 永远低于任何用户 Interaction 和 Robot action 优先级；
5. 用户输入不传给 Cat，但会取消未开始或可中断的 Cat 动作；
6. 重启后不补执行过期 trigger；
7. 建立长跑、模型调用频率、误触发和抢占测试；
8. 提供审计页面或日志查询。

## 3. 分段与当前进度

### 7A — Autonomy Feature Runtime（本轮）

- [x] 定义严格的 `timer.elapsed`、`ha.state_changed`、`world.changed`、`task.completed` schema；
- [x] HA trigger 只接受 alias/domain/state/available 投影，room target 由本地 allowlist 映射；
- [x] 实现总开关/暂停、quiet hours、全局与分来源限频、每日模型调用 admission budget；
- [x] 实现 event id 去重、过期/未来时间、启动时间 fence 和 World autonomy feedback-loop 阻断；
- [x] Cat 使用独立 `role-profile/v6`，仍不接受用户原文且不含任何 `home.*` Tool；
- [x] 复用低优先级 RoleScheduler；任一 Human/Robot 新交互先取消 queued/active Cat；
- [x] task-complete 观察只暴露 run/role/outcome/time，不暴露用户文本或角色上下文；
- [x] 提供无轮询、有界 in-flight 的 source bridge，可绑定 HA/P4 observer 与 task-complete sink；
- [x] 提供 `getStatus()`、`setMode()`、`listAudit()` 查询/控制边界；批准后的 Run 继续写入 SQLite；
- [x] 正式 Timer trigger 已通过 fake P4 走通 model → action → SQLite terminal audit。

本地复现（Node `v24.19.0`）：

```bash
cd agent
pnpm typecheck
pnpm test:phase7
```

### 7B — Long-run / Frequency / Preemption Gate

- [x] 建立无持续模型轮询的 7 天虚拟时钟长跑；
- [x] 量化按来源与全局模型调用频率、预算耗尽、跨日恢复和误触发；
- [x] 压测用户/Robot 抢占、暂停/关闭、队列满、重启不补跑与审计容量；
- [x] 增加独立 `pnpm gate:phase7` 与 [Phase 7B evidence](../../../../evidence/agent-phase-7/phase-7b-local-gate.md)。

2026-08-26 本地 gate 在 Node `v24.19.0` 下通过：7 天 10,080 个有界 Timer 输入产生 168 次
model admission（每日严格 24 次），无 trigger 的模型调用为 0；1,000 条 HA storm 仅 admission 1 次；
四类误触发均为 0 admission。7B 只关闭本地确定性门禁，不包含真实模型延迟、真实 HA/P4 或产品
启动装配。

### 7C — Product Wiring / Real Environment / Final Review

- [x] 产品启动装配挂载 Timer、真实 HA allowlist client、P4 device adapter 和 task-complete ingress，
  并通过独立 bugs review 与修复复核；
- [x] 验证真实 P4 action、HA/P4 原链不回归与 120 秒、1 秒粒度资源采样稳定门禁（非瞬时硬上限）；
  - [x] 完成专用 `phase7_autonomy` profile、真实模型/P4 harness、HA 只读 frame 计数、隐私审计编码，
    并完成两路独立 bugs review 与修复复核；
  - [x] 旧 run `33056257943` 的 artifact 因复核发现 entity 残留已删除并作废；修复提交
    `e8de907` 对应 run `33061620203` 已按 manifest-first 协议通过，分别证明 Phase 7 Agent
    `RobotHaClient` 与 P4 内置 HA client 零 `call_service` dispatch；
- [x] 提供 loopback bearer 控制面、policy decision 与 execution terminal 的有界查询，并通过独立 review；
- [x] 完成 [真实环境证据](../../../../evidence/agent-phase-7/phase-7c-real-environment-gate.md)；
- [x] 2026-08-27 用户最终 review 通过。

## 4. 完成定义

- [x] 不存在持续 `while true ask_llm`；
- [x] 本地 7 天虚拟长跑调用频率/预算稳定；真实模型/P4 与 120 秒、1 秒粒度资源采样稳定门禁通过；
- [x] 本地抢占、关停和重连测试证明不抢占用户动作；
- [x] Cat 不接收原始用户输入、不调用 HA 写 Tool，Timer/HA 触发均可追溯；
- [x] 用户可查看、暂停和关闭 autonomy；
- [x] 用户 review 通过，Phase 7 计划已归档并更新架构状态。
