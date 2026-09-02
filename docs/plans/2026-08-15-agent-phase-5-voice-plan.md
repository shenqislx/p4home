# Agent Phase 5 — Role-aware Voice Pipeline Plan

> Status: `pending_real_environment`
> Started: 2026-08-23
> Current Gate: 5A–5D 技术门禁通过；commit `85b55ec` 的 `phase5e_ui` run `33452154578` 已通过
> 读、写并恢复、Human 聊天、三次终态 UI delivery、六次 applied ACK 和 artifact 审计，用户已肉眼
> 确认三轮屏幕更新；`phase5a_voice` run `33454508895` 与用户听觉共同确认 SPK/J16 startup tone。
> `phase5e_e2e` 修复提交 `d39b69b` 的 run `33456284948` 已完成四轮分角色播放和
> barge-in，用户确认功能符合要求；但旧 artifact schema 无法表达合法重试，workflow fail-closed，
> 且语音响应明显偏慢。重试守恒和低延迟候选已提交为 `e004870`；run `33460199737` 的 artifact
> 审计通过且 VAD 提前收口生效，但迟到 credit 触发重连并取消三次 STT，业务门禁失败。对应
> 首次竞态修复提交 `8b96022` 的 run `33461779715` 仍复现取消，进而确认 credit 在
> `WAITING_CLOSE` 窗口到达。覆盖 WAITING_CLOSE/刚关闭 IDLE 的修复提交 `cbd0f39` 已由 run
> `33463393866` 完成实机复验：artifact、driver/harness、四轮业务、恢复和 barge-in 全部通过，
> 端到端为 `7.55–8.16 s`。模型计时提交 `6821b24` 的最终 `phase5e_ui` run `33526540788`
> 进一步完成三轮真实 P4/STT/Qwen/HA/UI 与审计：Qwen 首轮冷加载 `10.928 s`，热态 write/chat
> 模型阶段 `2.001 s / 1.703 s`，STT `1.338–1.785 s`，UI ACK `145–247 ms`。首次响应慢的
> 主因已确认是 Qwen 冷加载；P4 wake/VAD 收口仍为 `hardware_pending`，仍待优化和长停顿句确认，
> Phase 5 不关闭。Phase 6、7 已分别完成并归档。
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 2、4 complete；P4 音频、ESP-SR model partition 与 Agent 节点可用

## 1. 目标

建立 ESP-SR wake/AFE → P4 音频上行 → STT → 统一 Role Router → Human/Robot Run →
确定性 Response Composer → 分角色 TTS → P4 播放的本地语音闭环，并在 Agent/STT/TTS 离线时保留
P4 固定离线命令、触摸、HA 与 UI 主链。

## 2. 不可变边界

1. Voice 只是新的 Interaction 输入/输出通道。STT 文本必须进入 Phase 4 已冻结的统一 Router 和
   Role Runtime，不新建“语音专用意图路由器”，也不能扩大任何 RoleProfile 的 Tool 权限；
2. Wake/AFE、固定离线命令与音频设备所有权留在 P4；通用 STT/TTS 和 Agent 推理留在局域网节点；
3. 音频数据面与 Device Protocol JSON 控制面分离并显式版本化。Phase 5 不原地修改冻结的 Device
   Protocol v1/v2、Tool Schema v1/v2 或 HA Tool contract；
4. 第一版统一采用 16 kHz、mono、signed PCM16 little-endian。frame 时长、序号、时间戳、会话状态、
   流控、丢帧和终态必须在传输前冻结，禁止依赖 WebSocket 消息边界猜测 PCM 几何；
5. P4 同一时刻只有一个录音/播放 owner。Wake、上行、TTS、自检和固定命令必须经过显式仲裁；
6. 原始音频默认只在内存中短暂处理，不写 SQLite、日志、Git 或 CI artifact；诊断留存必须显式 opt-in、
   限定时长、说明用途并可删除；
7. VAD end-of-speech、STT/TTS timeout、断线、取消和 barge-in 均使用显式终态；过期 session 的迟到
   transcript/audio 必须丢弃；
