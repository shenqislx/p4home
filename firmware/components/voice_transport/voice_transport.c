#include "voice_transport.h"

#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "conversation_service.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "nvs.h"
#include "sr_service.h"
#include "voice_protocol.h"
#include "voice_playback_receiver.h"

static const char *TAG = "voice_transport";

#define VOICE_TRANSPORT_QUEUE_FRAMES 16U
#define VOICE_TRANSPORT_CONTROL_MAX_BYTES 4096U
#define VOICE_TRANSPORT_WORKER_INTERVAL_MS 10U
#define VOICE_TRANSPORT_SEND_TIMEOUT_MS 2000U
#define VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES 16U
#define VOICE_TRANSPORT_OPEN_TIMEOUT_US 5000000LL
#define VOICE_TRANSPORT_END_TIMEOUT_US 5000000LL
#define VOICE_TRANSPORT_MAX_SESSION_US 40000000LL
#define VOICE_TRANSPORT_EPOCH_RESERVATION 65536U
#define VOICE_TRANSPORT_EPOCH_RESERVE_THRESHOLD 1024U
#define VOICE_TRANSPORT_EPOCH_RETRY_US 5000000LL
#define VOICE_TRANSPORT_EPOCH_TASK_STACK 4096U
#define VOICE_TRANSPORT_NVS_NAMESPACE "p4voice"
#define VOICE_TRANSPORT_NVS_EPOCH_END "epoch_end"
#define VOICE_WS_OPCODE_CONTINUATION 0x0U
#define VOICE_WS_OPCODE_TEXT 0x1U
#define VOICE_WS_OPCODE_BINARY 0x2U
#define VOICE_WS_OPCODE_CLOSE 0x8U
#define VOICE_WS_OPCODE_PING 0x9U
#define VOICE_WS_OPCODE_PONG 0xAU

#ifndef CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK
#define CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK 12288
#endif
#ifndef CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK
#define CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK 6144
#endif
#ifndef CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS
#define CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS 10000
#endif

typedef enum {
    VOICE_SESSION_IDLE = 0,
    VOICE_SESSION_OPENING,
    VOICE_SESSION_READY,
    VOICE_SESSION_WAITING_CLOSE,
} voice_session_state_t;

typedef struct {
    uint8_t bytes[VOICE_PROTOCOL_HEADER_BYTES + VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES];
    size_t length;
    uint32_t sequence;
    bool eos;
} voice_transport_frame_t;

typedef struct {
    char session_id[CONVERSATION_UI_SESSION_ID_HEX_BYTES + 1U];
    uint32_t stream_id;
    uint32_t epoch;
    uint32_t revision;
} voice_ui_ack_t;

typedef struct {
    bool initialized;
    bool enabled;
    volatile bool running;
    bool reconnect_requested;
    bool abort_requested;
    bool socket_connected;
    esp_websocket_client_handle_t ws;
    TaskHandle_t worker_task;
    QueueHandle_t frame_queue;
    SemaphoreHandle_t send_mutex;
    portMUX_TYPE lock;
    char uri[VOICE_TRANSPORT_URI_MAX_BYTES];
    char device_id[VOICE_TRANSPORT_DEVICE_ID_MAX_BYTES + 1U];
    char token[VOICE_TRANSPORT_TOKEN_MAX_BYTES];
    char headers[VOICE_TRANSPORT_TOKEN_MAX_BYTES + VOICE_TRANSPORT_DEVICE_ID_MAX_BYTES + 64U];
    uint8_t spki_sha256[VOICE_TRANSPORT_SPKI_SHA256_BYTES];
    voice_session_state_t session_state;
    bool open_requested;
    bool end_requested;
    bool eos_sent;
    bool pending_discontinuity;
    uint8_t session_id[16];
    char session_id_hex[33];
    uint32_t stream_id;
    uint32_t epoch;
    uint32_t epoch_reserved_end;
    bool epoch_reservation_in_progress;
    int64_t epoch_reservation_retry_at_us;
    uint32_t next_sequence;
    uint32_t final_sequence;
    uint32_t available_credit;
    uint32_t outstanding_frames;
    uint32_t outstanding_sequences[VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES];
    int64_t last_ack_sequence;
    uint32_t last_sent_sequence;
    uint32_t session_frames_sent;
    uint32_t session_bytes_sent;
    uint32_t session_dropped_frames;
    int64_t session_deadline_us;
    char end_reason[24];
    int16_t assembly[VOICE_PROTOCOL_FRAME_SAMPLES];
    size_t assembly_samples;
    uint64_t assembly_started_at_us;
    char rx_control[VOICE_TRANSPORT_CONTROL_MAX_BYTES + 1U];
    size_t rx_expected;
    size_t rx_received;
    bool rx_binary;
    bool ui_ack_pending;
    bool suppress_wake_session;
    voice_transport_capture_readiness_probe_t capture_readiness_probe;
    void *capture_readiness_context;
    voice_ui_ack_t pending_ui_ack;
    voice_transport_snapshot_t metrics;
} voice_transport_state_t;

static voice_transport_state_t s_voice = {
    .lock = portMUX_INITIALIZER_UNLOCKED,
    .last_ack_sequence = -1,
};
static const mbedtls_x509_crt s_dummy_ca;

static bool voice_begin_capture(void *context, uint64_t started_at_us);
static void voice_offer_pcm(void *context, const int16_t *samples, size_t sample_count,
                            uint64_t captured_at_us);
static void voice_end_capture(void *context, const char *reason, uint64_t ended_at_us);
static void voice_wake_detected(void *context, uint64_t detected_at_us);
static bool voice_ready_for_capture(void *context);
static bool voice_suppress_wake_session(void *context);

static bool voice_capture_dependency_ready(void)
{
    voice_transport_capture_readiness_probe_t probe = s_voice.capture_readiness_probe;
    return probe != NULL && probe(s_voice.capture_readiness_context);
}

static bool voice_valid_uri(const char *uri)
{
    if (uri == NULL) return false;
    static const char scheme[] = "wss://";
    static const char path[] = "/v1/voice";
    size_t length = strnlen(uri, VOICE_TRANSPORT_URI_MAX_BYTES);
    if (length <= strlen(scheme) + strlen(path) || length >= VOICE_TRANSPORT_URI_MAX_BYTES ||
        strncmp(uri, scheme, strlen(scheme)) != 0 || strchr(uri, '?') != NULL ||
        strchr(uri, '#') != NULL) {
        return false;
    }
    const char *authority = uri + strlen(scheme);
    const char *uri_path = strchr(authority, '/');
    return uri_path != NULL && uri_path > authority &&
           memchr(authority, '@', (size_t)(uri_path - authority)) == NULL &&
           strcmp(uri_path, path) == 0;
}

static bool voice_valid_id(const char *value)
{
    if (value == NULL) return false;
    size_t length = strnlen(value, VOICE_TRANSPORT_DEVICE_ID_MAX_BYTES + 1U);
    if (length == 0U || length > VOICE_TRANSPORT_DEVICE_ID_MAX_BYTES ||
        !isalnum((unsigned char)value[0])) {
        return false;
    }
    for (size_t i = 1; i < length; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (!isalnum(c) && c != '.' && c != '_' && c != ':' && c != '-') return false;
    }
    return true;
}

static bool voice_valid_token(const char *token)
{
    if (token == NULL) return false;
    size_t length = strnlen(token, VOICE_TRANSPORT_TOKEN_MAX_BYTES);
    return length >= 32U && length < VOICE_TRANSPORT_TOKEN_MAX_BYTES &&
           strchr(token, '\r') == NULL && strchr(token, '\n') == NULL;
}

