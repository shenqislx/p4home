# Agent Phase 2 — P4 Room-level World Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 0-1 complete; M6 HA 主链状态明确

## 1. 目标

把现有房间级角色能力提升为具有真实状态、队列、幂等和完成反馈的 P4 World Adapter。

## 2. 实施步骤

1. 新增 `world_service`，持有 room、activity、current_action；
2. 把角色决策从 `ui_home_actor` 抽离，UI 只保留渲染；
3. 实现容量受限的 Action Queue 与完整状态机；
4. 新增 `agent_transport` Device WebSocket；
5. 实现 hello/capabilities/heartbeat/snapshot/reconnect；
6. 实现 `get_state/go_to_room/set_activity/say/get_snapshot`；
7. 支持 duplicate action、deadline、cancel、queue full；
8. 保留 Agent 离线时现有 HA UI 与本地 fallback policy；
9. 扩展 host simulator/fake backend；
10. 在真实 Action 前增加确定性策略/用户确认门禁，拦截无工具 eval 中的模型误调用；
11. 把 timeout 定义为“Agent 停止等待”而不是“动作必未发生”：设备在每个副作用前检查 deadline，
    Agent 以 action_id 幂等重试，并对 timeout/断线后的未知结果执行 snapshot reconciliation；
12. 完成 Agent Runtime ↔ simulator ↔ 实机闭环。

## 3. 验证

- “去客厅待一会儿”返回 accepted/started/completed；
- 相同 action_id 重发不重复移动；
- 工具忽略本地 AbortSignal 或响应晚到时，过期动作不会在设备侧产生新副作用；若结果未知，重连后
  通过 snapshot 对账，禁止盲目重放；
- 断线重连后 snapshot 与真实角色一致；
- Agent 离线 2 小时不影响 P4 ↔ HA；
- 连续 100 次动作无崩溃、无泄漏、无静默丢失；
- 无工具安全集必须 100% 被策略层拒绝；任何模型误调用均不得到达 Device WebSocket；
- image、DIRAM、heap、stack、8 FPS 门禁通过。

## 4. 完成定义

- [ ] 房间级动作闭环稳定；
- [ ] UI 不再拥有语义决策真值；
- [ ] 故障与资源证据齐全；
- [ ] 用户 review 通过后启动 Phase 3。
