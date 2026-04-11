# esp-sr-model-partition-staging Plan

## 1. 背景

当前 `M3 ESP-SR AFE scaffold` 已完成依赖接入与启动预检查，但 `sr_service` 仍然卡在：

- partition table 中没有 `model` 分区
- `esp_srmodel_init("model")` 无法挂载模型
- `AFE` 只能停留在 preflight 失败状态

这意味着当前工程虽然已经接入 `ESP-SR`，但还没有把模型文件真正纳入 `build/flash` 链路，无法形成下一步唤醒词与命令词验证所需的最小底座。

所属 Milestone: `M3`

## 2. 目标

- 为固件分区表增加 `model` 分区
- 让 `ESP-SR` 模型随 `idf.py flash` 进入真实烧录链路
- 固定一组最小模型选择，先打通 `AFE` 可用性
- 在启动日志中输出可供硬件验证使用的 `sr` 标记

## 3. 范围

包含：

- 更新 `firmware/partitions.csv`
- 更新 `firmware/sdkconfig.defaults`
- 更新启动日志中的 `sr` 验证标记
- 补充一份 `M3` 技术文档，记录分区与模型 staging 约束

不包含：

- `AFE feed/fetch` 运行时循环
- 唤醒词状态机
- MultiNet 命令词配置
- Home Assistant 或网关接入

## 4. 设计方案

### 4.1 目录影响

- 新增 `docs/plans/2026-04-10-esp-sr-model-partition-staging-plan.md`
- 新增 `docs/m3-esp-sr-model-partition-staging.md`
- 更新 `firmware/partitions.csv`
- 更新 `firmware/sdkconfig.defaults`
- 更新 `firmware/main/app_main.c`

### 4.2 模块拆解

- `partitions.csv` 增加标签名固定为 `model` 的数据分区
- `sdkconfig.defaults` 选择 `CONFIG_MODEL_IN_FLASH` 与一组最小 WakeNet 模型
- `espressif/esp-sr` 组件自身负责生成 `srmodels.bin` 并挂接到 `flash` 目标
- `app_main` 输出 `VERIFY:sr:*` 标记，便于串口 artifact 裁决

### 4.3 数据流 / 控制流

- `idf.py build` 读取 `sdkconfig`
- `esp-sr` 组件根据 `sdkconfig` 选择模型并生成 `build/srmodels/srmodels.bin`
- `idf.py flash` 除应用镜像外，还会把 `srmodels.bin` 烧录到 `model` 分区
- 板子启动后，`sr_service` 挂载 `model` 分区并执行 `AFE` 预检查
- 启动日志输出模型与 `AFE` ready 状态，供后续硬件验证读取

## 5. 实现任务

1. 为 `ESP-SR` 增加 `model` 分区
2. 固定最小模型选择，确保 `srmodels.bin` 非空
3. 为串口日志补充 `sr` 机器可读标记
4. 构建验证 `srmodels.bin` 已进入工程输出

## 6. 测试方案

### 6.1 构建验证

- `idf.py reconfigure build` 成功
- `build/srmodels/srmodels.bin` 成功生成
- partition table 中存在 `model` 分区

### 6.2 功能验证

- 启动日志不再出现 `model partition 'model' not found`
- `sr_service` 能看到非零 `model_count`
- `VERIFY:sr:models:PASS` 与 `VERIFY:sr:afe_preflight:PASS` 可用于后续硬件验证

### 6.3 回归验证

- 不影响现有显示、触摸、音频初始化路径
- 不改变现有 `ESP-IDF v5.5.4` 激活方式

### 6.4 硬件/联调验证

- `idf.py flash` 时模型分区随应用一并烧录
- 串口日志能稳定输出 `sr` 状态与验证标记
- 若 `AFE` 仍失败，失败点应收敛到具体模型或运行时配置，而不是分区缺失

## 7. 风险

- 后续如果切换更大的 WakeNet 或 MultiNet 组合，`model` 分区大小可能需要再次调整
- 当前选择的 WakeNet 只用于打通 `M3` 模型链路，不代表最终产品唤醒词决策
- `build` 本地通过不等于实机 `AFE` 运行完全稳定，仍需硬件串口验证

## 8. 完成定义

- 仓库存在 `model` 分区并可构建
- `srmodels.bin` 已进入 `build/flash` 链路
- 启动日志能输出明确的 `sr` 模型与 `AFE` 状态

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待用户重点查看的文件
