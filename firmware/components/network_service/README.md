# network_service

网络模块。

## 硬件前提

`ESP32-P4` 自身不带 Wi‑Fi 射频。本项目使用 `ESP32-P4 Function EV Board` 板载的 `ESP32-C6` 协处理器提供 Wi‑Fi，master 侧通过 `espressif/esp_wifi_remote` 管理组件把标准 `esp_wifi_*` API 路由到 C6 slave，transport 为 SDIO。C6 slave firmware 使用 EV Board 出厂镜像，本组件不负责 slave 端固件。

## 当前职责

- `esp_netif` 初始化
- 默认事件循环初始化
- `Wi-Fi STA` 形态的 `esp_netif` 创建
- 基于板级 `base MAC` 生成默认 `hostname` / `device_id`
- `esp_wifi_init` / `set_mode(STA)` / `set_config` / `start`，并在 `WIFI_EVENT_STA_START` 后发起 `esp_wifi_connect`
- 订阅 `WIFI_EVENT_*` 与 `IP_EVENT_STA_GOT_IP`，维护 `wifi_started / wifi_connected / wifi_has_ip / ip_text / retry_count / last_disconnect_reason`
- 断线后按指数退避（`1s → 30s`）自动重连，达到 `P4HOME_WIFI_MAX_RETRY` 后切到 `60s` slow-retry 循环
- 提供 `network_service_wait_connected(timeout_ms)` 供 `app_main` / `time_service` / `ha_client` 使用
- 启动期 `VERIFY:network:stack|event_loop|sta_netif|wifi_started|wifi_connected|ip_acquired` 自检基线

## 凭证来源

本阶段通过 `Kconfig.projbuild` 注入：

- `P4HOME_WIFI_SSID`
- `P4HOME_WIFI_PASSWORD`
- `P4HOME_WIFI_MAX_RETRY`
- `P4HOME_WIFI_AUTOSTART`
- `P4HOME_WIFI_VERIFY_WAIT_MS`

后续 NVS / 运行时改写凭证归 `settings-service-ha-credentials` plan。

## 后续扩展

- 运行时 Wi‑Fi 凭证读写（走 `settings_service` NVS）
- 时间同步（归 `time-service-sntp`）
- Home Assistant WebSocket 接入（归 `ha-client-websocket-bootstrap`）
- UI 侧 Wi‑Fi 状态指示（归 `ui-connection-status-banner`）
