# esp-sr-afe-runtime-selftest Plan

## 1. 背景

当前工程已经完成：

- `ESP-SR` 依赖接入
- `model partition + model staging`
- `audio` 启动自检
- `AFE` 预检查

但还缺少一个关键裁决点：本地实机串口日志仍无法直接证明 `AFE feed/fetch` runtime 路径已经真的跑通。

所属 Milestone: `M3`

## 2. 目标

- 在启动阶段增加最小 `AFE runtime selftest`
- 让串口日志中的 `VERIFY:sr:afe_runtime` 具备真实判定意义
- 不引入长期语音循环或唤醒词状态机

## 3. 范围

包含：

- 更新 `sr_service` 启动行为
- 复用 `audio_service` 的 microphone stream 读取能力
- 补充一份技术文档说明 runtime selftest 的边界
- 重新进行本地 `flash + serial` 硬件验证

不包含：

- 持续 AFE runtime task
- WakeNet 状态机
- MultiNet 命令词
- UI 侧语音交互联动

## 4. 设计方案

### 4.1 模块拆解

- `sr_service_init()` 在 preflight 之后追加一次最小 runtime selftest
- `audio_service` 提供原始麦克风 sample 读取接口
- `app_main` 输出新的 `VERIFY:sr:afe_runtime`

### 4.2 控制流

- `board_support_init()`
- `audio_service_init()`
- `sr_service_init()`
- `model load`
- `AFE config/init`
- `AFE runtime selftest`
- 更新状态位
- `app_main` 输出启动期 `VERIFY:sr:*`

## 5. 实现任务

1. 在 `audio_service` 中暴露原始 microphone sample 读取接口
2. 在 `sr_service` 中加入最小 `feed/fetch` runtime selftest
3. 在启动日志中增加 `VERIFY:sr:afe_runtime`
4. 执行本地实机烧录和串口验证
5. 记录实现边界与残留风险

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功

### 6.2 功能验证

- 启动日志出现 `VERIFY:sr:models:PASS`
- 启动日志出现 `VERIFY:sr:afe_preflight:PASS`
- 启动日志出现 `VERIFY:sr:afe_runtime:PASS`

### 6.3 回归验证

- 现有 `audio` startup selftest 不应被破坏
- 启动后不应出现 panic 或重启

### 6.4 硬件验证

- 本地 `flash + serial capture` 成功
- artifact 中可看到 `afe_runtime_ready=yes`

## 7. 风险

- 启动路径增加 runtime selftest，可能放大音频/I2S 时序问题
- 若在启动期引入过大栈分配，可能触发 `main` 任务栈保护
- 当前 `input_format = "MR"` 依赖 microphone + reference 输入拼装逻辑正确

## 8. 完成定义

- 启动期 `sr` 标记可用于本地硬件裁决
- 本地烧录日志可以直接证明 `AFE` 已真实 `feed/fetch`

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 残留 `i2s` 时序噪声的边界说明
