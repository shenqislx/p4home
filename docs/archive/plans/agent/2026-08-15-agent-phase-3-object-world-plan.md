# Agent Phase 3 — Object-level World Plan

> Status: `completed`
> Started: 2026-08-20
> Completed: 2026-08-20
> Reviewed: 2026-08-20
> Architecture: [P4 Local Agent Architecture](../../../p4-local-agent-architecture.md)
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

- [x] 扩展 World snapshot 的对象位置、朝向、姿态、占用与可用性；
- [x] 实现 `go_to/sit/look_at/interact` 的队列、deadline、幂等、取消与终态缓存；
- [x] 新增稳定错误码：对象不存在、不支持动作、不可用、被占用与执行中取消；
- [x] 通过版本化 capabilities、Device Protocol 与 Tool Schema 公布真实执行能力；
- [x] UI 只渲染 World snapshot，不拥有对象级语义真值。

退出门禁：host simulator 可确定性执行和拒绝全部对象动作；capabilities 与执行层一致；旧 v1
客户端仍按 Phase 2 行为工作。

## 5. 纵切 3C — Cat Object Event & Role Boundary

只有 3B 退出门禁通过后开始：

- [x] 定义经过策略层归一化的对象事件，不接受用户原文或任意 target/action；
- [x] Cat 模型只从无坐标 capability projection 选择对象 Tool，并将观察结果写入 Run 审计；
- [x] 支持 `go_to(target_id) → sit(target_id)` 的有界顺序执行，前一步失败立即停止；
- [x] 回归 Router/Human/Robot 无法看到、选择或调用对象级 Cat Tool。

退出门禁：fake device 上对象不存在、不支持动作、被占用、中途取消和断线 unknown 均有可审计
终态；任何越权事件在模型或 WebSocket 前拒绝。

## 6. 纵切 3D — Simulator & Hardware Gate

只有 3C 退出门禁通过后开始：

- [x] 在完整像素 simulator 验证对象锚点、朝向、姿态与动画绑定；
- [x] 通过真实 Device WebSocket 在 P4 实机完成 `go_to(living_room.sofa) → sit`；
- [x] 验证重连 snapshot、取消、占用冲突、Agent 离线、HA/UI 隔离与资源/8 FPS 回归；
- artifact 身份、强 marker 与无矛盾证据由 Codex 判定，workflow 绿色本身不代表通过。

## 7. 当前进度

2026-08-20，用户明确授权启动 Phase 3。3A 已建立 World Object Registry v1、无坐标 Agent projection、
固件只读注册表和 JSON/TypeScript/C 一致性门禁。代码审查后进一步收紧公共 API、实时可用性与
动作-动画精确映射；Node 24.19 strict typecheck、Agent 120/120、Python contract 48/48、C host
1/1，以及 ESP-IDF 固件对象编译和 ELF 增量链接均通过。3A 初始实现的全量固件构建已通过；本轮
全量重跑受沙箱进程枚举权限限制，详见
[Phase 3A Object Registry Contract Evidence](../../../../evidence/agent-phase-3/phase-3a-object-registry.md)。
3B 已完成 P4 权威对象 snapshot、四种对象动作、稳定错误、Device Protocol v2 / Tool Schema v2
candidate，以及默认 v1、显式选择 v2 的 transport 门禁。3B 复审后，Schema 已补齐注册表映射、
角色/对象状态不变量、逐动作结果与 retryable 约束。Agent 123/123、Python 54/54、C host 2/2、
ASan/UBSan 2/2、ESP32-P4 默认与显式 v2 编译及最终 ELF 增量链接均通过；证据见
[Phase 3B P4 Object Runtime Evidence](../../../../evidence/agent-phase-3/phase-3b-object-runtime.md)。据此 3B
退出门禁满足。3C 已增加只接受 `test.object_sit_target` 的前置策略，动作由策略固定派生为
`go_to → sit`；Cat 只能从实时、无坐标 capability projection 确认该序列，Human/Robot 仍无对象
Tool，用户原文也不能进入 Cat。两步 ToolCall 均有终态审计，第一步非 completed 时第二步不会发往
设备；fake-device 的对象不存在、不支持、占用、取消与断线 unknown/重连对账均通过。Node 24.19
strict typecheck、Agent 139/139 与 Python contract 54/54 通过。3C 复审进一步收紧 canonical capability
字段/顺序，修复对账窗口取消状态和 Action 审计冲突遗留 pending ToolCall，并把非法 timeout 前移到
策略/模型之前拒绝；证据见
[Phase 3C Cat Object Event and Role Boundary Evidence](../../../../evidence/agent-phase-3/phase-3c-cat-object-boundary.md)。
据此 3C 退出门禁满足，Device Protocol v2 / Tool Schema v2 已冻结，下一步进入 3D Simulator &
Hardware Gate；v1 契约和默认 transport 选择保持不变。

3D 本地部分已把对象 snapshot 接入同一套 Pixel Home renderer，增加左右朝向及 walk/sit/look/paw
像素帧，并用完整 LVGL simulator 自动核对 sofa/desk anchor、floor anchor、pose、四种 animation
binding、取消恢复与占用冲突。复审同时发现并修复两条此前只能在实机暴露的路径：WebSocket 回调
内同步完成动作导致取消无窗口、瞬态动画被 UI 合并；Agent 离线 fallback 保留旧对象 target 导致
房间/对象状态矛盾。现在对象执行由 worker 推进并保留两个 8 FPS 帧；短暂传输中断先保留权威对象
snapshot 10 秒供自动重连，超过窗口才让 local fallback 释放对象占用和 target。跨阶段复审还修复了
fake-device 生命周期 `state_version/world.changed` 与 P4 不一致、幂等缓存重放误报强 marker、静态
object-idle 每帧重复 invalidation。实机复审进一步发现失败重连会反复重置 10 秒宽限，导致 Agent
离线 fallback 永不到期；现已改为只有已认证连接真正断开才启动一次宽限，并在到期时原子释放对象
target/占用。最终 run `32382940058` 的 manifest 身份、动作链、重连 snapshot、取消、设备/UI 离线
释放、HA READY、时间同步、资源和 240 秒 8 FPS 证据均通过，未见崩溃或栈/看门狗故障。Phase 3
技术退出门禁已满足。2026-08-20 用户最终 review 通过，Phase 3 已完成并关闭；证据见
[Phase 3D Simulator & Hardware Gate Evidence](../../../../evidence/agent-phase-3/phase-3d-simulator-hardware-gate.md)。

## 8. 完成定义

- [x] 模型不接触坐标即可稳定完成对象动作；
- [x] capabilities 与真实执行能力一致；
- [x] 对象级失败可被 Agent 正确观察；
- [x] 对象级能力只属于 Cat，跨角色越权测试通过；
- [x] 用户最终 review 通过，Phase 3 关闭；
- [ ] Phase 4 需用户另行明确授权后启动。
