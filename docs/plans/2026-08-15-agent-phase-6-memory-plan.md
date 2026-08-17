# Agent Phase 6 — Memory Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2 stable; Router/Robot/Human/Cat 专项 eval 骨架 established

## 1. 目标

引入可追溯、可过期、可删除的长期记忆，不把 World State 或秘密误当 Memory；通过评测决定
Robot/Human/Cat 使用共享、分离还是混合记忆，不预先让角色互读。

## 2. 实施步骤

1. 定义 conversation_summary、user_fact、task_outcome；
2. 为每条记录增加 source、confidence、timestamps、expiry、sensitivity、owner_role、
   visibility_scope、source_interaction_id 和 policy revision；
3. 定义写入策略和用户显式删除接口；
4. 使用 SQLite + FTS/结构化标签检索；
5. 为 Context Builder 增加独立 memory token budget；
6. 建立错误记忆、冲突记忆、过期与敏感信息测试；
7. 分别实现并评测：角色完全私有、共享 Store + ACL projection、共享 user_fact + 角色私有摘要/任务/
   pet memory；
8. 增加跨角色隐私泄漏、错误归属、权限变更和删除传播测试；
9. 用户 review 最终可见性矩阵后才启用跨角色召回；默认不跨角色；
10. 只有评测证明必要时才立 Vector DB 新计划。

## 3. 完成定义

- [ ] 记忆来源可追踪、可删除；
- [ ] 不保存 token、密码、原始音频；
- [ ] World State 仍从 P4/HA 读取；
- [ ] 召回效果有量化证据；
- [ ] 角色记忆可见性有量化对照和用户确认，跨角色读取不会隐式发生；
- [ ] 用户 review 通过后启动 Phase 7。
