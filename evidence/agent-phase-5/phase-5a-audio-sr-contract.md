# Phase 5A Audio/ESP-SR Baseline & Voice Contract Evidence

日期：2026-08-23

## 范围结论

5A 只恢复 P4 本地 audio/ESP-SR 基线并冻结 Voice Protocol v1。默认固件仍关闭 SR、audio startup
selftest 和 Phase 5A marker；本纵切没有创建 Voice socket、连接 STT/TTS、传输或持久化真实音频。

## 已实现边界

- PCM 固定为 16 kHz、mono、signed PCM16 little-endian；正常 frame 为 20 ms、320 samples、
  640 bytes；
- 56-byte little-endian header 显式携带 version、kind、flags、session id、stream id、epoch、
  sequence、capture timestamp 与 PCM geometry；
- receiver 拒绝过期 session/epoch、重复 frame、未声明 discontinuity 的 gap 和 EOS 后数据；
- control contract 显式定义 `session.open/ready`、credit、EOS、cancel、closed 与 terminal error；
- 完整 binary message 必须精确等于 header + `payload_bytes`，截断和尾随 bytes 均拒绝；
- flow tracker 关联 lifecycle/epoch、协商 window、单调 ack、可用 credit 和未确认 frame；
- audio owner 使用枚举 lease/generation；伪造、过期、重复 release 失败，SR selftest/runtime 不再借用
  字符串 owner；codec I/O 由 mutex 串行化，open/close 不确定时 quarantine 到重启；
- P4 与 TypeScript 侧共享相同 wire geometry，并分别有 host/contract 失败测试。

## 本地验证

- ESP-IDF v5.5.4 默认配置 clean build：通过；
- ESP-IDF v5.5.4 `phase5a_voice` 等价专用配置 clean build：通过，review 修复后 app image
  `0x281c90` bytes，3 MiB app partition 剩余 `0x7e370` bytes（16%）；
- C host tests：4/4（`world_service`、`world_object_runtime`、`voice_protocol`、
  `audio_service_lease`）通过；
- Agent 全量 tests：247/247；TypeScript typecheck：通过；
- Python contract：78/78；hardware harness：11/11；
- workflow YAML parse 与 `git diff --check`：通过。

## Coding bugs review

coding done 后启动独立只读 subagent review。review 报告的 6 项 finding 已全部修复：完整 binary
payload 长度、跨消息 lifecycle/credit/window、codec read/close 串行化、codec close fault quarantine、
JavaScript flags 数值边界、控制面全零 session。修复后另将 lease generation 溢出改为 fail-closed，
避免旧 generation ABA 复用。上述全量回归均在修复后重新通过。

## 实机门禁

待 coding review 与修复完成并推送候选 commit 后触发。判定顺序固定为 workflow → manifest/artifact
identity → 原始 `VERIFY:` marker → 人工口播/听觉观察；workflow 绿色不等于功能通过。
