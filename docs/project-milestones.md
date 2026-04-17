# Project Milestones

## 1. 目的

本文件定义 `p4home` 的项目级 milestones，用于检查真实开发是否按正确顺序推进，以及每个阶段是否已经具备进入下一阶段的条件。

使用原则：

- 每个新功能 plan 都应标明它属于哪个 milestone
- milestone 以“可验收交付物”为准，不以代码量为准
- 未达到当前 milestone 的退出条件前，不应贸然推进下一阶段

## 2. 当前主线

项目当前主线已调整为：

- **优先目标**：连接 `Home Assistant`，以图形化方式展示家庭传感器数据
- **暂缓目标**：本地语音对话、米家直接联动、本地 LLM 节点

对应的关键决策（`2026-04-17` 定版）：

- HA 接入协议：`Home Assistant WebSocket API` + `Long-Lived Access Token`
- 面板实体清单来源：**固件内置 JSON**（MVP 期），后续再演进到 NVS 可配置 / Panel Gateway 下发
- 本地语音前端（`ESP-SR` / `AFE` / `WakeNet` / `MultiNet`）已完成骨架，**主线暂停**，等图形化主线稳定后再按 `M7` 重新推进

本轮调整导致 milestone 语义变动：

- 原 `M4` 设备与网关接入 → 保留本地邮箱骨架，重心改为“真实 HA WebSocket 接入（读侧）”
- 原 `M5` HA 与米家联调 → **拆分**：HA 读侧提前，米家与控制回写后置
- 原 `M6` 本地语音对话 → **顺延为 `M7`**
- 原 `M7` 产品化打磨 → **顺延为 `M8`**

## 3. 里程碑总览

- `M0`：Harness 与工程治理基线 —— 已完成
- `M1`：本地底座 bring-up —— 已完成
- `M2`：原生 UI 骨架 —— 已完成
- `M3`：音频与本地语音前端 —— 骨架已完成，主线暂停
- `M4`：网络联网与 `Home Assistant` WebSocket 接入（读侧）—— **当前主线**
- `M5`：图形化传感器仪表盘 UI —— **当前主线**
- `M6`：控制回写与米家联动
- `M7`：本地语音对话与 AI 节点（延后启用）
- `M8`：产品化打磨与发布准备

## 4. Milestone 细节

## M0：Harness 与工程治理基线

### 目标

建立项目最小可维护基础设施，确保后续上下文可以稳定接手。

### 交付物

- `AGENT.md`
- `docs/harness-workflow.md`
- `docs/templates/`
- `docs/plans/`
- `scripts/`
- `.githooks/`
- Git 仓库初始化
- GitHub 远端仓库初始化

### 验收标准

- 已有统一的 plan 流程
- 已有统一的 review 后 push 约束
- 本地 `commit/push` 脚本可用
- 远端仓库存在且本地已连通

### 退出条件

- 项目治理不再阻塞真实功能开发

### 状态

- 已完成。

## M1：本地底座 bring-up

### 目标

确认 `ESP32-P4 EVB` 的最小板级能力稳定可用。

### 交付物

- 最小 `ESP-IDF` 工程
- 串口日志可用
- 板级启动稳定
- Flash / PSRAM / 基础分区确认

### 验收标准

- 能稳定烧录
- 能稳定进入 `app_main`
- 无早期崩溃或随机重启
- 启动日志可用于问题定位

### 退出条件

- 板级 bring-up 不再是后续开发阻塞项

### 状态

- 已完成。

## M2：原生 UI 骨架

### 目标

建立基于 `LVGL` 的原生界面框架。

### 交付物

- LCD 点亮
- `LVGL` 集成
- 页面导航框架
- 至少一个首页 demo
- 触摸输入可用

### 验收标准

- 界面稳定刷新
- 触摸输入命中可靠
- 页面切换无严重闪烁
- UI 内存占用在可接受范围

### 退出条件

- 后续 UI 开发可以基于稳定骨架持续扩展

### 状态

- 已完成。现有首页仅为面板自检 UI，业务化改造归入 `M5`。

## M3：音频与本地语音前端

### 目标

建立稳定的本地音频链路和 `ESP-SR` 语音前端。

### 交付物

- 麦克风采集
- 扬声器播放
- 音频 service 抽象
- `ESP-SR` AFE
- 唤醒词验证
- 固定命令词初版

### 验收标准

- 可稳定录音与播放
- 唤醒词在典型室内环境可用
- 固定命令词可触发至少一组动作
- 音频链路不会明显干扰 UI 稳定性

