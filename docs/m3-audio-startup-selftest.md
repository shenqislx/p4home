# M3 Audio Startup Selftest

## 1. 背景

在 [m3-audio-codec-bringup.md](/Users/andyhao/workspace/p4home/docs/m3-audio-codec-bringup.md) 完成后，项目已经具备：

- 手动 `Play Test Tone`
- 手动 `Capture Mic Sample`
- `Mic Meter`

但启动期的机器可读标记仍然停留在：

- `VERIFY:audio:tone_played:FAIL`
- `VERIFY:audio:mic_capture:FAIL`

问题不在 codec 初始化，而在于启动路径当时只做了 `speaker/microphone codec init`，没有在 boot 阶段真实执行 tone write 和 microphone capture。

这会让本地烧录后的串口 artifact 无法直接判断音频 runtime 路径是否已经通了。

## 2. 本次交付

- 在 [audio_service.c](/Users/andyhao/workspace/p4home/firmware/components/audio_service/audio_service.c) 中新增启动期最小音频自检
- 启动时顺序执行：
  - 一次短 speaker tone write
  - 一次 microphone sample capture
- 保留现有手动按钮和 `Mic Meter` 逻辑不变
- 重新完成一次本地 `flash + serial capture` 验证

## 3. 实现说明

### 3.1 启动自检语义

`audio_service_init()` 现在不再只做 codec 初始化，还会在初始化后调用启动自检：

- speaker 自检：短时写入一段方波 PCM，用来证明 `open -> write -> close` 路径可用
- microphone 自检：读取一次 PCM sample，用来证明 `open -> read -> close` 路径可用

自检失败只记 warning，不会阻塞整机启动。

### 3.2 与手动诊断的边界

启动自检解决的是“串口上是否能直接证明 runtime 路径已经执行过”。

它不替代：

- 手动 `Play Test Tone`
- 手动 `Capture Mic Sample`
- `Mic Meter`
- 外接喇叭的主观可听声验证

换句话说：

- `VERIFY:audio:tone_played:PASS` 代表软件写音路径已执行成功
- 不代表用户一定已经听到可听声

## 4. 本地实机验证

### 4.1 构建

执行：

```sh
cd /Users/andyhao/workspace/p4home/firmware
. ../scripts/activate-idf-v5.5.4.sh
export IDF_SKIP_CHECK_SUBMODULES=1
idf.py build
```

结果：

- 构建成功

### 4.2 烧录与串口采集

本地验证 artifact：

- [hardware-validation-manifest.json](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-audio-startup-selftest/hardware-validation-manifest.json)
- [monitor.log](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-audio-startup-selftest/monitor.log)

本次验证目标：

- `VERIFY:audio:tone_played:PASS`
- `VERIFY:audio:mic_capture:PASS`

### 4.3 关键日志

串口日志确认：

```text
audio_service: startup speaker selftest wrote 2048 bytes
audio_service: microphone capture bytes=2048 samples=1024 ...
audio_service: startup microphone selftest complete
p4home_main: VERIFY:audio:tone_played:PASS
p4home_main: VERIFY:audio:mic_capture:PASS
```

这说明启动期已经能在无需手动点按钮的情况下，直接证明：

- speaker 写音路径已执行
- microphone 采样路径已执行

## 5. 当前残留问题

日志中仍出现：

```text
E (...) i2s_common: i2s_channel_disable(...): the channel has not been enabled yet
```

当前它没有阻止：

- speaker startup selftest 成功
- microphone startup selftest 成功
- 最终 `VERIFY:audio:*` 变为 `PASS`

因此它暂时属于已知噪声/清理项，而不是本次功能的失败条件。后续若继续打磨 `M3`，应再单独收敛这组 `i2s` 关流时序告警。

## 6. 结论

`M3` 的音频启动自检已经完成：

- 启动串口日志可以直接裁决 `audio` runtime 基线
- `VERIFY:audio:tone_played` 与 `VERIFY:audio:mic_capture` 已从 `FAIL` 变为 `PASS`
- 手动音频诊断路径保持可用

下一个合理动作是：

- 单独清理 `i2s_channel_disable` 告警
- 或继续推进 `AFE feed/fetch` 与更上层语音 runtime 验证
