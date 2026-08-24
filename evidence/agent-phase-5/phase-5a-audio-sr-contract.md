# Phase 5A Audio/ESP-SR Baseline & Voice Contract Evidence

日期：2026-08-23

## 范围结论

5A 只恢复 P4 本地 audio/ESP-SR 基线并冻结 Voice Protocol v1。默认固件仍关闭 SR、audio startup
selftest 和 Phase 5A marker；本纵切没有创建 Voice socket、连接 STT/TTS、传输或持久化真实音频。

## 已实现边界

- PCM 固定为 16 kHz、mono、signed PCM16 little-endian；正常 frame 为 20 ms、320 samples、
  640 bytes；
- 56-byte little-endian header 显式携带 version、kind、flags、session id、stream id、epoch、
  sequence、capture timestamp 与 PCM geometry；
- receiver 拒绝过期 session/epoch、重复 frame、未声明 discontinuity 的 gap 和 EOS 后数据；
- control contract 显式定义 `session.open/ready`、credit、EOS、cancel、closed 与 terminal error；
- 完整 binary message 必须精确等于 header + `payload_bytes`，截断和尾随 bytes 均拒绝；
- flow tracker 关联 lifecycle/epoch、协商 window、单调 ack、可用 credit 和未确认 frame；
- audio owner 使用枚举 lease/generation；伪造、过期、重复 release 失败，SR selftest/runtime 不再借用
  字符串 owner；codec I/O 由 mutex 串行化，open/close 不确定时 quarantine 到重启；
- P4 与 TypeScript 侧共享相同 wire geometry，并分别有 host/contract 失败测试。

## 本地验证

- ESP-IDF v5.5.4 默认配置 clean build：通过；
- ESP-IDF v5.5.4 `phase5a_voice` 等价专用配置 clean build：通过，review 修复后 app image
  `0x281c90` bytes，3 MiB app partition 剩余 `0x7e370` bytes（16%）；
- 首轮真机失败修复后的同 profile 构建：通过，app image `0x2840c0` bytes，3 MiB app partition
  剩余 `0x7bf40` bytes（16%）；
- 第二轮真机失败的 profile-specific main stack 修复及 review 修正后增量构建：通过，app image
  `0x2841e0` bytes，3 MiB app partition 剩余 `0x7be20` bytes（16%）；临时 sdkconfig 已核对为
  `CONFIG_ESP_MAIN_TASK_STACK_SIZE=12288`；
- 官方 G2P 带对象短命令别名及 review 修正后构建：通过，app image `0x284220` bytes，3 MiB app
  partition 剩余 `0x7bde0` bytes（16%）；
- 命令窗口聚合诊断及三轮独立 review 修复后构建：通过，app image `0x284630` bytes，3 MiB app
  partition 剩余 `0x7b9d0` bytes（16%）；诊断仅记录 frame/VAD/detect-call 计数与 PCM 峰值，不保存
  或上传原始音频；
- C host tests：4/4（`world_service`、`world_object_runtime`、`voice_protocol`、
  `audio_service_lease`）通过；
- Agent 全量 tests：247/247；TypeScript typecheck：通过；
- Python contract：82/82；hardware harness：11/11；
- workflow YAML parse 与 `git diff --check`：通过。

## Coding bugs review

coding done 后启动独立只读 subagent review。review 报告的 6 项 finding 已全部修复：完整 binary
payload 长度、跨消息 lifecycle/credit/window、codec read/close 串行化、codec close fault quarantine、
JavaScript flags 数值边界、控制面全零 session。修复后另将 lease generation 溢出改为 fail-closed，
避免旧 generation ABA 复用。上述全量回归均在修复后重新通过。

后续 fixed-command 定位改动也按 coding done → 独立 review → 修复 → 复审执行。review 发现并关闭：
命令 runtime 可因 NULL fetch/chunksize mismatch/持续 DETECTING 永久停留 AWAKE、MultiNet 空结果被
误记为 detected、`WAKE_DETECTED` 在 NULL fetch 时无法推进，以及过期帧可能先执行动作再检查截止。
最终状态机在任何 NULL-fetch continue、frame 计数、MultiNet detect 和本地背光动作之前统一推进
wake hold 与 command hard deadline；所有终止路径恢复 WakeNet/Listening，并用独立 outcome 区分
动作成功、动作失败、空结果、MultiNet timeout、硬截止和 command runtime 不可用。最终复审无代码
finding，证据计数过期问题已同步修正为 82/82。

