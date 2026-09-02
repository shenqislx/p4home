# P4Home TTS worker

This persistent worker freezes `mlx-audio[tts]` 0.4.8, Kokoro revision
`a71e4d38b236d968966a2002c4c895dbd12b1c3c`, and the Chinese voices
`zf_xiaobei` (Human) and `zm_yunxi` (Robot). It accepts bounded, serialized JSON
requests over NDJSON and streams identity-bound, memory-only 16 kHz mono PCM16
chunks before one terminal record. The model stays loaded between requests;
cancellation or a protocol failure discards the worker before reuse.

`prepare_model.py` creates an immutable snapshot containing only the config,
weights, the two approved voice files, and their SHA-256 manifest. The worker
refuses symlinks, extra files, version drift, model drift, role/voice mismatch,
and oversized source or output audio. The 24 kHz source accumulator is capped
before conversion using the exact 2/3 output ratio. Human text is split into
bounded Chinese clauses so playback can start before the full response is
finished. Generated audio is not persisted.