8. barge-in 先停止本地播放并关闭旧输出 epoch，再取消当前 voice Interaction 的 Human/Robot Run 和
   全部低优先级 Cat Run；已发送的 Robot 写请求沿用 Phase 4 `unknown`/reconciliation 语义；
9. Agent/STT/TTS 离线不得破坏固定离线命令、P4 ↔ HA、触摸、Cat fallback 或稳态 UI 8 FPS；
10. Cat 不接收用户原始音频、STT 原文或 voice session；Cat 发声不在本 Phase 偷渡。
11. Voice UI 是独立的只读呈现通道，不复用 Cat 的 `character.say`，不修改 World 语义真值，也不
    允许 UI 文本反向创建 ToolCall；所有 update 必须绑定活动 capture 的 session/stream/epoch，旧
    epoch 和回退 revision 必须拒绝；
12. 扬声器缺失时，`role_execution` 与 `ui_delivery` 是无扬声器闭环的阻断项，
    `audio_delivery=deferred` 不是失败。HA/Robot 终态、UI 投递和音频投递必须分别记录，任何一个
    通道都不能改写另一个通道的事实。

## 3. 启动准备（已完成）

- [x] 确认 Phase 4 技术/真实环境门禁和用户最终 review 均通过，并归档 Phase 4 计划；
- [x] 盘点 `audio_service`、`sr_service`、`agent_transport`、Router/Orchestrator/Composer 与硬件 workflow；
- [x] 把原始串行清单拆成 5A–5E 五个可独立 review 的纵切；
- [x] 冻结 PCM、数据面隔离、音频所有权、迟到数据、barge-in、音频保留和角色隔离原则；
- [x] 记录准备证据：[Phase 5 Preparation](../../evidence/agent-phase-5/phase-5-preparation.md)。

准备阶段没有打开默认 SR/音频自检、没有监听新端口、没有安装 STT/TTS Provider，也没有录制、
上传或持久化任何真实音频。

## 4. 纵切 5A — Audio/ESP-SR Baseline & Voice Contract

- [x] 在独立配置中恢复 `audio_service` 与 `sr_service`，验证 codec、麦克风采集、AFE feed/fetch、
  WakeNet、MultiNet 固定离线命令和播放路径；默认配置保持关闭，直到实机门禁通过；
- [x] 冻结 Voice Protocol v1 控制状态机和二进制 frame header：session/stream/epoch、单调 sequence、
  capture timestamp、PCM geometry、EOS/cancel/error 与有界 credit/window；
- [x] 把音频 owner 从借用字符串升级为可验证的枚举 lease/generation，覆盖 open/close 失败、任务退出、
  重复释放和 owner 抢占；
- [x] 建立 P4 host contract/fake 测试，覆盖 PCM 几何、frame 顺序、丢帧、过期 epoch、所有权竞争和
  固定命令优先级；本纵切不连接真实 STT/TTS；
- [x] 通过专用 P4 profile 验证真实非零 PCM、AFE 持续 feed/fetch、真实 wake、固定离线命令、speaker
  播放、资源/栈/看门狗和 UI 8 FPS；人工听觉或口令观察与自动 marker 分开报告。
  - [x] manifest、P4/flash、codec write、麦克风、AFE、wake、固定命令动作、资源/栈/看门狗与 UI；
  - [x] P4 startup tone 的独立可听人工观察：2026-09-01 `phase5a_voice` run `33454508895` 的同一
    唯一开机周期内，串口 `VERIFY:audio:tone_played:PASS`，用户从接在 `SPK/J16` 两端的外接扬声器
    明确听到提示音；数字 marker 与人工听觉分层成立。

退出门禁：Voice Protocol v1 与 PCM/所有权边界冻结；真实 P4 可稳定 wake、采集、AFE、固定命令和
播放，默认配置不受影响；尚未向 Agent 节点传输音频。

## 5. 纵切 5B — Binary Voice Channel & Session Lifecycle

只有 5A review 通过后开始：

- [x] 实现独立于 Device JSON 的受认证二进制 Voice channel；复用设备身份，但连接、backpressure、
  消息大小、速率和并发上限独立；
- [x] P4 只在 wake 后创建有界 capture session，按 credit 上行 AFE PCM；Agent 明确 ack、EOS、cancel
  与 terminal error，不能无限缓存；
