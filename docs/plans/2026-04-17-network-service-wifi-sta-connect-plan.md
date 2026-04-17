# network-service-wifi-sta-connect Plan

所属 Milestone: `M4`

## 1. 背景

根据 [project-milestones.md](../project-milestones.md) 的最新调整，项目主线已切换为“连接 `Home Assistant` 图形化展示传感器数据”。该主线依赖一条真正可用的家庭 Wi‑Fi 链路。

当前 `firmware/components/network_service/` 只完成：

- `esp_netif` 初始化
- 默认事件循环初始化
- Wi‑Fi STA 形态的 `esp_netif` 创建
- `hostname` / `device_id` / `mac_text` 生成
- `VERIFY:network:stack|event_loop|sta_netif` 自检

它**没有真正联网**：没有 `esp_wifi_init` / `esp_wifi_start` / `esp_wifi_connect`、没有事件订阅、没有 IP 获取状态。

另外，`ESP32-P4` 本身**不带 Wi‑Fi 射频**，当前这块 `ESP32-P4 Function EV Board` 的 Wi‑Fi 由板载 `ESP32-C6` 协处理器经 `ESP-Hosted` 提供，固件侧通过 `espressif/esp_wifi_remote` 管理组件把标准 `esp_wifi_*` API 路由到远端 C6 slave。当前仓库：

- `firmware/dependencies.lock` 未声明 `espressif/esp_wifi_remote` 或 `espressif/esp_hosted`
- `firmware/sdkconfig.defaults` 没有 `CONFIG_ESP_WIFI_REMOTE_*` 或 `CONFIG_ESP_HOSTED_*` 基线
- 因此 P4 本地固件 **缺少到 C6 的 transport 配置**，是本 plan 的前置硬阻塞

本 plan 是 `M4` 的第 1 号 plan，目标是把 Wi‑Fi STA 经 ESP-Hosted + C6 真正拉起来，供 `time_service`、`ha_client` 等上层依赖。

## 2. 目标

- 引入并启用 `espressif/esp_wifi_remote` 管理组件，打通 `ESP32-P4 → ESP-Hosted → ESP32-C6 slave` 的 Wi‑Fi 通路
- 让 `network_service` 具备“拨号 → 获得 IP → 维持连接 → 断线重连”的最小可用 Wi‑Fi STA 链路
- 对外提供稳定、线程安全的连接状态查询与等待接口
- 扩展启动期 `VERIFY:network:*` 基线，覆盖真正的 Wi‑Fi 连接与 IP 事件；`app_main` 在记录 `VERIFY` 前短等一段可配置时间，避免“启动瞬间一定 FAIL”
- 保留现有 `hostname` / `device_id` / `sta_netif` 语义，不回归既有 `M0`~`M3` 交付

## 3. 范围

包含：

- 新增 `espressif/esp_wifi_remote` 作为 managed component，并让其拉取 `espressif/esp_hosted`
- ESP‑Hosted transport 基线：`sdkconfig.defaults` 开启 SDIO transport、对齐 `ESP32-P4 Function EV Board` 的默认引脚/时钟
- `network_service` 中新增 Wi‑Fi 初始化、启动、连接、事件处理
- 订阅 `WIFI_EVENT_*` / `IP_EVENT_STA_GOT_IP` 并维护连接状态机
- 指数退避重连
- 凭证来源：`Kconfig.projbuild` 注入 `WIFI_SSID` / `WIFI_PASSWORD` / `WIFI_MAX_RETRY` / `WIFI_AUTOSTART`
- 向外暴露：
  - `network_service_wifi_connected()`
  - `network_service_wifi_has_ip()`
  - `network_service_ip_text()`
  - `network_service_wait_connected(timeout_ms)`
- 扩展 `network_service_snapshot_t` 字段
- `board_support` 与 `app_main` 的启动日志与 `VERIFY:` 标记扩展
- `app_main` 在记录 Wi‑Fi 相关 `VERIFY:` 前调用 `wait_connected(CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS)`，默认 `3000ms`

不包含：

