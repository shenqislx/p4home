#include "sr_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio_service.h"
#include "display_service.h"
#include "esp_afe_config.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_mn_models.h"
#include "esp_mn_speech_commands.h"
#include "model_path.h"

static const char *TAG = "sr_service";
#define SR_SERVICE_INPUT_FORMAT "MR"
#define SR_SERVICE_MODEL_PATH "model"
#define SR_SERVICE_COMMAND_TIMEOUT_MS 6000
#define SR_SERVICE_RUNTIME_SELFTEST_FRAMES 6
#define SR_SERVICE_RUNTIME_LOG_INTERVAL_FRAMES 64
#define SR_SERVICE_RUNTIME_TASK_STACK_SIZE 6144
#define SR_SERVICE_WAKE_DETECTED_HOLD_MS 1500
#define SR_SERVICE_AWAKE_HOLD_MS 5000

typedef enum {
    SR_SERVICE_COMMAND_ID_NONE = 0,
    SR_SERVICE_COMMAND_ID_LIGHT_ON = 1,
    SR_SERVICE_COMMAND_ID_LIGHT_OFF = 2,
} sr_service_command_id_t;

typedef struct {
    sr_service_command_id_t command_id;
    const char *phrase;
    const char *phonemes;
} sr_service_command_phrase_t;

static const sr_service_command_phrase_t SR_SERVICE_COMMAND_PHRASES[] = {
    {SR_SERVICE_COMMAND_ID_LIGHT_ON, "turn on the light", "TkN nN jc LiT"},
    {SR_SERVICE_COMMAND_ID_LIGHT_OFF, "turn off the light", "TkN eF jc LiT"},
    {SR_SERVICE_COMMAND_ID_LIGHT_OFF, "turn of the light", "TkN cV jc LiT"},
    {SR_SERVICE_COMMAND_ID_LIGHT_ON, "screen on", "SKRmN nN"},
    {SR_SERVICE_COMMAND_ID_LIGHT_OFF, "screen off", "SKRmN eF"},
    {SR_SERVICE_COMMAND_ID_LIGHT_ON, "display on", "DgSPLd nN"},
    {SR_SERVICE_COMMAND_ID_LIGHT_OFF, "display off", "DgSPLd eF"},
};

static sr_service_status_t s_status;
static bool s_sr_initialized;
static TaskHandle_t s_runtime_task;
static esp_afe_sr_iface_t *s_runtime_afe_iface;
static esp_afe_sr_data_t *s_runtime_afe_data;
static int s_runtime_feed_channel_count;
static const esp_mn_iface_t *s_command_iface;
static model_iface_data_t *s_command_model_data;
static char s_command_model_name[MODEL_NAME_MAX_LENGTH];
static TickType_t s_wake_detected_deadline;
static TickType_t s_awake_deadline;

static void sr_service_runtime_task(void *parameter);
static esp_err_t sr_service_start_runtime_loop(esp_afe_sr_iface_t *afe_iface,
                                               afe_config_t *afe_config);
static esp_err_t sr_service_init_command_runtime(srmodel_list_t *models);
static void sr_service_deinit_command_runtime(void);
static const char *sr_service_command_id_to_text(int command_id);
static void sr_service_publish_voice_status(const char *status_text);
static esp_err_t sr_service_apply_command_action(sr_service_command_id_t command_id);
static const char *sr_service_voice_state_to_text(sr_service_voice_state_t state);
static void sr_service_set_voice_state(sr_service_voice_state_t state, const char *reason);
static void sr_service_set_wakenet_enabled(bool enabled, const char *reason);

static const char *sr_service_command_id_to_text(int command_id)
{
    switch ((sr_service_command_id_t)command_id) {
    case SR_SERVICE_COMMAND_ID_LIGHT_ON:
        return "light_on";
    case SR_SERVICE_COMMAND_ID_LIGHT_OFF:
        return "light_off";
    case SR_SERVICE_COMMAND_ID_NONE:
    default:
        return "none";
    }
}

