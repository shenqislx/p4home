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
#include "sdkconfig.h"

static const char *TAG = "audio_service";
static const char *AUDIO_SERVICE_OWNER_NONE = "none";

#ifndef CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST
#define CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST 0
#endif

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
static bool s_microphone_stream_open;
static const char *s_action_owner = "none";

static const esp_codec_dev_sample_info_t AUDIO_SERVICE_SAMPLE_INFO = {
    .bits_per_sample = 16,
    .channel = 1,
    .channel_mask = 0,
    .sample_rate = 16000,
    .mclk_multiple = 0,
};

static esp_err_t audio_service_capture_microphone(bool log_result);

static esp_err_t audio_service_write_speaker_tone(size_t sample_count,
                                                  int16_t amplitude,
                                                  uint8_t volume_percent,
                                                  TickType_t settle_delay_ticks)
{
    int ret = esp_codec_dev_set_out_vol(s_speaker_codec, volume_percent);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to set speaker volume: %d", ret);
        return ESP_FAIL;
    }

    ret = esp_codec_dev_open(s_speaker_codec, (esp_codec_dev_sample_info_t *)&AUDIO_SERVICE_SAMPLE_INFO);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to open speaker stream: %d", ret);
        return ESP_FAIL;
    }

    const int period_samples = 16;
    for (size_t i = 0; i < sample_count; ++i) {
        s_tone_buffer[i] = ((i % period_samples) < (period_samples / 2)) ? amplitude : -amplitude;
    }

    ret = esp_codec_dev_write(s_speaker_codec, s_tone_buffer, sample_count * sizeof(s_tone_buffer[0]));
    if (settle_delay_ticks > 0) {
        vTaskDelay(settle_delay_ticks);
    }
    int close_ret = esp_codec_dev_close(s_speaker_codec);
    if (close_ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to close speaker stream: %d", close_ret);
        return ESP_FAIL;
    }
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to write speaker tone: %d", ret);
        return ESP_FAIL;
    }

    s_state.tone_played = true;
    return ESP_OK;
}

static const char *audio_service_normalize_owner(const char *owner)
{
    return (owner != NULL && owner[0] != '\0') ? owner : AUDIO_SERVICE_OWNER_NONE;
}

static bool audio_service_try_begin_action(const char *owner)
{
    bool granted = false;

    taskENTER_CRITICAL(&s_state_lock);
    if (!s_action_running) {
        s_action_running = true;
        s_action_owner = audio_service_normalize_owner(owner);
        granted = true;
    }
    taskEXIT_CRITICAL(&s_state_lock);

    return granted;
}

static void audio_service_finish_action(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    s_action_running = false;
    s_action_owner = AUDIO_SERVICE_OWNER_NONE;
    taskEXIT_CRITICAL(&s_state_lock);
}

static void audio_service_fill_snapshot(audio_service_microphone_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    snapshot->ready = s_state.microphone_capture_ready;
    snapshot->bytes_read = s_state.microphone_bytes_read;
    snapshot->peak_abs = s_state.microphone_peak_abs;
    snapshot->mean_abs = s_state.microphone_mean_abs;
    snapshot->nonzero_samples = s_state.microphone_nonzero_samples;
}

