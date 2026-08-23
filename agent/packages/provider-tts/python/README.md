# P4Home TTS worker

This one-shot worker freezes `mlx-audio[tts]` 0.4.8, Kokoro revision
`a71e4d38b236d968966a2002c4c895dbd12b1c3c`, and the Chinese voices
`zf_xiaobei` (Human) and `zm_yunxi` (Robot). It accepts one bounded JSON line and
returns one identity-bound, memory-only 16 kHz mono PCM16 result.

`prepare_model.py` creates an immutable snapshot containing only the config,
weights, the two approved voice files, and their SHA-256 manifest. The worker
refuses symlinks, extra files, version drift, model drift, role/voice mismatch,
and oversized source or output audio. The 24 kHz source accumulator is capped
before concatenation using the exact 2/3 output ratio. It does not persist
generated audio.
