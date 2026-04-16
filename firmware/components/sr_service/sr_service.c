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
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
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

static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;

/** Short critical sections only; do not call blocking APIs while holding the lock. */
#define SR_STATUS_MUTATE(code)          \
    do {                                \
        taskENTER_CRITICAL(&s_status_lock); \
        code;                           \
        taskEXIT_CRITICAL(&s_status_lock); \
    } while (0)

static sr_service_voice_state_t sr_status_voice_state_get(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    sr_service_voice_state_t v = s_status.voice_state;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

static bool sr_status_command_set_ready_get(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool r = s_status.command_set_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    return r;
}

static uint32_t sr_status_command_chunksize_get(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    uint32_t c = s_status.command_chunksize;
    taskEXIT_CRITICAL(&s_status_lock);
    return c;
}

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

    const char *voice_state_text;
    const char *last_command_text;
    uint32_t wake_events;
    uint32_t awake_sessions;
    uint32_t cmd_detect;
    uint32_t cmd_action;

    taskENTER_CRITICAL(&s_status_lock);
    voice_state_text = s_status.voice_state_text;
    wake_events = s_status.runtime_wake_event_count;
    awake_sessions = s_status.awake_session_count;
    cmd_detect = s_status.command_detect_count;
    cmd_action = s_status.command_action_count;
    last_command_text = s_status.last_command_text;
    taskEXIT_CRITICAL(&s_status_lock);

    char metrics_text[192];
    snprintf(metrics_text, sizeof(metrics_text),
             "voice_state=%s wake_events=%" PRIu32 " awake_sessions=%" PRIu32 " cmd_detect=%" PRIu32 " cmd_action=%" PRIu32 " last=%s backlight=%s",
             voice_state_text,
             wake_events,
             awake_sessions,
             cmd_detect,
             cmd_action,
             last_command_text,
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
        SR_STATUS_MUTATE(s_status.command_action_count++);
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
    const char *voice_state_text;
    uint32_t transitions;
    uint32_t wake_events;

    taskENTER_CRITICAL(&s_status_lock);
    if (s_status.voice_state == state) {
        s_status.voice_state_text = sr_service_voice_state_to_text(state);
        taskEXIT_CRITICAL(&s_status_lock);
        return;
    }

    s_status.voice_state = state;
    s_status.voice_state_text = sr_service_voice_state_to_text(state);
    s_status.wake_state_transition_count++;
    voice_state_text = s_status.voice_state_text;
    transitions = s_status.wake_state_transition_count;
    wake_events = s_status.runtime_wake_event_count;
    taskEXIT_CRITICAL(&s_status_lock);

    ESP_LOGI(TAG,
             "voice state -> %s reason=%s transitions=%" PRIu32 " wake_events=%" PRIu32,
             voice_state_text,
             reason != NULL ? reason : "unspecified",
             transitions,
             wake_events);
    char status_text[96];
    snprintf(status_text, sizeof(status_text),
             "Voice %s: %s",
             voice_state_text,
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
        SR_STATUS_MUTATE(s_status.status_text = "MultiNet model not found in model partition";);
        return ESP_ERR_NOT_FOUND;
    }

    strlcpy(s_command_model_name, command_model_name, sizeof(s_command_model_name));
    SR_STATUS_MUTATE(s_status.command_model_name = s_command_model_name;);
    s_command_iface = esp_mn_handle_from_name(s_command_model_name);
    ESP_RETURN_ON_FALSE(s_command_iface != NULL, ESP_FAIL, TAG,
                        "failed to resolve MultiNet handle for %s", s_command_model_name);

    s_command_model_data = s_command_iface->create(s_command_model_name, SR_SERVICE_COMMAND_TIMEOUT_MS);
    if (s_command_model_data == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "MultiNet create failed";);
        s_command_iface = NULL;
        return ESP_FAIL;
    }

    SR_STATUS_MUTATE({
        s_status.command_model_ready = true;
        s_status.command_chunksize = (uint32_t)s_command_iface->get_samp_chunksize(s_command_model_data);
    });

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
        SR_STATUS_MUTATE(s_status.status_text = "MultiNet command update reported invalid phrases";);
        return ESP_FAIL;
    }

    SR_STATUS_MUTATE({
        s_status.command_set_ready = true;
        s_status.status_text = "ESP-SR command runtime ready";
    });
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
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime create_from_config failed";);
        return ESP_FAIL;
    }

    esp_err_t err = ESP_OK;
    int feed_chunksize = afe_iface->get_feed_chunksize(afe_data);
    int fetch_chunksize = afe_iface->get_fetch_chunksize(afe_data);
    int feed_channels = afe_iface->get_feed_channel_num(afe_data);

    SR_STATUS_MUTATE({
        s_status.afe_feed_chunksize = (feed_chunksize > 0) ? (uint32_t)feed_chunksize : 0;
        s_status.afe_fetch_chunksize = (fetch_chunksize > 0) ? (uint32_t)fetch_chunksize : 0;
    });

    if (feed_chunksize <= 0 || fetch_chunksize <= 0 || feed_channels <= 0) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime reported invalid chunk or channel geometry";);
        err = ESP_FAIL;
        goto cleanup;
    }

    int16_t *mic_frame = calloc((size_t)feed_chunksize, sizeof(int16_t));
    int16_t *afe_input = calloc((size_t)feed_chunksize * (size_t)feed_channels, sizeof(int16_t));
    if (mic_frame == NULL || afe_input == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime selftest buffer allocation failed";);
        err = ESP_ERR_NO_MEM;
        free(mic_frame);
        free(afe_input);
        goto cleanup;
    }

    err = audio_service_begin_microphone_stream_for("sr_runtime_selftest");
    if (err != ESP_OK) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime could not open microphone stream";);
        free(mic_frame);
        free(afe_input);
        goto cleanup;
    }

    for (int frame = 0; frame < SR_SERVICE_RUNTIME_SELFTEST_FRAMES; ++frame) {
        memset(afe_input, 0, (size_t)feed_chunksize * (size_t)feed_channels * sizeof(int16_t));
        err = audio_service_read_microphone_samples(mic_frame, (size_t)feed_chunksize, NULL);
        if (err != ESP_OK) {
            SR_STATUS_MUTATE(s_status.status_text = "AFE runtime microphone frame read failed";);
            break;
        }

        for (int i = 0; i < feed_chunksize; ++i) {
            afe_input[i * feed_channels] = mic_frame[i];
        }

        int fed = afe_iface->feed(afe_data, afe_input);
        if (fed <= 0) {
            SR_STATUS_MUTATE(s_status.status_text = "AFE runtime feed failed";);
            err = ESP_FAIL;
            break;
        }
        SR_STATUS_MUTATE(s_status.afe_feed_frame_count++;);

        afe_fetch_result_t *fetch_result = afe_iface->fetch_with_delay(afe_data, pdMS_TO_TICKS(20));
        if (fetch_result != NULL && fetch_result->data != NULL && fetch_result->data_size > 0) {
            SR_STATUS_MUTATE({
                s_status.afe_fetch_frame_count++;
                s_status.afe_runtime_ready = true;
                s_status.status_text = "ESP-SR AFE runtime selftest ready";
            });
            err = ESP_OK;
            break;
        }
    }

    bool afe_ready_flag;
    taskENTER_CRITICAL(&s_status_lock);
    afe_ready_flag = s_status.afe_runtime_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    if (!afe_ready_flag && err == ESP_OK) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime selftest produced no fetch output";);
        err = ESP_FAIL;
    }

    esp_err_t stream_close_err = audio_service_end_microphone_stream();
    if (err == ESP_OK && stream_close_err != ESP_OK) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime microphone stream close failed";);
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
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop geometry invalid";);
        goto cleanup;
    }

    mic_frame = calloc((size_t)feed_chunksize, sizeof(int16_t));
    afe_input = calloc((size_t)feed_chunksize * (size_t)feed_channels, sizeof(int16_t));
    if (mic_frame == NULL || afe_input == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop buffer allocation failed";);
        goto cleanup;
    }

    err = audio_service_begin_microphone_stream_for("sr_runtime_loop");
    if (err != ESP_OK) {
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop could not acquire microphone";);
        goto cleanup;
    }

    stream_open = true;
    SR_STATUS_MUTATE({
        s_status.runtime_loop_active = true;
        s_status.status_text = "ESP-SR runtime loop active";
    });
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "runtime loop active");
    ESP_LOGI(TAG, "runtime loop started: feed_chunksize=%d feed_channels=%d", feed_chunksize, feed_channels);

    while (true) {
        const TickType_t now = xTaskGetTickCount();
        memset(afe_input, 0, (size_t)feed_chunksize * (size_t)feed_channels * sizeof(int16_t));
        err = audio_service_read_microphone_samples(mic_frame, (size_t)feed_chunksize, NULL);
        if (err != ESP_OK) {
            SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop microphone read failed";);
            break;
        }

        for (int i = 0; i < feed_chunksize; ++i) {
            afe_input[i * feed_channels] = mic_frame[i];
        }

        int fed = s_runtime_afe_iface->feed(s_runtime_afe_data, afe_input);
        if (fed <= 0) {
            SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop feed failed";);
            err = ESP_FAIL;
            break;
        }

        afe_fetch_result_t *fetch_result =
            s_runtime_afe_iface->fetch_with_delay(s_runtime_afe_data, pdMS_TO_TICKS(20));
        SR_STATUS_MUTATE(s_status.runtime_loop_iteration_count++;);
        if (fetch_result == NULL) {
            continue;
        }

        SR_STATUS_MUTATE({
            s_status.last_vad_state = fetch_result->vad_state;
            s_status.last_wakeup_state = fetch_result->wakeup_state;
            s_status.last_wake_word_index = fetch_result->wake_word_index;
        });

        if (fetch_result->data != NULL && fetch_result->data_size > 0) {
            SR_STATUS_MUTATE(s_status.runtime_fetch_count++;);
        }
        if (fetch_result->vad_state == VAD_SPEECH) {
            SR_STATUS_MUTATE(s_status.runtime_vad_speech_count++;);
        }
        if (fetch_result->wakeup_state == WAKENET_DETECTED &&
            sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_LISTENING) {
            SR_STATUS_MUTATE(s_status.runtime_wake_event_count++;);
            s_wake_detected_deadline = now + pdMS_TO_TICKS(SR_SERVICE_WAKE_DETECTED_HOLD_MS);
            sr_service_set_wakenet_enabled(false, "wake detected");
            sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_WAKE_DETECTED, "WakeNet detected");
            SR_STATUS_MUTATE(s_status.status_text = "Wake word detected; opening command window";);
            ESP_LOGI(TAG,
                     "runtime wake event: wake_word_index=%d model_index=%d trigger_channel=%d",
                     fetch_result->wake_word_index,
                     fetch_result->wakenet_model_index,
                     fetch_result->trigger_channel_id);
        }

        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_WAKE_DETECTED &&
            now >= s_wake_detected_deadline) {
            s_awake_deadline = now + pdMS_TO_TICKS(SR_SERVICE_AWAKE_HOLD_MS);
            SR_STATUS_MUTATE(s_status.awake_session_count++;);
            sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_AWAKE, "wake detected hold elapsed");
            if (s_command_iface != NULL && s_command_model_data != NULL && sr_status_command_set_ready_get()) {
                s_command_iface->clean(s_command_model_data);
                SR_STATUS_MUTATE(s_status.status_text = "Wake acknowledged; awaiting fixed voice command";);
                sr_service_publish_voice_status("Voice awake: waiting for fixed command.");
            }
        }

        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_AWAKE &&
            s_command_iface != NULL && s_command_model_data != NULL && sr_status_command_set_ready_get()) {
            if (fetch_result->data != NULL && fetch_result->data_size > 0) {
                const int command_samples = fetch_result->data_size / (int)sizeof(int16_t);
                const uint32_t mn_chunksize = sr_status_command_chunksize_get();
                if ((uint32_t)command_samples == mn_chunksize) {
                    esp_mn_state_t command_state =
                        s_command_iface->detect(s_command_model_data, fetch_result->data);
                    if (command_state == ESP_MN_STATE_DETECTED) {
                        esp_mn_results_t *command_result = s_command_iface->get_results(s_command_model_data);
                        if (command_result != NULL && command_result->num > 0) {
                            const char *last_txt =
                                sr_service_command_id_to_text(command_result->command_id[0]);
                            SR_STATUS_MUTATE({
                                s_status.command_detect_count++;
                                s_status.last_command_id = command_result->command_id[0];
                                s_status.last_command_text = last_txt;
                                s_status.status_text = "Fixed command detected";
                            });
                            ESP_LOGI(TAG,
                                     "command detected: id=%d text=%s prob=%.3f raw=%s",
                                     command_result->command_id[0],
                                     last_txt,
                                     command_result->prob[0],
                                     command_result->string);
                            esp_err_t action_err =
                                sr_service_apply_command_action((sr_service_command_id_t)command_result->command_id[0]);
                            if (action_err != ESP_OK) {
                                ESP_LOGW(TAG, "command action failed: %s", esp_err_to_name(action_err));
                                SR_STATUS_MUTATE(s_status.status_text = "Fixed command action failed";);
                            } else {
                                SR_STATUS_MUTATE(s_status.status_text = "Fixed command action applied";);
                            }
                            sr_service_publish_voice_status("Voice command accepted.");
                        }
                        sr_service_set_wakenet_enabled(true, "command detected");
                        sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "command detected");
                    } else if (command_state == ESP_MN_STATE_TIMEOUT) {
                        SR_STATUS_MUTATE(s_status.status_text = "Fixed command window timed out";);
                        sr_service_set_wakenet_enabled(true, "command timeout");
                        sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "command timeout");
                    }
                } else if (mn_chunksize > 0U && (uint32_t)command_samples != mn_chunksize) {
                    ESP_LOGW(TAG,
                             "MultiNet chunksize mismatch: afe_fetch=%d multinet=%" PRIu32,
                             command_samples,
                             mn_chunksize);
                }
            }
        } else if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_AWAKE) {
            if (fetch_result->vad_state == VAD_SPEECH) {
                s_awake_deadline = now + pdMS_TO_TICKS(SR_SERVICE_AWAKE_HOLD_MS);
            } else if (now >= s_awake_deadline) {
                SR_STATUS_MUTATE(s_status.status_text = "Wake session expired without command runtime";);
                sr_service_set_wakenet_enabled(true, "awake hold elapsed");
                sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "awake hold elapsed");
            }
        }

        uint32_t iter_log;
        taskENTER_CRITICAL(&s_status_lock);
        iter_log = s_status.runtime_loop_iteration_count;
        taskEXIT_CRITICAL(&s_status_lock);
        if ((iter_log % SR_SERVICE_RUNTIME_LOG_INTERVAL_FRAMES) == 0U) {
            const char *vst;
            uint32_t rfetch, rvad, rwake, rasleep, rcdetect, rcaction;
            int lvad, lwake;
            taskENTER_CRITICAL(&s_status_lock);
            iter_log = s_status.runtime_loop_iteration_count;
            rfetch = s_status.runtime_fetch_count;
            rvad = s_status.runtime_vad_speech_count;
            rwake = s_status.runtime_wake_event_count;
            vst = s_status.voice_state_text;
            rasleep = s_status.awake_session_count;
            rcdetect = s_status.command_detect_count;
            rcaction = s_status.command_action_count;
            lvad = s_status.last_vad_state;
            lwake = s_status.last_wakeup_state;
            taskEXIT_CRITICAL(&s_status_lock);
            ESP_LOGI(TAG,
                     "runtime loop iterations=%" PRIu32 " fetch=%" PRIu32 " vad_speech=%" PRIu32 " wake_events=%" PRIu32 " voice_state=%s awake_sessions=%" PRIu32 " command_detect=%" PRIu32 " command_action=%" PRIu32 " last_vad=%d last_wakeup=%d",
                     iter_log,
                     rfetch,
                     rvad,
                     rwake,
                     vst,
                     rasleep,
                     rcdetect,
                     rcaction,
                     lvad,
                     lwake);
        }
    }