#if CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED
static int voice_hex_nibble(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

static bool voice_decode_pin(const char *hex, uint8_t output[VOICE_TRANSPORT_SPKI_SHA256_BYTES])
{
    if (hex == NULL || strlen(hex) != VOICE_TRANSPORT_SPKI_SHA256_BYTES * 2U) return false;
    for (size_t i = 0; i < VOICE_TRANSPORT_SPKI_SHA256_BYTES; ++i) {
        int high = voice_hex_nibble(hex[i * 2U]);
        int low = voice_hex_nibble(hex[i * 2U + 1U]);
        if (high < 0 || low < 0) return false;
        output[i] = (uint8_t)((high << 4) | low);
    }
    return true;
}
#endif

static bool voice_constant_time_equal(const uint8_t *left, const uint8_t *right, size_t length)
{
    uint8_t difference = 0U;
    for (size_t i = 0; i < length; ++i) difference |= left[i] ^ right[i];
    return difference == 0U;
}

static int voice_verify_spki(void *context, mbedtls_x509_crt *certificate,
                             int depth, uint32_t *flags)
{
    (void)context;
    if (certificate == NULL || flags == NULL) return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    if (depth != 0) {
        *flags = 0U;
        return 0;
    }
    if (certificate->pk_raw.p == NULL || certificate->pk_raw.len == 0U) {
        ESP_LOGE(TAG, "Voice TLS SPKI verification failed reason=missing_raw_spki");
        return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    }
    unsigned char digest[VOICE_TRANSPORT_SPKI_SHA256_BYTES];
    if (mbedtls_sha256(certificate->pk_raw.p, certificate->pk_raw.len, digest, 0) != 0) {
        ESP_LOGE(TAG, "Voice TLS SPKI verification failed reason=sha256");
        return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    }
    if (!voice_constant_time_equal(digest, s_voice.spki_sha256, sizeof(digest))) {
        ESP_LOGE(TAG, "Voice TLS SPKI verification failed reason=pin_mismatch");
        return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    }
    ESP_LOGI(TAG, "Voice TLS SPKI verified");
    *flags = 0U;
    return 0;
}

static esp_err_t voice_attach_spki_verifier(void *config)
{
    ESP_RETURN_ON_FALSE(config != NULL, ESP_ERR_INVALID_ARG, TAG, "TLS config is required");
    mbedtls_ssl_config *ssl_config = (mbedtls_ssl_config *)config;
    mbedtls_ssl_conf_ca_chain(ssl_config, (mbedtls_x509_crt *)&s_dummy_ca, NULL);
    mbedtls_ssl_conf_verify(ssl_config, voice_verify_spki, NULL);
    return ESP_OK;
}

static void voice_metric_protocol_error(void)
{
    taskENTER_CRITICAL(&s_voice.lock);
    s_voice.metrics.protocol_errors++;
    taskEXIT_CRITICAL(&s_voice.lock);
}

static void voice_abort_session(const char *reason)
{
    bool was_active;
    taskENTER_CRITICAL(&s_voice.lock);
    was_active = s_voice.session_state != VOICE_SESSION_IDLE;
    s_voice.session_state = VOICE_SESSION_IDLE;
    s_voice.open_requested = false;
    s_voice.end_requested = false;
    s_voice.eos_sent = false;
    s_voice.available_credit = 0U;
    s_voice.outstanding_frames = 0U;
    s_voice.session_deadline_us = 0;
    s_voice.metrics.session_active = false;
    if (was_active) {
        s_voice.metrics.sessions_cancelled++;
    }
    taskEXIT_CRITICAL(&s_voice.lock);
    voice_playback_receiver_capture_finished();
    if (was_active) {
        (void)conversation_service_set_local_stage(CONVERSATION_LOCAL_STAGE_IDLE);
    }
    if (was_active) ESP_LOGW(TAG, "voice capture aborted: %s", reason);
}

static void voice_request_abort(void)
{
    taskENTER_CRITICAL(&s_voice.lock);
    s_voice.abort_requested = true;
    taskEXIT_CRITICAL(&s_voice.lock);
}

static void voice_request_reconnect(void)
{
    taskENTER_CRITICAL(&s_voice.lock);
    s_voice.reconnect_requested = true;
    taskEXIT_CRITICAL(&s_voice.lock);
}

static esp_err_t voice_reserve_epoch_block(void)
{
    taskENTER_CRITICAL(&s_voice.lock);
    const uint32_t current_end = s_voice.epoch_reserved_end;
    taskEXIT_CRITICAL(&s_voice.lock);
    nvs_handle_t handle = 0;
    esp_err_t result = nvs_open(VOICE_TRANSPORT_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (result != ESP_OK) return result;
    uint32_t previous_end = 0U;
    result = nvs_get_u32(handle, VOICE_TRANSPORT_NVS_EPOCH_END, &previous_end);
    if (result == ESP_ERR_NVS_NOT_FOUND) result = ESP_OK;
    if (result == ESP_OK && current_end != 0U && previous_end != current_end) {
        result = ESP_ERR_INVALID_STATE;
    }
    if (result == ESP_OK && previous_end > UINT32_MAX - VOICE_TRANSPORT_EPOCH_RESERVATION) {
        result = ESP_ERR_INVALID_STATE;
    }
    const uint32_t reserved_end = previous_end + VOICE_TRANSPORT_EPOCH_RESERVATION;
    if (result == ESP_OK) result = nvs_set_u32(handle, VOICE_TRANSPORT_NVS_EPOCH_END, reserved_end);
    if (result == ESP_OK) result = nvs_commit(handle);
    nvs_close(handle);
    if (result == ESP_OK) {
        taskENTER_CRITICAL(&s_voice.lock);
        if (current_end == 0U) s_voice.epoch = previous_end;
        s_voice.epoch_reserved_end = reserved_end;
        taskEXIT_CRITICAL(&s_voice.lock);
    }
    return result;
}

static void voice_epoch_reservation_task(void *argument)
{
    (void)argument;
    const esp_err_t reserve_result = voice_reserve_epoch_block();
    const int64_t now_us = esp_timer_get_time();
    taskENTER_CRITICAL(&s_voice.lock);
    s_voice.epoch_reservation_in_progress = false;
    if (reserve_result == ESP_OK) {
        s_voice.epoch_reservation_retry_at_us = 0;
    } else {
        s_voice.epoch_reservation_retry_at_us = now_us + VOICE_TRANSPORT_EPOCH_RETRY_US;
        s_voice.metrics.protocol_errors++;
    }
    taskEXIT_CRITICAL(&s_voice.lock);
    vTaskDelete(NULL);
}

static esp_err_t voice_send_json(cJSON *root)
{
    if (root == NULL || s_voice.send_mutex == NULL) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_STATE;
    }
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (text == NULL) return ESP_ERR_NO_MEM;
    size_t length = strlen(text);
    int sent = -1;
    if (length <= VOICE_TRANSPORT_CONTROL_MAX_BYTES &&
        xSemaphoreTake(s_voice.send_mutex,
                       pdMS_TO_TICKS(VOICE_TRANSPORT_SEND_TIMEOUT_MS)) == pdTRUE) {
        taskENTER_CRITICAL(&s_voice.lock);
        const bool connected = s_voice.socket_connected;
        esp_websocket_client_handle_t ws = s_voice.ws;
        taskEXIT_CRITICAL(&s_voice.lock);
        if (connected && ws != NULL) {
            sent = esp_websocket_client_send_text(
                ws, text, length, pdMS_TO_TICKS(VOICE_TRANSPORT_SEND_TIMEOUT_MS));
        }
        xSemaphoreGive(s_voice.send_mutex);
    }
    free(text);
    return sent == (int)length ? ESP_OK : ESP_FAIL;
}

static esp_err_t voice_send_binary(const uint8_t *bytes, size_t length)
{
    if (bytes == NULL || length == 0U || s_voice.send_mutex == NULL ||
        xSemaphoreTake(s_voice.send_mutex,
                       pdMS_TO_TICKS(VOICE_TRANSPORT_SEND_TIMEOUT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    taskENTER_CRITICAL(&s_voice.lock);
    const bool connected = s_voice.socket_connected;
    esp_websocket_client_handle_t ws = s_voice.ws;
    taskEXIT_CRITICAL(&s_voice.lock);
    int sent = connected && ws != NULL
                   ? esp_websocket_client_send_bin(
                         ws, (const char *)bytes, length,
                         pdMS_TO_TICKS(VOICE_TRANSPORT_SEND_TIMEOUT_MS))
                   : -1;
    xSemaphoreGive(s_voice.send_mutex);
    return sent == (int)length ? ESP_OK : ESP_FAIL;
}

static esp_err_t voice_send_ui_applied(const voice_ui_ack_t *ack)
{
    if (ack == NULL) return ESP_ERR_INVALID_ARG;
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    cJSON_AddNumberToObject(root, "ui_protocol_version", CONVERSATION_UI_PROTOCOL_VERSION);
    cJSON_AddStringToObject(root, "type", "ui.applied");
    cJSON_AddStringToObject(root, "session_id", ack->session_id);
    cJSON_AddNumberToObject(root, "stream_id", ack->stream_id);
    cJSON_AddNumberToObject(root, "epoch", ack->epoch);
    cJSON_AddNumberToObject(root, "revision", ack->revision);
    return voice_send_json(root);
}

static void voice_conversation_rendered(const conversation_update_t *update, void *context)
{
    (void)context;
    if (update == NULL) return;
    taskENTER_CRITICAL(&s_voice.lock);
    if (!s_voice.socket_connected || s_voice.ui_ack_pending) {
        s_voice.metrics.protocol_errors++;
    } else {
        memcpy(s_voice.pending_ui_ack.session_id, update->session_id,
               sizeof(s_voice.pending_ui_ack.session_id));
        s_voice.pending_ui_ack.stream_id = update->stream_id;
        s_voice.pending_ui_ack.epoch = update->epoch;
        s_voice.pending_ui_ack.revision = update->revision;
        s_voice.ui_ack_pending = true;
    }
    taskEXIT_CRITICAL(&s_voice.lock);
}

static esp_err_t voice_playback_send_json(cJSON *root, void *context)
{
    (void)context;
    return voice_send_json(root);
}

static void voice_add_identity(cJSON *root, const char *type)
{
    cJSON_AddNumberToObject(root, "protocol_version", VOICE_PROTOCOL_VERSION);
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddStringToObject(root, "session_id", s_voice.session_id_hex);
    cJSON_AddNumberToObject(root, "stream_id", s_voice.stream_id);
    cJSON_AddNumberToObject(root, "epoch", s_voice.epoch);
}

static esp_err_t voice_send_open(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    voice_add_identity(root, "session.open");
    cJSON_AddStringToObject(root, "direction", "capture");
    cJSON *format = cJSON_AddObjectToObject(root, "format");
    cJSON_AddStringToObject(format, "encoding", "pcm_s16le");
    cJSON_AddNumberToObject(format, "sample_rate_hz", VOICE_PROTOCOL_SAMPLE_RATE_HZ);
    cJSON_AddNumberToObject(format, "channels", VOICE_PROTOCOL_CHANNELS);
    cJSON_AddNumberToObject(format, "bits_per_sample", VOICE_PROTOCOL_BITS_PER_SAMPLE);
    cJSON_AddNumberToObject(format, "frame_samples", VOICE_PROTOCOL_FRAME_SAMPLES);
    cJSON_AddNumberToObject(root, "max_inflight_frames", VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES);
    return voice_send_json(root);
}

static esp_err_t voice_send_eos_control(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) return ESP_ERR_NO_MEM;
    voice_add_identity(root, "session.eos");
    cJSON_AddNumberToObject(root, "final_sequence", s_voice.final_sequence);
    cJSON_AddStringToObject(root, "reason", s_voice.end_reason);
    return voice_send_json(root);
}

static bool voice_json_uint32(const cJSON *item, uint32_t *value)
{
    if (!cJSON_IsNumber(item) || item->valuedouble < 0.0 ||
        item->valuedouble > (double)UINT32_MAX ||
        (double)(uint32_t)item->valuedouble != item->valuedouble) {
        return false;
    }
    if (value != NULL) *value = (uint32_t)item->valuedouble;
    return true;
}

static bool voice_control_identity_valid(const cJSON *root)
{
    uint32_t version, stream, epoch;
    const cJSON *session = cJSON_GetObjectItemCaseSensitive(root, "session_id");
    return voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "protocol_version"), &version) &&
           version == VOICE_PROTOCOL_VERSION && cJSON_IsString(session) &&
           strcmp(session->valuestring, s_voice.session_id_hex) == 0 &&
           voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "stream_id"), &stream) &&
           stream == s_voice.stream_id &&
           voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "epoch"), &epoch) &&
           epoch == s_voice.epoch;
}

