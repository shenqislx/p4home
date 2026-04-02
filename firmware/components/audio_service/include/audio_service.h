#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t audio_service_init(void);
esp_err_t audio_service_play_test_tone(void);
esp_err_t audio_service_capture_microphone_sample(void);
bool audio_service_is_busy(void);
bool audio_service_speaker_ready(void);
bool audio_service_microphone_ready(void);
bool audio_service_tone_played(void);
bool audio_service_microphone_capture_ready(void);
uint32_t audio_service_microphone_bytes_read(void);
uint16_t audio_service_microphone_peak_abs(void);
uint32_t audio_service_microphone_mean_abs(void);
uint32_t audio_service_microphone_nonzero_samples(void);
void audio_service_log_summary(void);
