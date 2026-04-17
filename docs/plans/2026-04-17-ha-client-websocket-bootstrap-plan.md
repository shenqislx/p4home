# ha-client-websocket-bootstrap Plan

所属 Milestone: `M4`

## 1. 背景

依据 [project-milestones.md](../project-milestones.md) 的定版，当前主线已调整为「连接 `Home Assistant`，以图形化方式展示家庭传感器数据」。`M4` 已经拆出三条前置 plan：

- plan 1 `network-service-wifi-sta-connect`：提供可用的 Wi‑Fi STA 链路与 `network_service_wait_connected(...)`
- plan 2 `time-service-sntp`：提供 `time_service_wait_synced(...)`，保证 TLS 握手时系统时钟已经是合理的真实时间
- plan 3 `settings-service-ha-credentials`：在 `p4home_ha` NVS namespace 中保存 `url` / `token` / `verify_tls`，并提供 `settings_service_ha_get_url/token`、`settings_service_ha_verify_tls`、`settings_service_ha_credentials_present`

但 **仓库内还没有任何 HA 侧 client**：面板目前没法和 `Home Assistant` 建立 WebSocket 会话，也没法完成 long-lived access token 的鉴权握手。`M4` 的后续 plan（`ha-client-state-subscription`、`panel-data-store`、`ui-dashboard-sensor-cards`、`ui-connection-status-banner` 等）全部压在「已有一个可用、已鉴权的 HA WebSocket 会话」这个前提上。

本 plan 是 `M4` 的第 4 号 plan，负责从零建立 `ha_client` 组件，让面板具备「HA WebSocket 拨号 + long-lived access token 鉴权」的最小可用能力，并把状态机、等待接口、VERIFY 标记一次到位，方便后续 plan 在不动握手逻辑的前提下，直接往状态机的 `READY` 之后叠功能。

本 plan 明确 **不做** 订阅 / 拉快照 / 完整重连策略 / metrics / UI —— 这些归 plan 5 / plan 10 / plans 8、9。

## 2. 目标

- 新建 `firmware/components/ha_client/` 组件，对齐仓库既有 `network_service` / `settings_service` 的组织风格
- 引入管理组件 `espressif/esp_websocket_client`，沿用 plan 1 对 `esp_wifi_remote` 的「先宽松约束 `"*"`，联调成功后再回填精确版本」工作流
- 完成 `IDLE → CONNECTING → AUTHENTICATING → READY → ERROR` 最小状态机
- 完成与 HA WebSocket API 的鉴权握手：收 `auth_required` → 发 `{"type":"auth","access_token":"..."}` → 等 `auth_ok` / `auth_invalid`
- 在拨号前统一等 `network_service_wait_connected` + `time_service_wait_synced`，单次失败进入 `ERROR` 并做一次简单 one-shot retry，不把完整 backoff 逻辑塞进本 plan
- 支持 `ws://` / `wss://` / `http(s)://host[:port]/api/websocket` 等常见 URL 形态并归一化；根据 `settings_service_ha_verify_tls()` 选择 `esp_crt_bundle` 还是明文
- 对外暴露稳定的 `ha_client_init/start/stop/get_state/wait_ready/state_text/last_error_text`，与 ICD 对齐，供下游 plan 直接调用
- `board_support_init` 在 settings / network / time init 之后初始化 `ha_client`；`app_main` 在记录 HA `VERIFY:` 前短等 `ha_client_wait_ready`，对齐 plan 1 的 Wi‑Fi 短等模式
- 不回归现有 `M0`~`M3` 的任何 `VERIFY:` 标记

## 3. 范围

包含：

