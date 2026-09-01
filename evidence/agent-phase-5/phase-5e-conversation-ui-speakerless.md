# Phase 5E Conversation UI Speakerless Closure

日期：2026-08-31

状态：`current_candidate_real_p4_and_ui_manual_pass / role_playback_fix_pending`

分支：`feature/agent-harness`

本轮实现起点：`d7ff617`；最终候选身份以本记录对应的 Git 提交为准。

## 结论边界

当前 commit `85b55ec9d282218baed14d685ddd5dc2d505562b` 的 `phase5e_ui` run
`33452154578` 已形成真实 P4 自动化证据：真实模型、HA、STT 的 Robot 只读、一次低风险写入并恢复、
Human 聊天均完成，三次终态 `ui_delivery` 均为 `completed`；monitor 共记录六次 `ui_applied` ACK，
即每轮 thinking/revision1 与 completed/revision2 各一次，其中三次 revision2 为业务终态 ACK。
artifact 隐私审计通过，音频明确为 `deferred` 且没有打开 playback。用户随后现场确认三轮屏幕均从
处理中更新到最终内容，人工目视门禁 PASS。该 run 替代 `33345080880` 作为当前候选自动化证据；
后者仍保留为历史成功记录。

自动化 run 本身不证明用户肉眼看见三轮对话框文本；本轮由用户另行完成目视确认。它也不证明物理
扬声器可听。修复后的雨动画已由同一
LVGL/RGB565 host renderer 生成 48 帧循环预览，并于 2026-08-31 获用户肉眼确认通过；该结论是渲染
观感验收，不冒充 P4 面板摄像证据。后续 `phase5e_e2e` run `33456284948` 曾完成功能播放但
artifact 审计失败且响应偏慢；低延迟提交 `e004870` 的 run `33460199737` artifact 审计通过，
但 terminal credit 引发重连并取消 STT；首次修复提交 `8b96022` 的 run `33461779715` 确认
实际触发窗口为 `WAITING_CLOSE`，完整实体播放仍未形成新闭环，因此 Phase 5 继续为
`pending_real_environment`。

## 已实现闭环

1. Voice final transcript 继续进入既有统一 Router/Orchestrator；Human、Robot、HA 与 Memory 边界不变。
2. Conversation UI Protocol v1 以 session/stream/epoch/revision 做严格身份与过期 fencing；只承载
   有界 final transcript、Composer 结果、role 和 execution status，不写入 World/Cat speech。
3. P4 Home 页接受更新、切回 Home、更新既有对话框，并在 LVGL 已应用后异步回送 `ui.applied`；
   Agent 只有收到匹配 ACK 才记录 `ui_delivery=completed`。
4. Role/HA、UI 和音频投递分别记录，互不伪造。无扬声器 profile 固定
   `ui_output=required`、`audio_output=disabled`，所以成功结果为 `audio_delivery=deferred`。
5. `phase5e_ui` profile 依次验证 Robot 只读、低风险写入并恢复、Human 聊天，要求三次 P4 UI
   render/ACK、禁止 playback opened，并对上传候选执行凭据和原始音频审计。

## 历史真实 P4 自动化证据

| 项目 | 结果 |
|---|---|
| workflow run | `32862092039` |
| commit / profile | `3edb229` / `phase5e_ui` |
| 串口 | `/dev/cu.usbserial-210` |
| monitor / capture | `900 s` / `1080 s` |
| manifest | `passed=true`，`agent_harness_status=0` |
| 业务路径 | read、write、chat 均 `completed`，write 已恢复 |
| UI | 三次终态 `ui_delivery=completed`；E2E 汇总按三轮业务记 `ui_applied=3`；`voice_ui_e2e=PASS` |
| 音频 | 三次均 `deferred`；未出现 playback opened |
| provider | STT 3 次、模型 6 次；未保留 raw audio |
| 稳定性 | power-on 1、reset 1、crash 0 |
| 隐私 | `artifact_audit=PASS` |

串口中的 UI 对话文字 marker 因 LVGL 重绘共出现九次，不能按 marker 行数推导业务轮数；业务 JSON
的三次终态 `ui_delivery=completed` 与匹配的 `ui_applied` ACK 才共同构成自动化投递结论。自动 marker
只能证明 P4 UI 代码已应用更新，不能代替用户肉眼观察。

