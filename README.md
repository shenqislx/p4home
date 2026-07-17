# p4home

基于 `ESP32-P4` 的原生 `Home Assistant Smart Panel` 项目。

当前技术路线已定版为：

- 面板方案：`ESP32-P4 原生面板`
- 固件基座：`ESP-IDF`
- 图形栈：`LVGL`
- 本地语音前端：`ESP-SR`
- 家居中台：`Home Assistant`
- 本地 AI 节点：后续接入 `Whisper / Piper / Ollama`

当前 `ESP-IDF` 版本基线：

- 固定版本：`ESP-IDF v5.5.4`
- 当前阶段不使用：`master`、漂移分支、`v6.x`
- 所有 `firmware/` 相关构建与验证，默认都应先切换到 `v5.5.4`

未来何时考虑升级 `ESP-IDF`：

- 当当前 `M6` 控制回写主线稳定后，再评估是否需要升级
- 当现有版本在 `ESP32-P4` 支持、驱动、组件兼容性上出现明确阻塞
- 当新版本带来项目明确需要的能力，而不是仅仅“版本更新”
- 升级前应先做一次独立验证，确认不会破坏现有 `firmware/` 构建和已完成功能

当前优先级：

1. 推进 `M6`：`Home Assistant call_service` 控制回写
2. 补齐 dashboard 控制卡片：开关与 action / scene
3. 用真实 HA 可控设备完成“面板 -> HA -> 设备”闭环
4. 米家设备先通过 HA 暴露后再纳入面板控制

当前工程状态：

- `M0` 到 `M2` 已完成
- `M3` 音频与本地语音前端骨架已完成，主线暂停
- `M4` / `M5` 已完成 HA 读侧与图形化传感器 dashboard MVP
- 当前工作区正在实现 `M6` 控制回写与控制卡片，尚未提交

现有文档：

- [总体方案](./docs/esp32-p4-smart-panel-plan.md)
- [本地验证计划](./docs/p4-local-validation-plan.md)
- [UTM 桥接网络与 P4/HA 通讯操作手册](./docs/utm-bridged-network-p4-home-assistant-guide.md)
- [Harness 工作流](./docs/harness-workflow.md)

建议开发顺序：

1. 完成并提交 `M6` 的 `ha_client call_service` 写回 API
2. 完成并提交 dashboard 控制卡片
3. 接入真实 HA 可控实体做实机验证
4. 再推进米家经 HA 暴露后的联动闭环
5. `M6` 稳定后再重启 `M7` 本地语音对话

本地维护辅助：

- `AGENT.md`：目录与模块总览
- `docs/plans/`：功能 plan 持久化目录
- `docs/templates/`：文档模板
- `scripts/`：plan、commit、push、hook 安装辅助脚本
- `.githooks/`：本地 hook 模板
- `firmware/`：固件主工程
