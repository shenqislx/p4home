# Phase 4C Low-risk Write & HA/P4 Convergence Evidence

日期：2026-08-21

## 当前结论

4C 已完成 coding、独立 subagent bugs review 与真实 HA/P4 门禁。Robot revision v4 只暴露 alias 级
`home.turn_on`、`home.turn_off` 与 `home.activate_scene`；真实 run `32454798244` 使用仓库外专用
非管理员 Robot 凭证，在 P4 应用离线和在线订阅两种情况下分别完成一次隔离低风险实体的切换与恢复。
两次动作均由 HA accepted、因果 state observation 和最终独立读取共同证明，终态恢复为 `off`。

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
| Agent full suite | 206/206 |
| Runtime validators | Device v1、Object v2、HA v1 全部通过 |
| Python cross-stage contract / hardware helper | 66/66 |
| Phase 4C 私有配置固件构建 | 通过；app `0x169fa0`，最小 app 分区剩余 53% |
| `git diff --check` | 通过 |
| 真实 HA/P4 convergence | run `32454798244` 通过 |

定向覆盖 fixed `call_service`、完成回刷、already-satisfied no-op、reject、accepted-without-observation、
发送后取消、断线、unknown 不重放、未授权实体、climate hard deny、多动作顺序/失败短路、高风险工具名
与 SQLite accepted/completed/unknown 审计还原。

## 独立 bugs review

独立 subagent 完成多轮只读 review。首轮发现并修复：旧/跨连接 state event 可误判完成、dispatch 后
response rejection 挂接过晚、attempt/response request id 缺少运行期校验、write 审计来源/顺序错误，以及
reconciliation checkbox 过度声明。第二轮发现并修复同步 dispatch-cancel 后的晚到 rejection 与
already-satisfied 快路径取消竞态。补齐 reconciliation 后继续发现并修复审计失败导致二次查询、旧 adapter
接口守卫不完整，以及查询中取消覆盖不足。

真实硬件首轮进一步暴露并修复 macOS launchd Runner 的局域网访问边界、身份 WebSocket close 生命周期、
恢复写 unknown/回弹计数，以及 P4 HA 初始状态突发从非 LVGL 任务直接调用 `lv_async_call()` 导致的 TLSF
free-list 损坏。最终固件统一在 BSP display recursive mutex 下投递 UI 回调，订阅成功后才拉白名单 REST
快照，订阅 reject/timeout fail closed；控制卡片使用原子引用计数和预分配 task payload，关闭晚到结果 UAF
与低内存 pending 卡死。最终独立复核为 no findings。

## 真实硬件证据

- workflow：[run 32454798244](https://github.com/shenqislx/p4home/actions/runs/32454798244)，commit
  `9fe3ab68e05fda4ebd1ee35547736ca7f90504e2`，profile `phase4c_ha`，串口
  `/dev/cu.usbserial-210`，连续采集 480 秒；
- manifest SHA-256：`5b57207e8045f9280053eb4bbbee3e067940d6edf27e11581528274bee18cff8`；
  monitor SHA-256：`25d631225ccab95ed3d4353fb71fa137455ecfb155c2a2d38c46d4e39485e3fa`；
- manifest 同时确认 Robot 非管理员、policy 仅 1 个 alias、P4 Agent transport disabled、policy/固件目标
  binding verified、串口实体标识已脱敏；离线与在线 gate 均 `passed=true`，恢复 attempts=1，终态 `off`；
- monitor artifact 包含采集后追加的两组 Robot harness `robot_identity/write/restore:PASS`；其中真正的
  固件串口部分包含 4 条 P4 目标状态 `on/off/on/off` 回刷、持续 `p4_standalone:PASS` 和 54 条
  `ui:8fps:PASS`。敏感 token/header、原始实体样式与 task watchdog/Guru Meditation 扫描均为零；
- 冷启动 36 个白名单状态集中回刷时出现 1 条启动期 `ui:8fps:FAIL interval_ms=10060`，随后恢复且
  Robot 关闭后的专用 suffix gate 持续通过。它不否定 4C 的 post-Robot 稳态门禁，但保留给 4E
  长跑/冷启动性能回归继续观察，不据此宣称 Agent disabled 的全启动过程从无瞬时抖动。

据此，4C 的自动化真实 HA/P4 收敛与 post-Robot 稳态门禁关闭，可以开始 4D；本 run 没有摄像/人工
物理灯态观察，也没有实际触摸输入，二者已明确保留在 4E 最终环境门禁，Phase 4 整体仍未完成。