## 2026-08-28 当前候选本地修复与 review

- 把 HA 初始同步 readiness 从 `voice_transport` 对 `ha_client` 的具体依赖，改为由组合根
  `board_support` 注入通用 readiness probe；未注入、未就绪和非法生命周期均 fail-closed。
- 保持既有产品语义：HA 尚未 ready 时显示连接提示，不开始 capture、STT、LLM 或固定命令窗口；
  capture 前再次检查 readiness，避免状态变化竞态。
- Phase 5A 的源码契约测试改为对换行/空白不敏感，同时继续验证确切函数、状态、原因和调用顺序。
- 独立源码 review 未发现阻塞问题，并强化 probe 缺失/false、非法设置时机、wake prompt 分支和二次
  suppress 检查。变更 C 对象在 ESP-IDF 5.5.4 下编译通过。
- 修复 STT Python provider 在 `spawn_process` 内发生 abort 时可能丢失取消信号的竞态；注册 listener
  后立即二次检查，并以真实慢 worker 验证 timeout/kill 后同一 provider 的下一次请求仍健康。
- Phase 5E artifact 审计现在复用 Git objects 和 process argv 敏感扫描，覆盖 device/HA token 与 Agent
  TLS 私钥；secret、result 和 artifact 均拒绝 symlink/非常规文件，secret 仅允许 `0400/0600`。
  workflow 在 manifest 生成后、上传前执行最终只读审计，覆盖 `monitor.log` 与 manifest；审计失败不上传。
- 复审进一步关闭 TLS 私钥遗漏、artifact symlink 绕过和 Git scanner timeout 子进程/管道泄漏三项问题。
- `VoiceInteractionResult` 与 Phase 5E artifact 升级到 schema v2，固定 STT、Router、Human、Robot、
  Composer、TTS、UI、playback transport 及 P4 wake/VAD/physical playback 共 11 个阶段。Agent 可测
  duration、角色/UI/播放状态及 drop/cancel 与真实业务结果交叉核验；P4 三项固定
  `hardware_pending/null`，不得以本机计时冒充硬件证据。
- 对抗性 holdout 覆盖 bad/unknown/cross-device token、错误 scheme、重复或畸形认证/设备 header，
  攻击后合法连接仍健康；超长、控制字符和伪造 tool-call transcript 不进入 Robot/Cat/工具执行，
  UI 仍只有有界呈现且下一轮恢复。TTS 保留长度/trim/control 门禁；合法 JSON 文本可安全朗读，避免
  把内容形态误判为协议注入。
- 真实 Node 子进程门禁在 active capture 时执行 SIGKILL，确认旧 socket 关闭、同端口新进程重新监听
  并完成下一轮 EOS 会话；SIGTERM 后 connection/playback/UI pending 清零并自然退出。
- 隔离子进程完成 1000-session deterministic soak，覆盖 provider offline、cancel、真实 timeout、
  non-cooperative hang/supersede/abort 后健康恢复；results/maps/listeners/open handles 有界，914 个
  provider PCM 引用全部归零，实测 event-loop 最大 lag 3 ms、heap 增长约 4.9 MiB。
- 交叉 review 修复 Router fallback 被指标误报为 `completed` 的问题；gate 现在要求真实 routing
  accepted 且无 fallback，不能用伪造 metrics 通过。
- 完整默认固件构建被既有私有硬件 sdkconfig / Hosted Wi-Fi 配置保护拦截；这不是本次源码编译错误，
  也不记为完整构建通过。

Node `v24.19.0` 本地全量门禁通过：`pnpm typecheck` 通过，默认并发 `pnpm test` 为 `444/444`。Python
contract 为 `109/109`，hardware harness 为 `63/63`；两个审计脚本 `py_compile` 和
`git diff --check` 通过。harness 输出仍有既有
SQLite `ResourceWarning`，但测试退出码为 0。上述结果只证明源码边界和本地回归，不把真实 P4 或
人工门禁标记为通过。

## 2026-08-31 当前候选真实 P4 自动化证据

在用户重新插拔 `/dev/cu.usbserial-210` 后，当前候选完成了 commit-bound 实机重跑。最终有效 run
如下；前序诊断 run 只用于说明修复过程，不作为通过证据。