## 实机门禁

判定顺序固定为 workflow → manifest/artifact identity → 原始 `VERIFY:` marker → 人工口播/听觉观察；
workflow 绿色不等于功能通过。

### 首轮候选：FAIL（保留为回归证据）

- commit：`dd7e92e51aacfadb4aafcda51fcae6d6a171d246`；run：`32609975662`；
  profile：`phase5a_voice`；串口：`/dev/cu.usbserial-210`；capture/monitor：300 秒；
- workflow conclusion 为 `success`，manifest 的 commit/run/profile/serial、Phase 5A 开关和
  `phase5a_agent_transport_disabled=true` 均匹配；原始串口确认 `ESP32-P4 (revision v1.0)`，刷写日志
  多次出现 `Hash of data verified`；
- 功能判定为 **FAIL**：启动约 6.5 秒后反复 `Guru Meditation Error: Core 0 panic'ed
  (Load access fault)`，没有任何 `VERIFY:phase5a:*` marker；
- PC/RA 地址解析分别落在 ESP-SR WebRTC AGC 的 `WebRtcSpl_DownsampleBy2` 与
  `WebRtcAgc_ProcessAnalog`，fault address `0x5010a940` 位于 ESP32-P4 LP-RAM 区域；
- capture 期间曾用 Mac 系统扬声器两次播放 `Hi ESP` 和固定开灯命令，但设备处于重启循环，
  因此这只记录为输入尝试，不构成 wake/command 或设备扬声器证据。

### 首轮失败后的修复

板上只有一个麦克风、没有提供 playback reference。修复将 AFE 输入从 `MR` 收窄为 `M`，关闭未被
Phase 5A 门禁要求的 AEC 与 WebRTC AGC，并使用 ESP-SR 支持的 `AFE_MEMORY_ALLOC_MORE_PSRAM`。
现有证据只证明 AGC 调用路径访问了 LP-RAM 地址，尚不能证明 fault pointer 来自何种分配或损坏；
修复通过关闭非必要的 AGC/AEC 路径并采用受支持的 PSRAM-first 策略进行隔离。WakeNet、VAD 和
MultiNet 仍保持启用，但是否退化必须由新门禁判断。修复必须经过独立 bugs review、本地回归、
推送和新的同 profile 真机 run 后才能改变 5A 判定。

第二轮独立 review 对该硬件修复报告 3 项 P2：第二次 AFE create 失败可能遗留 runtime-ready
假阳性、contract test 未守住 policy 生效顺序/单通道几何、以及 allocator 根因表述超过原始证据。
修复后第二次 create 与 runtime cleanup 均 fail-closed 清理 live readiness，启动前显式校验
`total_ch_num=1`、`mic_num=1`、`ref_num=0`，测试固定 init → policy → validate → handle/create
顺序，并将文档结论收窄为“AGC 路径访问 LP-RAM，pointer 形成机制未证实”。

fix 复核另发现 1 项 P1：`xTaskCreate` 后由父任务写 ready 状态会与高优先级 runtime task 的
早期失败清理竞态。最终修复在创建 task 前发布 starting 状态，创建失败统一回滚，创建成功后父任务
不再写 live/UI 状态；后续状态只由 runtime task 持有，退出时同时清除 AFE、loop、wake 与 MultiNet
ready 标志。

### 第二轮候选：FAIL（AGC fault 消失，暴露 main stack overflow）

- commit：`cfa2e27352592e7addcfddf6ecc107b839a3b0bb`；run：`32611151734`；
  profile：`phase5a_voice`；串口：`/dev/cu.usbserial-210`；capture/monitor：300 秒；
- workflow conclusion 为 `success`，manifest 的 commit/run/profile/serial、`ESP32-P4 (revision
  v1.0)`、四次 `Hash of data verified`、Phase 5A 开关与 agent transport disabled 均匹配；