static void sr_service_publish_voice_status(const char *status_text)
{
    if (!display_service_is_ready()) {
        return;
    }

    char metrics_text[192];
    snprintf(metrics_text, sizeof(metrics_text),
             "voice_state=%s wake_events=%" PRIu32 " awake_sessions=%" PRIu32 " cmd_detect=%" PRIu32 " cmd_action=%" PRIu32 " last=%s backlight=%s",
             s_status.voice_state_text,
             s_status.runtime_wake_event_count,
             s_status.awake_session_count,
             s_status.command_detect_count,
             s_status.command_action_count,
             s_status.last_command_text,
             display_service_backlight_enabled() ? "on" : "off");
    esp_err_t err = display_service_set_voice_state(status_text, metrics_text);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to update voice UI: %s", esp_err_to_name(err));
    }
}

static esp_err_t sr_service_apply_command_action(sr_service_command_id_t command_id)
{
    esp_err_t err = ESP_OK;

    switch (command_id) {
    case SR_SERVICE_COMMAND_ID_LIGHT_ON:
        err = display_service_set_backlight_enabled(true);
        break;
    case SR_SERVICE_COMMAND_ID_LIGHT_OFF:
        err = display_service_set_backlight_enabled(false);
        break;
    case SR_SERVICE_COMMAND_ID_NONE:
    default:
        err = ESP_ERR_NOT_SUPPORTED;
        break;
    }

    if (err == ESP_OK) {
        s_status.command_action_count++;
    }
    return err;
}

static const char *sr_service_voice_state_to_text(sr_service_voice_state_t state)
{
    switch (state) {
    case SR_SERVICE_VOICE_STATE_INACTIVE:
        return "inactive";
    case SR_SERVICE_VOICE_STATE_LISTENING:
        return "listening";
    case SR_SERVICE_VOICE_STATE_WAKE_DETECTED:
        return "wake_detected";
    case SR_SERVICE_VOICE_STATE_AWAKE:
        return "awake";
    default:
        return "unknown";
    }
}

static void sr_service_set_voice_state(sr_service_voice_state_t state, const char *reason)
{
    if (s_status.voice_state == state) {
        s_status.voice_state_text = sr_service_voice_state_to_text(state);
        return;
    }

    s_status.voice_state = state;
    s_status.voice_state_text = sr_service_voice_state_to_text(state);
    s_status.wake_state_transition_count++;
    ESP_LOGI(TAG,
             "voice state -> %s reason=%s transitions=%" PRIu32 " wake_events=%" PRIu32,
             s_status.voice_state_text,
             reason != NULL ? reason : "unspecified",
             s_status.wake_state_transition_count,
             s_status.runtime_wake_event_count);
    char status_text[96];
    snprintf(status_text, sizeof(status_text),
             "Voice %s: %s",
             s_status.voice_state_text,
             reason != NULL ? reason : "state update");
    sr_service_publish_voice_status(status_text);
}

static void sr_service_set_wakenet_enabled(bool enabled, const char *reason)
{
    if (s_runtime_afe_iface == NULL || s_runtime_afe_data == NULL) {
        return;
    }

    int state = enabled ? s_runtime_afe_iface->enable_wakenet(s_runtime_afe_data)
                        : s_runtime_afe_iface->disable_wakenet(s_runtime_afe_data);
    if (state < 0) {
        ESP_LOGW(TAG,
                 "failed to %s WakeNet reason=%s",
                 enabled ? "enable" : "disable",
                 reason != NULL ? reason : "unspecified");
        return;
    }

    ESP_LOGI(TAG,
             "WakeNet %s reason=%s state=%d",
             enabled ? "enabled" : "disabled",
             reason != NULL ? reason : "unspecified",
             state);
}

