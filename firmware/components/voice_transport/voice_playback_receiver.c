#include "voice_playback_receiver.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include "audio_service.h"
#include "conversation_service.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sr_service.h"
#include "voice_protocol.h"

static const char *TAG = "voice_playback";

#define PLAYBACK_QUEUE_FRAMES 8U
#define PLAYBACK_TASK_STACK 6144U
#define PLAYBACK_TASK_INTERVAL_MS 5U
#define PLAYBACK_SESSION_TIMEOUT_US 70000000LL
#define PLAYBACK_VOLUME_PERCENT 83U
#define WAKE_PROMPT_VOLUME_PERCENT 75U
#define WAKE_PROMPT_CAPTURE_GUARD_US 800000LL
#define PLAYBACK_MAX_FRAMES 3000U

extern const uint8_t wake_ack_pcm_start[]
    asm("_binary_wake_ack_zh_zai_ne_pcm_start");
extern const uint8_t wake_ack_pcm_end[]
    asm("_binary_wake_ack_zh_zai_ne_pcm_end");
extern const uint8_t wake_connecting_pcm_start[]
    asm("_binary_wake_connecting_zh_pcm_start");
extern const uint8_t wake_connecting_pcm_end[]
    asm("_binary_wake_connecting_zh_pcm_end");

typedef enum {
    PLAYBACK_IDLE = 0,
    PLAYBACK_PREPARING,
    PLAYBACK_OPENING,
    PLAYBACK_READY,
    PLAYBACK_TERMINATING,
} playback_state_t;

typedef struct {
    uint32_t sequence;
    uint16_t sample_count;
    bool eos;
    int16_t samples[VOICE_PROTOCOL_FRAME_SAMPLES];
} playback_frame_t;

typedef struct {
    bool initialized;
    volatile bool running;
    playback_state_t state;
    portMUX_TYPE lock;
    QueueHandle_t queue;
    TaskHandle_t task;
    voice_playback_send_json_fn send_json;
    void *send_context;
    uint8_t session_id[16];
    char session_id_hex[33];
    uint32_t stream_id;
    uint32_t epoch;
    uint32_t max_inflight_frames;
    voice_protocol_rx_tracker_t tracker;
    bool open_requested;
    bool cancel_requested;
    bool fail_requested;
    bool local_barge_in;
    bool barge_in_gate_required;
    bool barge_in_gate_ready;
    bool capture_fenced;
    bool wake_prompt_requested;
    bool wake_prompt_connecting;
    bool wake_prompt_active;
    bool wake_prompt_gate_required;
    bool wake_prompt_gate_ready;
    int64_t wake_prompt_capture_ready_us;
    bool local_stage_pending;
    conversation_local_stage_t pending_local_stage;
    bool suppress_terminal;
    bool eos_control_received;
    bool eos_played;
    bool rx_busy;
    uint32_t session_frames_received;
    uint32_t final_sequence;
    int64_t deadline_us;
    bool speaker_open;
    audio_service_lease_t speaker_lease;
    voice_playback_snapshot_t metrics;
} playback_receiver_state_t;

static playback_receiver_state_t s_playback = {
    .lock = portMUX_INITIALIZER_UNLOCKED,
};

static TickType_t playback_delay_ticks(uint32_t milliseconds)
{
    const TickType_t ticks = pdMS_TO_TICKS(milliseconds);
    return ticks == 0 ? 1 : ticks;
}

static bool json_uint32(const cJSON *item, uint32_t *value, bool positive)
{
    if (!cJSON_IsNumber(item) || item->valuedouble < (positive ? 1.0 : 0.0) ||
        item->valuedouble > (double)UINT32_MAX ||
        (double)(uint32_t)item->valuedouble != item->valuedouble) {
        return false;
    }
    if (value != NULL) *value = (uint32_t)item->valuedouble;
    return true;
}

static bool decode_session_id(const char *hex, uint8_t output[16])
{
    if (hex == NULL || strlen(hex) != 32U) return false;
    bool nonzero = false;
    for (size_t i = 0; i < 16U; ++i) {
        char pair[3] = {hex[i * 2U], hex[i * 2U + 1U], '\0'};
        if (!((pair[0] >= '0' && pair[0] <= '9') || (pair[0] >= 'a' && pair[0] <= 'f')) ||
            !((pair[1] >= '0' && pair[1] <= '9') || (pair[1] >= 'a' && pair[1] <= 'f'))) {
            return false;
        }
        output[i] = (uint8_t)strtoul(pair, NULL, 16);
        nonzero |= output[i] != 0U;
    }
    return nonzero;
}

