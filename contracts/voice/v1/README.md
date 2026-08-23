# P4 Voice Protocol v1

> Status: frozen after Phase 5A gate (2026-08-23)
> Protocol version: `1`
> Data plane: independent authenticated WebSocket; not Device Protocol v1/v2

Voice Protocol v1 carries only bounded voice-session control messages and PCM frames. Device identity may be
reused during authentication, but this protocol has its own connection, limits, epochs and lifecycle.

## PCM baseline

- signed PCM16 little-endian;
- 16,000 Hz, mono;
- normal frame: 320 samples / 640 bytes / 20 ms;
- final frame may contain 1–320 samples and sets `END_OF_STREAM`;
- raw audio is memory-only by default and must not be logged or persisted.

## Binary header

Every binary WebSocket message is exactly one 56-byte little-endian header followed by `payload_bytes` PCM.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | ASCII `P4V1` |
| 4 | 1 | protocol version `1` |
| 5 | 1 | header bytes `56` |
| 6 | 1 | kind: `1=capture_pcm`, `2=playback_pcm` |
| 7 | 1 | flags: bit 0 EOS, bit 1 discontinuity |
| 8 | 16 | non-zero binary session id |
| 24 | 4 | non-zero stream id |
| 28 | 4 | non-zero epoch |
| 32 | 4 | sequence, starting at zero |
| 36 | 8 | capture/playback source monotonic timestamp in microseconds |
| 44 | 4 | payload bytes |
| 48 | 4 | sample rate `16000` |
| 52 | 2 | samples in this frame |
| 54 | 1 | channels `1` |
| 55 | 1 | bits per sample `16` |

Sequence gaps are rejected unless the first frame after a known loss sets `DISCONTINUITY`; the receiver then
records the exact dropped-frame count. Duplicate, old epoch/session/stream and post-EOS frames are rejected.
Sequence `0xffffffff` is valid only on an EOS frame, so the counter can never wrap within one stream.

## Control lifecycle

`session.open → session.ready → credit/audio* → session.eos → session.closed`. Either peer may send
`session.cancel`; protocol/limit failures use `error` and then close the session. `session.ready` 的初始 credit
不得超过 `max_inflight_frames`；后续 `credit.ack_sequence` 是已连续消费的最高 frame sequence，必须
严格单调且不能超前，`grant_frames` 是增量授权。可用 credit 与未确认 frame 之和始终不能超过协商
window。ready 之前、terminal 之后或旧 epoch 的 credit 一律拒绝。

Control messages are JSON text frames validated by `control-message.schema.json`. Audio bytes never appear in a
control message. A reconnect always creates a higher epoch; messages and audio from older epochs are stale.

This contract is frozen after the Phase 5A host, firmware build, independent review and real P4 audio/SR gates
passed. Later Phase 5 slices must version any incompatible change instead of editing v1 in place.
