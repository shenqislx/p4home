#include "audio_service.h"

#include <inttypes.h>
#include <string.h>

#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "audio_service";

#ifndef CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST
#define CONFIG_P4HOME_AUDIO_STARTUP_SELFTEST 0
#endif

#define AUDIO_SERVICE_TONE_BUFFER_SAMPLES 8000U
#define AUDIO_SERVICE_STARTUP_TONE_SAMPLES 8000U
#define AUDIO_SERVICE_STARTUP_TONE_AMPLITUDE 9000
#define AUDIO_SERVICE_STARTUP_TONE_VOLUME_PERCENT 55U
#define AUDIO_SERVICE_STARTUP_TONE_SETTLE_MS 600U

_Static_assert(AUDIO_SERVICE_STARTUP_TONE_SAMPLES <= AUDIO_SERVICE_TONE_BUFFER_SAMPLES,
               "startup tone must fit the static tone buffer");

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
    uint32_t speaker_frames_written;
    uint32_t speaker_bytes_written;
} audio_diag_state_t;

static audio_diag_state_t s_state;
static esp_codec_dev_handle_t s_speaker_codec;
static esp_codec_dev_handle_t s_microphone_codec;
static int16_t s_tone_buffer[AUDIO_SERVICE_TONE_BUFFER_SAMPLES];
static int16_t s_capture_buffer[1024];
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static StaticSemaphore_t s_input_mutex_storage;
static SemaphoreHandle_t s_input_mutex;
static StaticSemaphore_t s_output_mutex_storage;
static SemaphoreHandle_t s_output_mutex;
static bool s_microphone_stream_open;
static bool s_speaker_stream_open;
static bool s_duplex_codec_open;
static audio_service_lease_state_t s_input_lease_state;
static audio_service_lease_state_t s_output_lease_state;

static const esp_codec_dev_sample_info_t AUDIO_SERVICE_SAMPLE_INFO = {
    .bits_per_sample = 16,
    .channel = 1,
    .channel_mask = 0,
    .sample_rate = 16000,
    .mclk_multiple = 0,
};

static esp_err_t audio_service_capture_microphone(bool log_result);

static bool audio_service_owner_is_output(audio_service_owner_t owner)
{
    return owner == AUDIO_SERVICE_OWNER_STARTUP_SELFTEST ||
           owner == AUDIO_SERVICE_OWNER_SPEAKER_TEST ||
           owner == AUDIO_SERVICE_OWNER_VOICE_PLAYBACK;
}

static bool audio_service_ensure_input_mutex(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    if (s_input_mutex == NULL) {
        s_input_mutex = xSemaphoreCreateMutexStatic(&s_input_mutex_storage);
    }
    const bool ready = s_input_mutex != NULL;
    taskEXIT_CRITICAL(&s_state_lock);
    return ready;
}

static bool audio_service_ensure_output_mutex(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    if (s_output_mutex == NULL) {
        s_output_mutex = xSemaphoreCreateMutexStatic(&s_output_mutex_storage);
    }
    const bool ready = s_output_mutex != NULL;
    taskEXIT_CRITICAL(&s_state_lock);
    return ready;
}

static bool audio_service_lock_input(void)
{
    return audio_service_ensure_input_mutex() &&
           xSemaphoreTake(s_input_mutex, portMAX_DELAY) == pdTRUE;
}

static void audio_service_unlock_input(void)
{
    (void)xSemaphoreGive(s_input_mutex);
}

static bool audio_service_lock_output(void)
{
    return audio_service_ensure_output_mutex() &&
           xSemaphoreTake(s_output_mutex, portMAX_DELAY) == pdTRUE;
}

static void audio_service_unlock_output(void)
{
    (void)xSemaphoreGive(s_output_mutex);
}

