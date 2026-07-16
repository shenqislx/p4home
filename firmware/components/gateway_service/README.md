# gateway_service

本地 `M4` 网关骨架。

当前负责：

- 设备注册模型
- 面板状态快照
- 单条 pending command 邮箱
- 最近一次命令执行结果摘要

当前自检 command：

- `sync_state`

`Home`、`Settings`、`Gateway` 三个早期诊断页面已从产品 UI 移除；网关服务继续为启动自检和状态快照提供后台能力。

当前阶段不负责：

- 真实网络协议
- 真实远端注册
- Home Assistant / 米家实体映射
