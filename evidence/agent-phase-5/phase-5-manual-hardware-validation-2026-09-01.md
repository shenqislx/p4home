# Phase 5 Manual Hardware Validation — 2026-09-01

日期：2026-09-01

状态：`ui_manual_pass / startup_tone_manual_pass / role_playback_incomplete`

分支：`feature/agent-harness`

提交：`85b55ec9d282218baed14d685ddd5dc2d505562b`

## 结论

本轮把自动化、原始串口和人工观察分层记录：

- P4 对话框三轮可见更新已经由用户肉眼确认通过；
- 外接在 `SPK/J16` 的扬声器已由用户明确听到 Phase 5A 开机提示音；
- `phase5e_e2e` 已证明 P4 至少一次可听回复和新唤醒打断旧播放，但完整多轮播放没有通过，最终
  `voice_e2e_result_timeout`，因此 Phase 5 继续保持 `pending_real_environment`；
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

## 5. 当前剩余项

- 修复并从新提交重跑 `phase5e_e2e`，要求完整交互业务终态、audio driver 与 harness 均为 `0`；
- 在同一有效 run 中再次由用户确认完整分角色回复可听，且 barge-in 后旧 epoch 不再恢复播放；
- 真实网络丢失、HA 重启/对账、launchd KeepAlive、P4 感知 Agent 重连和长跑连续性继续按既定决策
  延期，不冒充已验证；
- 上述非延期阻断项通过后，再交由用户最终 review 关闭 Phase 5。