- 新增 `firmware/components/ha_client/`（`CMakeLists.txt` / `Kconfig.projbuild` / `idf_component.yml` / `include/ha_client.h` / `ha_client.c` / `README.md`）
- 引入 managed component `espressif/esp_websocket_client`，约束先写 `"*"`，联调后回填精确版本
- URL 归一化：接受 `ws://host[:port][/api/websocket]`、`wss://...`、`http(s)://...`，统一拼成 `ws(s)://host:port/api/websocket`，并记住归一化后的 scheme 决定是否启用 TLS
- TLS：`wss` 情况下根据 `settings_service_ha_verify_tls()` 选 `esp_crt_bundle_attach`；`verify_tls=false` 时允许跳过证书校验以便本地 HA 使用自签证书或 `http://`
- 状态机 + `EventGroupHandle_t`（`CONNECTED_BIT | AUTH_OK_BIT | AUTH_FAIL_BIT | FATAL_BIT`）
- 鉴权握手：解析 `auth_required` / `auth_ok` / `auth_invalid`，解析用 IDF 自带 `cJSON`
- 启动前置：`network_service_wait_connected(CONFIG_P4HOME_HA_CLIENT_NET_WAIT_MS)` + `time_service_wait_synced(CONFIG_P4HOME_HA_CLIENT_TIME_WAIT_MS)`
- 失败行为：任一前置超时，或 WebSocket open 失败，或鉴权失败，均进入 `HA_CLIENT_STATE_ERROR`，记录 `last_error_text`，并做 **一次** one-shot retry（间隔 ~2s）；仍失败后保持 `ERROR` 等待 plan 10 的 runtime 重连
- `app_main` 短等：在既有 Wi‑Fi 短等块之后、`VERIFY:ha:*` 之前，调用 `ha_client_wait_ready(CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS)`，超时不 panic，但对应 `VERIFY:` 如实 `FAIL`
- `VERIFY:ha:ws_connected` / `VERIFY:ha:authenticated`

不包含：

- `subscribe_events` 订阅 `state_changed`（归 plan 5）
- `get_states` 初始快照拉取（归 plan 5）
- `ha_client_state_change_t` / `ha_client_state_change_cb_t` / `ha_client_set_state_change_callback` / `ha_client_initial_state_count` / `ha_client_subscription_ready` 等符号（归 plan 5，本 plan **显式不定义**）
- 完整重连策略（指数退避 + jitter + 可恢复/不可恢复错误分类 + `ha_client_reconnect_policy_t` 归 plan 10）
- metrics（`connected_duration_ms` / `reconnect_count` / `events_per_second_ewma` / `initial_state_age_ms` / `ha_client_get_metrics` 归 plan 10）
- UI 侧 HA 状态显示（归 plans 8/9）
- 任何 HA `call_service` 控制回写（归 `M6`）
- Wi‑Fi 凭证、HA URL/Token 的运行时修改路径（归 plan 3 / 未来配置页）

## 4. 设计方案

### 4.1 目录影响

- 新增 `firmware/components/ha_client/`
  - `ha_client.c`：状态机 + WebSocket 事件处理 + 握手
  - `include/ha_client.h`：对外 API 与类型
  - `Kconfig.projbuild`：声明本 plan 的四个键
  - `CMakeLists.txt`：`REQUIRES esp_websocket_client json esp-tls nvs_flash settings_service network_service time_service`（`esp_crt_bundle` 经 `esp-tls` 走 `PRIV_REQUIRES mbedtls` 即可）
  - `idf_component.yml`：`espressif/esp_websocket_client: "*"`（宽松约束，联调后回填）
  - `README.md`：说明 HA WebSocket 接入边界，明确「本 plan 只到 `READY`，订阅/拉快照在 plan 5」
- 扩展 `firmware/components/board_support/`
  - `board_support.c`：在 `board_support_init` 里 settings / network / time 之后追加 `ha_client_init`，并透传 `ha_client_*` 查询
  - `include/board_support.h`：追加 `board_support_ha_*` 透传 getter 与 `board_support_ha_wait_ready`
- 扩展 `firmware/main/app_main.c`
  - 在 Wi‑Fi 短等之后、`VERIFY:ha:*` 之前追加 `board_support_ha_wait_ready(CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS)`
  - 追加 `VERIFY:ha:ws_connected` / `VERIFY:ha:authenticated`
- `firmware/dependencies.lock`：由 `idf.py reconfigure` 自动新增 `espressif/esp_websocket_client` 条目
- `firmware/sdkconfig.defaults`：实现阶段 **不直接改**；`idf.py reconfigure` 成功后再通过 `menuconfig` 把**与默认不同的**键位回迁（预期可能涉及 `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y` 若 IDF 默认未开启）
- 不新增分区、不改 `partitions.csv`

### 4.2 模块拆解

`ha_client.c` 内部按职责切开（不对外暴露）：

