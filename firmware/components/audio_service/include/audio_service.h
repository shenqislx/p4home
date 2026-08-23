#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "audio_service_lease.h"

typedef struct {
    bool ready;
    uint32_t bytes_read;
    uint16_t peak_abs;
    uint32_t mean_abs;
    uint32_t nonzero_samples;
} audio_service_microphone_snapshot_t;

esp_err_t audio_service_init(void);
esp_err_t audio_service_play_test_tone(void);
esp_err_t audio_service_capture_microphone_sample(void);
esp_err_t audio_service_run_startup_selftest(void);
esp_err_t audio_service_poll_microphone_level(audio_service_microphone_snapshot_t *snapshot);
esp_err_t audio_service_begin_microphone_stream(audio_service_owner_t owner,
                                                audio_service_lease_t *lease);
esp_err_t audio_service_read_microphone_stream(const audio_service_lease_t *lease,
                                               audio_service_microphone_snapshot_t *snapshot);
esp_err_t audio_service_read_microphone_samples(const audio_service_lease_t *lease,
                                                int16_t *samples,
                                                size_t sample_count,
                                                audio_service_microphone_snapshot_t *snapshot);
esp_err_t audio_service_end_microphone_stream(audio_service_lease_t *lease);
void audio_service_get_microphone_snapshot(audio_service_microphone_snapshot_t *snapshot);
bool audio_service_is_busy(void);
const char *audio_service_current_owner(void);
uint32_t audio_service_current_generation(void);
bool audio_service_faulted(void);
bool audio_service_speaker_ready(void);
bool audio_service_microphone_ready(void);
bool audio_service_tone_played(void);
bool audio_service_microphone_capture_ready(void);
uint32_t audio_service_microphone_bytes_read(void);
uint16_t audio_service_microphone_peak_abs(void);
uint32_t audio_service_microphone_mean_abs(void);
uint32_t audio_service_microphone_nonzero_samples(void);
void audio_service_log_summary(void);
