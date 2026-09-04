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
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "esp_mn_models.h"
#include "esp_mn_speech_commands.h"
#include "model_path.h"

static const char *TAG = "sr_service";
#define SR_SERVICE_INPUT_FORMAT "M"
#define SR_SERVICE_MODEL_PATH "model"
#define SR_SERVICE_COMMAND_TIMEOUT_MS 8000
#define SR_SERVICE_RUNTIME_SELFTEST_FRAMES 6
#define SR_SERVICE_RUNTIME_LOG_INTERVAL_FRAMES 64
#define SR_SERVICE_RUNTIME_TASK_STACK_SIZE 6144
#define SR_SERVICE_WAKE_DETECTED_HOLD_MS 1500
#define SR_SERVICE_AWAKE_HOLD_MS 8000
#define SR_SERVICE_VAD_EARLY_END_MIN_MS 1200U
#define SR_SERVICE_VAD_TRAILING_SILENCE_MS 1200U
#define SR_SERVICE_PLAYBACK_WAKE_RESUME_GUARD_MS 400U
#define SR_SERVICE_CAPTURE_GATE_RETRY_MS 20
#define SR_SERVICE_CAPTURE_GATE_MAX_WAIT_MS 3500
#define SR_SERVICE_PREROLL_MS 800U
#define SR_SERVICE_SAMPLE_RATE_HZ 16000U
#define SR_SERVICE_PREROLL_SAMPLES \
    ((SR_SERVICE_SAMPLE_RATE_HZ * SR_SERVICE_PREROLL_MS) / 1000U)
#define SR_SERVICE_VAD_EARLY_END_MIN_SAMPLES \
    ((SR_SERVICE_SAMPLE_RATE_HZ * SR_SERVICE_VAD_EARLY_END_MIN_MS) / 1000U)
#define SR_SERVICE_VAD_TRAILING_SILENCE_SAMPLES \
    ((SR_SERVICE_SAMPLE_RATE_HZ * SR_SERVICE_VAD_TRAILING_SILENCE_MS) / 1000U)

_Static_assert(SR_SERVICE_VAD_EARLY_END_MIN_MS + SR_SERVICE_VAD_TRAILING_SILENCE_MS <
                   SR_SERVICE_AWAKE_HOLD_MS,
               "VAD endpoint must remain below the hard command deadline");

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
    {SR_SERVICE_COMMAND_ID_LIGHT_ON, "light on", "LiT nN"},
    {SR_SERVICE_COMMAND_ID_LIGHT_OFF, "light off", "LiT eF"},
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
static TickType_t s_capture_gate_deadline;
static TickType_t s_awake_deadline;
static sr_service_capture_listener_t s_capture_listener;
static bool s_capture_active;
static int16_t *s_preroll;
static size_t s_preroll_start;
static size_t s_preroll_count;
static bool s_preroll_armed;
static bool s_preroll_draining;
static size_t s_preroll_flush_target;
static size_t s_preroll_flushed_current;
static uint64_t s_preroll_started_at_us;
static bool s_preroll_rearm_requested;
static size_t s_capture_live_samples;
static size_t s_capture_trailing_silence_samples;
static bool s_capture_speech_seen;
static bool s_playback_active_requested;
static int64_t s_playback_wake_resume_after_us;
static bool s_playback_wake_gate_active;

static portMUX_TYPE s_status_lock = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_preroll_signal_lock = portMUX_INITIALIZER_UNLOCKED;
static portMUX_TYPE s_playback_signal_lock = portMUX_INITIALIZER_UNLOCKED;

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
static bool sr_service_set_wakenet_enabled(bool enabled, const char *reason);
static void sr_service_apply_playback_wake_gate(void);
static uint32_t sr_service_pcm_peak(const int16_t *samples, size_t sample_count);
static void sr_service_log_command_window(const char *outcome);
static bool sr_service_deadline_reached(TickType_t now, TickType_t deadline);
static void sr_service_finish_command_window(const char *outcome,
                                             const char *status_text,
                                             const char *reason);
