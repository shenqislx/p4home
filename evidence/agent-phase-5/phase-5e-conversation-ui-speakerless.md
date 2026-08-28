# Phase 5E Conversation UI Speakerless Closure

日期：2026-08-28

状态：`historical_real_p4_automated_pass / current_candidate_rerun_pending / manual_checks_deferred`

分支：`feature/agent-harness`

## 结论边界

历史 commit `3edb229` 的 `phase5e_ui` run `32862092039` 已形成真实 P4 自动化证据：真实模型、HA、
STT 的 Robot 只读、一次低风险写入并恢复、Human 聊天均完成，三次 Conversation UI 投递均收到
P4 ACK，artifact 隐私审计通过，音频明确为 `deferred` 且没有打开 playback。

该 run 早于后续 Voice 产品改动，不能证明当前候选。它也不证明用户肉眼看见三轮对话框文本，更不
证明物理扬声器可听。2026-08-28 用户要求涉及人工验证的工作先延期，因此当前候选实机重跑、P4 UI
肉眼核对和扬声器可听观察继续保持 pending。

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
| UI | 三次结构化 UI ACK 均 `completed`；`ui_applied` 三次；`voice_ui_e2e=PASS` |
| 音频 | 三次均 `deferred`；未出现 playback opened |
| provider | STT 3 次、模型 6 次；未保留 raw audio |
| 稳定性 | power-on 1、reset 1、crash 0 |
| 隐私 | `artifact_audit=PASS` |

串口中的 UI 对话文字 marker 因 LVGL 重绘共出现九次，不能按 marker 行数推导业务轮数；业务 JSON
结果和三次匹配 UI ACK 才是自动化投递结论。自动 marker 只能证明 P4 UI 代码已应用更新，不能代替
用户肉眼观察。

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
- 完整默认固件构建被既有私有硬件 sdkconfig / Hosted Wi-Fi 配置保护拦截；这不是本次源码编译错误，
  也不记为完整构建通过。

Node `v24.19.0` 本地全量门禁通过：`pnpm typecheck` 通过，`pnpm test` 为 `438/438`。Python
contract 为 `100/100`，hardware harness 为 `51/51`；两个审计脚本 `py_compile` 和
`git diff --check` 通过。harness 输出仍有既有
SQLite `ResourceWarning`，但测试退出码为 0。上述结果只证明源码边界和本地回归，不把真实 P4 或
人工门禁标记为通过。

## 仍待完成

- 对当前候选提交触发 commit-bound `phase5e_ui` 真实 P4 run，按 manifest-first 顺序复核身份、flash、
  原始 `VERIFY:`、Agent/SQLite/HA 终态、隐私、reset/crash 和 playback absence（按用户要求延期）。
- 用户核对 P4 对话框三轮可见文本（人工验证，延期）。
- 连接物理扬声器后核对 startup tone 与分角色播放可听输出（人工验证，延期）。
- 完成 5E 其余 security holdout、断线/恢复和长跑总门禁；不得由历史 run 或本地测试替代。
- 仍需补齐本地分阶段指标 schema/埋点、认证与恶意 transcript/TTS 组合 holdout、Agent 进程级恢复
  以及确定性 soak；现有分层单测不能替代这些组合门禁。
- 用户最终 review 通过后才能关闭 Phase 5；Phase 6、7 已完成并归档不改变这一边界。