static esp_err_t sr_service_init_command_runtime(srmodel_list_t *models)
{
    ESP_RETURN_ON_FALSE(models != NULL, ESP_ERR_INVALID_ARG, TAG, "models list is null");

    char *command_model_name = esp_srmodel_filter(models, ESP_MN_PREFIX, ESP_MN_ENGLISH);
    if (command_model_name == NULL) {
        s_status.status_text = "MultiNet model not found in model partition";
        return ESP_ERR_NOT_FOUND;
    }

    strlcpy(s_command_model_name, command_model_name, sizeof(s_command_model_name));
    s_status.command_model_name = s_command_model_name;
    s_command_iface = esp_mn_handle_from_name(s_command_model_name);
    ESP_RETURN_ON_FALSE(s_command_iface != NULL, ESP_FAIL, TAG,
                        "failed to resolve MultiNet handle for %s", s_command_model_name);

    s_command_model_data = s_command_iface->create(s_command_model_name, SR_SERVICE_COMMAND_TIMEOUT_MS);
    if (s_command_model_data == NULL) {
        s_status.status_text = "MultiNet create failed";
        s_command_iface = NULL;
        return ESP_FAIL;
    }

    s_status.command_model_ready = true;
    s_status.command_chunksize = (uint32_t)s_command_iface->get_samp_chunksize(s_command_model_data);

    ESP_RETURN_ON_ERROR(esp_mn_commands_alloc(s_command_iface, s_command_model_data), TAG,
                        "failed to allocate MultiNet command list");

    for (size_t i = 0; i < sizeof(SR_SERVICE_COMMAND_PHRASES) / sizeof(SR_SERVICE_COMMAND_PHRASES[0]); ++i) {
        ESP_RETURN_ON_ERROR(esp_mn_commands_phoneme_add((int)SR_SERVICE_COMMAND_PHRASES[i].command_id,
                                                        SR_SERVICE_COMMAND_PHRASES[i].phrase,
                                                        SR_SERVICE_COMMAND_PHRASES[i].phonemes),
                            TAG,
                            "failed to add speech command '%s'",
                            SR_SERVICE_COMMAND_PHRASES[i].phrase);
    }

    esp_mn_error_t *command_error = esp_mn_commands_update();
    if (command_error != NULL) {
        ESP_LOGW(TAG, "MultiNet command update reported %d invalid phrase(s)", command_error->num);
        s_status.status_text = "MultiNet command update reported invalid phrases";
        return ESP_FAIL;
    }

    s_status.command_set_ready = true;
    s_status.status_text = "ESP-SR command runtime ready";
    esp_mn_active_commands_print();
    return ESP_OK;
}

static void sr_service_deinit_command_runtime(void)
{
    if (s_command_model_data != NULL && s_command_iface != NULL) {
        s_command_iface->destroy(s_command_model_data);
    }
    s_command_model_data = NULL;
    s_command_iface = NULL;
    s_command_model_name[0] = '\0';
    esp_mn_commands_free();
}

static esp_err_t sr_service_run_runtime_selftest(esp_afe_sr_iface_t *afe_iface,
                                                 afe_config_t *afe_config)
{
    ESP_RETURN_ON_FALSE(afe_iface != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "AFE interface is null");
    ESP_RETURN_ON_FALSE(afe_config != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "AFE config is null");

    esp_afe_sr_data_t *afe_data = afe_iface->create_from_config(afe_config);
    if (afe_data == NULL) {
        s_status.status_text = "AFE runtime create_from_config failed";
        return ESP_FAIL;
    }

    esp_err_t err = ESP_OK;
    int feed_chunksize = afe_iface->get_feed_chunksize(afe_data);
    int fetch_chunksize = afe_iface->get_fetch_chunksize(afe_data);
    int feed_channels = afe_iface->get_feed_channel_num(afe_data);

    s_status.afe_feed_chunksize = (feed_chunksize > 0) ? (uint32_t)feed_chunksize : 0;
    s_status.afe_fetch_chunksize = (fetch_chunksize > 0) ? (uint32_t)fetch_chunksize : 0;

    if (feed_chunksize <= 0 || fetch_chunksize <= 0 || feed_channels <= 0) {
        s_status.status_text = "AFE runtime reported invalid chunk or channel geometry";
        err = ESP_FAIL;
        goto cleanup;
    }

    int16_t *mic_frame = calloc((size_t)feed_chunksize, sizeof(int16_t));
    int16_t *afe_input = calloc((size_t)feed_chunksize * (size_t)feed_channels, sizeof(int16_t));
    if (mic_frame == NULL || afe_input == NULL) {
        s_status.status_text = "AFE runtime selftest buffer allocation failed";
        err = ESP_ERR_NO_MEM;
        free(mic_frame);
        free(afe_input);
        goto cleanup;
    }

    err = audio_service_begin_microphone_stream_for("sr_runtime_selftest");
    if (err != ESP_OK) {
        s_status.status_text = "AFE runtime could not open microphone stream";
        free(mic_frame);
        free(afe_input);
        goto cleanup;
    }

    for (int frame = 0; frame < SR_SERVICE_RUNTIME_SELFTEST_FRAMES; ++frame) {
        memset(afe_input, 0, (size_t)feed_chunksize * (size_t)feed_channels * sizeof(int16_t));
        err = audio_service_read_microphone_samples(mic_frame, (size_t)feed_chunksize, NULL);
        if (err != ESP_OK) {
            s_status.status_text = "AFE runtime microphone frame read failed";
            break;
        }

        for (int i = 0; i < feed_chunksize; ++i) {
            afe_input[i * feed_channels] = mic_frame[i];
        }

        int fed = afe_iface->feed(afe_data, afe_input);
        if (fed <= 0) {
            s_status.status_text = "AFE runtime feed failed";
            err = ESP_FAIL;
            break;
        }
        s_status.afe_feed_frame_count++;

        afe_fetch_result_t *fetch_result = afe_iface->fetch_with_delay(afe_data, pdMS_TO_TICKS(20));
        if (fetch_result != NULL && fetch_result->data != NULL && fetch_result->data_size > 0) {
            s_status.afe_fetch_frame_count++;
            s_status.afe_runtime_ready = true;
            s_status.status_text = "ESP-SR AFE runtime selftest ready";
            err = ESP_OK;
            break;
        }
    }

    if (!s_status.afe_runtime_ready && err == ESP_OK) {
        s_status.status_text = "AFE runtime selftest produced no fetch output";
        err = ESP_FAIL;
    }

    esp_err_t stream_close_err = audio_service_end_microphone_stream();
    if (err == ESP_OK && stream_close_err != ESP_OK) {
        s_status.status_text = "AFE runtime microphone stream close failed";
        err = stream_close_err;
    }

    free(mic_frame);
    free(afe_input);

cleanup:
    afe_iface->destroy(afe_data);
    return err;
}