static bool format_valid(const cJSON *format)
{
    if (!cJSON_IsObject(format) || cJSON_GetArraySize(format) != 5) return false;
    const cJSON *encoding = cJSON_GetObjectItemCaseSensitive(format, "encoding");
    uint32_t rate, channels, bits, samples;
    return cJSON_IsString(encoding) && strcmp(encoding->valuestring, "pcm_s16le") == 0 &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(format, "sample_rate_hz"), &rate, true) &&
           rate == VOICE_PROTOCOL_SAMPLE_RATE_HZ &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(format, "channels"), &channels, true) &&
           channels == VOICE_PROTOCOL_CHANNELS &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(format, "bits_per_sample"), &bits, true) &&
           bits == VOICE_PROTOCOL_BITS_PER_SAMPLE &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(format, "frame_samples"), &samples, true) &&
           samples == VOICE_PROTOCOL_FRAME_SAMPLES;
}

static bool control_base_valid(const cJSON *root)
{
    uint32_t version, stream, epoch;
    const cJSON *session = cJSON_GetObjectItemCaseSensitive(root, "session_id");
    return cJSON_IsObject(root) &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(root, "protocol_version"),
                       &version, true) && version == VOICE_PROTOCOL_VERSION &&
           cJSON_IsString(session) && strcmp(session->valuestring, s_playback.session_id_hex) == 0 &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(root, "stream_id"), &stream, true) &&
           stream == s_playback.stream_id &&
           json_uint32(cJSON_GetObjectItemCaseSensitive(root, "epoch"), &epoch, true) &&
           epoch == s_playback.epoch;
}

static bool cancel_reason_valid(const char *reason)
{
    return reason != NULL &&
           (strcmp(reason, "barge_in") == 0 || strcmp(reason, "timeout") == 0 ||
            strcmp(reason, "disconnect") == 0 || strcmp(reason, "provider_error") == 0 ||
            strcmp(reason, "user") == 0);
}

static bool error_code_valid(const char *code)
{
    return code != NULL &&
           (strcmp(code, "INVALID_MESSAGE") == 0 || strcmp(code, "INVALID_FRAME") == 0 ||
            strcmp(code, "LIMIT_EXCEEDED") == 0 || strcmp(code, "STALE_EPOCH") == 0 ||
            strcmp(code, "UNAVAILABLE") == 0);
}

static void add_identity(cJSON *root, const char *type)
{
    cJSON_AddNumberToObject(root, "protocol_version", VOICE_PROTOCOL_VERSION);
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddStringToObject(root, "session_id", s_playback.session_id_hex);
    cJSON_AddNumberToObject(root, "stream_id", s_playback.stream_id);
    cJSON_AddNumberToObject(root, "epoch", s_playback.epoch);
}

static esp_err_t send_ready(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    add_identity(root, "session.ready");
    cJSON_AddNumberToObject(root, "initial_credit_frames",
                           s_playback.max_inflight_frames < PLAYBACK_QUEUE_FRAMES
                               ? s_playback.max_inflight_frames : PLAYBACK_QUEUE_FRAMES);
    return s_playback.send_json(root, s_playback.send_context);
}

static esp_err_t send_credit(uint32_t sequence)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    add_identity(root, "credit");
    cJSON_AddNumberToObject(root, "ack_sequence", sequence);
    cJSON_AddNumberToObject(root, "grant_frames", 1U);
    return s_playback.send_json(root, s_playback.send_context);
}

static esp_err_t send_cancel(const char *reason)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    add_identity(root, "session.cancel");
    cJSON_AddStringToObject(root, "reason", reason);
    return s_playback.send_json(root, s_playback.send_context);
}

static esp_err_t send_error(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    add_identity(root, "error");
    cJSON_AddStringToObject(root, "code", "UNAVAILABLE");
    return s_playback.send_json(root, s_playback.send_context);
}

static esp_err_t send_closed(const char *status, uint32_t dropped)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    add_identity(root, "session.closed");
    cJSON_AddStringToObject(root, "status", status);
    cJSON_AddNumberToObject(root, "dropped_frames", dropped);
    return s_playback.send_json(root, s_playback.send_context);
}

static void wait_for_rx_idle(void)
{
    for (;;) {
        taskENTER_CRITICAL(&s_playback.lock);
        const bool busy = s_playback.rx_busy;
        taskEXIT_CRITICAL(&s_playback.lock);
        if (!busy) return;
        vTaskDelay(playback_delay_ticks(1U));
    }
}

static bool sync_output_quarantine(void)
{
    const bool faulted = audio_service_speaker_faulted();
    if (faulted) {
        taskENTER_CRITICAL(&s_playback.lock);
        s_playback.metrics.output_quarantined = true;
        taskEXIT_CRITICAL(&s_playback.lock);
    }
    return faulted;
}

