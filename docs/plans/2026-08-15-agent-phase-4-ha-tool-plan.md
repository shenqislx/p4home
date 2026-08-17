# Agent Phase 4 — Robot HA Tool & Multi-role Split Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2 complete; HA 环境稳定；Phase 3 可独立推进但按主线顺序先完成

## 1. 目标

由 Robot 直接连接 Home Assistant，提供受 allowlist 和 policy 约束的家居 Tool；同时把 Role Router
从单 assignment 升级为语义分割，使一个 Interaction 可安全地产生 Human 与 Robot 两个响应。

## 2. 实施步骤

1. 建立 Robot 专用 HA 账号/token 和凭证存储；
2. 实现认证、request id、订阅、重连与 metrics；
3. 只加载 allowlist 实体；
4. 先仅向 Robot RoleProfile 实现 `get_entity` 读侧；
5. 再仅向 Robot 实现 `turn_on/turn_off/activate_scene` 低风险写侧；
6. Tool Runtime 执行 entity/service allowlist 与高风险确认策略；
7. 关联 HA result 和后续 `state_changed`；
8. 验证 P4 现有订阅自然回刷；
9. 增加 prompt injection、越权、HA 离线和超时测试；
10. 建立执行审计日志；
11. RoutePlan 放开多个 assignment，验证 span 完整、无重叠、无遗漏和稳定顺序；
12. 实现确定性 Response Composer，分别呈现 Human 文本与 Robot accepted/completed/failed 结果；
13. 增加“我好累，打开空调”等未参与提示词调优的混合意图 holdout；
14. 验证 Human/Cat 无法取得 HA Tool，Router 分错角色也不能绕过 Robot policy。

## 3. 完成定义

- [ ] Robot 不经过 P4 即可控制允许的 HA 实体；
- [ ] Robot 与 P4 状态最终一致；
- [ ] 任意 `call_service(json)` 不向模型开放；
- [ ] 越权与高风险动作被稳定阻止；
- [ ] 混合输入可拆给 Human/Robot，文本与真实执行结果不串角色；
- [ ] 用户 review 通过后启动 Phase 5。
