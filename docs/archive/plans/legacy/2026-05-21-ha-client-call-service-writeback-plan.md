# HA Client Call Service Writeback Plan

所属 Milestone: `M6`

## 1. 背景

`M4` / `M5` 已经把 `Home Assistant` 读侧链路打通到 `panel_data_store` 与 dashboard 卡片，但 `ha_client` 当前只能订阅状态，不能向 HA 发起控制。`M6` 的第一步应先补齐协议层写回能力，避免后续 UI 控制卡片直接拼 HA WebSocket JSON。

## 2. 目标

- 在 `ha_client` 内提供可复用的 `call_service` API
- 支持常见 `entity_id` 控制调用
- 调用结果具备超时、失败日志与同步返回值
- 不改动现有读侧订阅、初始状态加载与 dashboard 数据流

## 3. 范围

包含：

- `ha_client_call_service()`
- `ha_client_call_entity_service()`
- `call_service` pending result 跟踪
- 调用超时 Kconfig
- `ha_client` 文档更新

不包含：

- dashboard 控制卡片 UI
- 亮度滑条 / 场景按钮
- 米家集成安装与联调
- HA token / URL 配置页

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ha_client/`
- `docs/plans/`

### 4.2 模块拆解

- `ha_client` 继续作为 HA 协议边界
- UI / gateway 后续只调用 `ha_client` 公共 API
- `panel_data_store` 仍只承载读侧状态缓存，不混入控制命令

### 4.3 数据流 / 控制流

1. 上层传入 `domain` / `service` / `service_data_json`
2. `ha_client` 分配 WebSocket message id
3. 发送 `{"type":"call_service",...}`
4. `ha_client_handle_result()` 根据 pending id 匹配结果
5. API 返回 `ESP_OK` / `ESP_FAIL` / `ESP_ERR_TIMEOUT`
6. HA 后续 `state_changed` 事件仍通过原有读侧路径刷新 UI

## 5. 实现任务

1. 扩展 `ha_client` public API
2. 在 pending 类型中加入 `HA_PENDING_CALL_SERVICE`
3. 增加同步等待与调用序列化
4. 更新文档
5. 本地构建验证

## 6. 测试方案

### 6.1 构建验证

- 在 `firmware/` 下执行 ESP-IDF build

### 6.2 功能验证

- HA ready 后调用 `ha_client_call_entity_service("switch", "turn_on", "<entity>", timeout)`
- 观察 HA WebSocket `result.success=true`
- 观察随后 `state_changed` 更新回 `panel_data_store`

### 6.3 回归验证

- HA 不可用时 API 返回 `ESP_ERR_INVALID_STATE`
- HA 不返回 result 时 API 返回 `ESP_ERR_TIMEOUT`
- 现有 `VERIFY:ha:*` 与 `VERIFY:ui:dashboard_rendered:PASS` 不回归

### 6.4 硬件/联调验证

- 需要接入真实 HA 与至少一个可控设备后完成
- 米家设备通过 HA 暴露后再进入 M6 下一份 UI / 联动 plan

## 7. 风险

- HA `call_service` 成功只代表 HA 接受调用，不等于设备最终到达目标状态；最终验收必须依赖后续 `state_changed`
- 当前 API 串行化控制调用，适合面板 MVP；批量场景调用如需高并发应另立 plan
- `service_data_json` 由调用方提供，后续 UI 层应只走受控 helper，避免把自由 JSON 暴露给交互层

## 8. 完成定义

- 固件可构建
- `ha_client` 暴露写回 API
- `call_service` result 可同步反馈成功、失败、超时
- 未改变现有读侧链路职责边界

## 9. 当前状态（2026-07-14）

### 已完成的实现项

- `e7528d4` 已提交 `ha_client_call_service()` 与 `ha_client_call_entity_service()`。
- `ha_client` 已支持 `HA_PENDING_CALL_SERVICE`、同步等待 result、调用超时与串行化调用。
- `Kconfig.projbuild` 已增加 `CONFIG_P4HOME_HA_CLIENT_CALL_SERVICE_TIMEOUT_MS`。
- `ha_client/README.md` 已补充 writeback API 说明。

### 已完成的验证项

- 本地增量构建通过：`cmake --build firmware/build -j4`。
- `git diff --check` 通过。
- `2026-07-14` 已通过 `/dev/cu.usbserial-210` 重烧录到 ESP32-P4 EVB，应用分区完成 hash 校验。
- `2026-07-15` 复测确认 P4 可从 `192.168.110.87` 跨网段访问 `192.168.71.4:8123`，HA 进入 `READY`；30 个白名单实体全部完成初始状态拉取。

### 尚未完成

- 需要在面板实际点击一盏灯或空调控制项，验证 `call_service result.success=true`、设备动作与后续 `state_changed` 回刷。

### 待重点查看的文件

- [ha_client.c](/Users/andyhao/workspace/p4home/firmware/components/ha_client/ha_client.c)
- [ha_client.h](/Users/andyhao/workspace/p4home/firmware/components/ha_client/include/ha_client.h)
- [Kconfig.projbuild](/Users/andyhao/workspace/p4home/firmware/components/ha_client/Kconfig.projbuild)