static void sr_service_preroll_reset(void);
static void sr_service_preroll_append(const int16_t *samples, size_t sample_count);
static void sr_service_preroll_start_drain(uint64_t captured_at_us);
static void sr_service_preroll_drain_with_live(const int16_t *samples,
                                               size_t sample_count,
                                               uint64_t captured_at_us);

void sr_service_rearm_preroll_after_wake_prompt(void)
{
    taskENTER_CRITICAL(&s_preroll_signal_lock);
    s_preroll_rearm_requested = true;
    taskEXIT_CRITICAL(&s_preroll_signal_lock);
}

void sr_service_set_playback_active(bool active)
{
    const int64_t now_us = esp_timer_get_time();
    taskENTER_CRITICAL(&s_playback_signal_lock);
    s_playback_active_requested = active;
    s_playback_wake_resume_after_us =
        active ? 0 : now_us + (int64_t)SR_SERVICE_PLAYBACK_WAKE_RESUME_GUARD_MS * 1000LL;
    taskEXIT_CRITICAL(&s_playback_signal_lock);
}

static void sr_service_preroll_reset(void)
{
    if (s_preroll != NULL) {
        memset(s_preroll, 0, SR_SERVICE_PREROLL_SAMPLES * sizeof(*s_preroll));
    }
    s_preroll_start = 0U;
    s_preroll_count = 0U;
    s_preroll_armed = false;
    s_preroll_draining = false;
    s_preroll_flush_target = 0U;
    s_preroll_flushed_current = 0U;
    s_preroll_started_at_us = 0U;
    SR_STATUS_MUTATE(s_status.preroll_buffered_samples = 0U;);
}

static void sr_service_preroll_append(const int16_t *samples, size_t sample_count)
{
    if (s_preroll == NULL || !s_preroll_armed || samples == NULL || sample_count == 0U) return;
    if (sample_count >= SR_SERVICE_PREROLL_SAMPLES) {
        samples += sample_count - SR_SERVICE_PREROLL_SAMPLES;
        sample_count = SR_SERVICE_PREROLL_SAMPLES;
        memcpy(s_preroll, samples, SR_SERVICE_PREROLL_SAMPLES * sizeof(*s_preroll));
        s_preroll_start = 0U;
        s_preroll_count = SR_SERVICE_PREROLL_SAMPLES;
    } else {
        for (size_t index = 0U; index < sample_count; ++index) {
            if (s_preroll_count < SR_SERVICE_PREROLL_SAMPLES) {
                size_t write = (s_preroll_start + s_preroll_count) %
                               SR_SERVICE_PREROLL_SAMPLES;
                s_preroll[write] = samples[index];
                s_preroll_count++;
            } else {
                s_preroll[s_preroll_start] = samples[index];
                s_preroll_start = (s_preroll_start + 1U) % SR_SERVICE_PREROLL_SAMPLES;
            }
        }
    }
    SR_STATUS_MUTATE(s_status.preroll_buffered_samples = (uint32_t)s_preroll_count;);
}

static void sr_service_preroll_start_drain(uint64_t captured_at_us)
{
    const size_t count = s_preroll_count;
    if (count == 0U || s_capture_listener.offer_pcm == NULL) {
        sr_service_preroll_reset();
        return;
    }
    const uint64_t duration_us = (uint64_t)count * 1000000ULL /
                                 SR_SERVICE_SAMPLE_RATE_HZ;
    s_preroll_armed = false;
    s_preroll_draining = true;
    s_preroll_flush_target = count;
    s_preroll_flushed_current = 0U;
    s_preroll_started_at_us = captured_at_us > duration_us
                                  ? captured_at_us - duration_us : 0U;
}

