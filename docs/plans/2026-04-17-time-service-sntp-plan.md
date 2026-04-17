# time-service-sntp Plan

所属 Milestone: `M4`

## 1. 背景

根据 [project-milestones.md](../project-milestones.md) 的当前主线，`M4` 的目标是“把面板真正接入家庭网络 + 以只读方式接入 `Home Assistant WebSocket API`”。其中 `time_service`（`SNTP` 时间同步）是 `M4` 的第 2 号 plan，必须在 `plan 1 network-service-wifi-sta-connect` 拿到 Wi‑Fi + IP 之后、`plan 4 ha-client-websocket-bootstrap` 之前就位。

为什么 `ha_client` 必须拿到正确墙钟时间：

- HA WebSocket endpoint 多数情况下走 `wss://`（TLS），TLS 握手强依赖本地时钟在证书有效期内；芯片冷启动时钟在 `1970` 附近会直接握手失败
- 后续 `plan 5 ha-client-state-subscription` 的 `state_changed` 事件需要给每条 state 打本地时间戳，用于 `plan 6 panel_data_store` 的 `fresh / stale / unknown` 判定；若时钟未同步，`stale` 判定会整体错乱
- `plan 9 ui-connection-status-banner` 顶栏要显示 `HH:MM`，需要 `time_service_format_now_iso8601` 的稳定输出

当前仓库状态：

- `firmware/components/` 下没有 `time_service/` 组件
- `firmware/sdkconfig.defaults` 没有 `CONFIG_LWIP_SNTP_*` / `CONFIG_LWIP_DHCP_GET_NTP_SRV` 基线
- `firmware/main/app_main.c` 没有任何 `VERIFY:time:*` 标记
- `plan 1 network-service-wifi-sta-connect` 已经提供稳定的 `network_service_wait_connected(uint32_t timeout_ms)`，语义为：`ESP_OK` = 已拿到 IP，`ESP_ERR_TIMEOUT` = 超时未拿到 IP，`ESP_ERR_INVALID_STATE` = Wi‑Fi 未启动（例如 SSID 为空或 `CONFIG_P4HOME_WIFI_AUTOSTART=n`）；本 plan 直接消费该接口，不再自己订阅 `IP_EVENT_STA_GOT_IP`

## 2. 目标

- 新建 `firmware/components/time_service/` 组件，使用 `ESP-IDF v5.5.4` 内置的 `esp_sntp`（基于 `lwIP SNTP`）做时间同步
- 组件以**非阻塞**方式初始化：`time_service_init` 只做“注册 → 拉起后台任务”，立即返回，不阻塞 `board_support_init`
- 后台任务内串行等待：`network_service_wait_connected` 成功 → `esp_sntp_setservername` → `esp_sntp_init` → 等第一次同步完成
- 时区通过 `setenv("TZ", ...)` + `tzset()` 配置，默认 `CST-8`（中国标准时间）
- 对外暴露线程安全的查询接口：`is_synced` / `wait_synced` / `tz_text` / `format_now_iso8601` / `last_sync_epoch_ms`
- `board_support_init` 在 `network_service_init` 之后调用 `time_service_init`
- `app_main` 在打 `VERIFY:time:*` 标记前调用 `time_service_wait_synced(CONFIG_P4HOME_TIME_SYNC_WAIT_MS)`（默认 `5000ms`），对齐 plan 1 在 Wi‑Fi 上“先短等再打 VERIFY”的节奏
- 启动期 `VERIFY:` 基线新增 `time:sync_started` 与 `time:sync_acquired`
- 不回归 plan 1 任何已通过的 `VERIFY:network:*`

## 3. 范围

包含：