- 对 `ESP32-C6` slave firmware 的定制开发（本 plan 假设使用官方 `esp_hosted` 发布版的 slave，直接烧录即可）
- SoftAP / BLE / 蓝牙配网
- Web / H5 配网页面
- Wi‑Fi 凭证的 NVS 存储与运行时修改（归后续 `settings-service-ha-credentials` plan）
- `SNTP` 时间同步（归后续 `time-service-sntp` plan）
- 任何 HA / WebSocket / TLS 相关实现（归后续 `ha-client-*` plan）
- UI 侧的 Wi‑Fi 状态指示（归 `M5` 的 `ui-connection-status-banner` plan）
- 多 AP 漫游、5G/2.4G 选择策略

## 4. 设计方案

### 4.1 目录影响

- `firmware/components/network_service/`
  - `network_service.c`：扩展实现
  - `include/network_service.h`：追加 API 与 snapshot 字段
  - `Kconfig.projbuild`：**新增**，声明 `P4HOME_WIFI_SSID` / `P4HOME_WIFI_PASSWORD` / `P4HOME_WIFI_MAX_RETRY` / `P4HOME_WIFI_AUTOSTART` / `P4HOME_WIFI_VERIFY_WAIT_MS`
  - `CMakeLists.txt`：`REQUIRES` 追加 `esp_wifi`、`nvs_flash`、`esp_wifi_remote`
  - `idf_component.yml`：**新增**，声明 `espressif/esp_wifi_remote` 依赖（由其内部传递依赖 `espressif/esp_hosted`）
  - `README.md`：更新职责边界，明确 ESP-Hosted + C6 transport
- `firmware/sdkconfig.defaults`：追加 ESP-Hosted / esp_wifi_remote transport 基线（SDIO + ESP32-C6 function ev board 默认引脚）
- `firmware/components/board_support/`
  - `board_support.c` / `include/board_support.h`：透传新增连接状态查询 API
- `firmware/main/app_main.c`：启动摘要增加 Wi‑Fi 连接状态 + 新 `VERIFY:` 标记，并在 `VERIFY` 前调用短等
- `firmware/dependencies.lock`：由 `idf.py reconfigure` 自动更新，入库
- 不新建组件，不新建分区

### 4.2 模块拆解

`network_service` 内部分成四个小职责（仍在同一 `.c`）：

- **ESP-Hosted transport 接入**：依赖 `esp_wifi_remote`，对 P4 侧无需额外显式初始化——它会在 `esp_wifi_init` 路径里把调用路由到 C6 slave。本 plan 只需保证：
  - `esp_wifi_remote` 出现在 managed components
  - `sdkconfig` 选择正确的 transport（SDIO）与引脚预设
  - NVS 已 ready（`settings_service_init` 里已做 `nvs_flash_init`，顺序必须在 `network_service_init` 之前，当前已满足）
- **Wi‑Fi 子栈初始化**：`esp_wifi_init`、`esp_wifi_set_storage(RAM)`、`esp_wifi_set_mode(STA)`、`esp_wifi_set_config(...)`（调用对象是 `esp_wifi_remote`，语义与原生一致）
- **事件路由**：`esp_event_handler_instance_register` 注册 `WIFI_EVENT_ANY_ID` 与 `IP_EVENT_STA_GOT_IP`，dispatch 到内部状态机
- **连接状态机**：`IDLE → STARTING → CONNECTING → CONNECTED → GOT_IP`，以及 `DISCONNECTED → RETRY_BACKOFF` 回路
- **对外 API**：`is_ready` / `wifi_started` / `wifi_connected` / `wifi_has_ip` / `ip_text` / `wait_connected` / `get_snapshot` / `log_summary`

状态存储用 `portMUX_TYPE` 保护（对齐 `gateway_service` 的做法），`wait_connected` 采用 `EventGroupHandle_t` 等待 `CONNECTED_BIT | GOT_IP_BIT | FAIL_BIT`。

### 4.3 数据流 / 控制流

启动链路不改现有顺序：

