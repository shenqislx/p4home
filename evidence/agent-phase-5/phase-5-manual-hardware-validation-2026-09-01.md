# Phase 5 Manual Hardware Validation — 2026-09-01

日期：2026-09-01

状态：`ui_manual_pass / startup_tone_manual_pass / role_playback_manual_pass / latency_pending`

分支：`feature/agent-harness`

提交：`85b55ec9d282218baed14d685ddd5dc2d505562b` / `d39b69b97e34511e73ea512aaaeac49814bc8e88` / `e004870f0810e1d9e31f9148bf4fac5f177d6d3e` / `8b96022145283dce76917a11f48b56ef8707e7a2` / `cbd0f39cd484673d02ecfd75d9a4012c0ff5b2fd`

## 结论

本轮把自动化、原始串口和人工观察分层记录：

- P4 对话框三轮可见更新已经由用户肉眼确认通过；
- 外接在 `SPK/J16` 的扬声器已由用户明确听到 Phase 5A 开机提示音；
- 修复后的 `phase5e_e2e` 已完成四次交互，用户确认前两次回复可听、第三次被新唤醒打断、
  第四次完整播放；但该 run 因 artifact result schema 未表达合法重试而 fail-closed，且用户明确反馈
  语音响应明显偏慢，因此 Phase 5 仍保持 `pending_real_environment`；
- 低延迟和审计修复提交 `e004870` 的 run `33460199737` 已使 artifact 审计通过并观察到 VAD
  `vad_silence` 提前收口，但三次 read STT 均被迟到 credit 引发的重连取消，业务结果失败；本轮
  没有播放，不能请求或记录人工听觉通过；
- 首次迟到 credit 修复提交 `8b96022` 的 run `33461779715` 再次以相同时序失败，证明只覆盖关闭后
  IDLE 不足；pre-EOS credit 实际在 `WAITING_CLOSE` 窗口触发异步重连。补充修复已通过独立 review
  和原生 C 状态矩阵；提交 `cbd0f39` 的 run `33463393866` 已自动化实机通过，当前只剩响应体感
  和长停顿句人工确认；
- `phase5e_e2e` profile 不启用 Conversation UI 输出。该 run 中屏幕未更新不能判为 Conversation UI
  回归；UI 由独立 `phase5e_ui` run 和用户肉眼观察判定。

## 1. 分角色播放与 barge-in：部分通过，完整闭环失败

| 项目 | 结果 |
|---|---|
| workflow run / attempt | `33450564511` / `1`，workflow `success` |
| profile | `phase5e_e2e` |
| 串口 | `/dev/cu.usbserial-210` |
| transport | `completed`，exit `0` |
| app image | `3009792` bytes；SHA-256 `3b3a240a59ed91d0a638b1086d3ca1a2d8dbaa37f31d3849f5197c544ac534ff` |
| manifest | power-on `1`、reset `1`、crash `0`；artifact audit `pass` |
| 驱动 / harness | audio driver status `1`；Agent harness status `1` |
| 原始串口 | capture opened `7`、playback opened `3`、playback cancelled `1` |
| 业务终态 | `VERIFY:phase5e:voice_e2e:FAIL reason=voice_e2e_result_timeout` |
| UI | `ui_conversation=0`、`ui_applied=0`，符合该 profile 未启用 Conversation UI 的边界 |
| 稳定性 | UI 8 FPS FAIL `4`、PASS `84`；无 crash |

人工观察：

1. 第一次观察到 P4 外接扬声器有回复，响应延迟约数秒；
2. 第三次观察到旧回复被新唤醒打断，barge-in 的物理听觉结果为 PASS；
3. 第五次没有声音，屏幕停留在“正在识别”；结合驱动/harness 非零状态与最终 timeout，不能把完整
   多轮实体播放判为通过。

artifact SHA-256：

- `monitor.log`：`58d3b4ac1e78ca4a6c010c502600c9e64207d616dd9db0a8b39b569cfc1ea28e`
- `hardware-validation-manifest.json`：
  `4bc38291a24c9321702b3f9018a8af4c5ab79685c456051e6402a30f53a65822`

