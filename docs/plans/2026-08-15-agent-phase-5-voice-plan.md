# Agent Phase 5 — Role-aware Voice Pipeline Plan

> Status: `in_progress`
> Started: 2026-08-23
> Current Gate: 启动准备已完成；进入 5A Audio/ESP-SR Baseline & Voice Contract
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

## 3. 启动准备（已完成）

- [x] 确认 Phase 4 技术/真实环境门禁和用户最终 review 均通过，并归档 Phase 4 计划；
- [x] 盘点 `audio_service`、`sr_service`、`agent_transport`、Router/Orchestrator/Composer 与硬件 workflow；
- [x] 把原始串行清单拆成 5A–5E 五个可独立 review 的纵切；
- [x] 冻结 PCM、数据面隔离、音频所有权、迟到数据、barge-in、音频保留和角色隔离原则；
- [x] 记录准备证据：[Phase 5 Preparation](../../evidence/agent-phase-5/phase-5-preparation.md)。

准备阶段没有打开默认 SR/音频自检、没有监听新端口、没有安装 STT/TTS Provider，也没有录制、
上传或持久化任何真实音频。

## 4. 纵切 5A — Audio/ESP-SR Baseline & Voice Contract

- [ ] 在独立配置中恢复 `audio_service` 与 `sr_service`，验证 codec、麦克风采集、AFE feed/fetch、
  WakeNet、MultiNet 固定离线命令和播放路径；默认配置保持关闭，直到实机门禁通过；
- [ ] 冻结 Voice Protocol v1 控制状态机和二进制 frame header：session/stream/epoch、单调 sequence、
  capture timestamp、PCM geometry、EOS/cancel/error 与有界 credit/window；
- [ ] 把音频 owner 从借用字符串升级为可验证的枚举 lease/generation，覆盖 open/close 失败、任务退出、
  重复释放和 owner 抢占；
- [ ] 建立 P4 host contract/fake 测试，覆盖 PCM 几何、frame 顺序、丢帧、过期 epoch、所有权竞争和
  固定命令优先级；本纵切不连接真实 STT/TTS；
- [ ] 通过专用 P4 profile 验证真实非零 PCM、AFE 持续 feed/fetch、真实 wake、固定离线命令、speaker
  播放、资源/栈/看门狗和 UI 8 FPS；人工听觉或口令观察与自动 marker 分开报告。

退出门禁：Voice Protocol v1 与 PCM/所有权边界冻结；真实 P4 可稳定 wake、采集、AFE、固定命令和
播放，默认配置不受影响；尚未向 Agent 节点传输音频。

## 5. 纵切 5B — Binary Voice Channel & Session Lifecycle

只有 5A review 通过后开始：

- [ ] 实现独立于 Device JSON 的受认证二进制 Voice channel；复用设备身份，但连接、backpressure、
  消息大小、速率和并发上限独立；
- [ ] P4 只在 wake 后创建有界 capture session，按 credit 上行 AFE PCM；Agent 明确 ack、EOS、cancel
  与 terminal error，不能无限缓存；
- [ ] 实现断线、重连和 epoch fencing，旧连接、旧 session 或迟到 frame 不能污染新 Interaction；
- [ ] Agent 离线、慢消费者或帧洪水时快速释放音频 owner，恢复 WakeNet 与固定离线命令；
- [ ] 建立 loopback/fake transport 与真实 LAN 吞吐、抖动、丢帧和恢复测试，仍使用 fake STT/TTS。

退出门禁：真实 P4 PCM 可在有界内存内抵达 Agent fake sink；断线、慢端和迟到帧可恢复且不串 session；
Device JSON、HA、触摸、固定命令和 UI 主链不回归。

## 6. 纵切 5C — STT, VAD & Unified Role Runtime

只有 5B review 通过后开始：

- [ ] 以独立固定 Python 3.11/3.12 环境或容器接入版本锁定的 STT Provider，不复用 ESP-IDF Python；
- [ ] 定义 VAD end-of-speech、最短/最长 utterance、静音、噪声、STT timeout、空 transcript、语言和
  provider error 的确定性状态与指标；
