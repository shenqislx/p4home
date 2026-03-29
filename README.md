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

- 当 `M1` 到 `M3` 的板级 bring-up、`LVGL`、`ESP-SR` 基础链路已经稳定
- 当现有版本在 `ESP32-P4` 支持、驱动、组件兼容性上出现明确阻塞
- 当新版本带来项目明确需要的能力，而不是仅仅“版本更新”
- 升级前应先做一次独立验证，确认不会破坏现有 `firmware/` 构建和已完成功能

当前优先级：

1. 完成 `ESP-IDF + LVGL + ESP-SR` 的本地验证
2. 完成 `屏幕 / 触摸 / 音频 / 网络` 的 bring-up
3. 验证原生 UI 与本地唤醒词链路
4. 再进入 `Home Assistant` 与语音网关联调

当前工程状态：

- 已完成项目治理与 GitHub milestones 基线
- 已创建 `firmware/` 最小 `ESP-IDF` 工程骨架
- 下一步进入 `M1` 板级 bring-up

现有文档：

- [总体方案](./docs/esp32-p4-smart-panel-plan.md)
- [本地验证计划](./docs/p4-local-validation-plan.md)
- [Harness 工作流](./docs/harness-workflow.md)

建议开发顺序：

1. 建立最小 `ESP-IDF` 工程
2. 点亮屏幕并跑通 `LVGL`
3. 打通触摸与页面切换
4. 打通音频输入输出
5. 集成 `ESP-SR` 验证唤醒词与固定命令
6. 增加设备配置、日志、OTA 基础设施
7. 再接入 `Home Assistant`

本地维护辅助：

- `AGENT.md`：目录与模块总览
- `docs/plans/`：功能 plan 持久化目录
- `docs/templates/`：文档模板
- `scripts/`：plan、commit、push、hook 安装辅助脚本
- `.githooks/`：本地 hook 模板
- `firmware/`：固件主工程
