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
`qwen3.6:35b-mlx`，但不共享上下文、工具权限或推理参数；所有 Qwen 请求固定使用
`think: false`。

## 当前工作重点

当前进入 M7 Agent 化主线，唯一架构基线为：

- [P4 Home 本地 LLM Agent 化架构](./docs/p4-local-agent-architecture.md)

执行入口：

- [当前工作计划与 Phase 状态](./docs/plans/README.md)
- [当前里程碑](./docs/project-milestones.md)
- [Harness Workflow](./docs/harness-workflow.md)
- [Human-only 常驻语音聊天](./docs/product-human-voice.md)

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
fake sink、丢帧 0，并保持 HA、固定命令与稳态 UI 主链，独立 review 后技术门禁关闭。5C 最终 run
`32635742553` 已证明真实 P4 中文输入经固定 STT 后只进入统一 Human Runtime，审计完整且 Cat 零
泄漏；5D 分角色 TTS、播放与 barge-in 技术门禁已通过。2026-09-01，commit `85b55ec` 的
`phase5e_ui` run `33452154578` 已通过真实模型/HA/STT 的读、低风险写入并恢复、Human 聊天、三次
终态 UI delivery、六次 P4 applied ACK 和 artifact 隐私审计，用户另行肉眼确认三轮屏幕均更新到
最终内容；`phase5a_voice` run `33454508895` 与人工听觉共同确认外接 SPK/J16 startup tone。
`phase5e_e2e` run `33450564511` 曾因 `voice_e2e_result_timeout` 失败；修复提交 `d39b69b`
的 run `33456284948` 已完成四次分角色播放和 barge-in，用户确认功能符合要求。但该 run
因旧 artifact schema 无法守恒合法 STT 重试而 fail-closed，且用户明确反馈语音响应明显偏慢。
重试审计守恒、模型 ready 前预热与 VAD 静音提前收口已提交为 `e004870`。run `33460199737`
证明 artifact 审计通过且 VAD 已由固定 `5 s` 改为语音后静音提前收口，但 terminal credit 被固件
误判后触发重连，三次 STT 均被取消。首次修复提交 `8b96022` 的 run `33461779715` 复现同样失败，
从精确时序确认 pre-EOS credit 是在 `WAITING_CLOSE` 窗口到达，而非只在关闭后的 IDLE 到达。
覆盖两个终止窗口的修复提交 `cbd0f39` 已由 run `33463393866` 完成实机复验：workflow、artifact
审计、driver/harness、四轮业务、写入恢复和 barge-in 全部通过，STT/TTS 均为 4 次且无重试；
capture-open 到 playback-open 为 `7.55–8.16 s`。仍待用户确认实际响应体感可接受，以及人工长停顿
句不被 `800 ms` 静音窗口误截断。因此 Phase 5 继续保持
`pending_real_environment`，默认 SR 仍关闭。2026-08-24 用户明确授权 Phase 6
先完成编码、确定性测试与模拟验证。Phase 6A–6E
本地门禁现已完成：Memory contract/SQLite、
确定性写入与删除、private 产品召回、三种 visibility 策略对照和 `pnpm gate:phase6` 均有本地证据。
2026-08-24 用户已批准 visibility matrix v1 保持 `private`；三类 Memory 均保持 owner-role private，
`shared_acl/hybrid` 仅限 experimental evaluator，跨角色产品召回未启用。6F 真实 35B
门禁已通过，6G 真实 HA 只读门禁已从干净工作树复跑通过并绑定提交。6I APFS 权限、WAL/NORMAL、
受控进程终止、完整性/损坏拒绝、在线备份和 checkpoint 冷备份子门禁已从干净工作树复跑通过，
production-policy 刷新证据绑定提交 `899b746`。6H P4 Cat + Memory run `32819132030` 已通过，
World 仍以 P4 snapshot 为真值且 artifact 隐私审计通过；DB/WAL/index quota revision 1
（128/256/256 MiB）与分类
retention revision 1 已获批并实现。代表性家庭数据、Voice + Memory、家庭身份、真实断电、
加密与介质级 secure-delete 于 2026-08-25 经用户决定延期，均保持未验证而非通过。同日用户最终
review 通过、接受这些延期并关闭 Phase 6；Phase 6 计划已归档。
Vector DB 仍不立项。Phase 5 仍为 `pending_real_environment`。2026-08-26 用户已明确授权启动
Phase 7；7A feature runtime 已实现四类低频 trigger、Event Policy、quiet hours/budget/总开关、
用户抢占和审计查询，7B 本地长跑/频率/误触发/抢占 gate 也已通过。随后，修复提交 `e8de907`
对应的 7C run `33061620203` 已通过产品接线、真实只读 HA
快照/P4/模型、终态后 P4 心跳、artifact 隐私与 120 秒、1 秒粒度资源采样稳定门禁（非瞬时硬上限）。
2026-08-27 用户最终 review 通过，Phase 7 已完成并归档。Agent
与 P4 的零 `call_service` dispatch 计数不等同于 HA 服务端全局零写入。Phase 6 完整
清单和复现入口见
[Phase 6 real-environment gate evidence](./evidence/agent-phase-6/phase-6-real-environment-gates.md)。

7C1 产品接线已通过独立 bugs review：默认关闭，显式启用后等待 P4 Device Protocol v2 ready，再挂载
Timer/HA/World/task-complete；本机 bearer 控制与审计说明见
[Cat Autonomy 产品接线](docs/product-cat-autonomy.md)，本地复核见
[7C1 evidence](evidence/agent-phase-7/phase-7c1-product-wiring-review.md)，真实环境技术门禁见
[7C evidence](evidence/agent-phase-7/phase-7c-real-environment-gate.md)。

## 工作规则

开始任务前依次读取：

1. [AGENT.md](./AGENT.md)；
2. [当前架构](./docs/p4-local-agent-architecture.md)；
3. [当前计划索引](./docs/plans/README.md)；
4. 如存在，再读取当前 `in_progress` Phase plan。

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
