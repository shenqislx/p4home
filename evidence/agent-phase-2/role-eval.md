# Phase 2A Role Eval

> Date: 2026-08-18
> Model: `qwen3.8:27b-mlx`
> Ollama: `0.32.14`
> Raw report: [qwen3.8-27b-role-eval-v2.json](./qwen3.8-27b-role-eval-v2.json)

评测固定执行两轮，并分别报告 Router、Human、Robot、Cat。报告的 `aggregate_score` 固定为 `null`，
禁止把权限、安全与文本体验压成一个总分。

| Role | 用例 | 通过 | 关键结果 |
|---|---:|---:|---|
| Router | 24 | 24 | accuracy 100%；unsafe misroute 0；p50/p95 383/1,691 ms |
| Human | 8 | 8 | completion 100%；policy violation 0；p50/p95 1,647/2,405 ms |
| Robot | 8 | 8 | capability unavailable 100%；模型调用 0；ToolCall 0 |
| Cat | 18 | 18 | contract accuracy 100%；用户原文拒绝 2/2；ToolCall 0 |

## 评测边界

- Router：12 条固定输入两轮，覆盖 Human 对话、Robot 家控、混合、代词、条件式与否定命令；
- Human：4 条固定输入两轮，验证无工具、非空响应、本地设备执行声明拒绝和 clarification 信号，
  不对主观文风生成综合分；每个 case 显式保存 `policy_compliant`；
- Robot：Phase 4 前只验证确定性能力未上线响应，明确证明不会调用模型或真实 HA Tool；
- Cat：Phase 2A 只验证归一化事件契约、六个房间和用户原文/非法事件拒绝；Cat 模型决策与真实动作
  属于 Phase 2B，不能由本报告提前宣称通过。

所有真实模型请求均显式 `think=false` 且不提供 `tools`。任一角色失败或安全计数非零时，CLI 会保留
完整报告并返回非零状态。本次评测退出码为 0；期间未连接 P4、Home Assistant 或 Device WebSocket，
也未改变系统已有 Ollama 服务的生命周期。

## 结论

Phase 2A 的契约、路由、角色隔离、Human 本地策略、Robot 未上线边界、组合调度、审计和分角色
eval 退出条件在 review 修复后全部满足。该结论只允许进入 Phase 2B 的设计/实现，不代表 Phase 2
完成。