- **URL 解析器 `ha_client_parse_url`**：输入 `settings_service_ha_get_url` 拿到的原始字符串，输出 `{ scheme, host, port, path, use_tls }`。接受：
  - `wss://homeassistant.local:8123`（补 `/api/websocket`，端口默认 `8123`）
  - `ws://192.168.1.10:8123/api/websocket`
  - `https://ha.example.com`（映射到 `wss://ha.example.com:443/api/websocket`）
  - `http://ha.local:8123`（映射到 `ws://ha.local:8123/api/websocket`）
  - 若配置 `settings_service_ha_verify_tls()==false` 且 URL scheme 是 `wss` / `https`，仍保持 `use_tls=true` 但关闭 `skip_cert_common_name_check`；`http` / `ws` 则保持明文
- **`esp_websocket_client` 包装**：按解析结果拼 `esp_websocket_client_config_t`，填充 `uri` 或 `host/port/path + transport`；TLS 情况下设置 `crt_bundle_attach = esp_crt_bundle_attach`（`verify_tls=true`）或 `skip_cert_common_name_check=true`（`verify_tls=false`）
- **状态机 + EventGroup**：
  - 状态字段用 `portMUX_TYPE` 保护（对齐 `gateway_service` / `network_service` 风格）
  - `EventGroupHandle_t` 位定义：`HA_BIT_CONNECTED`、`HA_BIT_AUTH_OK`、`HA_BIT_AUTH_FAIL`、`HA_BIT_FATAL`
  - `ha_client_wait_ready` 等 `HA_BIT_AUTH_OK`（或 `HA_BIT_AUTH_FAIL | HA_BIT_FATAL` 视为失败）
- **握手解析器 `ha_client_handle_text_frame`**：用 `cJSON_ParseWithLength` 解析 text frame，只识别 `type=auth_required|auth_ok|auth_invalid`。其他 type 在本 plan 阶段一律忽略（日志降级为 `DEBUG`），给 plan 5 留扩展入口
- **鉴权发送器 `ha_client_send_auth`**：用 `cJSON_CreateObject` 拼 `{"type":"auth","access_token":"..."}`，`esp_websocket_client_send_text(...)` 发送；发送前 token 在日志里必须脱敏（对齐 plan 3 的 `***<last4>` 约定）
- **`ha_client_task`（可选轻量任务）**：只负责启动阶段的「等 Wi‑Fi / 等 time / 启动 client / 处理 one-shot retry」串行流程，运行一次即退出或转为 idle；WebSocket 事件本身仍然由 `esp_websocket_client` 自己的任务驱动
- **错误文案表 `s_error_text[]`**：把 `ESP_ERR_TIMEOUT` / `invalid_auth` / `url_parse_failed` / `net_wait_timeout` / `time_wait_timeout` / `ws_open_failed` 等归一化成字符串，经 `ha_client_last_error_text()` 暴露

### 4.3 数据流 / 控制流

冷启动时序（对齐 plan 1、plan 2 的风格）：

1. `board_support_init` 顺序：`settings_service_init → network_service_init → time_service_init → ha_client_init`
   - `ha_client_init`：仅做资源申请（`EventGroup`、锁、状态字段、错误文案指针），不拨号、不读 NVS
2. `board_support_init` 继续跑完显示 / 触控 / 音频 / SR 等其它子系统
3. `board_support_init` 末尾（或 `app_main` 里显式）调用 `ha_client_start()`：
   - 若 `settings_service_ha_credentials_present()==false` → 记录 `last_error_text="credentials_missing"`，进入 `ERROR`，直接返回 `ESP_OK`（不算致命，保留离线可运行路径）
   - 否则：置状态 `CONNECTING`，创建 `ha_client_task` 串行跑下面 4–7 步
