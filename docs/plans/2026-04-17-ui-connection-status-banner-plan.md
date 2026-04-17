# ui-connection-status-banner Plan

所属 Milestone: `M5`

## 1. 背景

依据 [project-milestones.md](../project-milestones.md) §4 `M5` 的交付物清单，dashboard 页之外还需要一条“顶部状态栏”，以常驻方式告诉用户当前面板的三件事：

- Wi‑Fi 是否连通、拿到的 IP 后缀（便于在多 AP 场景快速区分）
- `Home Assistant` WebSocket 客户端的状态（是否已 `ready` / 正在 `auth` / 断开 / 错误）
- 本地时间 `HH:MM`（用于状态化展示“最后一次同步在几分钟前”的心理预期）

当前 `firmware/components/ui_pages/` 只有 `ui_pages.c` 中的 Home / Settings / Gateway 三页自检 UI，还没有跨页常驻控件的概念。上游 plan 已经把真正可用的数据都就位：

- plan 1 `network_service`：`network_service_wifi_connected` / `network_service_wifi_has_ip` / `network_service_ip_text` / `network_service_wifi_started`
- plan 2 `time_service`：`time_service_is_synced` / `time_service_format_now_iso8601`
- plan 4 `ha_client`：`ha_client_get_state` / `ha_client_state_text`
- plan 6 `panel_data_store`：`panel_data_store_entity_count`（用来在 banner 空间允许时附加一个 “N traits tracked” 提示，属可选渲染）

本 plan 是 `M5` 的第 9 号 plan，目标是在不新增组件的前提下，给 `ui_pages` 加一条 1 Hz 轮询的跨页常驻状态栏，并优先接入 plan 8 `ui_page_dashboard`。

## 2. 目标

- 在 `ui_pages` 内新增 `ui_status_banner` 模块，作为任意 LVGL 容器的子对象出现在顶部，横跨整屏宽度
- 三个分区固定布局：左 Wi‑Fi、中 HA 状态 pill、右本地时间
- 单一 LVGL timer（`lv_timer_create`）以 1 Hz 轮询上游 getter，避免为这条慢速信息另起任务/观察者
- 对外只暴露 2 个符号：`ui_status_banner_init(lv_obj_t *parent)`、`ui_status_banner_tick(void)`
- 接入 `ui_page_dashboard_init` 的根容器，使 banner 在仪表盘页生效；`home` / `settings` / `gateway` 预留后续按需接入（本 plan 不做）
- 启动完成后打印 `VERIFY:ui:status_banner_ready:PASS`
- 保持离线可运行：上游任一服务未初始化或尚未 ready 时，banner 仍能渲染占位（Wi‑Fi 红点、HA `disconnected`、时间 `--:--`），不能 panic

## 3. 范围

包含：

- `firmware/components/ui_pages/` 内部新增 `ui_status_banner.c` + `include/ui_status_banner.h`
- `ui_status_banner_init(lv_obj_t *parent)`：构建顶部容器、左/中/右三个子 label/icon、挂载 1 Hz `lv_timer`；返回 `ESP_OK` / `ESP_FAIL` / `ESP_ERR_INVALID_ARG`
- `ui_status_banner_tick(void)`：等价于 timer 回调，供需要立即强刷新的上游（如页面切换后）主动调用一次
- 1 Hz timer 内读取：
  - `network_service_wifi_started` / `_wifi_connected` / `_wifi_has_ip` / `_ip_text`
  - `ha_client_get_state` / `ha_client_state_text`
  - `time_service_is_synced` / `time_service_format_now_iso8601`
- Wi‑Fi 图标三档状态渲染（`disconnected` / `connecting` / `connected`），`connecting` 定义为 `wifi_started && !wifi_connected`
- 右侧时间：从 `time_service_format_now_iso8601` 返回的 ISO8601 串中截出 `HH:MM` 5 字符片段；`time_service_is_synced` 为 `false` 时显示 `--:--`
- 中部 HA pill：文本直接取 `ha_client_state_text(ha_client_get_state())`，按状态映射到固定底色（`ready` 绿、`auth` / `connecting` 黄、`disconnected` 灰、`error` 红）
- IP 后缀渲染：当 `CONFIG_P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX=y` 且 `wifi_has_ip=true` 时，在 Wi‑Fi 图标右侧显示 `.<last_octet>`；IPv6 或非点分格式直接降级为空串
- banner 高度：`CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT`，默认 `36`
- 在 plan 8 `ui_page_dashboard_init` 内，构建完 dashboard root 容器后立即调用 `ui_status_banner_init(root)`，并相应让卡片栅格的起始 `y` 偏移 `CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT`
- 启动摘要新增 `VERIFY:ui:status_banner_ready`

不包含：

