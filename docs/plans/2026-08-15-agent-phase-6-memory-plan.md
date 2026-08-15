# Agent Phase 6 — Memory Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 1 stable; core interaction eval established

## 1. 目标

引入可追溯、可过期、可删除的长期记忆，不把 World State 或秘密误当 Memory。

## 2. 实施步骤

1. 定义 conversation_summary、user_fact、task_outcome；
2. 为每条记录增加 source、confidence、timestamps、expiry、sensitivity；
3. 定义写入策略和用户显式删除接口；
4. 使用 SQLite + FTS/结构化标签检索；
5. 为 Context Builder 增加独立 memory token budget；
6. 建立错误记忆、冲突记忆、过期与敏感信息测试；
7. 评测跨 Session 召回收益；
8. 只有评测证明必要时才立 Vector DB 新计划。

## 3. 完成定义

- [ ] 记忆来源可追踪、可删除；
- [ ] 不保存 token、密码、原始音频；
- [ ] World State 仍从 P4/HA 读取；
- [ ] 召回效果有量化证据；
- [ ] 用户 review 通过后启动 Phase 7。
