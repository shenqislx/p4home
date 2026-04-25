#include "ha_client.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "network_service.h"
#include "settings_service.h"
#include "time_service.h"

static const char *TAG = "ha_client";

#define HA_CLIENT_READY_BIT         BIT0
#define HA_CLIENT_AUTH_FAIL_BIT     BIT1
#define HA_CLIENT_FATAL_ERROR_BIT   BIT2
#define HA_CLIENT_SUB_READY_BIT     BIT3
#define HA_CLIENT_INITIAL_DONE_BIT  BIT4
#define HA_CLIENT_STOP_BIT          BIT5
#define HA_CLIENT_MAX_INITIAL_ENTITIES 32U
#define HA_CLIENT_ENTITY_ID_MAX_LEN 128U

#ifndef CONFIG_P4HOME_HA_CLIENT_START_DELAY_MS
#define CONFIG_P4HOME_HA_CLIENT_START_DELAY_MS 30000
#endif
#ifndef CONFIG_P4HOME_HA_CLIENT_WORKER_STACK
#define CONFIG_P4HOME_HA_CLIENT_WORKER_STACK 12288
#endif
#ifndef CONFIG_P4HOME_HA_CLIENT_WS_TASK_STACK
#define CONFIG_P4HOME_HA_CLIENT_WS_TASK_STACK 8192
#endif

typedef enum {
    HA_SUB_STATE_IDLE = 0,
    HA_SUB_STATE_WAIT_SUBSCRIBE_ACK,
    HA_SUB_STATE_WAIT_INITIAL_STATES,
    HA_SUB_STATE_STEADY,
} ha_sub_state_t;

typedef enum {
    HA_PENDING_NONE = 0,
    HA_PENDING_SUBSCRIBE,
    HA_PENDING_GET_STATES,
} ha_pending_type_t;

typedef struct {
    bool active;
    uint32_t id;
    ha_pending_type_t type;
} ha_pending_entry_t;

typedef struct {
    bool initialized;
    bool running;
    bool stop_requested;
    bool retry_lockout;
    bool ws_connected;
    bool auth_sent;
    bool authenticated;
    bool subscription_ready;
    ha_client_state_t state;
    ha_sub_state_t sub_state;
    EventGroupHandle_t event_group;
    TaskHandle_t worker_task;
    esp_websocket_client_handle_t ws;
    portMUX_TYPE lock;
    uint32_t next_message_id;
    ha_pending_entry_t pending[4];
    ha_client_state_change_cb_t callback;
    void *callback_user;
    char *rx_frame;
    size_t rx_frame_expected;
    size_t rx_frame_received;
    bool rx_dropping;
    size_t rx_drop_expected;
    char initial_entities[HA_CLIENT_MAX_INITIAL_ENTITIES][HA_CLIENT_ENTITY_ID_MAX_LEN];
    size_t initial_entity_count;
    char normalized_url[256];
    char last_error[48];
    char token_masked[24];
    uint32_t initial_state_count;
    uint32_t total_event_count;
    uint32_t reconnect_count;
    uint32_t bucket_a;
    uint32_t bucket_b;
    uint64_t bucket_epoch_ms;
    uint64_t last_connected_at_ms;
    uint64_t last_ready_at_ms;
    uint64_t last_event_at_ms;
    uint64_t connected_duration_ms;
} ha_client_state_ctx_t;

static ha_client_state_ctx_t s_ctx = {
    .initialized = false,
    .running = false,
    .stop_requested = false,
    .retry_lockout = false,
    .ws_connected = false,
    .auth_sent = false,
    .authenticated = false,
    .subscription_ready = false,
    .state = HA_CLIENT_STATE_IDLE,
    .sub_state = HA_SUB_STATE_IDLE,
    .event_group = NULL,
    .worker_task = NULL,
    .ws = NULL,
    .lock = portMUX_INITIALIZER_UNLOCKED,
    .next_message_id = 1U,
    .normalized_url = {0},
    .last_error = "idle",
    .token_masked = {0},
};

static uint64_t ha_client_now_ms(void)
{
    return (uint64_t)(esp_timer_get_time() / 1000ULL);
}

static void ha_client_set_state_locked(ha_client_state_t state)
{
    if (s_ctx.state == HA_CLIENT_STATE_READY && state != HA_CLIENT_STATE_READY && s_ctx.last_connected_at_ms != 0U) {
        s_ctx.connected_duration_ms += ha_client_now_ms() - s_ctx.last_connected_at_ms;
        s_ctx.last_connected_at_ms = 0U;
    }
    s_ctx.state = state;
    if (state == HA_CLIENT_STATE_READY) {
        s_ctx.last_ready_at_ms = ha_client_now_ms();
        s_ctx.last_connected_at_ms = s_ctx.last_ready_at_ms;
    }
}

static void ha_client_set_error_locked(const char *reason)
{
    snprintf(s_ctx.last_error, sizeof(s_ctx.last_error), "%s", reason != NULL ? reason : "unknown");
}

static uint32_t ha_client_alloc_message_id(void)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    uint32_t id = s_ctx.next_message_id++;
    if (s_ctx.next_message_id == 0U) {
        s_ctx.next_message_id = 1U;
    }
    taskEXIT_CRITICAL(&s_ctx.lock);
    return id;
}

static void ha_client_set_pending(uint32_t id, ha_pending_type_t type)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    for (size_t i = 0; i < sizeof(s_ctx.pending) / sizeof(s_ctx.pending[0]); ++i) {
        if (!s_ctx.pending[i].active) {
            s_ctx.pending[i].active = true;
            s_ctx.pending[i].id = id;
            s_ctx.pending[i].type = type;
            break;
        }
    }
    taskEXIT_CRITICAL(&s_ctx.lock);
}

static ha_pending_type_t ha_client_take_pending(uint32_t id)
{
    ha_pending_type_t type = HA_PENDING_NONE;
    taskENTER_CRITICAL(&s_ctx.lock);
    for (size_t i = 0; i < sizeof(s_ctx.pending) / sizeof(s_ctx.pending[0]); ++i) {
        if (s_ctx.pending[i].active && s_ctx.pending[i].id == id) {
            type = s_ctx.pending[i].type;
            memset(&s_ctx.pending[i], 0, sizeof(s_ctx.pending[i]));
            break;
        }
    }
    taskEXIT_CRITICAL(&s_ctx.lock);
    return type;
}

