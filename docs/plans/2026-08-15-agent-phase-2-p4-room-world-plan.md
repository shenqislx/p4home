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
10. 完成 Agent Runtime ↔ simulator ↔ 实机闭环。

## 3. 验证

- “去客厅待一会儿”返回 accepted/started/completed；
- 相同 action_id 重发不重复移动；
- 断线重连后 snapshot 与真实角色一致；
- Agent 离线 2 小时不影响 P4 ↔ HA；
- 连续 100 次动作无崩溃、无泄漏、无静默丢失；
- image、DIRAM、heap、stack、8 FPS 门禁通过。

## 4. 完成定义

- [ ] 房间级动作闭环稳定；
- [ ] UI 不再拥有语义决策真值；
- [ ] 故障与资源证据齐全；
- [ ] 用户 review 通过后启动 Phase 3。