workflow 成功只证明构建、刷写、采集和上传链完成。本小节的功能结论仍为失败，源码根因和修复必须
单独 review、测试并从新 commit 重跑，不能用 UI 或 startup tone 的通过结果抵消。

## 2. Conversation UI：自动化与人工观察均通过

| 项目 | 结果 |
|---|---|
| workflow run / attempt | `33452154578` / `1`，workflow `success` |
| profile | `phase5e_ui` |
| 串口 | `/dev/cu.usbserial-210` |
| monitor / capture | `900 s` / `1080 s` |
| transport | `completed`，exit `0` |
| app image | `3009792` bytes；SHA-256 `8c21350984d0c248016fea0008f5c4c9c0967f084899109d9c4e8125bf8facd4` |
| manifest | result `passed=true`；driver `0`；harness `0`；artifact audit `pass` |
| 业务 | read、write/restore、chat 均完成；STT `5` 次、模型 `6` 次、audit events `21` |
| UI | 三次终态 `ui_delivery=completed`；六次 `ui_applied`，每轮 thinking/completed 各一次 |
| 音频 | 三次均 `deferred`，符合 speakerless profile |
| 稳定性 | power-on `1`、reset `1`、crash `0`；UI 8 FPS FAIL `5`、PASS `119` |

人工观察在自动三轮输入期间完成，用户确认三轮屏幕均从处理中更新到最终内容。该肉眼结论与三次终态
delivery、六次 applied ACK 分开成立。启动时 SNTP 首次等待超时，但在同一 artifact 后续出现
`VERIFY:time:sync_acquired:PASS`，没有形成持续失败。

原始关键终态：

```text
VERIFY:phase5e:voice_ui_e2e:PASS interactions=3 stt_calls=5 model_calls=6 ui_applied=3 audio=deferred audit=persisted restored=yes raw_audio_retained=false
VERIFY:phase5e:artifact_audit:PASS secrets=absent audio_payload=absent source=clean source_mode=archive process_argv=clean
```

artifact SHA-256：

- `monitor.log`：`a916e2256e6d5be7a05768f8950fb74b3f552f168e95d32b6f6102b56231d781`
- `hardware-validation-manifest.json`：
  `86087b543ec34a27e4dc6112f22bd03f19768512e2921df45cd3041012505a85`

## 3. Phase 5A startup tone：自动化与人工听觉均通过

| 项目 | 结果 |
|---|---|
| workflow run / attempt | `33454508895` / `1`，workflow `success` |
| profile | `phase5a_voice` |
| 串口 | `/dev/cu.usbserial-210` |
| monitor / capture | `180 s` / `180 s` |
| transport | `completed`，exit `0` |
| app image | `3008864` bytes；SHA-256 `b43b91b9a54a9d0afd6648bb22f3cb97c350eaf26366bda6169970a701ef61aa` |
| manifest | main stack `12288`；Phase 5A/SR/audio selftest enabled；Agent transport disabled |
| 稳定性 | power-on `1`、reset `1`、crash `0`；UI 8 FPS FAIL `1`、PASS `19` |

同一个唯一开机周期内，原始串口确认：

```text
VERIFY:audio:speaker:PASS
VERIFY:audio:tone_played:PASS
VERIFY:phase5a:profile:PASS
VERIFY:phase5a:pcm_contract:PASS
```

外接扬声器已接到 `SPK/J16` 两端，用户在有效监听窗口明确回复“听到”。因此 startup tone 同时具备
数字/codec 路径证据和人工物理听觉证据；两者不互相替代。

artifact SHA-256：

- `monitor.log`：`298fcb1cd0ead6c01546a47599515631f25be4b681c894585003dfae5a5e46a7`
- `hardware-validation-manifest.json`：
  `e5e11a02e603b4be39848e99eed2f71cec15067f2dd6af07cac404cfb576f1fa`

## 4. E2E timeout 源码修复与独立 review