static void ha_client_reset_subscription_locked(void)
{
    s_ctx.sub_state = HA_SUB_STATE_IDLE;
    s_ctx.subscription_ready = false;
    s_ctx.initial_state_count = 0U;
    memset(s_ctx.pending, 0, sizeof(s_ctx.pending));
}

static void ha_client_reset_rx_frame(void)
{
    if (s_ctx.rx_frame != NULL) {
        free(s_ctx.rx_frame);
        s_ctx.rx_frame = NULL;
    }
    s_ctx.rx_frame_expected = 0U;
    s_ctx.rx_frame_received = 0U;
    s_ctx.rx_dropping = false;
    s_ctx.rx_drop_expected = 0U;
}

static void ha_client_start_drop_rx_frame(size_t expected_len)
{
    ha_client_reset_rx_frame();
    s_ctx.rx_dropping = true;
    s_ctx.rx_drop_expected = expected_len;
}

static void ha_client_metrics_record_event_locked(void)
{
    uint64_t now_ms = ha_client_now_ms();
    if (s_ctx.bucket_epoch_ms == 0U) {
        s_ctx.bucket_epoch_ms = now_ms;
    }
    if (now_ms - s_ctx.bucket_epoch_ms >= 60000U) {
        s_ctx.bucket_a = s_ctx.bucket_b;
        s_ctx.bucket_b = 0U;
        s_ctx.bucket_epoch_ms = now_ms;
    } else if (now_ms - s_ctx.bucket_epoch_ms >= 30000U) {
        s_ctx.bucket_a = s_ctx.bucket_b;
        s_ctx.bucket_b = 0U;
        s_ctx.bucket_epoch_ms = now_ms - ((now_ms - s_ctx.bucket_epoch_ms) % 30000U);
    }
    s_ctx.bucket_b++;
    s_ctx.total_event_count++;
    s_ctx.last_event_at_ms = now_ms;
}

static bool ha_client_parse_url(const char *input, char *output, size_t output_len)
{
    if (input == NULL || output == NULL || output_len == 0U || input[0] == '\0') {
        return false;
    }

    char scheme[8] = {0};
    char host[128] = {0};
    char path[96] = {0};
    int port = 0;

    const char *sep = strstr(input, "://");
    if (sep == NULL) {
        snprintf(scheme, sizeof(scheme), "http");
        size_t input_len = strlen(input);
        if (input_len >= sizeof(host)) {
            return false;
        }
        memcpy(host, input, input_len + 1U);
    } else {
        size_t scheme_len = (size_t)(sep - input);
        if (scheme_len >= sizeof(scheme)) {
            return false;
        }
        memcpy(scheme, input, scheme_len);
        const char *rest = sep + 3;
        const char *slash = strchr(rest, '/');
        if (slash == NULL) {
            snprintf(host, sizeof(host), "%s", rest);
        } else {
            size_t host_len = (size_t)(slash - rest);
            if (host_len >= sizeof(host)) {
                return false;
            }
            memcpy(host, rest, host_len);
            snprintf(path, sizeof(path), "%s", slash);
        }
    }

    char *port_sep = strchr(host, ':');
    if (port_sep != NULL) {
        *port_sep = '\0';
        port = atoi(port_sep + 1);
    }

    bool secure = strcmp(scheme, "https") == 0 || strcmp(scheme, "wss") == 0;
    const char *ws_scheme = secure ? "wss" : "ws";
    if (port == 0) {
        if (strcmp(scheme, "ws") == 0 || strcmp(scheme, "wss") == 0) {
            port = 8123;
        } else if (strcmp(scheme, "https") == 0) {
            port = 443;
        } else {
            port = 80;
        }
    }

    if (path[0] == '\0' || strcmp(path, "/") == 0) {
        snprintf(path, sizeof(path), "/api/websocket");
    } else if (strcmp(path, "/api/websocket") != 0) {
        snprintf(path, sizeof(path), "/api/websocket");
    }

    snprintf(output, output_len, "%s://%s:%d%s", ws_scheme, host, port, path);
    return true;
}

static bool ha_client_make_rest_state_url(const char *input, const char *entity_id,
                                          char *output, size_t output_len)
{
    if (input == NULL || entity_id == NULL || output == NULL || output_len == 0U ||
        input[0] == '\0' || entity_id[0] == '\0') {
        return false;
    }

    char scheme[8] = {0};
    char host[128] = {0};
    int port = 0;

    const char *sep = strstr(input, "://");
    if (sep == NULL) {
        snprintf(scheme, sizeof(scheme), "http");
        size_t input_len = strlen(input);
        if (input_len == 0U || input_len >= sizeof(host)) {
            return false;
        }
        memcpy(host, input, input_len + 1U);
    } else {
        size_t scheme_len = (size_t)(sep - input);
        if (scheme_len >= sizeof(scheme)) {
            return false;
        }
        memcpy(scheme, input, scheme_len);
        const char *rest = sep + 3;
        const char *slash = strchr(rest, '/');
        size_t host_len = slash == NULL ? strlen(rest) : (size_t)(slash - rest);
        if (host_len == 0U || host_len >= sizeof(host)) {
            return false;
        }
        memcpy(host, rest, host_len);
        host[host_len] = '\0';
    }

    char *port_sep = strchr(host, ':');
    if (port_sep != NULL) {
        *port_sep = '\0';
        port = atoi(port_sep + 1);
    }

    bool secure = strcmp(scheme, "https") == 0 || strcmp(scheme, "wss") == 0;
    const char *http_scheme = secure ? "https" : "http";
    if (port == 0) {
        if (strcmp(scheme, "https") == 0 || strcmp(scheme, "wss") == 0) {
            port = 443;
        } else if (strcmp(scheme, "http") == 0 || strcmp(scheme, "ws") == 0) {
            port = 80;
        } else {
            port = 8123;
        }
    }

    int written = snprintf(output, output_len, "%s://%s:%d/api/states/%s",
                           http_scheme, host, port, entity_id);
    return written > 0 && (size_t)written < output_len;
}

