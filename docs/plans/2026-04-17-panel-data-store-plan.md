# panel-data-store Plan

所属 Milestone: `M4`

## 1. 背景

根据 [project-milestones.md](../project-milestones.md) §4 `M4` 的交付要求，面板要把 `Home Assistant` 订阅到的实体状态以“线程安全的只读 snapshot / observer 事件”形式交给 UI 层（`M5`）消费。plan 5（`ha-client-state-subscription`）已经约定：

- 在 `ha_client` 内部任务上调用 `ha_client_state_change_cb_t` 回调
- 回调里**不能**直接访问 `LVGL`
- 初始全量（`get_states`）与增量（`state_changed`）共用同一个回调路径

因此需要一个位于 `ha_client` 与 UI 之间的**内存数据中台**：接收 `ha_client` 的回调，按 `entity_id` 归并最新值、属性、时间戳、新鲜度；对上层提供稳定、可快照、可订阅的接口。这层也需要承担“白名单闸门”的职责——只有 plan 7（`panel-entity-whitelist-config`）提前 `register` 的 `entity_id` 才被接受，避免 HA 端上百个实体全部挤入内存。

仓库现状（2026-04-17）：

- 还没有 `firmware/components/panel_data_store/`
- `ha_client` 的回调签名由 plan 5 锁定为 `ha_client_set_state_change_callback(cb, user)`
- `firmware/components/gateway_service/gateway_service.c` 已经示范了一套 `portMUX_TYPE` + snapshot 拷贝的线程安全写法，本 plan 在锁粒度和“拷贝出临界区后再打印”上对齐该风格，但换用 `SemaphoreHandle_t`（见 §4）

本 plan 是 `M4` 的第 6 号 plan，属于 UI 之前的最后一块“只读数据底座”。完成后 plan 8（dashboard 卡片）、plan 9（状态栏）均可直接消费。

## 2. 目标

- 新建组件 `firmware/components/panel_data_store/`，对外提供 ICD 约定的 `panel_data_store_*` API 与 `panel_sensor_t` 数据结构
- 以**固定大小数组**持有全部白名单实体，`CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES`（默认 `32`）为硬上限，容量不足时拒绝 `register` 并记录告警
- 作为 plan 5 的下游：通过 `ha_client_set_state_change_callback` 注册一个内部 trampoline，把每条 `ha_client_state_change_t` 转换成 `panel_data_store_update`
- 实现“已注册才接受更新”的 whitelist 闸门（非白名单实体直接被丢弃并累计一个计数）
- 提供线程安全的 snapshot/iterate/count API，`observer` 单槽回调在 `ha_client` 任务上同步触发，消费者自行线程跳转
- 实现基于可配置阈值 `CONFIG_P4HOME_PANEL_STORE_STALE_THRESHOLD_MS`（默认 `300000`）的 `panel_data_store_tick_freshness(now_ms)`，由 `app_main` 现有心跳（每 10s）驱动
- 在启动摘要期输出 `VERIFY:panel_store:ready` 与 `VERIFY:panel_store:entity_count:n=<N>`（在 plan 7 加载白名单之后打印）
- `board_support_init` 中在 `ha_client_init` 之前调用 `panel_data_store_init`，保证 plan 5 回调注册时 store 已就绪

## 3. 范围

包含：

- 新组件目录 `firmware/components/panel_data_store/`（`.c/.h/CMakeLists.txt/Kconfig.projbuild/README.md`）
- `panel_sensor_kind_t` / `panel_sensor_freshness_t` / `panel_sensor_t`（字段严格按 ICD）
- `panel_data_store_init / register / update / get_snapshot / iterate / entity_count / tick_freshness / set_observer` 八个对外 API
- 单槽 observer 回调 `panel_data_store_observer_cb_t`
- 线程安全：`SemaphoreHandle_t` 互斥锁，写/遍历入锁，单条 getter 入短临界区
- Kconfig：`CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES`、`CONFIG_P4HOME_PANEL_STORE_STALE_THRESHOLD_MS`、`CONFIG_P4HOME_PANEL_STORE_AUTOSTART`
- `board_support` 中把 `panel_data_store_init` 串入初始化链，并在 `ha_client_init` 之前
- 与 `ha_client` 的对接：在 `panel_data_store_init` 里调用 `ha_client_set_state_change_callback`（要求 `ha_client_init` 由调用方在本函数之后执行 `start`；注册仅缓存回调指针，不触发拨号）
- `value_numeric` / `value_text` 的解析策略：`PANEL_SENSOR_KIND_NUMERIC` 走 `strtod`，失败时保持 `freshness=UNKNOWN` 并将原始文本落入 `value_text`
- `VERIFY:panel_store:ready` 与 `VERIFY:panel_store:entity_count:n=<N>`，后者在 `app_main` 调用 `panel_entity_whitelist_load` 之后打印
- 启动摘要：`panel_data_store_log_summary`（非 ICD，但对齐 `gateway_service_log_summary` 风格，加进 `board_support_log_summary`）

