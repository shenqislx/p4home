# P4 Home 当前工作计划

> Current Focus: [P4 Home 本地 LLM Agent 化架构](../p4-local-agent-architecture.md)
> Updated: 2026-08-23
> Working Branch: `feature/agent-harness`

## 工作规则

- 本目录只保存当前架构主线尚未归档的计划；
- 任意时刻最多一个 Phase 标记为 `in_progress`；
- 后续 Phase 可以先定义边界，但只有前置退出门禁满足后才能启动；
- 每完成一个任务，都要把验证证据写回对应 Phase plan；
- Phase 完成并 review 后，计划移入 `docs/archive/plans/agent/`，长期结论更新到架构文档或正式技术记录；
- Phase 0–7 的所有文档、代码和测试改动持续提交到 `feature/agent-harness`；
- 单个 Phase 完成后不合入 `main`，全部 Phase 完成并通过最终 review 后再整体合入；
- 旧 Smart Panel、M1–M6 计划均已归档，不再作为默认工作入口。

## 当前顺序

| 顺序 | Phase | 状态 | 主要结果 | 计划 |
|---|---|---|---|---|
| 0 | Baseline & Contract | `completed` | 可重复构建、运行期基线、协议 v1、Mock | [Phase 0 归档](../archive/plans/agent/2026-08-15-agent-phase-0-baseline-contract-plan.md) |
| 1 | Text Agent Runtime | `completed` | TypeScript Runtime、Ollama、有限 Tool Loop | [Phase 1 归档](../archive/plans/agent/2026-08-15-agent-phase-1-text-runtime-plan.md) |
| 2 | Role Runtime & Cat World | `completed` | Role Router、三角色隔离、Cat 房间动作 | [Phase 2 归档](../archive/plans/agent/2026-08-15-agent-phase-2-p4-room-world-plan.md) |
| 3 | Cat Object World | `completed` | sofa 等对象锚点与 Cat 交互动作 | [Phase 3 归档](../archive/plans/agent/2026-08-15-agent-phase-3-object-world-plan.md) |
| 4 | Robot HA & Multi-role | `completed` | Robot 受限 HA 工具、Human/Robot 语义分割 | [Phase 4 归档](../archive/plans/agent/2026-08-15-agent-phase-4-ha-tool-plan.md) |
| 5 | Role-aware Voice | `in_progress` | ESP-SR → STT → Router/Roles → TTS | [Phase 5](./2026-08-15-agent-phase-5-voice-plan.md) |
| 6 | Role-aware Memory | `pending` | 比较共享、私有和混合记忆可见性 | [Phase 6](./2026-08-15-agent-phase-6-memory-plan.md) |
| 7 | Cat Autonomy | `pending` | Timer/HA 事件驱动、低频、可审计 Cat 行为 | [Phase 7](./2026-08-15-agent-phase-7-autonomy-plan.md) |

## 下一步

Phase 2 已于 2026-08-20 完成并通过用户最终 review。2A Role Contract & Router、2B Cat Action
Adapter、2C P4 World Service、2D Real Transport & Hardware Gate 四个纵切的退出门禁均已满足；
`phase2d_agent` 实机 run `32262619021` 的 artifact 已通过身份、100 次动作、第 50 次后重连 snapshot、
两小时 Agent 离线、资源与 8 FPS 门禁判定。Phase 2 计划已归档。

2026-08-20，用户已明确授权启动 Phase 3。3A Object Registry Contract、3B P4 Object Runtime 与
3C Cat Object Event & Role Boundary 已完成：稳定对象契约、P4 权威对象状态机、四种对象动作、
Cat-only Role 边界和显式选择的 v2 transport 均已通过门禁。3D 最终实机 run `32382940058` 已通过
manifest-first artifact 判定：动作链、重连 snapshot、取消、10 秒后设备/UI 离线释放、HA READY、
资源和 240 秒 8 FPS 均无矛盾。2026-08-20 用户最终 review 通过，Phase 3 已完成并归档；冻结的
Device Protocol v1 / Tool Schema v1 未修改。

2026-08-20，用户已明确授权启动 Phase 4，并要求先完成准备工作。Phase 4 已重构为 4A Robot HA
Contract & Credential Boundary、4B Read-only Robot HA Tool、4C Low-risk Write & HA/P4 Convergence、
4D Multi-assignment RoutePlan & Response Composer、4E Security/Eval/Real Environment Gate 五个纵切。
准备边界与 4A/4B review 已通过。4C 完成低风险写侧、unknown 不重放、恢复对账和独立 bugs review；
真实 run `32454798244` 已用专用非管理员 Robot 账号证明 P4 应用离线时 Robot 可用、在线时 Robot/P4
从 HA 回刷到一致终态，并在 Robot 关闭后保持 P4 standalone 与稳态 UI 8 FPS。4C 自动化门禁已关闭，
独立物理灯态和实际触摸输入保留给 4E。4D 已完成显式 v2 RoutePlan、UTF-16 全文分割、独立
Human/Robot Run、确定性 Response Composer、deadline/partial/deferred 语义与 SQLite 三 Run 还原，
并在多轮独立 bugs review 后以 no findings 关闭。4E 已完成四分项真实模型评测、security holdout、
Git/运行产物/SQLite/进程参数敏感审计和十一轮独立 bugs review，最终为 no findings。最终 run
`32585132074` 已通过 manifest-first 身份、flash、离线/在线 Robot、HA/P4 回刷、1800 秒长稳、post-Robot
standalone/UI 与矛盾证据判定；用户也已独立确认物理灯态变化/恢复和实际触摸。4B 真实只读门禁及
4A–4E 其余技术/真实环境门禁均已关闭。2026-08-23 用户最终 review 通过，Phase 4 已完成并归档。
用户在同一条指令中另行授权启动 Phase 5。5A 的 Voice Protocol v1 已冻结；run `32615794192`
通过 manifest-first 身份、ESP32-P4/flash hash、codec write/microphone、稳定 AFE/lease/栈/UI、真实
wake 与固定命令动作 marker。Mac 系统扬声器只替代口播输入，P4 startup tone 的独立可听人工观察
仍明确待补，不能由 `tone_played` marker 冒充。按用户要求不中断后续 coding，当前继续 5B Binary
Voice Channel & Session Lifecycle；尚未接入真实 STT/TTS。

Phase 1 的 SQLite Worker、启动恢复、Runtime 相对 timeout 与协作取消边界已经关闭。设备端
deadline、action_id 幂等和 snapshot reconciliation 已在 Phase 2 完成并通过实机证据验证。

产品角色边界已纳入 Phase 2–7：默认模型统一使用 `qwen3.8:27b-mlx`，但 Role Router、Robot、
Human、Cat 的上下文、工具、temperature、预算与 eval 独立。当前 32 场景 ToolCall 结果只作为
命令执行型专项证据，不作为整个 Agent 总分。所有 Qwen 请求统一显式传入
`think: false`，不将思考模式开关暴露给各 RoleProfile。

SQLite 的生产化延后项集中记录在
[Agent SQLite Production TODO](./2026-08-16-agent-sqlite-production-todo.md)，不与当前 Demo
正确性修复混在一起；进入 Phase 2 真实 Action 前必须重新 review 对应门禁。

## 历史入口

- [归档说明](../archive/README.md)
- [旧计划](../archive/plans/legacy/)
- [旧项目里程碑记录](../archive/records/project/project-milestones-through-m6.md)
