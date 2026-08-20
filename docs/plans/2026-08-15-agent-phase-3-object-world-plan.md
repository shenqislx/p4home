# Agent Phase 3 — Object-level World Plan

> Status: `in_progress`
> Started: 2026-08-20
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2 complete

## 1. 目标

在 Cat 房间级闭环稳定后，引入 sofa、desk、window 等对象锚点，使 Cat 的
`sit/look_at/interact` 成为真实可执行语义动作；不扩大 Robot/Human 权限。

## 2. 不可变边界

1. Device Protocol v1 与 Tool Schema v1 保持冻结；对象动作通过显式版本化的新契约接入，不能原地
   扩大 v1 枚举或让旧设备误报能力；
2. 模型只接触稳定对象 ID、房间、可用性和支持动作；anchor 坐标与 animation binding 只存在于
   确定性执行层；
3. 对象级能力只属于 Cat。Router 无 Tool，Human/Robot 不获得对象 Tool，用户原文仍不能创建 Cat Run；
4. P4 仍是动作完成、占用与可用性的唯一权威；Agent 不用目标状态推断某个 `action_id` 已完成；
5. Phase 2 的 deadline、幂等、取消、重连 snapshot 与 HA/UI 隔离门禁继续成立。

## 3. 纵切 3A — Object Registry Contract

- [x] 定义 room-qualified stable object id、room ownership、anchor、supported actions、默认可用性与
  animation bindings；
- [x] 建立可校验的 World Object Registry v1，并提供不含坐标的 Agent capability projection；
- [x] 固件提供只读注册表与确定性 lookup/support 查询，不在 3A 提前开放执行 Tool；
- [x] 用契约测试锁定 JSON、TypeScript 与 C 的对象顺序、房间、动作与内部锚点一致性。

退出门禁：`living_room.sofa`、`study.desk`、`living_room.window` 使用稳定 ID；非法 ID、重复 ID、
越界 anchor、缺失 animation binding 与 room/action 不一致会被拒绝；模型侧投影不包含坐标或动画名。

## 4. 纵切 3B — P4 Object Runtime

只有 3A 退出门禁通过后开始：

- 扩展 World snapshot 的对象位置、朝向、姿态、占用与可用性；
- 实现 `go_to/sit/look_at/interact` 的队列、deadline、幂等、取消与终态缓存；
- 新增稳定错误码：对象不存在、不支持动作、不可用、被占用与执行中取消；
- 通过版本化 capabilities、Device Protocol 与 Tool Schema 公布真实执行能力；
- UI 只渲染 World snapshot，不拥有对象级语义真值。

退出门禁：host simulator 可确定性执行和拒绝全部对象动作；capabilities 与执行层一致；旧 v1
客户端仍按 Phase 2 行为工作。

## 5. 纵切 3C — Cat Object Event & Role Boundary

只有 3B 退出门禁通过后开始：

- 定义经过策略层归一化的对象事件，不接受用户原文或任意 target/action；
- Cat 模型只从无坐标 capability projection 选择对象 Tool，并将观察结果写入 Run 审计；
- 支持 `go_to(target_id) → sit(target_id)` 的有界顺序执行，前一步失败立即停止；
- 回归 Router/Human/Robot 无法看到、选择或调用对象级 Cat Tool。

退出门禁：fake device 上对象不存在、不支持动作、被占用、中途取消和断线 unknown 均有可审计
终态；任何越权事件在模型或 WebSocket 前拒绝。

## 6. 纵切 3D — Simulator & Hardware Gate

只有 3C 退出门禁通过后开始：

- 在完整像素 simulator 验证对象锚点、朝向、姿态与动画绑定；
- 通过真实 Device WebSocket 在 P4 实机完成 `go_to(living_room.sofa) → sit`；
- 验证重连 snapshot、取消、占用冲突、Agent 离线、HA/UI 隔离与资源/8 FPS 回归；
- artifact 身份、强 marker 与无矛盾证据由 Codex 判定，workflow 绿色本身不代表通过。

## 7. 当前进度

2026-08-20，用户明确授权启动 Phase 3。3A 已建立 World Object Registry v1、无坐标 Agent projection、
固件只读注册表和 JSON/TypeScript/C 一致性门禁。Node 24.19 strict typecheck、Agent 119/119、Python
contract 47/47、C host 1/1 与 ESP-IDF v5.5.4 全量固件构建均通过；证据见
[Phase 3A Object Registry Contract Evidence](../../evidence/agent-phase-3/phase-3a-object-registry.md)。
据此 3A 退出门禁满足，下一步进入 3B P4 Object Runtime；当前仍未向模型或真实 Device WebSocket
公布对象级 Tool，也未修改冻结的 v1 契约。

## 8. 完成定义

- [ ] 模型不接触坐标即可稳定完成对象动作；
- [ ] capabilities 与真实执行能力一致；
- [ ] 对象级失败可被 Agent 正确观察；
- [ ] 对象级能力只属于 Cat，跨角色越权测试通过；
- [ ] 用户 review 通过后启动 Phase 4。
