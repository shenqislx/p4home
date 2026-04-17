# ui-dashboard-sensor-cards Plan

所属 Milestone: `M5`

## 1. 背景

按 [project-milestones.md](../project-milestones.md) 的最新调整，项目主线是“连接 `Home Assistant` + 图形化展示家庭传感器数据”。`M4` 系列 plan（1~7）把读侧链路打通到 `panel_data_store`：

- plan 1 `network_service_*` 提供 Wi‑Fi 联通
- plan 2 `time_service_*` 提供带时区的时间戳
- plan 3 `settings_service_ha_*` 提供 HA URL / token
- plan 4/5 `ha_client_*` 提供 WebSocket + `state_changed` 订阅
- plan 6 `panel_data_store_*` 提供统一实体缓存 + observer 回调 + freshness tick
- plan 7 `panel_entity_whitelist_*` 把固件内置 JSON 反序列化成 `panel_sensor_t` 种子

截止当前，`firmware/components/ui_pages/` 只有 `home / settings / gateway` 三页 `ui_pages.c`，是 `M2` 的自检骨架：

- `home` 页展示芯片/触摸/音频 bring-up 信息，没有任何家庭实体
- `settings` 页用于显示启动页配置与开关
- `gateway` 页展示 `gateway_service` 的本地邮箱 `panel_state`

这些页面服务 bring-up 期诊断，不承载用户价值。`M5` 需要把“业务首页”落到一个真正渲染 `panel_data_store` 内容的新 `ui_page_dashboard`，并把自检首页降格为“只能从 settings 进入”的诊断页。这是 plan 8，`M5` 主线首个 UI plan，上游依赖 plan 6（store observer + snapshot/iterate）与 plan 7（白名单字段 `group / icon / kind / unit`）。

## 2. 目标

- 新增 `ui_page_dashboard`，作为面板的用户可见首页，渲染 `panel_data_store` 内全量白名单实体
- 提供三种卡片控件：数值卡 / 二值卡 / 多行卡，分别对应 `PANEL_SENSOR_KIND_NUMERIC` / `_BINARY` 以及 `_TEXT + _TIMESTAMP`（后两者共用多行卡）
- 提供五种视觉状态：`loading / ready / stale / disconnected / empty`，每种都有明确的视觉基调（色彩 + 小字标签），断网或陈旧绝不静默
- 实现 observer → LVGL 线程转发，任何 LVGL 对象变更都发生在 LVGL 任务上
- 实现 1 Hz 节拍 `lv_timer`：调用 `panel_data_store_tick_freshness(now_ms)`，并让陈旧卡片视觉降级
- 按 `panel_sensor_t::group` 字段分组分页，使用 LVGL 9 的 `lv_tabview` 或 swipeable pages，默认落在 `CONFIG_P4HOME_DASHBOARD_DEFAULT_PAGE` 指定组
- 卡片网格列数由 `CONFIG_P4HOME_DASHBOARD_COLUMNS` 控制（默认 3）
- 扩展 `display_service_page_t` 增加 `DISPLAY_SERVICE_PAGE_DASHBOARD`，并通过 `settings_service_startup_page_text` 默认切到该页
- 保留老 `home / settings / gateway` 路径：从 `settings` 页保留跳转入口（诊断用），不回归 `M0~M3` 交付
- 对外暴露 ICD plan 8 指定的三个符号：`ui_page_dashboard_init` / `ui_page_dashboard_show` / `ui_page_dashboard_on_sensor_update`
- 启动期 `VERIFY:` 新增 `ui:dashboard_rendered` 与 `ui:dashboard_card_count n=<N>`

## 3. 范围

包含：