static void finish_session(const char *status, bool send_terminal, const char *local_cancel_reason)
{
    taskENTER_CRITICAL(&s_playback.lock);
    if (s_playback.state != PLAYBACK_IDLE) s_playback.state = PLAYBACK_TERMINATING;
    const bool local_barge = s_playback.local_barge_in;
    taskEXIT_CRITICAL(&s_playback.lock);
    wait_for_rx_idle();
    bool close_failed = false;
    if (s_playback.speaker_open) {
        close_failed = audio_service_end_speaker_stream(&s_playback.speaker_lease) != ESP_OK;
        s_playback.speaker_open = false;
        (void)sync_output_quarantine();
    }
    xQueueReset(s_playback.queue);
    taskENTER_CRITICAL(&s_playback.lock);
    const uint32_t dropped = s_playback.tracker.dropped_frames;
    const bool local_cancel = local_cancel_reason != NULL;
    if (close_failed && (strcmp(status, "completed") == 0 || local_cancel)) status = "failed";
    s_playback.open_requested = false;
    s_playback.cancel_requested = false;
    s_playback.fail_requested = false;
    s_playback.local_barge_in = false;
    s_playback.eos_control_received = false;
    s_playback.eos_played = false;
    s_playback.deadline_us = 0;
    s_playback.metrics.active = false;
    if (close_failed) {
        s_playback.metrics.output_quarantined = true;
        s_playback.metrics.speaker_close_failures++;
    }
    s_playback.metrics.dropped_frames += dropped;
    if (strcmp(status, "completed") == 0) s_playback.metrics.sessions_completed++;
    else if (strcmp(status, "cancelled") == 0) s_playback.metrics.sessions_cancelled++;
    else s_playback.metrics.sessions_failed++;
    taskEXIT_CRITICAL(&s_playback.lock);
    esp_err_t terminal_result = ESP_OK;
    if (send_terminal) {
        if (local_cancel) {
            terminal_result = close_failed ? send_error() : send_cancel(local_cancel_reason);
        } else if (strcmp(status, "failed") == 0) {
            terminal_result = send_error();
        }
        if (terminal_result == ESP_OK) {
            (void)send_closed(status, dropped);
        } else {
            ESP_LOGE(TAG, "playback terminal precondition send failed: %s",
                     esp_err_to_name(terminal_result));
        }
    }
    if (local_barge) {
        taskENTER_CRITICAL(&s_playback.lock);
        s_playback.barge_in_gate_ready = send_terminal && !close_failed &&
                                         terminal_result == ESP_OK;
        taskEXIT_CRITICAL(&s_playback.lock);
    }
    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.state = PLAYBACK_IDLE;
    taskEXIT_CRITICAL(&s_playback.lock);
    ESP_LOGW(TAG, "playback terminal status=%s dropped=%" PRIu32, status, dropped);
}

static void fail_session(void)
{
    bool suppress;
    taskENTER_CRITICAL(&s_playback.lock);
    if (s_playback.state != PLAYBACK_IDLE) s_playback.state = PLAYBACK_TERMINATING;
    suppress = s_playback.suppress_terminal;
    taskEXIT_CRITICAL(&s_playback.lock);
    finish_session("failed", !suppress, NULL);
}

static void play_wake_prompt(bool connecting)
{
    audio_service_lease_t lease = {0};
    bool played = false;
    const uint8_t *pcm_start = connecting ? wake_connecting_pcm_start : wake_ack_pcm_start;
    const uint8_t *pcm_end = connecting ? wake_connecting_pcm_end : wake_ack_pcm_end;
    const size_t bytes = (size_t)(pcm_end - pcm_start);
    const size_t samples = bytes / sizeof(int16_t);
    int16_t frame[VOICE_PROTOCOL_FRAME_SAMPLES];

    if (bytes > 0U && (bytes % sizeof(int16_t)) == 0U &&
        audio_service_begin_speaker_stream(AUDIO_SERVICE_OWNER_VOICE_PLAYBACK,
                                           WAKE_PROMPT_VOLUME_PERCENT, &lease) == ESP_OK) {
        size_t offset = 0U;
        played = true;
        while (offset < samples) {
            size_t count = samples - offset;
            if (count > VOICE_PROTOCOL_FRAME_SAMPLES) count = VOICE_PROTOCOL_FRAME_SAMPLES;
            memcpy(frame, pcm_start + offset * sizeof(int16_t),
                   count * sizeof(int16_t));
            if (audio_service_write_speaker_samples(&lease, frame, count, NULL) != ESP_OK) {
                played = false;
                break;
            }
            offset += count;
        }
        if (audio_service_end_speaker_stream(&lease) != ESP_OK) played = false;
    }

    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.wake_prompt_active = false;
    s_playback.wake_prompt_gate_ready = true;
    s_playback.wake_prompt_capture_ready_us = connecting
                                                  ? esp_timer_get_time()
                                                  : esp_timer_get_time() +
                                                        WAKE_PROMPT_CAPTURE_GUARD_US;
    if (played) s_playback.metrics.wake_prompts_played++;
    else s_playback.metrics.wake_prompt_failures++;
    taskEXIT_CRITICAL(&s_playback.lock);
    if (!connecting) {
        sr_service_rearm_preroll_after_wake_prompt();
        (void)conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_LISTENING);
    }
    if (played) {
        if (connecting) {
            ESP_LOGW(TAG,
                     "VERIFY:voice:ha_gate_prompt:PASS phrase=zheng_zai_lian_jie_qing_shao_hou volume=%u samples=%u",
                     (unsigned)WAKE_PROMPT_VOLUME_PERCENT, (unsigned)samples);
        } else {
            ESP_LOGW(TAG,
                     "VERIFY:voice:wake_prompt:PASS phrase=zai_ne volume=%u samples=%u guard_ms=%u",
                     (unsigned)WAKE_PROMPT_VOLUME_PERCENT, (unsigned)samples,
                     (unsigned)(WAKE_PROMPT_CAPTURE_GUARD_US / 1000LL));
        }
    } else {
        ESP_LOGW(TAG, "VERIFY:voice:%s:FAIL reason=local_playback_failed",
                 connecting ? "ha_gate_prompt" : "wake_prompt");
    }
}