static bool ha_client_parse_timestamp_ms(const char *input, uint64_t *epoch_ms)
{
    if (input == NULL || epoch_ms == NULL) {
        return false;
    }

    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    if (sscanf(input, "%d-%d-%dT%d:%d:%d", &year, &month, &day, &hour, &minute, &second) != 6) {
        return false;
    }

    int tz_sign = 0;
    int tz_hour = 0;
    int tz_minute = 0;
    const char *tz = strchr(input, 'T');
    if (tz != NULL) {
        tz = strpbrk(tz, "Z+-");
        while (tz != NULL && *tz == '-' && tz > input && *(tz - 1) != 'T' && *(tz - 1) != '.' &&
               (*(tz - 1) < '0' || *(tz - 1) > '9')) {
            tz = strpbrk(tz + 1, "Z+-");
        }
    }
    if (tz != NULL && *tz == 'Z') {
        tz_sign = 0;
    } else if (tz != NULL && (*tz == '+' || *tz == '-')) {
        tz_sign = *tz == '+' ? 1 : -1;
        if (sscanf(tz + 1, "%d:%d", &tz_hour, &tz_minute) < 1) {
            return false;
        }
    }

    int64_t y = (int64_t)year - (month <= 2 ? 1 : 0);
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const uint64_t yoe = (uint64_t)(y - era * 400);
    const uint64_t mp = (uint64_t)(month + (month > 2 ? -3 : 9));
    const uint64_t doy = (153U * mp + 2U) / 5U + (uint64_t)day - 1U;
    const uint64_t doe = yoe * 365U + yoe / 4U - yoe / 100U + doy;
    int64_t days = era * 146097 + (int64_t)doe - 719468;
    int64_t seconds_since_epoch = days * 86400 + (int64_t)hour * 3600 + (int64_t)minute * 60 + second;
    seconds_since_epoch -= (int64_t)tz_sign * ((int64_t)tz_hour * 3600 + (int64_t)tz_minute * 60);
    if (seconds_since_epoch < 0) {
        return false;
    }
    *epoch_ms = (uint64_t)seconds_since_epoch * 1000ULL;
    return true;
}

static uint64_t ha_client_state_timestamp_ms(cJSON *state_obj)
{
    uint64_t updated_at_ms = time_service_now_epoch_ms();
    if (updated_at_ms == 0U) {
        updated_at_ms = time_service_last_sync_epoch_ms();
    }

    cJSON *last_updated = cJSON_GetObjectItemCaseSensitive(state_obj, "last_updated");
    cJSON *last_changed = cJSON_GetObjectItemCaseSensitive(state_obj, "last_changed");
    if (cJSON_IsString(last_updated) &&
        ha_client_parse_timestamp_ms(last_updated->valuestring, &updated_at_ms)) {
        return updated_at_ms;
    }
    if (cJSON_IsString(last_changed) &&
        ha_client_parse_timestamp_ms(last_changed->valuestring, &updated_at_ms)) {
        return updated_at_ms;
    }
    return updated_at_ms;
}

static void ha_client_dispatch_state_change_from_result(cJSON *state_obj)
{
    if (state_obj == NULL) {
        return;
    }

    cJSON *entity_id = cJSON_GetObjectItemCaseSensitive(state_obj, "entity_id");
    cJSON *state = cJSON_GetObjectItemCaseSensitive(state_obj, "state");
    cJSON *attributes = cJSON_GetObjectItemCaseSensitive(state_obj, "attributes");
    if (!cJSON_IsString(entity_id) || !cJSON_IsString(state)) {
        return;
    }

    const char *unit_text = NULL;
    const char *friendly_name = NULL;
    const char *device_class = NULL;
    char *attributes_json = NULL;
    uint64_t updated_at_ms = ha_client_state_timestamp_ms(state_obj);
    bool available = strcmp(state->valuestring, "unavailable") != 0;

    if (cJSON_IsObject(attributes)) {
        cJSON *unit = cJSON_GetObjectItemCaseSensitive(attributes, "unit_of_measurement");
        cJSON *friendly = cJSON_GetObjectItemCaseSensitive(attributes, "friendly_name");
        cJSON *device = cJSON_GetObjectItemCaseSensitive(attributes, "device_class");
        if (cJSON_IsString(unit)) {
            unit_text = unit->valuestring;
        }
        if (cJSON_IsString(friendly)) {
            friendly_name = friendly->valuestring;
        }
        if (cJSON_IsString(device)) {
            device_class = device->valuestring;
        }
        attributes_json = cJSON_PrintUnformatted(attributes);
    }

    ha_client_state_change_t change = {
        .entity_id = entity_id->valuestring,
        .state_text = state->valuestring,
        .attributes_json = attributes_json,
        .unit_text = unit_text,
        .friendly_name = friendly_name,
        .device_class = device_class,
        .updated_at_ms = updated_at_ms,
        .available = available,
    };

    taskENTER_CRITICAL(&s_ctx.lock);
    ha_client_state_change_cb_t callback = s_ctx.callback;
    void *callback_user = s_ctx.callback_user;
    s_ctx.initial_state_count++;
    ha_client_metrics_record_event_locked();
    taskEXIT_CRITICAL(&s_ctx.lock);

    if (callback != NULL) {
        callback(&change, callback_user);
    }

    if (attributes_json != NULL) {
        cJSON_free(attributes_json);
    }
}

static void ha_client_handle_result(cJSON *root)
{
    cJSON *id_item = cJSON_GetObjectItemCaseSensitive(root, "id");
    if (!cJSON_IsNumber(id_item)) {
        return;
    }

    ha_pending_type_t pending_type = ha_client_take_pending((uint32_t)id_item->valuedouble);
    if (pending_type == HA_PENDING_SUBSCRIBE) {
        taskENTER_CRITICAL(&s_ctx.lock);
        s_ctx.subscription_ready = true;
        s_ctx.sub_state = HA_SUB_STATE_STEADY;
        taskEXIT_CRITICAL(&s_ctx.lock);
        xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_SUB_READY_BIT);
        return;
    }

    if (pending_type == HA_PENDING_GET_STATES) {
        cJSON *success = cJSON_GetObjectItemCaseSensitive(root, "success");
        cJSON *result = cJSON_GetObjectItemCaseSensitive(root, "result");
        if (!cJSON_IsTrue(success) || !cJSON_IsArray(result)) {
            return;
        }

        cJSON *child = NULL;
        cJSON_ArrayForEach(child, result) {
            ha_client_dispatch_state_change_from_result(child);
        }

        taskENTER_CRITICAL(&s_ctx.lock);
        s_ctx.subscription_ready = true;
        s_ctx.sub_state = HA_SUB_STATE_STEADY;
        taskEXIT_CRITICAL(&s_ctx.lock);
        xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_SUB_READY_BIT | HA_CLIENT_INITIAL_DONE_BIT);
    }
}