static void sr_service_runtime_task(void *parameter)
{
    (void)parameter;

    esp_err_t err = ESP_OK;
    const int feed_chunksize = s_runtime_afe_iface->get_feed_chunksize(s_runtime_afe_data);
    const int feed_channels = s_runtime_feed_channel_count;
    int16_t *mic_frame = NULL;
    int16_t *afe_input = NULL;
    bool stream_open = false;

    if (feed_chunksize <= 0 || feed_channels <= 0) {
        s_status.status_text = "ESP-SR runtime loop geometry invalid";
        goto cleanup;
    }

    mic_frame = calloc((size_t)feed_chunksize, sizeof(int16_t));
    afe_input = calloc((size_t)feed_chunksize * (size_t)feed_channels, sizeof(int16_t));
    if (mic_frame == NULL || afe_input == NULL) {
        s_status.status_text = "ESP-SR runtime loop buffer allocation failed";
        goto cleanup;
    }

    err = audio_service_begin_microphone_stream_for("sr_runtime_loop");
    if (err != ESP_OK) {
        s_status.status_text = "ESP-SR runtime loop could not acquire microphone";
        goto cleanup;
    }

    stream_open = true;
    s_status.runtime_loop_active = true;
    s_status.status_text = "ESP-SR runtime loop active";
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "runtime loop active");
    ESP_LOGI(TAG, "runtime loop started: feed_chunksize=%d feed_channels=%d", feed_chunksize, feed_channels);

    while (true) {
        const TickType_t now = xTaskGetTickCount();
        memset(afe_input, 0, (size_t)feed_chunksize * (size_t)feed_channels * sizeof(int16_t));
        err = audio_service_read_microphone_samples(mic_frame, (size_t)feed_chunksize, NULL);
        if (err != ESP_OK) {
            s_status.status_text = "ESP-SR runtime loop microphone read failed";
            break;
        }

        for (int i = 0; i < feed_chunksize; ++i) {
            afe_input[i * feed_channels] = mic_frame[i];
        }

        int fed = s_runtime_afe_iface->feed(s_runtime_afe_data, afe_input);
        if (fed <= 0) {
            s_status.status_text = "ESP-SR runtime loop feed failed";
            err = ESP_FAIL;
            break;
        }

        afe_fetch_result_t *fetch_result =
            s_runtime_afe_iface->fetch_with_delay(s_runtime_afe_data, pdMS_TO_TICKS(20));
        s_status.runtime_loop_iteration_count++;
        if (fetch_result == NULL) {
            continue;
        }

        s_status.last_vad_state = fetch_result->vad_state;
        s_status.last_wakeup_state = fetch_result->wakeup_state;
        s_status.last_wake_word_index = fetch_result->wake_word_index;

        if (fetch_result->data != NULL && fetch_result->data_size > 0) {
            s_status.runtime_fetch_count++;
        }
        if (fetch_result->vad_state == VAD_SPEECH) {
            s_status.runtime_vad_speech_count++;
        }
        if (fetch_result->wakeup_state == WAKENET_DETECTED &&
            s_status.voice_state == SR_SERVICE_VOICE_STATE_LISTENING) {
            s_status.runtime_wake_event_count++;
            s_wake_detected_deadline = now + pdMS_TO_TICKS(SR_SERVICE_WAKE_DETECTED_HOLD_MS);
            sr_service_set_wakenet_enabled(false, "wake detected");
            sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_WAKE_DETECTED, "WakeNet detected");
            s_status.status_text = "Wake word detected; opening command window";
            ESP_LOGI(TAG,
                     "runtime wake event: wake_word_index=%d model_index=%d trigger_channel=%d",
                     fetch_result->wake_word_index,
                     fetch_result->wakenet_model_index,
                     fetch_result->trigger_channel_id);
        }

        if (s_status.voice_state == SR_SERVICE_VOICE_STATE_WAKE_DETECTED &&
            now >= s_wake_detected_deadline) {
            s_awake_deadline = now + pdMS_TO_TICKS(SR_SERVICE_AWAKE_HOLD_MS);
            s_status.awake_session_count++;
            sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_AWAKE, "wake detected hold elapsed");
            if (s_command_iface != NULL && s_command_model_data != NULL && s_status.command_set_ready) {
                s_command_iface->clean(s_command_model_data);
                s_status.status_text = "Wake acknowledged; awaiting fixed voice command";
                sr_service_publish_voice_status("Voice awake: waiting for fixed command.");
            }
        }

        if (s_status.voice_state == SR_SERVICE_VOICE_STATE_AWAKE &&
            s_command_iface != NULL && s_command_model_data != NULL && s_status.command_set_ready) {
            if (fetch_result->data != NULL && fetch_result->data_size > 0) {
                const int command_samples = fetch_result->data_size / (int)sizeof(int16_t);
                if ((uint32_t)command_samples == s_status.command_chunksize) {
                    esp_mn_state_t command_state =
                        s_command_iface->detect(s_command_model_data, fetch_result->data);
                    if (command_state == ESP_MN_STATE_DETECTED) {
                        esp_mn_results_t *command_result = s_command_iface->get_results(s_command_model_data);
                        if (command_result != NULL && command_result->num > 0) {
                            s_status.command_detect_count++;
                            s_status.last_command_id = command_result->command_id[0];
                            s_status.last_command_text =
                                sr_service_command_id_to_text(command_result->command_id[0]);
                            s_status.status_text = "Fixed command detected";
                            ESP_LOGI(TAG,
                                     "command detected: id=%d text=%s prob=%.3f raw=%s",
                                     command_result->command_id[0],
                                     s_status.last_command_text,
                                     command_result->prob[0],
                                     command_result->string);
                            esp_err_t action_err =
                                sr_service_apply_command_action((sr_service_command_id_t)command_result->command_id[0]);
                            if (action_err != ESP_OK) {
                                ESP_LOGW(TAG, "command action failed: %s", esp_err_to_name(action_err));
                                s_status.status_text = "Fixed command action failed";
                            } else {
                                s_status.status_text = "Fixed command action applied";
                            }
                            sr_service_publish_voice_status("Voice command accepted.");
                        }
                        sr_service_set_wakenet_enabled(true, "command detected");
                        sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "command detected");
                    } else if (command_state == ESP_MN_STATE_TIMEOUT) {
                        s_status.status_text = "Fixed command window timed out";
                        sr_service_set_wakenet_enabled(true, "command timeout");
                        sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "command timeout");
                    }
                } else if (s_status.command_chunksize > 0 &&
                           (uint32_t)command_samples != s_status.command_chunksize) {
                    ESP_LOGW(TAG,
                             "MultiNet chunksize mismatch: afe_fetch=%d multinet=%" PRIu32,
                             command_samples,
                             s_status.command_chunksize);
                }
            }
        } else if (s_status.voice_state == SR_SERVICE_VOICE_STATE_AWAKE) {
            if (fetch_result->vad_state == VAD_SPEECH) {
                s_awake_deadline = now + pdMS_TO_TICKS(SR_SERVICE_AWAKE_HOLD_MS);
            } else if (now >= s_awake_deadline) {
                s_status.status_text = "Wake session expired without command runtime";
                sr_service_set_wakenet_enabled(true, "awake hold elapsed");
                sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "awake hold elapsed");
            }
        }

        if ((s_status.runtime_loop_iteration_count % SR_SERVICE_RUNTIME_LOG_INTERVAL_FRAMES) == 0U) {
            ESP_LOGI(TAG,
                     "runtime loop iterations=%" PRIu32 " fetch=%" PRIu32 " vad_speech=%" PRIu32 " wake_events=%" PRIu32 " voice_state=%s awake_sessions=%" PRIu32 " command_detect=%" PRIu32 " command_action=%" PRIu32 " last_vad=%d last_wakeup=%d",
                     s_status.runtime_loop_iteration_count,
                     s_status.runtime_fetch_count,
                     s_status.runtime_vad_speech_count,
                     s_status.runtime_wake_event_count,
                     s_status.voice_state_text,
                     s_status.awake_session_count,
                     s_status.command_detect_count,
                     s_status.command_action_count,
                     s_status.last_vad_state,
                     s_status.last_wakeup_state);
        }
    }

