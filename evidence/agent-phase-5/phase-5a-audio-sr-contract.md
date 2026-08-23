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
- C host tests：4/4（`world_service`、`world_object_runtime`、`voice_protocol`、
  `audio_service_lease`）通过；
- Agent 全量 tests：247/247；TypeScript typecheck：通过；
- Python contract：80/80；hardware harness：11/11；
- workflow YAML parse 与 `git diff --check`：通过。

## Coding bugs review

coding done 后启动独立只读 subagent review。review 报告的 6 项 finding 已全部修复：完整 binary
payload 长度、跨消息 lifecycle/credit/window、codec read/close 串行化、codec close fault quarantine、
JavaScript flags 数值边界、控制面全零 session。修复后另将 lease generation 溢出改为 fail-closed，
避免旧 generation ABA 复用。上述全量回归均在修复后重新通过。

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