- `firmware/components/ui_pages/` 内新增 `dashboard/` 子目录（或平铺 `ui_page_dashboard.c/.h`），保持组件注册不变
- 三种卡片控件的内部实现与刷新函数
- 分组 tabview / 分页骨架
- observer → LVGL 线程 hop：`panel_data_store_set_observer` 注册回调，回调内用 `lv_async_call` 派发到 LVGL 任务
- 1 Hz `lv_timer` 刷新 freshness 与时间相关视觉
- `display_service_page_t` 追加 `DISPLAY_SERVICE_PAGE_DASHBOARD`，`display_service_show_page` / `display_service_current_page_text` 识别新页
- `settings_service` 默认启动页文案扩展到 `"dashboard"`
- `board_support_init` 在 `display_service_init` 之后调用 `ui_page_dashboard_init`；`app_main` 按 `settings_service_startup_page_text` 决定是否调用 `ui_page_dashboard_show`
- Kconfig：`CONFIG_P4HOME_DASHBOARD_COLUMNS` (int, default 3)、`CONFIG_P4HOME_DASHBOARD_DEFAULT_PAGE` (string, default 第一个 group 名)、`CONFIG_P4HOME_DASHBOARD_STALE_VISUAL` (bool, default y)
- VERIFY：`ui:dashboard_rendered:PASS|FAIL`、`ui:dashboard_card_count:n=<N>`

不包含：

