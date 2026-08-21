# Phase 4C Low-risk Write & HA/P4 Convergence Evidence

日期：2026-08-21

## 当前结论

4C coding 与独立 subagent bugs review 已完成。Robot revision v4 新增 alias 级
`home.turn_on`、`home.turn_off` 与 `home.activate_scene`；当前没有读取真实 token、没有连接 Robot
专用 HA 账号，也没有对真实设备执行动作。因此本文只证明本地实现和 Fake/回环门禁，不宣称 4C
stage complete 或 Robot/P4 真实收敛通过。

## 写侧边界

- 模型只看到 alias、domain 与该 alias 可用的固定 Tool 名，不接收真实 `entity_id`、HA
  `domain/service/target`、任意 `service_data` 或 token；
- transport 在模型边界之后把 allowlist alias 确定性映射为一次固定 `call_service`：light/switch
  仅 `turn_on/turn_off`，scene 的 `activate_scene` 固定映射为 `scene.turn_on`；
- climate、sensor、binary_sensor、lock、alarm、门禁、购买、删除、温度设定和任意 Tool 名在执行层
  零发送；即使 capability 试图声明 climate write，模型只得到 read Tool；
- 相同 alias 的重复/冲突调用在发送前拒绝；多个不同 alias 按模型顺序串行，首个失败后后续调用
  以显式取消终止，不产生部分盲发。

## 结果语义

1. `role.ha.policy_decided` 必须先于 transport send；
2. send 产生唯一 request id，并记录 `role.ha.write.dispatched`；
3. HA `success=true` 只记录 accepted，不代表完成；
4. 只有匹配 alias/domain/action 的、再次通过运行期投影校验的 state observation 才记录 completed；
5. HA reject 记录 rejected；发送后的 timeout、取消、断线或缺少回刷记录 unknown；
6. unknown 的 ToolResult 固定 `replay_allowed=false`，Runtime 不自动重发，用户文本明确要求先核对状态；
7. 动作前状态已满足时不发送 service，记录确定性 completed/no-op。

timeout、断线或缺少订阅回刷后最多执行一次单 alias、只读、独立超时的 reconciliation；查询只返回
allowlist 投影，不改 transport cache。即使查询状态符合目标，也只记录 `reconciliation_matches_target=true`
作为旁证，仍保持 unknown，不伪造本次动作的因果完成。取消发生在查询前时零查询，查询进行中取消时
及时终止；审计失败重入也复用同一个 Promise，不会产生第二次查询。

## 本地验证

| 门禁 | coding done 结果 |
|---|---:|
| Node 24.19 strict typecheck | 通过 |
| Phase 4C targeted tests | 20/20；加 transport 固定映射/reconciliation 共 21 项 |
| Agent full suite | 192/192 |
| Runtime validators | Device v1、Object v2、HA v1 全部通过 |
| Python cross-stage contract / hardware helper | 58/58；4/4 |
| `git diff --check` | 通过 |
| 真实 HA/P4 convergence | 待专用账号与隔离实体 |

定向覆盖 fixed `call_service`、完成回刷、already-satisfied no-op、reject、accepted-without-observation、
发送后取消、断线、unknown 不重放、未授权实体、climate hard deny、多动作顺序/失败短路、高风险工具名
与 SQLite accepted/completed/unknown 审计还原。

## 独立 bugs review

独立 subagent 完成多轮只读 review。首轮发现并修复：旧/跨连接 state event 可误判完成、dispatch 后
response rejection 挂接过晚、attempt/response request id 缺少运行期校验、write 审计来源/顺序错误，以及
reconciliation checkbox 过度声明。第二轮发现并修复同步 dispatch-cancel 后的晚到 rejection 与
already-satisfied 快路径取消竞态。补齐 reconciliation 后继续发现并修复审计失败导致二次查询、旧 adapter
接口守卫不完整，以及查询中取消覆盖不足。最终代码复核为 no findings；证据计数同步为当前实际验证结果。

## 尚未关闭的退出门禁

- 使用 Robot 专用非管理员账号和仓库外凭证验证真实 allowlist 读写；
- 在隔离 light/switch/scene 上证明单次服务请求、HA result、物理状态和 Robot observation；
- 同时核对 P4 从 HA 订阅回刷到相同终态；
- 验证 P4 离线时 Robot HA 可用、Agent/Robot 离线时 P4 ↔ HA 与触控 UI 不受影响；
- 保存脱敏证据，并在进入 4D 前关闭真实写侧门禁。