1. `board_support_init` 依次 `settings_service_init → network_service_init`
2. `network_service_init` 完成现有的 `esp_netif` / 事件循环 / STA netif / identity
3. `network_service_init` 末尾**新增** `network_service_wifi_start()`：
   - 若 `CONFIG_P4HOME_WIFI_AUTOSTART=n` 或 `CONFIG_P4HOME_WIFI_SSID` 为空 → 记录 `wifi_started=false`，直接返回，保留离线可运行路径
   - 否则进入状态机，`esp_wifi_init` → `esp_wifi_set_mode(STA)` → `esp_wifi_set_config` → `esp_wifi_start`，由事件回调驱动 `esp_wifi_connect`
4. 事件回调（运行在 `esp_event` 任务上，保持轻量，只做状态更新与事件组置位）：
   - `WIFI_EVENT_STA_START` → `esp_wifi_connect`
   - `WIFI_EVENT_STA_CONNECTED` → 置位 `connected`
   - `IP_EVENT_STA_GOT_IP` → 记录 IP 字符串，置位 `CONNECTED_BIT | GOT_IP_BIT`
   - `WIFI_EVENT_STA_DISCONNECTED` → 清 `connected/has_ip`，按指数退避重试（1s, 2s, 4s, 8s, 上限 30s），达到 `CONFIG_P4HOME_WIFI_MAX_RETRY` 后置位 `FAIL_BIT` 但仍持续低频重试（60s 节拍）
5. 阻塞/非阻塞原则：
   - `network_service_init` 内的 `esp_wifi_init` 允许短时阻塞等待 ESP-Hosted 与 C6 slave 的 SDIO handshake（通常几百 ms 至 1~2s，取决于 `esp_wifi_remote` 实现）
   - 但 `network_service_init` **不**等待 Wi‑Fi 连接或 IP 获取
   - Wi‑Fi 连接在后台由事件机驱动
6. `app_main` 启动摘要前：
   - 在 `board_support_log_summary()` 之后、`log_verify_marker("network", "wifi_connected", ...)` 之前，调用 `network_service_wait_connected(CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS)`（默认 `3000ms`）
   - 超时不 panic，允许继续走其它子系统 VERIFY；但本项会被记录为 `FAIL`，便于串口/CI 检测
   - 该短等只影响 Wi‑Fi 相关 `VERIFY` 的观察时机，不阻塞运行时 `while(true)` 心跳

### 4.4 状态/字段扩展

`network_service_snapshot_t` 追加字段：

- `wifi_started`
- `wifi_connected`
- `wifi_has_ip`
- `ip_text`
- `last_disconnect_reason`
- `retry_count`

`VERIFY:` 启动基线追加（在 `wait_connected(3s)` 之后打印）：

- `VERIFY:network:wifi_started:PASS|FAIL`
- `VERIFY:network:wifi_connected:PASS|FAIL`
- `VERIFY:network:ip_acquired:PASS|FAIL`

启动摘要行同步追加 Wi‑Fi 相关字段。`log_summary` 中也追加 Wi‑Fi 状态。

### 4.5 Kconfig 与 sdkconfig

新增 `firmware/components/network_service/Kconfig.projbuild`：

- `P4HOME_WIFI_SSID`：`string`，默认空
- `P4HOME_WIFI_PASSWORD`：`string`，默认空
- `P4HOME_WIFI_MAX_RETRY`：`int`，默认 `10`
- `P4HOME_WIFI_AUTOSTART`：`bool`，默认 `y`
- `P4HOME_WIFI_VERIFY_WAIT_MS`：`int`，默认 `3000`，`0` 表示不等

`firmware/sdkconfig.defaults` 的改动策略：

- 本 plan 的代码实现阶段**不直接改 `sdkconfig.defaults`**
- 因为 `esp_wifi_remote` 自身会通过 Kconfig 在组件进入依赖链时默认启用合适的 ESP-Hosted transport（对 `ESP32-P4 Function EV Board` 而言默认就是 SDIO），无需前置硬编码
- 第一次 `idf.py reconfigure` 成功后，跑一次 `idf.py menuconfig`，只把**与出厂默认不同**的 ESP-Hosted / esp_wifi_remote 键位移进 `sdkconfig.defaults`，保持基线最小化
- 不改动 `CONFIG_SPIRAM_*`、分区、日志等现有基线

