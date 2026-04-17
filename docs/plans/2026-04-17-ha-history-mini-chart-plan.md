# ha-history-mini-chart Plan

所属 Milestone: `M5 (可选, 可延后到 M8)`

## 1. 背景

本 plan 是主线 `M4 → M5` 的第 11 号 plan，也是**全序列中唯一一个标注为“可选 / 不阻塞 `M5` 出口”的 plan**。`project-milestones.md` §7 在排优先级时就显式把它标记为 optional：仪表盘已经有数字卡、二值卡和多行卡足以交付“图形化展示传感器数据”的主诉求，折线图只是在此之上的锦上添花。

做这个 plan 的动机：

- 家庭温度、湿度、能耗这类数值传感器，单点瞬时值信息量有限；展示近几小时的趋势能显著提升面板的“能看懂”体验
- `Home Assistant` 自带 `history/history_during_period` 能直接给出时间序列，不需要本地缓存历史
- `LVGL v9` 的 `lv_chart` 控件足以支撑小尺寸折线图渲染

但是：

- `firmware/partitions.csv` 的 `factory` app 分区当前只剩约 2% 余量（见 `docs/plans/2026-04-15-firmware-size-reduction-plan.md`），加入 `lv_chart` 子系统和相关字体/纹理会进一步挤压空间
- JSON 响应在一次请求里可能包含数百到上千个采样点，一次性解析会在堆上产生较大峰值
- M5 的 exit criteria 只要求“传感器仪表盘可用”，不包含折线图

因此：**本 plan 默认不启用**（`CONFIG_P4HOME_HISTORY_CHART_ENABLE` 默认 `n`），完全没实现这条 plan 也不会阻塞 `M5` 验收；主线收官后若有空间再回来开工。

## 2. 目标

- 在 `ha_client` 上增加一次性历史查询 API `ha_client_fetch_history`，向 HA 发起 `history/history_during_period` 并解析结果
- 在 `ui_pages` 上增加 `ui_card_history_chart`，基于 `lv_chart` 展示一路数值实体的近期走势
- 提供 Kconfig 开关、窗口时长、最大点数、目标 `entity_id`，让用户按需启用
- `dashboard` 在 Kconfig 允许且配置完整时才插入该卡片，其他情况下该卡片完全缺席（代码路径甚至可以靠 `#if` 整体剪掉）
- 明确本 plan 是“可放弃”的 stretch goal：删除/关闭本 plan 的所有代码不影响 `M4` / `M5` 的主线验收

## 3. 范围

包含：

- `ha_client` 新增 one-shot 历史查询入口 `ha_client_fetch_history` + 回调类型 `ha_client_history_cb_t`
- 在现有 WebSocket 会话上发送 `{"type":"history/history_during_period", ...}` 帧并做请求/响应配对
- 响应 JSON → `double samples[]` + `int64_t ts_ms[]` 数组的解析
- 客户端降采样：若返回点数超过 `CONFIG_P4HOME_HISTORY_CHART_MAX_POINTS`，按等距抽样裁剪
- `ui_card_history_chart` 卡片：单路折线、自动 Y 轴（min/max ±10% 余量）、X 轴按时间升序
- 仪表盘在 `CONFIG_P4HOME_HISTORY_CHART_ENABLE=y` 且 `CONFIG_P4HOME_HISTORY_CHART_ENTITY_ID` 非空时才插入该卡片
- 新增 `VERIFY:ui:history_chart_ready`
- **启用开关默认关闭**（`CONFIG_P4HOME_HISTORY_CHART_ENABLE=n`）

不包含：

