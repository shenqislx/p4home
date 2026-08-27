# P4 Home 当前里程碑

> Updated: 2026-08-27
> Current Architecture: [P4 Local Agent Architecture](./p4-local-agent-architecture.md)
> Active Work: [Agent Phase Plans](./plans/README.md)

## 1. 当前结论

项目当前工作重点切换为 M7：本地语音、LLM 与 Agent Runtime。

- M0–M5 已形成固件、显示、触摸、音频/ESP-SR 骨架、HA 读侧和 UI 基线；
- M6 已实现 HA `call_service` 与主要控制 UI；2026-08-15 已恢复 P4 串口、Wi-Fi、HA READY 与
  `state_changed` 接收，并完成书房吸顶灯的隔离实机闭环；更广泛的米家设备覆盖仍作为
  Phase 2 前需明确边界的延期项；
- M7.0 候选提交 `b0aa443` 已通过 7,200 秒 HA + Pixel Home 实机稳定性回归，workflow、artifact
  完整性与功能判定均通过；
- 旧里程碑全文已归档到 [project-milestones-through-m6.md](./archive/records/project/project-milestones-through-m6.md)。

## 2. M7 分阶段里程碑

| Milestone | 状态 | 退出结果 |
|---|---|---|
| M7.0 Baseline & Contract | `completed` | 可重复构建、实机资源基线、冻结协议 v1、Mock 合约测试 |
| M7.1 Text Agent Runtime | `completed` | Ollama + 有限 Tool Loop + SQLite + eval |
| M7.2 Role Runtime & Cat World | `completed` | Role Router、三角色隔离、Cat 房间动作闭环 |
| M7.3 Cat Object World | `completed` | sofa/window/desk 等 Cat 对象级动作，实机门禁与最终 review 已通过 |
| M7.4 Robot HA & Multi-role | `completed` | 4A–4E 技术/真实环境门禁及用户最终 review 已通过 |
| M7.5 Role-aware Voice | `pending_real_environment` | 5A–5D 技术主体完成；5E 实机总门禁与 P4 可听观察待补 |
| M7.6 Role-aware Memory | `completed` | 最终 review 通过；6F/6G/6H Cat 与 6I 已通过，其余真实门禁由用户接受延期 |
| M7.7 Cat Autonomy | `completed` | 7A–7C 技术/实机门禁及用户最终 review 已通过 |

M7.6 的稳定本地结论是：Memory contract/SQLite、确定性写入/冲突/删除、private 产品召回、三种
visibility evaluator 和 `pnpm gate:phase6` 已通过；2026-08-24 用户已批准 matrix v1 保持
`private`，三类 Memory 均为 owner-role private，`shared_acl/hybrid` 仍为 evaluator-only，未启用
跨角色产品召回。6H P4 Cat + Memory run `32819132030` 已证明旧 Memory 仅作 untrusted data，P4
Object snapshot 保持 World 真值，artifact 隐私审计通过。6I APFS 权限、WAL/NORMAL、受控进程终止、
完整性/损坏拒绝、在线/冷备份与 DB/WAL/index quota 和分类 retention 已通过；revision 1 采用
128/256/256 MiB 和 30/14/7、365/180/30、90/60/30 天矩阵。代表性家庭数据、Voice + Memory、
真实断电、加密/secure-delete 和家庭身份模型于 2026-08-25 经用户决定延期，保持未验证。
[visibility matrix](../evidence/agent-phase-6/visibility-matrix.md)
用户裁决已完成。2026-08-25 用户最终 review 通过、接受上述延期并关闭 M7.6/Phase 6；延期项仍未
验证。这不改变 M7.5 `pending_real_environment`；Vector DB 仍不立项。M7.7 已于 2026-08-26 获得
授权并推进，当前状态见上表。旧 run `33056257943` 的隐私 artifact 已因 entity 残留删除并作废；
修复提交 `e8de907` 对应 run `33061620203` 已通过真实模型、只读 HA 快照、P4 动作/重连、Agent 与
P4 各自零 `call_service` dispatch、终态后心跳和 artifact 隐私门禁。该零计数不覆盖其他 HA 客户端
或 HA 服务端全局写入。2026-08-27 用户最终 review 通过，M7.7 / Phase 7 已完成并归档。