- 顶部 Wi‑Fi / HA / 时间连接状态栏（归 plan 9 `ui-connection-status-banner`）
- 历史曲线 / `lv_chart` 卡片（归 plan 11 `ha-history-mini-chart`，可选）
- 控制类控件（开关、亮度、场景调用）：归 `M6` `control-writeback`
- 语音页：归 `M7`
- HA 重连策略、metrics 打点：归 plan 10
- 运行时修改白名单：延后到 `settings_service` / gateway 下发阶段
- 多屏 / 横竖屏自适应：先锁定当前 EV Board 分辨率
- 主题/深色切换：延后

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ui_pages/`
  - `ui_page_dashboard.c`：**新增**，实现本 plan 全部 UI 逻辑
  - `include/ui_page_dashboard.h`：**新增**，声明 plan 8 三个符号
  - `cards/ui_card_numeric.c` + `.h`：**新增**，数值卡
  - `cards/ui_card_binary.c` + `.h`：**新增**，二值卡
  - `cards/ui_card_multiline.c` + `.h`：**新增**，多行卡（承接 text + timestamp 两类）
  - `Kconfig.projbuild`：**新增**，声明 `P4HOME_DASHBOARD_*` 三项
  - `CMakeLists.txt`：`SRCS` 追加新文件；`REQUIRES` 追加 `panel_data_store` 与 `esp_timer`（取 `esp_timer_get_time()` 作为 now_ms，避免在 LVGL tick 里碰 FreeRTOS tick 精度陷阱）
  - `idf_component.yml`：保持 `esp_lvgl_port` 依赖不变
  - `README.md`：补一段 dashboard 职责与线程模型说明
- `firmware/components/display_service/`
  - `include/display_service.h`：`display_service_page_t` 追加 `DISPLAY_SERVICE_PAGE_DASHBOARD = 3`
  - `display_service.c`：`display_service_show_page` 分派到 `ui_page_dashboard_show`；`display_service_current_page_text` 增加 `"dashboard"`
- `firmware/components/settings_service/`
  - 不改 API，只扩展默认 `startup_page_text` 的可选字典（仍是字符串即可），默认值改为 `"dashboard"`，并保留 `"home"` / `"settings"` / `"gateway"` 合法
- `firmware/components/board_support/`
  - `board_support.c`：`display_service_init` 之后调用 `ui_page_dashboard_init`；`board_support_log_summary` 加上 `dashboard_card_count`
- `firmware/main/app_main.c`：
  - 依据 `settings_service_startup_page_text()` 决定默认切到哪一页
  - 注入 `ui:dashboard_rendered` 与 `ui:dashboard_card_count` 两个 `VERIFY:`
- 不新建组件，不新建分区

### 4.2 模块拆解

`ui_page_dashboard.c` 内部分五块职责（共享一个 `static` 上下文）：

1. **上下文**（`static dashboard_ctx_t g_dash`）：
   - `lv_obj_t *root`：承载 tabview 的顶级容器
   - `lv_obj_t *tabview`：分组 tab，按 `group` 动态生成
   - `card_slot_t slots[MAX_CARDS]`：每个 slot 保存 `entity_id`、`lv_obj_t *card`、`panel_sensor_kind_t kind`、所属 `tab_index`
   - `lv_timer_t *tick_timer`：1 Hz 节拍
   - `bool loaded`：是否已完成首次 build
   - `panel_sensor_connection_hint_t conn`：从 `ha_client_state_text` 或 `ha_client_get_state` 缓存的粗粒度“连接好/坏”标志（本 plan 只读不拥有）
2. **布局构建 `dashboard_build_locked(void)`**：
   - 调 `panel_data_store_iterate` 拿全量 snapshot
   - 按 `group` 聚合 → 创建 `lv_tabview` tab
   - 每个 tab 内部用 `lv_obj` + flex 或 `lv_grid` 按 `CONFIG_P4HOME_DASHBOARD_COLUMNS` 列排版
   - 每个 entity 根据 `kind` 分派到对应卡片创建函数
   - 入口状态：若 `entity_count == 0` → `empty`；否则 `loading` 直到首次 observer 更新推回
3. **卡片创建 / 刷新**：
   - `ui_card_numeric_create(parent, sensor)` → 大字号 `value_numeric` + 单位 + label
   - `ui_card_binary_create(parent, sensor)` → 图标 + ON/OFF 色块
   - `ui_card_multiline_create(parent, sensor)` → 上行 `label`、中行 `value_text`、底行相对时间（由 `updated_at_ms` + now_ms 算出）
   - 三种卡片都暴露 `*_apply_locked(lv_obj_t *card, const panel_sensor_t *s)` 做增量刷新
   - 视觉状态应用由 `card_apply_visual_state_locked(card, state)` 统一处理
4. **observer → LVGL 线程 hop**：
   - `ui_page_dashboard_init` 末尾调 `panel_data_store_set_observer(dashboard_observer_cb, NULL)`
   - `dashboard_observer_cb` 运行在 plan 6 内部任务或 plan 5 `ha_client` 任务，**禁止** 直接触碰 LVGL
   - 回调里只做一件事：从池里拿一个 `sensor_event_t`（`entity_id[48]` + `panel_sensor_t` 拷贝），`lv_async_call(dashboard_apply_on_lvgl, ev)`
   - `dashboard_apply_on_lvgl` 在 LVGL 任务上被 LVGL 框架调起，先 `lv_display_trigger_activity`（可选），再查 `slots` → 命中则调 `*_apply_locked`，否则走“动态追加”路径（实体新出现）
5. **tick timer**：
   - `lv_timer_create(dashboard_tick_cb, 1000, NULL)`
   - 回调里拿 `now_ms = esp_timer_get_time() / 1000`，调 `panel_data_store_tick_freshness(now_ms)`
   - 再遍历 slots，对 `freshness == STALE` 的 card 触发 `card_apply_visual_state_locked(card, DASH_VIS_STALE)`（若开启 `CONFIG_P4HOME_DASHBOARD_STALE_VISUAL`）
   - 同时刷新多行卡底部“X 秒前”相对时间

### 4.3 数据流 / 控制流

启动链路：

1. `app_main` → `board_support_init`：`settings_service_init → nvs → network_service_init → time_service_init → display_service_init → ui_page_dashboard_init → panel_data_store_init → panel_entity_whitelist_load → ha_client_init / start`（实际顺序由各 plan board_support 调整合并；dashboard 必须在 `display_service_init` 之后、`panel_data_store_init` 之后）
2. `ui_page_dashboard_init`：
   - 申请一次 LVGL 锁（`esp_lvgl_port` 提供），构建 root + 空 tabview，保存句柄
   - 注册 `panel_data_store_set_observer(dashboard_observer_cb, NULL)`
   - 注册 `lv_timer_create(... 1000ms ...)`
   - 不立刻 build 卡片；等白名单加载完成后，dashboard 第一次被 show 或第一次 observer event 触发时再 build（防止与 whitelist load 有竞争）
3. `app_main` 决定默认页：
   - 读 `settings_service_startup_page_text()`，若返回 `"dashboard"` 则 `display_service_show_page(DISPLAY_SERVICE_PAGE_DASHBOARD)` → 内部分派到 `ui_page_dashboard_show`
   - `ui_page_dashboard_show` 首次执行时若 `!g_dash.loaded` 则同步 `dashboard_build_locked()`，随后发 `VERIFY:ui:dashboard_rendered:PASS` + `VERIFY:ui:dashboard_card_count:n=<N>`

运行时数据流：

```
ha_client  (plan 5 task)
   │ state_change_cb
   ▼
panel_data_store_update  (plan 6 lock)
   │ observer cb
   ▼
dashboard_observer_cb    (非 LVGL 任务)     ── 绝不触碰 LVGL
   │ lv_async_call(fn, ev)
   ▼