static bool voice_ui_stage(const char *value, conversation_stage_t *stage)
{
    static const char *const values[] = {
        "listening", "transcribing", "thinking", "completed", "failed", "cancelled",
    };
    if (value == NULL || stage == NULL) return false;
    for (size_t index = 0U; index < sizeof(values) / sizeof(values[0]); ++index) {
        if (strcmp(value, values[index]) == 0) {
            *stage = (conversation_stage_t)index;
            return true;
        }
    }
    return false;
}

static bool voice_ui_role(const char *value, conversation_response_role_t *role)
{
    static const char *const values[] = {"none", "human", "robot", "mixed", "system"};
    if (value == NULL || role == NULL) return false;
    for (size_t index = 0U; index < sizeof(values) / sizeof(values[0]); ++index) {
        if (strcmp(value, values[index]) == 0) {
            *role = (conversation_response_role_t)index;
            return true;
        }
    }
    return false;
}

static bool voice_ui_execution(const char *value, conversation_execution_status_t *status)
{
    static const char *const values[] = {
        "pending", "completed", "failed", "unknown", "not_applicable",
    };
    if (value == NULL || status == NULL) return false;
    for (size_t index = 0U; index < sizeof(values) / sizeof(values[0]); ++index) {
        if (strcmp(value, values[index]) == 0) {
            *status = (conversation_execution_status_t)index;
            return true;
        }
    }
    return false;
}

static bool voice_handle_ui_update(const cJSON *root)
{
    if (!cJSON_IsObject(root) || cJSON_GetArraySize(root) != 11) return false;
    uint32_t version, stream, epoch, revision;
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    const cJSON *session = cJSON_GetObjectItemCaseSensitive(root, "session_id");
    const cJSON *stage = cJSON_GetObjectItemCaseSensitive(root, "stage");
    const cJSON *user = cJSON_GetObjectItemCaseSensitive(root, "user_text");
    const cJSON *response = cJSON_GetObjectItemCaseSensitive(root, "response_text");
    const cJSON *role = cJSON_GetObjectItemCaseSensitive(root, "response_role");
    const cJSON *execution = cJSON_GetObjectItemCaseSensitive(root, "execution_status");
    if (!voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "ui_protocol_version"),
                           &version) ||
        version != CONVERSATION_UI_PROTOCOL_VERSION || !cJSON_IsString(type) ||
        strcmp(type->valuestring, "ui.update") != 0 || !cJSON_IsString(session) ||
        strcmp(session->valuestring, s_voice.session_id_hex) != 0 ||
        !voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "stream_id"), &stream) ||
        stream != s_voice.stream_id ||
        !voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "epoch"), &epoch) ||
        epoch != s_voice.epoch ||
        !voice_json_uint32(cJSON_GetObjectItemCaseSensitive(root, "revision"), &revision) ||
        revision == 0U || !cJSON_IsString(stage) || !cJSON_IsString(user) ||
        !cJSON_IsString(response) || !cJSON_IsString(role) || !cJSON_IsString(execution) ||
        strlen(user->valuestring) > CONVERSATION_UI_USER_TEXT_MAX_BYTES ||
        strlen(response->valuestring) > CONVERSATION_UI_RESPONSE_TEXT_MAX_BYTES) {
        return false;
    }

    conversation_update_t update = {
        .stream_id = stream,
        .epoch = epoch,
        .revision = revision,
    };
    snprintf(update.session_id, sizeof(update.session_id), "%s", session->valuestring);
    snprintf(update.user_text, sizeof(update.user_text), "%s", user->valuestring);
    snprintf(update.response_text, sizeof(update.response_text), "%s", response->valuestring);
    if (!voice_ui_stage(stage->valuestring, &update.stage) ||
        !voice_ui_role(role->valuestring, &update.response_role) ||
        !voice_ui_execution(execution->valuestring, &update.execution_status)) {
        return false;
    }
    return conversation_service_apply(&update) == ESP_OK;
}

