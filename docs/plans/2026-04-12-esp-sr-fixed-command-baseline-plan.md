# esp-sr-fixed-command-baseline Plan

## 1. 背景

当前工程已经具备：

- `AFE runtime loop`
- 最小 `wake state machine`
- `WakeNet` / `VAD` 运行时统计

但还缺少一个真正的语音动作闭环：

- 没有 `MultiNet` 命令模型
- 没有命令窗口内的设备动作
- 启动期无法裁决 command baseline 是否建立

所属 Milestone: `M3`

## 2. 目标

- 将 `MultiNet7` 命令词模型接入到现有 `WakeNet` 状态机之后
- 增加一个低风险、可观察的最小设备动作
- 输出启动期 `VERIFY:sr:command_model` 和 `VERIFY:sr:command_set`

## 3. 范围

包含：

- 更新 `sdkconfig.defaults`，启用英文 `MultiNet7`
- 更新 `sr_service`，加入 fixed-command runtime
- 更新 `display_service`，提供 voice status 与 LCD backlight 动作
- 更新 `board_support` / `app_main`，暴露命令词状态与 verify marker
- 重新进行本地 `flash + serial` 硬件验证

不包含：

- 大规模命令词表
- 业务逻辑编排
- 复杂 UI 动画
- 远端 workflow 验证

## 4. 设计方案

### 4.1 固定命令

首批固定命令分两层：

- 官方 baseline：
  - `turn on the light`
  - `turn off the light`
  - `turn of the light`
- 用户自然别名：
  - `screen on`
  - `screen off`
  - `display on`
  - `display off`

英文命令统一走显式 phoneme，避免只靠字符串自动转换。

### 4.2 动作选择

首批动作选择为 LCD backlight 开关，因为它：

- 对系统风险低
- 实机可直接观察
- 不与当前 AFE runtime 主路径强耦合

### 4.3 启动验证

启动期至少要能稳定得到：

- `command_model_ready=yes`
- `command_set_ready=yes`
- `VERIFY:sr:command_model:PASS`
- `VERIFY:sr:command_set:PASS`

## 5. 实现任务

1. 在 `sdkconfig.defaults` 中启用 `CONFIG_SR_MN_EN_MULTINET7_QUANT`
2. 在 `sr_service` 中创建 `MultiNet` runtime，并装载固定命令表
3. 在 `display_service` 中提供 voice status 和 backlight 控制
4. 在 `app_main` 中增加新的 verify marker
5. 刷机并抓取本地串口 evidence
6. 记录 `sdkconfig` 覆盖默认配置的验证陷阱

## 6. 测试方案

### 6.1 构建验证

- `idf.py reconfigure build` 成功
- `build/srmodels/` 同时出现 `wn9_hiesp` 与 `mn7_en`
- flash 步骤继续包含 `0x710000 build/srmodels/srmodels.bin`

### 6.2 启动验证

- 串口出现 `Quantized MultiNet7 ... mn7_en`
- 启动期出现 `command_model_ready=yes`
- 启动期出现 `command_set_ready=yes`
- 新增 verify marker 为 `PASS`

### 6.3 运行验证

- runtime iteration 持续增长
- runtime loop 未被命令接入破坏
- 至少完成一次顺序正确的 `light_on -> light_off` backlight 动作验证
- `awake` 窗口内不再被重复 `WakeNet` 打断

## 7. 风险

- 本地已生成 `sdkconfig` 可能覆盖 `sdkconfig.defaults`，导致模型未实际打包
- 20 秒串口窗口不一定覆盖真实 wake word / command 命中
- 命令动作目前只证明 baseline 可运行，不证明产品交互已完成

## 8. 完成定义

- `mn7_en` 已进入 `model` 分区并可初始化
- 固定命令表已成功装载
- 启动期可以机器可读地裁决 command baseline
- 本地硬件上已验证最小 `wake -> command -> backlight action` 闭环
- 后续可以在此基础上继续做真实口播验收和业务动作扩展