| 项目 | 结果 |
|---|---|
| workflow run / attempt | `33345080880` / `1`，workflow 成功 |
| commit / profile | `c9acbf872e931bd3a9f719622a1b6c9dac78ff0f` / `phase5e_ui` |
| 芯片 / 串口 | ESP32-P4 revision v1.0 / `/dev/cu.usbserial-210` |
| monitor / capture | `900 s` / `1080 s` |
| transport | `completed`，exit `0` |
| app image | `3009792` bytes；SHA-256 `a2192b1307eb163a44c98577e97314a990411f19a459ade81ffe8ad0fbef5241` |
| manifest | schema `1`，`mode=artifact-only`，`verdict_owner=cloud-codex` |
| 业务结果 | result schema `2`，`passed=true`；read/write/chat 均通过，write 已恢复 |
| provider | STT `3` 次，mismatch 和其他 provider failure 均为 `0`；模型 `6` 次 |
| UI / 音频 | 三次 `ui_delivery=completed`；三次 `audio_delivery=deferred` |
| 审计 / 稳定性 | audit events `21`；power-on `1`、reset `1`、crash `0`；raw audio 未保留 |
| artifact | 最终审计 `pass`；input driver status `0`；Agent harness status `0` |

manifest-first 复核后，原始串口中的关键证据如下。为保持节选紧凑，下面只列三条 revision2 终态
ACK；另有三条对应的 revision1 thinking ACK，完整 monitor 合计六条 `ui_applied`：

```text
Chip is ESP32-P4 (revision v1.0)
VERIFY:ha:initial_sync_ready:PASS
VERIFY:phase5e:ui_conversation:PASS epoch=7864321 revision=2 stage=completed role=robot execution=completed
VERIFY:phase5e:ui_applied:PASS epoch=7864321 revision=2
VERIFY:phase5e:ui_conversation:PASS epoch=7864322 revision=2 stage=completed role=robot execution=completed
VERIFY:phase5e:ui_applied:PASS epoch=7864322 revision=2
VERIFY:phase5e:ui_conversation:PASS epoch=7864323 revision=2 stage=completed role=human execution=not_applicable
VERIFY:phase5e:ui_applied:PASS epoch=7864323 revision=2
VERIFY:phase5e:voice_ui_e2e:PASS interactions=3 stt_calls=3 model_calls=6 ui_applied=3 audio=deferred audit=persisted restored=yes raw_audio_retained=false
VERIFY:phase5e:artifact_audit:PASS secrets=absent audio_payload=absent source=clean source_mode=archive process_argv=clean
```

下载后的 `monitor.log` SHA-256 为
`fa64a510c4d89663bb7891a8eaaa928d52c6df39a559c24fa8ce009b65355941`，manifest SHA-256 为
`02e05e1d4eb7acd1a543d34920337a9ba6bee28bff63868e90479c6425e30e82`。

三次业务交互高负载窗口各出现一条 `VERIFY:ui:8fps:FAIL`，其后均恢复；整个 artifact 共记录 123 条
`PASS`，且没有 panic、Guru Meditation、额外 reset 或 crash。该瞬态单独披露，不表述为全程无抖动。
P4 wake、VAD 和实体播放三项在 result 中仍严格保持 `hardware_pending/null`；本次 speakerless input
driver 自动化不能替代真人唤醒时序或物理播放证明。

前序 run `33313056968`（串口/端口环境失败）、`33316568299`（写路径终态等待超时）和
`33318941758`（业务完成但旧 result schema 无法归因额外 STT 调用）均未被接受为通过。修复后的
schema 对 mismatch、固定 provider failure code 和 expected kind 做严格守恒；未知类别仍 fail-closed。

run `33343736267`（commit `87aa79e`）在第一轮读完成后因进度快照竞态被输入驱动误判并取消，
不作为通过证据。根因是 coordinator 结果可能早于 pipeline 终态可见，旧实现分别读取两者并发布了
撕裂快照。commit `c9acbf8` 改为从同一个 settled pipeline snapshot 原子计算完成数与尝试数，并在
三轮进度达成后继续等待输入驱动显式 status `0`。独立源码 review 先发现“第三轮进度后提前退出”
blocker，修复后复核为 no blocker；本地 Agent 444/444、harness 64/64、contract 110/110、目标测试
4/4 均通过。新 run 的 `progress.json` 为 `completed_interactions=3 / capture_attempts=3`，输入驱动和
harness 状态均为 `0`，从真实 P4 路径闭合了该竞态修复。