- 首轮的 WebRTC AGC `Load access fault` 不再出现，启动越过两次 WakeNet/AFE create；
- 功能仍判定为 **FAIL**：约 6.6 秒后反复 `***ERROR*** A stack overflow in task main has been
  detected.`，manifest 确认 main stack 为 5120 bytes，没有 `VERIFY:phase5a:*` marker；
- capture 期间用 Mac 系统扬声器以 115 和 105 两档语速播放两轮唤醒词及 on/off 固定命令；设备
  在命令窗口前持续重启，故播音不构成 wake/command 证据。

该失败的最小隔离修复只把 `phase5a_voice` 的 main task stack 提升为 12288 bytes；默认固件及其他
profile 继续使用 tracked 5120 bytes。workflow 在 build 前后验证 profile-specific stack，并把实际值
写入 manifest；固件分别在 `board_support_init` 返回后和首个 30 秒 heartbeat 输出历史最低剩余栈
字节数，后者还以 1024 bytes 为最低通过门槛。下一次实机 run 必须同时核对 heartbeat marker/count
和持续无 stack overflow，不能只依赖“不再重启”。

### 第三轮：基础设施失败（不产生功能判定）

- commit：`ca28fa05f99734ac0208bc8a149f10ce55d62faf`；run：`32611933569`；
- build 通过后 self-hosted runner 在 flash/capture 步骤中途离线，GitHub 等待 job lease 到期后将
  workflow 标为 `failure`；该步骤没有完成状态，后续 manifest 与 artifact upload 均未执行；
- GitHub runner API 确认 `andydeMac-mini` 为 `offline`，本地 runner/worker 日志也在采集中途终止；
  因此该 run 既不是固件 FAIL，也不能作为功能 PASS。

### 第四轮：部分通过（稳定/wake PASS，fixed command 未通过）

- commit：`ca28fa05f99734ac0208bc8a149f10ce55d62faf`；run：`32612649839`；
  profile：`phase5a_voice`；串口：`/dev/cu.usbserial-210`；capture/monitor：300 秒；
- workflow conclusion 为 `success`；manifest 的 commit/run/profile/serial、12288-byte main stack、
  Phase 5A 开关与 agent transport disabled 均匹配；原始日志确认 ESP32-P4 与四次 flash hash；
- 设备 300 秒内无 panic、stack overflow 或 watchdog；after-init/heartbeat 最低剩余 main stack 分别为
  7260/7032 bytes，`main_stack_headroom`、非零 PCM、AFE stream、audio lease 与 UI 8 FPS 均 PASS；
- Mac 系统扬声器回放得到真实 `VERIFY:phase5a:wake_detected:PASS`，但没有
  `VERIFY:phase5a:fixed_command:PASS`，MultiNet 只输出空结果。因此本轮仍不能关闭 5A。

### 第五轮：定向声学重试仍未完成 fixed command

- 同一 commit 的 run `32613095770` 使用 180 秒窗口，manifest 身份与第四轮相同且 workflow
  success；栈、PCM、AFE、lease、wake 与 UI marker 再次通过；
- 系统音量为 100%，按 wake hold 后 3 秒的节奏回放 `screen on`、`display off` 和慢速
  `turn on the light`；MultiNet 输出已解析到 `_TkN_nN_jc`（`turn on the`）但未形成 DETECTED；
- 为降低完整长句在声学回放中的尾词丢失风险，下一候选使用 ESP-SR 官方 `multinet_g2p.py`
  生成的带对象短别名 `light on/off`。独立 review 拒绝了会扩大语义并可能抢先匹配的无对象
  `turn on/off`；既有完整短语和 action id 不变，仍需复核、推送与新 artifact 才能判定。

### 第六、七轮：短别名候选仍未完成 fixed command

- commit `6e992832cc9f29f2036568f052e5cb35166c39f2` 的 run `32613812909` 与
  `32614298745` 均使用 180 秒 `phase5a_voice` profile；后者按 runner 本地 `$ serial-capture`
  启动标记精确安排系统扬声器回放；