cleanup:
    SR_STATUS_MUTATE(s_status.runtime_loop_active = false;);
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

    bool loop_started;
    taskENTER_CRITICAL(&s_status_lock);
    loop_started = s_status.runtime_loop_started;
    taskEXIT_CRITICAL(&s_status_lock);
    if (s_runtime_task != NULL || loop_started) {
        return ESP_OK;
    }

    s_runtime_afe_data = afe_iface->create_from_config(afe_config);
    if (s_runtime_afe_data == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop create_from_config failed";);
        return ESP_FAIL;
    }

    s_runtime_feed_channel_count = afe_iface->get_feed_channel_num(s_runtime_afe_data);
    if (s_runtime_feed_channel_count <= 0) {
        afe_iface->destroy(s_runtime_afe_data);
        s_runtime_afe_data = NULL;
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop channel geometry invalid";);
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
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop task create failed";);
        return ESP_ERR_NO_MEM;
    }

    SR_STATUS_MUTATE({
        s_status.runtime_loop_started = true;
        s_status.wake_state_machine_started = true;
    });
    sr_service_set_wakenet_enabled(true, "runtime loop task created");
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, "runtime loop task created");
    SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop starting";);
    return ESP_OK;
}

esp_err_t sr_service_init(void)
{
    if (s_sr_initialized) {
        ESP_LOGI(TAG, "sr service already initialized");
        return ESP_OK;
    }

    memset(&s_status, 0, sizeof(s_status));
    SR_STATUS_MUTATE({
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
    });

    bool mic_ready;
    taskENTER_CRITICAL(&s_status_lock);
    mic_ready = s_status.microphone_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    if (!mic_ready) {
        SR_STATUS_MUTATE(s_status.status_text = "microphone not ready, AFE preflight incomplete";);
        goto log_and_exit;
    }

    srmodel_list_t *models = esp_srmodel_init(SR_SERVICE_MODEL_PATH);
    if (models == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "model partition 'model' not found";);
        goto log_and_exit;
    }

    SR_STATUS_MUTATE({
        s_status.model_count = (uint32_t)models->num;
        s_status.models_available = (models->num > 0);
    });
    bool models_avail;
    taskENTER_CRITICAL(&s_status_lock);
    models_avail = s_status.models_available;
    taskEXIT_CRITICAL(&s_status_lock);
    if (!models_avail) {
        SR_STATUS_MUTATE(s_status.status_text = "model partition mounted but contains no SR models";);
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }

    afe_config_t *afe_config = afe_config_init(SR_SERVICE_INPUT_FORMAT, models, AFE_TYPE_SR, AFE_MODE_HIGH_PERF);
    if (afe_config == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "afe_config_init failed";);
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }

    esp_afe_sr_iface_t *afe_iface = esp_afe_handle_from_config(afe_config);
    const bool afe_iface_ready = (afe_iface != NULL);
    SR_STATUS_MUTATE({
        s_status.afe_config_ready = true;
        s_status.afe_ready = afe_iface_ready;
        s_status.status_text = afe_iface_ready
                                   ? "ESP-SR AFE preflight ready"
                                   : "AFE interface unavailable from current config";
    });

    bool afe_ok;
    taskENTER_CRITICAL(&s_status_lock);
    afe_ok = s_status.afe_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    if (afe_ok) {
        esp_err_t command_err = sr_service_init_command_runtime(models);
        if (command_err != ESP_OK) {
            ESP_LOGW(TAG, "command runtime init incomplete: %s", esp_err_to_name(command_err));
        }
        esp_err_t runtime_err = sr_service_run_runtime_selftest(afe_iface, afe_config);
        if (runtime_err != ESP_OK) {
            ESP_LOGW(TAG, "runtime selftest completed with warnings: %s", esp_err_to_name(runtime_err));
        }
        bool afe_rt;
        taskENTER_CRITICAL(&s_status_lock);
        afe_rt = s_status.afe_runtime_ready;
        taskEXIT_CRITICAL(&s_status_lock);
        if (afe_rt) {
            esp_err_t loop_err = sr_service_start_runtime_loop(afe_iface, afe_config);
            if (loop_err != ESP_OK) {
                ESP_LOGW(TAG, "runtime loop start failed: %s", esp_err_to_name(loop_err));
            }
        }
    }

    afe_config_free(afe_config);
    esp_srmodel_deinit(models);

