# gateway-service-scaffold Plan

## 1. 背景

当前项目已经具备：

- `M1` 板级 bring-up
- `M2` 原生 `LVGL` 页面骨架
- `M3` 音频与本地语音前端
- `M4` 第一阶段 `network_service` 骨架

但 `M4` 还缺少三块关键骨架：

- 设备注册模型
- 状态同步接口
- 命令下发接口

如果继续只在 `display_service` 里堆本地诊断按钮，后续接入 `Home Assistant` 或自定义网关时，UI、运行时状态和外部协议会重新耦合在一起。

所属 Milestone: `M4`

## 2. 目标

- 新增最小 `gateway_service`
- 建立稳定的设备注册模型
- 建立本地状态快照与同步接口
- 建立最小命令邮箱与执行通路
- 在 UI 中提供一个 `Gateway` 页作为页面模型初版

## 3. 范围

包含：

- 新增 `gateway_service` 组件
- 注册 `device_id` / `hostname` / `board_name` / `app_version` / `capabilities`
- 聚合本地面板状态并生成 gateway snapshot
- 提供本地命令邮箱，支持少量 demo command
- 在 `board_support` 中接入 gateway 注册、状态同步和命令执行
- 在 `display_service` 中新增 `Gateway` 页和 demo command 入口
- 在 `app_main` 中新增 `VERIFY:gateway:*` 与运行期命令轮询

不包含：

- 真实 `Wi‑Fi` 连接
- MQTT / HTTP / WebSocket
- Home Assistant 实体映射
- 米家联调
- 真实远端注册或下发协议

## 4. 设计方案

### 4.1 模块职责

- `gateway_service`
  - 持有注册信息
  - 持有最近一次状态快照
  - 管理单条 pending command 邮箱
  - 记录最近一次命令执行结果
- `board_support`
  - 聚合 `display/settings/network/audio/sr` 当前状态
  - 调用 `gateway_service` 完成注册与状态同步
  - 执行 gateway command，并回写执行结果
- `display_service`
  - 新增 `Gateway` 页
  - 展示注册摘要、状态摘要、最近命令结果
  - 提供几个本地 demo command 按钮
- `app_main`
  - 输出 gateway 摘要与 `VERIFY:gateway:*`
  - 在主循环中处理 pending gateway command，并定期刷新 gateway state

### 4.2 命令模型

本阶段先只支持无网络 demo command：

- `sync_state`
- `show_home`
- `show_settings`

这些命令足以证明：

- UI 可以触发“外部命令”
- 运行时可以消费命令
- 状态同步会在命令完成后刷新

### 4.3 页面模型

`Gateway` 页只做只读状态和 demo command，不承担真实业务页面职责。

页面内容：

- 注册摘要
- 当前 panel state 摘要
- 最近一次 command 结果
- 若干 demo command 按钮

## 5. 实现任务

1. 新增 `gateway_service` 组件与接口
2. 在 `board_support` 中接入 gateway 注册、状态同步、命令执行
3. 在 `display_service` 中新增 `Gateway` 页与 demo command 入口
4. 在 `app_main` 中新增 gateway 启动摘要、verify marker 和轮询
5. 更新相关 README / 验证文档
6. 执行本地 build / flash / 串口验证

## 6. 测试方案

### 6.1 构建验证

- `idf.py build` 成功

### 6.2 启动验证

- 启动日志出现 `gateway ready=yes`
- 启动日志出现 `registered=yes`
- 启动日志出现 `VERIFY:gateway:registration:PASS`
- 启动日志出现 `VERIFY:gateway:state_sync:PASS`
- 启动日志出现 `VERIFY:gateway:command_mailbox:PASS`

### 6.3 回归验证

- `network/settings/display/touch/audio/sr` 现有 `VERIFY:*` 不回归
- 新增 gateway 逻辑不阻塞进入 `app_main`

### 6.4 本地 UI 验证

- 屏幕上可看到 `Gateway` 页
- `Gateway` 页可显示注册与状态摘要
- demo command 可被成功入队并由运行时消费

## 7. 风险

- `display_service` 若继续承担过多聚合逻辑，后续会和外部协议重新耦合
- 运行时轮询若实现粗糙，可能带来无意义日志噪音
- 新增 UI 页面和 service 后，镜像体积可能进一步逼近 app 分区上限

## 8. 完成定义

- `gateway_service` 不再是概念占位
- 本地固件具备“注册 + 状态同步 + 命令邮箱”的最小网关骨架
- UI 已有一页专门承载 `M4` 状态，而不是把外部接入逻辑继续塞回 `Home/Settings`

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待重点查看的文件

### 已完成的实现项

- 新增 `gateway_service` 组件，完成设备注册模型、状态快照、单条 pending command 邮箱和最近命令结果记录
- `board_support` 已接入 gateway 注册、状态同步、命令执行，并在启动期跑通一次 `sync_state` 自检命令
- `display_service` 已新增 `Gateway` 页，包含注册摘要、状态摘要、命令摘要和 demo command 按钮
- `app_main` 已增加 gateway 启动摘要、`VERIFY:gateway:*` 和运行期轮询
- 更新组件说明文档，明确 `gateway_service` 的职责范围

### 已完成的验证项

- `idf.py build` 成功
- 已烧录到本地 `ESP32-P4 EVB`（`/dev/cu.usbserial-210`）
- 冷启动串口日志 [p4home-serial-20260415-gateway-service-v2.log](/tmp/p4home-serial-20260415-gateway-service-v2.log) 已确认：
  - `gateway ready=yes`
  - `registered=yes`
  - `state_synced=yes`
  - `last_command=sync_state/applied`
  - `VERIFY:gateway:registration:PASS`
  - `VERIFY:gateway:state_sync:PASS`
  - `VERIFY:gateway:command_mailbox:PASS`
- `network/settings/display/touch/audio/sr` 现有 `VERIFY:*` 均未回归

### 待重点查看的文件

- [gateway_service.c](/Users/andyhao/workspace/p4home/firmware/components/gateway_service/gateway_service.c)
- [gateway_service.h](/Users/andyhao/workspace/p4home/firmware/components/gateway_service/include/gateway_service.h)
- [board_support.c](/Users/andyhao/workspace/p4home/firmware/components/board_support/board_support.c)
- [display_service.c](/Users/andyhao/workspace/p4home/firmware/components/display_service/display_service.c)
- [app_main.c](/Users/andyhao/workspace/p4home/firmware/main/app_main.c)

### 剩余风险

- `Gateway` 页上的 demo command 按钮这次只完成了启动级验证，尚未补充一次人工触屏回归记录
- 当前 app 分区只剩约 `0x5e90` 字节（约 1%）空余，后续继续推进 `M4/M5` 前需要优先处理镜像体积
- `i2s_channel_disable(...): the channel has not been enabled yet` 仍然存在，本计划按当前约定继续忽略
