# P4Home TTS worker

The persistent worker uses `mlx-audio[tts]` 0.4.8 and two explicitly pinned profiles:

| Profile | Model revision | Human / Robot voices |
| --- | --- | --- |
| `qwen3` | Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit, `1c6c0ff58c43afa8df571facde2efa077efd85e2` | `Serena` / `Vivian` |
| `kokoro` (legacy default) | Kokoro-82M-bf16, `a71e4d38b236d968966a2002c4c895dbd12b1c3c` | `zf_xiaoxiao` / `zf_xiaobei` |

The current installed product explicitly selects Qwen3 through its private `tts-engine` file.
The selected model revision binds the voice mapping at the TypeScript and Python boundaries.
Models do not switch automatically after a synthesis error. Requests remain serialized,
identity-bound NDJSON; both profiles emit bounded, memory-only 16 kHz mono PCM16.
Cancellation or protocol failure discards the worker before reuse.

`prepare_model.py` installs/verifies the legacy Kokoro snapshot. `prepare_qwen3_model.py`
installs/verifies the Qwen3 weights, text tokenizer, speech tokenizer and config from a fixed
commit. Both installation and runtime use repository-pinned SHA-256 values. Local manifests
alone are not trusted; symlinks, extra files and altered hashes fail closed. Runtime runs
with Hugging Face and Transformers offline. The verified model stays loaded between requests.

For Qwen3, install under the canonical product cache (create its parent first):

```sh
agent/packages/provider-tts/python/.venv/bin/python \
  agent/packages/provider-tts/python/prepare_qwen3_model.py \
  --output "$HOME/Library/Caches/p4home/tts/qwen3-custom-6bit-1c6c0ff58c43afa8df571facde2efa077efd85e2"
```

Then use `scripts/install-product-human-voice.py --tts-engine qwen3` with the existing device
and endpoint arguments, or atomically update the installed private `tts-engine` and
`tts-model-path` before restarting the service. Reinstallation preserves the selected engine
unless explicitly overridden. Keep the old model/path if a rollback is needed.

Qwen3 uses Chinese generation with a fixed natural, steady speaking instruction, a 0.48-second
model streaming interval and a 750-token generation cap. Hitting the cap fails the request;
it must not report truncated speech as completed. A stateful polyphase resampler retains
filter context across chunks, so stream boundaries match conversion of the complete signal.
The 24 kHz source accumulator is bounded before conversion; the existing 60-second per-request
PCM limit remains enforced. Generated production audio is never persisted.

Opt-in real-model coverage is in `agent/tests/integration/qwen3-tts-live.test.ts` (set
`P4HOME_TTS_QWEN3_LIVE=1`, absolute `P4HOME_TTS_PYTHON`, `P4HOME_TTS_WORKER`, and
`P4HOME_TTS_QWEN3_MODEL`). It covers both role voices, cancellation and fresh-worker recovery.
Local fixed-text WAV samples and timings are testing artifacts, not retained user recordings.