static void sr_service_preroll_drain_with_live(const int16_t *samples,
                                               size_t sample_count,
                                               uint64_t captured_at_us)
{
    if (!s_preroll_draining || samples == NULL || sample_count == 0U ||
        s_capture_listener.offer_pcm == NULL) {
        if (samples != NULL && sample_count > 0U &&
            s_capture_listener.offer_pcm != NULL) {
            s_capture_listener.offer_pcm(s_capture_listener.context, samples,
                                         sample_count, captured_at_us);
        }
        return;
    }

    size_t drain_remaining = sample_count * 2U;
    if (drain_remaining > s_preroll_count) drain_remaining = s_preroll_count;
    while (drain_remaining > 0U) {
        size_t contiguous = SR_SERVICE_PREROLL_SAMPLES - s_preroll_start;
        if (contiguous > drain_remaining) contiguous = drain_remaining;
        const uint64_t chunk_at_us = s_preroll_started_at_us +
            (uint64_t)s_preroll_flushed_current * 1000000ULL /
                SR_SERVICE_SAMPLE_RATE_HZ;
        s_capture_listener.offer_pcm(s_capture_listener.context,
                                     s_preroll + s_preroll_start,
                                     contiguous, chunk_at_us);
        s_preroll_start = (s_preroll_start + contiguous) % SR_SERVICE_PREROLL_SAMPLES;
        s_preroll_count -= contiguous;
        s_preroll_flushed_current += contiguous;
        drain_remaining -= contiguous;
    }

    if (s_preroll_count == 0U) {
        const size_t flushed = s_preroll_flushed_current;
        const size_t target = s_preroll_flush_target;
        s_preroll_draining = false;
        SR_STATUS_MUTATE({
            s_status.preroll_buffered_samples = 0U;
            s_status.preroll_flushed_samples += (uint32_t)target;
            s_status.preroll_flush_count++;
        });
        ESP_LOGW(TAG,
                 "VERIFY:voice:preroll:PASS buffered_ms=%u flushed_samples=%u catchup_samples=%u mode=paced",
                 (unsigned)((target * 1000U) / SR_SERVICE_SAMPLE_RATE_HZ),
                 (unsigned)target, (unsigned)flushed);
        s_capture_listener.offer_pcm(s_capture_listener.context, samples,
                                     sample_count, captured_at_us);
        memset(s_preroll, 0, SR_SERVICE_PREROLL_SAMPLES * sizeof(*s_preroll));
        s_preroll_start = 0U;
        s_preroll_flush_target = 0U;
        s_preroll_flushed_current = 0U;
        s_preroll_started_at_us = 0U;
        return;
    }

    /* Two old samples are released for every new sample. The freed half keeps
     * live audio in chronological order until the backlog catches up. */
    for (size_t index = 0U; index < sample_count; ++index) {
        const size_t write = (s_preroll_start + s_preroll_count) %
                             SR_SERVICE_PREROLL_SAMPLES;
        s_preroll[write] = samples[index];
        s_preroll_count++;
    }
    SR_STATUS_MUTATE(s_status.preroll_buffered_samples = (uint32_t)s_preroll_count;);
}

static uint32_t sr_service_pcm_peak(const int16_t *samples, size_t sample_count)
{
    uint32_t peak = 0;

    if (samples == NULL) {
        return 0;
    }

    for (size_t i = 0; i < sample_count; ++i) {
        const int32_t sample = samples[i];
        const uint32_t magnitude = (uint32_t)(sample < 0 ? -sample : sample);
        if (magnitude > peak) {
            peak = magnitude;
        }
    }
    return peak;
}

static void sr_service_log_command_window(const char *outcome)
{
    uint32_t frames;
    uint32_t vad_speech;
    uint32_t detect_calls;
    uint32_t raw_peak;
    uint32_t afe_peak;

    taskENTER_CRITICAL(&s_status_lock);
    frames = s_status.command_window_frame_count;
    vad_speech = s_status.command_window_vad_speech_count;
    detect_calls = s_status.command_window_detect_call_count;
    raw_peak = s_status.command_window_raw_peak;
    afe_peak = s_status.command_window_afe_peak;
    taskEXIT_CRITICAL(&s_status_lock);

    ESP_LOGW(TAG,
             "DIAG:phase5a:command_window outcome=%s frames=%" PRIu32
             " vad_speech=%" PRIu32 " detect_calls=%" PRIu32
             " raw_peak=%" PRIu32 " afe_peak=%" PRIu32,
             outcome != NULL ? outcome : "unknown",
             frames,
             vad_speech,
             detect_calls,
             raw_peak,
             afe_peak);
}

