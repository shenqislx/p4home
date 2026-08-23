# Phase 5D Role-aware TTS, Playback & Barge-in Evidence

日期：2026-08-23

## 范围结论

5D 已完成版本锁定 TTS、Human/Robot 分角色合成、有界 P4 playback、统一语音 assembly 与 barge-in
取消链，并通过逐批独立 bugs review。Composer 的结构化 part 是唯一 TTS 输入；provider、render 和
playback 回执均重新校验 interaction/assignment/device/session/stream/epoch、顺序与 PCM 几何。旧
capture/playback、迟到回执、断线、关闭和取消都有显式终态，不会改写已派发 Robot 请求的真实结果。

## 三个 coding 批次

- 5D-A commit `c353d9d`：锁定 `mlx-audio[tts] 0.4.8`、Kokoro revision
  `a71e4d38b236d968966a2002c4c895dbd12b1c3c`，Human 使用 `zf_xiaobei`、Robot 使用
  `zm_yunxi`；限制 source/output PCM，修复 spawn/abort 竞态，并在所有失败路径清零音频；
- 5D-B commit `cd03437`：Agent 实现 credit-driven sender，P4 实现有界播放 receiver、EOS/terminal、
  underrun/overrun、speaker quarantine、WakeNet capture 优先和旧 epoch fencing；
- 5D-C commit `eb8a827`：把 STT → Role Runtime → TTS → P4 playback 接入一个真实
  `UnifiedVoiceRuntime`，并让两个 Cat 产品入口持有共享的低优先级 cancellation lease。

## 真值、取消与资源边界

- P4 主动 `session.cancel`/`session.closed(cancelled)` 保持 playback cancelled，但已完成 Role dispatch
  的 STT 仍记为 `dispatched`；新 capture 或断线造成的 upstream cancel 则记为 `stale`；
- barge-in 先在 P4 停止旧输出，再由 Agent 按 device/epoch 取消旧 voice work 和全部 Cat lease；正在
  退出的 Cat `run_id` 保留 tombstone 到 runner `release()`，不能并发重入或绕过容量；
- TTS provider 和 coordinator 双层拒绝身份、分段顺序、voice、采样数、时长或总字节不一致；playback
  summary 同时校验 device identity、terminal 与 frames/bytes/dropped geometry；
- sender 私有 PCM、TTS segment PCM 和 WebSocket 临时 binary frame 在成功、取消、失败、同步 throw、
  异步 callback、disconnect 和 timeout 后清零；结果历史和 device high-water 均有界；
- shutdown 首先同步取消 Coordinator、Cat 和 STT pipeline，再以 `allSettled` 收尾 server/drain；失败
  后可重试 `close()`，但首次 shutdown 后永久拒绝再次 `start()`。

## Bugs review 与回归

5D-A、5D-B、5D-C 每个 coding 批次完成后均交由独立只读 subagent review，修复后继续 closure review。
5D-C 共进行五轮 closure，关闭了 remote cancel 真值、Cat terminating lease、TTS/playback 身份校验、
PCM 清零、shutdown retry、同设备 reconnect、high-water 有界等问题；最终结论为 **no findings**。

最终提交前验证：

- Node `24.19.0` runtime preflight：通过；
- TypeScript `tsc --noEmit`：通过；
- Agent 全量：319/319；5D orchestration：14/14；
- 5D-A 真实 Mac Metal Kokoro TTS：1/1；
- ESP-IDF v5.5.4 ESP32-P4 clean temp build：通过，app binary `0x167ed0`，partition 余量约 53%；
- `git diff --check`：通过。

一次全量并发运行中，既有 Phase 4C unavailable-socket 用例先得到 `transport_error` 而非预期
`unsafe_initial_state`；该文件单独复跑 22/22，随后全量复跑 319/319，未复现，且本次 diff 不修改
Phase 4C gate。

## Gate verdict

版本锁定 TTS、结构化分角色输出、有界播放、barge-in fencing、Cat 低优先级取消、断线/重连/关闭
终态和 PCM 最小保留满足 5D 技术门禁，状态为 **PASS**。本结论不声称已经听到 P4 板载扬声器；真实
P4 + Agent + HA 的端到端播放、barge-in、长跑和人工可听观察属于 5E 总门禁。Mac 系统扬声器只可
替代口播输入，不能替代 P4 输出证明。5D PASS 只授权进入 5E，不关闭 Phase 5，也不授权 Phase 6。
