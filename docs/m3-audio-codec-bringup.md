# M3 Audio Codec Bring-up

## 1. 结论

`ESP32-P4 EVB V1.4` 上的 `ES8311` codec bring-up 已完成，当前阶段已经验证：

- speaker codec 初始化成功
- microphone codec 初始化成功
- 页面按钮可手动触发 `Play Test Tone`
- 页面按钮可手动触发 `Capture Mic Sample`
- 串口日志确认 tone 写入路径与 microphone capture 路径都已真实执行
- 音频链路失败不会阻塞现有 `LCD + LVGL + GT911` 路径

当前未闭环项只有一项：

- `speaker audible verification`

该项不再视为当前 `codec bring-up` 的软件阻塞，而是明确依赖外接喇叭硬件。

## 2. 实际验证结果

### 2.1 启动阶段

启动后串口已确认：

- `audio_service: speaker codec initialized`
- `audio_service: microphone codec initialized`
- `audio initialized=yes busy=no speaker_ready=yes microphone_ready=yes tone_played=no mic_capture_ready=no`

这说明当前版本的开机路径只做 codec 初始化，不再自动播放 tone，也不再自动做 microphone capture。

### 2.2 手动触发 speaker test tone

点击页面上的 `Play Test Tone` 后，串口已确认：

- `Adev_Codec: Open codec device OK`
- `audio_service: speaker test tone wrote 16000 bytes`

这说明：

- `LVGL -> UI button -> FreeRTOS task -> audio_service -> esp_codec_dev_write()`

这条软件路径已打通。

### 2.3 手动触发 microphone capture

点击页面上的 `Capture Mic Sample` 后，串口已确认：

- `audio_service: microphone capture bytes=2048 samples=1024 peak_abs=32768 mean_abs=23457 nonzero=876`

这说明 microphone capture 路径已打通，当前可以输出基础 PCM 诊断指标。

## 3. 当前边界

当前阶段按以下边界收口：

- `codec bring-up`：已完成
- `manual diagnostics UI`：已完成
- `microphone baseline capture`：已完成
- `speaker audible verification`：未闭环，但原因已收敛到外接喇叭依赖

## 4. 为什么没有听到声音

从当前验证结果看，问题不在软件触发路径：

- 按钮事件已到达音频服务
- codec 已打开输出流
- PCM tone 已写入

当前更合理的解释是：

- `ESP32-P4 EVB V1.4` 提供的是 `Speaker Output Port`
- 可听声验证依赖外接喇叭
- 若未连接外接喇叭，则“听不到声音”是预期现象

## 5. 对 Issue #6 的处理建议

`#6` 应按以下结论关闭：

- `audio codec bring-up and diagnostics baseline` 已完成
- `audible verification` 不作为当前 issue 的关闭前提
- 若后续接入外接喇叭，再单独开一个小功能点做 `speaker audible verification`

## 6. 后续建议

下一步更合理的拆分方式是：

1. 当前 `#6` 按 bring-up 完成收口
2. 若后续接入外接喇叭，新增一个独立 issue：
   `M3: external speaker audible verification`
3. 在此之后再继续推进 `ESP-SR` 或语音链路上层能力
