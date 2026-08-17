# Agent Phase 2 — Role Runtime & P4 Room-level Cat World Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 0-1 complete; M6 HA 主链状态明确

## 1. 目标

建立统一 Role Router 与 Robot/Human/Cat 三个隔离行为域，并把现有房间级角色能力明确归入 Cat 的
P4 World Adapter。三个角色共用同一已加载模型和 Provider，但上下文、工具、推理参数与审计隔离。

## 2. 实施步骤

1. 冻结 `RoleId / Interaction / RoutePlan / RoleAssignment` 契约；RoutePlan 从第一版使用
   `assignments[] + source span`，但 Runtime 暂时限制最多一个 assignment；
2. 实现无 Tool、temperature 0 的 Role Router；非法、未知或重叠分段 fail closed 到 Human 澄清，
   绝不默认选择 Robot；不得复用 Phase 1 带 Tool 的 `TEXT_AGENT_SYSTEM_PROMPT` 充当 Router；
3. 定义 Robot/Human/Cat RoleProfile revision：Robot 只允许 HA Tool namespace，Human 无执行 Tool，
   Cat 只允许最小 P4 World Tool；Phase 4 前 Robot 对 HA 命令明确返回能力未上线，不借用 Cat Tool；
4. 为三个角色实现独立 Session、Context Builder、消息历史、预算、temperature 和 AbortSignal；
5. 共用一个 `qwen3.8:27b-mlx` Ollama Provider/已加载模型，所有 Qwen 请求
   强制 `think: false`，增加有界公平队列，Cat 永远低优先级；
6. 审计贯通 `interaction_id → route_plan_id → role_id → run_id → tool_call_id → action_id`；
7. 为 Human 建立无工具基础对话；用户输入只允许路由到 Human/Robot，Cat 不接收原始文本；
8. 新增 `world_service`，持有 Cat 的 room、activity、current_action；
9. 把角色决策从 `ui_home_actor` 抽离，UI 只保留渲染；
10. 实现容量受限的 Action Queue 与完整状态机；
11. 新增 `agent_transport` Device WebSocket；
12. 实现 hello/capabilities/heartbeat/snapshot/reconnect；
13. 实现 Cat `get_state/go_to_room/set_activity/say/get_snapshot`；
14. 支持 duplicate action、deadline、cancel、queue full；
15. 保留 Agent 离线时现有 HA UI 与本地 fallback policy；
16. 扩展 host simulator/fake backend，并用归一化 test/timer event 触发 Cat，不使用用户文本；
17. 在 Cat 真实 Action 前增加确定性策略门禁；在 Robot Phase 4 真实 HA Action 前另建 HA 策略；
18. 把 timeout 定义为“Agent 停止等待”而不是“动作必未发生”：设备在每个副作用前检查 deadline，
    Agent 以 action_id 幂等重试，并对 timeout/断线后的未知结果执行 snapshot reconciliation；
19. 完成 Cat Runtime ↔ simulator ↔ 实机闭环。

## 3. 验证

- “今天好累”只路由 Human；“打开空调”只路由 Robot，但 Phase 4 前不执行并明确能力未上线；
- 任何用户原始文本都不能直接建立 Cat Run；
- Router 非法输出不会产生 Robot/Cat ToolCall；Human 无法调用执行型 Tool；
- 捕获 Router/Robot/Human/Cat 的 Ollama 请求，全部含 `think: false`，且响应不产生 thinking 内容；
- 归一化 Cat test event `room_target=living_room` 返回 accepted/started/completed；
- 相同 action_id 重发不重复移动；
- 工具忽略本地 AbortSignal 或响应晚到时，过期动作不会在设备侧产生新副作用；若结果未知，重连后
  通过 snapshot 对账，禁止盲目重放；
- 断线重连后 snapshot 与真实角色一致；
- Agent 离线 2 小时不影响 P4 ↔ HA；
- 连续 100 次动作无崩溃、无泄漏、无静默丢失；
- Cat 越权/过期/高频事件必须 100% 被策略层拒绝；任何模型误调用均不得到达 Device WebSocket；
- Router、Human、Cat、Robot 骨架专项 eval 分开报告，不生成单一 Agent 总分；
- image、DIRAM、heap、stack、8 FPS 门禁通过。

## 4. 完成定义

- [ ] Role Router 单 assignment、三个 RoleProfile 和上下文隔离稳定；
- [ ] Router/Human 无执行权限，Robot/Cat Tool namespace 不交叉；
- [ ] Cat 房间级事件动作闭环稳定；
- [ ] UI 不再拥有语义决策真值；
- [ ] 故障与资源证据齐全；
- [ ] 用户 review 通过后启动 Phase 3。