static void voice_handle_control(const char *text, size_t length)
{
    cJSON *root = cJSON_ParseWithLength(text, length);
    const cJSON *type = root != NULL ? cJSON_GetObjectItemCaseSensitive(root, "type") : NULL;
    if (root == NULL || !cJSON_IsString(type)) {
        cJSON_Delete(root);
        voice_metric_protocol_error();
        voice_request_reconnect();
        return;
    }
    if (strcmp(type->valuestring, "ui.update") == 0) {
        if (!voice_handle_ui_update(root)) {
            voice_metric_protocol_error();
            voice_request_reconnect();
        }
        cJSON_Delete(root);
        return;
    }
    const cJSON *direction = cJSON_GetObjectItemCaseSensitive(root, "direction");
    if (strcmp(type->valuestring, "session.open") == 0 && cJSON_IsString(direction) &&
        strcmp(direction->valuestring, "playback") == 0) {
        if (voice_playback_receiver_open(root) != ESP_OK) {
            voice_metric_protocol_error();
            voice_request_reconnect();
        }
        cJSON_Delete(root);
        return;
    }
    if (voice_playback_receiver_matches(root)) {
        if (voice_playback_receiver_control(root) != ESP_OK) {
            voice_metric_protocol_error();
            voice_playback_receiver_fail();
        }
        cJSON_Delete(root);
        return;
    }
    if (!voice_control_identity_valid(root)) {
        cJSON_Delete(root);
        voice_metric_protocol_error();
        voice_request_reconnect();
        return;
    }
    if (strcmp(type->valuestring, "session.ready") == 0) {
        uint32_t credit;
        const int64_t ready_deadline_us = esp_timer_get_time() + VOICE_TRANSPORT_MAX_SESSION_US;
        const bool fields_valid = voice_json_uint32(
            cJSON_GetObjectItemCaseSensitive(root, "initial_credit_frames"), &credit);
        taskENTER_CRITICAL(&s_voice.lock);
        const bool valid = fields_valid && s_voice.session_state == VOICE_SESSION_OPENING &&
                           credit > 0U && credit <= VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES;
        if (valid) {
            s_voice.available_credit = credit;
            s_voice.session_state = VOICE_SESSION_READY;
            s_voice.session_deadline_us = ready_deadline_us;
            s_voice.metrics.available_credit = credit;
        }
        taskEXIT_CRITICAL(&s_voice.lock);
        if (!valid) {
            voice_metric_protocol_error();
            voice_request_reconnect();
        }
    } else if (strcmp(type->valuestring, "credit") == 0) {
        uint32_t ack, grant;
        bool valid = voice_json_uint32(
                         cJSON_GetObjectItemCaseSensitive(root, "ack_sequence"), &ack) &&
                     voice_json_uint32(
                         cJSON_GetObjectItemCaseSensitive(root, "grant_frames"), &grant);
        taskENTER_CRITICAL(&s_voice.lock);
        if (valid) {
            valid = s_voice.session_state == VOICE_SESSION_READY && grant > 0U &&
                    grant <= VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES &&
                    (int64_t)ack > s_voice.last_ack_sequence;
        }
        if (valid) {
            uint32_t ack_index = 0U;
            while (ack_index < s_voice.outstanding_frames &&
                   s_voice.outstanding_sequences[ack_index] != ack) {
                ack_index++;
            }
            const uint32_t acknowledged = ack_index + 1U;
            valid = ack_index < s_voice.outstanding_frames &&
                    s_voice.available_credit + grant + s_voice.outstanding_frames - acknowledged <=
                        VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES;
            if (valid) {
                s_voice.last_ack_sequence = (int64_t)ack;
                memmove(s_voice.outstanding_sequences,
                        s_voice.outstanding_sequences + acknowledged,
                        (s_voice.outstanding_frames - acknowledged) * sizeof(uint32_t));
                s_voice.outstanding_frames -= acknowledged;
                s_voice.available_credit += grant;
                s_voice.metrics.available_credit = s_voice.available_credit;
            }
        }
        taskEXIT_CRITICAL(&s_voice.lock);
        if (!valid) {
            voice_metric_protocol_error();
            voice_request_reconnect();
        }
    } else if (strcmp(type->valuestring, "session.closed") == 0) {
        const cJSON *status = cJSON_GetObjectItemCaseSensitive(root, "status");
        uint32_t dropped;
        const bool fields_valid = cJSON_IsString(status) &&
                                  strcmp(status->valuestring, "completed") == 0 &&
                                  voice_json_uint32(cJSON_GetObjectItemCaseSensitive(
                                                        root, "dropped_frames"),
                                                    &dropped);
        taskENTER_CRITICAL(&s_voice.lock);
        const bool valid = fields_valid && s_voice.session_state == VOICE_SESSION_WAITING_CLOSE &&
                           dropped == s_voice.session_dropped_frames;
#if CONFIG_P4HOME_PHASE5B_VALIDATION
        const uint32_t epoch = s_voice.epoch;
        const uint32_t frames = s_voice.session_frames_sent;
        const uint32_t bytes = s_voice.session_bytes_sent;
#endif
        if (valid) {
            s_voice.session_state = VOICE_SESSION_IDLE;
            s_voice.session_deadline_us = 0;
            s_voice.metrics.session_active = false;
            s_voice.metrics.sessions_completed++;
        }
        taskEXIT_CRITICAL(&s_voice.lock);
        if (!valid) {
            voice_metric_protocol_error();
            voice_request_reconnect();
        } else {
            voice_playback_receiver_capture_finished();
#if CONFIG_P4HOME_PHASE5B_VALIDATION
            taskENTER_CRITICAL(&s_voice.lock);
            const uint32_t queue_high_water = s_voice.metrics.queue_high_water;
            const uint32_t stack_high_water = s_voice.metrics.worker_stack_high_water_bytes;
            taskEXIT_CRITICAL(&s_voice.lock);
            const bool resources_ok = queue_high_water <= VOICE_TRANSPORT_QUEUE_FRAMES &&
                                      stack_high_water >= 1024U;
            ESP_LOGW(TAG,
                     "VERIFY:phase5b:voice_capture:%s epoch=%" PRIu32
                     " frames=%" PRIu32 " bytes=%" PRIu32 " dropped=%" PRIu32
                     " queue_hwm=%" PRIu32 " stack_hwm=%" PRIu32,
                     resources_ok ? "PASS" : "FAIL", epoch, frames, bytes, dropped,
                     queue_high_water, stack_high_water);
#endif
        }
    } else if (strcmp(type->valuestring, "error") == 0) {
        voice_metric_protocol_error();
        voice_request_abort();
        voice_request_reconnect();
    } else {
        voice_metric_protocol_error();
        voice_request_reconnect();
    }
    cJSON_Delete(root);
}

