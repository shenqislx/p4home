# Phase 5C STT, VAD & Unified Role Runtime Evidence

日期：2026-08-23

## 范围结论

5C 已实现并通过逐批独立 bugs review、本地回归和真实 ESP32-P4 门禁。版本锁定的本地 STT Provider
只接收活动 capture session 经确定性 VAD 截取的 final utterance；final transcript 随后进入 Phase 4
冻结的统一 Router/Orchestrator、Human/Robot session 和 SQLite 审计链。partial、空白、迟到、重复、
错误 epoch、取消和 provider 失败均为显式零执行终态，Cat 不接收 transcript，原始 PCM 不落盘。

## 实现与失败边界

- Python 3.12 环境锁定 `mlx-whisper 0.4.3` 与
  `mlx-community/whisper-small-mlx@45f3915923c7a79a5a5b5a7d909d39aeb0e5630e`；模型 manifest
  SHA-256 为 `a09d91391784a5bab229222ff04886b4cc50cece8c3c3b544929acc81d1880c3`；
- VAD 冻结最短/最长 utterance、最小 speech、静音、EOS、timeout、空 transcript、provider error、
  cancellation 与 epoch fencing；只有活动 session 的一次 final transcript 可 dispatch；
- Voice Interaction 只通过已有 `user_text` 边界进入统一 Role Runtime；Human/Robot 的 span、session、
  policy、Composer 和审计沿用 Phase 4，Cat history 保持 0；
- STT deadline 在 final transcript 产生时结束，不能误取消其后的 Role dispatch；不配合取消的 provider
  也受硬 deadline 限制，迟到结果不能跨 epoch 执行；
- 原始音频只在进程内有界 Buffer 中短暂存在；结果只记录字节数、speech frame、时延、哈希和终态，
  `raw_audio_retained=false`；默认固件仍关闭 SR/Voice profile，真实 TTS 尚未接入。

## Coding bugs review 与回归

每个 coding 批次完成后均启动独立只读 subagent bugs review，再修复、复审和推送。真实门禁继续关闭了
四类只在完整链路暴露的问题：hardware harness 内层误用 Node 22、INFO capture gate 在 WARN profile
不可见、WebSocket PONG 被应用层误判为协议错误而每 10 秒重连、合法短 EOS 尾帧被拒绝。随后又修正
`pcm_bytes` 按整帧估算造成的尾帧虚增，最终按实际送入 STT Provider 的 Buffer 字节精确求和。最终
各批 review 均为 no findings。

最终回归：

- Agent（Node 24.19.0）：280/280；Phase 5C target：15/15；
- Python STT harness：17/17；真实 MLX 预录中文样本通过；
- ESP-IDF v5.5.4 Phase 5C enabled build：通过；
- `git diff --check`：通过。

## 真实硬件门禁

最终 run `32635742553`，commit `4a17e711d64d2e7cfd9dc14ed3a32abf801440e7`，workflow
conclusion `success`。artifact manifest 精确匹配 run/commit、`phase5c_stt`、
`/dev/cu.usbserial-210`、300 秒 monitor 与 480 秒 capture，并确认 Agent harness status 为 0、固定
Provider/模型 revision 与 manifest SHA 均匹配。

Mac 系统扬声器先播放 wake 输入，再播放中文现场句子，仅作为 P4 麦克风输入替代。真实链路输出：

- P4：`VERIFY:phase5b:voice_capture:PASS epoch=1966081 frames=250 bytes=159744 dropped=0
  queue_hwm=4 stack_hwm=8864`；
- Agent：`VERIFY:phase5c:voice_stt_unified:PASS epoch=1966081 pcm_bytes=154880 speech_frames=130
  stt_ms=18581.967 transcript_chars=12 attempts=1 mismatches=0 role=human audit=persisted cat_history=0
  raw_audio_retained=false`；
- transcript 的规范化 SHA-256 与预期
  `cd1c667a089b4486c36f7c0d262c663bed74b9cd51462a84a0b698a385eb3621` 精确相等；只有一次
  attempt，SQLite 写入 2 个审计 event，Cat history 为 0；
- `159744` 是 P4 整段上传字节，`154880` 是 VAD 后实际送入 STT Provider 的精确字节，二者不是
  同一指标；本次修复消除了 EOS 尾帧按 640 字节整帧计数的虚增；
- harness 完成结果后主动退出，P4 随后按 10 秒退避尝试重连；在 STT 节点离线期间，HA 始终
  `READY`、`reconnect=0`，固定 P4 主链和 UI 继续运行；
- 原始 flash 日志确认 `ESP32-P4 (revision v1.0)`、四次 `Hash of data verified` 和 reset 后运行；
  480 秒内只有一次预期 `POWERON`，无 panic、Guru Meditation、watchdog、brownout、assert 或
  Backtrace；这份串口证据不等同于用户所见蓝屏现象已关闭；
- UI 共 54 条 `8fps:PASS` 和 1 条 `8fps:FAIL interval_ms=10040`。唯一 FAIL 位于 HA 冷启动集中
  回刷窗口，此前 4 条 PASS，之后 50 条连续 PASS；本 closeout 不把它表述为“全部 UI marker PASS”。

artifact SHA-256：

- `hardware-validation-manifest.json`：
  `d450a39b5b4c519c6126a7aac583e3df47d10a1a06f617add8bae7af25ad6128`；
- `monitor.log`：
  `0afb18cd6adcabaf5246438880b3c03e44698dcb659e104bb0b8288535c2e4d0`。

## Gate verdict

版本锁定 STT、确定性 VAD/final-only 边界、统一 Human/Robot Runtime、SQLite 审计、零 Cat 泄漏、
原始音频最小保留和真实 P4 中文链路均满足 5C 退出门禁，5C 技术状态为 **PASS**。P4 startup tone
的独立可听人工观察仍是 5A/Phase 5 最终关闭前的待补项；Mac 系统扬声器输入不能替代该 P4 输出
观察。5C PASS 只授权进入 5D，不关闭 Phase 5，也不授权 Phase 6。