- 不新建独立组件，不拆 `ui_components/`
- 不做任何交互（tap 打开 settings、长按弹 diagnostics 等，归后续 plan）
- 不做通知/告警条目（比如 HA 错误详情滚动、OTA 进度条），归 `M8`
- 不做音量/亮度/睡眠等全局控件
- 不做对 `home` / `settings` / `gateway` 现有页面的接入（只占位，放在 review 备注里供后续 plan）
- 不提供销毁接口（`ui_status_banner_destroy` 留白，后续需要时再补）
- 不订阅 `panel_data_store_set_observer`；`entity_count` 只在 timer 里一次性 `panel_data_store_entity_count()` 轮询（可选，仅在 banner 有空位且 Kconfig 未来开启时）
- 不做多语言 / 动态主题切换

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/ui_pages/`
  - `ui_status_banner.c`：**新增**，banner 的构建、timer、渲染
  - `include/ui_status_banner.h`：**新增**，只导出 `ui_status_banner_init` / `ui_status_banner_tick`
  - `ui_pages.c`：**无修改**（现有 home / settings / gateway 页在本 plan 不接入 banner）
  - `Kconfig.projbuild`：**新增或扩展**，追加 `P4HOME_UI_STATUS_BANNER_HEIGHT` / `P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX`
  - `CMakeLists.txt`：`SRCS` 追加 `ui_status_banner.c`；`REQUIRES` 追加 `network_service`、`time_service`、`ha_client`、`panel_data_store`
  - `README.md`：补一段“顶部状态栏 `ui_status_banner` 模块”说明
- `firmware/components/ui_pages/` 内 plan 8 新建的 `ui_page_dashboard.c`：**本 plan 追加**
  - 构建完 dashboard root 容器后调用 `ui_status_banner_init(root)`，并将卡片栅格起始 `y` 偏移 `CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT`
- `firmware/main/app_main.c`：追加 `log_verify_marker("ui", "status_banner_ready", ...)` 一项，基于 `ui_status_banner_init` 的返回值
- 不新增组件、不改分区、不动 `sdkconfig.defaults`

### 4.2 模块拆解

`ui_status_banner.c` 内部分成四个小职责（同一文件）：

- **构建**：`ui_status_banner_init`
  - `lv_obj_create(parent)` → 设置 `LV_ALIGN_TOP_MID`、`lv_obj_set_size(banner, LV_PCT(100), CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT)`
  - 背景色固定深灰、无边框、内边距 4px；样式只用 LVGL 内建，不引入新字体
  - 三个 flex 子容器：左 `banner_left` / 中 `banner_mid` / 右 `banner_right`
  - 左容器内两个 label：`wifi_icon_label`（Unicode 三态图标，来自 `LV_SYMBOL_*` 或现有 font）+ `ip_suffix_label`
  - 中容器一个 `ha_pill_label`（以 label + 背景色 style 组合，不新建 button）
  - 右容器一个 `time_label`
  - 构造完毕后立刻调用一次 `ui_status_banner_tick()`，让首帧就有内容
  - 以 `lv_timer_create(timer_cb, 1000, NULL)` 注册周期 timer；timer 句柄存模块静态变量
- **刷新**：`ui_status_banner_tick`
  - 读三组上游 getter；未初始化/未 ready 时按占位值处理（空串/`--:--`/`disconnected`）
  - Wi‑Fi 三态判定：
    - `!wifi_started || !wifi_connected && !wifi_has_ip` → `disconnected`
    - `wifi_started && !wifi_connected` → `connecting`
    - `wifi_connected && wifi_has_ip` → `connected`
  - IP 后缀：`ip_text` 不为空且包含最后一个 `.` 时取 `.<tail>`；否则清空（IPv6 / 空串 / 非点分格式全走清空分支）
  - HA pill：`state_text` + 底色映射表（静态数组）
  - 时间：`char iso[32]; time_service_format_now_iso8601(iso, sizeof(iso));`，若 `time_service_is_synced()==false` 或字符串长度 <16（ISO8601 至少要到分钟位）则显示 `--:--`，否则从索引 11 开始拷 5 字节
- **状态存储**：三组字段缓存上一次 label 文本（`char wifi_text_prev[...]` 等），只有文本变化时才 `lv_label_set_text`，减少 LVGL 无效重绘
- **线程约束**：timer 回调运行在 LVGL 任务上下文，可以安全操 widget；getter 均被上游标注线程安全，可直接调用

### 4.3 数据流 / 控制流

启动链路：

1. `board_support_init` → `settings_service_init` → `network_service_init` → `time_service_init` → `ha_client_init` / `ha_client_start` → `panel_data_store_init` → `panel_entity_whitelist_load`
2. `display_service_start` 与 `ui_page_dashboard_init` 调用顺序不变（见 plan 8）；`ui_page_dashboard_init` 内部在构建完根容器后调用 `ui_status_banner_init(root)`
3. `ui_status_banner_init` 立刻做一次 `tick()`（首帧），随后由 LVGL timer 接管
4. `app_main` 在 `VERIFY:` 阶段新增：`VERIFY:ui:status_banner_ready:PASS|FAIL`，判定来自 `ui_page_dashboard_init` 透传的 banner init 结果

运行时 per-tick 流程：

- 1 Hz timer 触发 → 读三个上游 getter → 与前一帧缓存对比 → 只在变化时调用 `lv_label_set_text` 或 `lv_obj_set_style_bg_color`
- 上游任一 getter 返回 NULL 或 0 / 未同步：走占位渲染分支，不访问 null 指针
- 中途若上游组件还未编译进固件（构建裁剪场景），由 `ui_pages` 的 `REQUIRES` 保证链接可解析；真实功能失败交给占位渲染吸收

控制流风险边界：

- timer 回调内禁止长阻塞（字符串扫描 O(16)、无内存分配），严守“回调即刻返回”原则
- `tick()` 也可由外部在页面切换后主动调用一次，用来把旧页面残留的显示状态立即刷成当前真值

## 5. 实现任务

代码侧（agent 可完成）：

1. 在 `firmware/components/ui_pages/include/` 新增 `ui_status_banner.h`，只声明 `ui_status_banner_init` / `ui_status_banner_tick`
2. 新增 `firmware/components/ui_pages/ui_status_banner.c`，实现 §4.2 的构建、timer、三段 tick 渲染
3. 扩展 `firmware/components/ui_pages/Kconfig.projbuild`：
   - `P4HOME_UI_STATUS_BANNER_HEIGHT`：`int`，默认 `36`
   - `P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX`：`bool`，默认 `y`
4. `firmware/components/ui_pages/CMakeLists.txt`：`SRCS` 追加 `ui_status_banner.c`；`REQUIRES` 追加 `network_service time_service ha_client panel_data_store`
5. 在 `firmware/components/ui_pages/ui_page_dashboard.c`（plan 8 新建）中，构建根容器后调用 `ui_status_banner_init(root)`，并把卡片栅格 `y` 起点下移 `CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT`
6. `firmware/main/app_main.c` 新增 `VERIFY:ui:status_banner_ready` 标记，取值来自 dashboard init 透传
7. 更新 `firmware/components/ui_pages/README.md`：追加 `ui_status_banner` 一段说明与接入方式
8. 为 Wi‑Fi 三态准备 icon 文本映射常量（优先复用 `LV_SYMBOL_WIFI`，无对应符号时用字符串 `WiFi` / `...` / `x` 降级）

本地硬件侧（用户在开发机 / EVB 上完成）：

9. `idf.py menuconfig`：确认新增 Kconfig 项可见，默认值 `36` / `y` 合理
10. `idf.py build && flash && monitor`，观察首屏 banner 是否出现、三段内容是否按预期随网络/HA/时钟变化
11. 人工断开 AP、下线 HA、重启 SNTP，观察三个分区是否各自正确降级并自愈
12. 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ui-status-banner-v1.log` 作为 review 附件

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 保持；`idf.py build` 通过，无新增编译/链接错误
- `menuconfig` 中 `Component config → p4home ui_pages` 下新增两个 Kconfig 项可见
- 关闭 `CONFIG_P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX` 后重新构建仍通过
- `firmware/dependencies.lock` 不应被意外改动
- 目标 app 分区 `factory` 剩余体积不得比接入前再恶化 >0.5%（若超过，在 PR 描述中报备）