4. `network_service_wait_connected(CONFIG_P4HOME_HA_CLIENT_NET_WAIT_MS)`；超时 → `ERROR(net_wait_timeout)`，退出 task 让 plan 10 将来的 runtime loop 接管
5. `time_service_wait_synced(CONFIG_P4HOME_HA_CLIENT_TIME_WAIT_MS)`；超时 → `ERROR(time_wait_timeout)`
6. 读 `settings_service_ha_get_url` / `_get_token` / `_verify_tls`，解析 URL；解析失败 → `ERROR(url_parse_failed)`
7. `esp_websocket_client_init` + `register_events` + `esp_websocket_client_start`：
   - `WEBSOCKET_EVENT_CONNECTED` → 切 `AUTHENTICATING`，置 `HA_BIT_CONNECTED`；**不主动发任何帧**，等 HA 的 `auth_required`
   - `WEBSOCKET_EVENT_DATA`（text frame）→ `ha_client_handle_text_frame`：
     - 收到 `auth_required` → 调 `ha_client_send_auth`
     - 收到 `auth_ok` → 切 `READY`，置 `HA_BIT_AUTH_OK`
     - 收到 `auth_invalid` → 切 `ERROR(invalid_auth)`，置 `HA_BIT_AUTH_FAIL`，`esp_websocket_client_close`（token 无效属不可恢复，交 plan 10 决定长睡 / 用户重置凭证）
   - `WEBSOCKET_EVENT_ERROR` / `WEBSOCKET_EVENT_DISCONNECTED`：
     - 若此时状态在 `CONNECTING` / `AUTHENTICATING` → `ERROR(ws_open_failed)`，由「one-shot retry」决定是否再拨一次
     - 若状态已 `READY` → 仅切到 `ERROR(ws_disconnected)`，不在本 plan 里做自动重连，交 plan 10
8. one-shot retry：在 step 7 的「尚未鉴权通过就断」情况下，等 ~2s 再重跑 step 7 一次；仍失败保持 `ERROR` 退出 task
9. `app_main` 侧：
   - 先跑现有 `board_support_log_summary()` 与 Wi‑Fi 短等
   - 新增：`board_support_ha_wait_ready(CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS)` 默认 `8000ms`
   - 然后记 `VERIFY:ha:ws_connected:PASS|FAIL`（依据 `ha_client_get_state() != ERROR && state in {AUTHENTICATING, READY}` 或直接看 `HA_BIT_CONNECTED`）
   - 记 `VERIFY:ha:authenticated:PASS|FAIL`（依据 `ha_client_get_state() == READY`）
   - 超时不 panic，`VERIFY:` 如实 `FAIL`
10. 阻塞 / 非阻塞原则：
    - `ha_client_init` 不阻塞、不触发网络 IO
    - `ha_client_start` 返回即走，不等握手；`ha_client_wait_ready` 是**唯一**暴露的阻塞 wait
    - WebSocket 事件回调保持轻量：只做状态位切换 + `EventGroupSetBits`，不在回调里解析大 JSON 之外的东西，禁止在回调里等阻塞对象

### 4.4 Kconfig 与 sdkconfig

新增 `firmware/components/ha_client/Kconfig.projbuild`：

- `P4HOME_HA_CLIENT_NET_WAIT_MS`：`int`，默认 `10000`，`0` 表示不等（直接进入 `ERROR(net_wait_timeout)` 逻辑视作立即失败）
- `P4HOME_HA_CLIENT_TIME_WAIT_MS`：`int`，默认 `5000`
- `P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS`：`int`，默认 `8000`
- `P4HOME_HA_CLIENT_BUFFER_SIZE`：`int`，默认 `4096`，用于 `esp_websocket_client_config_t.buffer_size`（HA 握手/事件帧通常较小，订阅阶段在 plan 5 会根据实际事件帧大小再调整）

`sdkconfig.defaults` 策略（对齐 plan 1）：

- 本 plan 代码阶段**不直接改 `sdkconfig.defaults`**
- 首次 `idf.py reconfigure` 成功后跑一次 `idf.py menuconfig`，只把**与出厂默认不同**的 `esp_websocket_client` / `MBEDTLS_CERTIFICATE_BUNDLE` 等键回迁到 `sdkconfig.defaults`，保持基线最小化
- 不改 `CONFIG_SPIRAM_*`、分区、日志等现有基线

### 4.5 状态 / 对外字段扩展

`ha_client.h` 对外暴露（严格对齐 ICD plan 4 段）：

```c
typedef enum {
    HA_CLIENT_STATE_IDLE = 0,
    HA_CLIENT_STATE_CONNECTING,
    HA_CLIENT_STATE_AUTHENTICATING,
    HA_CLIENT_STATE_READY,
    HA_CLIENT_STATE_ERROR,
} ha_client_state_t;

esp_err_t     ha_client_init(void);
esp_err_t     ha_client_start(void);
esp_err_t     ha_client_stop(void);
ha_client_state_t ha_client_get_state(void);
esp_err_t     ha_client_wait_ready(uint32_t timeout_ms);
const char   *ha_client_state_text(ha_client_state_t s);
const char   *ha_client_last_error_text(void);
```