static void ha_client_handle_event(cJSON *root)
{
    cJSON *event = cJSON_GetObjectItemCaseSensitive(root, "event");
    cJSON *data = cJSON_IsObject(event) ? cJSON_GetObjectItemCaseSensitive(event, "data") : NULL;
    cJSON *new_state = cJSON_IsObject(data) ? cJSON_GetObjectItemCaseSensitive(data, "new_state") : NULL;
    if (!cJSON_IsObject(new_state)) {
        return;
    }

    cJSON *entity_id = cJSON_GetObjectItemCaseSensitive(new_state, "entity_id");
    cJSON *state = cJSON_GetObjectItemCaseSensitive(new_state, "state");
    cJSON *attributes = cJSON_GetObjectItemCaseSensitive(new_state, "attributes");
    if (!cJSON_IsString(entity_id) || !cJSON_IsString(state)) {
        return;
    }

    const char *unit_text = NULL;
    const char *friendly_name = NULL;
    const char *device_class = NULL;
    char *attributes_json = NULL;
    uint64_t updated_at_ms = ha_client_state_timestamp_ms(new_state);

    if (cJSON_IsObject(attributes)) {
        cJSON *unit = cJSON_GetObjectItemCaseSensitive(attributes, "unit_of_measurement");
        cJSON *friendly = cJSON_GetObjectItemCaseSensitive(attributes, "friendly_name");
        cJSON *device = cJSON_GetObjectItemCaseSensitive(attributes, "device_class");
        if (cJSON_IsString(unit)) {
            unit_text = unit->valuestring;
        }
        if (cJSON_IsString(friendly)) {
            friendly_name = friendly->valuestring;
        }
        if (cJSON_IsString(device)) {
            device_class = device->valuestring;
        }
        attributes_json = cJSON_PrintUnformatted(attributes);
    }

    ha_client_state_change_t change = {
        .entity_id = entity_id->valuestring,
        .state_text = state->valuestring,
        .attributes_json = attributes_json,
        .unit_text = unit_text,
        .friendly_name = friendly_name,
        .device_class = device_class,
        .updated_at_ms = updated_at_ms,
        .available = strcmp(state->valuestring, "unavailable") != 0,
    };

    taskENTER_CRITICAL(&s_ctx.lock);
    ha_client_state_change_cb_t callback = s_ctx.callback;
    void *callback_user = s_ctx.callback_user;
    ha_client_metrics_record_event_locked();
    taskEXIT_CRITICAL(&s_ctx.lock);

    if (callback != NULL) {
        callback(&change, callback_user);
    }

    if (attributes_json != NULL) {
        cJSON_free(attributes_json);
    }
}

static void ha_client_send_subscribe_sequence(void)
{
    if (s_ctx.ws == NULL) {
        return;
    }

    uint32_t subscribe_id = ha_client_alloc_message_id();
    char subscribe_json[96];
    snprintf(subscribe_json, sizeof(subscribe_json),
             "{\"id\":%" PRIu32 ",\"type\":\"subscribe_events\",\"event_type\":\"state_changed\"}",
             subscribe_id);
    esp_websocket_client_send_text(s_ctx.ws, subscribe_json, strlen(subscribe_json), portMAX_DELAY);
    ha_client_set_pending(subscribe_id, HA_PENDING_SUBSCRIBE);
}

static void ha_client_handle_text_frame(const char *payload, size_t payload_len)
{
    if (payload == NULL || payload_len == 0U || payload_len > CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES) {
        return;
    }

    cJSON *root = cJSON_ParseWithLength(payload, payload_len);
    if (root == NULL) {
        ESP_LOGW(TAG, "failed to parse HA JSON frame");
        return;
    }

    cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (cJSON_IsString(type)) {
        if (strcmp(type->valuestring, "auth_required") == 0) {
            char token[P4HOME_HA_TOKEN_MAX_LEN];
            if (settings_service_ha_get_token(token, sizeof(token)) == ESP_OK && token[0] != '\0') {
                char auth_json[512];
                snprintf(auth_json, sizeof(auth_json),
                         "{\"type\":\"auth\",\"access_token\":\"%s\"}", token);
                esp_websocket_client_send_text(s_ctx.ws, auth_json, strlen(auth_json), portMAX_DELAY);
                taskENTER_CRITICAL(&s_ctx.lock);
                s_ctx.auth_sent = true;
                ha_client_set_state_locked(HA_CLIENT_STATE_AUTHENTICATING);
                taskEXIT_CRITICAL(&s_ctx.lock);
            }
        } else if (strcmp(type->valuestring, "auth_ok") == 0) {
            taskENTER_CRITICAL(&s_ctx.lock);
            s_ctx.authenticated = true;
            ha_client_set_error_locked("idle");
            ha_client_set_state_locked(HA_CLIENT_STATE_READY);
            taskEXIT_CRITICAL(&s_ctx.lock);
            xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_READY_BIT);
            ha_client_send_subscribe_sequence();
        } else if (strcmp(type->valuestring, "auth_invalid") == 0) {
            taskENTER_CRITICAL(&s_ctx.lock);
            ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
            ha_client_set_error_locked("auth_invalid");
            s_ctx.retry_lockout = true;
            taskEXIT_CRITICAL(&s_ctx.lock);
            xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_AUTH_FAIL_BIT | HA_CLIENT_FATAL_ERROR_BIT);
        } else if (strcmp(type->valuestring, "result") == 0) {
            ha_client_handle_result(root);
        } else if (strcmp(type->valuestring, "event") == 0) {
            ha_client_handle_event(root);
        }
    }

    cJSON_Delete(root);
}

