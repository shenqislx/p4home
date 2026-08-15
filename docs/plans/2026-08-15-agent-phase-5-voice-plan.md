# Agent Phase 5 — Voice Pipeline Plan

> Status: `pending`
> Architecture: [P4 Local Agent Architecture](../p4-local-agent-architecture.md)
> Depends on: Phase 1-2 complete; audio/SR baseline restored

## 1. 目标

建立 ESP-SR wake/AFE → 音频上行 → STT → Agent → TTS → P4 播放的本地语音闭环。

## 2. 实施步骤

1. 恢复并重新验证 `audio_service`、`sr_service`；
2. 冻结 PCM format、frame size、流控和会话状态；
3. 实现独立二进制音频 channel；
4. 接入固定 Python 环境或容器中的 STT/TTS Provider；
5. 实现 VAD end-of-speech、timeout 和错误反馈；
6. 串联文本 Agent Run；
7. 实现 TTS 下行与播放队列；
8. 实现 barge-in，取消 TTS 和低优先级 Run；
9. 保留固定离线命令降级；
10. 分段记录 STT/LLM/Tool/TTS 延迟与音频丢帧。

## 3. 完成定义

- [ ] 本地唤醒到一次家控对话闭环稳定完成；
- [ ] barge-in、超时和断线可恢复；
- [ ] Agent 节点离线不破坏固定命令；
- [ ] 用户 review 通过后启动 Phase 6。