## 5. 实现任务

代码侧（agent 可完成）：

1. 新增 `firmware/components/network_service/idf_component.yml`，**先**用宽松约束 `espressif/esp_wifi_remote: "*"`，不显式声明 `esp_hosted`
2. `network_service/CMakeLists.txt` 追加 `REQUIRES esp_wifi nvs_flash esp_wifi_remote`
3. 在 `network_service/` 下新增 `Kconfig.projbuild`，声明 `P4HOME_WIFI_SSID` / `_PASSWORD` / `_MAX_RETRY` / `_AUTOSTART` / `_VERIFY_WAIT_MS`
4. 扩展 `network_service.c`：
   - 新增内部状态字段（`wifi_started` / `wifi_connected` / `wifi_has_ip` / `ip_text` / `retry_count` / `last_disconnect_reason`）
   - 新增 `EventGroupHandle_t`、`TimerHandle_t`（重连定时器）与访问锁
   - 新增 `network_service_wifi_event_handler` / `network_service_ip_event_handler`
   - 新增 `network_service_wifi_start_internal`，在 `network_service_init` 末尾按 `P4HOME_WIFI_AUTOSTART` 决策是否调用
   - 实现指数退避重连与 slow-retry fallback
   - 实现 `network_service_wifi_started` / `_wifi_connected` / `_wifi_has_ip` / `_ip_text` / `_last_disconnect_reason` / `_wifi_retry_count` / `_wait_connected`
   - 扩展 `network_service_get_snapshot` 与 `network_service_log_summary`
5. 扩展 `network_service.h` 与 `network_service_snapshot_t`
6. 在 `board_support` 中透传新的 Wi‑Fi 状态 getter 与 `wait_connected` 包装
7. 在 `app_main.c` 启动摘要与 `log_verify_marker` 前，插入 `board_support_wifi_wait_connected(CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS)`，并追加 Wi‑Fi 相关 `VERIFY:` 项
8. 更新 `firmware/components/network_service/README.md`，说明 ESP-Hosted + C6 路线

本地硬件侧（用户在配好 IDF 的开发机上完成，agent 给出命令）：

9. `idf.py reconfigure` 首次解析，查看 `dependencies.lock` 解出的 `esp_wifi_remote` 与 `esp_hosted` 版本，记录在 review 区
10. `idf.py menuconfig` 交叉检查 ESP-Hosted transport 是否自动选到 SDIO + C6，只把与默认**不同**的键位回迁到 `sdkconfig.defaults`
11. 本地构建：`idf.py build`；空凭证路径与有凭证路径两次各烧录一次，收集串口日志作为 review 附件
12. 实机联调通过后，把 §5.1 的宽松约束回填为 `dependencies.lock` 里的精确版本

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 保持；`idf.py build` 通过，无新增编译/链接错误
- `idf.py reconfigure` 后 `dependencies.lock` 出现 `espressif/esp_wifi_remote` 和 `espressif/esp_hosted`
- 打开 `menuconfig`，确认新增 Kconfig 项可见、默认值合理；确认 ESP-Hosted transport 方向与 SDIO 选项一致
- 空 `SSID` 情况下构建成功（MVP 期默认场景）

### 6.2 功能验证（空凭证路径）

- 不配置 SSID 时，启动日志：
  - `wifi_started=no`、`wifi_connected=no`、`wifi_has_ip=no`
  - `VERIFY:network:wifi_started:FAIL`
  - 其他现有 `VERIFY:` 不回归
  - 面板仍可进入 `app_main` 心跳循环

### 6.3 回归验证

