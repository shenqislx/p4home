# self-hosted-flash-serial-workflow Plan

## 1. 背景

当前仓库的 self-hosted `ESP-IDF` 构建 workflow 已经跑通，说明 GitHub Actions 可以成功调度到本地 `macOS ARM64` runner。下一步需要把链路推进到真实硬件验证，覆盖最小的 `build -> flash -> serial monitor` 闭环。

## 2. 目标

- 新增一个可手动触发的 GitHub Actions workflow
- 仅调度到带 `esp32-p4` 标签的硬件 runner
- 在 runner 上完成 `idf.py fullclean build`
- 对指定串口执行 `idf.py flash`
- 采集一段启动串口日志并校验关键启动标记

## 3. 范围

包含：

- 新增硬件冒烟验证 workflow
- 允许手动输入串口设备路径与串口采集时长
- 上传串口日志为 workflow artifact

不包含：

- 自动恢复或多轮重试逻辑
- 屏幕/触摸/音频的深度硬件验收
- 手机通知
- push / pull request 自动触发策略

## 4. 设计方案

### 4.1 目录影响

- 新增 `.github/workflows/firmware-self-hosted-flash-serial.yml`
- 新增 `docs/plans/2026-04-05-self-hosted-flash-serial-workflow-plan.md`

### 4.2 模块拆解

- GitHub Actions workflow 负责调度到 `self-hosted macOS ARM64 esp32-p4` runner
- 固件构建沿用项目内 `ESP-IDF v5.5.4` 激活脚本
- 串口采集通过 `python3` 包装 `idf.py monitor`，在固定超时后终止并输出日志

### 4.3 数据流 / 控制流

- 用户在 GitHub Actions 页面手动触发 workflow
- 传入串口路径与日志采集秒数
- workflow 激活 `ESP-IDF v5.5.4`
- workflow 执行 `idf.py fullclean build`
- workflow 执行 `idf.py -p <port> flash`
- workflow 运行 `idf.py -p <port> monitor` 并采集日志
- workflow 校验日志中是否出现关键启动标记
- workflow 上传日志 artifact

## 5. 实现任务

1. 新增手动触发的 flash/serial workflow
2. 增加可配置的串口和采样时长输入
3. 将串口日志保存并作为 artifact 上传
4. 增加最小关键日志断言，作为硬件冒烟验证结果

## 6. 测试方案

### 6.1 构建验证

- 校验 workflow YAML 结构和命令路径
- 确认 workflow 使用 `ESP-IDF v5.5.4`
- 确认 `idf.py fullclean build` 在 runner 上通过

### 6.2 功能验证

- 手动触发 workflow，确认 job 仅在带 `esp32-p4` 标签的 runner 上执行
- 确认能成功烧录 `/dev/cu.usbserial-10`
- 确认能生成并上传串口日志 artifact

### 6.3 回归验证

- 确认 build-only workflow 不受影响
- 确认未修改现有固件源码和本地激活脚本行为

### 6.4 硬件/联调验证

- 串口启动日志应包含 `ESP-IDF v5.5.4`
- 串口启动日志应包含 `diagnostics: p4home firmware starting`
- 串口启动日志应包含 `board_support: board=ESP32-P4 Function EV Board`

## 7. 风险

- runner 进程若离线，workflow 会持续排队
- 串口名称在 macOS 上可能变化，需要手动输入覆盖默认值
- `idf.py monitor` 为交互命令，超时回收依赖 `python3` 子进程管理
- 当前构建仍依赖 `IDF_SKIP_CHECK_SUBMODULES=1`

## 8. 完成定义

- 仓库内存在可手动触发的 flash/serial workflow
- workflow 仅运行在带 `esp32-p4` 标签的硬件 runner 上
- workflow 能上传串口日志并基于关键标记给出通过/失败结果

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待用户重点查看的文件
