# UI Control Cards Plan

所属 Milestone: `M6`

## 1. 背景

本轮工作区已经补上 `ha_client` 的 `call_service` 写回 API，下一步需要让 dashboard 能承载最小控制闭环。当前 dashboard 已有 binary 卡片，但只用于门窗、人体等只读状态，不具备控制元数据和触摸动作；米家场景经 HA 暴露后也需要一个无状态触发按钮。

## 2. 目标

- 白名单实体支持声明控制能力
- `panel_data_store` 保存控制域和开/关 service
- binary 卡片在可控实体上显示 `lv_switch`
- action / scene 卡片显示触发按钮
- 点击开关后异步调用 `ha_client_call_entity_service()`
- 控制失败在 UI meta 与日志中反馈

## 3. 范围

包含：

- `panel_sensor_t` 控制字段
- embedded whitelist `control` 对象解析
- binary 卡片的 switch 控件
- action 卡片的 `Run` 按钮
- UI 线程外执行 HA 写回调用
- 构建验证

不包含：

- 亮度滑条
- 场景按钮
- 控制实体白名单实机选择
- 米家集成安装与 HA 侧配置

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/panel_data_store/`
- `firmware/components/ui_pages/cards/ui_card_binary.c`
- `docs/plans/`

### 4.2 模块拆解

- `panel_entity_whitelist` 解析可选 `control` 对象
- `panel_data_store` 保留控制字段，不被 HA state 更新清空
- `ui_card_binary` 只在控制字段完整时创建 `lv_switch`
- `ui_card_action` 只需要 `control.domain` 与 `control.on_service`
- `ha_client` 继续作为唯一 HA 协议写回边界

### 4.3 数据流 / 控制流

1. 白名单注册 `entity_id`、`kind=binary|action`、`control.domain/on_service/off_service`
2. HA state 更新仍刷新 `value_text`
3. binary 卡根据 `value_text` 设置 switch checked 状态
4. 用户点击 switch
5. 卡片创建后台任务调用 `ha_client_call_entity_service()`
6. 成功后等待 HA `state_changed` 回刷最终状态
7. action 卡点击后调用 `control.on_service`
8. 失败时卡片显示 `Control | Failed` 或 `Action | Failed`

## 5. 实现任务

1. 扩展 `panel_sensor_t`
2. 解析 whitelist 控制字段
3. 保持 store 更新不丢控制字段
4. 改造 binary 卡片 UI
5. 新增 action 卡片 UI
6. 本地构建验证

## 6. 测试方案

### 6.1 构建验证

- `source scripts/activate-idf-v5.5.4.sh && cmake --build firmware/build -j4`

### 6.2 功能验证

- 在 `panel_entities.json` 中加入真实 HA `switch.*` 或 `light.*` 二值控制实体
- 在 `panel_entities.json` 中加入真实 HA `scene.*` 或 `button.*` 动作实体
- 配置 `control.domain`、`control.on_service`、`control.off_service`
- 面板点击 switch 后确认 HA 设备动作
- 确认 HA `state_changed` 回刷后 UI 状态一致

### 6.3 回归验证

- 无 `control` 字段的 binary 卡仍按只读卡渲染
- 无 `control` 字段的 action 卡按钮禁用
- HA 不 ready 时控制失败但 UI 不崩
- dashboard 现有 numeric/text/weather 卡不受影响

### 6.4 硬件/联调验证

- 需要真实 HA 与可控设备
- 米家设备应先通过 HA 暴露为 `switch` / `light` / `scene` 后再纳入面板白名单

## 7. 风险

- 当前卡片后台任务持有卡片上下文指针；dashboard 生命周期稳定时可接受，后续如果引入动态删除卡片，需要改为引用计数或队列化控制请求
- `call_service` 成功不等于设备状态已到达，最终状态仍依赖 HA 事件回刷
- 第一版只覆盖二值控制；亮度和场景需要独立卡片形态
- 第一版已覆盖无状态 action / scene，亮度仍需独立滑条卡片

## 8. 完成定义

- 固件可构建
- 可控 binary 实体能显示 switch
- action / scene 实体能显示 `Run` 按钮
- 点击 switch 会走 HA `call_service`
- 点击 `Run` 会走 HA `call_service`
- 失败路径有 UI 与日志反馈

## 9. 当前状态（2026-07-14）

### 已完成的实现项

- `e7528d4` 已提交 `panel_sensor_t` 控制字段、`PANEL_SENSOR_KIND_ACTION` 与 HA `call_service` 写回能力。
- `panel_entity_whitelist` 已解析可选 `control` 对象。
- `ui_card_binary` 已在可控实体上创建 `lv_switch`，点击后异步调用 HA 写回 API。
- 已新增 `ui_card_action`，无状态 action / scene 可显示 `Run` 按钮并调用 `control.on_service`。
- `ui_page_dashboard` 已接入 action card。
- 当前白名单已替换为 27 路真实灯具开关，不再展示监测图表。
- dashboard 使用 8 张固定卡片分页复用，共 4 页；点击卡片或 switch 均可触发开关控制。

### 已完成的验证项

- 本地增量构建通过：`cmake --build firmware/build -j4`。
- `git diff --check` 通过。
- `2026-07-14` 已通过 `/dev/cu.usbserial-210` 烧录到 ESP32-P4 EVB。
- 启动日志确认 `dashboard_visible=yes cards=27 children=8`、`VERIFY:ui:dashboard_rendered:PASS`、`VERIFY:ui:dashboard_card_count:n=27`。
- P4 已连接 `192.168.110.87`，HA 已进入 `READY`，27 个白名单实体均收到有效状态；连续观察约一分钟无崩溃或重启。
- 最终重烧录后的复测中，宿主机与 P4 均暂时无法连接 `192.168.71.4:8123`；P4 保持稳定并停留在 HA `CONNECTING`，需在 UTM/HA 恢复可达后继续控制验收。

### 尚未完成

- 需要在面板上实际点击一盏灯，确认 HA `call_service` 成功、灯具动作以及 `state_changed` 状态回刷。
- 当前灯具清单均为二值开关；亮度滑条与场景按钮不在本轮 UI 中。

### 待重点查看的文件

- [ui_card_binary.c](/Users/andyhao/workspace/p4home/firmware/components/ui_pages/cards/ui_card_binary.c)
- [ui_card_action.c](/Users/andyhao/workspace/p4home/firmware/components/ui_pages/cards/ui_card_action.c)
- [panel_data_store.h](/Users/andyhao/workspace/p4home/firmware/components/panel_data_store/include/panel_data_store.h)
- [panel_entity_whitelist.c](/Users/andyhao/workspace/p4home/firmware/components/panel_data_store/panel_entity_whitelist.c)