### 6.2 功能验证（模拟/占位路径）

- 上游全部缺席或未 ready：Wi‑Fi 图标显示 `disconnected`、IP 后缀空、HA pill 显示 `disconnected` 灰底、时间 `--:--`
- `network_service` 进入 `connecting` 阶段：Wi‑Fi 图标切为 `connecting`
- `network_service` `wifi_has_ip=true` 且 IP 为 `192.168.1.42`：IP 后缀显示 `.42`
- `ha_client_get_state()` 依次经历 `CONNECTING → AUTHENTICATING → READY`：pill 文本与底色正确切换，且不抖动
- `time_service_is_synced()` 为 `false` 时右侧固定显示 `--:--`；同步后切到 `HH:MM`
- 手动调用 `ui_status_banner_tick()` 应立刻反映当前真值

### 6.3 回归验证

- `VERIFY:network:* / time:* / ha:* / panel_store:*` 全部不回归
- `display / touch / audio / sr / gateway / settings` 相关 `VERIFY:` 不回归
- `ui_pages` 现有 Home / Settings / Gateway 三页不接入 banner，视觉与行为不变
- `app_main` 心跳抖动不超过 50ms（1 Hz banner timer 成本极小）

### 6.4 硬件/联调验证

- EVB 冷启动可见 dashboard 顶部有一条高度约 `36px` 的状态栏
- AP 切换与断连场景：Wi‑Fi 三态切换可视可听（日志同步），IP 后缀随 IP 变化
- HA 关停/重启：pill 文字与底色正确翻转；`error` 状态下使用红底，`ready` 绿底
- 断网 + HA 下线混合场景：banner 不闪烁、不崩溃，时间分区保持正确刷新
- 2 小时长跑：LVGL FPS 与心跳抖动无趋势性恶化；banner 每秒 1 次 timer，累计 CPU 占用 <0.1%
- 串口日志 `VERIFY:ui:status_banner_ready:PASS`

