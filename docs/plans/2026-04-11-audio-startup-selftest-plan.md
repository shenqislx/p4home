# audio-startup-selftest Plan

## 1. 背景

当前 `M3` 音频链路已经支持：

- 手动触发 `Play Test Tone`
- 手动触发 `Capture Mic Sample`
- 持续 `Mic Meter`

但启动期的机器可读标记仍然是：

- `VERIFY:audio:tone_played:FAIL`
- `VERIFY:audio:mic_capture:FAIL`

根因不是 codec 初始化失败，而是当前启动路径只做 codec init，不会自动执行 tone write 或 microphone capture。这样会让本地烧录后的串口日志无法直接反映音频 runtime 路径是否可用。

所属 Milestone: `M3`

## 2. 目标

- 在启动阶段增加最小音频自检
- 让串口日志中的 `VERIFY:audio:tone_played` 与 `VERIFY:audio:mic_capture` 具备真实判定意义
- 保持现有手动按钮与 mic meter 诊断能力不变

## 3. 范围

包含：

- 更新 `audio_service` 启动行为
- 补充一份技术文档说明启动自检语义
- 重新进行本地 `flash + serial` 硬件验证

不包含：

- 完整连续录音 runtime
- 语音唤醒状态机
- 外接喇叭可听声主观验收

## 4. 设计方案

### 4.1 模块拆解

- `audio_service_init()` 完成 codec 初始化后，顺序执行：
  - 一次最小 speaker tone write
  - 一次最小 microphone sample capture
- 自检失败只记录 warning，不应让整机启动失败
- 现有手动按钮仍复用同一套 audio service API

### 4.2 控制流

- `board_support_init()`
- `audio_service_init()`
- `speaker/microphone codec init`
- `startup selftest`
- 更新状态位
- `app_main` 输出启动期 `VERIFY:audio:*`

## 5. 实现任务

1. 将 tone write 抽成可复用内部 helper
2. 在 `audio_service_init()` 中加入启动自检
3. 新增技术文档，明确启动自检与手动诊断的边界
4. 执行本地实机烧录和串口验证

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功

### 6.2 功能验证

- 启动日志出现 `VERIFY:audio:tone_played:PASS`
- 启动日志出现 `VERIFY:audio:mic_capture:PASS`

### 6.3 回归验证

- 现有 `Play Test Tone`
- `Capture Mic Sample`
- `Mic Meter`

不应被破坏。

### 6.4 硬件/联调验证

- 本地 `flash + serial capture` 成功
- 若 speaker 可听声仍依赖外接喇叭，应在文档中单独说明，不与 tone write 软件验证混淆

## 7. 风险

- 启动时会增加一次短音频自检，若接了外接喇叭，可能听到短提示音
- 若 microphone capture 受环境噪声影响，其数值可能变化，但只要 capture 成功就应视为软件路径通过

## 8. 完成定义

- 启动期 `audio` 标记可用于本地硬件裁决
- 本地烧录日志可以直接证明音频 runtime 路径已执行

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待用户重点查看的文件
