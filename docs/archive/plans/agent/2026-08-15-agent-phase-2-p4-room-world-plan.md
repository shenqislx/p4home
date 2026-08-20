# Agent Phase 2 — Role Runtime & P4 Room-level Cat World Plan

> Status: `completed`
> Restarted: 2026-08-17
> Completed: 2026-08-20
> Reviewed: 2026-08-20
> Architecture: [P4 Local Agent Architecture](../../../p4-local-agent-architecture.md)
> Depends on: Phase 0–1 complete; M6 HA 主链保持隔离

## 1. 目标与边界

Phase 2 建立可审计的 Role Runtime，并让 Cat 通过冻结的 Device Protocol v1 完成房间级动作闭环。
本阶段不接入 Robot 的真实 Home Assistant Tool，不实现多角色拆句，不把用户原文交给 Cat，也不以
模型输出代替确定性策略、设备幂等或 snapshot 对账。

本轮重新设计后，不再把 Router、调度器、Agent WebSocket、固件状态机和实机验收作为一条不可分割
的 19 步任务。实施拆为四个有独立退出门禁的纵切；前一纵切未通过时，后一纵切不得产生真实副作用。

## 2. 不可变安全约束

1. Role Router 没有 Tool，只能产生一个 Human/Robot assignment；非法、未知、混合或越权输出
   fail closed 到 Human 澄清，绝不默认 Robot；
2. Human 无执行 Tool；Robot 在 Phase 4 前没有真实 HA Tool；Cat 只持有五个冻结 P4 World Tool；
3. Cat 只接收经过策略层归一化的 event，任何用户原文都不能创建 Cat Context 或 Run；
4. 所有 Qwen 请求显式 `think: false`，Role 的上下文、Session、预算、temperature 和审计隔离；
5. timeout 只表示 Agent 停止等待。设备在副作用前检查 deadline，以 `action_id` 幂等，并在未知结果
   时使用 snapshot reconciliation，禁止盲目重放；
6. Agent 传输、Cat World 和 HA 现有链路相互隔离；Agent 离线不得破坏 P4 ↔ HA 与本地 UI。

## 3. 纵切 2A — Role Contract & Router

交付：

- [x] 定义 `RoleId / UserTextInteraction / RoutePlan / RoleAssignment / SourceSpan`；
- [x] RoutePlan v1 限制恰好一个 assignment，并要求覆盖完整 UTF-16 用户文本；
- [x] 定义 Robot/Human/Cat `role-profile/v1`，冻结工具、模型参数、轮次和队列优先级；
- [x] Context Builder 拒绝 Cat 用户原文，并拒绝 Human/Robot 接收 Cat event；
- [x] 实现无 Tool、temperature 0、结构化输出本地复验的 Role Router；
- [x] 非法 JSON、ToolCall、thinking 内容与 provider error 全部闭合到 Human clarification；
- [x] 建立各角色独立 Session 与 Context 历史，不跨角色复用消息；
- [x] Human 无工具基础对话与 Robot “Phase 4 前能力未上线”确定性响应；
- [x] Human 回复经过本地设备执行声明/澄清策略复验，违规输出不提交 Session；
- [x] 有界公平调度器：Human/Robot 轮转、用户任务优先，Cat 只能使用 background 队列；
- [x] 建立 Router → Scheduler → Session → Runner/Audit 正式组合入口，供 2B adapter 复用；
- [x] 审计贯通 `interaction_id → route_plan_id → role_id → run_id`，并支持按 Interaction 反查 Run；
- [x] 建立 Router/Human/Robot/Cat 四份独立 eval，不生成单一综合分。

退出门禁：

- “今天好累”只产生 Human assignment；“打开空调”只产生 Robot assignment；混合或含糊输入只进入
  Human clarification；
- Router 请求中不存在 `tools`，且 `think=false`；
- Router 任意非法输出都不能创建 Robot/Cat ToolCall；
- Human 设备执行声明与非澄清 fallback 不能作为成功回复提交；
- Cat Context 的用户原文拒绝率 100%；
- Node 24.19 严格类型检查和全部确定性测试通过。

## 4. 纵切 2B — Cat Action Adapter & Deterministic Device Simulator

只有 2A 退出门禁通过后开始：

- [x] 从归一化 `test.room_target` event 创建 Cat Run，不从用户文本创建；
- [x] 在任何模型或动作调用之前增加 Cat Event Policy：来源、频率、时效、目标房间和工具 allowlist；
- [x] 实现 Agent 侧 Device WebSocket adapter 与容量受限的 action waiter；
- [x] 在 deterministic fake device 上跑通 hello/capabilities/heartbeat/snapshot/reconnect；
- [x] 实现 accepted/started/completed/failed、duplicate、deadline、cancel、queue full；
- [x] timeout/断线后标记 outcome unknown，通过 snapshot 对账，不盲目重放。

