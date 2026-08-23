# Phase 5B Binary Voice Channel & Session Lifecycle Evidence

日期：2026-08-23

## 范围结论

5B 已实现并通过独立 bugs review、本地回归和真实 ESP32-P4 门禁。Voice Protocol v1 使用独立于
Device JSON/HA 的认证 WSS `/v1/voice` 数据面；真实 P4 在 wake 后把有界 AFE PCM session 送达
Agent fake sink，并以显式 credit、ack、EOS、cancel、terminal error 和 epoch fencing 约束生命周期。
默认固件仍关闭 SR、Voice transport 和 Phase 5B validation；本纵切没有接入真实 STT/TTS，也没有
保留原始 PCM。

## 实现与失败边界

- Agent 与 P4 分别限制 pending socket、header/payload、帧率、并发 session、credit/window、队列、
  session 时长和重连；旧 epoch、重复/回退 sequence、迟到 frame 与 EOS 后数据 fail-closed；
- P4 capture owner 在完成、cancel、timeout、慢消费者、断线和重连路径释放；Agent sink 只保留受限
  aggregate summary，`raw_audio_retained=false`；
- Voice transport worker、Voice WebSocket worker 和 HA worker 使用有界栈；TLS 使用外部内存；Phase 5B
  专用 profile 将常驻 weather/energy 任务的两个 8192-byte 栈放入 PSRAM，为 Hosted Wi-Fi、HA 与
  Voice 的内部 DMA-capable 分配保留连续块；普通配置仍走原 `xTaskCreate`；
- workflow 在 build 前后精确核对 profile，并把实际 main/Voice/HA stack、TLS allocator、后台栈和
  transport 开关写入 manifest；harness 必须在 flash 成功后才启动，避免把 build/flash 时间算入
  capture deadline；
- Device Protocol v1/v2、HA Tool contract、RoleProfile 权限、默认 SR 开关和真实 STT/TTS 均未扩大。

## Coding bugs review 与回归

每个 coding 批次完成后均启动独立只读 subagent bugs review，再修复、复审和推送。主要关闭的问题
包括：Voice/HA worker internal-RAM 竞争、Hosted memcpy/SDIO DMA 连续块不足、HA WebSocket 栈缩小
导致的 stack-protection fault、harness 在 flash 前启动造成假 timeout，以及 Kconfig 误用兼容宏名而
静默丢弃后台外部栈开关。最终 Kconfig 使用 ESP-IDF 5.5.4 的真实
`FREERTOS_TASK_CREATE_ALLOW_EXT_MEM` 依赖，最终复审为 no findings。

最终回归：

- Python contract：88/88；hardware harness：15/15；
- Agent（Node 24.19.0）：262/262；
- ESP-IDF v5.5.4 Phase 5B enabled clean build：通过，生成配置明确启用后台外部栈；
- ESP-IDF v5.5.4 default clean build：通过，生成配置明确保持该开关关闭；
- `git diff --check`：通过。

## 真实硬件门禁

最终 run `32627837273`，commit `c24414cba263bce9f6affe433f981433211038f5`，workflow
conclusion `success`。artifact manifest 精确匹配 run/commit、`phase5b_voice`、
`/dev/cu.usbserial-210`、300 秒 capture，并确认：

- ESP main stack 8192 bytes；Voice transport worker 12288 bytes；Voice WebSocket worker
  6144 bytes；HA WebSocket worker 8192 bytes；Voice reconnect 10000 ms；
- Phase 5B、Voice transport、TLS external allocator、weather/energy external stack 均启用；
  Device Agent transport 关闭；Agent harness status 为 0；
- 原始 flash 日志确认 `ESP32-P4 (revision v1.0)`、四次 `Hash of data verified` 和 reset 后运行；
- weather 与 energy 均输出 `background_stack:PASS ... external=yes size=8192`；HA 完成 36 个初始实体，
  保持 `READY`、`reconnect=0`；300 秒内无 panic、stack protection fault、assert、watchdog 或重启；
- Mac 系统扬声器仅作为 P4 麦克风输入替代。真实 wake 后 P4 输出
  `voice_capture:PASS epoch=1572865 frames=252 bytes=160768 dropped=0 queue_hwm=3
  stack_hwm=8864`；Agent 同步输出 `agent_voice_sink:PASS`，peak 2666，EOS=true，未保留原始音频；
- 精确词表补播后，三次 command window 均为 `detected_action_applied`，并输出
  `wake_detected:PASS` 与 `fixed_command:PASS`；
- UI 共有 32 条 `8fps:PASS` 和 1 条 `8fps:FAIL interval_ms=11810`。唯一 FAIL 位于 HA 冷启动
  36 实体集中回刷窗口；此前 5 条 PASS，之后约 27 条连续 PASS 直至采集结束，denied=0，HA/Voice/
  fixed command 后续均正常。独立 evidence review 判定这是一次性非稳态抖动，不是稳态 UI 回归；
  closeout 不把它表述为“全部 UI marker PASS”。

artifact SHA-256：

- `hardware-validation-manifest.json`：
  `5d54dc2e2183968f3433766b1b7358816a112156f80c10d9709a9f3c074293d6`；
- `monitor.log`：
  `0693ed1a2f665eaae90b5b811f3d8ca4e7049655a66ce7c80babd3d25d7ffc18`。

## Gate verdict

workflow 链、artifact identity、真实 P4 PCM → Agent fake sink、生命周期/恢复、HA/固定命令与稳态 UI
证据均满足 5B 退出门禁，5B 技术状态为 **PASS**。P4 startup tone 的独立可听人工观察仍是 5A/Phase 5
最终关闭前的待补项；Mac 系统扬声器输入不能替代该 P4 输出观察。5B PASS 只授权进入 5C，不关闭
Phase 5，也不授权 Phase 6。
