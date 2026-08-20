# Phase 4 Preparation Evidence

日期：2026-08-20

## 当前结论

Phase 4 启动准备完成，功能实现尚未开始。当前工作入口为 4A Robot HA Contract & Credential
Boundary；Robot RoleProfile 仍没有 HA Tool，本轮没有创建或读取真实 HA token、没有连接 Robot HA
WebSocket，也没有执行真实家居动作。

## 前置状态

- Phase 3 最终实机 run `32382940058` 已通过 artifact-first 判定并经用户最终 review；
- Phase 3 计划已归档，计划索引中不存在第二个 `in_progress` Phase；
- 本地分支已快进到云端 `origin/feature/agent-harness` 后再提交 Phase 3 收尾，避免把云端既有提交
  重复带入 Phase 4；
- Phase 4 继续工作在 `feature/agent-harness`，不会提前合入 `main`。

## 代码入口盘点

| 当前入口 | 已有行为 | Phase 4 影响 |
|---|---|---|
| `role-contracts.ts` | RoutePlan v1 恰好一个 full-span assignment | 4D 新增显式版本，不能原地放宽 v1 |
| `role-router.ts` | Human/Robot/clarify 单标签，非法输出 fail closed 到 Human | 4A–4C 保持不变，4D 才引入 span 输出 |
| `role-profiles.ts` | Robot 无 Tool；Human 无 Tool；Cat 只拥有 P4 World Tool | 4B 新增 Robot revision，不能改写其他角色权限 |
| `role-runner.ts` | Robot 返回 Phase 4 unavailable；Human 只做文本 | 4B 后接入 Robot 专用 Tool Loop，仍保持会话隔离 |
| `role-orchestrator.ts` | 单 assignment 的路由、调度与 Session 组合入口 | 4D 扩为最多两个独立 Run，再交给 Composer |
| `role-audit.ts` / SQLite | 可关联 interaction、route plan、assignment、role 与 run | 4B 增加 HA request/state 观察；4D 增加组合结果关联 |
| Core Tool Loop | schema 后顺序执行、timeout/cancel、有限调用 | 可复用生命周期，但 HA 写侧 unknown 不能降格为普通失败 |
| P4 `ha_client` | 已验证 auth、request id、订阅、allowlist read 与 call_service | 只复用协议经验；Robot 使用独立 Agent 侧实现和凭证 |

## 启动决策

1. Phase 4 拆成 4A 契约/凭证、4B 读侧、4C 低风险写侧、4D 多角色分割、4E 真实环境总门禁；
2. 多角色路由晚于真实 Robot 写侧，避免同时调试权限、副作用和语义分割；
3. Robot 模型使用稳定 alias，不直接选择任意 HA entity/service/data；真实 entity id 只在本地 policy
   映射中出现；
4. 凭证采用仓库外 token file，Robot 与 P4 账号/token 分离；任何 token 进入模型、日志、SQLite、
   Git 或 artifact 都是阻断项；
5. HA result 与后续 state change 分开记录；timeout/断线/取消后不重放写请求，无法确认时保留 unknown；
6. 首批写侧只允许显式 allowlist 的低风险 `turn_on/turn_off/activate_scene`，锁、安防、门禁、购买、
   删除、任意 service/data 和温度设定在 Phase 4 硬拒绝；
7. RoutePlan v1 保持冻结；4D 使用显式新版本，最多 Human + Robot 两个连续、无重叠、全文覆盖的
   UTF-16 span；非法分割在任何 Robot Run 创建前整体 fail closed；
8. Phase 4 最终 review 只授权归档本 Phase，不自动开始 Phase 5。

## 准备验证

Phase 3 收尾提交前已复跑：

- Node 24.19 strict typecheck：通过；
- Agent tests：141/141 通过；
- Python contract：58/58 通过；
- World Service C host：2/2 通过；
- `git diff --check`：通过。

Phase 4 准备提交只修改计划、状态和本证据，不包含运行时代码。提交前还需执行 Markdown 链接、
旧状态引用和 `git diff --check` 门禁。

## 4A 开始前的外部前置项

- 创建 Robot 专用、可独立撤销的非管理员 HA 账号与 long-lived token；
- 选定一个读侧实体集合和至少一个可隔离恢复的低风险写侧实体；
- 在仓库外准备权限收紧的 token file 与真实 policy file；仓库只提交脱敏示例；
- 记录 HA URL/TLS 方式与测试回滚方法，但不得把 token 写入文档、命令行或 artifact。

这些外部项尚未执行；在 4A 本地 fake contract 成形前也不需要执行。
