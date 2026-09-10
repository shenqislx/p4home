"""Continuous 24-to-16 kHz polyphase conversion across arbitrary stream chunks."""
from __future__ import annotations

class StreamingResampler24To16:
    # scipy's default filter has 30 upsampled taps of lookahead (15 source
    # samples). Retain 30 source samples on each side, aligned to the 3:2 phase.
    CONTEXT = 30

    def __init__(self):
        import numpy as np
        self.buffer = np.empty(0, dtype=np.float32)
        self.prefix = 0
        self.closed = False

    def push(self, samples, final=False):
        import numpy as np
        from scipy.signal import resample_poly
        if self.closed:
            raise ValueError("resampler already closed")
        data = np.asarray(samples, dtype=np.float32)
        if data.ndim != 1 or not np.isfinite(data).all():
            raise ValueError("invalid audio chunk")
        previous = self.buffer
        self.buffer = np.concatenate((previous, data))
        previous.fill(0)
        end = len(self.buffer) if final else max(0, (len(self.buffer) - self.CONTEXT) // 3 * 3)
        if end <= self.prefix and not final:
            return np.empty(0, dtype=np.float32)
        if not len(self.buffer):
            self.closed = final
            return np.empty(0, dtype=np.float32)
        resampled = resample_poly(self.buffer, 2, 3).astype(np.float32)
        start_out = self.prefix * 2 // 3
        end_out = len(resampled) if final else end * 2 // 3
        output = resampled[start_out:end_out].copy()
        resampled.fill(0)
        keep_from = max(0, end - self.CONTEXT)
        previous = self.buffer
        self.buffer = np.empty(0, dtype=np.float32) if final else previous[keep_from:].copy()
        previous.fill(0)
        self.prefix = 0 if final else end - keep_from
        self.closed = final
        return output
