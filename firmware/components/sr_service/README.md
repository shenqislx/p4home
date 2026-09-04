# sr_service

`ESP-SR` 本地语音前端模块。

当前负责：

- 从 `audio_service` lease 独占麦克风并持续向 AFE feed/fetch；
- WakeNet 唤醒与 MultiNet 固定离线命令；
- 固定 light/display 命令的本地执行和 voice UI 状态；
- selftest/runtime 迭代、fetch、wake 与 command-action 诊断计数。

板级 AFE 固定为单麦克风 `M` 输入；由于没有回放参考通道，AEC 关闭。Phase 5A 首轮实机证据
定位到 ESP-SR 2.1.4 的 WebRTC AGC 路径访问 LP-RAM 地址，但尚未证明该指针的形成机制，因此
本板隔离非必要的 AGC 路径，其余 AFE 工作内存使用 PSRAM-first 策略。WakeNet、VAD、MultiNet
仍保持启用，实际可用性和声学效果由新的真机门禁判定。

Phase 5A 专用 profile 打开 `CONFIG_P4HOME_SR_ENABLE`，默认配置仍关闭。Agent/STT/TTS 离线时，
本模块的 WakeNet 与固定命令必须继续本地可用；final transcript、通用 Router 和 Tool Runtime 不在
本模块实现。

项目默认选用 ESP-SR 2.1.4 已随包提供的 `wn9_hixiaoxing_tts` 模型，唤醒词为
`Hi，小星`。由于该 ESP-SR 版本的模型清单已包含模型但 Kconfig 遗漏选项，本组件的
`Kconfig.projbuild` 补充同名 symbol，供上游模型打包脚本选中。

产品语音采用单麦半双工：远端 TTS playback 活跃时，由 playback task 发送非阻塞状态，SR task
自行暂停 WakeNet；播放关闭并等待 400 ms 后恢复。这样既不跨 task 直接调用 AFE，也避免回复中近似
`Hi，小星` 的内容触发自唤醒并取消尚未播完的 epoch。单轮 capture 的硬上限为 8 秒，检测到语音后
以 1.2 秒连续尾部静音结束，兼顾自然停顿和有限资源占用。