dashboard_apply_on_lvgl  (LVGL 任务)        ── 合法的 UI 变更位点
   │ slot 查找 → card_*_apply_locked
   ▼
LVGL 重绘
```

> ⚠️ **关键约束（务必在代码注释里也写一次）**：`dashboard_observer_cb` 在 `panel_data_store` 内部持锁路径或 `ha_client` 任务上执行。若在这里直接调用任何 `lv_obj_*` / `lv_label_set_text` / 状态切换，**会立即破坏 LVGL 状态机并 crash**（非必现，典型是 SEGV 或 `lv_ll` 断言）。统一走 `lv_async_call` 做线程 hop 是本 plan 的硬性约束，不接受例外。

tick 驱动流：

```
lv_timer (1 Hz, LVGL task)
   ▼
panel_data_store_tick_freshness(now_ms)    ── 标记 stale
   ▼
slot 遍历 → freshness 变化 → card_apply_visual_state_locked(STALE)
   ▼
多行卡底部相对时间刷新
```

五种视觉状态的视觉映射（`CONFIG_P4HOME_DASHBOARD_STALE_VISUAL=y` 时）：

| 状态           | 卡片底色            | 边框色            | 额外标签                   |
|----------------|---------------------|-------------------|----------------------------|
| `loading`      | 中性灰              | 点状边框          | `加载中…`                  |
| `ready`        | 主题底色            | 主题强调色        | 无                         |
| `stale`        | 暖灰                | 暗黄              | `数据陈旧` + 灰字相对时间 |
| `disconnected` | 暗灰 + 降透明       | 红色细边          | `连接断开`                 |
| `empty`        | 全页占位            | —                 | `未配置实体`               |

`disconnected` 判定来源：`ha_client_get_state() != HA_CLIENT_STATE_READY`，读值不触发 hop，由 tick 轮询；正式持续指示归 plan 9 状态栏，本 plan 只做卡片级降级。

## 5. 实现任务

代码侧（agent 可完成）：

1. 在 `firmware/components/ui_pages/` 新增 `include/ui_page_dashboard.h`，声明：
   - `esp_err_t ui_page_dashboard_init(void);`
   - `void ui_page_dashboard_show(void);`
   - `void ui_page_dashboard_on_sensor_update(const panel_sensor_t *s);`（内部 observer 转发的公开入口，便于 unit 测试或手动触发）
2. 新增 `ui_page_dashboard.c`：上下文结构、observer 回调、`lv_async_call` hop、tick timer、build/show、`VERIFY:` 打点辅助
3. 新增 `cards/ui_card_numeric.{c,h}` / `cards/ui_card_binary.{c,h}` / `cards/ui_card_multiline.{c,h}`，每个都对外暴露 `_create` 与 `_apply_locked`、`_apply_visual_state_locked`
4. 新增 `firmware/components/ui_pages/Kconfig.projbuild`：
   - `P4HOME_DASHBOARD_COLUMNS` `int` 默认 `3`，范围 `1~6`
   - `P4HOME_DASHBOARD_DEFAULT_PAGE` `string` 默认 `""`（空即采用白名单第一个 group）
   - `P4HOME_DASHBOARD_STALE_VISUAL` `bool` 默认 `y`
5. 更新 `CMakeLists.txt`：`SRCS` 追加 5 个文件；`REQUIRES` 追加 `panel_data_store esp_timer`
6. 扩展 `display_service`：
   - 头文件加 `DISPLAY_SERVICE_PAGE_DASHBOARD = 3`
   - `display_service_show_page` 分派新分支
   - `display_service_current_page_text` 返回 `"dashboard"`
7. 扩展 `settings_service`：不改 API，但默认种子值改为 `"dashboard"`，`README` 追加合法枚举说明
8. 扩展 `board_support`：`board_support_init` 顺序调整，调用 `ui_page_dashboard_init`；`log_summary` 追加 dashboard 卡片数
9. 扩展 `app_main.c`：
   - 根据 `settings_service_startup_page_text()` 首次切页
   - 打 `VERIFY:ui:dashboard_rendered`
   - 打 `VERIFY:ui:dashboard_card_count:n=<N>`，其中 `N = panel_data_store_entity_count()`
10. 更新 `firmware/components/ui_pages/README.md`：补 dashboard 章节 + 线程模型示意

本地硬件侧（用户在配好 IDF 的开发机上完成，agent 给出命令）：

11. `idf.py reconfigure`，确认新 Kconfig 在 `menuconfig` 可见
12. `idf.py build`，确认未再触发 `factory` 分区溢出（参考 ICD §项目上下文的 2% 余量警告）
13. 烧录 → 串口观察 `VERIFY:ui:dashboard_rendered:PASS`、`VERIFY:ui:dashboard_card_count:n=<N>` 是否符合白名单规模
14. 触摸测试：手动左右滑动 tabview，确认卡片不抖动；断网一次观察所有卡片在 ≤ 300s 内进入 stale，并在恢复后自动回 `ready`

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 保持
- `idf.py build` 通过，无新增编译 / 链接错误
- `menuconfig` 中可见 `P4HOME_DASHBOARD_COLUMNS` / `_DEFAULT_PAGE` / `_STALE_VISUAL`
- `firmware/partitions.csv` 不变；构建末尾观察 `factory` 分区剩余 ≥ 1%，否则回到 §7 风险项触发精简动作
- 不触发 `-Werror`；LVGL 9 新 API 不产生 deprecation 警告

### 6.2 功能验证

- 空 `panel_data_store`（白名单 JSON 为空或未加载）：dashboard 显示 `empty` 占位，`VERIFY:ui:dashboard_card_count:n=0`，不崩
- 白名单 ≥ 3 实体、HA 未联通：卡片显示 `loading` → 超过 `panel_data_store` stale 阈值后全部切 `stale`
- HA 连通 + 至少一个 numeric / binary / text 实体：
  - numeric 卡数值与单位正确显示（单位空字符串时不留空白）
  - binary 卡 ON/OFF 视觉区分清晰
  - multiline 卡 `value_text` + 相对时间正确
- observer 触发后卡片刷新延迟 `< 200ms`（主观）
- 分组切换（tab）无卡片错位；`CONFIG_P4HOME_DASHBOARD_COLUMNS` 改 2 / 4 重新构建显示正常
- `settings_service_startup_page_text="dashboard"` 冷启动即落在 dashboard；改为 `"home"` 冷启动仍能进入自检首页（老路径不回归）

### 6.3 回归验证

- 现有 `VERIFY:` 全部保持：`boot / chip / partition / memory / display / touch / audio / sr / settings / gateway / network / time / ha / panel_store / panel_whitelist`
- `ui_pages` 的 home / settings / gateway 三页仍可通过从 settings 页入口进入，渲染无回归
- `app_main` 心跳周期不受 dashboard 影响；`lv_timer` 1 Hz 节拍不与现有 `ui_pages_update_meter_ui` 冲突
- 长跑 2 小时：`esp_get_free_heap_size` 无显著下降；dashboard 的 `slots[]` 不累积重复 entity
- 未启用 ha 连接的冷启路径（MVP 空 SSID 情况下）dashboard 仍能进 `empty` 态而不会 panic

### 6.4 硬件/联调验证

- 真实 HA 环境下，白名单内同时包含 numeric/binary/text 各至少 1 个，观察：
  - `VERIFY:ui:dashboard_rendered:PASS`
  - `VERIFY:ui:dashboard_card_count:n=<N>` 与白名单条目数一致
- 人工拔 AP → 300s 后全部卡片视觉切 `stale`；恢复 AP → 所有卡片在 HA 下一次 `state_changed` 后回 `ready`
- 人工停 HA（保留 Wi‑Fi）：卡片按 stale 规则降级；`ha_client_get_state` 退出 `READY` 时卡片叠加 `disconnected` 轻边框
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-dashboard-v1.log` 作为 review 附件
- 触摸滑动 tabview 至少 30 次，不出现 `lv_async_call` 队列溢出或 `lv_ll` 断言

