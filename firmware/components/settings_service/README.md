# settings_service

设置与持久化模块。

当前负责：

- `NVS` 初始化
- `boot_count` 持久化
- `startup_page` 兼容迁移（旧的 `home` / `settings` 值统一迁移为 `dashboard`）
- Home Assistant URL、Token 与 TLS 校验配置

产品界面当前固定从 `dashboard` 启动，不再提供启动页选择。

后续继续负责：

- 本地配置扩展
- 设备信息与标识
- 网络与 OTA 相关配置