static void ha_client_handle_ws_text_data(const esp_websocket_event_data_t *data)
{
    if (data == NULL || data->data_ptr == NULL || data->data_len <= 0) {
        return;
    }

    if (s_ctx.rx_dropping) {
        const size_t offset = data->payload_offset > 0 ? (size_t)data->payload_offset : 0U;
        const size_t len = (size_t)data->data_len;
        if (data->fin || offset + len >= s_ctx.rx_drop_expected ||
            (data->payload_len > 0 && (size_t)data->payload_len != s_ctx.rx_drop_expected)) {
            ha_client_reset_rx_frame();
        }
        return;
    }

    if (data->payload_len <= data->data_len && data->payload_offset == 0) {
        ha_client_handle_text_frame(data->data_ptr, (size_t)data->data_len);
        return;
    }

    if (data->payload_len <= 0 || data->payload_len > CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES) {
        ESP_LOGW(TAG, "drop oversized HA JSON frame len=%d", data->payload_len);
        ha_client_start_drop_rx_frame(data->payload_len > 0 ? (size_t)data->payload_len : 0U);
        return;
    }

    if (data->payload_offset == 0 || s_ctx.rx_frame == NULL ||
        s_ctx.rx_frame_expected != (size_t)data->payload_len) {
        ha_client_reset_rx_frame();
        s_ctx.rx_frame = malloc((size_t)data->payload_len + 1U);
        if (s_ctx.rx_frame == NULL) {
            ESP_LOGW(TAG, "failed to allocate HA JSON frame len=%d", data->payload_len);
            return;
        }
        s_ctx.rx_frame_expected = (size_t)data->payload_len;
        s_ctx.rx_frame_received = 0U;
    }

    const size_t offset = (size_t)data->payload_offset;
    const size_t len = (size_t)data->data_len;
    if (offset + len > s_ctx.rx_frame_expected) {
        ESP_LOGW(TAG, "drop malformed HA JSON fragment offset=%d len=%d total=%d",
                 data->payload_offset, data->data_len, data->payload_len);
        ha_client_reset_rx_frame();
        return;
    }

    memcpy(s_ctx.rx_frame + offset, data->data_ptr, len);
    if (offset + len > s_ctx.rx_frame_received) {
        s_ctx.rx_frame_received = offset + len;
    }

    if ((data->fin || s_ctx.rx_frame_received >= s_ctx.rx_frame_expected) &&
        s_ctx.rx_frame_received == s_ctx.rx_frame_expected) {
        s_ctx.rx_frame[s_ctx.rx_frame_expected] = '\0';
        ha_client_handle_text_frame(s_ctx.rx_frame, s_ctx.rx_frame_expected);
        ha_client_reset_rx_frame();
    }
}

static void ha_client_ws_event_handler(void *args,
                                       esp_event_base_t base,
                                       int32_t event_id,
                                       void *event_data)
{
    (void)args;
    (void)base;
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        taskENTER_CRITICAL(&s_ctx.lock);
        s_ctx.ws_connected = true;
        ha_client_set_state_locked(HA_CLIENT_STATE_CONNECTING);
        taskEXIT_CRITICAL(&s_ctx.lock);
        ESP_LOGI(TAG, "HA WebSocket connected");
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        ha_client_reset_rx_frame();
        taskENTER_CRITICAL(&s_ctx.lock);
        s_ctx.ws_connected = false;
        s_ctx.authenticated = false;
        s_ctx.auth_sent = false;
        if (!s_ctx.stop_requested) {
            ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
            if (!s_ctx.retry_lockout) {
                ha_client_set_error_locked("ws_disconnected");
            }
        }
        taskEXIT_CRITICAL(&s_ctx.lock);
        break;
    case WEBSOCKET_EVENT_DATA:
        if (data != NULL && (data->op_code == 0x1 || data->op_code == 0x0)) {
            ha_client_handle_ws_text_data(data);
        }
        break;
    case WEBSOCKET_EVENT_ERROR:
        taskENTER_CRITICAL(&s_ctx.lock);
        ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
        if (!s_ctx.retry_lockout) {
            ha_client_set_error_locked("ws_error");
        }
        taskEXIT_CRITICAL(&s_ctx.lock);
        break;
    default:
        break;
    }
}

static esp_err_t ha_client_fetch_one_initial_state(const char *base_url, const char *token,
                                                   bool verify_tls, const char *entity_id)
{
    char state_url[320];
    ESP_RETURN_ON_FALSE(ha_client_make_rest_state_url(base_url, entity_id, state_url, sizeof(state_url)),
                        ESP_ERR_INVALID_ARG, TAG, "failed to build HA state URL");

    const bool use_tls = strncmp(state_url, "https://", 8) == 0;
    esp_http_client_config_t config = {
        .url = state_url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 5000,
        .buffer_size = CONFIG_P4HOME_HA_CLIENT_BUFFER_SIZE,
        .crt_bundle_attach = use_tls && verify_tls ? esp_crt_bundle_attach : NULL,
        .skip_cert_common_name_check = use_tls && !verify_tls,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    ESP_RETURN_ON_FALSE(client != NULL, ESP_ERR_NO_MEM, TAG, "failed to create HA REST client");

    char auth_header[P4HOME_HA_TOKEN_MAX_LEN + 8];
    snprintf(auth_header, sizeof(auth_header), "Bearer %s", token);
    esp_http_client_set_header(client, "Authorization", auth_header);
    esp_http_client_set_header(client, "Content-Type", "application/json");

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return err;
    }

    (void)esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);
    if (status != 200) {
        ESP_LOGW(TAG, "HA initial state fetch status=%d entity=%s", status, entity_id);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    char *body = calloc(1U, CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES + 1U);
    if (body == NULL) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }

    int total = 0;
    while (total < CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES) {
        int read_len = esp_http_client_read(client, body + total,
                                           CONFIG_P4HOME_HA_CLIENT_MAX_EVENT_JSON_BYTES - total);
        if (read_len < 0) {
            err = ESP_FAIL;
            break;
        }
        if (read_len == 0) {
            break;
        }
        total += read_len;
    }

    if (err == ESP_OK && total > 0) {
        cJSON *root = cJSON_ParseWithLength(body, (size_t)total);
        if (root != NULL) {
            ha_client_dispatch_state_change_from_result(root);
            cJSON_Delete(root);
        } else {
            ESP_LOGW(TAG, "failed to parse HA initial state entity=%s", entity_id);
            err = ESP_FAIL;
        }
    }

    free(body);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return err;
}