cleanup:
    s_status.runtime_loop_active = false;
    sr_service_set_wakenet_enabled(true, "runtime loop stopped");
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_INACTIVE, "runtime loop stopped");

    if (stream_open) {
        esp_err_t close_err = audio_service_end_microphone_stream();
        if (err == ESP_OK && close_err != ESP_OK) {
            err = close_err;
        }
    }

    free(mic_frame);
    free(afe_input);

    if (s_runtime_afe_data != NULL && s_runtime_afe_iface != NULL) {
        s_runtime_afe_iface->destroy(s_runtime_afe_data);
    }
    sr_service_deinit_command_runtime();
    s_runtime_afe_data = NULL;
    s_runtime_afe_iface = NULL;
    s_runtime_feed_channel_count = 0;
    s_runtime_task = NULL;

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "runtime loop stopped: %s", esp_err_to_name(err));
    }
    vTaskDelete(NULL);
}

static esp_err_t sr_service_start_runtime_loop(esp_afe_sr_iface_t *afe_iface,
                                               afe_config_t *afe_config)
{
    ESP_RETURN_ON_FALSE(afe_iface != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "AFE interface is null");
    ESP_RETURN_ON_FALSE(afe_config != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "AFE config is null");

    if (s_runtime_task != NULL || s_status.runtime_loop_started) {
        return ESP_OK;
    }

    s_runtime_afe_data = afe_iface->create_from_config(afe_config);
    if (s_runtime_afe_data == NULL) {
        s_status.status_text = "ESP-SR runtime loop create_from_config failed";
        return ESP_FAIL;
    }

    s_runtime_feed_channel_count = afe_iface->get_feed_channel_num(s_runtime_afe_data);
    if (s_runtime_feed_channel_count <= 0) {
        afe_iface->destroy(s_runtime_afe_data);
        s_runtime_afe_data = NULL;
        s_status.status_text = "ESP-SR runtime loop channel geometry invalid";
        return ESP_FAIL;
    }

    s_runtime_afe_iface = afe_iface;
    if (xTaskCreate(sr_service_runtime_task,
                    "sr_runtime",
                    SR_SERVICE_RUNTIME_TASK_STACK_SIZE,
                    NULL,
                    5,
                    &s_runtime_task) != pdPASS) {
        afe_iface->destroy(s_runtime_afe_data);
        s_runtime_afe_data = NULL;
        s_runtime_afe_iface = NULL;
        s_runtime_feed_channel_count = 0;
        s_status.status_text = "ESP-SR runtime loop task create failed";
        return ESP_ERR_NO_MEM;
    }

    s_status.runtime_loop_started = true;
    s_status.wake_state_machine_started = true;
    sr_service_set_wakenet_enabled(true, "runtime loop task created");
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "runtime loop task created");
    s_status.status_text = "ESP-SR runtime loop starting";
    return ESP_OK;
}