针对 run `33450564511`，artifact 只能证明失败发生在 STT/Role 前置终态阶段，旧证据没有持久化足够
子类型，不能把四次后续失败全部断言为 transcript mismatch。源码 review 同时确认第二层 harness
缺陷：驱动对已落定失败仍等待完整 timeout，且 harness 不读取 audio-driver 状态，最终把具体失败
掩盖成 720 秒总超时。

本记录对应的修复候选：

- E2E 进度只从同一份 settled pipeline `dispatched` 结果计算，并与 audio-driver 原子状态文件握手；
- audio driver status `1` 立即失败，不再等待总超时；status 使用 `0600` 临时文件加原子替换发布；
- read/chat 只在已落定 terminal failure 后重试，未落定 timeout 禁止重放，write 始终不盲目重放；
- 期望提示类型由已落定的 dispatched 数决定，避免 STT 成功但下游失败后错误推进提示；
- 进度 JSON 严格拒绝 bool、错误 schema 和 `capture_attempts < completed_interactions`；
- 新增只包含有界 expected kind 与枚举 error code 的安全 STT failure marker，不输出正文或异常消息；
- follow-up 改为更稳定的“你好，请继续介绍一下你自己”。

独立源码 review 发现并修复 1 项 P1、2 项 P2，复核后无剩余阻断 findings。主代理在 Node 24.19.0
下复验：TypeScript typecheck PASS、Agent `444/444`、hardware harness `67/67`、Phase 5E 专项
`31/31`、`git diff --check` PASS。完整 Agent 测试在沙箱内的 loopback `listen EPERM` 已在允许本机
绑定的环境重跑并全部通过。

这些本地结果只证明修复候选边界，不把既有失败 run 改写为通过；仍需从包含该修复的新 Git 提交执行
实机 `phase5e_e2e`。

## 5. 修复后 E2E：功能与人工播放通过，产物审计和延迟未通过

commit `d39b69b97e34511e73ea512aaaeac49814bc8e88` 的 `phase5e_e2e` run `33456284948`
完成四次交互，但 workflow conclusion 为 `failure`。必须分层判定，不能用业务 PASS 抵消
artifact 审计失败：

| 项目 | 结果 |
|---|---|
| workflow run / attempt | `33456284948` / `1`，workflow `failure` |
| profile | `phase5e_e2e` |
| 串口 | `/dev/cu.usbserial-210` |
| monitor / capture | `600 s` / `780 s` |
| transport | `completed`，exit `0` |
| app image | `3009792` bytes；SHA-256 `57855c40eb1c02232349c5f2217335d76ebc1d2a16465cbecb03fa81fed5b022` |
| 驱动 / harness | audio driver status `0`；Agent harness status `0` |
| 业务结果 | `passed=true`；4 interactions；STT `8`；TTS `4`；playback segments `4` |
| 稳定性 | power-on `1`、reset `1`、crash `0` |
| artifact audit | `fail`；`VERIFY:phase5e:artifact_audit:FAIL reasons=result_schema` |

人工观察：

1. 前两次回复可听；
2. 第三次旧播放被新唤醒打断；
3. 第四次回复完整播放；
4. 用户对上述功能路径给出“符合要求”，但同时明确指出“语音反应速度明显慢”。

延迟指标显示两个独立瓶颈：

- 首轮 capture open 到 playback open 约 `40.6 s`；其中 STT `18.415 s`、TTS `16.795 s`，
  属于 MLX 模型冷启动；
- 热态 write 轮约 `8.47 s`；其中 STT `1.349 s`、TTS `1.658 s`，固定 `5 s` 采集窗口仍是主要延迟；
- barge 从首次采集到播放约 `16.6 s`，follow-up 约 `27.4 s`，包含有界识别失败重试；
- result 中 `stt_calls=8`、`stt_transcript_mismatches=2`，而旧 auditor 只接受固定
  `stt_calls=4 / mismatches=0`，这是审计失败的直接原因。

artifact SHA-256：