- [x] 实现断线、重连和 epoch fencing，旧连接、旧 session 或迟到 frame 不能污染新 Interaction；
- [x] Agent 离线、慢消费者或帧洪水时快速释放音频 owner，恢复 WakeNet 与固定离线命令；
- [x] 建立 loopback/fake transport 与真实 LAN 吞吐、抖动、丢帧和恢复测试，仍使用 fake STT/TTS。

证据：[Phase 5B Binary Voice Channel](../../evidence/agent-phase-5/phase-5b-binary-voice-channel.md)。
最终 run `32627837273` 证明真实 P4 PCM 有界抵达 Agent fake sink、丢帧 0，并在 HA READY、固定命令
和稳态 UI 主链同时运行时保持无 crash；32 条 UI PASS 与 HA 冷启动 burst 的 1 条瞬态 FAIL 分开披露。

退出门禁：真实 P4 PCM 可在有界内存内抵达 Agent fake sink；断线、慢端和迟到帧可恢复且不串 session；
Device JSON、HA、触摸、固定命令和 UI 主链不回归。

## 6. 纵切 5C — STT, VAD & Unified Role Runtime

只有 5B review 通过后开始：

- [x] 以独立固定 Python 3.11/3.12 环境或容器接入版本锁定的 STT Provider，不复用 ESP-IDF Python；
- [x] 定义 VAD end-of-speech、最短/最长 utterance、静音、噪声、STT timeout、空 transcript、语言和
  provider error 的确定性状态与指标；
- [x] 只有活动 session 的 final transcript 可创建 Voice Interaction；partial transcript 只用于 UI，
  不进入 Router、SQLite role history 或 Tool Runtime；
- [x] final transcript 原样进入 Phase 4 统一 Router/Orchestrator，继续执行 UTF-16 span、Human/Robot
  会话隔离、Robot policy 和确定性 Composer；Cat 不获得 transcript；
- [x] 分别评测 wake/VAD、STT、Router span、Human、Robot ToolCall/policy 和 Composer，不生成综合分。

证据：[Phase 5C STT & Unified Role Runtime](../../evidence/agent-phase-5/phase-5c-stt-unified-runtime.md)。
最终 run `32635742553` 证明 Mac 扬声器输入的现场中文经真实 P4 PCM/VAD/固定 MLX STT 后，只通过
统一 Human Runtime 创建审计完整的 Run；预期 transcript 哈希匹配、Cat history 为 0、原始音频未
保留。54 条 UI PASS 与 HA 冷启动 burst 的 1 条瞬态 FAIL 分开披露，480 秒内只有预期烧录后上电。

退出门禁：预录和现场语音只能通过统一文本入口创建审计完整的 Human/Robot Run；空白、迟到、重复
或错误 session transcript 零执行；STT 离线不生成猜测性文本或 ToolCall。

## 7. 纵切 5D — Role-aware TTS, Playback & Barge-in

只有 5C review 通过后开始：

- [x] 接入版本锁定的 TTS Provider，冻结输出 PCM 几何和 chunk/session/epoch 契约；
- [x] TTS 只消费 Composer 结构化输出：Human 表达和 Robot 真实执行结果保持分段、顺序与可辨识
  voice/style，不能互相覆盖或让 Human 文本伪造 Robot 完成；
- [x] P4 实现有界播放队列、underrun/overrun 指标、过期 chunk 拒绝和播放终态；播放失败不回写成
  Agent/HA 执行失败；
- [x] 实现 barge-in 原子 fencing：停止旧播放、创建新 capture epoch、取消旧 voice Run/低优先 Cat，
  并保持已发 Robot 写侧的 unknown/reconciliation；
- [x] 覆盖播放期间唤醒、网络断开、TTS timeout、迟到音频、连续打断、取消竞态和重连。

证据：[Phase 5D Role-aware TTS, Playback & Barge-in](../../evidence/agent-phase-5/phase-5d-role-aware-playback.md)。
5D-A/5D-B/5D-C 分别由 `c353d9d`、`cd03437`、`eb8a827` 落地；最终 Agent 全量 319/319、
5D orchestration 14/14、ESP32-P4 clean temp build 与逐批独立 bugs review 均通过。真实 P4 板载
扬声器可听观察及完整端到端长跑仍归 5E 总门禁，Mac 系统扬声器不得替代该输出证明。