static void ha_client_fetch_initial_states(const char *base_url, const char *token, bool verify_tls)
{
    char(*entities)[HA_CLIENT_ENTITY_ID_MAX_LEN] =
        calloc(HA_CLIENT_MAX_INITIAL_ENTITIES, HA_CLIENT_ENTITY_ID_MAX_LEN);
    if (entities == NULL) {
        ESP_LOGW(TAG, "failed to allocate HA initial entity snapshot");
        xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_INITIAL_DONE_BIT);
        return;
    }
    size_t count = 0U;

    taskENTER_CRITICAL(&s_ctx.lock);
    count = s_ctx.initial_entity_count;
    if (count > HA_CLIENT_MAX_INITIAL_ENTITIES) {
        count = HA_CLIENT_MAX_INITIAL_ENTITIES;
    }
    for (size_t i = 0; i < count; ++i) {
        snprintf(entities[i], sizeof(entities[i]), "%s", s_ctx.initial_entities[i]);
    }
    taskEXIT_CRITICAL(&s_ctx.lock);

    uint32_t ok_count = 0U;
    for (size_t i = 0; i < count; ++i) {
        if (s_ctx.stop_requested) {
            break;
        }
        if (ha_client_fetch_one_initial_state(base_url, token, verify_tls, entities[i]) == ESP_OK) {
            ok_count++;
        }
        vTaskDelay(pdMS_TO_TICKS(25));
    }

    ESP_LOGI(TAG, "HA initial whitelist states fetched ok=%" PRIu32 " requested=%u",
             ok_count, (unsigned)count);
    free(entities);
    xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_INITIAL_DONE_BIT);
}

static esp_err_t ha_client_start_socket(const char *url, bool verify_tls)
{
    ha_client_reset_rx_frame();
    const bool use_tls = strncmp(url, "wss://", 6) == 0;
    esp_websocket_client_config_t config = {
        .uri = url,
        .buffer_size = CONFIG_P4HOME_HA_CLIENT_BUFFER_SIZE,
        .network_timeout_ms = 15000,
        .disable_auto_reconnect = true,
        .task_stack = CONFIG_P4HOME_HA_CLIENT_WS_TASK_STACK,
        .cert_pem = NULL,
        .transport = use_tls ? WEBSOCKET_TRANSPORT_OVER_SSL : WEBSOCKET_TRANSPORT_OVER_TCP,
    };
    if (use_tls && verify_tls) {
        config.crt_bundle_attach = esp_crt_bundle_attach;
    } else if (use_tls) {
        config.skip_cert_common_name_check = true;
    }

    s_ctx.ws = esp_websocket_client_init(&config);
    ESP_RETURN_ON_FALSE(s_ctx.ws != NULL, ESP_FAIL, TAG, "failed to allocate websocket client");
    ESP_RETURN_ON_ERROR(esp_websocket_register_events(s_ctx.ws, WEBSOCKET_EVENT_ANY,
                                                      ha_client_ws_event_handler, NULL),
                        TAG, "failed to register websocket events");
    ESP_RETURN_ON_ERROR(esp_websocket_client_start(s_ctx.ws), TAG, "failed to start websocket client");
    return ESP_OK;
}

static void ha_client_stop_socket(void)
{
    ha_client_reset_rx_frame();
    if (s_ctx.ws == NULL) {
        return;
    }

    esp_websocket_client_stop(s_ctx.ws);
    esp_websocket_client_destroy(s_ctx.ws);
    s_ctx.ws = NULL;
}

static uint32_t ha_client_apply_jitter(uint32_t base_ms)
{
    uint32_t jitter_pct = CONFIG_P4HOME_HA_CLIENT_RECONNECT_JITTER_PCT;
    if (jitter_pct == 0U) {
        return base_ms;
    }

    uint32_t span = (base_ms * jitter_pct) / 100U;
    uint32_t rnd = esp_random() % ((span * 2U) + 1U);
    return base_ms - span + rnd;
}

