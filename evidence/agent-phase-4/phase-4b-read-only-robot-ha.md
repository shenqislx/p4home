# Phase 4B Read-only Robot HA Tool Evidence

日期：2026-08-21

## 当前结论

4B coding 与独立 subagent bugs review 已完成，review 最终无未关闭 finding。Robot revision v3 只获得
`home.get_entity(alias)`；Human、Cat 与 Router 的工具边界未扩大。当前实现和本地门禁不读取真实
token、不调用 HA service、不产生设备副作用。Robot 专用非管理员账号的真实 HA allowlist 读侧仍待
验证，因此本文不宣称 4B 退出门禁已完成。

## 只读执行边界

- 模型只看到当前 assignment 与 `{alias, domain, readable}`，看不到真实 `entity_id`、写动作、HA
  token、状态值、attributes 或事件文本；
- Runtime 只接受精确的 `home.get_entity({alias})`，最多四个不重复 alias；未知 alias、额外参数、
  写 Tool、thinking 或非法调用均 fail closed；
- 状态来自 4A transport 已投影且有界的 allowlist cache，不发起全量 `get_states`，也不调用
  `call_service`；
- ToolResult 和用户可见文本由 Runtime 确定性生成，不把 HA observation 送入第二次模型调用；
- Robot HA 结果不进入 RoleSession history，避免不可信状态或 attributes 在后续 Run 中重新进入模型；
- HA 不处于 `ready` 时不调用模型；若模型输出后连接断开，则显式返回 `HA_OFFLINE`，不会把旧缓存
  声称为当前状态。

## 审计关联

同一 `run_id/tool_call_id` 下记录 `role.model.requested`、`role.model.completed`、
`role.tool.requested`、`role.ha.policy_decided`、`role.ha.read.requested`、
`role.ha.observation` 或 `role.tool.failed` 与 Run 终态。缓存读取显式标记
`request_kind/observation_source=allowlisted_cache`，不伪装成新的网络请求。SQLite trace 不包含
`entity_id`、token 或 Robot 不可见的写能力。

## 本地验证

| 门禁 | coding done 结果 |
|---|---:|
| Node 24.19 strict typecheck | 通过 |
| Phase 4B targeted tests | 13/13 |
| 受影响 Role Runtime tests | 14/14 |
| Agent full suite | 171/171 |
| Runtime validators | Device v1、Object v2、HA v1 全部通过 |
| Python cross-stage contract / hardware helper | 58/58；4/4 |
| 真实 HA allowlist read | 待专用账号与仓库外凭证 |

定向覆盖只读 Tool 暴露、确定性投影、审计关联、跨 Run prompt-injection 隔离、未知 alias、离线、
非法写 Tool/额外参数/thinking 与执行前取消。4A transport 回归继续覆盖 auth invalid、timeout、断线、
重连、快照竞态、状态清理与无全量 `get_states`。

## 尚未关闭的退出门禁

使用 Robot 专用、非管理员且可独立撤销的 HA 账号，通过仓库外 `0600` token file 与真实 policy file
连接实际 HA；核对只逐实体读取 allowlist、账号不能访问或控制未授权实体、日志/SQLite/Git 无凭证，
并保存脱敏证据。在完成这项验证前，4B 只能称为 coding done，不能称为 stage complete。

## Bugs review 与修复

独立 subagent 首轮 review、修复复核和最终复核均只读执行，最终结论为 no findings。已关闭：

1. 旧 `role-profile-v1:robot` session 升级时不再冲突或覆写历史授权快照；新 revision 使用确定性派生的
   audit session，并记录 `role.audit.session_migrated` 关联；
2. `haReadRequested` 异步审计后重新检查取消与连接状态，断线不能降格为 state missing 或读取旧缓存；
3. 非法写 Tool/额外参数使用有界、脱敏的 `role.ha.policy_rejected`，原始 arguments 不进入 SQLite；
4. capability 只读取并克隆一次，同一快照用于运行期校验与模型投影，消除 getter/proxy TOCTOU；
5. cache state 在 ToolResult、审计和最终文本前重新校验精确字段、alias/domain、状态枚举、available、
   timestamp 与 domain attribute allowlist；伪造内容只返回通用 `HA_STATE_INVALID`。

修复后再次通过 Node 24.19 strict typecheck、171/171 Agent tests、三套 Runtime validator、58/58 Python
cross-stage contract、4/4 hardware helper 与 `git diff --check`。真实 HA 风险仍按上节保留。