- `monitor.log`：`5cb26483d2d15f8ffa679322bbb1832f9b81c5e5ee0a9d43f21fc7eeb3930ea6`
- `hardware-validation-manifest.json`：
  `9a7399afe5293418e52f1fc5dd3efb9d2619f5bc90a73965f232df43abadb4ff`

针对这两个未通过项，当前修复候选将冷启动顺序预热移到服务 ready 之前，并在已检测到语音后
连续静音 `800 ms`时提前结束采集，`5 s` 仍作为噪声/连续语音的硬上限。同时 result 新增按
expected kind 分类的 STT 拒绝、provider failure 和 capture terminal 守恒；写操作仍禁止重放，
unknown/unexpected 或计数不守恒继续 fail-closed。这些只是已 review 的修复候选，仍须新 commit 的
本地总门禁和实机复验，不回写 run `33456284948` 的 artifact 结论。

最终交叉 review 另修复 1 项 P1：聚合计数可被不对应真实 STT 调用的伪造 terminal 字段绕过。
修复后改为按 capture identity 守恒 accepted/failed STT 与 terminal outcome，并增加伪造、超限、
write 重放等反例。主代理复验：harness `68/68`、聚焦合同 `41/41`、Agent `448/448`、
TypeScript typecheck 和 `git diff --check` 全部通过。`sr_service.c` 单对象强制编译由独立 reviewer 确认通过；
本地完整固件 target 仍被既有 ESP-Hosted 私密配置 guard 阻断，不属于本次回归。

## 6. 低延迟候选复验：审计通过，业务因 terminal credit 竞态失败

commit `e004870f0810e1d9e31f9148bf4fac5f177d6d3e` 的 `phase5e_e2e` run
`33460199737` workflow 为 `success`，但这只表示构建、刷写、采集、审计和上传链完成；manifest
中的 audio driver 与 Agent harness 均为 `1`，原始串口业务终态明确为失败。

| 项目 | 结果 |
|---|---|
| workflow run / attempt | `33460199737` / `1`，workflow `success` |
| profile / port | `phase5e_e2e` / `9444`；串口 `/dev/cu.usbserial-210` |
| transport | `completed`，exit `0` |
| app image | `3010032` bytes；SHA-256 `1ef713e7e9ce360982279cf83703952d167695c0519ce4b9e468b074497e4fab` |
| 驱动 / harness | audio driver status `1`；Agent harness status `1` |
| 业务结果 | 三次 `read` STT 均为 `cancelled`；`VERIFY:phase5e:voice_e2e:FAIL reason=voice_e2e_audio_driver_failed` |
| VAD | 三次均出现 `DIAG:phase5a:command_window outcome=vad_silence`；首轮 capture PASS，说明提前收口路径已运行 |
| artifact audit | `pass`；未保留原始音频，源码/进程参数扫描通过 |
| 稳定性 | power-on `1`、reset `1`、crash `0` |

该 run 初步显示 terminal credit 与 `session.closed` 附近发生竞态。首次修复只允许关闭后 IDLE
消费迟到 credit；提交 `8b96022145283dce76917a11f48b56ef8707e7a2` 的复验 run
`33461779715` 再次出现三轮 `vad_silence`、capture PASS 后约 `200–300 ms` 重连，Agent 三次
`cancelled`，由此确认 pre-EOS credit 在固件已进入 `WAITING_CLOSE`、尚未处理 `session.closed`
时到达。旧逻辑先置异步 reconnect，随后到达的 `session.closed` 仍可打印 capture PASS，但 worker
最终执行重连并触发 Agent 同设备断连处理，取消进行中的 STT。这与 VAD 阈值本身无关，也不能从
workflow 绿色推导语音功能通过。

run `33461779715` 的分层结果：workflow `success`、transport `completed/0`、artifact audit
`pass`、power-on/reset/crash `1/1/0`，但 audio driver/harness 均为 `1`，业务终态为
`VERIFY:phase5e:voice_e2e:FAIL reason=voice_e2e_audio_driver_failed`，没有 playback。app image 为
`3010368` bytes，SHA-256
`284fe2032062e5be041d859211505c0580093c34ae5741bd187a6082f4ec79ed`。artifact SHA-256：