- 新建组件 `firmware/components/time_service/`，含 `time_service.c` / `include/time_service.h` / `Kconfig.projbuild` / `CMakeLists.txt` / `README.md`
- 基于 `esp_sntp.h`（`IDF v5.5.4` 提供，`components/lwip/include/apps/esp_sntp.h`）的 SNTP 客户端
- 单一后台 FreeRTOS 任务 `time_service_task`（2K~3K 栈，优先级 `tskIDLE_PRIORITY + 3`）负责：等 Wi‑Fi → 启动 SNTP → 等 sync → 退出（保活的周期性重同步交给 SNTP 自身 polling）
- 基于 `EventGroupHandle_t` 的 `TIME_SYNC_STARTED_BIT` / `TIME_SYNC_ACQUIRED_BIT`，支持 `time_service_wait_synced` 的 timeout 语义
- `sntp_set_time_sync_notification_cb` 回调内只做 bit 置位 + epoch 记录，禁止阻塞
- 三台 NTP 服务器，按顺序 `CONFIG_P4HOME_TIME_NTP_SERVER_0/1/2`，默认 `pool.ntp.org` / `ntp.ntsc.ac.cn` / `cn.pool.ntp.org`
- 时区通过 `setenv("TZ", CONFIG_P4HOME_TIME_TZ, 1)` + `tzset()` 设置，默认 `CST-8`
- 线程安全存取：使用 `portMUX_TYPE`（对齐 `network_service` / `gateway_service` 的做法）
- `board_support` 中透传 `time_service_*` 的只读 getter 与 `wait_synced` 包装
- `app_main` 追加 `VERIFY:time:sync_started:PASS|FAIL` 与 `VERIFY:time:sync_acquired:PASS|FAIL`
- `diagnostics_service` 的启动 summary 行追加 `time=<ISO8601> tz=<tz_text>`（已有 summary 打点框架，仅追加字段，不新增打点）

不包含：