## 7. 风险

- **UI / 线程安全（最高风险）**：`panel_data_store` observer 回调执行在 plan 6 / plan 5 任务上下文。任何在回调里直接操作 LVGL 对象都会破坏 LVGL 状态机并 crash（典型表现是 `lv_ll` 断言或 SEGV）。本 plan 以 `lv_async_call` 做线程 hop，必须在代码注释、README 里重复强调；code review 要专门检查 observer 回调的任何分支都不得触发 LVGL 变更
- **per-card 堆占用**：LVGL 9 每个 `lv_obj` 带样式/state list，粗估每卡 `~1~2 KB`；白名单若突破 ~30 个实体，仅 card 本身就会吃掉 30~60 KB 堆，叠加 tabview 内部缓存有放大。需要在 `ui_page_dashboard_init` 里读 `panel_entity_whitelist_count()`，超过 `CONFIG_P4HOME_DASHBOARD_COLUMNS * MAX_TABS * 上限` 时给出 `ESP_LOGW`，并在 README 中给出上限指南
- **过多实体导致重绘饱和**：`lv_async_call` 每次 observer 更新都会唤醒 LVGL 任务；在 HA 初始 `get_states` 阶段会瞬时灌入几十~上百条事件。应在 `dashboard_apply_on_lvgl` 内做“同 entity 事件合并”或借用一个 `idle-until` 机制，避免 LVGL 一次 tick 内上百次 invalidate 导致掉帧
- **factory 分区紧张**：ICD 明确当前 `factory` 剩余约 2%。本 plan 引入 3 个卡片 .c + dashboard .c + 对 `panel_data_store` / `esp_timer` 的新 REQUIRES，需要在实现阶段：
  - 卡片内尽量复用 LVGL style（`static lv_style_t`），避免每卡独立 style
  - 若分区溢出，联动固件体积精简 plan（去掉未用的 `ESP-SR` 选项、裁剪 `LOG_DEFAULT_LEVEL` 等）
  - 必要时用 `CONFIG_P4HOME_DASHBOARD_STALE_VISUAL=n` 关掉额外视觉资源作为快速退路