2026-08-24 补充门禁：真实 `qwen3.6:35b-mlx` 在脱敏合成 Memory 上的 grounded
recall/prompt-injection/private 隔离已通过；真实 HA 只读门禁也证明 Memory 不覆盖
HA 真值且无 service call，结果已从干净工作树复跑并绑定提交；6I 文件系统子门禁也已从干净
工作树复跑通过，production-policy 刷新证据绑定提交 `899b746`；其余项已明确延期。

## 3. M6 遗留裁决

| 项目 | 2026-08-15 状态 | 处理 |
|---|---|---|
| HAOS 服务 | `reachable` | `192.168.71.4:8123` TCP 成功、HTTP 200 |
| P4 串口 | `available` | `/dev/cu.usbserial-210`，已完成多轮烧录与原始串口采集 |
| P4 网络与 HA | `ready` | DHCP 地址 `192.168.110.87`，HA 首次同步完成且持续接收事件 |
| 真实灯具点击与状态回刷 | `passed` | 书房吸顶灯隔离回归完成：初始灭、单次 `turn_on`、用户确认已亮，计数差对应 1 条受跟踪实体回刷 |
| 米家闭环 | `deferred` | 代表性小米灯具已通过；更广泛设备覆盖不移出范围，Phase 2 前维持独立债务裁决 |

代表性真实灯具的 M6 控制闭环已经通过；这不等于所有米家设备均已验收。Phase 2 若涉及
更广泛设备覆盖，仍须维持独立验证边界，不得在未隔离风险时同时改动 HA 主链和新的
Agent WebSocket。

## 4. 下一阶段入口