### 退出条件

- 面板已具备“可用的本地语音前端”能力

### 状态

- 骨架已完成。
- 依据 `2026-04-17` 的主线调整，本阶段**主线暂停**：
  - 不再新增语音相关功能
  - 已有 `audio_service` / `sr_service` 保持可构建、可运行，只做最小维护
  - 等 `M4` → `M5` → `M6` 稳定后，统一在 `M7` 重启语音对话链路

## M4：网络联网与 Home Assistant WebSocket 接入（读侧）

### 目标

把面板真正接入家庭网络，并以“只读订阅”的方式从 `Home Assistant` 拉到全量相关实体状态，为后续 UI 渲染提供稳定的数据底座。

### 交付物

- `network_service` 完成 Wi‑Fi STA 真正连接与重连（目前仅有 `esp_netif`/STA netif 骨架）
- `time_service`：`SNTP` 时间同步，用于状态时间戳与 UI 时钟
- `settings_service` 扩展：
  - `ha_url`
  - `ha_token`（长效访问令牌）
  - `ha_verify_tls`
  - 固件内置的实体白名单 `JSON`（MVP 期打包入固件分区）
- 新增 `ha_client` 组件：
  - 基于 `esp_websocket_client`
  - 握手：`auth` → `subscribe_events: state_changed` → `get_states`
  - 心跳 / 超时 / 错误分类
  - 指数退避重连
- 新增 `panel_data_store` 组件：
  - 按 `entity_id` 缓存最新值、属性、时间戳
  - 标记 `fresh / stale / unknown` 三态
  - 线程安全，向 UI 提供只读 snapshot 或 observer 事件
- 启动期 `VERIFY:*` 扩展：
  - `VERIFY:network:wifi_connected:PASS`
  - `VERIFY:network:ip_acquired:PASS`
  - `VERIFY:time:sync:PASS`
  - `VERIFY:ha:ws_connected:PASS`
  - `VERIFY:ha:authenticated:PASS`
  - `VERIFY:ha:subscribed:PASS`
  - `VERIFY:ha:initial_states_loaded:PASS n=<count>`

### 验收标准

- 面板冷启动 30s 内完成：Wi‑Fi 连接 → SNTP → HA 鉴权 → 初始 state 加载
- 白名单内任一实体在 HA 侧变化后，`<2s` 内更新到 `panel_data_store`
- Wi‑Fi 或 HA 断开能被识别并显式标记为断线/陈旧，不会卡死
- 2 小时长跑：内存无持续增长、重连自愈

### 退出条件

- 后续只需新增 UI 绑定，不再改动网络或 HA 客户端链路

### 范围外

- UI 卡片实现（归 `M5`）
- HA `call_service` 控制回写（归 `M6`）
- 米家集成（归 `M6`）
- SoftAP/BLE 配网（推后到 `M8` 打磨阶段）

## M5：图形化传感器仪表盘 UI

### 目标

把 `panel_data_store` 的数据以原生卡片形式呈现，达成“连接 HA + 图形化展示家庭传感器数据”的可演示闭环。

### 交付物

- 新增 `ui_page_dashboard`，作为首页替代现有自检首页
- 至少三种卡片形态：
  - 数值卡：温度 / 湿度 / 功率 / 照度等
  - 二值卡：门窗 / 人体 / 在家
  - 多行卡：天气摘要 / 能耗摘要
- UI 状态机：`loading / ready / stale / disconnected / empty`
- 顶部状态栏：Wi‑Fi、HA 连接、时间
- 分组展示（如 客厅 / 卧室 / 门窗 / 能耗）
- 新增 `VERIFY:ui:dashboard_rendered:PASS`

### 验收标准

- 至少 6~9 张传感器卡片稳定刷新真实 HA 数据
- 断网或 HA 下线时 UI 不崩，仅显示 stale 与连接状态
- 2 小时长跑：UI 线程无卡顿、FPS 稳定

### 退出条件

- 目标“连接 HA + 图形化展示传感器数据”达到可演示水平

### 范围外

- 趋势图 / 历史曲线（可选特性，归 `M8` 或单独立 plan）
- 控制类控件（归 `M6`）

## M6：控制回写与米家联动

### 目标

把单向读扩展为双向读写，并通过 `Home Assistant` 聚合米家设备。

### 交付物