static bool sr_service_deadline_reached(TickType_t now, TickType_t deadline)
{
    return (int32_t)(now - deadline) >= 0;
}

static void sr_service_finish_command_window(const char *outcome,
                                             const char *status_text,
                                             const char *reason)
{
    sr_service_preroll_reset();
    if (s_capture_active) {
        s_capture_active = false;
        if (s_capture_listener.end_capture != NULL) {
            s_capture_listener.end_capture(s_capture_listener.context,
                                           reason != NULL ? reason : "command window ended",
                                           (uint64_t)esp_timer_get_time());
        }
    }
    SR_STATUS_MUTATE(s_status.status_text = status_text;);
    sr_service_log_command_window(outcome);
    sr_service_set_wakenet_enabled(true, reason);
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING, reason);
}

static void sr_service_apply_board_afe_policy(afe_config_t *afe_config)
{
    if (afe_config == NULL) {
        return;
    }

    /*
     * The P4Home board exposes one microphone and does not feed a playback
     * reference channel into ESP-SR. Keep AEC and its unused reference path
     * disabled. The Phase 5A hardware gate observed ESP-SR 2.1.4's WebRTC AGC
     * path fault while accessing an ESP32-P4 LP-RAM address. The pointer's
     * origin is not yet proven. Phase 5A does not require AGC, so isolate that
     * path and keep the remaining AFE allocations PSRAM-first.
     */
    afe_config->aec_init = false;
    afe_config->agc_init = false;
    afe_config->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;
}