## 7. 风险

- **LVGL timer 成本 vs. 主 redraw**：1 Hz timer 虽轻，但每次 `lv_label_set_text` 都会触发局部 invalidate。若不做文本缓存对比，最差情况每秒 3 个分区各重绘一次；在低端抗锯齿+多卡片 dashboard 上可能让主 redraw 出现偶发掉帧。mitigation：在 `tick()` 里先比对缓存文本，只在变化时调 `lv_label_set_text`；底色改动亦同。
- **banner 占用垂直空间**：默认 `36px` 会让 dashboard 可用区域缩小，尤其在 4~5 行卡片布局下可能逼出滚动。plan 8 的栅格必须以 `CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT` 作为 `y` 起点；若未来想隐藏 banner，只能通过 Kconfig 默认不接入，不提供运行时隐藏开关以免 dashboard 布局抖动。
- **IPv6 / 非点分格式导致文本截取越界**：`network_service_ip_text()` 在 IPv6 启用或未获 IP 时可能返回 `::` / 空串 / `0.0.0.0`。IP 后缀必须以“找到最后一个 `.` 且右侧非空”为条件，否则直接清空；不做任何 `strtok`/`sprintf` 越界拷贝。
- **上游未初始化的首帧**：`ui_status_banner_init` 可能先于 `ha_client_init` / `time_service_init` 被 `ui_page_dashboard_init` 间接触发（启动乱序、或子系统构建失败时仅链接保留符号）。所有 getter 调用必须对未初始化场景容忍（返回 NULL/false/未同步），渲染分支按占位处理；禁止在 banner 内 `ESP_ERROR_CHECK` 这类上游结果。
- **`ha_client_state_text` 返回指针生命周期**：按 ICD 该指针应指向静态常量字符串；banner 不做 `strdup`，但需用 label 的 text copy 机制（`lv_label_set_text` 内部复制）避免悬垂。若后续扩展为动态字符串，需要转为 `strncpy` 至本地缓冲再 `lv_label_set_text`。
- **体积**：banner 不引入新依赖组件，只增加 ~1~2KB 代码 + 少量 LVGL 样式；但 `ui_pages` 的 `REQUIRES` 新增了 4 个组件，链接图扩展后可能额外带入少量去死码前的符号。`factory` 剩余约 2%，需在 PR 中附上 `idf.py size` 对比。
- **Kconfig `HEIGHT=0` 的退化**：若用户把 `P4HOME_UI_STATUS_BANNER_HEIGHT` 配为 0，banner 会不可见但仍占用 timer。建议在 `Kconfig.projbuild` 的 `range` 上限下限约束为 `24 ~ 64`，避免奇怪取值。
- **时间分区闪烁**：ISO8601 字符串在 SNTP 刚同步那一瞬可能快速变化；缓存对比能吸收，但需保证只在分钟跳变时写 label（即对比前 5 字节即可）。

## 8. 完成定义

- `ui_status_banner.h` / `.c` 新增到位，只导出 `ui_status_banner_init` / `ui_status_banner_tick` 两个符号
- `firmware/components/ui_pages/Kconfig.projbuild` 增加 `P4HOME_UI_STATUS_BANNER_HEIGHT`（默认 `36`）与 `P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX`（默认 `y`），`menuconfig` 可见
- `ui_page_dashboard_init` 内部接入 banner，卡片栅格正确下移
- EVB 冷启动可见顶部状态栏，三分区在正常家庭网络/HA/SNTP 环境下均显示真实内容
- 上游任一服务缺席或未 ready 时，banner 降级为占位渲染，不 panic、不 flood log
- `VERIFY:ui:status_banner_ready:PASS` 出现在启动日志
- 现有 `VERIFY:network:* / time:* / ha:* / panel_store:* / ui:dashboard_rendered` 全部不回归
- `firmware/components/ui_pages/README.md` 已更新，包含 banner 接入方式与 API 描述
- `idf.py size` 与接入前对比记录在 review 附件

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