不包含：

- 白名单 JSON 解析与嵌入（归 plan 7 `panel-entity-whitelist-config`）
- `cJSON` 对 `attributes_json` 的深度解析（store 只做透传/节选，UI 需要更多字段时在 plan 8 里扩展 `panel_sensor_t` 或增加 getter）
- UI 渲染、卡片、状态栏（归 plan 8/9）
- `ha_client` 重连、metrics、断线判定（归 plan 10）
- 历史曲线、时序数据（归 plan 11 可选）
- 持久化到 NVS（store 本身是易失；重启后由 `get_states` 全量恢复）
- 多 observer 订阅（本 plan 只做单槽；如未来 plan 9 也要监听，再扩展为小型数组）

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/panel_data_store/`（新建）
  - `panel_data_store.c`：实现
  - `include/panel_data_store.h`：ICD 所列全部类型与 API
  - `CMakeLists.txt`：`SRCS panel_data_store.c`，`REQUIRES freertos esp_common log ha_client`
  - `Kconfig.projbuild`：`P4HOME_PANEL_STORE_MAX_ENTITIES` / `P4HOME_PANEL_STORE_STALE_THRESHOLD_MS` / `P4HOME_PANEL_STORE_AUTOSTART`
  - `README.md`：职责边界、与 plan 5 / plan 7 / plan 8 的关系说明
- `firmware/components/board_support/`
  - `board_support.c` / `include/board_support.h`：在 `ha_client_init` **之前**调用 `panel_data_store_init`，并在 `board_support_log_summary` 里追加 store 行
  - `CMakeLists.txt`：`REQUIRES` 追加 `panel_data_store`
- `firmware/main/app_main.c`：在 plan 7 完成白名单注入后，追加 `VERIFY:panel_store:ready` 与 `VERIFY:panel_store:entity_count:n=<N>`；在心跳循环每 10s 的 tick 里调用 `panel_data_store_tick_freshness(now_ms)`
- `firmware/sdkconfig.defaults`：不改动（默认值都在 Kconfig 声明）
- `firmware/partitions.csv`：不改动
- `firmware/dependencies.lock`：不改动（本组件不引入 managed component）
- 不新建分区，不改动 `LVGL` 相关组件

### 4.2 模块拆解

`panel_data_store.c` 内部拆成四个小职责（仍在同一 `.c`）：

- **存储层**：`static panel_sensor_t s_entities[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES];` + `static size_t s_count;`；使用 `SemaphoreHandle_t s_mutex`（通过 `xSemaphoreCreateMutex` 在 `panel_data_store_init` 内创建）
- **查找层**：`static int find_index_locked(const char *entity_id)`，对 N≤32 的规模采用**线性扫描 + `strncmp`**；注释里明确“若未来提高上限到 >64，需要改为散列表或按 entity_id 排序 + 二分”
- **注册/更新层**：
  - `panel_data_store_register`：要求 `seed->entity_id` 非空，检查是否已存在（已存在则覆盖 seed 的 `label/unit/icon/group/kind`，保留已有 `value_*` 与 `updated_at_ms`；初次注册时 `freshness=UNKNOWN`，`updated_at_ms=0`），容量满返回 `ESP_ERR_NO_MEM`
  - `panel_data_store_update`：仅当 `entity_id` 在表中才写入；否则返回 `ESP_ERR_NOT_FOUND` 并累加 `s_rejected_count`。按 `kind` 分流：
    - `NUMERIC`：`strtod` 解析 `state_value`，成功写 `value_numeric`，失败回退到 `value_text` 并保持上一次 `value_numeric`
    - `BINARY`：把 `"on"/"off"/"open"/"closed"/"home"/"not_home"` 映射到 `value_numeric=1.0/0.0`，原文落 `value_text`
    - `TEXT`：只写 `value_text`
    - `TIMESTAMP`：`state_value` 作 ISO8601 透传进 `value_text`，`value_numeric` 保留为 0
  - 写入后 `freshness=FRESH`，`updated_at_ms=ts_ms`
- **观察者层**：
  - `static panel_data_store_observer_cb_t s_observer; static void *s_observer_user;`
  - `panel_data_store_set_observer` 在互斥锁下替换指针
  - 更新成功后，**在释放互斥锁之后**用**临界区拷贝出的** `panel_sensor_t` 调用 observer（对齐 `gateway_service_publish_panel_state` 的“拷贝再打印”风格，避免持锁回调带来的死锁风险）
- **陈旧性层**：`panel_data_store_tick_freshness(now_ms)` 在互斥锁内遍历，`updated_at_ms != 0 && (now_ms - updated_at_ms) > threshold_ms` 则置 `STALE`；由 `FRESH → STALE` 的跃迁同样触发 observer（携带快照）

plan 5 对接：`panel_data_store_init` 末尾调用：

```
ha_client_set_state_change_callback(&panel_data_store_on_ha_state_change, NULL);
```

`panel_data_store_on_ha_state_change` 内部只做 `panel_data_store_update(change->entity_id, change->state_value, change->attributes_json, change->updated_at_ms)`，不做任何其他操作。该 trampoline 在 `ha_client` 任务上运行，是观察者回调的“上游线程”。

### 4.3 数据流 / 控制流

启动链路：

1. `board_support_init`：
   1. `settings_service_init`
   2. `network_service_init`
   3. `time_service_init`
   4. **`panel_data_store_init`**（本 plan）——创建 `s_mutex`、清零 `s_entities`、向 `ha_client` 注册 trampoline（即便此时 `ha_client` 尚未 `start` 也允许，因为只是存指针）
   5. `ha_client_init`
2. `app_main` 启动阶段：
   1. `board_support_init`
   2. `panel_entity_whitelist_load`（plan 7 实现）→ 内部循环 `panel_data_store_register(seed)`
   3. `ha_client_start`
   4. `ha_client_wait_ready(...)`
   5. 输出 `VERIFY:panel_store:ready` 与 `VERIFY:panel_store:entity_count:n=<entity_count>`（来自 `panel_data_store_entity_count()`）
3. `app_main` 心跳循环：
   - 每 10s 一次 tick：
     - `int64_t now = esp_timer_get_time() / 1000;`（ms）
     - `panel_data_store_tick_freshness(now);`

运行时数据流：

1. HA server 推送 `state_changed` 事件
2. `ha_client` 任务解析 `cJSON`，得到 `ha_client_state_change_t`
3. `ha_client` 调用已注册的 `panel_data_store_on_ha_state_change`
4. store 加锁 → 线性查 `entity_id` → 命中则按 `kind` 归并字段 → 拷贝一份 `panel_sensor_t` 到栈上 → 释放锁
5. 若有 observer，则在释放锁后用栈副本同步调用
6. observer（由 plan 8 / plan 9 提供）在回调内部仅做 `lv_async_call` 之类的线程跳转，不碰 LVGL

读路径（UI 刷新）：

- 单个查询：`panel_data_store_get_snapshot("sensor.living_room_temperature", &out)` → 短临界区内拷出 `panel_sensor_t` → 返回 `true/false`
- 批量遍历：`panel_data_store_iterate(buf, max)` → 整段持锁 `memcpy`；`max` 与 `s_count` 取小值 → 返回实际写入数
- `panel_data_store_entity_count()` → 短临界区返回 `s_count`

### 4.4 Kconfig 与参数

新增 `firmware/components/panel_data_store/Kconfig.projbuild`：

- `P4HOME_PANEL_STORE_MAX_ENTITIES`：`int`，默认 `32`，范围 `1..128`；编译期决定 `s_entities` 数组大小
- `P4HOME_PANEL_STORE_STALE_THRESHOLD_MS`：`int`，默认 `300000`（5 分钟），范围 `5000..3600000`
- `P4HOME_PANEL_STORE_AUTOSTART`：`bool`，默认 `y`；若为 `n`，`panel_data_store_init` 仅建锁与清零但**不**调用 `ha_client_set_state_change_callback`，便于未来只跑本地 fixture 测试

### 4.5 对外 API 速览（与 ICD 对齐）

- `esp_err_t panel_data_store_init(void);`
- `esp_err_t panel_data_store_register(const panel_sensor_t *seed);`
- `esp_err_t panel_data_store_update(const char *entity_id, const char *state_value, const char *attributes_json, int64_t ts_ms);`
- `bool panel_data_store_get_snapshot(const char *entity_id, panel_sensor_t *out);`
- `size_t panel_data_store_iterate(panel_sensor_t *out_array, size_t max);`
- `size_t panel_data_store_entity_count(void);`
- `void panel_data_store_tick_freshness(int64_t now_ms);`
- `typedef void (*panel_data_store_observer_cb_t)(const panel_sensor_t *snapshot, void *user);`
- `esp_err_t panel_data_store_set_observer(panel_data_store_observer_cb_t cb, void *user);`

命名严格不变；头文件不对外暴露 `s_entities` 等静态符号。

## 5. 实现任务

代码侧（agent 可完成）：

1. 新建 `firmware/components/panel_data_store/` 目录与 `CMakeLists.txt`，`REQUIRES freertos esp_common log ha_client`
2. 新建 `include/panel_data_store.h`：按 ICD 定义 `panel_sensor_kind_t`、`panel_sensor_freshness_t`、`panel_sensor_t`（含 `entity_id[48]/label[32]/unit[8]/icon[16]/group[16]/kind/value_numeric/value_text[32]/updated_at_ms/freshness`），`panel_data_store_observer_cb_t`，以及 9 个对外 API
3. 新建 `panel_data_store.c`：
   - 静态存储 `s_entities[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES]` / `s_count` / `s_rejected_count` / `s_observer` / `s_observer_user` / `s_mutex`
   - `find_index_locked` 线性扫描
   - `register / update / get_snapshot / iterate / entity_count / tick_freshness / set_observer` 实现
   - `panel_data_store_on_ha_state_change` trampoline，`init` 里按 `AUTOSTART` 决定是否注册到 `ha_client`
   - `panel_data_store_log_summary`：打印 `count / rejected / stale / threshold`，供 `board_support_log_summary` 调用
   - 遵守 `gateway_service_publish_panel_state` 的“先把需要记日志/回调的字段拷出临界区，再退出锁”的写法
4. 新建 `Kconfig.projbuild`：声明 3 个键
5. 新建 `README.md`：写清职责边界、线程模型、与 plan 5/7/8 的边界
6. 扩展 `firmware/components/board_support/board_support.c`：
   - 在 `ha_client_init` 之前调用 `panel_data_store_init`
   - 在 `board_support_log_summary` 里追加 `panel_data_store_log_summary()`
   - `CMakeLists.txt` `REQUIRES` 追加 `panel_data_store`
7. 扩展 `firmware/main/app_main.c`：
   - 在白名单加载 + `ha_client_start` 之后：`log_verify_marker("panel_store", "ready", ...)`；`log_verify_marker_formatted("panel_store", "entity_count", "n=%zu", panel_data_store_entity_count())`
   - 心跳循环每 10s 调用 `panel_data_store_tick_freshness(esp_timer_get_time()/1000)`

本地硬件侧（用户在开发机上完成，agent 提供命令）：

8. `idf.py reconfigure` + `idf.py build`，确认无编译/链接错误
9. `idf.py menuconfig` 验证 3 个新 Kconfig 可见、默认值正确
10. `idf.py flash monitor` 冷启动，收集串口日志作为 review 附件（至少观察 `VERIFY:panel_store:ready:PASS` 与 `entity_count:n=<>` 两行）
11. 配合 plan 7 落地后做一次端到端实机验证（见 §6.4）

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 保持；`idf.py build` 通过
- `panel_data_store` 出现在组件依赖图中；`board_support` / `app_main` 都可见头文件
- `menuconfig` 中 `Component config → P4Home Panel Data Store` 下三个键可见，默认值分别为 `32` / `300000` / `y`
- `CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES=1` 与 `=64` 两种极端值下均可成功编译（保证 `sizeof(s_entities)` 无越界警告）

### 6.2 功能验证（可在不连 HA 的情况下本地跑）

- 冷启动日志包含：
  - `VERIFY:panel_store:ready:PASS`
  - `VERIFY:panel_store:entity_count:n=0`（plan 7 尚未合并时）或 `n=<whitelist 数量>`（plan 7 合并后）
- 手工在 `app_main` 临时 fixture 里调用 `panel_data_store_register` 注入 2~3 条种子，再调 `panel_data_store_update`，观察：
  - 命中白名单的 `update` 返回 `ESP_OK`，`get_snapshot` 能取回 `freshness=FRESH` 且 `value_numeric` / `value_text` 合理
  - 未注册的 `entity_id` 调 `update` 返回 `ESP_ERR_NOT_FOUND`，计数 `rejected` 增长
  - 连续 `register` 超过 `CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES` 返回 `ESP_ERR_NO_MEM`
- 把 `CONFIG_P4HOME_PANEL_STORE_STALE_THRESHOLD_MS` 调到 `3000`，等待 >3s 后 tick 一次，`freshness` 由 `FRESH → STALE`，observer 被触发一次

### 6.3 回归验证

- plan 1~5 现有 `VERIFY:network:*` / `VERIFY:time:*` / `VERIFY:settings:ha_credentials_present` / `VERIFY:ha:ws_connected|authenticated|subscribed` 全部不回归
- `gateway_service` / `display_service` / `ui_pages` / `diagnostics_service` 未被修改，启动摘要行顺序与 plan 1 基线一致（仅新增 store 行，不改既有行格式）
- `app_main` 心跳周期仍为 10s，不会因 `tick_freshness` 额外阻塞超过 5ms（在 N≤32 的线性扫描下实测应 <1ms）
- 二次冷启动（已在 NVS 有 HA 凭证）整链仍可在 30s 内完成 `VERIFY:ha:initial_states_loaded`

### 6.4 硬件/联调验证

前置：plan 7 的白名单 JSON 已合入（或临时 hardcode 2~3 个真实 HA 实体做联调）。

- `idf.py flash monitor` 冷启动串口日志应出现：
  - `panel_store: ready`
  - `panel_whitelist:parsed n=<N>` 之后紧跟 `VERIFY:panel_store:entity_count:n=<N>`（两个 N 必须一致）
  - 在 `VERIFY:ha:initial_states_loaded` 之后的 5s 内，至少观察到一条 `panel_data_store: entity=sensor.xxx value=... freshness=fresh`（由 observer/内部 log 打印）
- 在 HA 侧手工触发某个已注册实体状态变化，面板串口应在 2s 内观察到更新日志；未在白名单的实体不应出现
- 拔网 / 断 HA 超过 `CONFIG_P4HOME_PANEL_STORE_STALE_THRESHOLD_MS` 后，心跳 tick 将相应实体标为 `stale`，observer 被再次触发（为 plan 8 的 UI 提供状态源）
- 2 小时长跑：
  - `panel_data_store_entity_count()` 保持与白名单一致，不漂
  - `heap_caps_get_free_size(MALLOC_CAP_8BIT)` 不持续下降（store 本身不在 heap 上分配，只验证不因 observer 回调引入泄漏）
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-panel-store-v1.log` 作为 review 附件