log_and_exit:
    {
        sr_service_status_t snap;
        sr_service_get_status(&snap);
        ESP_LOGI(TAG,
                 "preflight dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s wake_state_machine_started=%s command_model_ready=%s command_set_ready=%s command_model=%s voice_state=%s feed_chunksize=%" PRIu32 " fetch_chunksize=%" PRIu32 " command_chunksize=%" PRIu32 " feed_frames=%" PRIu32 " fetch_frames=%" PRIu32 " runtime_iterations=%" PRIu32 " runtime_fetch=%" PRIu32 " runtime_vad_speech=%" PRIu32 " runtime_wake_events=%" PRIu32,
                 snap.dependency_declared ? "yes" : "no",
                 snap.microphone_ready ? "yes" : "no",
                 snap.models_available ? "yes" : "no",
                 snap.model_count,
                 snap.input_format,
                 snap.model_path,
                 snap.afe_config_ready ? "yes" : "no",
                 snap.afe_ready ? "yes" : "no",
                 snap.afe_runtime_ready ? "yes" : "no",
                 snap.runtime_loop_started ? "yes" : "no",
                 snap.runtime_loop_active ? "yes" : "no",
                 snap.wake_state_machine_started ? "yes" : "no",
                 snap.command_model_ready ? "yes" : "no",
                 snap.command_set_ready ? "yes" : "no",
                 snap.command_model_name,
                 snap.voice_state_text,
                 snap.afe_feed_chunksize,
                 snap.afe_fetch_chunksize,
                 snap.command_chunksize,
                 snap.afe_feed_frame_count,
                 snap.afe_fetch_frame_count,
                 snap.runtime_loop_iteration_count,
                 snap.runtime_fetch_count,
                 snap.runtime_vad_speech_count,
                 snap.runtime_wake_event_count);
        ESP_LOGI(TAG, "status=%s", snap.status_text);
    }

    s_sr_initialized = true;
    return ESP_OK;
}

