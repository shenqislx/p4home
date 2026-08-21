# Phase 4D Multi-assignment RoutePlan & Response Composer Evidence

日期：2026-08-21

## 当前结论

4D coding 与独立 subagent bugs review 已完成，最终复核为 no findings。Runtime 现在使用显式
`RoutePlan` v2，把一个 Interaction 安全地拆为最多两个 Human/Robot assignment；每个 Run 只接收自己的
UTF-16 slice，最终响应由确定性 Composer 从结构化终态生成。4D 不新增 HA 权限，也不修改冻结的
Device Protocol 或 Cat Tool Schema。

## RoutePlan 与隔离边界

- v2 assignment 数量固定为 1–2，目标只允许 Human/Robot；双 assignment 必须各一个角色且保持原文顺序；
- span 使用 JavaScript/JSON 一致的 UTF-16 offset，必须为安全整数、非空、首尾连续覆盖全文、无 gap/overlap、
  不切开 surrogate pair，且每段不能只有空白；
- 未知角色、第三段、重复角色、Robot clarify、非法 reason、provider/JSON/schema 错误统一回退为单个
  full-span Human clarification；回退完成前不会创建 Robot Run；
- Role Session 只接收 `interaction.text.slice(start,end)`，审计保留全局 span，但不会把另一段原文、历史或
  HA observation 复制到当前角色上下文；
- RoutePlan v1 读取兼容保留；产品入口始终生成 v2，单 assignment 的原有 Human/Robot 行为不变。

## 调度、结果与审计

- 两个 assignment 按源顺序关联独立 `assignment_id/run_id/session`，使用有界 RoleScheduler；全局 deadline、
  外部取消、queue full、partial success 和 provider 不合作均有确定性终态；
- Robot `beginWrite()` 返回后同步锁定“副作用可能已发生”，即使 attempt malformed、timeout、断线或审计
  停滞，也保留 `HA_OUTCOME_UNKNOWN`、`replay_allowed=false` 和单次发送事实；
- 写入后的审计 I/O 与物理动作状态机解耦，按顺序进入 deferred tail；独立 finalize budget 内完成时写入
  `persisted`，存储故障或永久停滞明确返回 `deferred`，不会阻塞或隐藏已形成的 Robot 真实结果；
- SQLite 在 Composer 前必须取得两个 role trace 的终态，并精确核对
  `interaction/route/assignment/role/source_span`；run-id 碰撞或任何 identity/invariant 不一致直接 fail closed，
  不允许修复或组合旧 Interaction；
- 确定性 Composer 按原文顺序输出结构化 part。Human 文本采用 JSON string encoding，换行及
  U+2028/U+2029 不能伪造新的 `Robot` 标签，也不能覆盖 Robot accepted/completed/failed/unknown；
- 两个 Role Run 和独立 Composer Run 可由 `interaction_id` 在 SQLite 中还原；scheduler rejection 和
  terminal write failure 也会生成或修复为明确终态，不遗留伪完成。

## 本地验证

| 门禁 | 结果 |
|---|---:|
| Node 24.19 strict typecheck | 通过 |
| Phase 4D + SQLite targeted tests | 34/34 |
| Agent full suite | 227/227 |
| Python cross-stage contract | 66/66 |
| `git diff --check` | 通过 |

定向测试覆盖：标点/emoji UTF-16 span、gap/overlap/Cat/第三段/空白段、非法计划在 Robot 前 fail closed、
Human→Robot 与 Robot→Human 精确 slice、跨角色文本注入、partial failure、用户取消、deadline、queue
rejection、provider/audit 不合作、malformed post-dispatch attempt、unknown 不重放、Composer 存储失败、
deferred 晚到终态、run-id collision、SQLite 两 Role + Composer 还原以及单 assignment 兼容。

## Bugs review 与修复

独立 subagent 进行了多轮只读审查并动态复现反例。已关闭：全局 deadline 对不合作 provider 无界等待、
Human 伪造 Robot 标签、scheduler rejection 缺失 Role Run、Composer/Role 审计晚到与永久 running、已写入后
timeout 丢失 unknown truth、审计停滞阻塞业务、malformed attempt 绕过 dispatch latch、run-id 跨 Interaction
碰撞、read/write deadline 被误判为用户取消，以及存储失败隐藏真实 Robot 结果。最终复核确认存储 I/O
失败只降级为 `deferred`；identity、correlation、terminal status、ToolResult、clock 和安全整数不变量仍
严格 fail closed，结论为 no findings。

4D 退出门禁已关闭，可以进入 4E Security, Eval & Real Environment Gate。4D 只证明 Runtime 分割、隔离、
组合与审计语义；真实 HA/P4、凭证扫描、长跑、物理灯态和实际触摸仍必须由 4E 的独立门禁证明。