- `ha_client` 扩展：`call_service` 控制回写
- 面板侧控制卡片：开关 / 亮度 / 场景调用
- `ha_xiaomi_home` 官方集成联调
- 必要时补 `hass-xiaomi-miot` 第三方集成
- 至少一组典型设备控制闭环

### 验收标准

- 面板可控制至少一组真实设备
- 米家设备经 HA 暴露可在面板端消费与操作
- 控制失败具备明确的 UI 反馈与日志

### 退出条件

- “面板 → HA → 米家设备” 路径可稳定演示

## M7：本地语音对话与 AI 节点（延后启用）

### 目标

在图形化主线稳定之后，把 `M3` 已完成的本地语音前端与局域网 AI 节点串起来，形成可用对话链路。

### 交付物

- 语音流上传机制
- STT 接入（`Whisper / faster-whisper`）
- TTS 接入（`Piper`）
- 本地 LLM 节点接入（`Ollama + Qwen`）
- 语音对话页面

### 验收标准

- 唤醒后可完成一次完整语音交互
- 可执行至少一组家庭控制对话
- 首次体验可用，延迟处于可接受范围

### 退出条件

- 已具备“本地唤醒 + 本地对话 + 家控执行”的最小闭环

### 启用前置

- `M4` / `M5` / `M6` 均已达到各自退出条件
- 固件体积与内存仍有可用空间

## M8：产品化打磨与发布准备

### 目标

从功能可用提升到可演示、可维护、可迭代。

### 交付物

- OTA
- 日志与诊断增强（HA 连接统计、实体数、事件速率、stale 比例）
- 配置页（Wi‑Fi / HA URL / Token / 亮度 / 启动页）
- 性能优化
- UI 动效打磨
- 发布说明与已知问题清单

### 验收标准

- 系统稳定性可接受
- 出错后具备可诊断性
- 核心路径具备基本回归验证
- 可以对外演示或进入小范围试用

### 退出条件

- 项目达到 `v0.9` 或类似可演示版本标准

## 5. 进度检查建议

建议用以下方式检查进度：

- 检查当前活跃功能 plan 属于哪个 milestone
- 检查该 milestone 的交付物是否已经具备
- 检查该 milestone 的退出条件是否真正满足
- 若未满足，不要用新增功能掩盖底座问题

## 6. 建议的开发顺序

项目必须按以下主线推进：

1. `M0` / `M1` / `M2` 已完成
2. `M3` 骨架已完成，本轮主线暂停
3. 当前聚焦 `M4` → `M5`，完成“HA 传感器图形化展示”MVP
4. 再进入 `M6`（控制回写 / 米家）
5. 待 `M6` 稳定后重启 `M7` 本地语音对话
6. 最后统一进入 `M8` 产品化打磨与发布

关键门槛：

- `M4` 的 `ha_client` 若做不抽象，UI/业务会反复重写
- `M5` 的数据绑定若直连 HA，未来换 Panel Gateway 会重做
- `M7` 在 `M5/M6` 不稳之前重启，只会互相干扰
- `M3` 骨架在 `M7` 启用前应保持最小维护，不因主线推进而回归

## 7. 后续 plan 的引用要求

后续每个新功能 plan 必须包含字段：

- `所属 Milestone: Mx`

当前主线（`M4` → `M5`）对应的 plan 优先级序列：

| 序号 | plan 名称                                   | milestone | 依赖              |
|------|---------------------------------------------|-----------|-------------------|
| 1    | `network-service-wifi-sta-connect`          | `M4`      | 无                |
| 2    | `time-service-sntp`                         | `M4`      | 1                 |
| 3    | `settings-service-ha-credentials`           | `M4`      | 无                |
| 4    | `ha-client-websocket-bootstrap`             | `M4`      | 1, 2, 3           |
| 5    | `ha-client-state-subscription`              | `M4`      | 4                 |
| 6    | `panel-data-store`                          | `M4`      | 5                 |
| 7    | `panel-entity-whitelist-config`             | `M4`/`M5` | 3, 6              |
| 8    | `ui-dashboard-sensor-cards`                 | `M5`      | 6, 7              |
| 9    | `ui-connection-status-banner`               | `M5`      | 6                 |
| 10   | `ha-client-reconnect-and-diagnostics`       | `M5`/`M8` | 4, 5              |
| 11   | `ha-history-mini-chart`（可选）              | `M5`/`M8` | 4, 8              |

后续里程碑（`M6` 之后）的 plan 序列在进入对应阶段前再细化，避免提前锁死设计。