**不** 暴露 `ha_client_state_change_t` / 回调注册 / 初始状态计数 / metrics 等（留给 plan 5 / plan 10）。

`board_support` 透传（仅只读 + 一个 wait）：

- `bool board_support_ha_ready(void);`（即 `ha_client_get_state() == HA_CLIENT_STATE_READY`）
- `const char *board_support_ha_state_text(void);`
- `const char *board_support_ha_last_error_text(void);`
- `esp_err_t board_support_ha_wait_ready(uint32_t timeout_ms);`

`VERIFY:` 启动基线追加（在 `board_support_ha_wait_ready(...)` 之后打印）：

- `VERIFY:ha:ws_connected:PASS|FAIL`
- `VERIFY:ha:authenticated:PASS|FAIL`

## 5. 实现任务

代码侧（agent 可完成）：

1. 新建 `firmware/components/ha_client/` 骨架：`CMakeLists.txt`、`idf_component.yml`（`espressif/esp_websocket_client: "*"`）、`Kconfig.projbuild`、`include/ha_client.h`、`ha_client.c`、`README.md`
2. `include/ha_client.h`：声明 `ha_client_state_t` 与 §4.5 列出的 7 个 API，补 `/** @brief ... */` 注释；严格不写 plan 5 的回调 / plan 10 的 metrics 符号
3. `ha_client.c`：
   - 静态状态 + `portMUX_TYPE` 锁 + `EventGroupHandle_t`
   - `ha_client_parse_url`：支持 `ws/wss/http/https` 归一化到 `ws(s)://host:port/api/websocket`，端口缺省按 scheme 补 `80/443/8123`（`ws`/`wss` 默认 `8123`，`http/https` 默认 `80/443`）；单测风格要可从字符串解析
   - `ha_client_init`：幂等，分配 EventGroup / 锁 / 状态初值 `IDLE`
   - `ha_client_start`：读 `settings_service_ha_*`、缺凭证直接 `ERROR(credentials_missing)`；启一个小 task 串行跑 net/time 等待 + WebSocket 拨号 + one-shot retry
   - `ha_client_stop`：`esp_websocket_client_stop` + `_destroy`，状态回 `IDLE`
   - `ha_client_wait_ready`：`xEventGroupWaitBits` 等 `AUTH_OK | AUTH_FAIL | FATAL`
   - `ha_client_state_text`：返回 `IDLE` / `CONNECTING` / `AUTHENTICATING` / `READY` / `ERROR`
   - `ha_client_last_error_text`：返回最近一次错误归类字符串，不含 token
   - WebSocket 事件回调：仅做 `AUTHENTICATING` 切换 + `cJSON` 解析 + `esp_websocket_client_send_text` + EventGroup 置位
   - 握手 JSON：`{"type":"auth","access_token":"<token>"}`
   - 日志：`ha_client`（`ESP_LOGI/W/E`），token 始终 `***<last4>` 脱敏
4. `CMakeLists.txt`：`idf_component_register(SRCS ha_client.c INCLUDE_DIRS include REQUIRES esp_websocket_client json esp-tls settings_service network_service time_service PRIV_REQUIRES mbedtls esp_event freertos)`
5. `Kconfig.projbuild`：按 §4.4 声明 4 个键，放在 `menu "p4home HA Client"` 下
6. `board_support.c`：
   - 在 `board_support_init` 里现有 `network_service_init` 之后、显示初始化之前（或显示之后、SR 之前均可，重点是位于 `time_service_init` 之后）追加 `ha_client_init`
   - 在 `board_support_init` 末尾合适位置（或单独暴露一个 `board_support_network_bringup_kickoff` 的后续调用点）触发 `ha_client_start`；为保持启动阻塞时间可控，`ha_client_start` 自身不阻塞，内部 task 异步跑
   - 追加 `board_support_ha_ready` / `_state_text` / `_last_error_text` / `_wait_ready` 透传
