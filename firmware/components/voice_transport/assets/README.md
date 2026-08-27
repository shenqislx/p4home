# Wake acknowledgement asset

`wake_ack_zh_zai_ne.pcm` is the device-local Human acknowledgement “在呢”.

- format: signed 16-bit little-endian PCM, mono, 16 kHz;
- samples: 11,220 (701.25 ms);
- playback volume: 75%;
- voice: Kokoro `zf_xiaobei`;
- model revision: `a71e4d38b236d968966a2002c4c895dbd12b1c3c`;
- PCM SHA-256: `7d2d692d90346a4a8976e0fa95c6a884fcd125f2dff0b17ee2a03962af274af2`.

The generated output was trimmed to 100 ms of padding around samples whose
absolute magnitude exceeds 100. Firmware embeds this fixed asset; wake
acknowledgement does not depend on Agent, network, or runtime TTS availability.

`wake_connecting_zh.pcm` is the device-local Human readiness prompt “正在连接，请稍后”.

- format: signed 16-bit little-endian PCM, mono, 16 kHz;
- samples: 32,572 (2,035.75 ms);
- playback volume: 75%;
- voice: Kokoro `zf_xiaobei`;
- model revision: `a71e4d38b236d968966a2002c4c895dbd12b1c3c`;
- PCM SHA-256: `494917bdbb18e579662c299be67eeb8f3a27f6b893bd425c890818e08d2b1a3b`.

It uses the same deterministic trim rule as the acknowledgement. Firmware plays
it when a wake word arrives before Home Assistant is ready, then discards that
wake without opening microphone capture, STT, the LLM, or the fixed-command
window.
