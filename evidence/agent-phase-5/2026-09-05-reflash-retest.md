# 2026-09-05 重新烧录与语音复测

## 烧录与产物

- 本地工作区 `5c0d160` 加未提交修复；本轮没有修改产品代码、提交或推送。
- ESP-IDF v5.5.4，ESP32-P4，`/dev/cu.usbserial-210`，MAC `30:ed:a0:e1:8a:f5`。
- 完整 `idf.py flash`：bootloader、应用、分区表、SR 模型四个镜像均有 `Hash of data verified`。
- app SHA-256：`0a3b34efff5390608801f6513880272c99906ab5d366fdb3568a08211e65d558`。
- ELF SHA-256：`9e7fd00b49e522f9652e89524797c61aeac7b40f0008d7576d6854c9c2f5240e`。
- 与上一轮产物及相关源文件哈希一致；依赖锁未变化。不是 GitHub Actions run。

私有原始证据目录：`evidence/voice-review-20260905/reflash.Q79yxy/`。
先核对 `hardware-validation-manifest.json`，再查看 `flash.log`、`monitor.log` 和 `acoustic.json`。

## 首次测试：功能未通过

同一 Mac Tingting 声学输入脚本经真实 P4 麦克风测试：

- 身份短问答 completed；UI/audio 均 completed，1 段播放无丢帧。
- 第二轮长故事请求在收音阶段返回 `too_short`，未进入模型回复或 TTS。
  Agent 保留 52,480 PCM 字节，仅 7 个有效语音帧（约 140 ms），低于默认 300 ms 门槛。
  P4 capture epoch 为 `10944514`，串口 `monitor.log:218` 打开采音，`:223` 以尾部静音结束。
  缺少原始音频/同步声学观测，不能据此断言原因是说话音量、测试输入时序或 VAD 本身。
- 采集 140 秒，包含失败后 60 秒。无 panic/watchdog/assert/brownout；只有主动捕获启动时的一次
  POWERON reset，没有意外重启。当前日志级别未打印启动 ELF SHA，不把其缺失当成哈希匹配证据。
- HA initial sync 约 44 秒通过。启动校时失败在约 83 秒恢复 PASS；一次 UI 8 FPS 告警随后恢复 PASS。

## 不重启的独立复测

保持相同固件、配置、脚本和输入语句，没有再次重启：

| 用例 | 结果 | 音频 | 完成分段 |
| --- | --- | ---: | ---: |
| 身份短问答 | completed | 3.4 秒 | 1 |
| 长故事 | completed | 92.8 秒 | 20 |
| 长故事后的短问答 | completed | 6.3 秒 | 1 |
| 再次请求长故事 | too_short | 未开始回复播放 | 0 |

第二次失败 capture epoch 为 `10944518`，仅 4 个有效语音帧（约 80 ms），
保留 PCM 为 40,960 字节。`retry-monitor.log:179` 开始采音，`:188` 开始失败后观察。
五用例脚本在失败处停止，没有执行第五个用例；不把未执行项算作通过。
本次独立采集 229 秒，包含失败后 60 秒；无崩溃、重启或 `VERIFY:*:FAIL` 标记。
这里“无 FAIL 标记”不代表业务通过：Agent 的 `too_short` 仍是明确失败证据。

## 本轮结论

烧录通过，语音功能复测未通过。两次独立测试共实际发起 6 次对话，4 次 completed、2 次
`too_short`；一次约 93 秒的长回复完整通过且后续短问答恢复正常，但间歇收音失败仍可复现。
本轮不修改产品代码、VAD 阈值或驱动输入时序；尚未定位两个失败的声学/端点判定根因。

首次失败不会因其他用例成功而被覆盖。机器声学测试不等同于真人听感和肉眼 UI 验收。