7. `board_support.h`：声明新透传函数
8. `app_main.c`：
   - 在既有 Wi‑Fi 短等之后，调用 `board_support_ha_wait_ready(CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS)`
   - 追加 `VERIFY:ha:ws_connected` / `VERIFY:ha:authenticated` 两条 marker；标记 PASS 判定条件见 §4.5
9. `firmware/components/ha_client/README.md`：写清「本 plan 只负责握手到 `READY`，订阅在 plan 5，重连在 plan 10」、URL 归一化规则、Kconfig 键、VERIFY 列表
10. 保留本地自测钩子：在 `ha_client.c` 顶部加 `// TODO(plan-5): subscribe_events` / `// TODO(plan-10): reconnect policy` 注释，防止下游 plan 把逻辑塞错位置

用户本机侧（agent 给命令，用户在本机 IDF 环境执行）：

11. `idf.py reconfigure` 首次解析，确认 `dependencies.lock` 新增 `espressif/esp_websocket_client`，记录解出的版本号到 review 区
12. `idf.py menuconfig` 交叉检查：
    - `Component config → ESP WebSocket Client` 的默认是否合适（尤其是 task stack / buffer size，和 `CONFIG_P4HOME_HA_CLIENT_BUFFER_SIZE` 保持一致或更大即可）
    - `Component config → mbedTLS → Certificate Bundle` 是否已启用（`wss` 场景必需），若不默认启用则在 `sdkconfig.defaults` 追加 `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y`
    - 只把**与默认不同**的键位回迁 `sdkconfig.defaults`
13. `idf.py build` 两轮：
    - 第一轮：不配 HA 凭证（`CONFIG_P4HOME_HA_URL` 空、`CONFIG_P4HOME_HA_TOKEN` 空）→ 构建成功，启动日志走 `credentials_missing` 分支，`VERIFY:ha:ws_connected:FAIL`、`VERIFY:ha:authenticated:FAIL`，面板不 panic
    - 第二轮：配真实 HA（本地 `http://ha.local:8123` + long-lived token），`VERIFY:ha:*:PASS`
14. 烧录 + `idf.py monitor`：
    - `wss://` 远端 HA 实例复测一次，确认 `esp_crt_bundle` 路径走通
    - 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ha-ws-bootstrap-v1.log` 作为 review 附件
15. 实机联调通过后，把 `idf_component.yml` 中的 `espressif/esp_websocket_client: "*"` 回填为 `dependencies.lock` 实际解出的精确版本，并重跑一次 `idf.py reconfigure + build` 确认一致

## 6. 测试方案

### 6.1 构建验证

- `idf.py set-target esp32p4` 保持；`idf.py build` 通过，无新增编译/链接错误
- `idf.py reconfigure` 后 `dependencies.lock` 出现 `espressif/esp_websocket_client`
- 打开 `menuconfig`：
  - `P4HOME_HA_CLIENT_NET_WAIT_MS` / `_TIME_WAIT_MS` / `_HANDSHAKE_TIMEOUT_MS` / `_BUFFER_SIZE` 可见且默认值符合 §4.4
  - `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y` 已启用（或在 `sdkconfig.defaults` 中回迁生效）
- 不配 HA 凭证的路径也能构建成功（MVP 默认场景）

### 6.2 功能验证

- 不配凭证路径：
  - 启动日志：`ha_client state=ERROR last_error=credentials_missing`
  - `VERIFY:ha:ws_connected:FAIL` / `VERIFY:ha:authenticated:FAIL`
  - 面板仍可进入 `app_main` 心跳循环
- URL 归一化单点测试（可用 host-side 的最小 C 测试或直接走 `idf.py monitor` 观察日志）：
  - `wss://homeassistant.local` → `wss://homeassistant.local:8123/api/websocket`
  - `http://192.168.1.10:8123` → `ws://192.168.1.10:8123/api/websocket`
  - `ws://ha.lan/` → `ws://ha.lan:8123/api/websocket`
  - 非法字符串 → `ha_client_last_error_text()==url_parse_failed`
- 明文 `ws://` 本地 HA 路径（`CONFIG_P4HOME_HA_VERIFY_TLS=n`）：
  - 收到 `auth_required` → 发 `auth` → 收 `auth_ok` → `READY`
  - 状态序列 `IDLE → CONNECTING → AUTHENTICATING → READY` 可在日志里逐条观察到
