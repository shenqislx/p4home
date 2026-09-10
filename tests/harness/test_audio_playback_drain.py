"""Exercise the real drain function against a delayed six-descriptor DMA sink."""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class AudioPlaybackDrainTests(unittest.TestCase):
    def test_drain_preserves_tail_and_propagates_errors(self):
        compiler = shutil.which("cc")
        if compiler is None:
            self.skipTest("C compiler unavailable")
        source = (ROOT / "firmware/components/audio_service/audio_service.c").read_text()
        drain = source[source.index("esp_err_t audio_service_drain_speaker_stream("):
                       source.index("esp_err_t audio_service_end_speaker_stream(")]
        harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
typedef int esp_err_t;
typedef int audio_service_lease_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM -2
#define ESP_ERR_INVALID_STATE -3
#define ESP_CODEC_DEV_OK 0
#define ESP_RETURN_ON_FALSE(c, e, ...) do { if (!(c)) return (e); } while (0)
static bool lock_available = true, locked, s_speaker_stream_open = true, current = true;
static int s_speaker_codec, calls, fail_on;
static size_t pending = 1536, transmitted, silence_samples;
static bool audio_service_lock_output(void) { locked = lock_available; return locked; }
static void audio_service_unlock_output(void) { assert(locked); locked = false; }
static bool audio_service_lease_is_current(const audio_service_lease_t *l) { return l && current; }
static int esp_codec_dev_write(int codec, void *data, int bytes) {
    (void)codec;
    assert(locked);
    if (++calls == fail_on) return -1;
    const int16_t *samples = data;
    for (int i = 0; i < bytes / 2; i++) {
        assert(samples[i] == 0);
        silence_samples++;
        if (pending) { pending--; transmitted++; }
    }
    return 0;
}
'''
        main = r'''
int main(void) {
    audio_service_lease_t lease = 1;
    assert(audio_service_drain_speaker_stream(&lease) == ESP_OK);
    assert(!locked && pending == 0 && transmitted == 1536 && silence_samples > 1536);
    calls = 0; fail_on = 2;
    assert(audio_service_drain_speaker_stream(&lease) == ESP_FAIL);
    assert(!locked && calls == 2);
    current = false; calls = 0;
    assert(audio_service_drain_speaker_stream(&lease) == ESP_ERR_INVALID_STATE);
    assert(!locked && calls == 0);
    current = true; s_speaker_stream_open = false;
    assert(audio_service_drain_speaker_stream(&lease) == ESP_ERR_INVALID_STATE);
    assert(!locked && calls == 0);
    lock_available = false;
    assert(audio_service_drain_speaker_stream(&lease) == ESP_ERR_NO_MEM);
    return 0;
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            (path / "test.c").write_text(harness + drain + main)
            subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                            str(path / "test.c"), "-o", str(path / "test")], check=True)
            subprocess.run([str(path / "test")], check=True)


if __name__ == "__main__":
    unittest.main()
