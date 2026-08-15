# Agent Phase 7 — Autonomy Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2、6 complete; 安全与稳定性门禁通过

## 1. 目标

增加事件驱动、低频、低优先级、可审计并可由用户完全关闭的自主行为。

## 2. 实施步骤

1. 定义 timer/world/HA/task-complete trigger；
2. 增加 quiet hours、每日调用预算和全局开关；
3. autonomy run 使用独立 AgentProfile 与更小工具权限；
4. autonomy action 永远低于用户 action 优先级；
5. 用户输入可取消未开始或可中断的自主动作；
6. 重启后不补执行过期 trigger；
7. 建立长跑、模型调用频率、误触发和抢占测试；
8. 提供审计页面或日志查询。

## 3. 完成定义

- [ ] 不存在持续 `while true ask_llm`；
- [ ] 长跑中调用频率、成本和行为稳定；
- [ ] 不抢占用户动作；
- [ ] 用户可查看、暂停和关闭 autonomy；
- [ ] 用户 review 通过后归档整个 Agent 主计划并更新架构状态。