- 多路曲线（一个卡片多条线）
- 运行时切换实体（例如面板 UI 里选不同传感器）
- 超过 24 小时的时间窗口
- 本地持久化历史（即便 HA 不在线也能看图）
- 历史数据导出、缩放、拖拽、tooltip 交互
- 把历史查询暴露给 `panel_data_store`（本 plan 只服务 UI 卡片，不做通用数据层下发）

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ha_client/`
  - `ha_client.c` / `ha_client.h`：新增历史查询相关 API 与内部请求表
  - `Kconfig.projbuild`：追加 history 相关 Kconfig 段
  - `idf_component.yml`：无新依赖（`esp_websocket_client` 已由 plan 4 拉入；`cJSON` 由 IDF 自带）
- `firmware/components/ui_pages/`
  - 新增 `ui_card_history_chart.c` / `ui_card_history_chart.h`
  - `ui_page_dashboard.c`（plan 8 交付物）：插入条件化分支
  - `CMakeLists.txt`：按 Kconfig 条件增加源文件
- `firmware/main/app_main.c`：无改动（VERIFY 标记由卡片自行发起）
- `firmware/sdkconfig.defaults`：默认 `CONFIG_P4HOME_HISTORY_CHART_ENABLE=n`，不触发 `lv_chart` 子系统
- `docs/project-milestones.md`：M5 小节中 11 号条目状态字段维护

### 4.2 模块拆解

**ha_client 历史查询扩展**：

- 新类型：
  ```c
  typedef void (*ha_client_history_cb_t)(esp_err_t err,
                                         const double   *samples,
                                         const int64_t  *ts_ms,
                                         size_t          n,
                                         void           *user);
  ```
- 新 API：
  ```c
  esp_err_t ha_client_fetch_history(const char *entity_id,
                                    int32_t     window_minutes,
                                    ha_client_history_cb_t cb,
                                    void       *user);
  ```
- 内部状态：一个最多容纳 `CONFIG_P4HOME_HA_CLIENT_MAX_INFLIGHT_HISTORY`（默认 1）条 in-flight 请求的表，key 为 WebSocket `id`，value 为 `{entity_id, cb, user, started_at_ms}`
- 复用 plan 4/5 已有的 `message_id` 自增计数
- 超时：`CONFIG_P4HOME_HISTORY_FETCH_TIMEOUT_MS`（默认 15000ms），超时则回调 `err = ESP_ERR_TIMEOUT`
- 权限要求：`ha_client` 已登录的 Long-Lived Access Token 自动带着，无需额外处理

**UI 卡片 ui_card_history_chart**：

- 对外：
  ```c
  esp_err_t ui_card_history_chart_init(lv_obj_t *parent,
                                       const char *entity_id,
                                       int32_t window_minutes,
                                       int32_t max_points);
  void      ui_card_history_chart_request_refresh(void);
  ```
- 内部使用 `lv_chart_create`，一条 `lv_chart_series_t *`
- 刷新触发：
  - 启动 1 次初始 fetch
  - 周期刷新：LVGL timer 每 `CONFIG_P4HOME_HISTORY_CHART_REFRESH_SEC`（默认 300s）触发一次
  - 支持显式 `ui_card_history_chart_request_refresh`（比如仪表盘手势）
- 状态机：IDLE → FETCHING → READY / ERROR；ERROR 时卡片显示占位文本“暂无数据”，不阻塞其他卡片
- 线程：`ha_client_fetch_history` 的回调在 ha_client 内部任务触发；卡片用 `lv_async_call` 把数据 hop 到 LVGL 线程再更新 chart

**仪表盘插入逻辑（plan 8 中实现，此 plan 文档化约束）**：

```c
#if CONFIG_P4HOME_HISTORY_CHART_ENABLE
    if (strlen(CONFIG_P4HOME_HISTORY_CHART_ENTITY_ID) > 0) {
        ui_card_history_chart_init(dashboard_root,
                                   CONFIG_P4HOME_HISTORY_CHART_ENTITY_ID,
                                   CONFIG_P4HOME_HISTORY_CHART_WINDOW_MINUTES,
                                   CONFIG_P4HOME_HISTORY_CHART_MAX_POINTS);
    }
#endif
```

### 4.3 数据流 / 控制流

```
ui_card_history_chart_init()
  └─ ha_client_fetch_history(entity_id, window_min, cb, self)
        └─ [ha_client task] send WS frame:
             { "id": N,
               "type": "history/history_during_period",
               "start_time": <now-window>,
               "entity_ids": [entity_id],
               "minimal_response": true,
               "no_attributes": true,
               "significant_changes_only": true }
             insert into inflight_table[N]

[HA server] -> result frame { "id": N, "success": true, "result": [[{state, last_changed}, ...]] }

[ha_client task on_ws_data]
  ├─ parse id → find inflight entry
  ├─ cJSON traverse result[0] -> collect (last_changed, state) pairs
  ├─ drop points where state is non-numeric (e.g. "unavailable")
  ├─ downsample to max_points (均匀跳采样)
  ├─ allocate temp arrays double[], int64_t[]
  ├─ invoke cb(ESP_OK, samples, ts_ms, n, user)   // 在 ha_client task
  └─ free temp arrays after cb returns