static esp_err_t audio_service_write_speaker_tone(size_t sample_count,
                                                  int16_t amplitude,
                                                  uint8_t volume_percent,
                                                  TickType_t settle_delay_ticks,
                                                  bool *codec_state_uncertain)
{
    ESP_RETURN_ON_FALSE(sample_count > 0U && sample_count <= AUDIO_SERVICE_TONE_BUFFER_SAMPLES,
                        ESP_ERR_INVALID_ARG, TAG, "speaker tone sample count is invalid");
    *codec_state_uncertain = false;
    int ret = esp_codec_dev_set_out_vol(s_speaker_codec, volume_percent);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to set speaker volume: %d", ret);
        return ESP_FAIL;
    }

    ret = esp_codec_dev_set_out_mute(s_speaker_codec, false);
    if (ret != ESP_CODEC_DEV_OK) return ESP_FAIL;

    const int period_samples = 16;
    for (size_t i = 0; i < sample_count; ++i) {
        s_tone_buffer[i] = ((i % period_samples) < (period_samples / 2)) ? amplitude : -amplitude;
    }

    ret = esp_codec_dev_write(s_speaker_codec, s_tone_buffer, sample_count * sizeof(s_tone_buffer[0]));
    if (settle_delay_ticks > 0) {
        vTaskDelay(settle_delay_ticks);
    }
    int mute_ret = esp_codec_dev_set_out_mute(s_speaker_codec, true);
    if (mute_ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to mute speaker stream: %d", mute_ret);
        *codec_state_uncertain = true;
        return ESP_FAIL;
    }
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to write speaker tone: %d", ret);
        return ESP_FAIL;
    }

    s_state.tone_played = true;
    return ESP_OK;
}

static bool audio_service_try_begin_action(audio_service_owner_t owner,
                                           audio_service_lease_t *lease)
{
    bool granted = false;

    taskENTER_CRITICAL(&s_state_lock);
    audio_service_lease_state_t *state =
        audio_service_owner_is_output(owner)
            ? &s_output_lease_state
            : &s_input_lease_state;
    granted = audio_service_lease_acquire(state, owner, lease);
    taskEXIT_CRITICAL(&s_state_lock);

    return granted;
}

static bool audio_service_finish_action(audio_service_lease_t *lease)
{
    bool released;
    taskENTER_CRITICAL(&s_state_lock);
    audio_service_lease_state_t *state =
        (lease != NULL && audio_service_owner_is_output(lease->owner))
            ? &s_output_lease_state
            : &s_input_lease_state;
    released = audio_service_lease_release(state, lease);
    taskEXIT_CRITICAL(&s_state_lock);
    return released;
}

static bool audio_service_quarantine_action(audio_service_lease_t *lease)
{
    bool faulted;
    taskENTER_CRITICAL(&s_state_lock);
    audio_service_lease_state_t *state =
        (lease != NULL && audio_service_owner_is_output(lease->owner))
            ? &s_output_lease_state
            : &s_input_lease_state;
    faulted = audio_service_lease_fault(state, lease);
    taskEXIT_CRITICAL(&s_state_lock);
    return faulted;
}

