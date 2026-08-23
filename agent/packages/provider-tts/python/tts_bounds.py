"""Pure integer bounds shared by the one-shot TTS worker and regression tests."""

MAX_PCM_BYTES = 1_920_000
MAX_SOURCE_SAMPLES_24K = (MAX_PCM_BYTES // 2) * 3 // 2


def checked_source_total(current: int, chunk_samples: int) -> int:
    if (
        isinstance(current, bool)
        or isinstance(chunk_samples, bool)
        or not isinstance(current, int)
        or not isinstance(chunk_samples, int)
        or current < 0
        or chunk_samples < 1
    ):
        raise ValueError("invalid source sample count")
    total = current + chunk_samples
    if total > MAX_SOURCE_SAMPLES_24K:
        raise ValueError("source audio exceeds the bounded 16 kHz PCM result")
    return total
