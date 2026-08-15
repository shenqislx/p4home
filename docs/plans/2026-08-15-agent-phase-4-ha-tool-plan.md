# Agent Phase 4 — Home Assistant Tool Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 1 complete; HA 环境稳定；Phase 2 建议完成

## 1. 目标

由 Agent Runtime 直接连接 Home Assistant，提供受 allowlist 和 policy 约束的家居 Tool，并确保 Agent 与 P4 最终观察到相同 HA 状态。

## 2. 实施步骤

1. 建立独立 HA 账号/token 和凭证存储；
2. 实现认证、request id、订阅、重连与 metrics；
3. 只加载 allowlist 实体；
4. 先实现 `get_entity` 读侧；
5. 再实现 `turn_on/turn_off/activate_scene` 低风险写侧；
6. Tool Runtime 执行 entity/service allowlist 与高风险确认策略；
7. 关联 HA result 和后续 `state_changed`；
8. 验证 P4 现有订阅自然回刷；
9. 增加 prompt injection、越权、HA 离线和超时测试；
10. 建立执行审计日志。

## 3. 完成定义

- [ ] Agent 不经过 P4 即可控制允许的 HA 实体；
- [ ] Agent 与 P4 状态最终一致；
- [ ] 任意 `call_service(json)` 不向模型开放；
- [ ] 越权与高风险动作被稳定阻止；
- [ ] 用户 review 通过后启动 Phase 5。