static void audio_service_process_capture_samples(const int16_t *samples,
                                                  uint32_t sample_count,
                                                  bool log_result)
{
    int64_t sum_samples = 0;
    uint32_t sum_abs = 0;
    uint16_t peak_abs = 0;
    uint32_t nonzero_samples = 0;

    for (uint32_t i = 0; i < sample_count; ++i) {
        sum_samples += samples[i];
    }

    const int32_t dc_offset = sample_count > 0 ? (int32_t)(sum_samples / (int64_t)sample_count) : 0;

    for (uint32_t i = 0; i < sample_count; ++i) {
        int32_t sample = samples[i];
        sample -= dc_offset;
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
    s_state.microphone_bytes_read = sample_count * sizeof(int16_t);
    s_state.microphone_peak_abs = peak_abs;
    s_state.microphone_mean_abs = sample_count > 0 ? (sum_abs / sample_count) : 0;
    s_state.microphone_nonzero_samples = nonzero_samples;

    if (log_result) {
        ESP_LOGI(TAG,
                 "microphone capture bytes=%" PRIu32 " samples=%" PRIu32 " dc_offset=%" PRId32 " peak_abs=%u mean_abs=%" PRIu32 " nonzero=%" PRIu32,
                 s_state.microphone_bytes_read,
                 sample_count,
                 dc_offset,
                 s_state.microphone_peak_abs,
                 s_state.microphone_mean_abs,
                 s_state.microphone_nonzero_samples);
    }
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
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action("speaker_tone"), ESP_ERR_INVALID_STATE, TAG,
                        "audio action already running");

    esp_err_t err = ESP_OK;
    err = audio_service_write_speaker_tone(sizeof(s_tone_buffer) / sizeof(s_tone_buffer[0]),
                                           9000,
                                           55,
                                           pdMS_TO_TICKS(120));
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "speaker test tone wrote %u bytes", (unsigned)sizeof(s_tone_buffer));
    }
    audio_service_finish_action();
    return err;
}

esp_err_t audio_service_run_startup_selftest(void)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");

    esp_err_t overall = ESP_OK;

    if (s_speaker_codec != NULL) {
        if (!audio_service_try_begin_action("startup_speaker_selftest")) {
            ESP_LOGW(TAG, "startup speaker selftest skipped: audio action already running");
            overall = ESP_ERR_INVALID_STATE;
        } else {
            esp_err_t ret = audio_service_write_speaker_tone(1024, 7000, 35, pdMS_TO_TICKS(40));
            if (ret != ESP_OK) {
                ESP_LOGW(TAG, "startup speaker selftest failed: %s", esp_err_to_name(ret));
                overall = ret;
            } else {
                ESP_LOGI(TAG, "startup speaker selftest wrote %u bytes", 1024U * (unsigned)sizeof(int16_t));
            }
            audio_service_finish_action();
        }
    }

    if (s_microphone_codec != NULL) {
        esp_err_t ret = audio_service_capture_microphone(true);
        if (ret != ESP_OK) {
            ESP_LOGW(TAG, "startup microphone selftest failed: %s", esp_err_to_name(ret));
            overall = (overall == ESP_OK) ? ret : overall;
        } else {
            ESP_LOGI(TAG, "startup microphone selftest complete");
        }
    }

    return overall;
}

esp_err_t audio_service_begin_microphone_stream_for(const char *owner)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");
    ESP_RETURN_ON_FALSE(s_microphone_codec != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "microphone codec unavailable");
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action(owner), ESP_ERR_INVALID_STATE, TAG,
                        "audio action already running");

    int ret = esp_codec_dev_set_in_gain(s_microphone_codec, 30.0f);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to set microphone gain: %d", ret);
        audio_service_finish_action();
        return ESP_FAIL;
    }

    ret = esp_codec_dev_open(s_microphone_codec, (esp_codec_dev_sample_info_t *)&AUDIO_SERVICE_SAMPLE_INFO);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to open microphone stream: %d", ret);
        audio_service_finish_action();
        return ESP_FAIL;
    }

    s_microphone_stream_open = true;
    return ESP_OK;
}

esp_err_t audio_service_begin_microphone_stream(void)
{
    return audio_service_begin_microphone_stream_for("microphone_stream");
}

static esp_err_t audio_service_read_microphone_stream_internal(audio_service_microphone_snapshot_t *snapshot,
                                                               int16_t *samples,
                                                               size_t sample_count,
                                                               bool log_result)
{
    ESP_RETURN_ON_FALSE(s_microphone_stream_open, ESP_ERR_INVALID_STATE, TAG,
                        "microphone stream not open");
    ESP_RETURN_ON_FALSE(samples != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "microphone samples buffer is null");
    ESP_RETURN_ON_FALSE(sample_count > 0, ESP_ERR_INVALID_ARG, TAG,
                        "microphone sample count must be positive");

    size_t bytes_read = sample_count * sizeof(int16_t);
    memset(samples, 0, bytes_read);
    int ret = esp_codec_dev_read(s_microphone_codec, samples, bytes_read);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to read microphone samples: %d", ret);
        return ESP_FAIL;
    }

    audio_service_process_capture_samples(samples, sample_count, log_result);
    audio_service_fill_snapshot(snapshot);
    return ESP_OK;
}

