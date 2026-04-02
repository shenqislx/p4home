# audio_service

音频 bring-up 与诊断模块。

当前负责：

- `ES8311` speaker codec 初始化
- `ES8311` microphone codec 初始化
- boot-time speaker test tone
- microphone PCM capture diagnostics

后续继续负责：

- 音频缓冲
- 录放 service 抽象
- `ESP-SR` 前置音频格式适配