static void playback_task(void *argument)
{
    (void)argument;
    const TickType_t interval_ticks = playback_delay_ticks(PLAYBACK_TASK_INTERVAL_MS);
    while (s_playback.running) {
        bool open_requested, cancel_requested, fail_requested, suppress;
        playback_state_t state;
        int64_t deadline;
        taskENTER_CRITICAL(&s_playback.lock);
        open_requested = s_playback.open_requested;
        if (open_requested) s_playback.open_requested = false;
        cancel_requested = s_playback.cancel_requested;
        fail_requested = s_playback.fail_requested;
        suppress = s_playback.suppress_terminal;
        state = s_playback.state;
        deadline = s_playback.deadline_us;
        taskEXIT_CRITICAL(&s_playback.lock);

        taskENTER_CRITICAL(&s_playback.lock);
        const bool prompt_can_start = s_playback.wake_prompt_requested &&
                                      s_playback.state == PLAYBACK_IDLE &&
                                      !s_playback.wake_prompt_active;
        const bool prompt_connecting = s_playback.wake_prompt_connecting;
        if (prompt_can_start) {
            s_playback.wake_prompt_requested = false;
            s_playback.wake_prompt_active = true;
        }
        taskEXIT_CRITICAL(&s_playback.lock);
        if (prompt_can_start) {
            (void)conversation_service_set_local_stage(
                prompt_connecting ? CONVERSATION_LOCAL_STAGE_CONNECTING
                                  : CONVERSATION_LOCAL_STAGE_PROMPTING);
            play_wake_prompt(prompt_connecting);
            continue;
        }

        taskENTER_CRITICAL(&s_playback.lock);
        const bool local_stage_pending = s_playback.local_stage_pending;
        const conversation_local_stage_t pending_local_stage =
            s_playback.pending_local_stage;
        s_playback.local_stage_pending = false;
        taskEXIT_CRITICAL(&s_playback.lock);
        if (local_stage_pending) {
            (void)conversation_service_set_local_stage(pending_local_stage);
        }

        if (open_requested && state == PLAYBACK_OPENING) {
            if (audio_service_begin_speaker_stream(AUDIO_SERVICE_OWNER_VOICE_PLAYBACK,
                                                   PLAYBACK_VOLUME_PERCENT,
                                                   &s_playback.speaker_lease) != ESP_OK) {
                (void)sync_output_quarantine();
                fail_session();
                continue;
            }
            s_playback.speaker_open = true;
            taskENTER_CRITICAL(&s_playback.lock);
            const bool still_opening = s_playback.state == PLAYBACK_OPENING &&
                                       !s_playback.cancel_requested;
            if (still_opening) s_playback.state = PLAYBACK_READY;
            taskEXIT_CRITICAL(&s_playback.lock);
            if (still_opening) {
                if (send_ready() != ESP_OK) fail_session();
            }
            continue;
        }

        if (cancel_requested && state != PLAYBACK_IDLE) {
            taskENTER_CRITICAL(&s_playback.lock);
            const bool local_barge = s_playback.local_barge_in;
            taskEXIT_CRITICAL(&s_playback.lock);
            finish_session("cancelled", !suppress,
                           local_barge ? "barge_in" : NULL);
            continue;
        }

        if (fail_requested && state != PLAYBACK_IDLE) {
            fail_session();
            continue;
        }

        if (state != PLAYBACK_IDLE && deadline > 0 && esp_timer_get_time() >= deadline) {
            taskENTER_CRITICAL(&s_playback.lock);
            if (s_playback.state != PLAYBACK_IDLE) s_playback.state = PLAYBACK_TERMINATING;
            taskEXIT_CRITICAL(&s_playback.lock);
            finish_session("cancelled", !suppress, "timeout");
            continue;
        }

        if (state == PLAYBACK_READY) {
            playback_frame_t frame;
            if (xQueueReceive(s_playback.queue, &frame, interval_ticks) == pdTRUE) {
                if (audio_service_write_speaker_samples(&s_playback.speaker_lease,
                                                        frame.samples,
                                                        frame.sample_count,
                                                        NULL) != ESP_OK) {
                    (void)sync_output_quarantine();
                    fail_session();
                    continue;
                }
                taskENTER_CRITICAL(&s_playback.lock);
                s_playback.metrics.frames_played++;
                s_playback.metrics.bytes_played += (uint32_t)frame.sample_count * sizeof(int16_t);
                if (frame.eos) s_playback.eos_played = true;
                const bool complete = s_playback.eos_played && s_playback.eos_control_received &&
                                      frame.sequence == s_playback.final_sequence;
                taskEXIT_CRITICAL(&s_playback.lock);
                if (!frame.eos) {
                    if (send_credit(frame.sequence) != ESP_OK) fail_session();
                } else if (complete) {
                    finish_session("completed", true, NULL);
                }
                continue;
            }
            taskENTER_CRITICAL(&s_playback.lock);
            const bool complete = s_playback.eos_played && s_playback.eos_control_received;
            taskEXIT_CRITICAL(&s_playback.lock);
            if (complete) {
                finish_session("completed", true, NULL);
                continue;
            }
        }

        taskENTER_CRITICAL(&s_playback.lock);
        s_playback.metrics.stack_high_water_bytes =
            (uint32_t)uxTaskGetStackHighWaterMark(NULL);
        taskEXIT_CRITICAL(&s_playback.lock);
        vTaskDelay(interval_ticks);
    }
    if (s_playback.state != PLAYBACK_IDLE) finish_session("cancelled", false, NULL);
    for (;;) vTaskSuspend(NULL);
}