esp_err_t sr_service_init(void)
{
    if (s_sr_initialized) {
        ESP_LOGI(TAG, "sr service already initialized");
        return ESP_OK;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_status.dependency_declared = true;
    s_status.input_format = SR_SERVICE_INPUT_FORMAT;
    s_status.model_path = SR_SERVICE_MODEL_PATH;
    s_status.command_model_name = "none";
    s_status.last_command_text = "none";
    s_status.microphone_ready = audio_service_microphone_ready();
    s_status.last_vad_state = -1;
    s_status.last_wakeup_state = -1;
    s_status.last_wake_word_index = 0;
    s_status.last_command_id = 0;
    s_status.voice_state = SR_SERVICE_VOICE_STATE_INACTIVE;
    s_status.voice_state_text = sr_service_voice_state_to_text(SR_SERVICE_VOICE_STATE_INACTIVE);
    s_status.status_text = "not initialized";

    if (!s_status.microphone_ready) {
        s_status.status_text = "microphone not ready, AFE preflight incomplete";
        goto log_and_exit;
    }

    srmodel_list_t *models = esp_srmodel_init(SR_SERVICE_MODEL_PATH);
    if (models == NULL) {
        s_status.status_text = "model partition 'model' not found";
        goto log_and_exit;
    }

    s_status.model_count = (uint32_t)models->num;
    s_status.models_available = (models->num > 0);
    if (!s_status.models_available) {
        s_status.status_text = "model partition mounted but contains no SR models";
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }

    afe_config_t *afe_config = afe_config_init(SR_SERVICE_INPUT_FORMAT, models, AFE_TYPE_SR, AFE_MODE_HIGH_PERF);
    if (afe_config == NULL) {
        s_status.status_text = "afe_config_init failed";
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }

    s_status.afe_config_ready = true;
    esp_afe_sr_iface_t *afe_iface = esp_afe_handle_from_config(afe_config);
    s_status.afe_ready = (afe_iface != NULL);
    s_status.status_text = s_status.afe_ready
                               ? "ESP-SR AFE preflight ready"
                               : "AFE interface unavailable from current config";

    if (s_status.afe_ready) {
        esp_err_t command_err = sr_service_init_command_runtime(models);
        if (command_err != ESP_OK) {
            ESP_LOGW(TAG, "command runtime init incomplete: %s", esp_err_to_name(command_err));
        }
        esp_err_t runtime_err = sr_service_run_runtime_selftest(afe_iface, afe_config);
        if (runtime_err != ESP_OK) {
            ESP_LOGW(TAG, "runtime selftest completed with warnings: %s", esp_err_to_name(runtime_err));
        }
        if (s_status.afe_runtime_ready) {
            esp_err_t loop_err = sr_service_start_runtime_loop(afe_iface, afe_config);
            if (loop_err != ESP_OK) {
                ESP_LOGW(TAG, "runtime loop start failed: %s", esp_err_to_name(loop_err));
            }
        }
    }

    afe_config_free(afe_config);
    esp_srmodel_deinit(models);

log_and_exit:
    ESP_LOGI(TAG,
             "preflight dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s wake_state_machine_started=%s command_model_ready=%s command_set_ready=%s command_model=%s voice_state=%s feed_chunksize=%" PRIu32 " fetch_chunksize=%" PRIu32 " command_chunksize=%" PRIu32 " feed_frames=%" PRIu32 " fetch_frames=%" PRIu32 " runtime_iterations=%" PRIu32 " runtime_fetch=%" PRIu32 " runtime_vad_speech=%" PRIu32 " runtime_wake_events=%" PRIu32,
             s_status.dependency_declared ? "yes" : "no",
             s_status.microphone_ready ? "yes" : "no",
             s_status.models_available ? "yes" : "no",
             s_status.model_count,
             s_status.input_format,
             s_status.model_path,
             s_status.afe_config_ready ? "yes" : "no",
             s_status.afe_ready ? "yes" : "no",
             s_status.afe_runtime_ready ? "yes" : "no",
             s_status.runtime_loop_started ? "yes" : "no",
             s_status.runtime_loop_active ? "yes" : "no",
             s_status.wake_state_machine_started ? "yes" : "no",
             s_status.command_model_ready ? "yes" : "no",
             s_status.command_set_ready ? "yes" : "no",
             s_status.command_model_name,
             s_status.voice_state_text,
             s_status.afe_feed_chunksize,
             s_status.afe_fetch_chunksize,
             s_status.command_chunksize,
             s_status.afe_feed_frame_count,
             s_status.afe_fetch_frame_count,
             s_status.runtime_loop_iteration_count,
             s_status.runtime_fetch_count,
             s_status.runtime_vad_speech_count,
             s_status.runtime_wake_event_count);
    ESP_LOGI(TAG, "status=%s", s_status.status_text);

    s_sr_initialized = true;
    return ESP_OK;
}

bool sr_service_dependency_declared(void)
{
    return s_status.dependency_declared;
}

bool sr_service_models_available(void)
{
    return s_status.models_available;
}

uint32_t sr_service_model_count(void)
{
    return s_status.model_count;
}

bool sr_service_afe_config_ready(void)
{
    return s_status.afe_config_ready;
}

bool sr_service_afe_ready(void)
{
    return s_status.afe_ready;
}

bool sr_service_afe_runtime_ready(void)
{
    return s_status.afe_runtime_ready;
}

bool sr_service_runtime_loop_started(void)
{
    return s_status.runtime_loop_started;
}

bool sr_service_runtime_loop_active(void)
{
    return s_status.runtime_loop_active;
}

bool sr_service_wake_state_machine_started(void)
{
    return s_status.wake_state_machine_started;
}

bool sr_service_command_model_ready(void)
{
    return s_status.command_model_ready;
}

bool sr_service_command_set_ready(void)
{
    return s_status.command_set_ready;
}

sr_service_voice_state_t sr_service_voice_state(void)
{
    return s_status.voice_state;
}

const char *sr_service_voice_state_text(void)
{
    return s_status.voice_state_text;
}

const char *sr_service_command_text(void)
{
    return s_status.last_command_text;
}

const char *sr_service_input_format(void)
{
    return s_status.input_format;
}

const char *sr_service_model_path(void)
{
    return s_status.model_path;
}

const char *sr_service_status_text(void)
{
    return s_status.status_text;
}

void sr_service_get_status(sr_service_status_t *status)
{
    if (status == NULL) {
        return;
    }

    memcpy(status, &s_status, sizeof(*status));
}

void sr_service_log_summary(void)
{
    ESP_LOGI(TAG,
             "dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s wake_state_machine_started=%s command_model_ready=%s command_set_ready=%s command_model=%s voice_state=%s last_command=%s wake_transitions=%" PRIu32 " awake_sessions=%" PRIu32 " command_detect=%" PRIu32 " command_action=%" PRIu32 " feed_chunksize=%" PRIu32 " fetch_chunksize=%" PRIu32 " command_chunksize=%" PRIu32 " feed_frames=%" PRIu32 " fetch_frames=%" PRIu32 " runtime_iterations=%" PRIu32 " runtime_fetch=%" PRIu32 " runtime_vad_speech=%" PRIu32 " runtime_wake_events=%" PRIu32 " last_vad=%d last_wakeup=%d last_wake_word=%d last_command_id=%d status=%s",
             s_status.dependency_declared ? "yes" : "no",
             s_status.microphone_ready ? "yes" : "no",
             s_status.models_available ? "yes" : "no",
             s_status.model_count,
             s_status.input_format,
             s_status.model_path,
             s_status.afe_config_ready ? "yes" : "no",
             s_status.afe_ready ? "yes" : "no",
             s_status.afe_runtime_ready ? "yes" : "no",
             s_status.runtime_loop_started ? "yes" : "no",
             s_status.runtime_loop_active ? "yes" : "no",
             s_status.wake_state_machine_started ? "yes" : "no",
             s_status.command_model_ready ? "yes" : "no",
             s_status.command_set_ready ? "yes" : "no",
             s_status.command_model_name,
             s_status.voice_state_text,
             s_status.last_command_text,
             s_status.wake_state_transition_count,
             s_status.awake_session_count,
             s_status.command_detect_count,
             s_status.command_action_count,
             s_status.afe_feed_chunksize,
             s_status.afe_fetch_chunksize,
             s_status.command_chunksize,
             s_status.afe_feed_frame_count,
             s_status.afe_fetch_frame_count,
             s_status.runtime_loop_iteration_count,
             s_status.runtime_fetch_count,
             s_status.runtime_vad_speech_count,
             s_status.runtime_wake_event_count,
             s_status.last_vad_state,
             s_status.last_wakeup_state,
             s_status.last_wake_word_index,
             s_status.last_command_id,
             s_status.status_text);
}