退出门禁：Human/Robot 组合响应按确定性顺序播放；barge-in 不播放旧音频、不串 role/session，也不
伪造或重放 Robot 副作用。

## 8. 纵切 5E — Security, Eval & Real Hardware Gate

只有 5D review 通过后开始：

进行中证据：[Phase 5E Conversation UI Speakerless Closure](../../evidence/agent-phase-5/phase-5e-conversation-ui-speakerless.md)。

- [ ] 加入认证绕过、frame 洪水、超长会话、序号回退、旧 epoch、恶意 transcript、TTS 注入、
  provider 离线/慢响应、P4/HA/Agent 任一断线和进程恢复 holdout；
  - [x] 本地自动化覆盖认证单值/攻击后恢复、frame/session/epoch、恶意 transcript 的
    Router/Role/UI 隔离、TTS 有界输入、provider timeout/abort 恢复，以及 Agent 真实子进程
    crash/restart 后下一轮合法会话；
  - [ ] 真实 P4 网络丢失、HA 服务重启与状态对账、launchd KeepAlive 和 P4 感知 Agent 重连（延期）；
- [ ] 核对 Git、日志、SQLite、进程参数和 CI artifact 不含 token 或非 opt-in 原始音频；
  - [x] 本地 scanner/harness 覆盖 Git objects、process argv、SQLite、上传候选、最终 manifest、token、
    TLS 私钥、raw audio、symlink/权限及审计失败不上传；
  - [x] 当前候选 run `33452154578` 的最终 workflow artifact 审计通过，凭据、原始音频、Git source
    archive 和 process argv 均满足门禁；
- [ ] 分别报告 wake/VAD/STT/Router/Human/Robot/Composer/TTS/播放和端到端延迟、丢帧、取消指标；
  - [x] `VoiceInteractionResult` schema v2 与 Phase 5E artifact schema v2 固定 11 个阶段，并将 Agent
    可测耗时、角色/UI/播放状态和 drop/cancel 与业务真值交叉校验；
  - [x] Human 产品链路支持 Ollama NDJSON 增量文本、有界中文分段、常驻 Kokoro、增量 PCM 和
    P4 credit 驱动播放；产品 readiness 前执行无 session/audit 的真实 Qwen warmup，并以
    `keep_alive=10m` 在最后一次请求后保温 10 分钟，闲置超时后允许 Ollama 自动释放约
    `22–25 GB` 模型内存。本地类型检查、497 项全量测试与真实 Kokoro 流式测试通过，安全前缀的
    失败/取消 result、audit、session 一致性及非合作流取消均有回归覆盖；热态无 P4 播放测得首个
    安全句段约 `562 ms`、首个 PCM 约 `842 ms`、模型/TTS 流终态约 `1.069 s`；
  - [ ] 真实 P4 复验首声延迟、句间连续听感和 barge-in；Kokoro 当前是 clause 级生成，不宣称
    神经声学模型逐帧生成；
  - [ ] P4 wake/VAD/实体播放继续显式 `hardware_pending`，待真实 run 提供可信硬件时序；
- [ ] 在真实 P4 + Agent + HA 完成本地唤醒到一次只读和一次隔离低风险家控语音闭环，并核对 HA
  result/state change、P4 回刷、分角色播放和审计关联；
- [ ] 验证 barge-in、超时、断线、Agent/STT/TTS 离线恢复，以及长跑期间固定命令、触摸、P4 ↔ HA、
  Cat fallback、资源/栈/看门狗和 UI 8 FPS；人工观察不得用自动 marker 冒充。
  - [x] 本地独立子进程完成 1000-session 确定性 soak，覆盖 offline/cancel/timeout/hang/abort 后恢复，
    并验证端口、maps、results、listener、PCM、heap、event-loop 与 open handles 有界；
  - [ ] 真实 P4/HA/Agent 长跑、heap/stack/watchdog、固定命令/触摸/HA/Cat/UI 连续性（延期）；