static void voice_handle_ws_data(const esp_websocket_event_data_t *data)
{
    if (data == NULL || data->data_ptr == NULL || data->data_len <= 0) return;
    size_t total = data->payload_len > 0 ? (size_t)data->payload_len : (size_t)data->data_len;
    size_t offset = data->payload_offset > 0 ? (size_t)data->payload_offset : 0U;
    size_t length = (size_t)data->data_len;
    const bool first_binary = offset == 0U && data->op_code == VOICE_WS_OPCODE_BINARY;
    const size_t maximum = (first_binary || (offset > 0U && s_voice.rx_binary))
                               ? VOICE_PROTOCOL_HEADER_BYTES + VOICE_PROTOCOL_FRAME_PAYLOAD_BYTES
                               : VOICE_TRANSPORT_CONTROL_MAX_BYTES;
    if (total > maximum || offset + length > total) {
        voice_metric_protocol_error();
        voice_request_reconnect();
        s_voice.rx_expected = s_voice.rx_received = 0U;
        return;
    }
    if (offset == 0U) {
        s_voice.rx_expected = total;
        s_voice.rx_received = 0U;
        s_voice.rx_binary = first_binary;
    }
    if (s_voice.rx_expected != total || offset != s_voice.rx_received) {
        voice_metric_protocol_error();
        voice_request_reconnect();
        s_voice.rx_expected = s_voice.rx_received = 0U;
        return;
    }
    memcpy(s_voice.rx_control + offset, data->data_ptr, length);
    s_voice.rx_received += length;
    if (data->fin || s_voice.rx_received == s_voice.rx_expected) {
        if (s_voice.rx_binary) {
            voice_playback_snapshot_t playback;
            voice_playback_receiver_get_snapshot(&playback);
            if (!playback.active ||
                voice_playback_receiver_frame((const uint8_t *)s_voice.rx_control,
                                              s_voice.rx_expected) != ESP_OK) {
                voice_metric_protocol_error();
                if (playback.active) voice_playback_receiver_fail();
                else voice_request_reconnect();
            }
        } else {
            s_voice.rx_control[s_voice.rx_expected] = '\0';
            voice_handle_control(s_voice.rx_control, s_voice.rx_expected);
        }
        s_voice.rx_expected = s_voice.rx_received = 0U;
        s_voice.rx_binary = false;
    }
}

static void voice_ws_event(void *handler_args, esp_event_base_t base,
                           int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        taskENTER_CRITICAL(&s_voice.lock);
        s_voice.socket_connected = true;
        s_voice.metrics.connected = true;
        s_voice.metrics.reconnect_count++;
        taskEXIT_CRITICAL(&s_voice.lock);
        ESP_LOGW(TAG, "voice channel connected");
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        taskENTER_CRITICAL(&s_voice.lock);
        s_voice.socket_connected = false;
        s_voice.ui_ack_pending = false;
        s_voice.metrics.connected = false;
        taskEXIT_CRITICAL(&s_voice.lock);
        voice_request_abort();
        voice_playback_receiver_disconnect();
        break;
    case WEBSOCKET_EVENT_DATA:
        if (data != NULL && (data->op_code == VOICE_WS_OPCODE_TEXT ||
                             data->op_code == VOICE_WS_OPCODE_BINARY ||
                             data->op_code == VOICE_WS_OPCODE_CONTINUATION)) {
            voice_handle_ws_data(data);
        } else if (data != NULL && (data->op_code == VOICE_WS_OPCODE_CLOSE ||
                                    data->op_code == VOICE_WS_OPCODE_PING ||
                                    data->op_code == VOICE_WS_OPCODE_PONG)) {
            /* esp_websocket_client owns RFC 6455 control-frame lifecycle. */
        } else if (data != NULL) {
            voice_metric_protocol_error();
            voice_request_reconnect();
        }
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "voice WebSocket error type=%d",
                 data != NULL ? data->error_handle.error_type : -1);
        break;
    default:
        break;
    }
}

static bool voice_queue_frame(bool eos, uint16_t sample_count, uint64_t captured_at_us)
{
    taskENTER_CRITICAL(&s_voice.lock);
    const bool active = s_voice.session_state != VOICE_SESSION_IDLE;
    taskEXIT_CRITICAL(&s_voice.lock);
    if (sample_count == 0U || sample_count > VOICE_PROTOCOL_FRAME_SAMPLES || !active) {
        return false;
    }
    voice_transport_frame_t frame = {0};
    frame.sequence = s_voice.next_sequence++;
    frame.eos = eos;
    uint8_t flags = eos ? VOICE_PROTOCOL_FLAG_END_OF_STREAM : 0U;
    if (s_voice.pending_discontinuity) flags |= VOICE_PROTOCOL_FLAG_DISCONTINUITY;
    voice_protocol_frame_header_t header = {
        .kind = VOICE_PROTOCOL_FRAME_CAPTURE_PCM,
        .flags = flags,
        .stream_id = s_voice.stream_id,
        .epoch = s_voice.epoch,
        .sequence = frame.sequence,
        .capture_time_us = captured_at_us,
        .payload_bytes = (uint32_t)sample_count * sizeof(int16_t),
        .sample_rate_hz = VOICE_PROTOCOL_SAMPLE_RATE_HZ,
        .frame_samples = sample_count,
        .channels = VOICE_PROTOCOL_CHANNELS,
        .bits_per_sample = VOICE_PROTOCOL_BITS_PER_SAMPLE,
    };
    memcpy(header.session_id, s_voice.session_id, sizeof(header.session_id));
    if (voice_protocol_encode_header(&header, frame.bytes, sizeof(frame.bytes)) != VOICE_PROTOCOL_OK) {
        return false;
    }
    memcpy(frame.bytes + VOICE_PROTOCOL_HEADER_BYTES, s_voice.assembly,
           (size_t)header.payload_bytes);
    frame.length = VOICE_PROTOCOL_HEADER_BYTES + (size_t)header.payload_bytes;
    if (xQueueSend(s_voice.frame_queue, &frame, 0) != pdTRUE) {
        taskENTER_CRITICAL(&s_voice.lock);
        s_voice.metrics.dropped_frames++;
        s_voice.session_dropped_frames++;
        taskEXIT_CRITICAL(&s_voice.lock);
        s_voice.pending_discontinuity = true;
        return false;
    }
    s_voice.pending_discontinuity = false;
    UBaseType_t queued = uxQueueMessagesWaiting(s_voice.frame_queue);
    taskENTER_CRITICAL(&s_voice.lock);
    if ((uint32_t)queued > s_voice.metrics.queue_high_water) {
        s_voice.metrics.queue_high_water = (uint32_t)queued;
    }
    taskEXIT_CRITICAL(&s_voice.lock);
    return true;
}

static bool voice_begin_capture(void *context, uint64_t started_at_us)
{
    (void)context;
    taskENTER_CRITICAL(&s_voice.lock);
    const bool candidate = s_voice.enabled && s_voice.socket_connected &&
                           s_voice.session_state == VOICE_SESSION_IDLE &&
                           !s_voice.epoch_reservation_in_progress &&
                           s_voice.epoch < s_voice.epoch_reserved_end;
    taskEXIT_CRITICAL(&s_voice.lock);
    if (!candidate) {
        voice_playback_receiver_capture_finished();
        voice_playback_receiver_capture_failed();
        return false;
    }

    uint8_t session_id[sizeof(s_voice.session_id)];
    char session_id_hex[sizeof(s_voice.session_id_hex)];
    esp_fill_random(session_id, sizeof(session_id));
    bool nonzero = false;
    for (size_t i = 0; i < sizeof(session_id); ++i) nonzero |= session_id[i] != 0U;
    if (!nonzero) session_id[0] = 1U;
    for (size_t i = 0; i < sizeof(session_id); ++i) {
        snprintf(session_id_hex + i * 2U, 3U, "%02x", session_id[i]);
    }
    uint32_t stream_id = esp_random();
    if (stream_id == 0U) stream_id = 1U;
    uint32_t accepted_epoch = 0U;

    xQueueReset(s_voice.frame_queue);
    taskENTER_CRITICAL(&s_voice.lock);
    const bool accepted = s_voice.enabled && s_voice.socket_connected &&
                          s_voice.session_state == VOICE_SESSION_IDLE &&
                          !s_voice.epoch_reservation_in_progress &&
                          s_voice.epoch < s_voice.epoch_reserved_end;
    if (accepted) {
        const uint32_t next_epoch = s_voice.epoch + 1U;
        if (next_epoch == 0U) {
            s_voice.metrics.protocol_errors++;
            taskEXIT_CRITICAL(&s_voice.lock);
            voice_playback_receiver_capture_finished();
            return false;
        }
        s_voice.session_state = VOICE_SESSION_OPENING;
        memcpy(s_voice.session_id, session_id, sizeof(s_voice.session_id));
        memcpy(s_voice.session_id_hex, session_id_hex, sizeof(s_voice.session_id_hex));
        s_voice.stream_id = stream_id;
        s_voice.epoch = next_epoch;
        s_voice.next_sequence = 0U;
        s_voice.final_sequence = 0U;
        s_voice.available_credit = 0U;
        s_voice.outstanding_frames = 0U;
        s_voice.last_ack_sequence = -1;
        s_voice.last_sent_sequence = 0U;
        s_voice.session_frames_sent = 0U;
        s_voice.session_bytes_sent = 0U;
        s_voice.session_dropped_frames = 0U;
        s_voice.session_deadline_us = (int64_t)started_at_us + VOICE_TRANSPORT_OPEN_TIMEOUT_US;
        s_voice.assembly_samples = 0U;
        s_voice.assembly_started_at_us = started_at_us;
        s_voice.pending_discontinuity = false;
        s_voice.end_requested = false;
        s_voice.eos_sent = false;
        memcpy(s_voice.end_reason, "source_complete", sizeof("source_complete"));
        s_voice.open_requested = true;
        s_voice.metrics.session_active = true;
        s_voice.metrics.sessions_started++;
        s_voice.metrics.last_epoch = next_epoch;
        accepted_epoch = next_epoch;
    }
    taskEXIT_CRITICAL(&s_voice.lock);
    if (accepted) {
        ESP_LOGW(TAG, "capture opened epoch=%" PRIu32, accepted_epoch);
    } else {
        voice_playback_receiver_capture_finished();
        voice_playback_receiver_capture_failed();
    }
    return accepted;
}