static void ha_client_worker(void *arg)
{
    (void)arg;
    uint32_t backoff_ms = CONFIG_P4HOME_HA_CLIENT_RECONNECT_BASE_MS;
    bool allow_one_shot = true;
    bool first_dial = true;

    while (true) {
        if (s_ctx.stop_requested) {
            break;
        }

        if (first_dial && CONFIG_P4HOME_HA_CLIENT_START_DELAY_MS > 0) {
            vTaskDelay(pdMS_TO_TICKS(CONFIG_P4HOME_HA_CLIENT_START_DELAY_MS));
        }
        first_dial = false;

        char url[P4HOME_HA_URL_MAX_LEN];
        char token[P4HOME_HA_TOKEN_MAX_LEN];
        bool verify_tls = settings_service_ha_verify_tls();
        settings_service_ha_get_url(url, sizeof(url));
        settings_service_ha_get_token(token, sizeof(token));

        if (url[0] == '\0' || token[0] == '\0') {
            taskENTER_CRITICAL(&s_ctx.lock);
            ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
            ha_client_set_error_locked("credentials_missing");
            taskEXIT_CRITICAL(&s_ctx.lock);
            break;
        }

        if (network_service_wait_connected(CONFIG_P4HOME_HA_CLIENT_NET_WAIT_MS) != ESP_OK) {
            taskENTER_CRITICAL(&s_ctx.lock);
            ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
            ha_client_set_error_locked("net_wait_timeout");
            taskEXIT_CRITICAL(&s_ctx.lock);
        } else if (!ha_client_parse_url(url, s_ctx.normalized_url, sizeof(s_ctx.normalized_url))) {
            taskENTER_CRITICAL(&s_ctx.lock);
            ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
            ha_client_set_error_locked("url_parse_failed");
            taskEXIT_CRITICAL(&s_ctx.lock);
        } else if (strncmp(s_ctx.normalized_url, "wss://", 6) == 0 && verify_tls &&
                   time_service_wait_synced(CONFIG_P4HOME_HA_CLIENT_TIME_WAIT_MS) != ESP_OK) {
            taskENTER_CRITICAL(&s_ctx.lock);
            ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
            ha_client_set_error_locked("time_wait_timeout");
            taskEXIT_CRITICAL(&s_ctx.lock);
        } else {
            taskENTER_CRITICAL(&s_ctx.lock);
            s_ctx.retry_lockout = false;
            s_ctx.ws_connected = false;
            s_ctx.auth_sent = false;
            s_ctx.authenticated = false;
            ha_client_reset_subscription_locked();
            ha_client_set_state_locked(HA_CLIENT_STATE_CONNECTING);
            taskEXIT_CRITICAL(&s_ctx.lock);
            xEventGroupClearBits(s_ctx.event_group, HA_CLIENT_READY_BIT | HA_CLIENT_AUTH_FAIL_BIT |
                                                   HA_CLIENT_FATAL_ERROR_BIT | HA_CLIENT_SUB_READY_BIT |
                                                   HA_CLIENT_INITIAL_DONE_BIT);

            if (allow_one_shot) {
                ha_client_fetch_initial_states(url, token, verify_tls);
            }

            esp_err_t start_err = ha_client_start_socket(s_ctx.normalized_url, verify_tls);
            if (start_err == ESP_OK) {
                EventBits_t bits = xEventGroupWaitBits(s_ctx.event_group,
                                                       HA_CLIENT_READY_BIT | HA_CLIENT_AUTH_FAIL_BIT |
                                                           HA_CLIENT_FATAL_ERROR_BIT,
                                                       pdFALSE, pdFALSE,
                                                       pdMS_TO_TICKS(CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS));
                if ((bits & HA_CLIENT_READY_BIT) != 0U) {
                    allow_one_shot = false;
                    backoff_ms = CONFIG_P4HOME_HA_CLIENT_RECONNECT_BASE_MS;
                    EventBits_t sub_bits = xEventGroupWaitBits(s_ctx.event_group,
                                                               HA_CLIENT_SUB_READY_BIT,
                                                               pdFALSE, pdFALSE,
                                                               pdMS_TO_TICKS(CONFIG_P4HOME_HA_CLIENT_INITIAL_STATES_TIMEOUT_MS));
                    if ((sub_bits & HA_CLIENT_SUB_READY_BIT) != 0U) {
                        ha_client_fetch_initial_states(url, token, verify_tls);
                    }

                    while (!s_ctx.stop_requested) {
                        taskENTER_CRITICAL(&s_ctx.lock);
                        bool connected = s_ctx.ws_connected && s_ctx.authenticated &&
                                         s_ctx.state == HA_CLIENT_STATE_READY;
                        taskEXIT_CRITICAL(&s_ctx.lock);
                        if (!connected) {
                            break;
                        }
                        vTaskDelay(pdMS_TO_TICKS(1000));
                    }

                    ha_client_stop_socket();
                    continue;
                }
                if ((bits & HA_CLIENT_FATAL_ERROR_BIT) != 0U) {
                    break;
                }
                taskENTER_CRITICAL(&s_ctx.lock);
                ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
                if (s_ctx.last_error[0] == '\0' || strcmp(s_ctx.last_error, "idle") == 0) {
                    ha_client_set_error_locked("ws_open_failed");
                }
                taskEXIT_CRITICAL(&s_ctx.lock);
            } else {
                taskENTER_CRITICAL(&s_ctx.lock);
                ha_client_set_state_locked(HA_CLIENT_STATE_ERROR);
                ha_client_set_error_locked("ws_open_failed");
                taskEXIT_CRITICAL(&s_ctx.lock);
            }

            ha_client_stop_socket();
        }

        if (s_ctx.retry_lockout || s_ctx.stop_requested) {
            break;
        }

        if (allow_one_shot) {
            allow_one_shot = false;
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        taskENTER_CRITICAL(&s_ctx.lock);
        s_ctx.reconnect_count++;
        taskEXIT_CRITICAL(&s_ctx.lock);

        uint32_t sleep_ms = ha_client_apply_jitter(backoff_ms);
        vTaskDelay(pdMS_TO_TICKS(sleep_ms));
        if (backoff_ms < CONFIG_P4HOME_HA_CLIENT_RECONNECT_MAX_MS) {
            backoff_ms *= 2U;
            if (backoff_ms > CONFIG_P4HOME_HA_CLIENT_RECONNECT_MAX_MS) {
                backoff_ms = CONFIG_P4HOME_HA_CLIENT_RECONNECT_MAX_MS;
            }
        }
    }

    ha_client_stop_socket();
    taskENTER_CRITICAL(&s_ctx.lock);
    s_ctx.running = false;
    s_ctx.worker_task = NULL;
    if (s_ctx.state != HA_CLIENT_STATE_ERROR) {
        ha_client_set_state_locked(HA_CLIENT_STATE_IDLE);
    }
    taskEXIT_CRITICAL(&s_ctx.lock);
    vTaskDelete(NULL);
}

esp_err_t ha_client_init(void)
{
    if (s_ctx.initialized) {
        return ESP_OK;
    }

    s_ctx.event_group = xEventGroupCreate();
    ESP_RETURN_ON_FALSE(s_ctx.event_group != NULL, ESP_ERR_NO_MEM, TAG, "ha event group alloc failed");
    s_ctx.initialized = true;
    snprintf(s_ctx.last_error, sizeof(s_ctx.last_error), "idle");
    return ESP_OK;
}

esp_err_t ha_client_start(void)
{
    ESP_RETURN_ON_FALSE(s_ctx.initialized, ESP_ERR_INVALID_STATE, TAG, "ha client not initialized");
    if (s_ctx.running) {
        return ESP_OK;
    }

    char token[P4HOME_HA_TOKEN_MAX_LEN];
    settings_service_ha_get_token(token, sizeof(token));
    if (token[0] != '\0') {
        size_t token_len = strlen(token);
        const char *tail = token_len > 4U ? token + token_len - 4U : token;
        size_t tail_len = strlen(tail);
        memset(s_ctx.token_masked, 0, sizeof(s_ctx.token_masked));
        memcpy(s_ctx.token_masked, "***", 3);
        if (tail_len > sizeof(s_ctx.token_masked) - 4U) {
            tail_len = sizeof(s_ctx.token_masked) - 4U;
        }
        memcpy(s_ctx.token_masked + 3, tail, tail_len);
    }

    s_ctx.stop_requested = false;
    BaseType_t ok = xTaskCreate(ha_client_worker, "p4home_ha_ws", CONFIG_P4HOME_HA_CLIENT_WORKER_STACK, NULL,
                                tskIDLE_PRIORITY + 4, &s_ctx.worker_task);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_ERR_NO_MEM, TAG, "failed to create HA worker task");
    s_ctx.running = true;
    return ESP_OK;
}