esp_err_t audio_service_read_microphone_stream(audio_service_microphone_snapshot_t *snapshot)
{
    return audio_service_read_microphone_stream_internal(snapshot,
                                                         s_capture_buffer,
                                                         sizeof(s_capture_buffer) / sizeof(s_capture_buffer[0]),
                                                         false);
}

esp_err_t audio_service_read_microphone_samples(int16_t *samples,
                                                size_t sample_count,
                                                audio_service_microphone_snapshot_t *snapshot)
{
    return audio_service_read_microphone_stream_internal(snapshot, samples, sample_count, false);
}

esp_err_t audio_service_end_microphone_stream(void)
{
    ESP_RETURN_ON_FALSE(s_microphone_stream_open, ESP_ERR_INVALID_STATE, TAG,
                        "microphone stream not open");

    int close_ret = esp_codec_dev_close(s_microphone_codec);
    s_microphone_stream_open = false;
    audio_service_finish_action();
    if (close_ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to close microphone stream: %d", close_ret);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t audio_service_capture_microphone(bool log_result)
{
    ESP_RETURN_ON_ERROR(audio_service_begin_microphone_stream_for(log_result ? "microphone_capture"
                                                                            : "microphone_poll"),
                        TAG,
                        "failed to begin microphone stream");

    esp_err_t err = audio_service_read_microphone_stream_internal(NULL,
                                                                  s_capture_buffer,
                                                                  sizeof(s_capture_buffer) / sizeof(s_capture_buffer[0]),
                                                                  log_result);
    esp_err_t close_err = audio_service_end_microphone_stream();
    if (err == ESP_OK && close_err != ESP_OK) {
        err = close_err;
    }
    return err;
}

esp_err_t audio_service_capture_microphone_sample(void)
{
    return audio_service_capture_microphone(true);
}

esp_err_t audio_service_poll_microphone_level(audio_service_microphone_snapshot_t *snapshot)
{
    esp_err_t ret = audio_service_capture_microphone(false);
    if (ret == ESP_OK) {
        audio_service_fill_snapshot(snapshot);
    }
    return ret;
}

void audio_service_get_microphone_snapshot(audio_service_microphone_snapshot_t *snapshot)
{
    audio_service_fill_snapshot(snapshot);
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
#if CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST
    esp_err_t selftest_ret = audio_service_run_startup_selftest();
    if (selftest_ret != ESP_OK) {
        ESP_LOGW(TAG, "startup selftest completed with warnings: %s", esp_err_to_name(selftest_ret));
    }
#else
    ESP_LOGW(TAG, "startup selftest skipped by config");
#endif
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

const char *audio_service_current_owner(void)
{
    const char *owner;

    taskENTER_CRITICAL(&s_state_lock);
    owner = s_action_owner;
    taskEXIT_CRITICAL(&s_state_lock);

    return owner;
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
             "audio initialized=%s busy=%s owner=%s speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s mic_bytes=%" PRIu32 " mic_peak_abs=%u mic_mean_abs=%" PRIu32 " mic_nonzero=%" PRIu32,
             s_state.initialized ? "yes" : "no",
             audio_service_is_busy() ? "yes" : "no",
             audio_service_current_owner(),
             s_state.speaker_ready ? "yes" : "no",
             s_state.microphone_ready ? "yes" : "no",
             s_state.tone_played ? "yes" : "no",
             s_state.microphone_capture_ready ? "yes" : "no",
             s_state.microphone_bytes_read,
             s_state.microphone_peak_abs,
             s_state.microphone_mean_abs,
             s_state.microphone_nonzero_samples);
}