- [x] 冻结独立的 Conversation UI Protocol v1：Agent 只能下发有界、已组合的展示文本和结构化
  execution status；P4 必须以 active epoch/revision fencing 接受，并在 LVGL 对话框显示用户 final
  transcript 与 Human/Robot 结果；不得借用 Cat `character.say`；
- [x] 增加常驻产品组装入口，接入真实 Ollama、STT、统一 Router、Robot HA、private Memory、UI，
  并允许在无扬声器 profile 中显式禁用 TTS/playback；测试/硬件 harness 不能冒充常驻入口；
- [x] 增加默认 Human-only 的常驻装配与 `product_human` 固件 profile；该模式不读取 HA 凭据、不构造
  Robot HA 客户端，Robot/混合路由 fail-closed 为 Human 澄清，并以稳定私有 identity 取代 workflow
  临时凭据；真人手动聊天、重启恢复和 UI 肉眼观察仍待部署后验证；
- [x] 在无扬声器条件下先完成真实 P4 的聊天、HA 只读、低风险写入/恢复三条路径，要求
  `role_execution=completed`、`ui_delivery=completed`，并把 `audio_delivery=deferred` 单独披露；
  串口 `VERIFY:`、Agent/SQLite 审计、HA state_changed 与用户可见 UI 观察必须相互一致。
  - [x] 独立 `phase5e_ui` workflow profile、真实模型/HA/STT harness、一次性写入恢复、UI ACK、
    speakerless input driver、artifact 隐私审计和 manifest 字段已实现并通过本地静态/单元门禁；
  - [x] 历史 commit `3edb229` 的 run `32862092039` 已按 manifest-first 协议判定：真实模型/HA/STT、
    读/写/恢复/聊天、三次终态 UI delivery、隐私审计均通过，`audio_delivery=deferred` 且没有打开
    playback；
    该 run 不覆盖其后的 Voice 产品改动，也不替代用户肉眼观察；
  - [x] 当前候选 commit `85b55ec` 的 run `33452154578` 已按 manifest-first 协议判定通过：ESP32-P4
    revision v1.0、flash image hash、transport、读/写恢复/聊天、三次终态 UI delivery、六次 applied
    ACK、隐私审计及终态一致；5 次瞬态 UI 8 FPS FAIL 后累计 119 次 PASS，且无 crash；
  - [x] 用户已核对 P4 对话框三轮可见文本，确认每轮均从处理中更新到最终内容；该人工观察不由
    串口 marker 代替；
  - [x] 同一 LVGL/RGB565 host renderer 的 48 帧雨态预览已由用户确认形成连续降雨观感，不再是
    上下两处闪烁；该人工结论不外推为 P4 面板摄像证明。
  - [ ] `phase5e_e2e` 修复提交 `d39b69b` 的 run `33456284948` 中 audio driver/harness 均为 `0`，
    四轮分角色播放、写入恢复和 barge-in 业务终态均 PASS，用户确认功能符合要求；但
    `stt_calls=8 / capture_attempts=9` 的合法有界重试无法被旧 result schema 守恒，artifact audit
    以 `result_schema` fail-closed。同时首轮约 `40.6 s`、热态约 `8.47 s`，用户确认响应明显偏慢。
    候选修复增加重试分类守恒、ready 前顺序预热，并在语音后 `800 ms` 静音时提前收口；已完成
    独立 review。commit `e004870` 的 run `33460199737` 已确认 artifact audit `pass` 与 VAD
    `vad_silence` 提前收口，但三次 read STT 均因正常 EOS 后迟到 credit 引发的重连而被取消，
    audio driver/harness 均为 `1`。首次窄化修复提交 `8b96022` 的 run `33461779715` 再次出现三次
    STT cancelled，正式 artifact 审计仍为 `pass`；精确时序证明 pre-EOS credit 在固件已进入
    `WAITING_CLOSE`、但尚未处理 `session.closed` 时到达。覆盖 WAITING_CLOSE/刚关闭 IDLE 的策略
    已经独立 review 与原生 C 状态矩阵验证。提交 `cbd0f39` 的 run `33463393866` 中 workflow、
    artifact audit、audio driver/harness、四轮业务、恢复和 barge-in 均 PASS，STT/TTS 各 4 次且无
    重试；capture-open 到 playback-open 为 `7.66 / 7.55 / 8.16 / 7.86 s`。仍须用户确认实际体感
    可接受，并用人工长停顿句排除 `800 ms` 静音误截断。