- `monitor.log`：`ea79fd3493f1ee003adf32382facd19a2a7f94562222ece3be0afb16efa33617`
- `hardware-validation-manifest.json`：
  `940d6e2c156eafa19dc00423bdbb79aea85a32d9becdb862d84a2336b00ac45a`

最终修复严格限定为：identity 必须匹配；仅正常 EOS 后的 WAITING_CLOSE 或保留终态字段的 IDLE；ACK 严格
递增、命中 outstanding 且早于最终 EOS；grant 有界。命中的迟到 credit 只消费 outstanding，绝不
增加 available credit；未知/跨 epoch/重复/EOS ACK 继续 protocol error + reconnect。独立 review
将该判定抽为固件实际调用的纯 C 策略，增加 READY/WAITING_CLOSE/IDLE 和全部拒绝分支的原生状态
矩阵，并加固 READY 额度守恒的无符号溢出边界。主代理复验 Phase 5B `15/15`、全部合同
`112/112`、harness `68/68`、`git diff --check`；reviewer 使用本次 run 的真实 ESP-IDF 编译参数
单对象编译通过。完整组件 target 仍被既有 ESP-Hosted 私有配置 guard 阻断。

artifact SHA-256：

- `monitor.log`：`1e8b9e575e9914f46a4f897a02c717c13a845b04aa2be94f58caea6f5bfb6897`
- `hardware-validation-manifest.json`：
  `c9a3544dc1732a2679e51f9ddb61c0e0eb8eef2dd5323e3f3d66324a568d8722`

本 run 没有任何 playback opened，因此没有新增人工扬声器或延迟体感结论。

## 7. 最终自动复验：业务、artifact 与 terminal credit 修复通过

commit `cbd0f39cd484673d02ecfd75d9a4012c0ff5b2fd` 的 `phase5e_e2e` run
`33463393866` 已按 manifest-first 协议完整通过：

| 项目 | 结果 |
|---|---|
| workflow / transport | `success`；`completed`，exit `0` |
| profile / serial / capture | `phase5e_e2e`；`/dev/cu.usbserial-210`；`600 s / 780 s` |
| app image | `3010464` bytes；SHA-256 `bb4491aabc74312e5e9a55fb581a3dbc84d8cbba5083718a46a942f6274142df` |
| driver / harness | `0 / 0` |
| 业务 | `passed=true`；read/write/restore/barge/follow-up 全部通过 |
| STT / TTS | `4 / 4`；STT 总计 `5189 ms`，TTS 总计 `6158 ms`；mismatch `0`；所有失败分类均为 `0` |
| 播放 | 4 segments、`712000` bytes；前两轮 completed，第三轮 cancelled，第四轮 completed |
| 审计 | artifact `pass`；4 个 composition audit、23 个事件；raw audio 未保留 |
| 稳定性 | power-on `1`、reset `1`、crash `0` |

原始串口时序：

| 轮次 | capture open → playback open | capture 收口 | 播放终态 |
|---|---:|---|---|
| read | `7.66 s` | `vad_silence`；terminal credit 在 `waiting_close` 安全消费 | completed |
| write | `7.55 s` | `vad_silence`；terminal credit 在 `waiting_close` 安全消费 | completed |
| barge | `8.16 s` | `5 s` hard deadline | 被下一次 wake cancelled |
| follow-up | `7.86 s` | `5 s` hard deadline | completed |

Agent 阶段计时为 STT `1292 / 1313 / 1281 / 1303 ms`，TTS
`1466 / 1510 / 1735 / 1447 ms`。首轮已不再出现旧 run 的 STT/TTS MLX 冷启动 `40.6 s`；本次四轮无 STT
重试。两次 `DIAG:voice:late_terminal_credit state=waiting_close` 后连接保持并进入播放，证明本次
协议修复命中预期窗口；barge-in 后为 follow-up 建立连接属于测试序列，未取消 STT，最终 result
严格通过。