- **`lv_async_call` 队列深度**：LVGL 9 默认队列不大；`ha_client` 初始 `get_states` 批量灌入时可能塞满导致事件丢失。需要在 observer 回调里做池化 + 背压检测，满时合并为 `dirty_all` 标记下一次 tick 统一刷新
- **tab 初次渲染阻塞**：若白名单 30+ 实体，一次性 `dashboard_build_locked` 可能超过单帧预算导致首屏黑屏 200~500ms。必要时拆分为“先创建 tab，再分帧填充 card”的两段式构建
- **与 plan 9 状态栏的顶边栏空间冲突**：本 plan 不做状态栏，但要给未来的 `ui_status_banner_init(parent)` 预留顶部 40px 的 `lv_obj`，免得 plan 9 落地时再大改 dashboard 布局
- **老自检首页回归风险**：`DISPLAY_SERVICE_PAGE_HOME` 仍然存在，`settings` 页保留入口；若 settings 页按钮回调被误改，会让自检路径失联，影响后续 bring-up 调试。回归测试要覆盖三老页入口
- **whitelist 未加载时首次 show**：build 的时机必须晚于 `panel_entity_whitelist_load`；若启动顺序被改动，可能进入“永久 empty”。应在 `ui_page_dashboard_show` 首次执行和第一次 observer 事件两处都做“惰性 build”保护

## 8. 完成定义

- `idf.py build` 成功，`factory` 分区剩余 ≥ 1%
- 冷启动后面板默认停留在 dashboard 页（`settings_service_startup_page_text` 默认 `"dashboard"`）
- 启动日志可见：
  - `VERIFY:ui:dashboard_rendered:PASS`
  - `VERIFY:ui:dashboard_card_count:n=<N>`，`N` 等于 `panel_data_store_entity_count()`
- 在真实 HA 环境下：
  - numeric / binary / multiline 三类卡片各至少 1 个可正确渲染并随 `state_changed` 更新
  - 断网 300s 后全部卡片进入 `stale`；HA 退出 `READY` 后卡片进入 `disconnected` 样式
  - 恢复后卡片能在下一次事件中回到 `ready`
- 三种卡片的 `*_apply_locked` 均只在 LVGL 任务被调用（通过代码路径审查 + 运行时无 `lv_ll` 断言）
- observer 回调内无任何 `lv_*` 直接调用（由 review 人工确认）
- 老 `home / settings / gateway` 三页仍可通过 settings 入口到达，无视觉或功能回归
- plan 8 ICD 三个符号 `ui_page_dashboard_init` / `_show` / `_on_sensor_update` 完整导出
- `ui_pages/README.md` 与 `display_service.h` 注释已同步更新，线程模型警告显式写明

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