static void voice_wake_detected(void *context, uint64_t detected_at_us)
{
    (void)context;
    (void)detected_at_us;
    const bool dependency_ready = voice_capture_dependency_ready();
    taskENTER_CRITICAL(&s_voice.lock);
    s_voice.suppress_wake_session = !dependency_ready;
    taskEXIT_CRITICAL(&s_voice.lock);
    voice_playback_receiver_barge_in();
    if (dependency_ready) voice_playback_receiver_request_wake_prompt();
    else voice_playback_receiver_request_connecting_prompt();
}

static bool voice_ready_for_capture(void *context)
{
    (void)context;
    return voice_playback_receiver_allow_capture();
}

static bool voice_suppress_wake_session(void *context)
{
    (void)context;
    taskENTER_CRITICAL(&s_voice.lock);
    const bool requested = s_voice.suppress_wake_session;
    s_voice.suppress_wake_session = false;
    taskEXIT_CRITICAL(&s_voice.lock);
    const bool dependency_ready = voice_capture_dependency_ready();
    const bool suppress = requested || !dependency_ready;
    if (suppress) {
        voice_playback_receiver_capture_finished();
        voice_playback_receiver_capture_failed();
        ESP_LOGW(TAG,
                 "VERIFY:voice:ha_gate:PASS action=suppressed_capture ha_ready=%s",
                 dependency_ready ? "yes" : "no");
    }
    return suppress;
}

static void voice_offer_pcm(void *context, const int16_t *samples, size_t sample_count,
                            uint64_t captured_at_us)
{
    (void)context;
    taskENTER_CRITICAL(&s_voice.lock);
    const bool accepting = s_voice.session_state != VOICE_SESSION_IDLE && !s_voice.end_requested;
    taskEXIT_CRITICAL(&s_voice.lock);
    if (samples == NULL || !accepting) return;
    size_t offset = 0U;
    while (offset < sample_count) {
        if (s_voice.assembly_samples == 0U) s_voice.assembly_started_at_us = captured_at_us;
        size_t remaining = VOICE_PROTOCOL_FRAME_SAMPLES - s_voice.assembly_samples;
        size_t copy = sample_count - offset < remaining ? sample_count - offset : remaining;
        memcpy(s_voice.assembly + s_voice.assembly_samples, samples + offset,
               copy * sizeof(int16_t));
        s_voice.assembly_samples += copy;
        offset += copy;
        if (s_voice.assembly_samples == VOICE_PROTOCOL_FRAME_SAMPLES) {
            (void)voice_queue_frame(false, VOICE_PROTOCOL_FRAME_SAMPLES,
                                    s_voice.assembly_started_at_us);
            s_voice.assembly_samples = 0U;
        }
    }
}

static void voice_end_capture(void *context, const char *reason, uint64_t ended_at_us)
{
    (void)context;
    taskENTER_CRITICAL(&s_voice.lock);
    const bool active = s_voice.session_state != VOICE_SESSION_IDLE && !s_voice.end_requested;
    taskEXIT_CRITICAL(&s_voice.lock);
    if (!active) return;
    voice_playback_receiver_capture_ended();
    if (reason != NULL && strstr(reason, "timeout") != NULL) {
        snprintf(s_voice.end_reason, sizeof(s_voice.end_reason), "%s", "max_duration");
    } else {
        snprintf(s_voice.end_reason, sizeof(s_voice.end_reason), "%s", "source_complete");
    }
    if (s_voice.assembly_samples == 0U) {
        s_voice.assembly[0] = 0;
        s_voice.assembly_samples = 1U;
        s_voice.assembly_started_at_us = ended_at_us;
    }
    if (!voice_queue_frame(true, (uint16_t)s_voice.assembly_samples,
                           s_voice.assembly_started_at_us)) {
        voice_request_abort();
        voice_request_reconnect();
    }
    s_voice.assembly_samples = 0U;
    taskENTER_CRITICAL(&s_voice.lock);
    s_voice.end_requested = true;
    s_voice.session_deadline_us = (int64_t)ended_at_us + VOICE_TRANSPORT_END_TIMEOUT_US;
    taskEXIT_CRITICAL(&s_voice.lock);
}

