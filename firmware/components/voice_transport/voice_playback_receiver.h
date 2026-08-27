#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"
#include "esp_err.h"

typedef esp_err_t (*voice_playback_send_json_fn)(cJSON *root, void *context);

typedef struct {
    bool active;
    bool output_quarantined;
    uint32_t sessions_started;
    uint32_t sessions_completed;
    uint32_t sessions_cancelled;
    uint32_t sessions_failed;
    uint32_t frames_received;
    uint32_t frames_played;
    uint32_t bytes_played;
    uint32_t dropped_frames;
    uint32_t queue_high_water;
    uint32_t barge_in_count;
    uint32_t speaker_close_failures;
    uint32_t wake_prompts_played;
    uint32_t wake_prompt_failures;
    uint32_t stack_high_water_bytes;
} voice_playback_snapshot_t;

esp_err_t voice_playback_receiver_init(voice_playback_send_json_fn send_json, void *context);
esp_err_t voice_playback_receiver_start(void);
esp_err_t voice_playback_receiver_stop(void);
bool voice_playback_receiver_matches(const cJSON *root);
esp_err_t voice_playback_receiver_open(const cJSON *root);
esp_err_t voice_playback_receiver_control(const cJSON *root);
esp_err_t voice_playback_receiver_frame(const uint8_t *bytes, size_t length);
void voice_playback_receiver_barge_in(void);
void voice_playback_receiver_request_wake_prompt(void);
void voice_playback_receiver_request_connecting_prompt(void);
void voice_playback_receiver_capture_failed(void);
void voice_playback_receiver_capture_ended(void);
bool voice_playback_receiver_allow_capture(void);
void voice_playback_receiver_capture_finished(void);
void voice_playback_receiver_fail(void);
void voice_playback_receiver_disconnect(void);
void voice_playback_receiver_get_snapshot(voice_playback_snapshot_t *snapshot);
