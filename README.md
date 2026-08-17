# p4home

基于 ESP32-P4 的原生 Home Assistant Smart Panel，并逐步扩展为由局域网本地 LLM Agent Runtime 驱动的家庭智能终端。

## 当前技术基线

- 面板：ESP32-P4 Function EV Board；
- 固件：ESP-IDF v5.5.4；
- 图形：LVGL v9；
- 联网：ESP32-C6 ESP-Hosted；
- 本地语音前端：ESP-SR；
- 家居中台：Home Assistant；
- 本地 AI 节点：Ollama、STT、TTS、Agent Runtime。

通用 LLM 不运行在 ESP32-P4 上。P4 负责 UI、交互、音频前端和世界动作执行；Mac mini/PC/Home Server 负责模型推理、Agent、Memory 与工具编排。

Agent 产品层使用统一 Role Router 和三个隔离角色：Robot 只执行受限 HA 命令，Human 只负责对话，
Cat 作为事件驱动电子宠物使用最小 P4 World 能力。它们默认共用一个已加载的
`qwen3.8:27b-mlx`，但不共享上下文、工具权限或推理参数；所有 Qwen 请求固定使用
`think: false`。

## 当前工作重点

当前进入 M7 Agent 化主线，唯一架构基线为：

- [P4 Home 本地 LLM Agent 化架构](./docs/p4-local-agent-architecture.md)

执行入口：

- [当前工作计划与 Phase 状态](./docs/plans/README.md)
- [当前里程碑](./docs/project-milestones.md)
- [Harness Workflow](./docs/harness-workflow.md)

当前仅推进 Phase 0：恢复可重复构建、固化 ESP32-C6 Hosted 配置、关闭 M6 遗留状态、采集运行期基线、冻结 Device Protocol v1/Tool Schema v1，并建立 Mock 合约测试。

## 工作规则

开始任务前依次读取：

1. [AGENT.md](./AGENT.md)；
2. [当前架构](./docs/p4-local-agent-architecture.md)；
3. [当前计划索引](./docs/plans/README.md)；
4. 当前 `in_progress` Phase plan。

`docs/plans/` 只保存当前计划；过去的架构、计划和实施记录统一位于 [docs/archive](./docs/archive/README.md)。

## ESP-IDF 版本策略

- 固定使用 ESP-IDF v5.5.4；
- 当前阶段不升级 `master` 或 v6.x；
- 固件构建前先使用 `scripts/activate-idf-v5.5.4.sh`；
- v5.5.4 manifest 要求的 RISC-V 工具链已经补齐，Phase 0 干净构建和实机烧录均已通过；
- 激活入口支持 `set -euo pipefail` 严格 shell，CI/runner 不得绕过该统一入口。
- `firmware/dependencies.lock` 纳入版本控制；managed component 升级必须显式 review，构建不得在线漂移。

## 主要目录

- `firmware/`：ESP32-P4 固件；
- `sim/`：Pixel Home host simulator 与 fake backend；
- `agent/`：Phase 1 才创建的本地 Agent Runtime；
- `contracts/`：Phase 0 创建的跨端协议与 Tool Schema；
- `docs/plans/`：当前 Agent 工作计划；
- `docs/records/`：完成后的稳定实现/验证记录；
- `docs/archive/`：历史架构、计划和记录；
- `scripts/`：构建、计划、提交和验证辅助脚本。

## 现有运行手册

- [ESP-IDF v5.5.4 安装](./docs/esp-idf-v5.5.4-install.md)
- [ESP-IDF 激活说明](./docs/esp-idf-v5.5.4-activation-skill.md)
- [UTM / Home Assistant 网络指南](./docs/utm-bridged-network-p4-home-assistant-guide.md)