static bool audio_service_lease_is_current(const audio_service_lease_t *lease)
{
    bool matches;
    taskENTER_CRITICAL(&s_state_lock);
    const audio_service_lease_state_t *state =
        (lease != NULL && audio_service_owner_is_output(lease->owner))
            ? &s_output_lease_state
            : &s_input_lease_state;
    matches = audio_service_lease_matches(state, lease);
    taskEXIT_CRITICAL(&s_state_lock);
    return matches;
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

static esp_err_t audio_service_open_persistent_duplex(void)
{
    if (s_duplex_codec_open) return ESP_OK;
    ESP_RETURN_ON_FALSE(s_speaker_codec != NULL && s_microphone_codec != NULL,
                        ESP_ERR_INVALID_STATE, TAG, "duplex codec handles unavailable");
    int ret = esp_codec_dev_open(s_speaker_codec,
                                 (esp_codec_dev_sample_info_t *)&AUDIO_SERVICE_SAMPLE_INFO);
    if (ret != ESP_CODEC_DEV_OK) return ESP_FAIL;
    ret = esp_codec_dev_open(s_microphone_codec,
                             (esp_codec_dev_sample_info_t *)&AUDIO_SERVICE_SAMPLE_INFO);
    if (ret != ESP_CODEC_DEV_OK) {
        (void)esp_codec_dev_close(s_speaker_codec);
        return ESP_FAIL;
    }
    ret = esp_codec_dev_set_in_gain(s_microphone_codec, 30.0f);
    if (ret == ESP_CODEC_DEV_OK) ret = esp_codec_dev_set_out_vol(s_speaker_codec, 55);
    if (ret == ESP_CODEC_DEV_OK) ret = esp_codec_dev_set_out_mute(s_speaker_codec, true);
    if (ret != ESP_CODEC_DEV_OK) {
        (void)esp_codec_dev_close(s_microphone_codec);
        (void)esp_codec_dev_close(s_speaker_codec);
        return ESP_FAIL;
    }
    s_duplex_codec_open = true;
    ESP_LOGI(TAG, "persistent 16 kHz full-duplex codec lifecycle opened");
    return ESP_OK;
}

esp_err_t audio_service_play_test_tone(void)
{
    audio_service_lease_t lease = {0};
    bool codec_state_uncertain = false;
    ESP_RETURN_ON_ERROR(audio_service_init(), TAG, "lazy audio init failed");
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");
    ESP_RETURN_ON_FALSE(s_speaker_codec != NULL && s_duplex_codec_open,
                        ESP_ERR_INVALID_STATE, TAG,
                        "speaker codec unavailable");
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action(AUDIO_SERVICE_OWNER_SPEAKER_TEST, &lease),
                        ESP_ERR_INVALID_STATE, TAG,
                        "audio action already running");

    if (!audio_service_lock_output()) {
        (void)audio_service_finish_action(&lease);
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = audio_service_write_speaker_tone(
        sizeof(s_tone_buffer) / sizeof(s_tone_buffer[0]),
        9000,
        55,
        pdMS_TO_TICKS(120),
        &codec_state_uncertain);
    audio_service_unlock_output();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "speaker test tone wrote %u bytes", (unsigned)sizeof(s_tone_buffer));
    }
    const bool released = codec_state_uncertain
                              ? audio_service_quarantine_action(&lease)
                              : audio_service_finish_action(&lease);
    if (!released) {
        ESP_LOGE(TAG, "speaker lease release failed");
        return ESP_ERR_INVALID_STATE;
    }
    if (codec_state_uncertain) {
        ESP_LOGE(TAG, "speaker codec quarantined until reboot after uncertain open/close");
    }
    return err;
}

esp_err_t audio_service_run_startup_selftest(void)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");

    esp_err_t overall = ESP_OK;

    if (s_speaker_codec != NULL) {
        audio_service_lease_t lease = {0};
        bool codec_state_uncertain = false;
        if (!audio_service_try_begin_action(AUDIO_SERVICE_OWNER_STARTUP_SELFTEST, &lease)) {
            ESP_LOGW(TAG, "startup speaker selftest skipped: audio action already running");
            overall = ESP_ERR_INVALID_STATE;
        } else {
            esp_err_t ret = ESP_ERR_NO_MEM;
            if (audio_service_lock_output()) {
                ret = audio_service_write_speaker_tone(
                    AUDIO_SERVICE_STARTUP_TONE_SAMPLES,
                    AUDIO_SERVICE_STARTUP_TONE_AMPLITUDE,
                    AUDIO_SERVICE_STARTUP_TONE_VOLUME_PERCENT,
                    pdMS_TO_TICKS(AUDIO_SERVICE_STARTUP_TONE_SETTLE_MS),
                    &codec_state_uncertain);
                audio_service_unlock_output();
            }
            if (ret != ESP_OK) {
                ESP_LOGW(TAG, "startup speaker selftest failed: %s", esp_err_to_name(ret));
                overall = ret;
            } else {
                ESP_LOGI(TAG, "startup speaker selftest wrote %u bytes",
                         AUDIO_SERVICE_STARTUP_TONE_SAMPLES * (unsigned)sizeof(int16_t));
            }
            const bool released = codec_state_uncertain
                                      ? audio_service_quarantine_action(&lease)
                                      : audio_service_finish_action(&lease);
            if (!released) {
                ESP_LOGE(TAG, "startup speaker lease release failed");
                overall = ESP_ERR_INVALID_STATE;
            }
            if (codec_state_uncertain) {
                ESP_LOGE(TAG, "speaker codec quarantined until reboot after uncertain open/close");
            }
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

esp_err_t audio_service_begin_microphone_stream(audio_service_owner_t owner,
                                                audio_service_lease_t *lease)
{
    ESP_RETURN_ON_FALSE(lease != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "microphone lease output is null");
    ESP_RETURN_ON_FALSE(owner > AUDIO_SERVICE_OWNER_NONE &&
                        owner <= AUDIO_SERVICE_OWNER_VOICE_PLAYBACK &&
                        !audio_service_owner_is_output(owner),
                        ESP_ERR_INVALID_ARG, TAG, "microphone stream owner is not allowed");
    ESP_RETURN_ON_ERROR(audio_service_init(), TAG, "lazy audio init failed");
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "audio service not initialized");
    ESP_RETURN_ON_FALSE(s_microphone_codec != NULL && s_duplex_codec_open,
                        ESP_ERR_INVALID_STATE, TAG,
                        "microphone codec unavailable");
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action(owner, lease), ESP_ERR_INVALID_STATE, TAG,
                        "audio action already running");

    if (!audio_service_lock_input()) {
        (void)audio_service_finish_action(lease);
        return ESP_ERR_NO_MEM;
    }
    int ret = esp_codec_dev_set_in_gain(s_microphone_codec, 30.0f);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to set microphone gain: %d", ret);
        audio_service_unlock_input();
        (void)audio_service_finish_action(lease);
        return ESP_FAIL;
    }

    s_microphone_stream_open = true;
    audio_service_unlock_input();
    return ESP_OK;
}

