# network-service-scaffold Plan

## 1. 背景

当前项目已经完成：

- `M1` 板级 bring-up
- `M2` 原生 `LVGL` 页面骨架
- `M3` 音频与 `ESP-SR` 本地语音前端

按照 [project-milestones.md](/Users/andyhao/workspace/p4home/docs/project-milestones.md) 的顺序，下一步应进入 `M4`，先建立“面板与外部系统的数据接口骨架”，避免后续接入 `Home Assistant` 时把现有固件结构推倒重来。

当前 `network_service` 仍是占位目录，缺少：

- 网络栈初始化入口
- 网络身份（`hostname` / `device_id`）抽象
- 可复用的网络状态摘要接口
- 启动期可验证的 `network` 自检标记

所属 Milestone: `M4`

## 2. 目标

- 建立最小 `network_service` 组件
- 打通 `esp_netif`、默认事件循环和默认 `Wi-Fi STA netif`
- 提供稳定的 `hostname` / `device_id` 生成与状态摘要接口
- 将 `network_service` 接入 `board_support` 与启动日志，形成可验证的启动基线

## 3. 范围

包含：

- 新增 `network_service` 头文件、源文件、CMake 配置
- 初始化 `esp_netif`
- 初始化默认事件循环
- 创建默认 `Wi-Fi STA netif`
- 生成并设置默认 `hostname`
- 基于 MAC 生成 `device_id`
- 输出 network 摘要与 `VERIFY:network:*` 标记

不包含：

- Wi‑Fi 配网页面
- 保存 SSID / password
- 自动联网 / 重连策略
- SNTP
- MQTT / HTTP / WebSocket
- Home Assistant 或任何业务实体同步

## 4. 设计方案

### 4.1 模块职责

- `network_service`
  - 负责网络栈最小初始化
  - 负责维护 `ready / event_loop_ready / sta_netif_ready` 状态
  - 负责提供 `hostname`、`device_id`、`mac` 摘要
- `board_support`
  - 负责在启动链路中初始化 `network_service`
  - 对外暴露 network 摘要查询接口
- `app_main`
  - 输出 network 启动摘要
  - 增加 `VERIFY:network:*` 标记

### 4.2 初始化顺序

- `diagnostics_service_log_boot_banner()`
- `board_support_init()`
- `settings_service_init()`
- `network_service_init()`
- `display/touch/audio/sr` 初始化

将 `network_service` 放在较早阶段，保证后续远端接入能力不会与 UI/语音强耦合。

### 4.3 数据模型

- `ready`
- `esp_netif_ready`
- `event_loop_ready`
- `sta_netif_ready`
- `wifi_started`（本阶段默认 `false`）
- `hostname`
- `device_id`
- `mac_text`

## 5. 实现任务

1. 新增 `network_service` 组件及接口
2. 在 `board_support` 中接入 network 初始化与摘要接口
3. 在 `app_main` 中增加 network 日志与 verify marker
4. 更新 `network_service/README.md`
5. 执行本地构建与串口验证

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功

### 6.2 功能验证

- 启动日志出现 `network ready=yes`
- 启动日志出现 `hostname=...`
- 启动日志出现 `device_id=...`
- 启动日志出现 `sta_netif_ready=yes`

### 6.3 回归验证

- `display/touch/audio/sr/settings` 摘要与 `VERIFY:*` 不回归
- 网络初始化不阻塞 `app_main`

### 6.4 硬件/联调验证

- 本地烧录后可抓到 network 启动摘要
- 本地烧录后 `VERIFY:network:stack:PASS`
- 本地烧录后 `VERIFY:network:sta_netif:PASS`

## 7. 风险

- `esp_netif` / 默认事件循环初始化若重复调用，可能引入启动错误
- 过早直接启动 `Wi-Fi` 可能带来无意义扫描和额外噪音日志
- 若 `hostname` / `device_id` 生成规则不稳定，后续外部系统绑定会被破坏

## 8. 完成定义

- `network_service` 不再是占位目录
- 固件具备最小网络栈骨架和稳定网络身份摘要
- 后续接入 `Wi-Fi` 配网、时间同步、HA 网关时不需要改动启动骨架

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待重点查看的文件

### 已完成的实现项

- 新增 `network_service` 组件，完成 `esp_netif`、默认事件循环和 `Wi-Fi STA` 形态 `esp_netif` 初始化
- 基于 `ESP32-P4` 可用的 `base MAC` 生成并暴露 `hostname`、`device_id`、`mac_text`
- 在 `board_support` 中接入 `network_service_init()` 与 network 摘要透传接口
- 在 `app_main` 中增加 network 启动摘要和 `VERIFY:network:stack/event_loop/sta_netif`
- 更新 `network_service/README.md`，明确当前职责和后续扩展边界

### 已完成的验证项

- `idf.py build` 成功
- 已烧录到本地 `ESP32-P4 EVB`（`/dev/cu.usbserial-210`）
- 冷启动串口日志 [p4home-serial-20260415-network-service-v2.log](/tmp/p4home-serial-20260415-network-service-v2.log) 已确认：
  - `network ready=yes`
  - `hostname=p4home-p4-e18af5`
  - `device_id=p4-e18af5`
  - `VERIFY:network:stack:PASS`
  - `VERIFY:network:event_loop:PASS`
  - `VERIFY:network:sta_netif:PASS`
- `settings/display/touch/audio/sr` 现有 `VERIFY:*` 均未回归

### 待重点查看的文件

- [network_service.c](/Users/andyhao/workspace/p4home/firmware/components/network_service/network_service.c)
- [network_service.h](/Users/andyhao/workspace/p4home/firmware/components/network_service/include/network_service.h)
- [board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c)
- [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)

### 剩余风险

- 当前只是网络栈与设备身份骨架，尚未进入真实联网、时间同步或网关双向通路
- `factory` app 分区仅剩约 `0x8620` 字节（约 2%）空余，后续 `M4/M5` 再扩功能前需要开始治理固件体积
- 启动期仍存在少量 `i2s_channel_disable(...): the channel has not been enabled yet` 日志，本计划按当前约定暂不处理
