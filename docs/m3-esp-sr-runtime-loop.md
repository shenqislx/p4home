# M3 ESP-SR Runtime Loop

## 1. 背景

在 [m3-esp-sr-afe-runtime-selftest.md](/Users/andyhao/workspace/p4home/docs/m3-esp-sr-afe-runtime-selftest.md) 完成后，工程已经证明：

- `ESP-SR` 模型可加载
- `AFE` 预检查通过
- 启动期最小 `feed/fetch` 自检通过

但那一步仍然只是“一次性启动自检”。  
它还没有把 `AFE` 变成持续运行的语音前端，也没有把音频资源归属从隐式状态变成显式状态。

## 2. 本次交付

- 在 [sr_service.c](/Users/andyhao/workspace/p4home/firmware/components/sr_service/sr_service.c) 中增加后台 `AFE runtime loop`
- 在 [audio_service.c](/Users/andyhao/workspace/p4home/firmware/components/audio_service/audio_service.c) 中增加显式 `audio owner`
- 在 [display_service.c](/Users/andyhao/workspace/p4home/firmware/components/display_service/display_service.c) 中让 UI 诊断在音频被占用时输出明确 owner 文本
- 在 [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c) 中新增 `VERIFY:sr:runtime_loop`
- 完成本地真实 `flash + serial capture` 验证

## 3. 实现说明

### 3.1 持续 runtime loop

`sr_service_init()` 在完成 runtime selftest 后，现在会继续创建后台任务：

- 新建 `afe_data`
- 启动 `sr_runtime` task
- task 持续读取 microphone sample
- 组装 `MR` 输入帧
- 连续执行 `afe->feed(...)`
- 连续执行 `afe->fetch_with_delay(...)`

这一步的意义是把 `AFE` 从“启动时证明能跑一下”推进到“系统启动后持续运行”。

### 3.2 audio owner 模型

之前 `audio_service` 只有一个模糊的 `busy` 状态。  
这次把 owner 文本显式化，当前典型 owner 包括：

- `speaker_tone`
- `microphone_capture`
- `display_mic_meter`
- `sr_runtime_selftest`
- `sr_runtime_loop`

这样一来，后续如果 UI 手动点 `Mic Meter` 或 `Mic Sample`，串口和界面都能直接说明当前是谁占用了音频，而不是只给一个泛化的 `busy` 错误。

### 3.3 启动期裁决语义

`VERIFY:sr:runtime_loop` 当前按“后台任务已成功启动”裁决，而不是按“task 已经进入 active 循环中的某个瞬间”裁决。

原因是启动日志存在天然时序窗口：

- `sr_service` 可以先成功创建 task
- `app_main` 可能在 task 首次更新 `active` 前就输出 verify marker

如果按 `active` 裁决，会造成真实功能已启动但启动标记误报 `FAIL`。

## 4. 本地实机验证

### 4.1 artifact

本地验证 artifact：

- [hardware-validation-manifest.json](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-runtime-loop/hardware-validation-manifest.json)
- [monitor.log](/Users/andyhao/workspace/p4home/firmware/build/local-hardware-validation-sr-runtime-loop/monitor.log)

### 4.2 启动期关键证据

串口日志确认：

```text
p4home_main: audio service ... busy=yes owner=sr_runtime_loop
p4home_main: VERIFY:sr:afe_runtime:PASS
p4home_main: VERIFY:sr:runtime_loop:PASS
```

这说明：

- 启动后 microphone 已经被 `sr_runtime_loop` 持有
- `AFE runtime` 通过
- runtime loop 启动裁决通过

### 4.3 运行中关键证据

后续 heartbeat 期间，runtime 计数持续增长：

```text
sr_service: runtime loop iterations=64 fetch=64 vad_speech=60 wake_events=0
sr_service: runtime loop iterations=128 fetch=128 vad_speech=124 wake_events=0
sr_service: runtime loop iterations=320 fetch=320 vad_speech=297 wake_events=0
```

这说明后台任务不是只启动一下，而是在持续：

- 读麦克风
- feed AFE
- fetch AFE 输出
- 统计 `VAD` / `WakeNet` 结果

## 5. 当前边界

本次完成的是：

- `AFE` 持续 runtime loop
- `audio owner` 显式化
- 启动期 `runtime_loop` 机器可读裁决

本次还未完成的是：

- 真正的 wake word 事件消费
- 唤醒后的状态机
- 命令词识别
- 与 UI/设备动作的联动

## 6. 结论

`M3` 的本地语音前端已经从“可自检”推进到“可持续运行”：

- `AFE` 后台 loop 已常驻
- 音频 owner 边界已显式化
- 串口 artifact 可以直接证明 `sr_runtime_loop` 已启动并持续推进

下一个合理动作是：

- 消费 `WakeNet` 命中事件
- 建立最小语音状态机
- 决定 `Mic Meter` 等人工诊断在语音常驻运行期间的交互策略