artifact SHA-256：

- `monitor.log`：`283ad321fe4bcdc3d3dbb91443a693e027ad2286971047188b2bb6c681189037`
- `hardware-validation-manifest.json`：
  `aae9d799837ea8e6bdfb461b9085eea0651e9395d13cc7e1c4a4c594cae40c8d`

以上只证明自动播放传输和 P4 串口时序；实际可听性、响应体感和长停顿句是否被误截断仍由用户
人工判断，不以 marker 代替。

## 8. 当前剩余项

- 用户已确认 run `33463393866` 四轮实际可听、打断与 follow-up 功能符合要求，但明确判定语音响应
  明显偏慢；延迟验收未通过；
- 通过人工长停顿句确认未被 `800 ms` 静音窗口误截断；
- 用真实 Qwen 的 `phase5e_ui` 重新采集 load、prompt eval、generation 与 Agent request wall time，
  再决定 Qwen 预热/保活、流式回复、增量 TTS 和 VAD 参数；
- 真实网络丢失、HA 重启/对账、launchd KeepAlive、P4 感知 Agent 重连和长跑连续性继续按既定决策
  延期，不冒充已验证；
- 上述非延期阻断项通过后，再交由用户最终 review 关闭 Phase 5。

## 9. 真实 Qwen 延迟观测与串口基础设施阻断

提交 `6821b24b4619071f4b5c0db8dd6f72ee0d0e5523` 新增 body-free、版本化的模型计时：覆盖
Router 与全部 Role/tool-loop `provider.chat`，分别记录 Agent request wall time 和 Ollama
`total/load/prompt_eval/eval` duration、prompt/output token，并守恒 completed、failed、cancelled、
timed-out 与 usage missing。产品 `voice_role_completed` 结构化日志和 `phase5e_ui` schema v3 artifact
均输出该计时，但不保留 transcript、response、error detail 或 raw audio。独立 review 修复 timeout/
cancel 竞态、unsafe integer、额外字段注入和 Python `bool == int` 审计绕过；Node 24 typecheck、Agent
`456/456`、Python contract `112/112`、harness `68/68` 与 focused `43/43` 均通过。提交已通过
`git-push.sh --reviewed` 推送，本地、tracking 与远端 SHA 一致。

随后两次真实 `phase5e_ui` 自动 run 均未进入设备或模型阶段：

| run | workflow / transport | manifest 身份 | 确定性错误 | 业务结论 |
|---|---|---|---|---|
| `33507758927` | failure；`failed/2` | `6821b24`；`phase5e_ui`；`900/1080 s`；`/dev/cu.usbserial-210` | esptool 打开串口时 `termios.error: (22, 'Invalid argument')` | `infra-fail`；无 flash、boot、STT 或 Qwen 调用 |
| `33508472447` | failure；`failed/2` | 同上 | 同一 `termios EINVAL` | `infra-fail`；一次自动重试后停止 |

两轮构建和 artifact 隐私审计均通过，但 manifest 均为 power-on/reset/crash `0/0/0`、
`agent_harness_status=null`、`agent_hardware_result=null`，不能作为模型或语音功能证据。artifact SHA-256：

- run `33507758927`：`monitor.log`
  `bc32a4dc206d84f126c52db0d1bc95d9b9bf283327a839def247f0b09887fdf4`；manifest
  `7125818765843a8ced787821e970d3e13f5f68ab12630c072e91390ff227ba82`；
- run `33508472447`：`monitor.log`
  `feccd718b35f1d63012d6e486ed36942b40b2e1d4e15eee5a84f539cdfc6946e`；manifest
  `77e031861b010818d9ee6c1bfea41bc1f662ab9bafaec17451a683e07bde4401`。

下一次实机尝试必须先恢复串口 termios 可配置状态；在此之前不重复触发 workflow，也不把缺失的
Qwen 延迟数据推断为性能通过或失败。