- 坏 token 场景（故意把 Kconfig 里的 token 改错）：
  - 收到 `auth_invalid` → `ERROR(invalid_auth)`，不做 one-shot retry（token 错误视作不可恢复）
  - 本 plan 不重连，静置等 plan 10
- 断网场景（`ha_client_start` 时 AP 已关）：
  - `network_service_wait_connected` 超时 → `ERROR(net_wait_timeout)`；one-shot retry 之后仍 `ERROR`
  - 面板不 panic，后续由 plan 10 接管

### 6.3 回归验证

- `VERIFY:network:stack/event_loop/sta_netif/wifi_started/wifi_connected/ip_acquired` 全部不回归
- `VERIFY:time:sync_started/sync_acquired` 不回归（plan 2）
- `VERIFY:settings:ha_credentials_present` 不回归（plan 3）
- `boot / display / touch / audio / sr / gateway` 现有 `VERIFY:` 结果保持旧基线
- `app_main` 心跳与 `gateway` 定时发布路径不变；`ha_client_wait_ready` 的 8s 短等不应使心跳抖动 > 300ms
- 不配 HA 凭证时，启动阶段总耗时与 plan 1 / plan 2 完成后的旧基线相比，额外增量 ≤ `CONFIG_P4HOME_HA_CLIENT_NET_WAIT_MS + CONFIG_P4HOME_HA_CLIENT_TIME_WAIT_MS`（理论上 `credentials_missing` 直接短路，实际应接近 0）

### 6.4 硬件 / 联调验证

- 准备一台本地 HA 实例（Home Assistant Core 或 OS），生成一个 long-lived access token
- 通过 `menuconfig` 或 Kconfig 种子写入：`CONFIG_P4HOME_HA_URL="http://<ha-host>:8123"` / `CONFIG_P4HOME_HA_TOKEN="<token>"` / `CONFIG_P4HOME_HA_VERIFY_TLS=n`
- `idf.py flash monitor` 冷启动后观察：
  - `ha_client parse_url scheme=ws host=<ha-host> port=8123 path=/api/websocket tls=no`
  - `ha_client state: IDLE -> CONNECTING`
  - `WEBSOCKET_EVENT_CONNECTED` + `ha_client state: CONNECTING -> AUTHENTICATING`
  - `recv auth_required`
  - `send auth token=***<last4>`
  - `recv auth_ok`
  - `ha_client state: AUTHENTICATING -> READY`
  - `VERIFY:ha:ws_connected:PASS`
  - `VERIFY:ha:authenticated:PASS`
- 切换到远端 `wss://` 实例重复一次，确认 `esp_crt_bundle` 路径 `READY`
- 故意断 AP → 启动后观察 `ERROR(net_wait_timeout)` 一次 + one-shot retry 一次 + 最终 `ERROR` 留给 plan 10
- 串口日志保存到 `/tmp/p4home-serial-YYYYMMDD-ha-ws-bootstrap-v1.log` 作为 review 附件

## 7. 风险

