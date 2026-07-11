# esp-sr-runtime-loop Plan

## 1. 背景

立项时工程已经完成：

- `ESP-SR` 依赖接入
- `model partition + model staging`
- `audio` 启动自检
- `AFE` runtime selftest

但仍缺少一个关键阶段：让 `AFE` 在系统启动后持续运行，而不是只在 boot 期间做一次最小自检。

所属 Milestone: `M3`

## 2. 目标

- 将 `AFE` 从启动期一次性自检推进到持续 runtime loop
- 将音频占用方显式化，避免后续 `audio_service` / `display_service` / `sr_service` 争用资源时难以定位
- 保持现有启动自检与机器可读 verify marker 可用

## 3. 范围

包含：

- 更新 `sr_service` 启动行为，创建后台 runtime task
- 更新 `audio_service`，增加 owner 文本
- 更新 `display_service`，让 UI 对“音频被占用”给出明确提示
- 重新进行本地 `flash + serial` 硬件验证

不包含：

- wake word 业务消费
- 命令词识别
- UI 侧唤醒态
- 家控动作联动

## 4. 设计方案

### 4.1 模块拆解

- `sr_service_init()` 完成 runtime selftest 后启动后台 `sr_runtime` task
- `audio_service` 继续作为 microphone stream 入口，但增加 owner 跟踪
- `app_main` 输出新的 `VERIFY:sr:runtime_loop`

### 4.2 控制流

- `board_support_init()`
- `audio_service_init()`
- `sr_service_init()`
- `AFE runtime selftest`
- `AFE runtime loop start`
- `app_main` 输出启动期 `VERIFY:sr:*`
- 后台 task 持续 `feed/fetch`

## 5. 实现任务

1. 在 `audio_service` 中增加 owner 跟踪
2. 在 `sr_service` 中加入后台 runtime loop task
3. 在 `display_service` 中补充 owner-aware 提示
4. 在启动日志中增加 `VERIFY:sr:runtime_loop`
5. 执行本地实机烧录和串口验证
6. 记录持续 loop 与 owner 模型的边界

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功

### 6.2 功能验证

- 启动日志出现 `VERIFY:sr:afe_runtime:PASS`
- 启动日志出现 `VERIFY:sr:runtime_loop:PASS`
- 启动日志出现 `owner=sr_runtime_loop`

### 6.3 运行验证

- heartbeat 之后 runtime iteration 持续增长
- `runtime_fetch_count` 持续增长
- 至少一段时间内没有 panic 或重启

### 6.4 回归验证

- 现有 `audio` startup selftest 不应被破坏
- 启动期 `VERIFY:audio:*` 仍应通过

## 7. 风险

- 语音后台 loop 常驻后，会长期占用 microphone 路径
- 若 UI 人工诊断仍尝试同时访问 microphone，必须依赖 owner 模型做边界控制
- `VERIFY:sr:runtime_loop` 若使用不稳定时序信号，容易误报

## 8. 完成定义

- 本地串口日志可以直接证明 `AFE` 持续 runtime loop 已启动
- `audio owner` 可以直接解释当前音频占用方
- 后续唤醒词状态机可以基于已有 runtime loop 继续搭建

## 9. review 结果

### 已完成的实现项

- `sr_service` 已加入后台 runtime loop task。
- `audio_service` 已增加 owner 跟踪，便于解释 microphone 占用方。
- `display_service` 已补充 owner-aware 提示。
- 启动日志已增加 `VERIFY:sr:runtime_loop`。
- 技术说明已沉淀到 [m3-esp-sr-runtime-loop.md](/Users/andyhao/workspace/p4home/docs/m3-esp-sr-runtime-loop.md)。

### 已完成的验证项

- 对应实现已随提交 `5477880 Add ESP-SR runtime loop and audio ownership diagnostics` 落地。
- 后续固定命令 baseline 已基于该 runtime loop 继续推进。

### 待重点查看的文件

- [sr_service.c](/Users/andyhao/workspace/p4home/firmware/components/sr_service/sr_service.c)
- [audio_service.c](/Users/andyhao/workspace/p4home/firmware/components/audio_service/audio_service.c)
- [display_service.c](/Users/andyhao/workspace/p4home/firmware/components/display_service/display_service.c)