- 两轮 manifest 均匹配 commit/run/profile/serial/12288-byte main stack，原始日志确认 ESP32-P4、
  四次 flash hash、稳定栈/PCM/AFE/lease/wake；第七轮 UI 8 FPS 全部 PASS 且无 panic/overflow；
- `light on/off` 仍没有形成 `VERIFY:phase5a:fixed_command:PASS`。第六轮一次孤立 UI interval FAIL
  未在第七轮复现，不据此判为持续 UI 回归；
- 同一已刷写候选的三组 no-reset 本地串口诊断分别覆盖单命令、多 voice 与 60/35/100% 音量矩阵；
  Mac 系统扬声器每次都只作为输入尝试，MultiNet 仍以 152 blank/空结果结束，不能改变 5A FAIL。

### 当前诊断候选：待真机 artifact

为区分信号幅度与状态/喂帧问题，当前候选加入命令窗口 aggregate-only 诊断：raw/AFE peak、VAD
speech frame、合格 frame 与 MultiNet detect call。`DIAG:` 与 `VERIFY:` 前缀严格分离，只有真实本地
动作递增 `command_action_count` 后，app_main 才会输出 `VERIFY:phase5a:fixed_command:PASS`。该候选
在提交、推送和新硬件 artifact 前不改变 Phase 5A 判定。

### 最终自动化候选：PASS；P4 可听播放人工观察：暂缓（缺少外接扬声器）

- commit：`d2841de76ad49eb51fdcd6fee32e00d742bc43d6`；run：`32615794192`；workflow
  conclusion：`success`；profile：`phase5a_voice`；串口：`/dev/cu.usbserial-210`；capture：180 秒；
- manifest 精确匹配 commit/run/profile/serial，确认 12288-byte main stack、Phase 5A/SR/audio
  selftest enabled、Agent transport disabled；原始日志确认 `ESP32-P4 (revision v1.0)` 与四次
  `Hash of data verified`；
- codec speaker/microphone、startup tone、mic capture、PCM contract、非零 PCM、AFE stream、audio
  lease、main stack headroom 与全部 UI 8 FPS marker 均 PASS；after-init/heartbeat 最低剩余 main
  stack 为 7260/7032 bytes，180 秒内无 panic、stack overflow 或 watchdog；
- Mac mini 系统扬声器作为输入替代播放三组唤醒/固定命令。第一命令窗口按 hard deadline 安全恢复；
  聚合诊断为 157 frames、51 VAD speech frames、157 detect calls、raw/AFE peak 3603。第二组输入形成
  `outcome=detected_action_applied`（98 frames、49 VAD speech frames、98 detect calls、raw/AFE peak
  2043），随后原始日志输出 `VERIFY:phase5a:wake_detected:PASS` 与
  `VERIFY:phase5a:fixed_command:PASS`；
- artifact SHA-256：`monitor.log`
  `101ecf6c1d8fe3784539321f1450600277351b868dba25e5cd0c99d8c0eae066`；manifest
  `a4e83113b1132d320cff3bc8945106543dc54866c0226708df18868333822e48`；
- 上述证据足以判定 5A 自动化、真实 wake 与固定命令动作门禁 **PASS**，并冻结 Voice Protocol v1；
  默认配置仍未打开 SR/音频自检，也没有向 Agent 节点传输或持久化真实音频。`speaker` 与
  `tone_played` marker 只证明 codec 数字播放路径调用成功，不能证明 P4 扬声器实际可听；Mac 系统
  扬声器是麦克风声学输入替代，不是 P4 输出观察。2026-08-24 首次人工反馈为已完成；随后使用本地
  Phase 5A profile 重新刷写并直接重测时，用户明确反馈未听到 startup tone。同期串口仍报告
  `speaker_ready=yes`、`tone_played=yes` 与 `VERIFY:audio:tone_played:PASS`，只证明 codec 数字写入
  路径返回成功。进一步核对后确认开发板 `SPK/J16` 未连接外接扬声器，因此该结果既不能判定物理
  输出 PASS，也不能据此判定固件播放 FAIL。人工可听项保持打开，待外接扬声器到货后再次现场确认。
