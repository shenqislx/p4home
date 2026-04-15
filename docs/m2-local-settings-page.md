# m2-local-settings-page

## 1. 来源

- Derived from plan: `docs/plans/2026-04-15-local-settings-page-plan.md`

## 2. 实现与测试记录

# local-settings-page Plan

## 1. 背景

当前固件已经具备：

- `LCD + LVGL` 启动页
- `GT911` 触摸输入接入
- `audio` 本地诊断按钮
- `ESP-SR` runtime 与命令基线

但 `docs/p4-local-validation-plan.md` 中“最小可行验证清单”的第 7 项 `本地设置页` 仍未落地，`settings_service` 目录也仍是占位状态。这样会导致：

- `M2` 的页面骨架仍停留在单页诊断面板
- 本地配置与 `NVS` 还没有真实落点
- 后续进入网络、设备接入、OTA 预留时缺少稳定的本地配置入口

所属 Milestone: `M2`

## 2. 目标

- 建立最小 `settings_service`，把 `NVS` 持久化真正接入固件
- 在现有 `LVGL` 诊断界面上增加 `home/settings` 双页导航
- 提供一个安全、可验证的本地设置项，证明设置页与持久化链路可用

## 3. 范围

包含：

- 新增 `settings_service` 组件
- 在启动期初始化 `NVS` 并记录 `boot_count`
- 增加 `startup_page` 设置项并持久化
- 将现有 `display_service` 拆成 `home/settings` 两个页面容器
- 在串口日志中输出 settings 摘要

不包含：

- Wi-Fi 配网
- OTA 真正接入
- 文本输入、软键盘或复杂设置表单
- 业务设备配置

## 4. 设计方案

### 4.1 目录影响

- 新增 `firmware/components/settings_service/`
- 更新 `board_support`
- 更新 `display_service`
- 更新 `app_main`

### 4.2 模块拆解

- `settings_service`
  - 负责 `nvs_flash` 初始化
  - 负责 `boot_count` 读取与递增
  - 负责 `startup_page` 的读取与写回
- `board_support`
  - 在板级 bring-up 早期初始化 settings
  - 对外暴露 settings 摘要查询接口
- `display_service`
  - 维护 `home` / `settings` 页面容器
  - 在 settings 页展示设备信息、启动次数、当前启动页设置
  - 允许用户将下次启动页保存为 `home` 或 `settings`

### 4.3 数据流 / 控制流

- `app_main`
- `board_support_init()`
- `settings_service_init()`
- `display_service_init()`
- `display_service` 根据 `startup_page` 决定默认展示页
- 用户在 settings 页点击保存
- `settings_service_set_startup_page()`
- 下次重启时从 `NVS` 恢复设置

## 5. 实现任务

1. 新增 `settings_service` 及头文件、CMake 配置
2. 在 `board_support` / `app_main` 中接入 settings 摘要与启动日志
3. 将 `display_service` 调整为最小双页导航，并加入 settings 页
4. 执行本地 `idf.py build` 验证

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功

### 6.2 功能验证

- 启动日志出现 `settings ready=yes`
- 启动日志出现 `boot_count=...`
- 界面可以在 `Home` 与 `Settings` 之间切换
- settings 页可以保存 `startup_page`

### 6.3 回归验证

- 现有 touch/audio/voice 诊断 UI 仍可正常展示
- `VERIFY:audio:*` 与 `VERIFY:sr:*` 标记逻辑不被破坏

### 6.4 硬件/联调验证

- 本地烧录后可通过触摸进入 settings 页
- 改变 `startup_page` 后，重启能看到页面恢复

## 7. 风险

- `NVS` 初始化若处理不当，可能影响首次启动或分区兼容
- `display_service` 当前是单页实现，改成多页时容易误伤已有状态标签更新
- 若把“不安全”的硬件设置做成持久化，可能降低本地 bring-up 可恢复性

## 8. 完成定义

- `settings_service` 不再是占位目录
- UI 拥有最小 `home/settings` 页面骨架
- 本地设置页与 `NVS` 闭环已经建立
- 后续网络/设备/OTA 预留可基于该设置入口继续扩展

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
  `settings_service` 已接入 `NVS`，支持 `boot_count` 与 `startup_page`
  `display_service` 已从单页诊断页扩展为 `Home / Settings` 双页导航
  `board_support` / `app_main` 已增加 settings 摘要日志与 `VERIFY:settings:nvs`
- 已完成的验证项
  `idf.py build` 通过
  本地 `flash` 到 `/dev/cu.usbserial-210` 通过
  冷启动串口验证通过，日志确认 `display ready ... touch=yes`
  冷启动串口验证通过，日志确认 `settings ready=yes boot_count=11 startup_page=home`
  冷启动串口验证通过，日志确认 `VERIFY:settings:nvs:PASS`
  现有 `VERIFY:display:*`、`VERIFY:touch:*`、`VERIFY:audio:*`、`VERIFY:sr:*` 未回归
- 待用户重点查看的文件
  `firmware/components/settings_service/settings_service.c`
  `firmware/components/display_service/display_service.c`
  `firmware/components/board_support/board_support.c`
  `firmware/main/app_main.c`
- 当前残余风险
  启动过程中仍存在 4 条 `i2s_channel_disable(...): the channel has not been enabled yet` 告警，已验证不阻塞自检与 runtime；一次尝试修补 `managed_components/espressif__esp_codec_dev/platform/audio_codec_data_i2s.c` 会引入更差的 `i2s_channel_reconfig_std_slot invalid state`，因此该试验已回滚，后续应按“上游组件问题”单独立项处理