esp_err_t ha_client_stop(void)
{
    if (!s_ctx.initialized) {
        return ESP_OK;
    }
    s_ctx.stop_requested = true;
    xEventGroupSetBits(s_ctx.event_group, HA_CLIENT_STOP_BIT);
    ha_client_stop_socket();
    taskENTER_CRITICAL(&s_ctx.lock);
    s_ctx.running = false;
    s_ctx.subscription_ready = false;
    s_ctx.authenticated = false;
    s_ctx.auth_sent = false;
    s_ctx.ws_connected = false;
    ha_client_reset_subscription_locked();
    ha_client_set_state_locked(HA_CLIENT_STATE_IDLE);
    taskEXIT_CRITICAL(&s_ctx.lock);
    return ESP_OK;
}

esp_err_t ha_client_restart(void)
{
    ESP_RETURN_ON_ERROR(ha_client_stop(), TAG, "failed to stop HA client");
    taskENTER_CRITICAL(&s_ctx.lock);
    s_ctx.retry_lockout = false;
    snprintf(s_ctx.last_error, sizeof(s_ctx.last_error), "restart_requested");
    taskEXIT_CRITICAL(&s_ctx.lock);
    return ha_client_start();
}

esp_err_t ha_client_wait_ready(uint32_t timeout_ms)
{
    ESP_RETURN_ON_FALSE(s_ctx.initialized && s_ctx.event_group != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "ha client not initialized");
    EventBits_t bits = xEventGroupGetBits(s_ctx.event_group);
    if ((bits & HA_CLIENT_READY_BIT) != 0U) {
        return ESP_OK;
    }
    bits = xEventGroupWaitBits(s_ctx.event_group,
                               HA_CLIENT_READY_BIT | HA_CLIENT_AUTH_FAIL_BIT | HA_CLIENT_FATAL_ERROR_BIT,
                               pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if ((bits & HA_CLIENT_READY_BIT) != 0U) {
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

bool ha_client_ready(void)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    bool ready = s_ctx.state == HA_CLIENT_STATE_READY;
    taskEXIT_CRITICAL(&s_ctx.lock);
    return ready;
}

ha_client_state_t ha_client_state(void)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    ha_client_state_t state = s_ctx.state;
    taskEXIT_CRITICAL(&s_ctx.lock);
    return state;
}

const char *ha_client_state_text(void)
{
    switch (ha_client_state()) {
    case HA_CLIENT_STATE_IDLE:
        return "IDLE";
    case HA_CLIENT_STATE_CONNECTING:
        return "CONNECTING";
    case HA_CLIENT_STATE_AUTHENTICATING:
        return "AUTHENTICATING";
    case HA_CLIENT_STATE_READY:
        return "READY";
    case HA_CLIENT_STATE_ERROR:
        return "ERROR";
    default:
        return "UNKNOWN";
    }
}

const char *ha_client_last_error_text(void)
{
    return s_ctx.last_error;
}

esp_err_t ha_client_set_initial_state_entities(const char *const *entity_ids, size_t count)
{
    if (count > 0U) {
        ESP_RETURN_ON_FALSE(entity_ids != NULL, ESP_ERR_INVALID_ARG, TAG, "entity list is null");
    }

    taskENTER_CRITICAL(&s_ctx.lock);
    s_ctx.initial_entity_count = 0U;
    for (size_t i = 0; i < count && s_ctx.initial_entity_count < HA_CLIENT_MAX_INITIAL_ENTITIES; ++i) {
        if (entity_ids[i] == NULL || entity_ids[i][0] == '\0') {
            continue;
        }
        snprintf(s_ctx.initial_entities[s_ctx.initial_entity_count],
                 sizeof(s_ctx.initial_entities[s_ctx.initial_entity_count]),
                 "%s", entity_ids[i]);
        s_ctx.initial_entity_count++;
    }
    taskEXIT_CRITICAL(&s_ctx.lock);

    ESP_LOGI(TAG, "HA initial state entity filter count=%u", (unsigned)s_ctx.initial_entity_count);
    return ESP_OK;
}

esp_err_t ha_client_set_state_change_callback(ha_client_state_change_cb_t callback, void *user_data)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    s_ctx.callback = callback;
    s_ctx.callback_user = user_data;
    taskEXIT_CRITICAL(&s_ctx.lock);
    return ESP_OK;
}

bool ha_client_subscription_ready(void)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    bool ready = s_ctx.subscription_ready;
    taskEXIT_CRITICAL(&s_ctx.lock);
    return ready;
}

uint32_t ha_client_initial_state_count(void)
{
    taskENTER_CRITICAL(&s_ctx.lock);
    uint32_t count = s_ctx.initial_state_count;
    taskEXIT_CRITICAL(&s_ctx.lock);
    return count;
}

esp_err_t ha_client_get_metrics(ha_client_metrics_t *metrics)
{
    ESP_RETURN_ON_FALSE(metrics != NULL, ESP_ERR_INVALID_ARG, TAG, "metrics is required");
    memset(metrics, 0, sizeof(*metrics));

    taskENTER_CRITICAL(&s_ctx.lock);
    metrics->state = s_ctx.state;
    metrics->reconnect_count = s_ctx.reconnect_count;
    metrics->initial_state_count = s_ctx.initial_state_count;
    metrics->total_event_count = s_ctx.total_event_count;
    metrics->events_per_minute = s_ctx.bucket_a + s_ctx.bucket_b;
    metrics->connected_duration_ms = s_ctx.connected_duration_ms;
    if (s_ctx.state == HA_CLIENT_STATE_READY && s_ctx.last_connected_at_ms != 0U) {
        metrics->connected_duration_ms += ha_client_now_ms() - s_ctx.last_connected_at_ms;
    }
    metrics->last_connected_at_ms = s_ctx.last_connected_at_ms;
    metrics->last_ready_at_ms = s_ctx.last_ready_at_ms;
    metrics->last_event_at_ms = s_ctx.last_event_at_ms;
    metrics->last_error_text = s_ctx.last_error;
    taskEXIT_CRITICAL(&s_ctx.lock);

    return ESP_OK;
}