## 2026-09-01 当前候选自动化与人工 UI 证据

commit `85b55ec9d282218baed14d685ddd5dc2d505562b` 的 `phase5e_ui` run `33452154578`
以 `/dev/cu.usbserial-210` 完成 900 秒 monitor / 1080 秒 capture，workflow、transport、input driver
和 Agent harness 状态均为 `0/success`。app 为 `3009792` bytes，SHA-256
`8c21350984d0c248016fea0008f5c4c9c0967f084899109d9c4e8125bf8facd4`。result schema v2 判定
read/write/restore/chat 均通过，三次终态 `ui_delivery=completed`，六次 monitor `ui_applied` 覆盖每轮
thinking/completed；音频三次均为 `deferred`。STT 共调用 5 次、模型 6 次、audit events 21，原始音频
未保留，artifact audit `pass`。

用户在正式观察窗口确认三轮屏幕均从处理中更新到最终内容。该结论与自动 ACK 分开记录。串口出现
5 次瞬时 UI 8 FPS FAIL，随后累计 119 次 PASS；启动时 SNTP 首次等待超时，但后续在同一 artifact
恢复为 `VERIFY:time:sync_acquired:PASS`，且无 panic、Guru Meditation、额外 reset 或 crash。

artifact SHA-256：`monitor.log`
`a916e2256e6d5be7a05768f8950fb74b3f552f168e95d32b6f6102b56231d781`；manifest
`86087b543ec34a27e4dc6112f22bd03f19768512e2921df45cd3041012505a85`。

## 仍待完成

- [x] 用户已在 run `33452154578` 的自动三轮输入期间核对 P4 对话框，确认每轮均从处理中更新到
  最终内容；三次终态 delivery、六次 applied ACK 和人工目视分层成立。
- [x] 修复后的下雨动画由同一 LVGL/RGB565 host renderer 生成 48 个连续雨态帧；用户于
  2026-08-31 确认已形成连续降雨观感，不再表现为上下两处闪烁。该项不外推为 P4 面板摄像证明。
- [x] 外接扬声器连接 `SPK/J16` 后，用户已在 `phase5a_voice` run `33454508895` 的唯一开机周期明确
  听到 startup tone；串口 marker 与人工听觉分开成立。
- [ ] 后续 `phase5e_e2e` run `33456284948` 的 audio driver/harness 均为 `0`，四轮业务结果通过，
  用户确认前两轮可听、第三轮成功打断、第四轮完整播放。但该 run 的旧 artifact schema
  不支持 `stt_calls=8 / capture_attempts=9` 的合法有界重试，manifest 明确记录 audit `fail`；
  用户同时反馈语音响应明显偏慢，首轮约 `40.6 s`、热态约 `8.47 s`。当前候选修复已加入
  重试分类守恒、ready 前顺序预热和语音后 `800 ms` 静音提前收口，并经独立 review。
  `e004870` 的 run `33460199737` 已使 artifact audit 通过且三次 VAD 提前收口生效，但正常 EOS 后
  terminal credit 被误判触发重连，三次 STT 均 cancelled、无 playback。首次修复提交 `8b96022`
  的 run `33461779715` 再次失败，确认 credit 是在 `WAITING_CLOSE` 到达。覆盖 WAITING_CLOSE/刚
  关闭 IDLE 的策略已完成独立 review 和原生 C 状态矩阵，仍需新 commit 实机复验业务闭环、响应
  延迟和长句停顿不截断。
- 真实 P4 网络丢失、HA 服务重启与状态对账、真实 launchd KeepAlive/P4 感知 Agent 重连，以及
  P4/HA/Agent 长跑中的固定命令、触摸、P4 ↔ HA、Cat、heap/stack/watchdog/UI 连续性（延期）。
- artifact 中 Agent duration 由运行方进程计时；schema 能验证范围、状态和内部一致性，但不能提供独立
  可信时间源。P4 wake/VAD/physical playback 仍须由针对这些阶段的实机路径补证。
- 用户最终 review 通过后才能关闭 Phase 5；Phase 6、7 已完成并归档不改变这一边界。

本次自动化、人工观察和失败边界的完整记录见
[Phase 5 Manual Hardware Validation — 2026-09-01](./phase-5-manual-hardware-validation-2026-09-01.md)。