## 7. 风险

- **内存占用**：按 ICD 字段估算，单个 `panel_sensor_t` 约为 `48+32+8+16+16 + 4(enum) + 8(double) + 32 + 8(int64) + 4(enum) ≈ 176 字节`，`32` 条时约 `5.6KB` 静态 BSS；若未来提高 `MAX_ENTITIES` 到 `128` 则接近 `22KB`，对 `factory` 分区与 PSRAM 无显著压力，但对 `.bss` 分区需要观察；本 plan 默认保持 `32` 以避免占用扩张，配合主线“固件体积敏感”的约束
- **`entity_id` 字符串冲突 / 越界**：`entity_id[48]` 对 HA 社区常见命名足够，但少量自动化脚本会生成 `sensor.<very_long_area_name>_<metric>` 接近 48 字符。`register` / `update` 都必须以 `strnlen(..., 48)` 判断并拒绝超长（返回 `ESP_ERR_INVALID_ARG`），避免 `strncmp` 命中半截字符串造成实体混淆；同时在 `README.md` 明确建议用户在 HA 里把实体重命名到 <47 字符
- **stale 与 disconnected 的语义区分**：`panel_data_store_tick_freshness` 只看 `now_ms - updated_at_ms`，在 Wi‑Fi 断开但数据本身很新时，实体仍会在阈值内保持 `FRESH`——这是故意的。真正的“HA 链路断开”由 plan 10 的 `ha_client_get_state()!=READY` 表示，由 UI（plan 9 状态栏）负责展示，store 本 plan 不把“disconnected”塞进 `panel_sensor_freshness_t`。README 与 §4.2 必须把这一边界写清楚，避免 plan 8 误把 stale 当作“断线”
- **observer 线程上下文**：回调跑在 `ha_client` 任务上，消费者若直接调用 LVGL API 会踩线程安全红线。已在 `README.md` 与 `include/panel_data_store.h` 注释里醒目标注“必须 `lv_async_call` / `esp_lvgl_port` 跳线”
- **更新阶段持锁时间**：`panel_data_store_update` 内部不做 JSON 深解析，仅 `strtod` + 少量 `memcpy`，持锁时间应 <100μs；但若后续 plan 在回调里做了 JSON 透传到 UI，需确保**不要**在持锁期间触发 observer，否则 observer 做 `lv_async_call` 内部短锁可能引入反向依赖
- **plan 间时序**：`panel_data_store_init` 必须在 `ha_client_set_state_change_callback` 之前发生；若 plan 7 的 `panel_entity_whitelist_load` 晚于 `ha_client_start`，初始 `get_states` 时大量实体会落入 `rejected`。对策：`app_main` 必须按“init store → load whitelist → ha_client_start”顺序执行，§4.3 已显式写明
- **固件体积**：新增 `.c` 仅依赖 `freertos` / `log` / `ha_client`，无引入新的 managed component，估算 `<4KB` text，对剩余 2% `factory` 分区影响可接受；若后续在本 plan 内再塞 `cJSON` 深解析则会把体积推高，需挪到 plan 8
- **`SemaphoreHandle_t` vs `portMUX_TYPE`**：当前 `gateway_service` 用的是 `portMUX_TYPE`（任务级自旋锁，禁止在持锁期间阻塞或调用日志）。本 plan 用 `SemaphoreHandle_t` 是因为 observer 调用、`ESP_LOGx` 都可能在持锁期间间接发生；若联调期实测出现优先级反转或死锁，需回退到 `portMUX_TYPE` + “只在锁外打印/回调”的模式

