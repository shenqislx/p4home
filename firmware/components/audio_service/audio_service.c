#include "audio_service.h"

#include <inttypes.h>
#include <string.h>

#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "freertos/task.h"

static const char *TAG = "audio_service";

typedef struct {
    bool initialized;
    bool speaker_ready;
    bool microphone_ready;
    bool tone_played;
    bool microphone_capture_ready;
    uint32_t microphone_bytes_read;
    uint16_t microphone_peak_abs;
    uint32_t microphone_mean_abs;
    uint32_t microphone_nonzero_samples;
} audio_diag_state_t;

static audio_diag_state_t s_state;
static esp_codec_dev_handle_t s_speaker_codec;
static esp_codec_dev_handle_t s_microphone_codec;
static int16_t s_tone_buffer[8000];
static int16_t s_capture_buffer[1024];
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_action_running;

static const esp_codec_dev_sample_info_t AUDIO_SERVICE_SAMPLE_INFO = {
    .bits_per_sample = 16,
    .channel = 1,
    .channel_mask = 0,
    .sample_rate = 16000,
    .mclk_multiple = 0,
};

static bool audio_service_try_begin_action(void)
{
    bool granted = false;

    taskENTER_CRITICAL(&s_state_lock);
    if (!s_action_running) {
        s_action_running = true;
        granted = true;
    }
    taskEXIT_CRITICAL(&s_state_lock);

    return granted;
}

static void audio_service_finish_action(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    s_action_running = false;
    taskEXIT_CRITICAL(&s_state_lock);
}

static esp_err_t audio_service_init_speaker(void)
{
    if (s_speaker_codec != NULL) {
        s_state.speaker_ready = true;
        return ESP_OK;
    }

    s_speaker_codec = bsp_audio_codec_speaker_init();
    ESP_RETURN_ON_FALSE(s_speaker_codec != NULL, ESP_FAIL, TAG,
                        "failed to init speaker codec");

    s_state.speaker_ready = true;
    ESP_LOGI(TAG, "speaker codec initialized");
    return ESP_OK;
}

static esp_err_t audio_service_init_microphone(void)
{
    if (s_microphone_codec != NULL) {
        s_state.microphone_ready = true;
        return ESP_OK;
    }

    s_microphone_codec = bsp_audio_codec_microphone_init();
    ESP_RETURN_ON_FALSE(s_microphone_codec != NULL, ESP_FAIL, TAG,
                        "failed to init microphone codec");

    s_state.microphone_ready = true;
    ESP_LOGI(TAG, "microphone codec initialized");
    return ESP_OK;
}

esp_err_t audio_service_play_test_tone(void)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");
    ESP_RETURN_ON_FALSE(s_speaker_codec != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "speaker codec unavailable");
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action(), ESP_ERR_INVALID_STATE, TAG,
                        "audio action already running");

    esp_err_t err = ESP_OK;
    int ret = esp_codec_dev_set_out_vol(s_speaker_codec, 55);
    if (ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to set speaker volume: %d", ret);
        goto cleanup;
    }

    ret = esp_codec_dev_open(s_speaker_codec, (esp_codec_dev_sample_info_t *)&AUDIO_SERVICE_SAMPLE_INFO);
    if (ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to open speaker stream: %d", ret);
        goto cleanup;
    }

    const int period_samples = 16;
    const int16_t amplitude = 9000;
    for (size_t i = 0; i < sizeof(s_tone_buffer) / sizeof(s_tone_buffer[0]); ++i) {
        s_tone_buffer[i] = ((i % period_samples) < (period_samples / 2)) ? amplitude : -amplitude;
    }

    ret = esp_codec_dev_write(s_speaker_codec, s_tone_buffer, sizeof(s_tone_buffer));
    vTaskDelay(pdMS_TO_TICKS(120));
    int close_ret = esp_codec_dev_close(s_speaker_codec);
    if (close_ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to close speaker stream: %d", close_ret);
        goto cleanup;
    }
    if (ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to write speaker tone: %d", ret);
        goto cleanup;
    }

    s_state.tone_played = true;
    ESP_LOGI(TAG, "speaker test tone wrote %u bytes", (unsigned)sizeof(s_tone_buffer));
cleanup:
    audio_service_finish_action();
    return err;
}

