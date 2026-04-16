# AGENT

## 项目总览

`p4home` 是一个基于 `ESP32-P4` 的原生 `Home Assistant Smart Panel` 项目，当前主线是：

- 面板路线：`ESP32-P4` 原生面板
- 固件基座：`ESP-IDF` **v5.5.4**
- 图形栈：`LVGL` **v9**
- 本地语音前端：`ESP-SR`
- 后续集成：`Home Assistant`、米家生态、本地语音/LLM 节点

本文件仅描述目录结构与功能模块，不承载开发流程约定。

## 顶层目录说明

### `/`

仓库根目录，保存项目入口说明、工程规范和后续顶层模块。

### `/docs`

项目文档目录：总体技术方案、本地验证计划、功能计划、模板与流程说明。

### `/docs/plans`

功能计划目录（先写 plan，实现与测试方案，沉淀后可删原 plan）。

### `/docs/templates`

文档模板目录。

### `/.codex`

Codex 扩展目录；当前固化 skill：`esp-idf-v5.5.4`。

### `/scripts`

本地辅助脚本：IDF 激活、plan 生命周期、git/hook 等。

### `/.githooks`

本地 git hook 模板目录。

### `/firmware`

固件主工程目录（ESP-IDF）。

结构要点：

- `main/`：入口 `app_main.c`，启动后输出 `VERIFY:area:check:PASS|FAIL` 供 CI/串口解析
- `components/`：业务组件（见下）
- `host_test/`：独立 Unity 冒烟测试工程（可选构建）
- `sdkconfig.defaults`：人工维护的默认配置基线
- `sdkconfig`：本地生成，通常 gitignore
- `partitions.csv`：分区表

## 开发与验证

仓库当前默认采用本地开发机完成固件开发、构建、烧录与串口验证，不再维护 self-hosted runner 相关 GitHub Actions workflow。

建议本地最小闭环：

- 激活 `ESP-IDF v5.5.4`
- 在 `firmware/` 下执行 `idf.py build`
- 按当前开发板串口执行 `idf.py -p <serial_port> flash monitor`
- 依据串口日志中的 `VERIFY:` 标记与功能现象做本地验收

## 固件组件（`firmware/components/`）

已实现并参与链接的典型组件：

| 组件 | 职责 |
|------|------|
| `board_support` | 板级编排：初始化各 service、网关状态发布、命令处理 |
| `diagnostics_service` | 启动信息、芯片/分区/内存、心跳 |
| `display_service` | DSI/LVGL 显示初始化、对外 API；页面 UI 委托 `ui_pages` |
| `ui_pages` | 三页 LVGL UI、音频/触摸/网关控件与运行时标签更新 |
| `touch_service` | GT911 / LVGL 触摸 |
| `audio_service` | Codec、提示音、采集 |
| `sr_service` | ESP-SR（AFE / WakeNet / MultiNet）与运行时任务 |
| `network_service` | `esp_netif`、STA、hostname/device_id |
| `gateway_service` | 本地网关状态与命令邮箱（脚手架） |
| `settings_service` | NVS：启动页、启动计数等 |

`ui_core/`：预留（导航壳/主题），当前逻辑主要在 `ui_pages`。

## 功能模块说明（概念）

### 板级支持模块

硬件初始化与编排：`board_support` 聚合各 service。

### UI 模块

`display_service` + `ui_pages`：显示链路、页面与交互控件。

### 语音前端模块

`sr_service` + `audio_service`：采集、AFE、唤醒与固定命令。

### 网关接入模块

`gateway_service`：本地注册/状态/命令邮箱契约（后续可接真实网关）。

### 系统基础设施模块

`settings_service`、`diagnostics_service`、分区与 OTA 配置在 `sdkconfig.defaults` / `partitions.csv` 中体现。

### 文档与流程模块

`/docs` 与 plan 模板；开发与验证流程以本地环境为准。