bool sr_service_dependency_declared(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.dependency_declared;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_models_available(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.models_available;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

uint32_t sr_service_model_count(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    uint32_t v = s_status.model_count;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_afe_config_ready(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.afe_config_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_afe_ready(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.afe_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_afe_runtime_ready(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.afe_runtime_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_runtime_loop_started(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.runtime_loop_started;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_runtime_loop_active(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.runtime_loop_active;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_wake_state_machine_started(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.wake_state_machine_started;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_command_model_ready(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.command_model_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

bool sr_service_command_set_ready(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    bool v = s_status.command_set_ready;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

sr_service_voice_state_t sr_service_voice_state(void)
{
    taskENTER_CRITICAL(&s_status_lock);
    sr_service_voice_state_t v = s_status.voice_state;
    taskEXIT_CRITICAL(&s_status_lock);
    return v;
}

const char *sr_service_voice_state_text(void)
{
    const char *p;
    taskENTER_CRITICAL(&s_status_lock);
    p = s_status.voice_state_text;
    taskEXIT_CRITICAL(&s_status_lock);
    return p;
}

const char *sr_service_command_text(void)
{
    const char *p;
    taskENTER_CRITICAL(&s_status_lock);
    p = s_status.last_command_text;
    taskEXIT_CRITICAL(&s_status_lock);
    return p;
}

const char *sr_service_input_format(void)
{
    const char *p;
    taskENTER_CRITICAL(&s_status_lock);
    p = s_status.input_format;
    taskEXIT_CRITICAL(&s_status_lock);
    return p;
}

const char *sr_service_model_path(void)
{
    const char *p;
    taskENTER_CRITICAL(&s_status_lock);
    p = s_status.model_path;
    taskEXIT_CRITICAL(&s_status_lock);
    return p;
}

const char *sr_service_status_text(void)
{
    const char *p;
    taskENTER_CRITICAL(&s_status_lock);
    p = s_status.status_text;
    taskEXIT_CRITICAL(&s_status_lock);
    return p;
}

void sr_service_get_status(sr_service_status_t *status)
{
    if (status == NULL) {
        return;
    }

    taskENTER_CRITICAL(&s_status_lock);
    memcpy(status, &s_status, sizeof(*status));
    taskEXIT_CRITICAL(&s_status_lock);
}

void sr_service_log_summary(void)
{
    sr_service_status_t snap;
    sr_service_get_status(&snap);
    ESP_LOGI(TAG,
             "dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s wake_state_machine_started=%s command_model_ready=%s command_set_ready=%s command_model=%s voice_state=%s last_command=%s wake_transitions=%" PRIu32 " awake_sessions=%" PRIu32 " command_detect=%" PRIu32 " command_action=%" PRIu32 " feed_chunksize=%" PRIu32 " fetch_chunksize=%" PRIu32 " command_chunksize=%" PRIu32 " feed_frames=%" PRIu32 " fetch_frames=%" PRIu32 " runtime_iterations=%" PRIu32 " runtime_fetch=%" PRIu32 " runtime_vad_speech=%" PRIu32 " runtime_wake_events=%" PRIu32 " last_vad=%d last_wakeup=%d last_wake_word=%d last_command_id=%d status=%s",
             snap.dependency_declared ? "yes" : "no",
             snap.microphone_ready ? "yes" : "no",
             snap.models_available ? "yes" : "no",
             snap.model_count,
             snap.input_format,
             snap.model_path,
             snap.afe_config_ready ? "yes" : "no",
             snap.afe_ready ? "yes" : "no",
             snap.afe_runtime_ready ? "yes" : "no",
             snap.runtime_loop_started ? "yes" : "no",
             snap.runtime_loop_active ? "yes" : "no",
             snap.wake_state_machine_started ? "yes" : "no",
             snap.command_model_ready ? "yes" : "no",
             snap.command_set_ready ? "yes" : "no",
             snap.command_model_name,
             snap.voice_state_text,
             snap.last_command_text,
             snap.wake_state_transition_count,
             snap.awake_session_count,
             snap.command_detect_count,
             snap.command_action_count,
             snap.afe_feed_chunksize,
             snap.afe_fetch_chunksize,
             snap.command_chunksize,
             snap.afe_feed_frame_count,
             snap.afe_fetch_frame_count,
             snap.runtime_loop_iteration_count,
             snap.runtime_fetch_count,
             snap.runtime_vad_speech_count,
             snap.runtime_wake_event_count,
             snap.last_vad_state,
             snap.last_wakeup_state,
             snap.last_wake_word_index,
             snap.last_command_id,
             snap.status_text);
}