- `Home Assistant` 客户端（归 `plan 4 ha-client-websocket-bootstrap`）
- TLS CA bundle / `esp_crt_bundle` 集成（归 `plan 4`；本 plan 只负责把时钟打准，为 TLS 扫清一个前置条件）
- UI 时钟卡片 / 顶栏时间渲染（归 `plan 9 ui-connection-status-banner`）
- 运行时配置 NTP server / TZ（MVP 期只用 `Kconfig`，未来再由 `settings_service` 扩展；不在本 plan）
- DHCP option 42 提供的 NTP server（`CONFIG_LWIP_DHCP_GET_NTP_SRV`）；本 plan 暂不启用，保持基线最小
- SNTP 统计信息 metrics 导出（`drift`、`round_trip_ms` 等；归 `plan 10 ha-client-reconnect-and-diagnostics` 的诊断扩展一起处理或单独立 plan）
- 夏令时规则 / 多时区切换 UI
- RTC 外设掉电保持（板上若有 backup domain 掉电保持请在后续 plan 补；本 plan 视作每次冷启动从 `1970` 起同步）

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/time_service/`（新建）
  - `time_service.c`：实现
  - `include/time_service.h`：对外 API
  - `Kconfig.projbuild`：声明 `P4HOME_TIME_NTP_SERVER_0/1/2` / `P4HOME_TIME_TZ` / `P4HOME_TIME_SYNC_WAIT_MS` / `P4HOME_TIME_AUTOSTART`
  - `CMakeLists.txt`：`idf_component_register(SRCS "time_service.c" INCLUDE_DIRS "include" REQUIRES lwip esp_event freertos PRIV_REQUIRES network_service log esp_timer)`
  - `README.md`：职责边界、Kconfig 说明、VERIFY 标记清单
- `firmware/components/board_support/`
  - `board_support.c`：`board_support_init` 链路里 `network_service_init` 之后追加 `time_service_init()`；`log_summary` 追加时间摘要一行
  - `include/board_support.h`：透传 `board_support_time_wait_synced(uint32_t timeout_ms)` / `board_support_time_is_synced(void)` / `board_support_time_format_now_iso8601(char*, size_t)`
  - `CMakeLists.txt`：`REQUIRES` 或 `PRIV_REQUIRES` 追加 `time_service`
- `firmware/main/app_main.c`
  - 在 `network_service_wait_connected(CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS)` 与 Wi‑Fi `VERIFY:` 打印**之后**，`VERIFY:time:*` 之前，插入：
    - `time_service_wait_synced(CONFIG_P4HOME_TIME_SYNC_WAIT_MS)`
    - `log_verify_marker("time", "sync_started", time_service_is_sync_started())`
    - `log_verify_marker("time", "sync_acquired", time_service_is_synced())`
- `firmware/sdkconfig.defaults`：
  - 默认保持 `IDF` 出厂的 `CONFIG_LWIP_SNTP_*` 基线；不在本 plan 显式硬编码 `CONFIG_LWIP_SNTP_UPDATE_DELAY`，避免无谓的基线漂移
  - 如 `idf.py menuconfig` 检查发现默认值与目标不一致（例如 `CONFIG_LWIP_SNTP_UPDATE_DELAY` 过短导致 UDP 流量抖动），再按 plan 1 的“只回迁差异”策略追加
- 不新建分区、不改 `firmware/partitions.csv`
- 不动 `firmware/dependencies.lock`（`esp_sntp` 是 IDF 内置，不需要 managed component）

### 4.2 模块拆解

`time_service` 内部（仍在同一 `.c`）分成四个小职责：

- **TZ 应用**：`time_service_init` 同步部分只做 `setenv("TZ", CONFIG_P4HOME_TIME_TZ, 1)` + `tzset()` + `memset(&s_state, 0, ...)` + 创建 `EventGroupHandle_t`；立即返回
- **后台任务 `time_service_task`**：
  1. 置位 `TIME_SYNC_STARTED_BIT` 之前先调用 `network_service_wait_connected(portMAX_DELAY / or a large ceiling)`；实际实现取 `CONFIG_P4HOME_TIME_WAIT_WIFI_MS`（默认 60000）循环重试，防止任务永远不返回
  2. 若 `network_service_wait_connected` 返回 `ESP_ERR_INVALID_STATE`（表示 Wi‑Fi 没起），任务进入 slow-retry（每 `30s` 再试一次），不主动退出；适配“面板在无 Wi‑Fi 凭证场景下继续运行”的路径
  3. 拿到 IP 后按顺序 `esp_sntp_setoperatingmode(SNTP_OPMODE_POLL)` / `esp_sntp_setservername(0,...)` / `esp_sntp_setservername(1,...)` / `esp_sntp_setservername(2,...)` / `esp_sntp_set_time_sync_notification_cb(sync_cb)` / `esp_sntp_init()`
  4. 置位 `TIME_SYNC_STARTED_BIT`，记录 `sync_started=true`
  5. 等 `TIME_SYNC_ACQUIRED_BIT` 最多 `CONFIG_P4HOME_TIME_FIRST_SYNC_MAX_MS`（默认 `30000ms`）；拿到即退出任务，`esp_sntp` 内部 polling 继续维持重同步
  6. 若首次同步超时，不 panic；打 `ESP_LOGW` 并进入 slow-retry（每 `30s` 检查一次 `sntp_get_sync_status`），直到拿到同步后退出任务
- **同步回调 `time_service_sync_notification_cb(struct timeval *tv)`**：`portENTER_CRITICAL` 记录 `last_sync_epoch_ms`、置 `synced=true`、`xEventGroupSetBits(TIME_SYNC_ACQUIRED_BIT)`；不打印、不阻塞
- **格式化工具 `time_service_format_now_iso8601`**：`time(&now)` + `localtime_r` + `strftime("%FT%T%z", ...)`，用栈局部变量，不动全局锁；调用方确保 `buf_size >= 32`

### 4.3 数据流 / 控制流

启动链路：

1. `app_main`
   → `board_support_init`
   → `settings_service_init`
   → `network_service_init`（内部 autostart Wi‑Fi，不阻塞）
   → **`time_service_init`（本 plan 新增；只做 TZ + event group + 拉任务，不阻塞）**
   → 其它子系统 init
2. 后台 `time_service_task` 运行时序：
   - `network_service_wait_connected(CONFIG_P4HOME_TIME_WAIT_WIFI_MS)` 成功
   - `esp_sntp_*` 一次性启动；置 `sync_started=true` + `TIME_SYNC_STARTED_BIT`
   - 回调被触发 → `synced=true` + `last_sync_epoch_ms=<ms>` + `TIME_SYNC_ACQUIRED_BIT`
   - 任务退出
3. `app_main` 回到主线，在调用 `board_support_log_summary()` 之后、打 `VERIFY:time:*` 之前：
   - `time_service_wait_synced(CONFIG_P4HOME_TIME_SYNC_WAIT_MS)`（默认 `5000ms`）
   - `log_verify_marker("time", "sync_started", time_service_is_sync_started())`
   - `log_verify_marker("time", "sync_acquired", time_service_is_synced())`
   - 超时不 panic，允许 `VERIFY:time:sync_acquired:FAIL` 真实暴露问题
4. 并发与锁：
   - `s_state` 用 `portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;` 保护（对齐 `network_service`）
   - `time_service_wait_synced` 使用 `xEventGroupWaitBits(TIME_SYNC_ACQUIRED_BIT, pdFALSE, pdTRUE, ticks)`，返回 `ESP_OK` / `ESP_ERR_TIMEOUT`；当 `event_group == NULL`（`time_service_init` 未调用）返回 `ESP_ERR_INVALID_STATE`
   - `time_service_format_now_iso8601` 为纯函数式调用，不碰 `s_state_lock`（除了读一次 `s_state.synced` 决定是否打 `"unsynced"` 前缀）

### 4.4 对外 API 契约（与 plan wave ICD 对齐，不增删符号）

`firmware/components/time_service/include/time_service.h` 必须且仅导出：

- `esp_err_t time_service_init(void);`：启动 SNTP 链路（非阻塞）；重入幂等，二次调用返回 `ESP_OK` 且不重新拉任务
- `bool time_service_is_synced(void);`：读最近一次同步是否成功
- `esp_err_t time_service_wait_synced(uint32_t timeout_ms);`：阻塞等 `TIME_SYNC_ACQUIRED_BIT`，超时 `ESP_ERR_TIMEOUT`，未初始化 `ESP_ERR_INVALID_STATE`，成功 `ESP_OK`
- `const char *time_service_tz_text(void);`：返回当前生效的 TZ 字符串（来自 `CONFIG_P4HOME_TIME_TZ`，如 `"CST-8"`），永不为 `NULL`
- `void time_service_format_now_iso8601(char *buf, size_t size);`：按本地时区格式化 `"YYYY-MM-DDTHH:MM:SS+HHMM"`；若未同步，写 `"1970-01-01T00:00:00+0000"` 或 `"unsynced"`（本 plan 选 `"unsynced"`，便于日志/UI 直观辨识；`size < 16` 时写空串）
- `int64_t time_service_last_sync_epoch_ms(void);`：最近一次同步回调触发时的 UTC epoch ms；未同步返回 `0`

内部辅助（不进头文件，仅 `static`）：

- `static bool time_service_is_sync_started(void);`：仅供 `app_main` 打 VERIFY 用；通过 `time_service_wait_synced(0)` + `last_sync_epoch_ms` 结合判定过于绕；建议在头文件内追加 **一个** getter？**按 ICD 约束不扩展符号**——改用内部静态函数由 `time_service_wait_synced(0)` 在 `board_support` 里组合出 `sync_started` 语义；但为避免语义错位，**本 plan 决定：`VERIFY:time:sync_started` 的判定 = `time_service_wait_synced(0) != ESP_ERR_INVALID_STATE`**（即只要 `time_service_init` 被调过即认为已启动 SNTP 链路）；若后续 review 认为该语义过弱，再由主 agent 裁决是否扩 ICD

### 4.5 Kconfig 与启动顺序

`firmware/components/time_service/Kconfig.projbuild`：

- `P4HOME_TIME_AUTOSTART`：`bool`，默认 `y`；`n` 时 `time_service_init` 只做 TZ + event group，不拉后台任务，不启 SNTP
- `P4HOME_TIME_NTP_SERVER_0`：`string`，默认 `"pool.ntp.org"`
- `P4HOME_TIME_NTP_SERVER_1`：`string`，默认 `"ntp.ntsc.ac.cn"`
- `P4HOME_TIME_NTP_SERVER_2`：`string`，默认 `"cn.pool.ntp.org"`
- `P4HOME_TIME_TZ`：`string`，默认 `"CST-8"`
- `P4HOME_TIME_SYNC_WAIT_MS`：`int`，默认 `5000`，`app_main` 打 VERIFY 前的短等；`0` 表示不等
- `P4HOME_TIME_WAIT_WIFI_MS`：`int`，默认 `60000`，后台任务单轮等 Wi‑Fi 的超时
- `P4HOME_TIME_FIRST_SYNC_MAX_MS`：`int`，默认 `30000`，首次 SNTP 同步等待上限

启动顺序硬约束：

- `settings_service_init` → `network_service_init` → `time_service_init`；与 `plan wave ICD` 第 `plan 2` 条吻合
- `time_service_init` **绝不**在同步尚未完成时回阻塞 `app_main`；阻塞行为只发生在 `app_main` 显式调用的 `time_service_wait_synced(...)`

## 5. 实现任务

代码侧（agent 可完成）：

1. 新建目录 `firmware/components/time_service/` 与其下 `include/` 子目录
2. 新建 `firmware/components/time_service/CMakeLists.txt`，`REQUIRES` 列 `lwip` / `esp_event` / `freertos`，`PRIV_REQUIRES` 列 `network_service` / `log` / `esp_timer`
3. 新建 `firmware/components/time_service/Kconfig.projbuild`，声明 §4.5 所列全部键
4. 新建 `firmware/components/time_service/include/time_service.h`，按 §4.4 仅导出 6 个符号
5. 新建 `firmware/components/time_service/time_service.c`：
   - 定义 `time_service_state_t`（含 `initialized` / `autostart` / `sync_started` / `synced` / `last_sync_epoch_ms` / `event_group` / `task_handle`）
   - 定义 `portMUX_TYPE s_state_lock`
   - 实现 `time_service_init`（TZ + event group + `xTaskCreate("p4home_time_svc", ...)`）
   - 实现 `time_service_task`：`network_service_wait_connected(CONFIG_P4HOME_TIME_WAIT_WIFI_MS)` + slow-retry + `esp_sntp_*` 启动 + 置 `TIME_SYNC_STARTED_BIT`
   - 实现 `time_service_sync_notification_cb`（见 §4.2）
   - 实现 `time_service_is_synced` / `time_service_wait_synced` / `time_service_tz_text` / `time_service_format_now_iso8601` / `time_service_last_sync_epoch_ms`
6. 新建 `firmware/components/time_service/README.md`，说明职责、依赖、`VERIFY:time:sync_started|sync_acquired`、Kconfig 清单
7. 修改 `firmware/components/board_support/board_support.c`：
   - 在 `network_service_init` 成功之后调用 `time_service_init()`；失败仅 `ESP_LOGW`，不阻塞后续子系统
   - `board_support_log_summary` 追加一行：`time=<time_service_format_now_iso8601> tz=<time_service_tz_text> synced=<yes|no>`
8. 修改 `firmware/components/board_support/include/board_support.h`，追加 `board_support_time_wait_synced` / `board_support_time_is_synced` / `board_support_time_format_now_iso8601` 透传包装（仅包装，不新增 `time_service` 符号）
9. 修改 `firmware/components/board_support/CMakeLists.txt`，`REQUIRES`（或 `PRIV_REQUIRES`）追加 `time_service`
10. 修改 `firmware/main/app_main.c`：
    - 在 `network_service_wait_connected(...)` 之后、`VERIFY:network:ip_acquired` 之后插入一段：
      - `time_service_wait_synced(CONFIG_P4HOME_TIME_SYNC_WAIT_MS)` 或 `board_support_time_wait_synced(...)`
      - `log_verify_marker("time", "sync_started", <...>)`
      - `log_verify_marker("time", "sync_acquired", time_service_is_synced())`
    - 现有其它 `VERIFY:` 保持原位
11. `diagnostics_service` 若已有 startup summary 收敛点，在其一行 log 里追加时间字段；若无合适 hook，跳过，只靠 `board_support_log_summary` 出时间摘要

本地硬件侧（用户在配好 `ESP-IDF v5.5.4` 的开发机上完成，agent 给出命令）：

12. `idf.py reconfigure`：确认新组件被发现、`Kconfig.projbuild` 项出现在 `menuconfig → Component config → P4Home → Time Service` 菜单下
13. `idf.py build`：首次构建通过，无新增编译/链接错误；观察 `factory` 分区剩余空间，按 plan wave ICD 的固件体积纪律记录一次增量
14. `idf.py flash monitor`：
    - 无 Wi‑Fi 凭证场景：确认 `time_service_task` 进入 slow-retry 不 panic
    - 有 Wi‑Fi 凭证场景：确认 30s 内看到 SNTP 同步日志 + `VERIFY:time:sync_acquired:PASS`
15. 人工把路由断一次，观察 `time_service` 是否被 `esp_sntp` 自行重试维持；不需要改代码
16. 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-time-sntp-v1.log` 作为 review 附件

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 保持；`idf.py build` 通过
- `idf.py reconfigure` 后 `menuconfig` 能看到新增 5 个 `P4HOME_TIME_*` 字符串/整型键位
- `time_service` 组件产生的 `.o` 大小应在 `<16KB` 数量级；否则触发 plan wave ICD 里的“固件体积 2% 预警”
- `firmware/dependencies.lock` 不应被本 plan 改动（纯 IDF 内置）