esp_err_t voice_playback_receiver_init(voice_playback_send_json_fn send_json, void *context)
{
    if (send_json == NULL) return ESP_ERR_INVALID_ARG;
    if (s_playback.initialized) return ESP_OK;
    s_playback.queue = xQueueCreateWithCaps(
        PLAYBACK_QUEUE_FRAMES, sizeof(playback_frame_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_playback.queue == NULL) return ESP_ERR_NO_MEM;
    s_playback.send_json = send_json;
    s_playback.send_context = context;
    s_playback.initialized = true;
    return ESP_OK;
}

esp_err_t voice_playback_receiver_deinit(void)
{
    if (s_playback.running || s_playback.task != NULL ||
        s_playback.state != PLAYBACK_IDLE) return ESP_ERR_INVALID_STATE;
    if (s_playback.queue != NULL) {
        vQueueDeleteWithCaps(s_playback.queue);
        s_playback.queue = NULL;
    }
    s_playback.state = PLAYBACK_IDLE;
    s_playback.send_json = NULL;
    s_playback.send_context = NULL;
    s_playback.initialized = false;
    return ESP_OK;
}

esp_err_t voice_playback_receiver_start(void)
{
    if (!s_playback.initialized) return ESP_ERR_INVALID_STATE;
    if (s_playback.running) return ESP_OK;
    if (s_playback.task != NULL) return ESP_ERR_INVALID_STATE;
    s_playback.running = true;
    if (xTaskCreate(playback_task, "voice_playback", PLAYBACK_TASK_STACK, NULL, 5,
                    &s_playback.task) != pdPASS) {
        s_playback.running = false;
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t voice_playback_receiver_stop(void)
{
    s_playback.running = false;
    if (s_playback.task == NULL) return ESP_OK;
    for (size_t i = 0; i < 250U; ++i) {
        if (eTaskGetState(s_playback.task) == eSuspended) {
            vTaskDelete(s_playback.task);
            s_playback.task = NULL;
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return ESP_ERR_TIMEOUT;
}

bool voice_playback_receiver_matches(const cJSON *root)
{
    if (!cJSON_IsObject(root)) return false;
    uint32_t stream, epoch;
    const cJSON *session = cJSON_GetObjectItemCaseSensitive(root, "session_id");
    taskENTER_CRITICAL(&s_playback.lock);
    const bool active = s_playback.state == PLAYBACK_PREPARING ||
                        s_playback.state == PLAYBACK_OPENING ||
                        s_playback.state == PLAYBACK_READY ||
                        s_playback.state == PLAYBACK_TERMINATING;
    const bool matches = active && cJSON_IsString(session) &&
                         strcmp(session->valuestring, s_playback.session_id_hex) == 0 &&
                         json_uint32(cJSON_GetObjectItemCaseSensitive(root, "stream_id"), &stream, true) &&
                         stream == s_playback.stream_id &&
                         json_uint32(cJSON_GetObjectItemCaseSensitive(root, "epoch"), &epoch, true) &&
                         epoch == s_playback.epoch;
    taskEXIT_CRITICAL(&s_playback.lock);
    return matches;
}

esp_err_t voice_playback_receiver_open(const cJSON *root)
{
    uint32_t version, stream, epoch, max_inflight;
    uint8_t session_id[16];
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    const cJSON *session = cJSON_GetObjectItemCaseSensitive(root, "session_id");
    const cJSON *direction = cJSON_GetObjectItemCaseSensitive(root, "direction");
    if (!cJSON_IsObject(root) || cJSON_GetArraySize(root) != 8 ||
        !json_uint32(cJSON_GetObjectItemCaseSensitive(root, "protocol_version"), &version, true) ||
        version != VOICE_PROTOCOL_VERSION || !cJSON_IsString(type) ||
        strcmp(type->valuestring, "session.open") != 0 || !cJSON_IsString(session) ||
        !decode_session_id(session->valuestring, session_id) ||
        !json_uint32(cJSON_GetObjectItemCaseSensitive(root, "stream_id"), &stream, true) ||
        !json_uint32(cJSON_GetObjectItemCaseSensitive(root, "epoch"), &epoch, true) ||
        !cJSON_IsString(direction) || strcmp(direction->valuestring, "playback") != 0 ||
        !format_valid(cJSON_GetObjectItemCaseSensitive(root, "format")) ||
        !json_uint32(cJSON_GetObjectItemCaseSensitive(root, "max_inflight_frames"),
                     &max_inflight, true) || max_inflight > 64U) {
        return ESP_ERR_INVALID_ARG;
    }
    taskENTER_CRITICAL(&s_playback.lock);
    const bool accepted = s_playback.running && s_playback.state == PLAYBACK_IDLE &&
                          !s_playback.barge_in_gate_required && !s_playback.capture_fenced &&
                          !s_playback.wake_prompt_requested && !s_playback.wake_prompt_active &&
                          !s_playback.wake_prompt_gate_required &&
                          !s_playback.metrics.output_quarantined;
    if (accepted) {
        memcpy(s_playback.session_id, session_id, sizeof(session_id));
        memcpy(s_playback.session_id_hex, session->valuestring, 33U);
        s_playback.stream_id = stream;
        s_playback.epoch = epoch;
        s_playback.max_inflight_frames = max_inflight;
        s_playback.open_requested = false;
        s_playback.cancel_requested = false;
        s_playback.fail_requested = false;
        s_playback.local_barge_in = false;
        s_playback.barge_in_gate_required = false;
        s_playback.barge_in_gate_ready = false;
        s_playback.suppress_terminal = false;
        s_playback.eos_control_received = false;
        s_playback.eos_played = false;
        s_playback.rx_busy = false;
        s_playback.session_frames_received = 0U;
        s_playback.final_sequence = 0U;
        s_playback.deadline_us = esp_timer_get_time() + PLAYBACK_SESSION_TIMEOUT_US;
        s_playback.metrics.active = true;
        s_playback.metrics.sessions_started++;
        (void)voice_protocol_rx_begin(&s_playback.tracker, session_id, stream, epoch);
        s_playback.state = PLAYBACK_PREPARING;
    }
    taskEXIT_CRITICAL(&s_playback.lock);
    if (!accepted) return ESP_ERR_INVALID_STATE;
    xQueueReset(s_playback.queue);
    taskENTER_CRITICAL(&s_playback.lock);
    const bool prepared = s_playback.running && s_playback.state == PLAYBACK_PREPARING;
    if (prepared) {
        s_playback.state = PLAYBACK_OPENING;
        s_playback.open_requested = true;
    }
    taskEXIT_CRITICAL(&s_playback.lock);
    if (prepared) {
        ESP_LOGW(TAG, "playback opened epoch=%" PRIu32 " volume=%u",
                 epoch, (unsigned)PLAYBACK_VOLUME_PERCENT);
    } else {
        ESP_LOGW(TAG, "playback cancelled while preparing epoch=%" PRIu32, epoch);
    }
    return ESP_OK;
}

esp_err_t voice_playback_receiver_control(const cJSON *root)
{
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (!cJSON_IsString(type) || !voice_playback_receiver_matches(root) ||
        !control_base_valid(root)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (strcmp(type->valuestring, "session.eos") == 0) {
        uint32_t final_sequence;
        const cJSON *reason = cJSON_GetObjectItemCaseSensitive(root, "reason");
        if (cJSON_GetArraySize(root) != 7 ||
            !json_uint32(cJSON_GetObjectItemCaseSensitive(root, "final_sequence"),
                         &final_sequence, false) || !cJSON_IsString(reason) ||
            strcmp(reason->valuestring, "source_complete") != 0) {
            return ESP_ERR_INVALID_ARG;
        }
        taskENTER_CRITICAL(&s_playback.lock);
        const bool valid = s_playback.state == PLAYBACK_READY && s_playback.tracker.ended &&
                           final_sequence + 1U == s_playback.tracker.next_sequence;
        if (valid) {
            s_playback.final_sequence = final_sequence;
            s_playback.eos_control_received = true;
        }
        taskEXIT_CRITICAL(&s_playback.lock);
        return valid ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    if (strcmp(type->valuestring, "session.cancel") == 0) {
        const cJSON *reason = cJSON_GetObjectItemCaseSensitive(root, "reason");
        if (cJSON_GetArraySize(root) != 6 || !cJSON_IsString(reason) ||
            !cancel_reason_valid(reason->valuestring)) return ESP_ERR_INVALID_ARG;
        taskENTER_CRITICAL(&s_playback.lock);
        const bool duplicate = s_playback.state == PLAYBACK_TERMINATING &&
                               s_playback.cancel_requested;
        const bool valid = duplicate || s_playback.state == PLAYBACK_PREPARING ||
                           s_playback.state == PLAYBACK_OPENING ||
                           s_playback.state == PLAYBACK_READY;
        if (valid) {
            if (!duplicate) {
                s_playback.state = PLAYBACK_TERMINATING;
                s_playback.cancel_requested = true;
            }
        }
        taskEXIT_CRITICAL(&s_playback.lock);
        return valid ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    if (strcmp(type->valuestring, "error") == 0) {
        const cJSON *code = cJSON_GetObjectItemCaseSensitive(root, "code");
        if (cJSON_GetArraySize(root) != 6 || !cJSON_IsString(code) ||
            !error_code_valid(code->valuestring)) return ESP_ERR_INVALID_ARG;
        taskENTER_CRITICAL(&s_playback.lock);
        const bool duplicate = s_playback.state == PLAYBACK_TERMINATING &&
                               s_playback.fail_requested;
        const bool valid = duplicate || s_playback.state == PLAYBACK_PREPARING ||
                           s_playback.state == PLAYBACK_OPENING ||
                           s_playback.state == PLAYBACK_READY;
        if (valid) {
            if (!duplicate) {
                s_playback.state = PLAYBACK_TERMINATING;
                s_playback.fail_requested = true;
            }
        }
        taskEXIT_CRITICAL(&s_playback.lock);
        return valid ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t voice_playback_receiver_frame(const uint8_t *bytes, size_t length)
{
    voice_protocol_frame_header_t header;
    const uint8_t *payload = NULL;
    voice_protocol_result_t decoded = voice_protocol_decode_frame(bytes, length, &header, &payload);
    if (decoded != VOICE_PROTOCOL_OK || header.kind != VOICE_PROTOCOL_FRAME_PLAYBACK_PCM) {
        return ESP_ERR_INVALID_ARG;
    }
    taskENTER_CRITICAL(&s_playback.lock);
    const bool ready = s_playback.state == PLAYBACK_READY && !s_playback.rx_busy;
    if (ready) s_playback.rx_busy = true;
    taskEXIT_CRITICAL(&s_playback.lock);
    if (!ready) return ESP_ERR_INVALID_STATE;
    esp_err_t result = ESP_OK;
    if ((header.flags & VOICE_PROTOCOL_FLAG_DISCONTINUITY) != 0U ||
        s_playback.session_frames_received >= PLAYBACK_MAX_FRAMES ||
        uxQueueSpacesAvailable(s_playback.queue) == 0U) {
        result = ESP_ERR_NO_MEM;
    }
    voice_protocol_result_t accepted = result == ESP_OK
                                           ? voice_protocol_rx_accept(&s_playback.tracker, &header)
                                           : VOICE_PROTOCOL_INVALID_ARGUMENT;
    if (result == ESP_OK && accepted != VOICE_PROTOCOL_OK) result = ESP_ERR_INVALID_ARG;
    playback_frame_t frame = {
        .sequence = header.sequence,
        .sample_count = header.frame_samples,
        .eos = (header.flags & VOICE_PROTOCOL_FLAG_END_OF_STREAM) != 0U,
    };
    if (result == ESP_OK) {
        memcpy(frame.samples, payload, header.payload_bytes);
        if (xQueueSend(s_playback.queue, &frame, 0) != pdTRUE) result = ESP_ERR_NO_MEM;
    }
    UBaseType_t queued = uxQueueMessagesWaiting(s_playback.queue);
    taskENTER_CRITICAL(&s_playback.lock);
    if (result == ESP_OK) {
        s_playback.session_frames_received++;
        s_playback.metrics.frames_received++;
    }
    if (result == ESP_OK && (uint32_t)queued > s_playback.metrics.queue_high_water) {
        s_playback.metrics.queue_high_water = (uint32_t)queued;
    }
    s_playback.rx_busy = false;
    taskEXIT_CRITICAL(&s_playback.lock);
    return result;
}

void voice_playback_receiver_barge_in(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    if (s_playback.state == PLAYBACK_PREPARING ||
        s_playback.state == PLAYBACK_OPENING || s_playback.state == PLAYBACK_READY) {
        s_playback.state = PLAYBACK_TERMINATING;
        s_playback.cancel_requested = true;
        s_playback.local_barge_in = true;
        s_playback.barge_in_gate_required = true;
        s_playback.barge_in_gate_ready = false;
        s_playback.metrics.barge_in_count++;
    }
    taskEXIT_CRITICAL(&s_playback.lock);
}

void voice_playback_receiver_request_wake_prompt(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.wake_prompt_requested = true;
    s_playback.wake_prompt_connecting = false;
    s_playback.wake_prompt_gate_required = true;
    s_playback.wake_prompt_gate_ready = false;
    s_playback.wake_prompt_capture_ready_us = 0;
    taskEXIT_CRITICAL(&s_playback.lock);
}

void voice_playback_receiver_request_connecting_prompt(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.wake_prompt_requested = true;
    s_playback.wake_prompt_connecting = true;
    s_playback.wake_prompt_gate_required = true;
    s_playback.wake_prompt_gate_ready = false;
    s_playback.wake_prompt_capture_ready_us = 0;
    taskEXIT_CRITICAL(&s_playback.lock);
}

void voice_playback_receiver_capture_failed(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.pending_local_stage = CONVERSATION_LOCAL_STAGE_IDLE;
    s_playback.local_stage_pending = true;
    taskEXIT_CRITICAL(&s_playback.lock);
}

void voice_playback_receiver_capture_ended(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.pending_local_stage = CONVERSATION_LOCAL_STAGE_TRANSCRIBING;
    s_playback.local_stage_pending = true;
    taskEXIT_CRITICAL(&s_playback.lock);
}

bool voice_playback_receiver_allow_capture(void)
{
    const int64_t now_us = esp_timer_get_time();
    taskENTER_CRITICAL(&s_playback.lock);
    const bool barge_in_ready = !s_playback.barge_in_gate_required ||
                                s_playback.barge_in_gate_ready;
    const bool prompt_ready = !s_playback.wake_prompt_gate_required ||
                              (s_playback.wake_prompt_gate_ready &&
                               now_us >= s_playback.wake_prompt_capture_ready_us);
    const bool allowed = barge_in_ready && prompt_ready;
    if (allowed) {
        s_playback.barge_in_gate_required = false;
        s_playback.barge_in_gate_ready = false;
        s_playback.wake_prompt_gate_required = false;
        s_playback.wake_prompt_gate_ready = false;
        s_playback.wake_prompt_capture_ready_us = 0;
        s_playback.capture_fenced = true;
    }
    taskEXIT_CRITICAL(&s_playback.lock);
    return allowed;
}

void voice_playback_receiver_capture_finished(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    s_playback.capture_fenced = false;
    taskEXIT_CRITICAL(&s_playback.lock);
}

void voice_playback_receiver_fail(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    if (s_playback.state == PLAYBACK_OPENING || s_playback.state == PLAYBACK_READY) {
        s_playback.state = PLAYBACK_TERMINATING;
        s_playback.fail_requested = true;
    }
    taskEXIT_CRITICAL(&s_playback.lock);
}

void voice_playback_receiver_disconnect(void)
{
    taskENTER_CRITICAL(&s_playback.lock);
    if (s_playback.state != PLAYBACK_IDLE) {
        s_playback.state = PLAYBACK_TERMINATING;
        s_playback.cancel_requested = true;
        s_playback.suppress_terminal = true;
    }
    s_playback.wake_prompt_requested = false;
    s_playback.wake_prompt_connecting = false;
    s_playback.wake_prompt_gate_required = false;
    s_playback.wake_prompt_gate_ready = false;
    s_playback.wake_prompt_capture_ready_us = 0;
    taskEXIT_CRITICAL(&s_playback.lock);
    (void)conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_IDLE);
}

void voice_playback_receiver_get_snapshot(voice_playback_snapshot_t *snapshot)
{
    if (snapshot == NULL) return;
    taskENTER_CRITICAL(&s_playback.lock);
    *snapshot = s_playback.metrics;
    taskEXIT_CRITICAL(&s_playback.lock);
}
