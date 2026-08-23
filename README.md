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

Phase 2 已完成并通过用户最终 review。Role Contract & Router、Cat Action Adapter、P4 World
Service、真实传输与实机门禁四个纵切均满足退出条件；Agent/P4 真实 Device WebSocket 已通过实机
100 次动作、第 50 次后重连 snapshot、两小时 Agent 离线与资源/8 FPS artifact 判定。Phase 2 计划
已归档。2026-08-20，用户已授权启动 Phase 3；3A Object Registry Contract、3B P4 Object Runtime
与 3C Cat Object Event & Role Boundary 已完成。3D 最终实机 run `32382940058` 已通过动作链、重连、
取消、Agent 离线释放、HA/UI、资源与 8 FPS artifact 判定。2026-08-20 用户最终 review 通过，
Phase 3 已完成并归档；对象级 Tool 仅加入 Cat RoleProfile，冻结的 Device Protocol v1 / Tool
Schema v1 未修改。2026-08-20 用户已授权启动 Phase 4 并先完成准备；4A–4E 独立门禁、Robot/P4
凭证隔离、HA 写侧 unknown 语义与多角色 span 边界已冻结。4A 的 HA contract、凭证文件边界、
allowlist transport 与 review 修复已完成并推送。4B 只读 Robot `home.get_entity(alias)` coding 与独立
bugs review、真实 HA 只读门禁均已完成。4C 低风险写侧、真实 HA/P4 收敛与恢复已完成；4D 多
assignment/确定性 Composer 和 4E 安全评测也已通过。最终硬件 run `32585132074` 证明离线 Robot、
在线 HA/P4 回刷、1800 秒长稳、post-Robot standalone/UI 8 FPS 与无矛盾证据；用户另行确认物理灯态
变化/恢复和实际触摸交互。4A–4E 技术与真实环境门禁均已关闭；2026-08-23 用户最终 review 通过，
Phase 4 已完成并归档。用户另行明确授权启动 Phase 5；5A 的 Voice Protocol v1、自动化硬件、真实
wake 与固定命令动作门禁已通过；5B 最终 run `32627837273` 已证明真实 P4 PCM 有界抵达 Agent
fake sink、丢帧 0，并保持 HA、固定命令与稳态 UI 主链，独立 review 后技术门禁关闭。P4 可听
startup tone 人工观察在用户离开设备期间仍明确待补；当前进入 5C，默认 SR 仍关闭，尚未接入真实 TTS。

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