### 6.2 功能验证

- **空凭证路径**（不配 `CONFIG_P4HOME_WIFI_SSID`）：
  - `time_service_init` 返回 `ESP_OK`
  - `time_service_wait_synced(CONFIG_P4HOME_TIME_SYNC_WAIT_MS)` 返回 `ESP_ERR_TIMEOUT`
  - `VERIFY:time:sync_started:PASS`（SNTP 链路已拉起，但等 Wi‑Fi）与 `VERIFY:time:sync_acquired:FAIL` 如实出现
  - `app_main` 心跳继续
- **有凭证 + 公网可达路径**：
  - 冷启动 `30s` 内 `VERIFY:time:sync_acquired:PASS`
  - `time_service_last_sync_epoch_ms` 返回合理 UTC 毫秒（大于 `1735689600000`，对应 `2025-01-01`）
  - `time_service_format_now_iso8601` 返回 `"20xx-xx-xxTHH:MM:SS+0800"` 形式
- **DNS 不可达 / NTP 端口被墙**：
  - `time_service_wait_synced` 超时；日志 `VERIFY:time:sync_started:PASS` + `VERIFY:time:sync_acquired:FAIL`
  - 任务进入 slow-retry；不 panic

### 6.3 回归验证

- plan 1 的 `VERIFY:network:stack|event_loop|sta_netif|wifi_started|wifi_connected|ip_acquired` 全部**不回归**
- `settings / gateway / display / touch / audio / sr` 的现有 `VERIFY:` 不受影响
- `app_main` 心跳抖动：本 plan 在 `VERIFY:time:*` 前最多额外等待 `CONFIG_P4HOME_TIME_SYNC_WAIT_MS`（默认 `5000ms`）；与 plan 1 的 `CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS`（默认 `3000ms`）串行，累积启动阻塞最坏约 `8s`；心跳首跳允许延迟不超过 `8.5s`
- `factory` 分区剩余空间：相比 plan 1 后的基线，`SNTP` 本身几乎不带新代码（IDF 内置），`time_service.c` 预计 `<8KB text`；若 `factory` 分区剩余降至 `<1.5%`，需在 review 附件中标注