- [ ] 只有活动 session 的 final transcript 可创建 Voice Interaction；partial transcript 只用于 UI，
  不进入 Router、SQLite role history 或 Tool Runtime；
- [ ] final transcript 原样进入 Phase 4 统一 Router/Orchestrator，继续执行 UTF-16 span、Human/Robot
  会话隔离、Robot policy 和确定性 Composer；Cat 不获得 transcript；
- [ ] 分别评测 wake/VAD、STT、Router span、Human、Robot ToolCall/policy 和 Composer，不生成综合分。

退出门禁：预录和现场语音只能通过统一文本入口创建审计完整的 Human/Robot Run；空白、迟到、重复
或错误 session transcript 零执行；STT 离线不生成猜测性文本或 ToolCall。

## 7. 纵切 5D — Role-aware TTS, Playback & Barge-in

只有 5C review 通过后开始：

- [ ] 接入版本锁定的 TTS Provider，冻结输出 PCM 几何和 chunk/session/epoch 契约；
- [ ] TTS 只消费 Composer 结构化输出：Human 表达和 Robot 真实执行结果保持分段、顺序与可辨识
  voice/style，不能互相覆盖或让 Human 文本伪造 Robot 完成；
- [ ] P4 实现有界播放队列、underrun/overrun 指标、过期 chunk 拒绝和播放终态；播放失败不回写成
  Agent/HA 执行失败；
- [ ] 实现 barge-in 原子 fencing：停止旧播放、创建新 capture epoch、取消旧 voice Run/低优先 Cat，
  并保持已发 Robot 写侧的 unknown/reconciliation；
- [ ] 覆盖播放期间唤醒、网络断开、TTS timeout、迟到音频、连续打断、取消竞态和重连。

退出门禁：Human/Robot 组合响应按确定性顺序播放；barge-in 不播放旧音频、不串 role/session，也不
伪造或重放 Robot 副作用。

## 8. 纵切 5E — Security, Eval & Real Hardware Gate

只有 5D review 通过后开始：

- [ ] 加入认证绕过、frame 洪水、超长会话、序号回退、旧 epoch、恶意 transcript、TTS 注入、
  provider 离线/慢响应、P4/HA/Agent 任一断线和进程恢复 holdout；
- [ ] 核对 Git、日志、SQLite、进程参数和 CI artifact 不含 token 或非 opt-in 原始音频；
- [ ] 分别报告 wake/VAD/STT/Router/Human/Robot/Composer/TTS/播放和端到端延迟、丢帧、取消指标；
- [ ] 在真实 P4 + Agent + HA 完成本地唤醒到一次只读和一次隔离低风险家控语音闭环，并核对 HA
  result/state change、P4 回刷、分角色播放和审计关联；
- [ ] 验证 barge-in、超时、断线、Agent/STT/TTS 离线恢复，以及长跑期间固定命令、触摸、P4 ↔ HA、
  Cat fallback、资源/栈/看门狗和 UI 8 FPS；人工观察不得用自动 marker 冒充。

退出门禁：所有 5A–5E 技术门禁与真实环境证据通过，再交由用户最终 review。workflow 绿色只证明
构建/烧录/采集/上传链完成；必须先核对 manifest，再用原始 `VERIFY:` marker、音频指标、HA/Agent
审计和人工观察分别判定功能。

## 9. 完成定义

- [ ] 本地唤醒到 Human 对话与 Robot 家控闭环稳定完成；
- [ ] Router、上下文、Tool 权限、Composer 文本和 TTS 播放不串角色；
- [ ] barge-in、timeout、断线、迟到数据和进程恢复均有确定性终态；
- [ ] Agent/STT/TTS 离线不破坏固定命令、触摸、P4 ↔ HA、Cat fallback 与 UI；
- [ ] 原始音频和凭证满足最小保留与敏感审计边界；
- [ ] 用户最终 review 通过，Phase 5 关闭；
- [ ] Phase 6 需用户另行明确授权后启动。
