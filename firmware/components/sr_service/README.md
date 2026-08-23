# sr_service

`ESP-SR` 本地语音前端模块。

当前负责：

- 从 `audio_service` lease 独占麦克风并持续向 AFE feed/fetch；
- WakeNet 唤醒与 MultiNet 固定离线命令；
- 固定 light/display 命令的本地执行和 voice UI 状态；
- selftest/runtime 迭代、fetch、wake 与 command-action 诊断计数。

Phase 5A 专用 profile 打开 `CONFIG_P4HOME_SR_ENABLE`，默认配置仍关闭。Agent/STT/TTS 离线时，
本模块的 WakeNet 与固定命令必须继续本地可用；final transcript、通用 Router 和 Tool Runtime 不在
本模块实现。
