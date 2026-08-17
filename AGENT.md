# AGENT

## 项目总览

`p4home` 是 ESP32-P4 原生 Home Assistant Smart Panel，并正在进入本地 LLM Agent 化阶段。

当前固定基线：

- ESP-IDF v5.5.4；
- LVGL v9；
- ESP32-C6 ESP-Hosted；
- Home Assistant WebSocket；
- ESP-SR 音频/唤醒骨架；
- 局域网 Agent Runtime + Ollama + STT/TTS。

通用 LLM 不运行在 P4。P4 是 UI、音频前端和 World Action 执行端；Agent 节点负责推理、会话、工具、Memory 和编排。

产品角色固定为：Role Router 只分发语义且无 Tool；Robot 只执行受限 HA 命令；Human 只负责对话
且无执行权限；Cat 是事件驱动电子宠物，只使用最小 P4 World 能力且不直接接收用户原文。四者可
共用同一个已加载的 `qwen3.8:27b-mlx` 和 Provider，但上下文、工具、参数、预算与审计隔离。
所有 Qwen 请求都必须显式设置 Ollama `think: false`，不允许角色自行开启思考模式。

## 接手顺序

1. 读取本文件；
2. 读取 `docs/p4-local-agent-architecture.md`；
3. 读取 `docs/plans/README.md`；
4. 只执行当前 `in_progress` Phase plan；
5. 需要历史证据时再查 `docs/archive/`。

## Agent 主线分支

- Phase 0–7 的架构、计划、记录、代码和测试统一提交到 `feature/agent-harness`；
- Agent 主线进行期间不得把阶段性改动直接提交或合入 `main`；
- 每个 Phase 完成后在同一分支归档计划、更新记录，再继续下一个 Phase；
- 只有 Phase 0–7 全部通过退出门禁并完成最终 review 后，才将
  `feature/agent-harness` 整体合入 `main`；
- 未经用户重新确认，不为单个 Phase 改用其他长期分支。

## 目录

| 路径 | 职责 |
|---|---|
| `firmware/` | ESP-IDF 固件主工程 |
| `sim/` | LVGL host simulator、fake HA/time/scenario |
| `assets/` | Pixel art 源资产 |
| `contracts/` | Device Protocol v1、Tool Schema v1 与黄金场景 |
| `agent/` | Phase 1 建立的 Agent Runtime；Phase 0 前不得创建生产实现 |
| `docs/p4-local-agent-architecture.md` | 当前唯一架构基线 |
| `docs/plans/` | 当前 Phase 计划与状态索引 |
| `docs/records/` | 完成后的稳定实现与验证记录 |
| `docs/archive/` | 历史架构、计划和记录；默认不维护当前状态 |
| `docs/templates/` | plan 与技术记录模板 |
| `scripts/` | 构建、计划、提交、推送和资源生成辅助脚本 |
| `.codex/` | 项目本地 Codex 扩展 |

## 固件组件

| 组件 | 当前职责 |
|---|---|
| `board_support` | 初始化与 service 编排 |
| `diagnostics_service` | 芯片、分区、内存、心跳与 VERIFY 标记 |
| `display_service` | DSI/LVGL 显示、背光与 standby |
| `ui_pages` | Pixel Home、Lights、Climate、Modes 与状态栏 |
| `ui_pixel_art` | 生成后的像素 sprite 资源 |
| `touch_service` | GT911 / LVGL 输入 |
| `audio_service` | Codec、采集、播放与所有权 |
| `sr_service` | AFE、WakeNet、MultiNet 骨架 |
| `network_service` | ESP32-C6 Hosted Wi-Fi |
| `ha_client` | HA WebSocket 订阅、状态、request 与 call_service |
| `panel_data_store` | 白名单实体与本地采样状态 |
| `gateway_service` | 注册、快照、单命令邮箱骨架 |
| `settings_service` | NVS 配置 |
| `weather_service` | 天气获取与面板数据写入 |

Agent Phase 2 计划新增：

- `role_router`：用户输入到 Human/Robot 的结构化分发；
- `roles`：Robot/Human/Cat RoleProfile、Context 与 Policy；
- `agent_transport`：P4 Device WebSocket；
- `world_service`：Cat 真值、Action Queue 与状态机。

## 开发与验证

- 固件构建必须激活 ESP-IDF v5.5.4；
- 新 build 结果不得依赖旧 CMake cache 或旧生成 `sdkconfig`；
- 验证包括 build、simulator、功能、回归、故障和必要的实机证据；
- 串口验证继续使用 `VERIFY:area:check:PASS|FAIL`；
- Phase 0 未完成前，不实现 Agent 生产代码或重构角色执行层。

流程细则见 `docs/harness-workflow.md`。