esp_err_t audio_service_capture_microphone_sample(void)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");
    ESP_RETURN_ON_FALSE(s_microphone_codec != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "microphone codec unavailable");
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action(), ESP_ERR_INVALID_STATE, TAG,
                        "audio action already running");

    esp_err_t err = ESP_OK;
    int ret = esp_codec_dev_set_in_gain(s_microphone_codec, 30.0f);
    if (ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to set microphone gain: %d", ret);
        goto cleanup;
    }

    ret = esp_codec_dev_open(s_microphone_codec, (esp_codec_dev_sample_info_t *)&AUDIO_SERVICE_SAMPLE_INFO);
    if (ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to open microphone stream: %d", ret);
        goto cleanup;
    }

    memset(s_capture_buffer, 0, sizeof(s_capture_buffer));
    ret = esp_codec_dev_read(s_microphone_codec, s_capture_buffer, sizeof(s_capture_buffer));
    int close_ret = esp_codec_dev_close(s_microphone_codec);
    if (close_ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to close microphone stream: %d", close_ret);
        goto cleanup;
    }
    if (ret != ESP_CODEC_DEV_OK) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "failed to read microphone samples: %d", ret);
        goto cleanup;
    }

    uint32_t bytes_read = sizeof(s_capture_buffer);
    uint32_t sample_count = bytes_read / sizeof(int16_t);
    uint32_t sum_abs = 0;
    uint16_t peak_abs = 0;
    uint32_t nonzero_samples = 0;

    for (uint32_t i = 0; i < sample_count; ++i) {
        int32_t sample = s_capture_buffer[i];
        if (sample < 0) {
            sample = -sample;
        }
        uint16_t magnitude = (uint16_t)sample;
        if (magnitude > peak_abs) {
            peak_abs = magnitude;
        }
        sum_abs += magnitude;
        if (magnitude != 0) {
            nonzero_samples++;
        }
    }

    s_state.microphone_capture_ready = true;
    s_state.microphone_bytes_read = bytes_read;
    s_state.microphone_peak_abs = peak_abs;
    s_state.microphone_mean_abs = sample_count > 0 ? (sum_abs / sample_count) : 0;
    s_state.microphone_nonzero_samples = nonzero_samples;

    ESP_LOGI(TAG,
             "microphone capture bytes=%" PRIu32 " samples=%" PRIu32 " peak_abs=%u mean_abs=%" PRIu32 " nonzero=%" PRIu32,
             s_state.microphone_bytes_read,
             sample_count,
             s_state.microphone_peak_abs,
             s_state.microphone_mean_abs,
             s_state.microphone_nonzero_samples);
cleanup:
    audio_service_finish_action();
    return err;
}

esp_err_t audio_service_init(void)
{
    if (s_state.initialized) {
        ESP_LOGI(TAG, "audio service already initialized");
        return ESP_OK;
    }

    memset(&s_state, 0, sizeof(s_state));

    esp_err_t ret = audio_service_init_speaker();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "speaker codec init failed: %s", esp_err_to_name(ret));
    }

    ret = audio_service_init_microphone();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "microphone codec init failed: %s", esp_err_to_name(ret));
    }

    s_state.initialized = true;
    audio_service_log_summary();
    return ESP_OK;
}

bool audio_service_is_busy(void)
{
    bool busy;

    taskENTER_CRITICAL(&s_state_lock);
    busy = s_action_running;
    taskEXIT_CRITICAL(&s_state_lock);

    return busy;
}

bool audio_service_speaker_ready(void)
{
    return s_state.speaker_ready;
}

bool audio_service_microphone_ready(void)
{
    return s_state.microphone_ready;
}

bool audio_service_tone_played(void)
{
    return s_state.tone_played;
}

bool audio_service_microphone_capture_ready(void)
{
    return s_state.microphone_capture_ready;
}

uint32_t audio_service_microphone_bytes_read(void)
{
    return s_state.microphone_bytes_read;
}

uint16_t audio_service_microphone_peak_abs(void)
{
    return s_state.microphone_peak_abs;
}

uint32_t audio_service_microphone_mean_abs(void)
{
    return s_state.microphone_mean_abs;
}

uint32_t audio_service_microphone_nonzero_samples(void)
{
    return s_state.microphone_nonzero_samples;
}

void audio_service_log_summary(void)
{
    ESP_LOGI(TAG,
             "audio initialized=%s busy=%s speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s mic_bytes=%" PRIu32 " mic_peak_abs=%u mic_mean_abs=%" PRIu32 " mic_nonzero=%" PRIu32,
             s_state.initialized ? "yes" : "no",
             audio_service_is_busy() ? "yes" : "no",
             s_state.speaker_ready ? "yes" : "no",
             s_state.microphone_ready ? "yes" : "no",
             s_state.tone_played ? "yes" : "no",
             s_state.microphone_capture_ready ? "yes" : "no",
             s_state.microphone_bytes_read,
             s_state.microphone_peak_abs,
             s_state.microphone_mean_abs,
             s_state.microphone_nonzero_samples);
}