static bool sr_service_board_afe_policy_valid(const afe_config_t *afe_config)
{
    return afe_config != NULL && !afe_config->aec_init && !afe_config->agc_init &&
           afe_config->memory_alloc_mode == AFE_MEMORY_ALLOC_MORE_PSRAM &&
           afe_config->pcm_config.total_ch_num == 1 && afe_config->pcm_config.mic_num == 1 &&
           afe_config->pcm_config.ref_num == 0 && afe_config->pcm_config.mic_ids != NULL &&
           afe_config->pcm_config.mic_ids[0] == 0;
}

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

    ESP_LOGW(TAG,
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

static bool sr_service_set_wakenet_enabled(bool enabled, const char *reason)
{
    if (s_runtime_afe_iface == NULL || s_runtime_afe_data == NULL) {
        return false;
    }

    int state = enabled ? s_runtime_afe_iface->enable_wakenet(s_runtime_afe_data)
                        : s_runtime_afe_iface->disable_wakenet(s_runtime_afe_data);
    if (state < 0) {
        ESP_LOGW(TAG,
                 "failed to %s WakeNet reason=%s",
                 enabled ? "enable" : "disable",
                 reason != NULL ? reason : "unspecified");
        return false;
    }

    ESP_LOGI(TAG,
             "WakeNet %s reason=%s state=%d",
             enabled ? "enabled" : "disabled",
             reason != NULL ? reason : "unspecified",
             state);
    return true;
}

static void sr_service_apply_playback_wake_gate(void)
{
    bool playback_active;
    int64_t resume_after_us;
    taskENTER_CRITICAL(&s_playback_signal_lock);
    playback_active = s_playback_active_requested;
    resume_after_us = s_playback_wake_resume_after_us;
    taskEXIT_CRITICAL(&s_playback_signal_lock);

    if (playback_active && !s_playback_wake_gate_active) {
        if (sr_service_set_wakenet_enabled(false, "assistant playback active")) {
            s_playback_wake_gate_active = true;
            ESP_LOGW(TAG,
                     "VERIFY:voice:half_duplex:PASS action=wake_suppressed guard_ms=%u",
                     (unsigned)SR_SERVICE_PLAYBACK_WAKE_RESUME_GUARD_MS);
        }
        return;
    }

    if (!playback_active && s_playback_wake_gate_active && resume_after_us > 0 &&
        esp_timer_get_time() >= resume_after_us &&
        sr_service_set_wakenet_enabled(true, "assistant playback guard elapsed")) {
        s_playback_wake_gate_active = false;
        ESP_LOGW(TAG,
                 "VERIFY:voice:half_duplex:PASS action=wake_resumed guard_ms=%u",
                 (unsigned)SR_SERVICE_PLAYBACK_WAKE_RESUME_GUARD_MS);
    }
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
    SR_STATUS_MUTATE({
        s_status.command_model_ready = false;
        s_status.command_set_ready = false;
        s_status.command_chunksize = 0;
        s_status.command_model_name = "none";
    });
}

static esp_err_t sr_service_run_runtime_selftest(esp_afe_sr_iface_t *afe_iface,
                                                 afe_config_t *afe_config)
{
    audio_service_lease_t audio_lease = {0};
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

    err = audio_service_begin_microphone_stream(AUDIO_SERVICE_OWNER_SR_SELFTEST, &audio_lease);
    if (err != ESP_OK) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE runtime could not open microphone stream";);
        free(mic_frame);
        free(afe_input);
        goto cleanup;
    }

    for (int frame = 0; frame < SR_SERVICE_RUNTIME_SELFTEST_FRAMES; ++frame) {
        memset(afe_input, 0, (size_t)feed_chunksize * (size_t)feed_channels * sizeof(int16_t));
        err = audio_service_read_microphone_samples(&audio_lease,
                                                    mic_frame,
                                                    (size_t)feed_chunksize,
                                                    NULL);
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

    esp_err_t stream_close_err = audio_service_end_microphone_stream(&audio_lease);
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
    audio_service_lease_t audio_lease = {0};

    if (feed_chunksize <= 0 || feed_channels <= 0) {
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop geometry invalid";);
        goto cleanup;
    }

    mic_frame = calloc((size_t)feed_chunksize, sizeof(int16_t));
    afe_input = calloc((size_t)feed_chunksize * (size_t)feed_channels, sizeof(int16_t));
    s_preroll = heap_caps_calloc(SR_SERVICE_PREROLL_SAMPLES, sizeof(*s_preroll),
                                 MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (mic_frame == NULL || afe_input == NULL || s_preroll == NULL) {
        SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop buffer allocation failed";);
        goto cleanup;
    }

    err = audio_service_begin_microphone_stream(AUDIO_SERVICE_OWNER_SR_RUNTIME, &audio_lease);
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
        err = audio_service_read_microphone_samples(&audio_lease,
                                                    mic_frame,
                                                    (size_t)feed_chunksize,
                                                    NULL);
        if (err != ESP_OK) {
            SR_STATUS_MUTATE(s_status.status_text = "ESP-SR runtime loop microphone read failed";);
            break;
        }

        const uint32_t raw_peak = sr_service_pcm_peak(mic_frame, (size_t)feed_chunksize);

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
        const TickType_t state_now = xTaskGetTickCount();

        /* Apply cross-task playback signals before interpreting this fetched
         * frame. A frame already captured from the speaker is ignored below
         * as soon as the half-duplex gate becomes active. */
        sr_service_apply_playback_wake_gate();

        taskENTER_CRITICAL(&s_preroll_signal_lock);
        const bool rearm_preroll = s_preroll_rearm_requested;
        s_preroll_rearm_requested = false;
        taskEXIT_CRITICAL(&s_preroll_signal_lock);
        if (rearm_preroll &&
            sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_WAKE_DETECTED) {
            sr_service_preroll_reset();
            s_preroll_armed = true;
        }

        /*
         * Advance timed states before inspecting the fetched frame. This keeps
         * NULL fetches from trapping WAKE_DETECTED and prevents an expired
         * command window from consuming a late frame or applying an action.
         */
        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_WAKE_DETECTED &&
            sr_service_deadline_reached(state_now, s_wake_detected_deadline)) {
            const bool capture_ready = s_capture_listener.ready_for_capture == NULL ||
                                       s_capture_listener.ready_for_capture(
                                           s_capture_listener.context);
            if (!capture_ready) {
                if (sr_service_deadline_reached(state_now, s_capture_gate_deadline)) {
                    sr_service_preroll_reset();
                    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING,
                                               "barge-in capture gate timeout");
                    sr_service_set_wakenet_enabled(true, "barge-in capture gate timeout");
                    SR_STATUS_MUTATE(s_status.status_text =
                                         "Playback did not stop; capture suppressed";);
                    continue;
                }
                s_wake_detected_deadline = state_now +
                                           pdMS_TO_TICKS(SR_SERVICE_CAPTURE_GATE_RETRY_MS);
            } else {
                const bool suppress_wake =
                    s_capture_listener.suppress_wake_session != NULL &&
                    s_capture_listener.suppress_wake_session(
                        s_capture_listener.context);
                if (suppress_wake) {
                    sr_service_preroll_reset();
                    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_LISTENING,
                                               "wake suppressed by readiness gate");
                    sr_service_set_wakenet_enabled(true, "wake readiness gate complete");
                    SR_STATUS_MUTATE(s_status.status_text =
                                         "Voice unavailable until Home Assistant is ready";);
                    sr_service_publish_voice_status(
                        "Voice waiting for Home Assistant connection.");
                    continue;
                }
                s_awake_deadline = state_now + pdMS_TO_TICKS(SR_SERVICE_AWAKE_HOLD_MS);
                SR_STATUS_MUTATE({
                    s_status.awake_session_count++;
                    s_status.command_window_frame_count = 0;
                    s_status.command_window_vad_speech_count = 0;
                    s_status.command_window_detect_call_count = 0;
                    s_status.command_window_raw_peak = 0;
                    s_status.command_window_afe_peak = 0;
                });
                s_capture_live_samples = 0U;
                s_capture_trailing_silence_samples = 0U;
                s_capture_speech_seen = false;
                sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_AWAKE,
                                           "wake detected hold elapsed");
                const uint64_t capture_started_at_us = (uint64_t)esp_timer_get_time();
                if (s_capture_listener.begin_capture != NULL) {
                    s_capture_active = s_capture_listener.begin_capture(
                        s_capture_listener.context, capture_started_at_us);
                }
                if (s_capture_active) sr_service_preroll_start_drain(capture_started_at_us);
                else sr_service_preroll_reset();
                if (s_command_iface != NULL && s_command_model_data != NULL &&
                    sr_status_command_set_ready_get()) {
                    s_command_iface->clean(s_command_model_data);
                    SR_STATUS_MUTATE(s_status.status_text = "Wake acknowledged; awaiting fixed voice command";);
                    sr_service_publish_voice_status("Voice awake: waiting for fixed command.");
                }
            }
        }

        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_AWAKE &&
            sr_service_deadline_reached(state_now, s_awake_deadline)) {
            const bool command_runtime_ready =
                s_command_iface != NULL && s_command_model_data != NULL &&
                sr_status_command_set_ready_get();
            sr_service_finish_command_window(command_runtime_ready ? "deadline" : "deadline_no_runtime",
                                             command_runtime_ready
                                                 ? "Fixed command hard deadline reached"
                                                 : "Wake session expired without command runtime",
                                             command_runtime_ready
                                                 ? "command hard deadline"
                                                 : "awake hold elapsed");
        }

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
        bool wake_just_detected = false;
        if (!s_playback_wake_gate_active &&
            fetch_result->wakeup_state == WAKENET_DETECTED &&
            sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_LISTENING) {
            sr_service_preroll_reset();
            s_preroll_armed = true;
            wake_just_detected = true;
            SR_STATUS_MUTATE(s_status.runtime_wake_event_count++;);
            if (s_capture_listener.wake_detected != NULL) {
                s_capture_listener.wake_detected(s_capture_listener.context,
                                                 (uint64_t)esp_timer_get_time());
            }
            s_wake_detected_deadline = now + pdMS_TO_TICKS(SR_SERVICE_WAKE_DETECTED_HOLD_MS);
            s_capture_gate_deadline = now +
                                      pdMS_TO_TICKS(SR_SERVICE_CAPTURE_GATE_MAX_WAIT_MS);
            sr_service_set_wakenet_enabled(false, "wake detected");
            sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_WAKE_DETECTED, "WakeNet detected");
            SR_STATUS_MUTATE(s_status.status_text = "Wake word detected; opening command window";);
            ESP_LOGI(TAG,
                     "runtime wake event: wake_word_index=%d model_index=%d trigger_channel=%d",
                     fetch_result->wake_word_index,
                     fetch_result->wakenet_model_index,
                     fetch_result->trigger_channel_id);
        }

        if (!wake_just_detected &&
            sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_WAKE_DETECTED &&
            fetch_result->data != NULL && fetch_result->data_size > 0) {
            sr_service_preroll_append(fetch_result->data,
                                      (size_t)fetch_result->data_size / sizeof(int16_t));
        }

        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_AWAKE &&
            s_command_iface != NULL && s_command_model_data != NULL && sr_status_command_set_ready_get()) {
            if (fetch_result->data != NULL && fetch_result->data_size > 0) {
                const int command_samples = fetch_result->data_size / (int)sizeof(int16_t);
                const uint32_t afe_peak = sr_service_pcm_peak(fetch_result->data,
                                                              (size_t)command_samples);
                SR_STATUS_MUTATE({
                    s_status.command_window_frame_count++;
                    if (fetch_result->vad_state == VAD_SPEECH) {
                        s_status.command_window_vad_speech_count++;
                    }
                    if (raw_peak > s_status.command_window_raw_peak) {
                        s_status.command_window_raw_peak = raw_peak;
                    }
                    if (afe_peak > s_status.command_window_afe_peak) {
                        s_status.command_window_afe_peak = afe_peak;
                    }
                });
                const uint32_t mn_chunksize = sr_status_command_chunksize_get();
                if ((uint32_t)command_samples == mn_chunksize) {
                    SR_STATUS_MUTATE(s_status.command_window_detect_call_count++;);
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
                                sr_service_finish_command_window("detected_action_failed",
                                                                 "Fixed command action failed",
                                                                 "command action failed");
                            } else {
                                SR_STATUS_MUTATE(s_status.status_text = "Fixed command action applied";);
                                sr_service_publish_voice_status("Voice command accepted.");
                                sr_service_finish_command_window("detected_action_applied",
                                                                 "Fixed command action applied",
                                                                 "command detected");
                            }
                        } else {
                            sr_service_finish_command_window("detected_empty",
                                                             "MultiNet detected state had no command result",
                                                             "empty command result");
                        }
                    } else if (command_state == ESP_MN_STATE_TIMEOUT) {
                        sr_service_finish_command_window("multinet_timeout",
                                                         "Fixed command window timed out",
                                                         "command timeout");
                    }
                } else if (mn_chunksize > 0U && (uint32_t)command_samples != mn_chunksize) {
                    ESP_LOGW(TAG,
                             "MultiNet chunksize mismatch: afe_fetch=%d multinet=%" PRIu32,
                             command_samples,
                             mn_chunksize);
                }
            }
        }

        /*
         * Offer a frame to the remote transcript path only after the local
         * fixed-command detector has had the opportunity to consume it. A
         * detected local command closes the window above, so its decisive
         * frame is not also offered to the remote transcription path.
         */
        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_AWAKE && s_capture_active &&
            s_capture_listener.offer_pcm != NULL && fetch_result->data != NULL &&
            fetch_result->data_size > 0) {
            const size_t live_samples =
                (size_t)fetch_result->data_size / sizeof(int16_t);
            sr_service_preroll_drain_with_live(
                fetch_result->data,
                live_samples,
                (uint64_t)esp_timer_get_time());
            s_capture_live_samples += live_samples;
            if (fetch_result->vad_state == VAD_SPEECH) {
                s_capture_speech_seen = true;
                s_capture_trailing_silence_samples = 0U;
            } else if (s_capture_speech_seen) {
                s_capture_trailing_silence_samples += live_samples;
            }
        }

        /*
         * The eight-second awake deadline is a hard upper bound, not an
         * endpointing policy. Once live speech has been observed, finish a
         * transport capture after a bounded trailing-silence window. The
         * local fixed-command detector above gets every frame first, and the
         * hard deadline remains the fallback for noise or continuous speech.
         */
        if (sr_status_voice_state_get() == SR_SERVICE_VOICE_STATE_AWAKE &&
            s_capture_active && s_capture_speech_seen &&
            s_capture_live_samples >= SR_SERVICE_VAD_EARLY_END_MIN_SAMPLES &&
            s_capture_trailing_silence_samples >=
                SR_SERVICE_VAD_TRAILING_SILENCE_SAMPLES) {
            sr_service_finish_command_window("vad_silence",
                                             "Voice capture ended after speech",
                                             "vad trailing silence");
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
    if (s_capture_active) {
        s_capture_active = false;
        if (s_capture_listener.end_capture != NULL) {
            s_capture_listener.end_capture(s_capture_listener.context,
                                           "sr runtime stopped",
                                           (uint64_t)esp_timer_get_time());
        }
    }
    SR_STATUS_MUTATE({
        s_status.afe_runtime_ready = false;
        s_status.runtime_loop_started = false;
        s_status.runtime_loop_active = false;
        s_status.wake_state_machine_started = false;
    });
    sr_service_set_wakenet_enabled(true, "runtime loop stopped");
    taskENTER_CRITICAL(&s_playback_signal_lock);
    s_playback_active_requested = false;
    s_playback_wake_resume_after_us = 0;
    taskEXIT_CRITICAL(&s_playback_signal_lock);
    s_playback_wake_gate_active = false;
    sr_service_set_voice_state(SR_SERVICE_VOICE_STATE_INACTIVE, "runtime loop stopped");

    if (stream_open) {
        esp_err_t close_err = audio_service_end_microphone_stream(&audio_lease);
        if (err == ESP_OK && close_err != ESP_OK) {
            err = close_err;
        }
    }

    free(mic_frame);
    free(afe_input);
    heap_caps_free(s_preroll);
    s_preroll = NULL;

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

    /* The selftest instance has already been destroyed; do not expose it as live readiness. */
    SR_STATUS_MUTATE(s_status.afe_runtime_ready = false;);

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
    /*
     * Publish the starting state before the higher-priority task can run. The
     * task owns all later transitions; if it fails immediately, its cleanup
     * remains the last writer and cannot be overwritten by this function.
     */
    SR_STATUS_MUTATE({
        s_status.afe_runtime_ready = true;
        s_status.runtime_loop_started = true;
        s_status.wake_state_machine_started = true;
        s_status.status_text = "ESP-SR runtime loop starting";
    });
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
        SR_STATUS_MUTATE({
            s_status.afe_runtime_ready = false;
            s_status.runtime_loop_started = false;
            s_status.wake_state_machine_started = false;
            s_status.status_text = "ESP-SR runtime loop task create failed";
        });
        return ESP_ERR_NO_MEM;
    }

    return ESP_OK;
}