退出门禁：相同 `action_id` 重发不产生第二次副作用；100 次 fake device 动作无静默丢失；断线后
snapshot 恢复一致；过期与越权 event 100% 在 WebSocket 前被拒绝。

## 5. 纵切 2C — P4 World Service & UI Separation

只有 2B 退出门禁通过后开始：

- 新增 `world_service`，持有 Cat room/activity/current_action 与单调 `state_version`；
- 从 `ui_home_actor` 抽离语义真值，UI 只根据 World snapshot 渲染动画；
- 实现容量 8 的 Action Queue、终态缓存、deadline 与 duplicate 检查；
- 扩展 host simulator/fake backend，先验证状态机，再连接真实网络；
- 保留本地 fallback policy，Agent 离线时原 HA UI 与触控链不变。

退出门禁：host simulator 完成 Cat `go_to_room/set_activity/say/get_state/get_snapshot` 全生命周期；
队列满、取消、过期和重复动作均有确定终态；UI 不再拥有 Cat 房间语义真值。

## 6. 纵切 2D — Real Transport & Hardware Gate

只有 2C 退出门禁通过后开始：

- [x] 新增与 HA WebSocket 隔离的 `agent_transport`；
- [x] 完成 Cat Runtime ↔ P4 Device WebSocket ↔ world_service ↔ UI 闭环；
- [x] 验证 reconnect、snapshot reconciliation、Agent 离线两小时与连续 100 次动作；
- [x] 采集 image、DIRAM、heap、stack、8 FPS 和 accepted/started/completed 延迟证据；
- [x] 实机阶段不同时扩大米家设备覆盖或修改 HA 主链。

最终退出链：

```text
test.room_target(room_target=living_room)
→ Cat Event Policy
→ character.go_to_room(living_room)
→ action accepted / started / completed
→ snapshot state_version 对账
→ Cat Run 获得真实完成结果
```

## 7. 当前证据

2026-08-18 review 修复后的 2A 代码包含 Role Contract、三个 Profile、Context Builder、fail-closed
Router、独立 Role Session、Human/Robot 入口、有界调度器与 SQLite 路由审计关联。正式
`runRoleInteraction()` 入口固定组合 Router → Scheduler → Session → Runner/Audit；同一 Session 的
Run 仍在底层串行，避免绕过组合入口时产生历史竞态。Node 24.19.0 严格类型检查与 92 项确定性测试
全部通过。Human 请求不暴露 Tool，回复还会经过本地执行声明/澄清策略复验；Robot 不调用模型或
设备，Cat 始终排在用户任务之后。SQLite schema v2 支持可索引、去重的 Interaction → Run 反查，
并可从 Run trace 还原 RoutePlan、assignment、Role 和 Session。

真实 `qwen3.8:27b-mlx` Router 已完成 4 个样例 smoke：Human、Robot、混合澄清和含糊澄清均符合
预期。首轮发现默认模型不稳定遵循 Ollama `format`，现已改成精确 JSON 提示词加 Runtime 本地 AJV
复验；修订后 4/4 通过，证据见
[Phase 2A Role Router Live Smoke](../../../../evidence/agent-phase-2/role-router-smoke.md)。临时 Ollama 服务
已停止。

review 修复后的四角色 v2 eval 已执行两轮且不生成综合分：Router 24/24、Human 8/8、Robot 8/8、
Cat 18/18；Router unsafe misroute 为 0，Human policy violation 为 0，Robot 模型/Tool 调用为 0，
Cat 用户原文拒绝为 2/2。CLI 现在对任一角色失败返回非零状态。完整摘要与原始 JSON 见
[Phase 2A Role Eval](../../../../evidence/agent-phase-2/role-eval.md)。

据此，Phase 2A 的退出门禁于 2026-08-18 review 修复后重新满足。尚未连接 simulator、P4 或 HA，
因此该结果只允许开始 2B，不得把它描述为 Phase 2 完成。

2026-08-18，2B 已新增逐帧冻结协议校验、Cat Event Policy、容量受限 Device WebSocket adapter、
deterministic fake device 和 Cat Run 审计入口。专项测试覆盖连续 100 次动作、`action_id` 幂等、
accepted/started/completed/failed、queue full、deadline、cancel、heartbeat、断线 unknown 与 reconnect
snapshot 对账；拒绝事件不会产生 action frame 或审计 Run。review 后进一步修复了 snapshot
伪完成、outbound seq 消耗、resync correlation、Run 对账审计和无界缓存，并接入只暴露批准 Tool
的 Cat 模型决策。Node 24.19.0 严格类型检查和 111 项全量
确定性测试通过，详细证据见
[Phase 2B Cat Action Adapter & Deterministic Device Evidence](../../../../evidence/agent-phase-2/phase-2b-deterministic-device.md)。
该 deterministic 验收链使用 fake provider 验证一次 Cat 模型 ToolCall，并在审计中记录
`model_turns=1`；尚未执行 live Cat 模型专项评测。冻结 v1 snapshot 只用于恢复权威状态，不能把
“目标状态已满足”伪装成特定 `action_id` 的 completed。