[ui_card_history_chart on_history_cb]
  └─ 复制必要数据到堆
  └─ lv_async_call(apply_to_chart, ctx)
        └─ [LVGL task] lv_chart_set_point_count / set_series_values / range / refresh
```

失败路径：

- WebSocket 未就绪：`ha_client_fetch_history` 直接返回 `ESP_ERR_INVALID_STATE`
- 超时：inflight timer 回调 → `cb(ESP_ERR_TIMEOUT, NULL, NULL, 0, user)`
- HA 返回 `success=false`：`cb(ESP_FAIL, NULL, NULL, 0, user)` + `ESP_LOGW` 打印 `error.message`
- 内存不足（大响应）：`cb(ESP_ERR_NO_MEM, ...)`，卡片进入 ERROR 状态

## 5. 实现任务

agent 可完成的代码侧：

1. 在 `firmware/components/ha_client/Kconfig.projbuild` 追加 `CONFIG_P4HOME_HISTORY_FETCH_TIMEOUT_MS`、`CONFIG_P4HOME_HA_CLIENT_MAX_INFLIGHT_HISTORY`
2. 在 `ha_client.h` 新增 `ha_client_history_cb_t` 与 `ha_client_fetch_history` 声明
3. 在 `ha_client.c` 实现 inflight 表 + 发帧 + on_ws_data 分派 + 超时定时器；和 plan 5 的 state_change 分派解耦
4. 在 `firmware/components/ui_pages/Kconfig.projbuild` 追加 `CONFIG_P4HOME_HISTORY_CHART_ENABLE`、`_WINDOW_MINUTES`、`_MAX_POINTS`、`_ENTITY_ID`、`_REFRESH_SEC`
5. 新增 `ui_card_history_chart.c/h`，实现卡片与 LVGL hop
6. 修改 `ui_pages/CMakeLists.txt`，使新源文件仅在 `CONFIG_P4HOME_HISTORY_CHART_ENABLE=y` 时编入
7. 在 `ui_page_dashboard.c`（plan 8）加入 §4.2 所示的条件化 `ui_card_history_chart_init` 调用
8. 在卡片首次拿到 ≥1 个样本点时打印 `VERIFY:ui:history_chart_ready:PASS`；其他任何失败路径打印 `:FAIL:<reason>`
9. 更新 `docs/project-milestones.md` M5 11 号条目状态为“skeleton 完成，默认关闭”

用户本机侧：

10. `idf.py menuconfig` 打开 `CONFIG_P4HOME_HISTORY_CHART_ENABLE=y` 并填写一个家中真实的数值 `entity_id`（例如 `sensor.livingroom_temperature`）
11. `idf.py build flash monitor`，观察 `VERIFY:ui:history_chart_ready:PASS` 与 chart 渲染
12. 长时间运行，检查周期刷新是否稳定、是否有内存泄漏（`heap_caps_get_free_size` 在 heartbeat 中的变化）

## 6. 测试方案

### 6.1 构建验证

- `CONFIG_P4HOME_HISTORY_CHART_ENABLE=n`（默认）：`idf.py build` 通过；`.map` 中不应出现 `ui_card_history_chart_` 符号（`-ffunction-sections` + 条件编译共同保证）
- `CONFIG_P4HOME_HISTORY_CHART_ENABLE=y` + 空 `ENTITY_ID`：`idf.py build` 通过；运行时仪表盘不插入卡片；日志出现一条 `W ui_card_history_chart: disabled (entity_id empty)`
- `CONFIG_P4HOME_HISTORY_CHART_ENABLE=y` + 合法 `ENTITY_ID`：`idf.py build` 通过；`size-components` 观察 `ha_client` + `ui_pages` 的 flash 增量在可接受范围（目标 < 40 KB）

### 6.2 功能验证

- `ha_client_fetch_history` 在 READY 前调用返回 `ESP_ERR_INVALID_STATE`
- 正常路径：拿到 ≥2 个点后卡片渲染折线，Y 轴范围覆盖所有点且上下留白约 10%
- 返回 0 点（实体短时间内无变化）：卡片渲染“暂无数据”占位，**不崩溃**
- 返回含 `unavailable` 的点：这些点被跳过，不影响其余点渲染
- 超时路径：拔掉 HA / 断网场景下，`ha_client_fetch_history` 经 `CONFIG_P4HOME_HISTORY_FETCH_TIMEOUT_MS` 后回调 `ESP_ERR_TIMEOUT`，卡片进入 ERROR 态

### 6.3 回归验证

- 关闭本 plan 后（`CONFIG_P4HOME_HISTORY_CHART_ENABLE=n`）完整跑 M4/M5 主流程：plan 4/5/6/7/8/9/10 的 VERIFY 标记全部 PASS，仪表盘正常
- 打开本 plan 后跑同一套流程：所有既有 VERIFY 仍 PASS，新增 `ui:history_chart_ready`，panel_data_store 的 observer 回调频率不异常（证明历史查询没干扰订阅）

### 6.4 硬件/联调验证

- 真实 HA 实例 + 一只 4 小时数据的温度传感器：检查曲线形状与 HA 自带 `history` 页一致（允许降采样导致的尖点丢失）
- 面板连续运行 6 小时：历史刷新 12 次（5 分钟一次），`heap_caps_get_free_size` 抖动在 ±4 KB 以内视为合格
- 同时打开本 plan 与 dashboard 多卡片 + 状态栏（plan 9），`esp_get_free_heap_size` 稳态不低于 60 KB

## 7. 风险

- **JSON 响应体内存峰值**：HA 对一只高频传感器的 4 小时历史可能返回几万字节 JSON，一次性解析会在堆上形成数十 KB 瞬时占用；`CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES`（plan 5）可能需要临时放宽，或切换到流式解析。应对：默认 `window_minutes=240`、默认 `max_points=120`，并在 §6.2 加入内存上限验证
- **chart 子系统 flash 占用**：`lv_chart` + 字体/刻度会把 `lvgl` 组件膨胀 20~40 KB，在 `factory` 分区只剩 2% 时可能直接把 plan 不可落地。应对：默认 `CONFIG_P4HOME_HISTORY_CHART_ENABLE=n`，并在实现阶段先跑一遍 `idf.py size-components` 评估预算
- **factory 分区逼近极限**：即便启用本 plan 也能编进，也可能让未来的小改动溢出。应对：在本 plan 的实现提交前，把 `docs/plans/2026-04-15-firmware-size-reduction-plan.md` 的未完成项先做掉
- **UI 线程安全**：回调必须跨线程 hop 到 LVGL；漏写 `lv_async_call` 会直接段错误。应对：卡片里只提供一个统一入口 `apply_to_chart`，其他路径禁止直接碰 `lv_obj`
- **WebSocket 上文字节背压**：plan 4 把 WebSocket 缓冲区设成 `CONFIG_P4HOME_HA_CLIENT_BUFFER_SIZE`；若历史响应超过该阈值，`esp_websocket_client` 会分片，我们需要正确拼帧。应对：在实现里明确处理 `WEBSOCKET_EVENT_DATA` 的分片拼接（可能需要累积缓冲）
- **WebSocket id 冲突**：历史查询与 plan 5 的订阅共享 `message_id` 计数，需要集中分配，避免 inflight 表错配。应对：让 `ha_client` 内部维护单一 `next_message_id`
- **长时运行资源泄漏**：inflight 表、临时数组、LVGL hop 上下文任一忘记释放都会慢慢吃光堆。应对：§6.4 的 6 小时压测作为硬门禁
- **实体变更无感**：Kconfig 目标 `entity_id` 改了需要重烧；MVP 阶段可以接受，未来 `settings_service` 扩展后可从 NVS 读
- **本 plan 可以不做**：若在 M5 收官时预算紧张，**完全不实现本 plan 是可接受的结局**，不影响 `M4` / `M5` exit criteria；主 agent 对此应保持清醒，不要把它当硬阻塞项

## 8. 完成定义

- `ha_client_fetch_history` 已实现，能在 READY 态下完成一次完整的历史拉取并触发回调
- `ui_card_history_chart` 已落地，默认关闭；在开启并配置实体后能在仪表盘上渲染出折线
- `VERIFY:ui:history_chart_ready` 在启用路径下稳定 PASS
- 关闭路径下 `factory` 分区占用不增加（仅 Kconfig / 头文件成本）
- §6 全部用例通过；6.4 的 6 小时压测无明显堆泄漏
- `docs/project-milestones.md` M5 对应条目状态字段更新

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项（待实现后补充）
- 已完成的验证项（待实现后补充）
- 待用户重点查看的文件（待实现后补充）