static esp_err_t audio_service_read_microphone_stream_internal(const audio_service_lease_t *lease,
                                                               audio_service_microphone_snapshot_t *snapshot,
                                                               int16_t *samples,
                                                               size_t sample_count,
                                                               bool log_result)
{
    ESP_RETURN_ON_FALSE(samples != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "microphone samples buffer is null");
    ESP_RETURN_ON_FALSE(sample_count > 0, ESP_ERR_INVALID_ARG, TAG,
                        "microphone sample count must be positive");
    ESP_RETURN_ON_FALSE(audio_service_lock_input(), ESP_ERR_NO_MEM, TAG,
                        "audio I/O mutex unavailable");
    if (!s_microphone_stream_open || !audio_service_lease_is_current(lease)) {
        audio_service_unlock_input();
        ESP_LOGE(TAG, "microphone stream or lease is stale");
        return ESP_ERR_INVALID_STATE;
    }

    size_t bytes_read = sample_count * sizeof(int16_t);
    memset(samples, 0, bytes_read);
    int ret = esp_codec_dev_read(s_microphone_codec, samples, bytes_read);
    if (ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "failed to read microphone samples: %d", ret);
        audio_service_unlock_input();
        return ESP_FAIL;
    }

    audio_service_process_capture_samples(samples, sample_count, log_result);
    audio_service_fill_snapshot(snapshot);
    audio_service_unlock_input();
    return ESP_OK;
}

esp_err_t audio_service_read_microphone_stream(const audio_service_lease_t *lease,
                                               audio_service_microphone_snapshot_t *snapshot)
{
    return audio_service_read_microphone_stream_internal(lease,
                                                         snapshot,
                                                         s_capture_buffer,
                                                         sizeof(s_capture_buffer) / sizeof(s_capture_buffer[0]),
                                                         false);
}

esp_err_t audio_service_read_microphone_samples(const audio_service_lease_t *lease,
                                                int16_t *samples,
                                                size_t sample_count,
                                                audio_service_microphone_snapshot_t *snapshot)
{
    return audio_service_read_microphone_stream_internal(lease, snapshot, samples, sample_count, false);
}

