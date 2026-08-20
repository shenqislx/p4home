# Phase 3C Cat Object Event and Role Boundary Evidence

> Date: 2026-08-20
> Runtime: Node.js 24.19.0
> Verdict: `pass`

## 完成范围

新增 `test.object_sit_target` 归一化对象事件。入口只接受精确字段和 Tool Schema v2 已审阅的 sit
目标，事件不能携带用户原文、坐标、任意 action 或扩大的 target allowlist。策略在 scheduler、Run、
模型和 WebSocket 之前固定派生 `character.go_to(target_id) → character.sit(target_id)`。

Cat RoleProfile v2 独占四个对象 Tool；Human、Robot 与 Router 仍没有对象 Tool，Cat 仍拒绝用户原文。
模型请求只包含稳定对象 ID、房间、实时可用性和支持动作，并把同一份无坐标 capability projection
写入 Run 事件。模型必须按顺序返回与策略完全相同的两个 ToolCall；执行端只有在第一步收到明确
`action.completed` 后才发送第二步。

Device Protocol v2 adapter 和 deterministic fake-device 已接入对象 capabilities、snapshot、结果校验、
取消与重连对账。对象可用性以最新 snapshot 为准，而不是沿用握手时的旧值。每个模型 ToolCall 都会
进入终态审计；未执行的后续步骤以 `CANCELLED` 和 `skipped=true` 终结，但不会创建或发送 Device
Action。unknown 结果禁止 replay，即使 snapshot 显示目标状态也不伪造某个 action_id 已完成。

## 复审修复

- Role Context 对 capability projection 做精确字段、注册表顺序、对象/房间、动作顺序与完整容量校验，
  拒绝 `default_available`、animation binding 或任意额外内部字段；
- 取消发生在模型完成后、设备 dispatch 前时，两条 ToolCall 都会终结，但不创建虚假的 Device Action；
- 取消发生在 unknown reconciliation 窗口时保留 unknown/replay 禁止事实，同时把 Run 标记为
  `cancelled`；若迟到的显式 terminal 已到达，则 terminal 结果优先；
- 模型 ToolCall 已入库后若 Action 审计身份冲突，所有 pending ToolCall 会以确定性错误终结，Run 不会
  留在 running；
- action/model/wait/reconciliation timeout 在策略、模型和 WebSocket 前校验；fake-device 的重复占用
  设置不再制造虚假的 state version 变化。

## 确定性场景

- 合法 sofa 事件严格执行 `go_to → sit`，两步 action/result/audit 全部成功；
- 用户原文、额外 action 字段、desk sit 目标和扩大的 allowlist 在模型/WebSocket 前拒绝；
- 实时 unavailable snapshot 在模型前阻断；
- 模型改写 target 或序列会在 ToolCall 审计和 WebSocket 前拒绝，不留下 pending call；
- fake-device 返回 `UNKNOWN_OBJECT`、`OBJECT_OCCUPIED` 时只发送第一步并终结第二个 ToolCall；
- `go_to` 成功后 `sit` 返回 `UNSUPPORTED_OBJECT_ACTION`，Run 保留逐步终态；
- 执行中取消返回 `CANCELLED`，不发送 sit；
- 执行中断线返回 unknown，重连 snapshot 记录 `state_not_satisfied`，不 replay、不发送 sit；
- Cat 可调用对象 Tool，Human/Robot 不可见也不可授权，Cat 用户原文继续 fail closed；
- v1 fake-device、Room Cat Runner、真实 WebSocket v1 与全部既有角色/审计测试保持通过。

## 验证结果

| 检查 | 结果 |
|---|---:|
| Node 24.19 TypeScript strict typecheck | 通过 |
| Agent 全量确定性测试 | 139/139 |
| Phase 3C 专项 Node 测试 | 16/16 |
| Python contract tests | 54/54 |
| Device Protocol v1 / Tool Schema v1 冻结与默认路径回归 | 通过 |
| Device Protocol v2 / Tool Schema v2 冻结校验 | 通过 |

本阶段只改动 Agent、测试、契约状态说明和证据，没有改动 3B 已验证的固件对象执行层，因此没有重复
声称新的 ESP32-P4 硬件证据。3B 的 host/ASan/UBSan/RISC-V 编译证据仍是固件基线；真实设备上的
`go_to(living_room.sofa) → sit`、像素 simulator、动画绑定和硬件重连门禁属于 3D。

据此 3C 退出门禁满足，v2 契约由 candidate 冻结。下一步进入 3D Simulator & Hardware Gate；在
3D 完成前不得把 fake-device 结果描述为实机对象动作通过。