### 6.4 硬件/联调验证

- 烧录后串口里应看到：
  - `I (xxxx) time_service: sntp started servers=pool.ntp.org,ntp.ntsc.ac.cn,cn.pool.ntp.org tz=CST-8`
  - `I (xxxx) time_service: sync acquired epoch_ms=<ms> iso8601=<...>`
  - `VERIFY:time:sync_started:PASS`
  - `VERIFY:time:sync_acquired:PASS`
- 把时区临时改为 `"UTC0"` + 重新烧录，确认 `time_service_format_now_iso8601` 输出 `"+0000"` 尾
- 2 小时长跑：观察 `esp_sntp` 周期性重同步不引起心跳抖动，`time_service_last_sync_epoch_ms` 随时间前进，未出现回退

## 7. 风险

- `esp_sntp_*` 系列在 `ESP-IDF v5.5.x` 中已统一前缀（旧版本为 `sntp_*`）；若切回旧版本会遇到符号不存在。本 plan 锁定 `v5.5.4`，但实现代码必须只用带 `esp_` 前缀的接口，避免 `deprecated` 警告
- `setenv("TZ", ...)` + `tzset()` 在 `newlib` 下对已 `localtime_r` 的缓存有一次性更新；若后续运行时允许改 TZ，需要再次 `tzset()`，本 plan 未提供该接口，属于有意限制
- 回调 `time_service_sync_notification_cb` 的调用上下文是 `lwIP tcpip` 任务，栈空间有限；回调体必须只做置位与 epoch 记录，严禁 `ESP_LOGI`（会拉长回调耗时）；改为“回调置 bit，`time_service_task` 被唤醒后再打一条 `ESP_LOGI`”
- `CONFIG_P4HOME_TIME_SYNC_WAIT_MS=5000` 对国内公网可能略紧；若 CI/实机环境首次同步稳定 >5s，再把默认改到 `8000`，不在本 plan 硬锁
- 与 plan 1 的 `CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS` 叠加后，`app_main` 启动阻塞合计约 `8s`；后续 plan 4 还会再叠 `ha_client_wait_ready`，需要统一考虑启动可观测性，本 plan 不动 plan 1 的默认值
- 固件体积敏感：`factory` 分区当前剩约 `2%`（plan wave ICD 强调），`time_service` 自身增量小（<10KB），但打开 `CONFIG_LWIP_SNTP_*` 若引入新代码路径需观察；本 plan 不主动打开额外 `LWIP_SNTP_*` 选项
- TLS 依赖：本 plan 把钟打准是 `plan 4 ha-client-websocket-bootstrap` 做 TLS 握手的前置；若首次同步失败，`plan 4` 的 `ha_client_start` 会卡在握手。plan 4 已在 ICD 中规定 `ha_client_start` 需要 `time_service_wait_synced` 通过才继续，这一契约在本 plan 不改动，仅在 README 记录依赖方向
- `NVS` 依赖：`esp_wifi` 需要 NVS，`esp_sntp` 本身不需要；本 plan 不主动动 NVS 命名空间，避免与 plan 3 的 `p4home_ha` namespace 打架
- `time_service_task` 栈大小：建议 `3072` 字节；若发现栈溢出，优先把 `ESP_LOGI` 改短而不是线性拉大