2026-08-28 本地修复把 HA 初始同步 readiness 从 `voice_transport` 具体依赖改为由
`board_support` 注入的通用 fail-closed probe，保持“HA 未就绪时只显示连接提示且不开始
capture/STT/LLM”的产品语义；同时把 5A 源码格式契约改为对空白不敏感。独立源码 review 无阻塞
问题，完整本地门禁结果记录在上述证据文件中。这些结果不将真实 P4 或人工门禁标记为通过。

同日后续本地门禁补齐 metrics schema v2、对抗性认证/文本边界、真实 Agent 子进程重启和
1000-session soak；交叉 review 修复 Router fallback 指标失真，并撤回会误杀合法朗读内容的
“完整 JSON 文本即 TTS 注入”规则。P4 专属阶段保持 `hardware_pending`，本地结果不替代真实环境。

2026-08-31 诊断 run `33343736267` 暴露 Agent 进度发布竞态：coordinator 结果可能先于 pipeline
终态可见，导致输入驱动误读上一轮终态。commit `c9acbf8` 改为从同一个 settled pipeline snapshot
原子计算完成数/尝试数，并要求三轮进度与输入驱动显式 status `0` 同时成立；源码修复经独立 review
从发现提前退出 blocker 到复核 no blocker，本地 Agent 444/444、harness 64/64、contract 110/110
与目标测试 4/4 均通过。

最新 `phase5e_ui` run `33452154578` 通过自动化门禁；其 result 对 STT mismatch/provider failure
做严格守恒，三轮 role/UI delivery 完成且音频 deferred，用户另行完成 P4 屏幕肉眼确认。独立
`phase5a_voice` run `33454508895` 与用户听觉完成 startup tone 物理确认。另一方面，
`phase5e_e2e` run `33456284948` 已有完整业务 result 和人工播放/barge-in PASS，但其 artifact
审计因旧 schema 不支持合法重试而失败，且用户不接受当前明显偏慢的响应速度。因此 Phase 5
状态暂不关闭。`e004870` 的首次复验 `33460199737` 已让 artifact 审计和 VAD 提前收口成立，
但暴露 terminal credit 导致重连/STT 取消的固件竞态。首次修复 run `33461779715` 证明只覆盖
关闭后 IDLE 不足，实际窗口是 `WAITING_CLOSE`；补充修复 run `33463393866` 已通过自动化实机
闭环。Phase 5 当前只剩响应体感与长停顿句人工确认。详见
[2026-09-01 manual hardware validation](../../evidence/agent-phase-5/phase-5-manual-hardware-validation-2026-09-01.md)。

退出门禁：所有 5A–5E 技术门禁与真实环境证据通过，再交由用户最终 review。workflow 绿色只证明
构建/烧录/采集/上传链完成；必须先核对 manifest，再用原始 `VERIFY:` marker、音频指标、HA/Agent
审计和人工观察分别判定功能。

## 9. 完成定义

- [ ] 本地唤醒到 Human 对话与 Robot 家控闭环稳定完成；
- [x] 无扬声器时，final transcript 与确定性 Composer 结果可在 P4 UI 对话框显示；UI 投递失败不
  冒充 HA/Role 执行失败，Role 执行成功也不冒充 UI 已显示；
- [ ] Router、上下文、Tool 权限、Composer 文本和 TTS 播放不串角色；
- [ ] barge-in、timeout、断线、迟到数据和进程恢复均有确定性终态；
- [ ] Agent/STT/TTS 离线不破坏固定命令、触摸、P4 ↔ HA、Cat fallback 与 UI；
- [ ] 原始音频和凭证满足最小保留与敏感审计边界；
- [ ] 用户最终 review 通过，Phase 5 关闭；
- [x] Phase 6、7 已经各自获得授权、完成并归档；其结果不自动关闭 Phase 5，也不授权新的 Phase。
