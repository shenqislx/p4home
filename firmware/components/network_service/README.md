# network_service

网络模块。

当前负责：

- `esp_netif` 初始化
- 默认事件循环初始化
- `Wi-Fi STA` 形态的 `esp_netif` 创建
- 基于板级 `base MAC` 生成默认 `hostname` / `device_id`
- 网络状态摘要输出
- 启动期 `VERIFY:network:*` 自检基线

后续扩展负责：

- Wi‑Fi 配网与连接管理
- 时间同步
- 设备注册模型
- 状态同步 / 命令下发接口
- 后续网关连接
