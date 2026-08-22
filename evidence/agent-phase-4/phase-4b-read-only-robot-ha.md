# Phase 4B Read-only Robot HA Tool Evidence

日期：2026-08-23

## 当前结论

4B coding、独立 subagent bugs review 与真实 HA allowlist 读侧门禁均已完成。Robot revision v4 只获得
`home.get_entity(alias)`；Human、Cat 与 Router 的工具边界未扩大。真实门禁使用 Robot 专用非管理员
账号和仓库外 0600 配置，通过只读 client view 读取一个 allowlist 投影，不调用 HA service、不产生
设备副作用，也不向模型或 Runtime 结果暴露 token 或真实 entity id。4B 退出门禁已关闭。

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
| 真实 HA allowlist read | 通过；专用非管理员账号、1 个 allowlist 投影、只读 Tool |

定向覆盖只读 Tool 暴露、确定性投影、审计关联、跨 Run prompt-injection 隔离、未知 alias、离线、
非法写 Tool/额外参数/thinking 与执行前取消。4A transport 回归继续覆盖 auth invalid、timeout、断线、
重连、快照竞态、状态清理与无全量 `get_states`。

## 真实 HA 读侧门禁

2026-08-23 使用 Robot 专用、非管理员且可独立撤销的 HA 账号，通过仓库外 `0600` token/policy/URL
文件连接实际 HA。产品 revision `role-profile/v4` 仅向模型暴露 `home.get_entity`，一次模型回合成功读取
一个 `switch` 投影；投影可用且 attribute key 为空。脱敏结果还逐项证明模型请求不含 entity id/token，
Runtime 结果不含 entity id。持久化结果见
[phase4b-real-read.json](./artifacts/phase4b-real-read.json)，SHA-256
`85528459cb9d93a6c6f01814662707664b98a7e0b50e0018b594b85ac72746de`。结果绑定 coding commit
`a1ac394f3ac2e9012c9bcee01b01ce874cfaf40b` 和 clean Agent tree
`b9acb68562b0d289bc32894d11fdf822f0445cc4`；实际计数为逐实体读取 1、全量状态读取 0、身份/Robot
service dispatch 均为 0、非法 outbound frame 为 0，且 Runtime 未取得写 client。

该门禁使用只读 client view，执行路径没有写方法；账号权限形状和后续真实写/恢复另由 4C/4E 的独立
门禁验证。凭证与真实 entity id 未写入本证据或持久化 JSON。

## Bugs review 与修复

独立 subagent 首轮 review、修复复核和最终复核均只读执行，最终结论为 no findings。已关闭：

1. 旧 `role-profile-v1:robot` session 升级时不再冲突或覆写历史授权快照；新 revision 使用确定性派生的
   audit session，并记录 `role.audit.session_migrated` 关联；
2. `haReadRequested` 异步审计后重新检查取消与连接状态，断线不能降格为 state missing 或读取旧缓存；
3. 非法写 Tool/额外参数使用有界、脱敏的 `role.ha.policy_rejected`，原始 arguments 不进入 SQLite；
4. capability 只读取并克隆一次，同一快照用于运行期校验与模型投影，消除 getter/proxy TOCTOU；
5. cache state 在 ToolResult、审计和最终文本前重新校验精确字段、alias/domain、状态枚举、available、
   timestamp 与 domain attribute allowlist；伪造内容只返回通用 `HA_STATE_INVALID`。
6. 真实读侧门禁补充复审关闭 exact token/entity 检查时机、身份与 Robot 帧观察隔离、Agent tree 绑定、
   socket/fetch 清理，以及 `wss://` 不得降级和关闭 Promise 必须终态的问题。

最终再次通过 Node 24.19 strict typecheck、241/241 Agent tests、Phase 4C gate 22/22、74/74 Python
cross-stage contract、9/9 hardware helper 与 `git diff --check`；subagent 最终复核为 no findings。