esp_err_t audio_service_end_microphone_stream(audio_service_lease_t *lease)
{
    ESP_RETURN_ON_FALSE(audio_service_lock_input(), ESP_ERR_NO_MEM, TAG,
                        "audio I/O mutex unavailable");
    if (!s_microphone_stream_open || !audio_service_lease_is_current(lease)) {
        audio_service_unlock_input();
        ESP_LOGE(TAG, "microphone stream or lease is stale");
        return ESP_ERR_INVALID_STATE;
    }

    s_microphone_stream_open = false;
    audio_service_unlock_input();
    const bool released = audio_service_finish_action(lease);
    if (!released) {
        ESP_LOGE(TAG, "microphone lease release failed");
        return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}

static esp_err_t audio_service_capture_microphone(bool log_result)
{
    audio_service_lease_t lease = {0};
    ESP_RETURN_ON_ERROR(audio_service_begin_microphone_stream(
                            log_result ? AUDIO_SERVICE_OWNER_MICROPHONE_CAPTURE
                                       : AUDIO_SERVICE_OWNER_MICROPHONE_POLL,
                            &lease),
                        TAG,
                        "failed to begin microphone stream");

    esp_err_t err = audio_service_read_microphone_stream_internal(&lease,
                                                                  NULL,
                                                                  s_capture_buffer,
                                                                  sizeof(s_capture_buffer) / sizeof(s_capture_buffer[0]),
                                                                  log_result);
    esp_err_t close_err = audio_service_end_microphone_stream(&lease);
    if (err == ESP_OK && close_err != ESP_OK) {
        err = close_err;
    }
    return err;
}

esp_err_t audio_service_capture_microphone_sample(void)
{
    return audio_service_capture_microphone(true);
}

static void audio_service_fill_speaker_snapshot(audio_service_speaker_snapshot_t *snapshot)
{
    if (snapshot == NULL) return;
    taskENTER_CRITICAL(&s_state_lock);
    const bool output_faulted = s_output_lease_state.faulted;
    taskEXIT_CRITICAL(&s_state_lock);
    snapshot->ready = s_state.speaker_ready && !output_faulted;
    snapshot->frames_written = s_state.speaker_frames_written;
    snapshot->bytes_written = s_state.speaker_bytes_written;
}

esp_err_t audio_service_begin_speaker_stream(audio_service_owner_t owner,
                                             uint8_t volume_percent,
                                             audio_service_lease_t *lease)
{
    ESP_RETURN_ON_FALSE(lease != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "speaker lease output is null");
    ESP_RETURN_ON_FALSE(owner == AUDIO_SERVICE_OWNER_VOICE_PLAYBACK,
                        ESP_ERR_INVALID_ARG, TAG, "speaker stream owner is not allowed");
    ESP_RETURN_ON_FALSE(volume_percent <= 100U, ESP_ERR_INVALID_ARG, TAG,
                        "speaker volume is invalid");
    ESP_RETURN_ON_ERROR(audio_service_init(), TAG, "lazy audio init failed");
    ESP_RETURN_ON_FALSE(s_speaker_codec != NULL && s_duplex_codec_open,
                        ESP_ERR_INVALID_STATE, TAG,
                        "speaker codec unavailable");
    ESP_RETURN_ON_FALSE(audio_service_try_begin_action(owner, lease), ESP_ERR_INVALID_STATE, TAG,
                        "speaker action already running");
    if (!audio_service_lock_output()) {
        (void)audio_service_finish_action(lease);
        return ESP_ERR_NO_MEM;
    }
    int ret = esp_codec_dev_set_out_vol(s_speaker_codec, volume_percent);
    if (ret == ESP_CODEC_DEV_OK) ret = esp_codec_dev_set_out_mute(s_speaker_codec, false);
    if (ret != ESP_CODEC_DEV_OK) {
        audio_service_unlock_output();
        (void)audio_service_quarantine_action(lease);
        ESP_LOGE(TAG, "speaker stream enable failed and output plane was quarantined: %d", ret);
        return ESP_FAIL;
    }
    s_speaker_stream_open = true;
    s_state.speaker_frames_written = 0U;
    s_state.speaker_bytes_written = 0U;
    audio_service_unlock_output();
    return ESP_OK;
}

esp_err_t audio_service_write_speaker_samples(const audio_service_lease_t *lease,
                                              const int16_t *samples,
                                              size_t sample_count,
                                              audio_service_speaker_snapshot_t *snapshot)
{
    ESP_RETURN_ON_FALSE(samples != NULL && sample_count > 0U && sample_count <= 320U,
                        ESP_ERR_INVALID_ARG, TAG, "speaker PCM frame is invalid");
    ESP_RETURN_ON_FALSE(audio_service_lock_output(), ESP_ERR_NO_MEM, TAG,
                        "speaker I/O mutex unavailable");
    if (!s_speaker_stream_open || !audio_service_lease_is_current(lease)) {
        audio_service_unlock_output();
        return ESP_ERR_INVALID_STATE;
    }
    const size_t bytes = sample_count * sizeof(int16_t);
    int ret = esp_codec_dev_write(s_speaker_codec, (void *)samples, bytes);
    if (ret == ESP_CODEC_DEV_OK) {
        s_state.speaker_frames_written++;
        s_state.speaker_bytes_written += (uint32_t)bytes;
        audio_service_fill_speaker_snapshot(snapshot);
    }
    audio_service_unlock_output();
    return ret == ESP_CODEC_DEV_OK ? ESP_OK : ESP_FAIL;
}

esp_err_t audio_service_end_speaker_stream(audio_service_lease_t *lease)
{
    ESP_RETURN_ON_FALSE(audio_service_lock_output(), ESP_ERR_NO_MEM, TAG,
                        "speaker I/O mutex unavailable");
    if (!s_speaker_stream_open || !audio_service_lease_is_current(lease)) {
        audio_service_unlock_output();
        return ESP_ERR_INVALID_STATE;
    }
    int close_ret = esp_codec_dev_set_out_mute(s_speaker_codec, true);
    s_speaker_stream_open = false;
    audio_service_unlock_output();
    const bool released = close_ret == ESP_CODEC_DEV_OK
                              ? audio_service_finish_action(lease)
                              : audio_service_quarantine_action(lease);
    if (!released) return ESP_ERR_INVALID_STATE;
    if (close_ret != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "speaker mute failed and output plane was quarantined: %d", close_ret);
        return ESP_FAIL;
    }
    return ESP_OK;
}

