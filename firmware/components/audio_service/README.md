# audio_service

音频 bring-up、仲裁与诊断模块。

当前负责：

- `ES8311` speaker codec 初始化
- `ES8311` microphone codec 初始化
- boot-time speaker test tone
- microphone PCM capture diagnostics
- 16 kHz、mono、signed PCM16 little-endian 采集边界
- 枚举 owner + 单调 generation lease；拒绝伪造、过期和重复释放
- `ESP-SR` selftest/runtime 与后续 voice capture/playback 共用的单 owner 仲裁
- 可阻塞 I/O mutex 串行化 codec read/close；open/close 状态不确定时 quarantine 到下次重启

Phase 5A 仍保持默认关闭的入口：

- `CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST`
- `CONFIG_P4HOME_PHASE5A_VALIDATION`

真实 Voice channel 和 TTS 播放队列不属于本纵切；它们必须继续通过 lease API 获取音频设备，不能
绕过仲裁或借用调用方字符串作为身份。
