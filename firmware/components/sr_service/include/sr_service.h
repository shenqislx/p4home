#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
    SR_SERVICE_VOICE_STATE_INACTIVE = 0,
    SR_SERVICE_VOICE_STATE_LISTENING,
    SR_SERVICE_VOICE_STATE_WAKE_DETECTED,
    SR_SERVICE_VOICE_STATE_AWAKE,
} sr_service_voice_state_t;

typedef struct {
    bool dependency_declared;
    bool microphone_ready;
    bool models_available;
    bool afe_config_ready;
    bool afe_ready;
    bool afe_runtime_ready;
    bool runtime_loop_started;
    bool runtime_loop_active;
    bool wake_state_machine_started;
    bool command_model_ready;
    bool command_set_ready;
    uint32_t model_count;
    uint32_t afe_feed_chunksize;
    uint32_t afe_fetch_chunksize;
    uint32_t command_chunksize;
    uint32_t afe_feed_frame_count;
    uint32_t afe_fetch_frame_count;
    uint32_t runtime_loop_iteration_count;
    uint32_t runtime_fetch_count;
    uint32_t runtime_vad_speech_count;
    uint32_t runtime_wake_event_count;
    uint32_t wake_state_transition_count;
    uint32_t awake_session_count;
    uint32_t command_detect_count;
    uint32_t command_action_count;
    int last_wakeup_state;
    int last_wake_word_index;
    int last_vad_state;
    int last_command_id;
    sr_service_voice_state_t voice_state;
    const char *input_format;
    const char *model_path;
    const char *command_model_name;
    const char *last_command_text;
    const char *status_text;
    const char *voice_state_text;
} sr_service_status_t;

esp_err_t sr_service_init(void);
bool sr_service_dependency_declared(void);
bool sr_service_models_available(void);
uint32_t sr_service_model_count(void);
bool sr_service_afe_config_ready(void);
bool sr_service_afe_ready(void);
bool sr_service_afe_runtime_ready(void);
bool sr_service_runtime_loop_started(void);
bool sr_service_runtime_loop_active(void);
bool sr_service_wake_state_machine_started(void);
bool sr_service_command_model_ready(void);
bool sr_service_command_set_ready(void);
sr_service_voice_state_t sr_service_voice_state(void);
const char *sr_service_voice_state_text(void);
const char *sr_service_command_text(void);
const char *sr_service_input_format(void);
const char *sr_service_model_path(void);
const char *sr_service_status_text(void);
void sr_service_get_status(sr_service_status_t *status);
void sr_service_log_summary(void);