static void voice_worker(void *argument)
{
    (void)argument;
    while (s_voice.running) {
        taskENTER_CRITICAL(&s_voice.lock);
        const bool abort_requested = s_voice.abort_requested;
        s_voice.abort_requested = false;
        taskEXIT_CRITICAL(&s_voice.lock);
        if (abort_requested) {
            voice_abort_session("voice channel aborted");
        }
        voice_ui_ack_t ui_ack = {0};
        taskENTER_CRITICAL(&s_voice.lock);
        const bool send_ui_ack = s_voice.socket_connected && s_voice.ui_ack_pending;
        if (send_ui_ack) {
            memcpy(&ui_ack, &s_voice.pending_ui_ack, sizeof(ui_ack));
            s_voice.ui_ack_pending = false;
        }
        taskEXIT_CRITICAL(&s_voice.lock);
        if (send_ui_ack) {
            if (voice_send_ui_applied(&ui_ack) == ESP_OK) {
                ESP_LOGW(TAG,
                         "VERIFY:phase5e:ui_applied:PASS epoch=%" PRIu32
                         " revision=%" PRIu32,
                         ui_ack.epoch, ui_ack.revision);
            } else {
                voice_metric_protocol_error();
                voice_request_reconnect();
            }
        }
        const int64_t now_us = esp_timer_get_time();
        taskENTER_CRITICAL(&s_voice.lock);
        const bool reserve_epoch = s_voice.session_state == VOICE_SESSION_IDLE &&
                                   !s_voice.epoch_reservation_in_progress &&
                                   s_voice.epoch_reserved_end > 0U &&
                                   s_voice.epoch <= s_voice.epoch_reserved_end &&
                                   s_voice.epoch_reserved_end - s_voice.epoch <=
                                       VOICE_TRANSPORT_EPOCH_RESERVE_THRESHOLD &&
                                   now_us >= s_voice.epoch_reservation_retry_at_us;
        if (reserve_epoch) s_voice.epoch_reservation_in_progress = true;
        taskEXIT_CRITICAL(&s_voice.lock);
        if (reserve_epoch) {
            if (xTaskCreate(voice_epoch_reservation_task, "voice_epoch",
                            VOICE_TRANSPORT_EPOCH_TASK_STACK, NULL, 4, NULL) != pdPASS) {
                taskENTER_CRITICAL(&s_voice.lock);
                s_voice.epoch_reservation_in_progress = false;
                s_voice.epoch_reservation_retry_at_us = now_us + VOICE_TRANSPORT_EPOCH_RETRY_US;
                s_voice.metrics.protocol_errors++;
                taskEXIT_CRITICAL(&s_voice.lock);
            }
        }
        taskENTER_CRITICAL(&s_voice.lock);
        const bool session_timed_out = s_voice.session_state != VOICE_SESSION_IDLE &&
                                       s_voice.session_deadline_us > 0 &&
                                       now_us >= s_voice.session_deadline_us;
        taskEXIT_CRITICAL(&s_voice.lock);
        if (session_timed_out) {
            voice_abort_session("voice session timeout");
            voice_request_reconnect();
        }
        taskENTER_CRITICAL(&s_voice.lock);
        const bool reconnect_requested = s_voice.reconnect_requested && s_voice.ws != NULL;
        if (reconnect_requested) s_voice.reconnect_requested = false;
        taskEXIT_CRITICAL(&s_voice.lock);
        if (reconnect_requested) {
            (void)esp_websocket_client_stop(s_voice.ws);
            if (s_voice.running && esp_websocket_client_start(s_voice.ws) != ESP_OK) {
                voice_request_reconnect();
            }
            vTaskDelay(pdMS_TO_TICKS(VOICE_TRANSPORT_WORKER_INTERVAL_MS));
            continue;
        }
        taskENTER_CRITICAL(&s_voice.lock);
        const bool send_open = s_voice.socket_connected && s_voice.open_requested;
        if (send_open) s_voice.open_requested = false;
        taskEXIT_CRITICAL(&s_voice.lock);
        if (send_open && voice_send_open() != ESP_OK) {
            taskENTER_CRITICAL(&s_voice.lock);
            if (s_voice.session_state == VOICE_SESSION_OPENING) s_voice.open_requested = true;
            taskEXIT_CRITICAL(&s_voice.lock);
            voice_request_reconnect();
        }
        while (true) {
            taskENTER_CRITICAL(&s_voice.lock);
            const bool can_send = s_voice.socket_connected &&
                                  s_voice.session_state == VOICE_SESSION_READY &&
                                  s_voice.available_credit > 0U;
            taskEXIT_CRITICAL(&s_voice.lock);
            if (!can_send) break;
            voice_transport_frame_t frame;
            if (xQueueReceive(s_voice.frame_queue, &frame, 0) != pdTRUE) break;
            taskENTER_CRITICAL(&s_voice.lock);
            const bool still_valid = s_voice.socket_connected &&
                                     s_voice.session_state == VOICE_SESSION_READY &&
                                     s_voice.available_credit > 0U &&
                                     s_voice.outstanding_frames < VOICE_TRANSPORT_MAX_INFLIGHT_FRAMES;
            if (still_valid) {
                s_voice.available_credit--;
                s_voice.outstanding_sequences[s_voice.outstanding_frames] = frame.sequence;
                s_voice.outstanding_frames++;
                s_voice.last_sent_sequence = frame.sequence;
                s_voice.metrics.available_credit = s_voice.available_credit;
            }
            taskEXIT_CRITICAL(&s_voice.lock);
            if (!still_valid) {
                voice_request_abort();
                break;
            }
            if (voice_send_binary(frame.bytes, frame.length) != ESP_OK) {
                voice_abort_session("binary send failed");
                voice_request_reconnect();
                break;
            }
            taskENTER_CRITICAL(&s_voice.lock);
            s_voice.metrics.frames_sent++;
            s_voice.metrics.bytes_sent += (uint32_t)(frame.length - VOICE_PROTOCOL_HEADER_BYTES);
            s_voice.session_frames_sent++;
            s_voice.session_bytes_sent +=
                (uint32_t)(frame.length - VOICE_PROTOCOL_HEADER_BYTES);
            if (frame.eos) {
                s_voice.eos_sent = true;
                s_voice.final_sequence = frame.sequence;
            }
            taskEXIT_CRITICAL(&s_voice.lock);
            if (frame.eos) break;
        }
        const int64_t close_deadline_us = esp_timer_get_time() + VOICE_TRANSPORT_END_TIMEOUT_US;
        taskENTER_CRITICAL(&s_voice.lock);
        const bool send_eos = s_voice.socket_connected &&
                              s_voice.session_state == VOICE_SESSION_READY &&
                              s_voice.end_requested && s_voice.eos_sent;
        if (send_eos) {
            s_voice.session_state = VOICE_SESSION_WAITING_CLOSE;
            s_voice.session_deadline_us = close_deadline_us;
        }
        taskEXIT_CRITICAL(&s_voice.lock);
        if (send_eos && voice_send_eos_control() != ESP_OK) {
            voice_abort_session("EOS control send failed");
            voice_request_reconnect();
        }
        taskENTER_CRITICAL(&s_voice.lock);
        s_voice.metrics.worker_stack_high_water_bytes =
            (uint32_t)uxTaskGetStackHighWaterMark(NULL);
        taskEXIT_CRITICAL(&s_voice.lock);
        vTaskDelay(pdMS_TO_TICKS(VOICE_TRANSPORT_WORKER_INTERVAL_MS));
    }
    for (;;) vTaskSuspend(NULL);
}