[Phase 2 归档计划](./archive/plans/agent/2026-08-15-agent-phase-2-p4-room-world-plan.md) 于 2026-08-17 重新设计为
2A–2D 四个纵切。2A Role Contract & Router 的 Role Contract、三个 RoleProfile、Cat
原文隔离、fail-closed Router、独立 Session、Human/Robot 入口、有界调度与路由审计已落地并通过
92 项确定性测试。2026-08-18 review 修复后，Human 文本策略、本地 eval gate、Session 串行、模型
轮次审计、SQLite schema v2 关联索引和统一 Role 组合入口均有回归覆盖；四角色两轮 v2 eval 分别为
Router 24/24、Human 8/8、Robot 8/8、Cat 18/18，且无综合分。2A、2B、2C 已依次满足退出门禁。
2026-08-20，2D 真实 WSS 软件链、P4 `agent_transport` 与硬件 harness 已通过软件回归和
Agent-enabled 固件构建；实机 run `32262619021` 的 100 次动作、重连 snapshot、两小时 Agent 离线、
资源与 8 FPS artifact 判定均通过。2A–2D 退出门禁已满足；2026-08-20 用户最终 review 通过，
Phase 2 / M7.2 已完成并归档。2026-08-20，用户明确授权启动 M7.3 / Phase 3；3A Object Registry
Contract、3B P4 Object Runtime 与 3C Cat Object Event & Role Boundary 门禁已通过。3D 最终实机
run `32382940058` 已通过 manifest、对象动作链、重连 snapshot、取消、Agent 离线释放、HA/UI、资源
与 240 秒 8 FPS artifact 判定。2026-08-20 用户最终 review 通过，Phase 3 / M7.3 已完成并归档；
对象执行 Tool 仅加入 Cat RoleProfile。2026-08-20，用户明确授权启动 M7.4 / Phase 4 并先做准备；
4A–4E 的独立门禁、Robot/P4 凭证隔离、HA 写侧 unknown 语义和多角色 span 边界已冻结。准备 review
通过后，4A 已完成版本化 contract、凭证文件边界、allowlist 状态投影、Fake/回环 transport 和安全
审计的本地门禁并通过 review。4B 已完成只读 `home.get_entity(alias)`、确定性状态呈现、跨角色隔离与
SQLite 关联审计的 coding 与独立 bugs review；review 发现的旧库迁移、断线竞态、拒绝审计、运行期
投影校验问题均已关闭。4C 已完成固定低风险写映射、result/observation 收敛与 unknown 不重放的核心
coding 和独立 bugs review（含单次只读 reconciliation）。真实 run `32454798244` 已用 Robot 专用
非管理员账号完成 P4 离线/在线两次隔离低风险切换与恢复，P4 目标回刷、standalone、post-Robot
稳态 UI 8 FPS、artifact 脱敏和无 watchdog 均通过专用门禁。4D 已完成多 assignment、UTF-16 span
隔离和确定性 Composer；4E 完成四分项真实模型评测与敏感审计。最终 run `32585132074` 绑定经复审的
Phase 4C timing fix commit，通过 P4 离线/在线 Robot、HA/P4 回刷、1800 秒长稳和 post-Robot
standalone/UI 门禁；用户也独立确认物理灯态变化/恢复与实际触摸。M7.4 的技术与真实环境门禁均已关闭。
2026-08-23 用户最终 review 通过，Phase 4 / M7.4 已完成并归档；用户在同一条指令中另行授权启动
M7.5 / Phase 5。Phase 5 已拆分为 5A 音频/ESP-SR 基线与 Voice contract、5B 二进制通道、5C
STT/统一 Router、5D 分角色 TTS/barge-in、5E 安全/评测/实机总门禁。5A 的协议/自动化硬件、真实
wake 与固定命令动作已通过。5B 最终 run `32627837273` 证明真实 P4 PCM 有界抵达 Agent fake sink、
丢帧 0，并保持 HA、固定命令与稳态 UI 主链；独立 review 后 5B 技术门禁关闭。5C 最终 run
`32635742553` 已证明现场中文经真实 P4/VAD/固定 MLX STT 后只进入统一 Human Runtime，审计完整、
Cat 零泄漏且不保留原始音频；独立 review 后技术门禁关闭。5D 已完成固定 Kokoro TTS、分角色
Composer 消费、有界 P4 playback、统一语音 assembly 与 barge-in/Cat cancellation，最终全量
319/319 且第五轮 closure review 为 no findings；当前进入 5E 安全/评测/实机总门禁。P4 可听
startup tone 与分角色播放人工观察仍明确待补，默认 SR 仍关闭。

2026-08-24，Phase 6A–6D 依次完成 Memory Store、写入/冲突/删除策略、private 产品召回和三策略
确定性 visibility 对照；6E 新增可重复 `pnpm gate:phase6` 并在 Node `v24.19.0` / pnpm `11.19.0`
下通过。定向结果为 6B/6C `20/20`、evaluator `15/15`、storage `43/43`；完整 `pnpm test`
为 `383/389`，5 个既有 Phase 4 timing/socket 失败经隔离复跑最终 `43/43`，既有 WSL Voice
仍为 `14/15`、`socket hang up`。用户同日批准 visibility matrix v1 保持 private；因此 M7.6
标记为 `local_complete_pending_real_environment`：本地门禁和用户裁决完成不等于全仓库测试、
真实模型、硬件或生产验收通过。

## 5. 状态更新规则

- 具体 checkbox 和证据写入 Phase plan；
- 本文件只记录 Phase 状态和退出结果；
- 一个 Phase 未通过退出门禁，下一 Phase 不得改为 `in_progress`；
- Phase 完成后先 review，再归档计划并更新本文件。