据此，2B 的 fake device 退出门禁满足，可以开始 2C；目前仍未修改 P4 固件、`world_service`、真实
网络或 HA 链路，不能把 2B 结果描述为 Phase 2 完成或实机通过。

2026-08-18，2C 已新增 P4 `world_service`，统一持有 Cat room/activity/active action 与单调
`state_version`，并将本地 HA fallback policy 从 actor view 抽离。`ui_home_actor` 公开 API 现在只
接收复制的 World snapshot；容量 8 的总 in-flight 队列、128 条 PSRAM 幂等记录、10 分钟终态保留、
accepted/started due sweep、cancel、duplicate/conflict 和五个 v1 Tool 生命周期均由 `-Werror` host test
覆盖。
Python 协议/分层契约 33/33、Agent 回归 111/111、完整像素 simulator 构建与 headless smoke 均通过。
ESP-IDF v5.5.4 固件在将动作记录从内部 BSS 迁移到 PSRAM 后构建成功，应用镜像 `0x162370`，3 MiB
分区剩余 54%。详细证据见
[Phase 2C P4 World Service & UI Separation Evidence](../../../../evidence/agent-phase-2/phase-2c-world-service.md)。

据此，2C 的 host 与固件编译退出门禁满足，可以开始 2D。当前仍未接入真实 Device WebSocket 或
执行实机连续动作、断线与性能门禁，不能把 Phase 2 描述为完成或实机通过。

2026-08-19，2D 软件侧已新增 Agent TLS WebSocket server、稳定 per-device Runtime Hub 与 P4
`agent_transport`，完成 Cat 产品入口经真实网络帧到 `world_service` 生命周期和 snapshot 的闭环。
未鉴权请求在 upgrade 前拒绝；SPKI pin、Bearer/device id、16 KiB 限制、协议违规断开、握手超时、
不可恢复错误重连和 HA fallback 均已实现。Node 全量 115/115、Python contract 42/42、hardware
helper 4/4、world host 1/1 通过；默认与 Agent-enabled ESP-IDF 构建均成功且 app 分区剩余 54%。
软件与门禁准备证据见
[Phase 2D Real Transport & Hardware Gate Evidence](../../../../evidence/agent-phase-2/phase-2d-real-transport.md)。

2026-08-20，自托管 workflow run
[32262619021](https://github.com/shenqislx/p4home/actions/runs/32262619021) 已对提交
`91aa3e58d24fee48e40d98d159485717f1a4252a` 完成 `phase2d_agent` 实机门禁。manifest 身份匹配，
profile 为 `phase2d_agent`，采集 `7,500` 秒；100 次 Cat 动作全部完成，三阶段最大延迟均小于
`595 ms`，第 50 次后的重连 snapshot version 为 `102`。设备侧在 Agent 离线超过两小时后输出
`VERIFY:agent_transport:offline_2h_fallback:PASS`，同时 HA 保持 READY；891 个后续 8 FPS marker
持续 PASS，周期 diagnostics 保持 `failed=0`、`protocol_errors=0`，无 panic/watchdog/reboot。
完整判定见
[Phase 2D Real Transport & Hardware Gate Evidence](../../../../evidence/agent-phase-2/phase-2d-real-transport.md)。

据此，2D 退出门禁满足。2026-08-20，用户确认 Phase 2 最终 review 通过，Phase 2 状态更新为
`completed`。Phase 3 保持 `pending`，需用户另行授权后才能启动。

## 8. Phase 2 完成定义

- [x] 2A–2D 四个纵切的退出门禁全部通过；
- [x] Router/Human 无执行权限，Robot/Cat Tool namespace 不交叉；
- [x] Cat 房间级事件动作闭环稳定，UI 不拥有语义真值；
- [x] timeout、幂等、断线与 snapshot reconciliation 有确定性和实机证据；
- [x] Agent 离线不影响既有 P4 ↔ HA；
- [x] 故障、资源、性能和角色专项 eval 证据齐全；
- [x] 用户已完成 Phase 2 最终 review。

Phase 2 已完成并归档。本计划的完成不自动启动 Phase 3。