esp_err_t sr_service_init(void)
{
    if (s_sr_initialized) {
        ESP_LOGI(TAG, "sr service already initialized");
        return ESP_OK;
    }

    memset(&s_status, 0, sizeof(s_status));
    taskENTER_CRITICAL(&s_playback_signal_lock);
    s_playback_active_requested = false;
    s_playback_wake_resume_after_us = 0;
    taskEXIT_CRITICAL(&s_playback_signal_lock);
    s_playback_wake_gate_active = false;
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
    sr_service_apply_board_afe_policy(afe_config);
    if (!sr_service_board_afe_policy_valid(afe_config)) {
        SR_STATUS_MUTATE(s_status.status_text = "AFE board policy or channel geometry invalid";);
        afe_config_free(afe_config);
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }
    ESP_LOGW(TAG, "AFE board policy: input_format=M aec=off agc=off memory=more_psram");

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

esp_err_t sr_service_register_capture_listener(const sr_service_capture_listener_t *listener)
{
    if (listener == NULL || listener->wake_detected == NULL ||
        listener->ready_for_capture == NULL ||
        listener->suppress_wake_session == NULL ||
        listener->begin_capture == NULL || listener->offer_pcm == NULL ||
        listener->end_capture == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_sr_initialized || s_runtime_task != NULL || s_capture_listener.begin_capture != NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    s_capture_listener = *listener;
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