static esp_err_t voice_delete_worker_task(void)
{
    TaskHandle_t worker = s_voice.worker_task;
    if (worker == NULL) return ESP_OK;
    for (size_t i = 0; i < 250U; ++i) {
        if (eTaskGetState(worker) == eSuspended) {
            vTaskDeleteWithCaps(worker);
            s_voice.worker_task = NULL;
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return ESP_ERR_TIMEOUT;
}

esp_err_t voice_transport_set_capture_readiness_probe(
    voice_transport_capture_readiness_probe_t probe, void *context)
{
    ESP_RETURN_ON_FALSE(!s_voice.initialized && !s_voice.running,
                        ESP_ERR_INVALID_STATE, TAG,
                        "capture readiness probe must be set before initialization");
    ESP_RETURN_ON_FALSE(probe != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "capture readiness probe is required");
    s_voice.capture_readiness_probe = probe;
    s_voice.capture_readiness_context = context;
    return ESP_OK;
}

esp_err_t voice_transport_init(const voice_transport_config_t *config)
{
    if (s_voice.initialized) return ESP_OK;
    memset(&s_voice.metrics, 0, sizeof(s_voice.metrics));
#if CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED
    voice_transport_config_t build = {0};
    uint8_t pin[VOICE_TRANSPORT_SPKI_SHA256_BYTES];
#endif
    if (config == NULL) {
#if CONFIG_P4HOME_VOICE_TRANSPORT_ENABLED
        if (!voice_decode_pin(CONFIG_P4HOME_VOICE_SPKI_SHA256, pin)) return ESP_ERR_INVALID_ARG;
        build.uri = CONFIG_P4HOME_VOICE_TRANSPORT_URI;
        build.device_id = CONFIG_P4HOME_VOICE_DEVICE_ID;
        build.device_token = CONFIG_P4HOME_VOICE_DEVICE_TOKEN;
        memcpy(build.paired_spki_sha256, pin, sizeof(pin));
        config = &build;
#else
        s_voice.initialized = true;
        s_voice.metrics.initialized = true;
        ESP_LOGI(TAG, "voice transport disabled");
        return ESP_OK;
#endif
    }
    ESP_RETURN_ON_FALSE(s_voice.capture_readiness_probe != NULL,
                        ESP_ERR_INVALID_STATE, TAG,
                        "capture readiness probe is not configured");
    if (!voice_valid_uri(config->uri) || !voice_valid_id(config->device_id) ||
        !voice_valid_token(config->device_token)) return ESP_ERR_INVALID_ARG;
    uint8_t zero_pin[VOICE_TRANSPORT_SPKI_SHA256_BYTES] = {0};
    if (voice_constant_time_equal(config->paired_spki_sha256, zero_pin, sizeof(zero_pin))) {
        return ESP_ERR_INVALID_ARG;
    }
    snprintf(s_voice.uri, sizeof(s_voice.uri), "%s", config->uri);
    snprintf(s_voice.device_id, sizeof(s_voice.device_id), "%s", config->device_id);
    snprintf(s_voice.token, sizeof(s_voice.token), "%s", config->device_token);
    memcpy(s_voice.spki_sha256, config->paired_spki_sha256, sizeof(s_voice.spki_sha256));
    ESP_RETURN_ON_ERROR(voice_reserve_epoch_block(), TAG, "failed to reserve voice epoch block");
    snprintf(s_voice.headers, sizeof(s_voice.headers),
             "Authorization: Bearer %s\r\nX-P4-Device-ID: %s\r\n",
             s_voice.token, s_voice.device_id);
    s_voice.frame_queue = xQueueCreate(VOICE_TRANSPORT_QUEUE_FRAMES,
                                       sizeof(voice_transport_frame_t));
    if (s_voice.frame_queue == NULL) return ESP_ERR_NO_MEM;
    s_voice.send_mutex = xSemaphoreCreateMutex();
    if (s_voice.send_mutex == NULL) {
        vQueueDelete(s_voice.frame_queue);
        s_voice.frame_queue = NULL;
        return ESP_ERR_NO_MEM;
    }
    esp_err_t result = voice_playback_receiver_init(voice_playback_send_json, NULL);
    if (result != ESP_OK) {
        vSemaphoreDelete(s_voice.send_mutex);
        s_voice.send_mutex = NULL;
        vQueueDelete(s_voice.frame_queue);
        s_voice.frame_queue = NULL;
        return result;
    }
    result = conversation_service_set_rendered_observer(voice_conversation_rendered, NULL);
    if (result != ESP_OK) {
        vSemaphoreDelete(s_voice.send_mutex);
        s_voice.send_mutex = NULL;
        vQueueDelete(s_voice.frame_queue);
        s_voice.frame_queue = NULL;
        return result;
    }
    const sr_service_capture_listener_t listener = {
        .context = NULL,
        .wake_detected = voice_wake_detected,
        .ready_for_capture = voice_ready_for_capture,
        .suppress_wake_session = voice_suppress_wake_session,
        .begin_capture = voice_begin_capture,
        .offer_pcm = voice_offer_pcm,
        .end_capture = voice_end_capture,
    };
    result = sr_service_register_capture_listener(&listener);
    if (result != ESP_OK) {
        (void)conversation_service_set_rendered_observer(NULL, NULL);
        vSemaphoreDelete(s_voice.send_mutex);
        s_voice.send_mutex = NULL;
        vQueueDelete(s_voice.frame_queue);
        s_voice.frame_queue = NULL;
        return result;
    }
    s_voice.initialized = true;
    s_voice.enabled = true;
    s_voice.metrics.initialized = true;
    s_voice.metrics.enabled = true;
    ESP_LOGI(TAG, "voice transport configured device_id=%s uri=%s token=(redacted)",
             s_voice.device_id, s_voice.uri);
    return ESP_OK;
}

esp_err_t voice_transport_start(void)
{
    ESP_RETURN_ON_FALSE(s_voice.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "voice transport not initialized");
    if (!s_voice.enabled || s_voice.running) return ESP_OK;
    ESP_RETURN_ON_ERROR(voice_playback_receiver_start(), TAG,
                        "failed to start voice playback receiver");
    esp_websocket_client_config_t config = {
        .uri = s_voice.uri,
        .headers = s_voice.headers,
        .buffer_size = 1024,
        .task_stack = CONFIG_P4HOME_VOICE_WEBSOCKET_TASK_STACK,
        .crt_bundle_attach = voice_attach_spki_verifier,
        .skip_cert_common_name_check = true,
        .reconnect_timeout_ms = CONFIG_P4HOME_VOICE_RECONNECT_TIMEOUT_MS,
        .enable_close_reconnect = true,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 10,
        .pingpong_timeout_sec = 10,
        .keep_alive_enable = true,
        .keep_alive_idle = 5,
        .keep_alive_interval = 5,
        .keep_alive_count = 3,
    };
    s_voice.ws = esp_websocket_client_init(&config);
    if (s_voice.ws == NULL) {
        (void)voice_playback_receiver_stop();
        return ESP_ERR_NO_MEM;
    }
    esp_err_t result = esp_websocket_register_events(s_voice.ws, WEBSOCKET_EVENT_ANY,
                                                      voice_ws_event, NULL);
    if (result != ESP_OK) {
        esp_websocket_client_destroy(s_voice.ws);
        s_voice.ws = NULL;
        (void)voice_playback_receiver_stop();
        return result;
    }
    s_voice.running = true;
    if (xTaskCreateWithCaps(voice_worker, "voice_transport",
                            CONFIG_P4HOME_VOICE_TRANSPORT_TASK_STACK, NULL, 5,
                            &s_voice.worker_task,
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
        s_voice.running = false;
        esp_websocket_client_destroy(s_voice.ws);
        s_voice.ws = NULL;
        (void)voice_playback_receiver_stop();
        return ESP_ERR_NO_MEM;
    }
    result = esp_websocket_client_start(s_voice.ws);
    if (result != ESP_OK) {
        s_voice.running = false;
        const esp_err_t worker_result = voice_delete_worker_task();
        esp_websocket_client_destroy(s_voice.ws);
        s_voice.ws = NULL;
        (void)voice_playback_receiver_stop();
        return worker_result == ESP_OK ? result : worker_result;
    }
    return ESP_OK;
}

esp_err_t voice_transport_stop(void)
{
    if (!s_voice.initialized || (!s_voice.running && s_voice.ws == NULL)) return ESP_OK;
    s_voice.running = false;
    ESP_RETURN_ON_ERROR(voice_delete_worker_task(), TAG, "failed to stop voice worker task");
    voice_abort_session("voice transport stopped");
    voice_playback_receiver_disconnect();
    ESP_RETURN_ON_ERROR(voice_playback_receiver_stop(), TAG,
                        "failed to stop voice playback receiver");
    if (s_voice.ws != NULL) {
        (void)esp_websocket_client_stop(s_voice.ws);
        esp_websocket_client_destroy(s_voice.ws);
        s_voice.ws = NULL;
    }
    return ESP_OK;
}

bool voice_transport_is_connected(void)
{
    taskENTER_CRITICAL(&s_voice.lock);
    bool connected = s_voice.socket_connected;
    taskEXIT_CRITICAL(&s_voice.lock);
    return connected;
}

void voice_transport_get_snapshot(voice_transport_snapshot_t *snapshot)
{
    if (snapshot == NULL) return;
    taskENTER_CRITICAL(&s_voice.lock);
    *snapshot = s_voice.metrics;
    taskEXIT_CRITICAL(&s_voice.lock);
    voice_playback_snapshot_t playback;
    voice_playback_receiver_get_snapshot(&playback);
    snapshot->playback_active = playback.active;
    snapshot->playback_output_quarantined = playback.output_quarantined;
    snapshot->playback_sessions_started = playback.sessions_started;
    snapshot->playback_sessions_completed = playback.sessions_completed;
    snapshot->playback_sessions_cancelled = playback.sessions_cancelled;
    snapshot->playback_sessions_failed = playback.sessions_failed;
    snapshot->playback_frames_received = playback.frames_received;
    snapshot->playback_frames_played = playback.frames_played;
    snapshot->playback_bytes_played = playback.bytes_played;
    snapshot->playback_dropped_frames = playback.dropped_frames;
    snapshot->playback_queue_high_water = playback.queue_high_water;
    snapshot->playback_barge_in_count = playback.barge_in_count;
    snapshot->playback_speaker_close_failures = playback.speaker_close_failures;
    snapshot->playback_stack_high_water_bytes = playback.stack_high_water_bytes;
}
