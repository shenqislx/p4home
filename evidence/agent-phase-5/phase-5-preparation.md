# Phase 5 Preparation Evidence

日期：2026-08-23

## 当前结论

Phase 5 已获用户明确授权并完成启动准备，当前工作入口为 5A Audio/ESP-SR Baseline & Voice
Contract。当前没有打开默认 SR/音频自检、没有创建 Voice socket、没有接入 STT/TTS，也没有录制、
传输或持久化真实音频。

## 前置状态

- Phase 4 的 4A–4E 技术与真实环境门禁已全部关闭；
- 最终硬件 run `32585132074` 已通过 manifest-first 身份、flash、Robot/HA/P4 收敛、1800 秒长稳、
  post-Robot standalone/UI 与矛盾证据判定；
- 用户已独立确认物理灯态变化/恢复和实际触摸，并于 2026-08-23 最终 review 通过；
- 用户在同一条指令中另行明确授权启动 Phase 5；Phase 4 收口与 Phase 5 授权按两个决策记录；
- Phase 4 计划已归档，当前计划索引只保留一个 `in_progress` Phase；
- Phase 5 继续工作在 `feature/agent-harness`，不会提前合入 `main`。

## 现有入口盘点

| 当前入口 | 已有行为 | Phase 5 影响 |
|---|---|---|
| `audio_service` | ES8311 speaker/microphone、16 kHz mono PCM16、自检、字符串 owner | 5A 冻结 PCM 并把 owner 收紧为 lease/generation |
| `sr_service` | AFE/WakeNet/MultiNet、固定 light/display 命令和 voice UI；默认关闭 | 5A 用独立 profile 恢复实机基线，固定命令继续本地执行 |
| `agent_transport` | Device JSON v1/v2、设备身份、Action/snapshot/reconnect | 只复用身份与恢复经验；Voice 二进制数据面独立版本化 |
| Router/Orchestrator | v2 span、Human/Robot Run 与角色隔离 | 5C final transcript 进入同一入口，不建立 Voice Router |
| Response Composer | Human/Robot 结构化终态的确定性组合 | 5D TTS 只消费该输出，不重新生成或覆盖执行结果 |
| Scheduler/Audit | deadline、取消、三 Run 审计与 Robot unknown | Voice session/epoch 关联既有 Interaction/Run，保持副作用边界 |
| hardware workflow | manifest、flash/serial、资源、UI 8 FPS 与专用 profile | 5A/5E 新增 Voice profile；artifact 与人工声学观察分开判定 |

## 启动决策

1. Phase 5 拆为 5A 音频/ESP-SR 基线与契约、5B 二进制通道、5C STT/统一 Router、5D 分角色
   TTS/barge-in、5E 安全/评测/真实环境五个纵切；
2. 先在 P4 本地恢复 wake/AFE/固定命令/播放，再打开音频上行，避免同时调试声学、网络与模型；
3. PCM v1 固定为 16 kHz、mono、signed PCM16 little-endian；frame/flow/session 细节由 5A contract
   冻结，不能依赖实现偶然行为；
4. Voice 使用独立二进制数据面，不原地扩展 Device JSON v1/v2；设备身份可以复用，连接、限流、
   backpressure 与状态机独立；
5. STT final transcript 只进入 Phase 4 统一 Router；partial transcript 不创建 Run，Cat 永不接收用户
   原始音频或 transcript；
6. TTS 只朗读确定性 Composer 的结构化 Human/Robot 结果，不能重新判定工具成功或跨角色改写；
7. barge-in 使用 epoch fencing。已发送 Robot 写请求仍按 `unknown` 与只读 reconciliation 收敛，
   不因取消自动重放；
8. 原始音频默认不落盘；任何诊断留存必须显式 opt-in、限定时长并可删除；
9. Agent/STT/TTS 离线时，固定离线命令、触摸、P4 ↔ HA、Cat fallback 与 UI 8 FPS 是阻断门禁；
10. Phase 5 最终 review 只关闭本 Phase，不自动授权 Phase 6。

## 5A 开始时的验证顺序

1. 先建立 Voice Protocol/PCM/owner contract 与 host/fake 失败测试；
2. 再用独立 sdkconfig profile 编译并启动 P4 本地 audio/SR，不修改默认生产开关；
3. 专用实机 artifact 先核对 commit、run、profile、串口、flash、model partition 与 capture duration；
4. 自动 marker 判 codec/PCM/AFE/wake/固定命令/资源/UI，人工判实际口令与扬声器可听播放；
5. 5A review 通过前不实现真实音频上行或 STT/TTS Provider。
