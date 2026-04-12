#include "sr_service.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include "audio_service.h"
#include "esp_afe_config.h"
#include "esp_afe_sr_iface.h"
#include "esp_afe_sr_models.h"
#include "esp_check.h"
#include "esp_log.h"
#include "model_path.h"

static const char *TAG = "sr_service";
#define SR_SERVICE_INPUT_FORMAT "MR"
#define SR_SERVICE_MODEL_PATH "model"
#define SR_SERVICE_RUNTIME_SELFTEST_FRAMES 6
#define SR_SERVICE_RUNTIME_LOG_INTERVAL_FRAMES 64
#define SR_SERVICE_RUNTIME_TASK_STACK_SIZE 6144

static sr_service_status_t s_status;
static bool s_sr_initialized;
static TaskHandle_t s_runtime_task;
static esp_afe_sr_iface_t *s_runtime_afe_iface;
static esp_afe_sr_data_t *s_runtime_afe_data;
static int s_runtime_feed_channel_count;

static void sr_service_runtime_task(void *parameter);
static esp_err_t sr_service_start_runtime_loop(esp_afe_sr_iface_t *afe_iface,
                                               afe_config_t *afe_config);

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
    ESP_LOGI(TAG, "runtime loop started: feed_chunksize=%d feed_channels=%d", feed_chunksize, feed_channels);

    while (true) {
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
        if (fetch_result->wakeup_state == WAKENET_DETECTED) {
            s_status.runtime_wake_event_count++;
            ESP_LOGI(TAG,
                     "runtime wake event: wake_word_index=%d model_index=%d trigger_channel=%d",
                     fetch_result->wake_word_index,
                     fetch_result->wakenet_model_index,
                     fetch_result->trigger_channel_id);
        }

        if ((s_status.runtime_loop_iteration_count % SR_SERVICE_RUNTIME_LOG_INTERVAL_FRAMES) == 0U) {
            ESP_LOGI(TAG,
                     "runtime loop iterations=%" PRIu32 " fetch=%" PRIu32 " vad_speech=%" PRIu32 " wake_events=%" PRIu32 " last_vad=%d last_wakeup=%d",
                     s_status.runtime_loop_iteration_count,
                     s_status.runtime_fetch_count,
                     s_status.runtime_vad_speech_count,
                     s_status.runtime_wake_event_count,
                     s_status.last_vad_state,
                     s_status.last_wakeup_state);
        }
    }

cleanup:
    s_status.runtime_loop_active = false;

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
    s_status.microphone_ready = audio_service_microphone_ready();
    s_status.last_vad_state = -1;
    s_status.last_wakeup_state = -1;
    s_status.last_wake_word_index = 0;
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
             "preflight dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s feed_chunksize=%" PRIu32 " fetch_chunksize=%" PRIu32 " feed_frames=%" PRIu32 " fetch_frames=%" PRIu32 " runtime_iterations=%" PRIu32 " runtime_fetch=%" PRIu32 " runtime_vad_speech=%" PRIu32 " runtime_wake_events=%" PRIu32,
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
             s_status.afe_feed_chunksize,
             s_status.afe_fetch_chunksize,
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
             "dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s feed_chunksize=%" PRIu32 " fetch_chunksize=%" PRIu32 " feed_frames=%" PRIu32 " fetch_frames=%" PRIu32 " runtime_iterations=%" PRIu32 " runtime_fetch=%" PRIu32 " runtime_vad_speech=%" PRIu32 " runtime_wake_events=%" PRIu32 " last_vad=%d last_wakeup=%d last_wake_word=%d status=%s",
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
             s_status.afe_feed_chunksize,
             s_status.afe_fetch_chunksize,
             s_status.afe_feed_frame_count,
             s_status.afe_fetch_frame_count,
             s_status.runtime_loop_iteration_count,
             s_status.runtime_fetch_count,
             s_status.runtime_vad_speech_count,
             s_status.runtime_wake_event_count,
             s_status.last_vad_state,
             s_status.last_wakeup_state,
             s_status.last_wake_word_index,
             s_status.status_text);
}