- **固件体积压力**：当前 `factory` app 分区仅剩 ~2%（见 `project-milestones.md` §2 决策）；`espressif/esp_websocket_client` + `cJSON` 使用量增加 + `esp_crt_bundle` 的默认 CA 列表都会显著挤占 flash；实现阶段必须在第一次 `idf.py build` 后 `idf.py size` / `idf.py size-components` 对齐前后差值，必要时把 `esp_crt_bundle` 精简为 `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_CMN`，或配合 `firmware-size-reduction` plan 的结论做精简
- **TLS 栈内存足迹**：`wss://` 握手时 mbedTLS 栈峰值内存 + 证书链缓存可能瞬时 > 40 KB，叠加 WebSocket RX 缓冲 `CONFIG_P4HOME_HA_CLIENT_BUFFER_SIZE` 默认 `4096`，`esp_websocket_client` 任务 stack 需 ≥ 6 KB；若 PSRAM 未承接这些分配，会落在 internal RAM 上，需要在硬件联调时确认无 `malloc` 失败
- **`esp_websocket_client` 版本漂移**：采用 `"*"` 宽松约束是为了在 IDF v5.5.4 上先解出一个可用版本；实现 / 联调完成后 **必须** 按 `dependencies.lock` 回填精确版本，否则后续 CI 可能因 client API 微调而回归（同 plan 1 对 `esp_wifi_remote` 的策略）
- **`time_service_wait_synced` 耦合**：TLS 握手依赖真实系统时间；若用户环境 NTP 不通 → `time_wait_timeout` → 本 plan 永远进不了 `READY`。本 plan 不改 plan 2 的行为，但要在 README 中显式提醒，并在 `ha_client_last_error_text` 精确区分 `net_wait_timeout` / `time_wait_timeout` / `invalid_auth` / `ws_open_failed` / `url_parse_failed`
- **`auth_invalid` vs 网络抖动**：本 plan 的 one-shot retry 只处理「open / `auth_required` 阶段失败」，`auth_invalid` 视作不可恢复；如果 HA 侧出现极少数 "握手阶段临时拒绝" 的情况，用户在硬件联调阶段可能会看到「只跑了一次就不再重试」，这是有意为之，完整策略在 plan 10 补
- **事件回调不能阻塞**：`WEBSOCKET_EVENT_DATA` 回调运行在 `esp_websocket_client` 内部任务；JSON 解析必须 O(text-frame-size) 并立即返回，禁止在回调里 `wait_ready` / `settings_service_*` 重活
- **凭证敏感日志**：token 必须全程 `***<last4>` 脱敏，对齐 plan 3 的 `settings_service_ha_log_summary`；review 时需要抽查串口日志与 `ESP_LOGD` 路径，避免 DEBUG 级误打 token 全文
- **`board_support_init` 阻塞时间**：`ha_client_init` / `ha_client_start` 都设计为非阻塞；但如果 future 改成同步等 `READY`，会把 `board_support_init` 整体拖到 ≥ 10s，影响 UI 早期渲染。当前实现必须保持「start 返回即走，wait 留给 `app_main`」的边界
- **one-shot retry 与 plan 10 的职责边界**：本 plan 的简单 retry 只是为了减少「握手第一次失败就直接 `VERIFY:FAIL`」的概率；plan 10 落地后 **必须把这段 retry 挪走或改写**，否则会跟指数退避打架。实现阶段在注释里留好 `// TODO(plan-10)` 钩子
- **`auth_ok` 之后的沉默期**：本 plan 不发 `subscribe_events` / `get_states`，因此 HA 侧会看到一个「登录但什么都不订阅」的 session。联调时如果 HA 侧做 session 审计，可能出现告警日志，属预期

## 8. 完成定义

- `idf.py build` 成功；`dependencies.lock` 中存在 `espressif/esp_websocket_client`，并已回填精确版本
- 面板在有真实 HA 的环境下，冷启动可在 `CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS`（默认 8s）内完成 `IDLE → CONNECTING → AUTHENTICATING → READY`；否则 `VERIFY:` 如实 `FAIL`，不 panic
- 启动日志可见：
  - `VERIFY:ha:ws_connected:PASS`
  - `VERIFY:ha:authenticated:PASS`
- 配错 token 时，状态稳定在 `ERROR(invalid_auth)`，不自动无限重试，不刷屏
- 断网 / NTP 不通时，状态稳定在 `ERROR(net_wait_timeout|time_wait_timeout)`，不 panic，不卡死其它子系统
- `ha_client` 对外暴露的 7 个符号严格按 ICD 命名，未提前引入 plan 5 / plan 10 的符号
- `board_support_ha_wait_ready` 已接入 `app_main`，与现有 Wi‑Fi 短等风格对齐
- `ha_client/README.md` 描述已同步更新，说明 WebSocket 接入路线、URL 归一化规则、与下游 plan 的职责边界
- 现有 `M0`~`M3`、plan 1/2/3 的 `VERIFY:` 标记全部不回归

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

- `firmware/components/ha_client/ha_client.c`
- `firmware/components/ha_client/include/ha_client.h`
- `firmware/components/ha_client/Kconfig.projbuild`
- `firmware/components/ha_client/CMakeLists.txt`
- `firmware/components/ha_client/idf_component.yml`
- `firmware/components/ha_client/README.md`
- `firmware/components/board_support/board_support.c`
- `firmware/components/board_support/include/board_support.h`
- `firmware/main/app_main.c`
- `firmware/sdkconfig.defaults`
- `firmware/dependencies.lock`
