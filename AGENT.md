# AGENT

## 项目总览

`p4home` 是一个基于 `ESP32-P4` 的原生 `Home Assistant Smart Panel` 项目，当前主线是：

- 面板路线：`ESP32-P4 原生面板`
- 固件基座：`ESP-IDF`
- 图形栈：`LVGL`
- 本地语音前端：`ESP-SR`
- 后续集成：`Home Assistant`、米家生态、本地语音/LLM 节点

本文件仅描述目录结构与功能模块，不承载开发流程约定。

## 顶层目录说明

### `/`

仓库根目录，保存项目入口说明、工程规范和后续顶层模块。

### `/docs`

项目文档目录，保存：

- 总体技术方案
- 本地验证计划
- 功能计划文件
- 功能完成后的技术文档
- 模板和流程说明

### `/docs/plans`

功能计划目录。

用途：

- 每个新增功能都先创建一个 plan
- plan 必须包含实现方案与测试方案
- 功能完成并经 review 后，plan 会被沉淀为正式技术文档，再删除原 plan 文件

### `/docs/templates`

文档模板目录。

用途：

- 功能计划模板
- 技术文档模板

### `/scripts`

本地辅助脚本目录。

用途：

- 创建 plan
- 完成功能后归档计划
- 自动化 commit
- 自动化 push
- 安装或启用本地 hook

### `/.githooks`

本地 git hook 模板目录。

用途：

- 对直接 `git push` 增加约束
- 提醒先完成 review 再推送
- 在未来扩展轻量检查逻辑

### `/firmware`

固件主工程目录。

当前已初始化为最小 `ESP-IDF` 工程骨架。

当前结构：

- `main/`：启动入口
- `components/`：按模块拆分的业务组件
- `sdkconfig.defaults`：默认配置
- `partitions.csv`：分区表

当前已落地的最小组件：

- `diagnostics_service`

预留目录：

- `board_support`
- `display_service`
- `touch_service`
- `ui_core`
- `ui_pages`
- `audio_service`
- `sr_service`
- `settings_service`
- `network_service`

## 功能模块说明

### 板级支持模块

负责硬件初始化与抽象，包括：

- 屏幕
- 触摸
- 背光
- 音频输入输出
- 存储
- 网络基础能力

### UI 模块

负责原生图形界面，包括：

- 页面框架
- 主题系统
- 卡片组件
- 状态展示
- 导航与交互

### 语音前端模块

负责本地语音输入链路，包括：

- 麦克风采集
- 音频前处理
- 唤醒词
- 固定命令词
- 语音会话状态管理

### 网关接入模块

负责面板与外部系统通信，包括：

- Home Assistant 数据同步
- 设备状态更新
- 命令下发
- 后续语音网关接入

### 系统基础设施模块

负责长期维护所需的基础能力，包括：

- 配置存储
- 日志
- 诊断
- OTA
- 版本信息
- 崩溃恢复

### 文档与流程模块

负责支撑长期维护的工程约定，包括：

- 功能计划
- 测试方案
- 技术文档沉淀
- review 后推送
