# firmware-size-reduction Plan

## 1. 背景

当前 `M4 gateway_service` 骨架已经在本地硬件上通过验证，但 `factory` app 分区只剩约 1% 空余：

- `p4home_firmware.bin = 0x1fa170`
- `factory app partition = 0x200000`
- 剩余空间约 `0x5e90`

如果继续推进 `M4/M5`，后续功能会直接碰到分区上限。

当前 `size-components` 结果显示，大头主要来自：

- `libflite_g2p.a`
- `liblvgl__lvgl.a`
- `libdl_lib.a`
- `libesp_timer.a`
- `liblwip.a`
- `libesp_audio_processor.a`

本轮不动 `ESP-SR` 模型链路和业务功能，先收低风险配置空间。

所属 Milestone: `M4`

## 2. 目标

- 在不回退当前本地功能的前提下回收 app 分区空间
- 优先采用低风险配置项减重
- 保持 `network/gateway/settings/display/touch/audio/sr` 当前验证基线不回归

## 3. 范围

包含：

- 调整编译优化策略为更偏 size
- 收紧日志 / 断言相关配置
- 关闭当前未使用的 `LVGL` examples
- 重新 build / flash / 验证镜像体积和启动基线

不包含：

- 调整分区表扩大 app 分区
- 移除 `ESP-SR`
- 大规模裁剪 `LVGL` widget 集
- 变更业务功能或 UI 结构

## 4. 设计方案

### 4.1 优先级

1. 先收配置项，不改功能结构
2. 先关确定未使用的能力，再考虑裁剪依赖
3. 只有当低风险配置不足时，才进入更激进的组件裁剪

### 4.2 计划采用的减重项

- `CONFIG_COMPILER_OPTIMIZATION_SIZE`
- 关闭 `CONFIG_LV_BUILD_EXAMPLES`
- 收紧默认日志级别
- 下调断言级别

## 5. 实现任务

1. 新增本 plan
2. 更新 `sdkconfig.defaults` / `sdkconfig`
3. 重新 build 并记录镜像大小变化
4. flash 到本地硬件并确认启动基线
5. 更新验证文档

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功
- 新镜像大小较当前版本下降

### 6.2 启动验证

- 原有 `VERIFY:network:*`
- 原有 `VERIFY:gateway:*`
- 原有 `VERIFY:settings:*`
- 原有 `VERIFY:display/touch/audio/sr:*`

### 6.3 风险回归

- 启动日志仍可用于定位问题
- UI 不因 `LVGL` 配置调整而损坏
- `ESP-SR` 启动路径不回归

## 7. 风险

- 过度裁剪日志会降低问题定位效率
- 过度裁剪 `LVGL` 选项会导致现有控件缺失
- 切换优化级别可能暴露时序差异

## 8. 完成定义

- 镜像体积显著下降
- 当前本地验证基线仍然通过
- 为后续 `M4/M5` 留出可继续迭代的空间

## 9. review 准备

在邀请用户 review 前补充：

- 采用了哪些减重项
- 新旧镜像大小对比
- 关键验证结果

## 10. 实际结果

- 已落地减重项：
  - `CONFIG_BOOTLOADER_LOG_LEVEL_WARN`
  - `CONFIG_LOG_DEFAULT_LEVEL_WARN`
  - `CONFIG_COMPILER_OPTIMIZATION_SIZE`
  - `CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_SILENT`
  - `CONFIG_LV_BUILD_EXAMPLES=n`
- 新镜像大小：
  - 首轮纯配置减重构建：`0x1fa170 -> 0x1c5f30`
  - 恢复 `WARN` 级别启动摘要与 `VERIFY:*` 后：`0x1c6be0`
  - app 分区空余：`0x5e90 (~1%) -> 0x39420 (~11%)`
- 体积热点仍主要集中在：
  - `libflite_g2p.a`
  - `liblvgl__lvgl.a`
  - `libdl_lib.a`
  - `libesp_timer.a`
  - `libesp_audio_processor.a`

## 11. 验证结论

- `idf.py build` 通过
- `idf.py size-components` 确认首轮减重有效
- 本地 `flash` 与冷启动串口已确认：
  - `network ready=yes`
  - `gateway ready=yes registered=yes state_synced=yes`
  - `settings service ready=yes`
  - `display/touch/audio/sr` 摘要均恢复可见
  - `VERIFY:network/gateway/settings/display/touch/audio/sr:*` 全部 `PASS`
  - `VERIFY:*` 标记在默认 `WARN` 日志级别下仍可见

## 12. 下一步

- 保留当前配置减重结果，作为后续 `M4/M5` 的新基线
- 如果镜像再次逼近分区上限，再进入第二轮更激进裁剪：
  - 针对 `LVGL` widget 集做按需关闭
  - 审查 `ESP-SR / flite` 依赖链的可裁剪项
