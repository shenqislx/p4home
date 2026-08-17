# Agent Phase 7 — Cat Autonomy Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2、4、6 complete; 安全与稳定性门禁通过

## 1. 目标

为 Cat 增加 Timer/HA/World/task-complete 事件驱动、低频、低优先级、可审计并可由用户完全关闭
的自主行为。Robot/Human 不因此获得后台自主执行能力。

## 2. 实施步骤

1. 定义 timer/world/HA/task-complete Cat trigger schema；HA 事件只投影 allowlist 字段；
2. 增加 Event Policy、去重、过期、quiet hours、每日调用预算和全局开关；
3. Cat autonomy 使用独立 RoleProfile revision、专属 Context 与最小 P4 World 工具权限；
4. Cat autonomy action 永远低于任何用户 Interaction 和 Robot action 优先级；
5. 用户输入不传给 Cat，但会取消未开始或可中断的 Cat 动作；
6. 重启后不补执行过期 trigger；
7. 建立长跑、模型调用频率、误触发和抢占测试；
8. 提供审计页面或日志查询。

## 3. 完成定义

- [ ] 不存在持续 `while true ask_llm`；
- [ ] 长跑中调用频率、成本和行为稳定；
- [ ] 不抢占用户动作；
- [ ] Cat 不接收原始用户输入、不调用 HA 写 Tool，Timer/HA 触发均可追溯；
- [ ] 用户可查看、暂停和关闭 autonomy；
- [ ] 用户 review 通过后归档整个 Agent 主计划并更新架构状态。