- `VERIFY:network:stack/event_loop/sta_netif` 仍为 `PASS`
- `settings / gateway / display / touch / audio / sr` 的 `VERIFY:` 结果与旧基线一致
- `boot` 阶段不出现 `ESP_ERROR_CHECK` 失败或 panic
- `app_main` 心跳与 `gateway` 定时发布路径不变；增加的 3s 等待不应使心跳抖动超过 300ms

### 6.4 硬件/联调验证

- 确认 `ESP32-C6` 已烧录匹配版本的 `esp_hosted` slave firmware（若为首次，按 `esp_hosted` 官方步骤烧录一次）
- `idf.py monitor` 冷启动后观察：
  - ESP-Hosted transport 初始化日志（SDIO link up / slave handshake）
  - `WIFI_EVENT_STA_START` / `IP_EVENT_STA_GOT_IP` 对应的 `ip=xxx.xxx.xxx.xxx`
  - `VERIFY:network:wifi_started:PASS`
  - `VERIFY:network:wifi_connected:PASS`
  - `VERIFY:network:ip_acquired:PASS`
- 人工关闭 AP 再恢复，观察指数退避与自愈（至少一次重连成功）
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-wifi-sta-v1.log` 作为 review 附件

## 7. 风险

- `ESP32-C6` slave firmware 与 `esp_wifi_remote` 版本必须严格匹配；版本漂移会导致 handshake 失败或 `esp_wifi_init` 返回超时错误。应通过 `dependencies.lock` 固化版本，并在 README 记录 slave 烧录方式
- SDIO transport 引脚与 `ESP32-P4 EV Board` 其它外设（SD 卡、LCD 背光等）可能冲突；需核对原理图与现有 `bsp` 定义，必要时通过 Kconfig 明确 pin override
- `esp_wifi_remote` 会显著增加固件体积；当前 `factory` 分区仅剩约 `2%`，实现阶段需同时关注 `firmware-size-reduction` plan 的结论，必要时在本 plan 中追加精简项
- `esp_wifi_init` 内部依赖 NVS；必须确保 `settings_service_init` 已完成 `nvs_flash_init`，否则需要在本组件单独初始化
- `esp_event` 回调运行在事件任务上，涉及较重逻辑时必须尽快返回；状态更新需用锁保护，禁止在回调内部等待阻塞对象
- 指数退避与 `FreeRTOS` 定时器选型不当可能阻塞事件任务；建议 `xTimerCreate` + `xTimerStart`，回调里只做 `esp_wifi_connect()` 触发
- `app_main` 短等 `wait_connected(3s)` 可能掩盖真实问题；需保证超时后 `VERIFY:` 依然记录 `FAIL`，不要静默通过
- 启动瞬间 `WIFI_EVENT_STA_DISCONNECTED` 首次为 `reason=201 NO_AP_FOUND` 属正常现象，不应被当作致命错误

## 8. 完成定义

- `idf.py build` 成功；`dependencies.lock` 中存在 `espressif/esp_wifi_remote` 与 `espressif/esp_hosted`
- 在有真实 AP 的环境下，面板冷启动可在 `CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS`（默认 3s）内完成 Wi‑Fi 连接；若未完成，`VERIFY:` 如实 `FAIL`
- 启动日志可见：`wifi_started=yes`、`wifi_connected=yes`、`ip=xxx.xxx.xxx.xxx`
- 断 AP 后能自动重连
- 现有 `VERIFY:` 标记全部不回归
- `network_service` 对外暴露 `wait_connected` 接口，可被后续 `time_service` / `ha_client` 调用
- `network_service/README.md` 描述已同步更新，说明 ESP-Hosted + C6 路线

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

- `firmware/components/network_service/network_service.c`
- `firmware/components/network_service/include/network_service.h`
- `firmware/components/network_service/Kconfig.projbuild`
- `firmware/components/network_service/CMakeLists.txt`
- `firmware/components/network_service/idf_component.yml`
- `firmware/components/network_service/README.md`
- `firmware/components/board_support/board_support.c`
- `firmware/components/board_support/include/board_support.h`
- `firmware/main/app_main.c`
- `firmware/sdkconfig.defaults`
- `firmware/dependencies.lock`