## 8. 完成定义

- `firmware/components/panel_data_store/` 组件存在，对外头文件符号与 ICD 完全一致（无重命名、无漏项）
- `idf.py build` 成功；`CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES` / `_STALE_THRESHOLD_MS` / `_AUTOSTART` 三个 Kconfig 可在 `menuconfig` 调整
- 冷启动串口日志可见 `VERIFY:panel_store:ready:PASS` 与 `VERIFY:panel_store:entity_count:n=<N>`，`<N>` 与 plan 7 实际白名单数量一致
- 配合 plan 5 / plan 7 联调：HA 端变化的白名单实体能在 2s 内经 `update` 落入 store，observer 被触发至少一次
- 停更超过阈值后，`tick_freshness` 能把对应实体置 `STALE` 并触发 observer
- 未注册实体的 `update` 被拒绝并累计到 `rejected` 计数
- `board_support_log_summary` 输出包含 store 行；现有 `VERIFY:` 基线全部不回归
- `README.md` 描述线程模型、stale/disconnected 区分、entity_id 长度约束

## 9. review 准备

在邀请用户 review 前补充：

- 已完成的实现项
- 已完成的验证项
- 待用户重点查看的文件

### 已完成的实现项

（待实现后补充）

### 已完成的验证项

（待实现后补充）

### 待重点查看的文件

（待实现后补充）