## 8. 完成定义

- `firmware/components/time_service/` 存在，构建通过，`menuconfig` 能看到 `P4HOME_TIME_*` 键位
- `time_service.h` 精确导出 ICD 指定的 6 个符号，无多余也无缺失
- `board_support_init` 在 `network_service_init` 之后调用 `time_service_init`，`board_support.h` 透传三个包装
- `app_main` 的启动 `VERIFY:` 里出现 `time:sync_started` 与 `time:sync_acquired` 两项
- 有真实 AP + 公网可达时，冷启动 `30s` 内完成 SNTP 首次同步，`time_service_format_now_iso8601` 输出本地时间
- 无 Wi‑Fi 凭证时，面板仍稳定进入心跳循环，`time_service` 不 panic，`VERIFY:time:sync_acquired:FAIL` 如实出现
- 现有 `VERIFY:` 全部不回归；`factory` 分区剩余不低于 `1.5%`
- `time_service/README.md` 描述职责与 `Kconfig` / `VERIFY` 清单

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

- `firmware/components/time_service/time_service.c`
- `firmware/components/time_service/include/time_service.h`
- `firmware/components/time_service/Kconfig.projbuild`
- `firmware/components/time_service/CMakeLists.txt`
- `firmware/components/time_service/README.md`
- `firmware/components/board_support/board_support.c`
- `firmware/components/board_support/include/board_support.h`
- `firmware/components/board_support/CMakeLists.txt`
- `firmware/main/app_main.c`
- `firmware/sdkconfig.defaults`（如确实需要回迁差异键位）