void audio_service_get_speaker_snapshot(audio_service_speaker_snapshot_t *snapshot)
{
    audio_service_fill_speaker_snapshot(snapshot);
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

    ret = audio_service_open_persistent_duplex();
    if (ret != ESP_OK) {
        s_state.speaker_ready = false;
        s_state.microphone_ready = false;
        ESP_LOGE(TAG, "persistent duplex codec open failed: %s", esp_err_to_name(ret));
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
    busy = s_input_lease_state.active || s_input_lease_state.faulted ||
           s_output_lease_state.active || s_output_lease_state.faulted;
    taskEXIT_CRITICAL(&s_state_lock);

    return busy;
}

const char *audio_service_current_owner(void)
{
    audio_service_owner_t owner;
    bool faulted;

    taskENTER_CRITICAL(&s_state_lock);
    owner = s_output_lease_state.active ? s_output_lease_state.owner : s_input_lease_state.owner;
    faulted = s_input_lease_state.faulted || s_output_lease_state.faulted;
    taskEXIT_CRITICAL(&s_state_lock);

    return faulted ? "faulted" : audio_service_owner_name(owner);
}

uint32_t audio_service_current_generation(void)
{
    uint32_t generation;
    taskENTER_CRITICAL(&s_state_lock);
    generation = s_output_lease_state.active ? s_output_lease_state.generation
                 : s_input_lease_state.active ? s_input_lease_state.generation : 0U;
    taskEXIT_CRITICAL(&s_state_lock);
    return generation;
}

bool audio_service_faulted(void)
{
    bool faulted;
    taskENTER_CRITICAL(&s_state_lock);
    faulted = s_input_lease_state.faulted || s_output_lease_state.faulted;
    taskEXIT_CRITICAL(&s_state_lock);
    return faulted;
}

bool audio_service_speaker_faulted(void)
{
    bool faulted;
    taskENTER_CRITICAL(&s_state_lock);
    faulted = s_output_lease_state.faulted;
    taskEXIT_CRITICAL(&s_state_lock);
    return faulted;
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
             "audio initialized=%s busy=%s owner=%s speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s mic_bytes=%" PRIu32 " mic_peak_abs=%u mic_mean_abs=%" PRIu32 " mic_nonzero=%" PRIu32 " speaker_frames=%" PRIu32 " speaker_bytes=%" PRIu32,
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
             s_state.microphone_nonzero_samples,
             s_state.speaker_frames_written,
             s_state.speaker_bytes_written);
}
