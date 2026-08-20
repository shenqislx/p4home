#include "agent_transport.h"

#include <ctype.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "world_object_registry.h"
#include "world_service.h"

static const char *TAG = "agent_transport";

#define AGENT_HEARTBEAT_INTERVAL_MS 10000U
#define AGENT_WORKER_INTERVAL_MS 100U
#define AGENT_WS_BUFFER_BYTES 4096
#define AGENT_ACTION_TIMEOUT_MIN_MS 100U
#define AGENT_ACTION_TIMEOUT_MAX_MS 120000U
#define AGENT_OBJECT_ACTION_RENDER_MS 250U
#define AGENT_LOCAL_FALLBACK_GRACE_MS 10000U

#ifndef CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK
#define CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK 8192
#endif

typedef struct {
    bool initialized;
    bool enabled;
    volatile bool running;
    volatile bool reconnect_requested;
    bool socket_connected;
    bool connected;
    bool handshake_sent;
    bool first_connection;
    esp_websocket_client_handle_t ws;
    SemaphoreHandle_t tx_mutex;
    SemaphoreHandle_t action_mutex;
    TaskHandle_t worker_task;
    portMUX_TYPE lock;
    char uri[AGENT_TRANSPORT_URI_MAX_BYTES];
    char device_id[AGENT_TRANSPORT_DEVICE_ID_MAX_BYTES + 1U];
    char token[AGENT_TRANSPORT_TOKEN_MAX_BYTES];
    uint8_t protocol_version;
    char headers[AGENT_TRANSPORT_TOKEN_MAX_BYTES + AGENT_TRANSPORT_DEVICE_ID_MAX_BYTES + 64U];
    uint8_t spki_sha256[AGENT_TRANSPORT_SPKI_SHA256_BYTES];
    char boot_id[40];
    uint32_t boot_nonce;
    char session_id[40];
    uint32_t session_counter;
    uint32_t message_counter;
    uint32_t next_tx_seq;
    uint32_t next_rx_seq;
    uint32_t last_rx_seq;
    uint64_t last_heartbeat_ms;
    uint64_t last_disconnect_at_ms;
    uint64_t world_disconnect_deadline_ms;
    uint64_t active_action_complete_at_ms;
    char *rx_frame;
    size_t rx_expected;
    size_t rx_received;
    bool rx_dropping;
    agent_transport_snapshot_t metrics;
} agent_transport_state_t;

static agent_transport_state_t s_agent = {
    .first_connection = true,
    .lock = portMUX_INITIALIZER_UNLOCKED,
};
static const mbedtls_x509_crt s_dummy_ca;

static bool agent_object_tool(world_action_tool_t tool);

static uint64_t agent_now_ms(void)
{
    return (uint64_t)(esp_timer_get_time() / 1000ULL);
}

static bool agent_valid_id(const char *value)
{
    if (value == NULL) {
        return false;
    }
    size_t length = strnlen(value, AGENT_TRANSPORT_DEVICE_ID_MAX_BYTES + 1U);
    if (length == 0U || length > AGENT_TRANSPORT_DEVICE_ID_MAX_BYTES ||
        !isalnum((unsigned char)value[0])) {
        return false;
    }
    for (size_t index = 1U; index < length; ++index) {
        unsigned char character = (unsigned char)value[index];
        if (!isalnum(character) && character != '.' && character != '_' &&
            character != ':' && character != '-') {
            return false;
        }
    }
    return true;
}

static bool agent_valid_token(const char *token)
{
    if (token == NULL) {
        return false;
    }
    size_t length = strnlen(token, AGENT_TRANSPORT_TOKEN_MAX_BYTES);
    if (length < 32U || length >= AGENT_TRANSPORT_TOKEN_MAX_BYTES) {
        return false;
    }
    return strchr(token, '\r') == NULL && strchr(token, '\n') == NULL;
}

static bool agent_valid_uri(const char *uri)
{
    if (uri == NULL) {
        return false;
    }
    size_t length = strnlen(uri, AGENT_TRANSPORT_URI_MAX_BYTES);
    static const char path[] = "/v1/device";
    static const char scheme[] = "wss://";
    if (length <= strlen(scheme) + strlen(path) ||
        length >= AGENT_TRANSPORT_URI_MAX_BYTES ||
        strncmp(uri, scheme, strlen(scheme)) != 0 ||
        strchr(uri, '?') != NULL || strchr(uri, '#') != NULL) {
        return false;
    }
    const char *authority = uri + strlen(scheme);
    const char *uri_path = strchr(authority, '/');
    return uri_path != NULL && uri_path > authority &&
           memchr(authority, '@', (size_t)(uri_path - authority)) == NULL &&
           strcmp(uri_path, path) == 0;
}

#if CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED
static int agent_hex_nibble(char value)
{
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    return -1;
}

static bool agent_decode_pin(const char *hex, uint8_t output[AGENT_TRANSPORT_SPKI_SHA256_BYTES])
{
    if (hex == NULL || strlen(hex) != AGENT_TRANSPORT_SPKI_SHA256_BYTES * 2U) {
        return false;
    }
    for (size_t index = 0U; index < AGENT_TRANSPORT_SPKI_SHA256_BYTES; ++index) {
        int high = agent_hex_nibble(hex[index * 2U]);
        int low = agent_hex_nibble(hex[index * 2U + 1U]);
        if (high < 0 || low < 0) {
            return false;
        }
        output[index] = (uint8_t)((high << 4) | low);
    }
    return true;
}
#endif

static bool agent_constant_time_equal(const uint8_t *left, const uint8_t *right, size_t length)
{
    uint8_t difference = 0U;
    for (size_t index = 0U; index < length; ++index) {
        difference |= left[index] ^ right[index];
    }
    return difference == 0U;
}

static int agent_verify_spki(void *context, mbedtls_x509_crt *certificate,
                             int depth, uint32_t *flags)
{
    (void)context;
    if (certificate == NULL || flags == NULL) {
        return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    }
    if (depth != 0) {
        *flags = 0U;
        return 0;
    }

    unsigned char der[1024];
    int der_length = mbedtls_pk_write_pubkey_der(&certificate->pk, der, sizeof(der));
    if (der_length <= 0 || (size_t)der_length > sizeof(der)) {
        return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    }
    unsigned char digest[AGENT_TRANSPORT_SPKI_SHA256_BYTES];
    const unsigned char *spki = der + sizeof(der) - (size_t)der_length;
    if (mbedtls_sha256(spki, (size_t)der_length, digest, 0) != 0 ||
        !agent_constant_time_equal(digest, s_agent.spki_sha256, sizeof(digest))) {
        return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    }
    *flags = 0U;
    return 0;
}

static esp_err_t agent_attach_spki_verifier(void *config)
{
    ESP_RETURN_ON_FALSE(config != NULL, ESP_ERR_INVALID_ARG, TAG, "TLS config is required");
    mbedtls_ssl_config *ssl_config = (mbedtls_ssl_config *)config;
    mbedtls_ssl_conf_ca_chain(ssl_config, (mbedtls_x509_crt *)&s_dummy_ca, NULL);
    mbedtls_ssl_conf_verify(ssl_config, agent_verify_spki, NULL);
    return ESP_OK;
}

static bool agent_connected(void)
{
    taskENTER_CRITICAL(&s_agent.lock);
    bool connected = s_agent.connected;
    taskEXIT_CRITICAL(&s_agent.lock);
    return connected;
}

static bool agent_socket_connected(void)
{
    taskENTER_CRITICAL(&s_agent.lock);
    bool connected = s_agent.socket_connected;
    taskEXIT_CRITICAL(&s_agent.lock);
    return connected;
}

static void agent_metric_protocol_error(void)
{
    taskENTER_CRITICAL(&s_agent.lock);
    s_agent.metrics.protocol_errors++;
    taskEXIT_CRITICAL(&s_agent.lock);
}

static void agent_request_reconnect(void)
{
    s_agent.reconnect_requested = true;
}

static bool agent_json_integer(const cJSON *item, uint32_t minimum, uint32_t maximum,
                               uint32_t *value)
{
    if (!cJSON_IsNumber(item) || !isfinite(item->valuedouble) ||
        floor(item->valuedouble) != item->valuedouble ||
        item->valuedouble < minimum || item->valuedouble > maximum) {
        return false;
    }
    if (value != NULL) {
        *value = (uint32_t)item->valuedouble;
    }
    return true;
}

static bool agent_json_nonnegative_integer(const cJSON *item)
{
    return cJSON_IsNumber(item) && isfinite(item->valuedouble) &&
           floor(item->valuedouble) == item->valuedouble &&
           item->valuedouble >= 0.0 && item->valuedouble <= 9007199254740991.0;
}

static bool agent_object_has_exact_fields(const cJSON *object,
                                          const char *const *fields,
                                          size_t field_count)
{
    if (!cJSON_IsObject(object)) {
        return false;
    }
    size_t actual_count = 0U;
    for (const cJSON *child = object->child; child != NULL; child = child->next) {
        actual_count++;
        bool known = false;
        for (size_t index = 0U; index < field_count; ++index) {
            if (strcmp(child->string, fields[index]) == 0) {
                known = true;
                break;
            }
        }
        if (!known) {
            return false;
        }
    }
    if (actual_count != field_count) {
        return false;
    }
    for (size_t index = 0U; index < field_count; ++index) {
        if (cJSON_GetObjectItemCaseSensitive(object, fields[index]) == NULL) {
            return false;
        }
    }
    return true;
}

static const char *agent_room_id(world_room_id_t room)
{
    static const char *const rooms[WORLD_ROOM_COUNT] = {
        "primary_bedroom", "study", "guest_room", "entry", "living_room", "kitchen",
    };
    return room >= WORLD_ROOM_PRIMARY_BEDROOM && room < WORLD_ROOM_COUNT
               ? rooms[room]
               : "living_room";
}

static bool agent_parse_room(const char *value, world_room_id_t *room)
{
    for (int index = 0; index < WORLD_ROOM_COUNT; ++index) {
        if (value != NULL && strcmp(value, agent_room_id((world_room_id_t)index)) == 0) {
            *room = (world_room_id_t)index;
            return true;
        }
    }
    return false;
}

static const char *agent_activity_id(world_activity_t activity)
{
    return activity == WORLD_ACTIVITY_SLEEP ? "sleep" : "idle";
}

static bool agent_uses_object_runtime(void)
{
    return s_agent.protocol_version == AGENT_TRANSPORT_PROTOCOL_V2;
}

static cJSON *agent_character_json(const world_service_snapshot_t *snapshot)
{
    cJSON *character = cJSON_CreateObject();
    if (character == NULL) {
        return NULL;
    }
    cJSON_AddStringToObject(character, "room_id", agent_room_id(snapshot->room));
    cJSON_AddStringToObject(character, "activity", agent_activity_id(snapshot->activity));
    cJSON_AddBoolToObject(character, "speaking", snapshot->speaking);
    if (snapshot->active_action_id[0] == '\0') {
        cJSON_AddNullToObject(character, "active_action_id");
    } else {
        cJSON_AddStringToObject(character, "active_action_id", snapshot->active_action_id);
    }
    if (agent_uses_object_runtime()) {
        if (snapshot->target_object_id[0] == '\0') {
            cJSON_AddNullToObject(character, "target_object_id");
        } else {
            cJSON_AddStringToObject(character, "target_object_id",
                                    snapshot->target_object_id);
        }
        cJSON_AddStringToObject(character, "pose",
                               world_service_pose_text(snapshot->character_pose));
    }
    return character;
}

static cJSON *agent_objects_json(const world_service_snapshot_t *snapshot,
                                 bool capabilities)
{
    cJSON *objects = cJSON_CreateArray();
    if (objects == NULL) {
        return NULL;
    }
    for (size_t index = 0U; index < snapshot->object_count; ++index) {
        const world_object_state_t *state = &snapshot->objects[index];
        const world_object_definition_t *definition =
            world_object_registry_find(state->object_id);
        if (definition == NULL) {
            cJSON_Delete(objects);
            return NULL;
        }
        cJSON *object = cJSON_CreateObject();
        if (object == NULL) {
            cJSON_Delete(objects);
            return NULL;
        }
        cJSON_AddStringToObject(object, "object_id", state->object_id);
        cJSON_AddStringToObject(object, "room_id", agent_room_id(state->room));
        if (capabilities) {
            cJSON *actions = cJSON_AddArrayToObject(object, "supported_actions");
            for (int action = WORLD_OBJECT_ACTION_GO_TO;
                 action < WORLD_OBJECT_ACTION_COUNT; ++action) {
                if (world_object_supports_action(definition,
                                                 (world_object_action_t)action)) {
                    cJSON_AddItemToArray(
                        actions,
                        cJSON_CreateString(world_object_action_text(
                            (world_object_action_t)action)));
                }
            }
        }
        cJSON_AddBoolToObject(object, "available", state->available);
        if (!capabilities) {
            cJSON_AddBoolToObject(object, "occupied", state->occupied);
        }
        cJSON_AddItemToArray(objects, object);
    }
    return objects;
}

static cJSON *agent_snapshot_payload(const char *reason)
{
    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    cJSON *payload = cJSON_CreateObject();
    if (payload == NULL) {
        return NULL;
    }
    char snapshot_id[64];
    snprintf(snapshot_id, sizeof(snapshot_id), "snapshot-%s-%" PRIu32,
             s_agent.boot_id, snapshot.state_version);
    cJSON_AddStringToObject(payload, "snapshot_id", snapshot_id);
    cJSON_AddStringToObject(payload, "reason", reason);
    cJSON_AddNumberToObject(payload, "state_version", snapshot.state_version);
    cJSON_AddNumberToObject(payload, "observed_at_ms", (double)snapshot.observed_at_ms);
    cJSON_AddItemToObject(payload, "character", agent_character_json(&snapshot));
    if (agent_uses_object_runtime()) {
        cJSON_AddItemToObject(payload, "objects", agent_objects_json(&snapshot, false));
    }
    return payload;
}

static cJSON *agent_changed_payload(void)
{
    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    cJSON *payload = cJSON_CreateObject();
    if (payload == NULL) {
        return NULL;
    }
    cJSON_AddNumberToObject(payload, "state_version", snapshot.state_version);
    cJSON_AddNumberToObject(payload, "observed_at_ms", (double)snapshot.observed_at_ms);
    cJSON_AddItemToObject(payload, "character", agent_character_json(&snapshot));
    if (agent_uses_object_runtime()) {
        cJSON_AddItemToObject(payload, "objects", agent_objects_json(&snapshot, false));
    }
    return payload;
}

static esp_err_t agent_send_payload(const char *type, cJSON *payload, const char *correlation_id)
{
    if (payload == NULL) {
        return ESP_ERR_NO_MEM;
    }
    if (!agent_socket_connected() || s_agent.ws == NULL) {
        cJSON_Delete(payload);
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_agent.tx_mutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
        cJSON_Delete(payload);
        return ESP_ERR_TIMEOUT;
    }

    uint32_t seq = s_agent.next_tx_seq;
    uint32_t counter = s_agent.message_counter++;
    char message_id[64];
    snprintf(message_id, sizeof(message_id), "p4-%08" PRIx32 "-%" PRIu32,
             s_agent.boot_nonce, counter);
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        xSemaphoreGive(s_agent.tx_mutex);
        cJSON_Delete(payload);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddNumberToObject(root, "protocol_version", s_agent.protocol_version);
    cJSON_AddStringToObject(root, "message_id", message_id);
    if (correlation_id == NULL) {
        cJSON_AddNullToObject(root, "correlation_id");
    } else {
        cJSON_AddStringToObject(root, "correlation_id", correlation_id);
    }
    cJSON_AddStringToObject(root, "device_id", s_agent.device_id);
    cJSON_AddStringToObject(root, "session_id", s_agent.session_id);
    cJSON_AddNumberToObject(root, "seq", seq);
    cJSON_AddNumberToObject(root, "sent_at_ms", (double)agent_now_ms());
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddItemToObject(root, "payload", payload);
    char *frame = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (frame == NULL) {
        xSemaphoreGive(s_agent.tx_mutex);
        return ESP_ERR_NO_MEM;
    }
    size_t frame_length = strlen(frame);
    esp_err_t result = ESP_ERR_INVALID_SIZE;
    if (frame_length <= AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES) {
        int sent = esp_websocket_client_send_text(s_agent.ws, frame, frame_length,
                                                  pdMS_TO_TICKS(2000));
        result = sent == (int)frame_length ? ESP_OK : ESP_FAIL;
    }
    free(frame);
    if (result == ESP_OK) {
        s_agent.next_tx_seq = seq + 1U;
        taskENTER_CRITICAL(&s_agent.lock);
        s_agent.metrics.sent_frames++;
        taskEXIT_CRITICAL(&s_agent.lock);
    }
    xSemaphoreGive(s_agent.tx_mutex);
    if (result != ESP_OK) {
        agent_request_reconnect();
    }
    return result;
}

static esp_err_t agent_send_world_changed(void)
{
    return agent_send_payload("world.changed", agent_changed_payload(), NULL);
}

static esp_err_t agent_send_protocol_error(const char *code, const char *message,
                                           const char *correlation_id)
{
    cJSON *payload = cJSON_CreateObject();
    if (payload == NULL) {
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddStringToObject(payload, "code", code);
    cJSON_AddStringToObject(payload, "message", message);
    cJSON_AddBoolToObject(payload, "retryable", false);
    agent_metric_protocol_error();
    return agent_send_payload("error", payload, correlation_id);
}

static const char *agent_action_error_code(world_action_error_t error)
{
    switch (error) {
    case WORLD_ACTION_ERROR_INVALID_ARGUMENT: return "INVALID_ARGUMENT";
    case WORLD_ACTION_ERROR_QUEUE_FULL: return "QUEUE_FULL";
    case WORLD_ACTION_ERROR_DEADLINE_EXCEEDED: return "DEADLINE_EXCEEDED";
    case WORLD_ACTION_ERROR_CANCELLED: return "CANCELLED";
    case WORLD_ACTION_ERROR_ACTION_ID_CONFLICT: return "ACTION_ID_CONFLICT";
    case WORLD_ACTION_ERROR_DEVICE_BUSY: return "DEVICE_BUSY";
    case WORLD_ACTION_ERROR_UNKNOWN_OBJECT: return "UNKNOWN_OBJECT";
    case WORLD_ACTION_ERROR_UNSUPPORTED_OBJECT_ACTION: return "UNSUPPORTED_OBJECT_ACTION";
    case WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE: return "OBJECT_UNAVAILABLE";
    case WORLD_ACTION_ERROR_OBJECT_OCCUPIED: return "OBJECT_OCCUPIED";
    case WORLD_ACTION_ERROR_OBJECT_NOT_REACHED: return "OBJECT_NOT_REACHED";
    default: return "INTERNAL";
    }
}

static cJSON *agent_action_result(const world_action_event_t *event)
{
    cJSON *result = cJSON_CreateObject();
    if (result == NULL) {
        return NULL;
    }
    switch (event->tool) {
    case WORLD_ACTION_CHARACTER_GO_TO_ROOM:
        cJSON_AddStringToObject(result, "room_id", agent_room_id(event->result.room));
        break;
    case WORLD_ACTION_CHARACTER_SET_ACTIVITY:
        cJSON_AddStringToObject(result, "activity", agent_activity_id(event->result.activity));
        break;
    case WORLD_ACTION_CHARACTER_SAY:
        cJSON_AddStringToObject(result, "text", event->result.text);
        break;
    case WORLD_ACTION_CHARACTER_GET_STATE:
        cJSON_Delete(result);
        return agent_character_json(&event->result.snapshot);
    case WORLD_ACTION_GET_SNAPSHOT:
        cJSON_AddNumberToObject(result, "state_version", event->result.snapshot.state_version);
        cJSON_AddNumberToObject(result, "observed_at_ms",
                                (double)event->result.snapshot.observed_at_ms);
        cJSON_AddItemToObject(result, "character",
                              agent_character_json(&event->result.snapshot));
        if (agent_uses_object_runtime()) {
            cJSON_AddItemToObject(result, "objects",
                                  agent_objects_json(&event->result.snapshot, false));
        }
        break;
    case WORLD_ACTION_CHARACTER_GO_TO_OBJECT:
    case WORLD_ACTION_CHARACTER_SIT:
    case WORLD_ACTION_CHARACTER_LOOK_AT:
    case WORLD_ACTION_CHARACTER_INTERACT:
        cJSON_AddStringToObject(result, "object_id", event->result.object.object_id);
        cJSON_AddStringToObject(result, "action",
                               world_object_action_text(event->result.object.action));
        cJSON_AddStringToObject(result, "pose",
                               world_service_pose_text(event->result.object.pose));
        break;
    default:
        break;
    }
    return result;
}

static esp_err_t agent_send_action_event(const world_action_event_t *event,
                                         const char *correlation_id)
{
    cJSON *payload = cJSON_CreateObject();
    if (payload == NULL) {
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddStringToObject(payload, "action_id", event->action_id);
    const char *type = NULL;
    switch (event->status) {
    case WORLD_ACTION_STATUS_ACCEPTED:
        type = "action.accepted";
        cJSON_AddNumberToObject(payload, "queue_position", event->queue_position);
        cJSON_AddNumberToObject(payload, "accepted_at_ms", (double)event->occurred_at_ms);
        break;
    case WORLD_ACTION_STATUS_STARTED:
        type = "action.started";
        cJSON_AddNumberToObject(payload, "started_at_ms", (double)event->occurred_at_ms);
        break;
    case WORLD_ACTION_STATUS_COMPLETED:
        type = "action.completed";
        cJSON_AddStringToObject(payload, "tool", world_service_tool_text(event->tool));
        cJSON_AddNumberToObject(payload, "completed_at_ms", (double)event->occurred_at_ms);
        cJSON_AddNumberToObject(payload, "state_version", event->state_version);
        cJSON_AddItemToObject(payload, "result", agent_action_result(event));
        break;
    case WORLD_ACTION_STATUS_FAILED: {
        type = "action.failed";
        cJSON_AddNumberToObject(payload, "failed_at_ms", (double)event->occurred_at_ms);
        cJSON *error = cJSON_CreateObject();
        cJSON_AddStringToObject(error, "code", agent_action_error_code(event->error));
        cJSON_AddStringToObject(error, "message", world_service_error_text(event->error));
        cJSON_AddBoolToObject(error, "retryable", event->retryable);
        cJSON_AddItemToObject(payload, "error", error);
        break;
    }
    default:
        cJSON_Delete(payload);
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t result = agent_send_payload(type, payload, correlation_id);
    if (result == ESP_OK && !event->from_cache && agent_object_tool(event->tool)) {
        if (event->status == WORLD_ACTION_STATUS_COMPLETED) {
            ESP_LOGW(TAG,
                     "VERIFY:phase3d:device_object_action:PASS action=%s target=%s pose=%s state_version=%" PRIu32,
                     world_object_action_text(event->result.object.action),
                     event->result.object.object_id,
                     world_service_pose_text(event->result.object.pose),
                     event->state_version);
        } else if (event->status == WORLD_ACTION_STATUS_FAILED &&
                   event->error == WORLD_ACTION_ERROR_CANCELLED) {
            ESP_LOGW(TAG,
                     "VERIFY:phase3d:device_object_cancel:PASS action_id=%s state_version=%" PRIu32,
                     event->action_id, event->state_version);
        }
    }
    if (result == ESP_OK && !event->from_cache) {
        taskENTER_CRITICAL(&s_agent.lock);
        if (event->status == WORLD_ACTION_STATUS_COMPLETED) {
            s_agent.metrics.completed_actions++;
        } else if (event->status == WORLD_ACTION_STATUS_FAILED) {
            s_agent.metrics.failed_actions++;
        }
        taskEXIT_CRITICAL(&s_agent.lock);
    }
    return result;
}

static bool agent_object_tool(world_action_tool_t tool)
{
    return tool >= WORLD_ACTION_OBJECT_FIRST && tool <= WORLD_ACTION_OBJECT_LAST;
}

static void agent_schedule_world_disconnect(uint64_t now_ms)
{
    taskENTER_CRITICAL(&s_agent.lock);
    s_agent.world_disconnect_deadline_ms = now_ms + AGENT_LOCAL_FALLBACK_GRACE_MS;
    taskEXIT_CRITICAL(&s_agent.lock);
}

static void agent_cancel_world_disconnect(void)
{
    taskENTER_CRITICAL(&s_agent.lock);
    s_agent.world_disconnect_deadline_ms = 0U;
    taskEXIT_CRITICAL(&s_agent.lock);
}

static void agent_publish_world_disconnect_if_due(void)
{
    bool due = false;
    const uint64_t now_ms = agent_now_ms();
    taskENTER_CRITICAL(&s_agent.lock);
    if (s_agent.world_disconnect_deadline_ms != 0U &&
        now_ms >= s_agent.world_disconnect_deadline_ms) {
        s_agent.world_disconnect_deadline_ms = 0U;
        due = true;
    }
    taskEXIT_CRITICAL(&s_agent.lock);
    /* A successful handshake can race the worker after it consumes the due
     * deadline. Recheck the transport truth before publishing fallback. */
    if (due && !agent_connected()) {
        (void)world_service_set_agent_connected(false);
    }
}

/* Action execution is advanced by the worker rather than inside the WebSocket
 * receive callback. This leaves the receive path free to process action.cancel
 * and gives object animations two complete 8 FPS frames before the terminal
 * snapshot replaces active_animation. */
static void agent_progress_action_queue(void)
{
    uint64_t now_ms = agent_now_ms();
    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    if (snapshot.active_action_id[0] != '\0') {
        if (s_agent.active_action_complete_at_ms == 0U ||
            now_ms < s_agent.active_action_complete_at_ms) {
            return;
        }
        world_action_event_t completed = {0};
        esp_err_t result = world_service_complete_active(&completed);
        s_agent.active_action_complete_at_ms = 0U;
        if (result != ESP_OK) {
            (void)agent_send_protocol_error("INTERNAL", "failed to complete active action",
                                            NULL);
            return;
        }
        (void)agent_send_action_event(&completed, NULL);
        (void)agent_send_world_changed();
    }

    world_action_event_t started = {0};
    esp_err_t result = world_service_start_next(&started);
    if (result == ESP_ERR_NOT_FOUND || result == ESP_ERR_INVALID_STATE) {
        return;
    }
    if (result != ESP_OK) {
        (void)agent_send_protocol_error("INTERNAL", "failed to start queued action", NULL);
        return;
    }
    (void)agent_send_action_event(&started, NULL);
    if (started.status != WORLD_ACTION_STATUS_STARTED) {
        return;
    }
    (void)agent_send_world_changed();
    s_agent.active_action_complete_at_ms =
        now_ms + (agent_object_tool(started.tool) ? AGENT_OBJECT_ACTION_RENDER_MS : 1U);
}

static bool agent_parse_action_request(const cJSON *payload, world_action_request_t *request)
{
    static const char *const fields[] = {
        "action_id", "tool", "arguments", "timeout_ms", "origin",
    };
    if (!agent_object_has_exact_fields(payload, fields, 5U)) {
        return false;
    }
    const cJSON *action_id = cJSON_GetObjectItemCaseSensitive(payload, "action_id");
    const cJSON *tool = cJSON_GetObjectItemCaseSensitive(payload, "tool");
    const cJSON *arguments = cJSON_GetObjectItemCaseSensitive(payload, "arguments");
    const cJSON *timeout = cJSON_GetObjectItemCaseSensitive(payload, "timeout_ms");
    const cJSON *origin = cJSON_GetObjectItemCaseSensitive(payload, "origin");
    uint32_t timeout_ms = 0U;
    if (!cJSON_IsString(action_id) || !agent_valid_id(action_id->valuestring) ||
        !cJSON_IsString(tool) || !cJSON_IsObject(arguments) || !cJSON_IsString(origin) ||
        !agent_json_integer(timeout, AGENT_ACTION_TIMEOUT_MIN_MS,
                            AGENT_ACTION_TIMEOUT_MAX_MS, &timeout_ms)) {
        return false;
    }
    if (strcmp(origin->valuestring, "user") != 0 && strcmp(origin->valuestring, "agent") != 0 &&
        strcmp(origin->valuestring, "autonomy") != 0 && strcmp(origin->valuestring, "test") != 0) {
        return false;
    }
    memset(request, 0, sizeof(*request));
    request->action_id = action_id->valuestring;
    request->timeout_ms = timeout_ms;
    size_t argument_count = 0U;
    for (const cJSON *child = arguments->child; child != NULL; child = child->next) {
        argument_count++;
    }
    if (strcmp(tool->valuestring, "character.get_state") == 0) {
        request->tool = WORLD_ACTION_CHARACTER_GET_STATE;
        return argument_count == 0U;
    }
    if (strcmp(tool->valuestring, "world.get_snapshot") == 0) {
        request->tool = WORLD_ACTION_GET_SNAPSHOT;
        return argument_count == 0U;
    }
    if (strcmp(tool->valuestring, "character.go_to_room") == 0) {
        const cJSON *room = cJSON_GetObjectItemCaseSensitive(arguments, "room_id");
        request->tool = WORLD_ACTION_CHARACTER_GO_TO_ROOM;
        return argument_count == 1U && cJSON_IsString(room) &&
               agent_parse_room(room->valuestring, &request->arguments.room);
    }
    if (strcmp(tool->valuestring, "character.set_activity") == 0) {
        const cJSON *activity = cJSON_GetObjectItemCaseSensitive(arguments, "activity");
        request->tool = WORLD_ACTION_CHARACTER_SET_ACTIVITY;
        if (argument_count != 1U || !cJSON_IsString(activity)) {
            return false;
        }
        if (strcmp(activity->valuestring, "idle") == 0) {
            request->arguments.activity = WORLD_ACTIVITY_IDLE;
            return true;
        }
        if (strcmp(activity->valuestring, "sleep") == 0) {
            request->arguments.activity = WORLD_ACTIVITY_SLEEP;
            return true;
        }
        return false;
    }
    if (strcmp(tool->valuestring, "character.say") == 0) {
        const cJSON *text = cJSON_GetObjectItemCaseSensitive(arguments, "text");
        request->tool = WORLD_ACTION_CHARACTER_SAY;
        if (argument_count != 1U || !cJSON_IsString(text)) {
            return false;
        }
        request->arguments.text = text->valuestring;
        return true;
    }
    if (agent_uses_object_runtime()) {
        const cJSON *target = cJSON_GetObjectItemCaseSensitive(arguments, "target_id");
        if (argument_count != 1U || !cJSON_IsString(target) ||
            strcmp(origin->valuestring, "user") == 0) {
            return false;
        }
        if (strcmp(tool->valuestring, "character.go_to") == 0) {
            request->tool = WORLD_ACTION_CHARACTER_GO_TO_OBJECT;
        } else if (strcmp(tool->valuestring, "character.sit") == 0) {
            request->tool = WORLD_ACTION_CHARACTER_SIT;
        } else if (strcmp(tool->valuestring, "character.look_at") == 0) {
            request->tool = WORLD_ACTION_CHARACTER_LOOK_AT;
        } else if (strcmp(tool->valuestring, "character.interact") == 0) {
            request->tool = WORLD_ACTION_CHARACTER_INTERACT;
        } else {
            return false;
        }
        request->arguments.target_id = target->valuestring;
        return true;
    }
    return false;
}

static void agent_handle_action_request(const cJSON *payload, const char *message_id)
{
    world_action_request_t request = {0};
    if (!agent_parse_action_request(payload, &request)) {
        (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid action.request payload",
                                        message_id);
        return;
    }
    if (xSemaphoreTake(s_agent.action_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
        (void)agent_send_protocol_error("INTERNAL", "action executor is busy", message_id);
        return;
    }
    world_action_event_t accepted = {0};
    esp_err_t result = world_service_submit(&request, &accepted);
    if (result != ESP_OK) {
        const char *code = result == ESP_ERR_INVALID_ARG ? "INVALID_MESSAGE" : "INTERNAL";
        (void)agent_send_protocol_error(code, "world service rejected action",
                                        message_id);
        xSemaphoreGive(s_agent.action_mutex);
        return;
    }
    (void)agent_send_action_event(&accepted, message_id);
    xSemaphoreGive(s_agent.action_mutex);
}

static void agent_handle_cancel(const cJSON *payload, const char *message_id)
{
    static const char *const fields[] = {"action_id", "reason"};
    if (!agent_object_has_exact_fields(payload, fields, 2U)) {
        (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid action.cancel payload",
                                        message_id);
        return;
    }
    const cJSON *action_id = cJSON_GetObjectItemCaseSensitive(payload, "action_id");
    const cJSON *reason = cJSON_GetObjectItemCaseSensitive(payload, "reason");
    if (!cJSON_IsString(action_id) || !agent_valid_id(action_id->valuestring) ||
        !cJSON_IsString(reason) || reason->valuestring[0] == '\0' ||
        strlen(reason->valuestring) > 128U) {
        (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid action.cancel payload",
                                        message_id);
        return;
    }
    if (xSemaphoreTake(s_agent.action_mutex, pdMS_TO_TICKS(5000)) != pdTRUE) {
        (void)agent_send_protocol_error("INTERNAL", "action executor is busy", message_id);
        return;
    }
    world_service_snapshot_t before = {0};
    world_service_get_snapshot(&before);
    world_action_event_t event = {0};
    esp_err_t result = world_service_cancel(action_id->valuestring, &event);
    if (result == ESP_ERR_NOT_FOUND) {
        (void)agent_send_protocol_error("ACTION_NOT_FOUND", "action id was not found", message_id);
        xSemaphoreGive(s_agent.action_mutex);
        return;
    }
    if (result != ESP_OK) {
        (void)agent_send_protocol_error("INTERNAL", "failed to cancel action", message_id);
        xSemaphoreGive(s_agent.action_mutex);
        return;
    }
    (void)agent_send_action_event(&event, message_id);
    if (before.active_action_id[0] != '\0' &&
        strcmp(before.active_action_id, action_id->valuestring) == 0) {
        s_agent.active_action_complete_at_ms = 0U;
    }
    world_service_snapshot_t after = {0};
    world_service_get_snapshot(&after);
    if (after.state_version != before.state_version) {
        (void)agent_send_world_changed();
    }
    xSemaphoreGive(s_agent.action_mutex);
}

static bool agent_valid_heartbeat(const cJSON *payload)
{
    static const char *const fields[] = {"uptime_ms", "last_rx_seq", "state_version"};
    const cJSON *uptime = cJSON_GetObjectItemCaseSensitive(payload, "uptime_ms");
    const cJSON *last_rx_seq = cJSON_GetObjectItemCaseSensitive(payload, "last_rx_seq");
    const cJSON *state_version = cJSON_GetObjectItemCaseSensitive(payload, "state_version");
    return agent_object_has_exact_fields(payload, fields, 3U) &&
           agent_json_nonnegative_integer(uptime) &&
           agent_json_integer(last_rx_seq, 0U, UINT32_MAX, NULL) &&
           agent_json_integer(state_version, 0U, UINT32_MAX, NULL);
}

static void agent_handle_resync(const cJSON *payload, const char *message_id)
{
    static const char *const fields[] = {"reason", "last_applied_state_version"};
    const cJSON *reason = cJSON_GetObjectItemCaseSensitive(payload, "reason");
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(payload, "last_applied_state_version");
    uint32_t ignored = 0U;
    if (!agent_object_has_exact_fields(payload, fields, 2U) || !cJSON_IsString(reason) ||
        !agent_json_integer(version, 0U, UINT32_MAX, &ignored) ||
        (strcmp(reason->valuestring, "seq_gap") != 0 &&
         strcmp(reason->valuestring, "state_version_gap") != 0 &&
         strcmp(reason->valuestring, "apply_failed") != 0 &&
         strcmp(reason->valuestring, "requested") != 0)) {
        (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid world.resync.request payload",
                                        message_id);
        return;
    }
    (void)agent_send_payload("world.snapshot", agent_snapshot_payload("resync"), message_id);
}

static void agent_handle_frame(const char *frame, size_t frame_length)
{
    cJSON *root = cJSON_ParseWithLength(frame, frame_length);
    static const char *const envelope_fields[] = {
        "protocol_version", "message_id", "correlation_id", "device_id", "session_id",
        "seq", "sent_at_ms", "type", "payload",
    };
    if (root == NULL || !agent_object_has_exact_fields(root, envelope_fields, 9U)) {
        cJSON_Delete(root);
        (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid protocol envelope", NULL);
        agent_request_reconnect();
        return;
    }
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(root, "protocol_version");
    const cJSON *message_id = cJSON_GetObjectItemCaseSensitive(root, "message_id");
    const cJSON *correlation = cJSON_GetObjectItemCaseSensitive(root, "correlation_id");
    const cJSON *device_id = cJSON_GetObjectItemCaseSensitive(root, "device_id");
    const cJSON *session_id = cJSON_GetObjectItemCaseSensitive(root, "session_id");
    const cJSON *seq = cJSON_GetObjectItemCaseSensitive(root, "seq");
    const cJSON *sent_at = cJSON_GetObjectItemCaseSensitive(root, "sent_at_ms");
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    const cJSON *payload = cJSON_GetObjectItemCaseSensitive(root, "payload");
    uint32_t sequence = 0U;
    bool valid = agent_json_integer(version, s_agent.protocol_version,
                                    s_agent.protocol_version, NULL) &&
                 cJSON_IsString(message_id) && agent_valid_id(message_id->valuestring) &&
                 (cJSON_IsNull(correlation) ||
                  (cJSON_IsString(correlation) && agent_valid_id(correlation->valuestring))) &&
                 cJSON_IsString(device_id) && strcmp(device_id->valuestring, s_agent.device_id) == 0 &&
                 cJSON_IsString(session_id) && strcmp(session_id->valuestring, s_agent.session_id) == 0 &&
                 agent_json_integer(seq, 0U, UINT32_MAX, &sequence) &&
                 agent_json_nonnegative_integer(sent_at) &&
                 cJSON_IsString(type) && cJSON_IsObject(payload);
    if (!valid) {
        cJSON_Delete(root);
        (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid protocol envelope", NULL);
        agent_request_reconnect();
        return;
    }
    if (sequence != s_agent.next_rx_seq) {
        const char *code = sequence < s_agent.next_rx_seq ? "SEQ_OUT_OF_ORDER" : "SEQ_GAP";
        (void)agent_send_protocol_error(code, "unexpected inbound sequence", message_id->valuestring);
        agent_request_reconnect();
        cJSON_Delete(root);
        return;
    }
    s_agent.last_rx_seq = sequence;
    s_agent.next_rx_seq = sequence + 1U;
    taskENTER_CRITICAL(&s_agent.lock);
    s_agent.metrics.received_frames++;
    s_agent.metrics.last_rx_seq = sequence;
    taskEXIT_CRITICAL(&s_agent.lock);

    if (strcmp(type->valuestring, "action.request") == 0) {
        agent_handle_action_request(payload, message_id->valuestring);
    } else if (strcmp(type->valuestring, "action.cancel") == 0) {
        agent_handle_cancel(payload, message_id->valuestring);
    } else if (strcmp(type->valuestring, "world.resync.request") == 0) {
        agent_handle_resync(payload, message_id->valuestring);
    } else if (strcmp(type->valuestring, "heartbeat") == 0) {
        if (!agent_valid_heartbeat(payload)) {
            (void)agent_send_protocol_error("INVALID_MESSAGE", "invalid heartbeat payload",
                                            message_id->valuestring);
        }
    } else {
        (void)agent_send_protocol_error("UNSUPPORTED_MESSAGE_TYPE", "unsupported inbound message type",
                                        message_id->valuestring);
    }
    cJSON_Delete(root);
}

static void agent_reset_rx(void)
{
    free(s_agent.rx_frame);
    s_agent.rx_frame = NULL;
    s_agent.rx_expected = 0U;
    s_agent.rx_received = 0U;
    s_agent.rx_dropping = false;
}

static void agent_handle_ws_data(const esp_websocket_event_data_t *data)
{
    if (data == NULL || data->data_ptr == NULL || data->data_len <= 0) {
        return;
    }
    size_t total = data->payload_len > 0 ? (size_t)data->payload_len : (size_t)data->data_len;
    size_t offset = data->payload_offset > 0 ? (size_t)data->payload_offset : 0U;
    size_t length = (size_t)data->data_len;
    if (s_agent.rx_dropping) {
        if (data->fin || offset + length >= s_agent.rx_expected) {
            agent_reset_rx();
        }
        return;
    }
    if (total > AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES) {
        s_agent.rx_dropping = true;
        s_agent.rx_expected = total;
        (void)agent_send_protocol_error("FRAME_TOO_LARGE", "frame exceeds 16 KiB", NULL);
        agent_request_reconnect();
        if (data->fin) {
            agent_reset_rx();
        }
        return;
    }
    if (offset == 0U && total == length) {
        agent_handle_frame(data->data_ptr, length);
        return;
    }
    if (offset == 0U || s_agent.rx_frame == NULL || s_agent.rx_expected != total) {
        agent_reset_rx();
        s_agent.rx_frame = malloc(total + 1U);
        if (s_agent.rx_frame == NULL) {
            agent_metric_protocol_error();
            agent_request_reconnect();
            return;
        }
        s_agent.rx_expected = total;
    }
    if (offset + length > s_agent.rx_expected) {
        agent_reset_rx();
        agent_metric_protocol_error();
        agent_request_reconnect();
        return;
    }
    memcpy(s_agent.rx_frame + offset, data->data_ptr, length);
    if (offset + length > s_agent.rx_received) {
        s_agent.rx_received = offset + length;
    }
    if (data->fin || s_agent.rx_received == s_agent.rx_expected) {
        s_agent.rx_frame[s_agent.rx_expected] = '\0';
        agent_handle_frame(s_agent.rx_frame, s_agent.rx_expected);
        agent_reset_rx();
    }
}

static esp_err_t agent_send_handshake(void)
{
    const esp_app_desc_t *description = esp_app_get_description();
    cJSON *hello = cJSON_CreateObject();
    cJSON_AddStringToObject(hello, "boot_id", s_agent.boot_id);
    cJSON_AddStringToObject(hello, "firmware_version",
                            description != NULL ? description->version : "unknown");
    cJSON *versions = cJSON_AddArrayToObject(hello, "protocol_versions");
    cJSON_AddItemToArray(versions, cJSON_CreateNumber(1));
    if (agent_uses_object_runtime()) {
        cJSON_AddItemToArray(versions, cJSON_CreateNumber(2));
    }
    cJSON_AddStringToObject(hello, "connection_reason",
                            s_agent.first_connection ? "boot" : "reconnect");
    ESP_RETURN_ON_ERROR(agent_send_payload("device.hello", hello, NULL), TAG,
                        "failed to send device hello");

    cJSON *capabilities = cJSON_CreateObject();
    cJSON_AddNumberToObject(capabilities, "selected_protocol_version",
                            s_agent.protocol_version);
    cJSON *rooms = cJSON_AddArrayToObject(capabilities, "rooms");
    for (int index = 0; index < WORLD_ROOM_COUNT; ++index) {
        cJSON_AddItemToArray(rooms, cJSON_CreateString(agent_room_id((world_room_id_t)index)));
    }
    cJSON *actions = cJSON_AddArrayToObject(capabilities, "actions");
    int last_action = agent_uses_object_runtime() ? WORLD_ACTION_OBJECT_LAST
                                                  : WORLD_ACTION_V1_LAST;
    for (int index = WORLD_ACTION_V1_FIRST; index <= last_action; ++index) {
        cJSON_AddItemToArray(actions,
                             cJSON_CreateString(world_service_tool_text((world_action_tool_t)index)));
    }
    if (agent_uses_object_runtime()) {
        world_service_snapshot_t snapshot = {0};
        world_service_get_snapshot(&snapshot);
        cJSON_AddItemToObject(capabilities, "objects",
                              agent_objects_json(&snapshot, true));
    }
    cJSON *limits = cJSON_AddObjectToObject(capabilities, "limits");
    cJSON_AddNumberToObject(limits, "max_json_frame_bytes", AGENT_TRANSPORT_MAX_JSON_FRAME_BYTES);
    cJSON_AddNumberToObject(limits, "action_queue_capacity", WORLD_SERVICE_ACTION_QUEUE_CAPACITY);
    cJSON_AddNumberToObject(limits, "say_text_max_chars", WORLD_SERVICE_SAY_TEXT_MAX_CHARS);
    cJSON_AddNumberToObject(limits, "action_timeout_min_ms", AGENT_ACTION_TIMEOUT_MIN_MS);
    cJSON_AddNumberToObject(limits, "action_timeout_max_ms", AGENT_ACTION_TIMEOUT_MAX_MS);
    cJSON_AddNumberToObject(limits, "idempotency_retention_ms",
                            WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS);
    ESP_RETURN_ON_ERROR(agent_send_payload("device.capabilities", capabilities, NULL), TAG,
                        "failed to send capabilities");
    ESP_RETURN_ON_ERROR(agent_send_payload("world.snapshot",
                                           agent_snapshot_payload(s_agent.first_connection
                                                                      ? "connect"
                                                                      : "reconnect"),
                                           NULL),
                        TAG, "failed to send initial snapshot");
    s_agent.first_connection = false;
    taskENTER_CRITICAL(&s_agent.lock);
    s_agent.handshake_sent = true;
    s_agent.metrics.handshake_sent = true;
    taskEXIT_CRITICAL(&s_agent.lock);
    return ESP_OK;
}

static void agent_ws_event(void *handler_args, esp_event_base_t base,
                           int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    const esp_websocket_event_data_t *data = (const esp_websocket_event_data_t *)event_data;
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED: {
        bool reconnect = !s_agent.first_connection;
        s_agent.next_tx_seq = 0U;
        s_agent.next_rx_seq = 0U;
        s_agent.last_rx_seq = 0U;
        s_agent.session_counter++;
        snprintf(s_agent.session_id, sizeof(s_agent.session_id), "session-%08" PRIx32 "-%" PRIu32,
                 s_agent.boot_nonce, s_agent.session_counter);
        taskENTER_CRITICAL(&s_agent.lock);
        s_agent.socket_connected = true;
        s_agent.connected = false;
        s_agent.handshake_sent = false;
        s_agent.metrics.connected = false;
        s_agent.metrics.handshake_sent = false;
        taskEXIT_CRITICAL(&s_agent.lock);
        if (agent_send_handshake() != ESP_OK) {
            ESP_LOGE(TAG, "device handshake failed");
            taskENTER_CRITICAL(&s_agent.lock);
            s_agent.connected = false;
            s_agent.handshake_sent = false;
            s_agent.metrics.connected = false;
            s_agent.metrics.handshake_sent = false;
            taskEXIT_CRITICAL(&s_agent.lock);
            (void)world_service_set_agent_connected(false);
            agent_request_reconnect();
        } else {
            agent_cancel_world_disconnect();
            taskENTER_CRITICAL(&s_agent.lock);
            s_agent.connected = true;
            s_agent.metrics.connected = true;
            s_agent.metrics.ever_connected = true;
            s_agent.last_disconnect_at_ms = 0U;
            if (reconnect) {
                s_agent.metrics.reconnect_count++;
            }
            taskEXIT_CRITICAL(&s_agent.lock);
            (void)world_service_set_agent_connected(true);
        }
        break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED: {
        uint64_t disconnected_at_ms = agent_now_ms();
        taskENTER_CRITICAL(&s_agent.lock);
        if (s_agent.connected) {
            s_agent.last_disconnect_at_ms = disconnected_at_ms;
        }
        s_agent.socket_connected = false;
        s_agent.connected = false;
        s_agent.handshake_sent = false;
        s_agent.metrics.connected = false;
        s_agent.metrics.handshake_sent = false;
        taskEXIT_CRITICAL(&s_agent.lock);
        agent_reset_rx();
        /* Keep the authoritative Agent snapshot through a short transport
         * interruption. Without this grace period the UI's local fallback
         * clears an object target before the automatic reconnect can publish
         * its snapshot, making reconnect reconciliation observe a state that
         * never came from either side of the protocol. */
        agent_schedule_world_disconnect(disconnected_at_ms);
        break;
    }
    case WEBSOCKET_EVENT_DATA:
        if (data != NULL && data->op_code == 0x2U) {
            size_t total = data->payload_len > 0
                               ? (size_t)data->payload_len
                               : (size_t)data->data_len;
            agent_reset_rx();
            if (!data->fin) {
                s_agent.rx_dropping = true;
                s_agent.rx_expected = total;
            }
            (void)agent_send_protocol_error("INVALID_MESSAGE",
                                            "binary frames are not supported", NULL);
            agent_request_reconnect();
        } else if (data != NULL && agent_connected() && s_agent.handshake_sent &&
                   (data->op_code == 0x1U || data->op_code == 0x0U)) {
            agent_handle_ws_data(data);
        }
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGW(TAG, "Agent WebSocket error type=%d",
                 data != NULL ? data->error_handle.error_type : -1);
        break;
    default:
        break;
    }
}

static void agent_worker(void *argument)
{
    (void)argument;
    while (s_agent.running) {
        agent_publish_world_disconnect_if_due();
        if (s_agent.reconnect_requested && s_agent.ws != NULL) {
            s_agent.reconnect_requested = false;
            esp_err_t stop_result = esp_websocket_client_stop(s_agent.ws);
            if (stop_result != ESP_OK) {
                ESP_LOGW(TAG, "Agent reconnect stop failed: %s",
                         esp_err_to_name(stop_result));
            }
            if (s_agent.running) {
                esp_err_t start_result = esp_websocket_client_start(s_agent.ws);
                if (start_result != ESP_OK) {
                    ESP_LOGW(TAG, "Agent reconnect start failed: %s",
                             esp_err_to_name(start_result));
                    s_agent.reconnect_requested = true;
                }
            }
            vTaskDelay(pdMS_TO_TICKS(AGENT_WORKER_INTERVAL_MS));
            continue;
        }
        if (agent_connected()) {
            if (xSemaphoreTake(s_agent.action_mutex, 0) == pdTRUE) {
                world_action_event_t expired = {0};
                world_service_snapshot_t before_expire = {0};
                world_service_get_snapshot(&before_expire);
                while (world_service_expire_next_due(&expired) == ESP_OK) {
                    (void)agent_send_action_event(&expired, NULL);
                    world_service_snapshot_t after_expire = {0};
                    world_service_get_snapshot(&after_expire);
                    if (after_expire.state_version != before_expire.state_version) {
                        (void)agent_send_world_changed();
                    }
                    before_expire = after_expire;
                }
                world_service_snapshot_t after_expirations = {0};
                world_service_get_snapshot(&after_expirations);
                if (after_expirations.active_action_id[0] == '\0') {
                    s_agent.active_action_complete_at_ms = 0U;
                }
                agent_progress_action_queue();
                xSemaphoreGive(s_agent.action_mutex);
            }
            uint64_t now = agent_now_ms();
            if (now - s_agent.last_heartbeat_ms >= AGENT_HEARTBEAT_INTERVAL_MS) {
                world_service_snapshot_t snapshot = {0};
                world_service_get_snapshot(&snapshot);
                cJSON *heartbeat = cJSON_CreateObject();
                cJSON_AddNumberToObject(heartbeat, "uptime_ms", (double)now);
                cJSON_AddNumberToObject(heartbeat, "last_rx_seq", s_agent.last_rx_seq);
                cJSON_AddNumberToObject(heartbeat, "state_version", snapshot.state_version);
                if (agent_send_payload("heartbeat", heartbeat, NULL) == ESP_OK) {
                    s_agent.last_heartbeat_ms = now;
                }
            }
            world_service_snapshot_t snapshot = {0};
            world_service_get_snapshot(&snapshot);
            taskENTER_CRITICAL(&s_agent.lock);
            s_agent.metrics.last_state_version = snapshot.state_version;
            taskEXIT_CRITICAL(&s_agent.lock);
        }
        taskENTER_CRITICAL(&s_agent.lock);
        s_agent.metrics.worker_stack_high_water_bytes =
            (uint32_t)uxTaskGetStackHighWaterMark(NULL);
        taskEXIT_CRITICAL(&s_agent.lock);
        vTaskDelay(pdMS_TO_TICKS(AGENT_WORKER_INTERVAL_MS));
    }
    s_agent.worker_task = NULL;
    vTaskDelete(NULL);
}

esp_err_t agent_transport_init(const agent_transport_config_t *config)
{
    if (s_agent.initialized) {
        return ESP_OK;
    }
    memset(&s_agent.metrics, 0, sizeof(s_agent.metrics));

#if CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED
    agent_transport_config_t build_config = {0};
    uint8_t build_pin[AGENT_TRANSPORT_SPKI_SHA256_BYTES] = {0};
#endif
    if (config == NULL) {
#if CONFIG_P4HOME_AGENT_TRANSPORT_ENABLED
        if (!agent_decode_pin(CONFIG_P4HOME_AGENT_SPKI_SHA256, build_pin)) {
            ESP_LOGE(TAG, "invalid Agent SPKI pin configuration");
            return ESP_ERR_INVALID_ARG;
        }
        build_config.uri = CONFIG_P4HOME_AGENT_TRANSPORT_URI;
        build_config.device_id = CONFIG_P4HOME_AGENT_DEVICE_ID;
        build_config.device_token = CONFIG_P4HOME_AGENT_DEVICE_TOKEN;
        build_config.protocol_version = CONFIG_P4HOME_AGENT_PROTOCOL_VERSION;
        memcpy(build_config.paired_spki_sha256, build_pin, sizeof(build_pin));
        config = &build_config;
#else
        s_agent.protocol_version = AGENT_TRANSPORT_PROTOCOL_V1;
        s_agent.initialized = true;
        s_agent.metrics.initialized = true;
        s_agent.metrics.protocol_version = AGENT_TRANSPORT_PROTOCOL_V1;
        ESP_LOGI(TAG, "Agent transport disabled; HA and local fallback remain active");
        return ESP_OK;
#endif
    }
    if (!agent_valid_uri(config->uri) || !agent_valid_id(config->device_id) ||
        !agent_valid_token(config->device_token)) {
        return ESP_ERR_INVALID_ARG;
    }
    uint8_t protocol_version = config->protocol_version == 0U
                                   ? AGENT_TRANSPORT_PROTOCOL_V1
                                   : config->protocol_version;
    if (protocol_version < AGENT_TRANSPORT_PROTOCOL_V1 ||
        protocol_version > AGENT_TRANSPORT_PROTOCOL_V2) {
        return ESP_ERR_INVALID_ARG;
    }
    snprintf(s_agent.uri, sizeof(s_agent.uri), "%s", config->uri);
    snprintf(s_agent.device_id, sizeof(s_agent.device_id), "%s", config->device_id);
    snprintf(s_agent.token, sizeof(s_agent.token), "%s", config->device_token);
    memcpy(s_agent.spki_sha256, config->paired_spki_sha256, sizeof(s_agent.spki_sha256));
    s_agent.protocol_version = protocol_version;
    uint8_t zero_pin[AGENT_TRANSPORT_SPKI_SHA256_BYTES] = {0};
    if (agent_constant_time_equal(s_agent.spki_sha256, zero_pin, sizeof(zero_pin))) {
        return ESP_ERR_INVALID_ARG;
    }
    snprintf(s_agent.headers, sizeof(s_agent.headers),
             "Authorization: Bearer %s\r\nX-P4-Device-ID: %s\r\n",
             s_agent.token, s_agent.device_id);
    s_agent.boot_nonce = esp_random();
    snprintf(s_agent.boot_id, sizeof(s_agent.boot_id), "boot-%08" PRIx32 "-%08" PRIx32,
             s_agent.boot_nonce, esp_random());
    s_agent.tx_mutex = xSemaphoreCreateMutex();
    if (s_agent.tx_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    s_agent.action_mutex = xSemaphoreCreateMutex();
    if (s_agent.action_mutex == NULL) {
        vSemaphoreDelete(s_agent.tx_mutex);
        s_agent.tx_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_agent.initialized = true;
    s_agent.enabled = true;
    s_agent.metrics.initialized = true;
    s_agent.metrics.enabled = true;
    s_agent.metrics.protocol_version = protocol_version;
    ESP_LOGI(TAG, "Agent transport configured device_id=%s uri=%s token=(redacted)",
             s_agent.device_id, s_agent.uri);
    return ESP_OK;
}

esp_err_t agent_transport_start(void)
{
    ESP_RETURN_ON_FALSE(s_agent.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "Agent transport not initialized");
    if (!s_agent.enabled || s_agent.running) {
        return ESP_OK;
    }
    ESP_RETURN_ON_FALSE(world_service_is_ready(), ESP_ERR_INVALID_STATE, TAG,
                        "world service is not ready");
    esp_websocket_client_config_t ws_config = {
        .uri = s_agent.uri,
        .headers = s_agent.headers,
        .buffer_size = AGENT_WS_BUFFER_BYTES,
        .task_stack = CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK,
        .crt_bundle_attach = agent_attach_spki_verifier,
        .skip_cert_common_name_check = true,
        .reconnect_timeout_ms = 2000,
        .enable_close_reconnect = true,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 10,
        .pingpong_timeout_sec = 10,
        .keep_alive_enable = true,
        .keep_alive_idle = 5,
        .keep_alive_interval = 5,
        .keep_alive_count = 3,
    };
    s_agent.ws = esp_websocket_client_init(&ws_config);
    ESP_RETURN_ON_FALSE(s_agent.ws != NULL, ESP_ERR_NO_MEM, TAG,
                        "failed to create Agent WebSocket client");
    esp_err_t result = esp_websocket_register_events(s_agent.ws, WEBSOCKET_EVENT_ANY,
                                                      agent_ws_event, NULL);
    if (result != ESP_OK) {
        esp_websocket_client_destroy(s_agent.ws);
        s_agent.ws = NULL;
        return result;
    }
    s_agent.running = true;
    s_agent.reconnect_requested = false;
    agent_cancel_world_disconnect();
    BaseType_t task_result = xTaskCreate(agent_worker, "agent_transport",
                                         CONFIG_P4HOME_AGENT_TRANSPORT_TASK_STACK,
                                         NULL, 5, &s_agent.worker_task);
    if (task_result != pdPASS) {
        s_agent.running = false;
        esp_websocket_client_destroy(s_agent.ws);
        s_agent.ws = NULL;
        return ESP_ERR_NO_MEM;
    }
    result = esp_websocket_client_start(s_agent.ws);
    if (result != ESP_OK) {
        s_agent.running = false;
        for (size_t attempt = 0U; attempt < 250U && s_agent.worker_task != NULL; ++attempt) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        esp_websocket_client_destroy(s_agent.ws);
        s_agent.ws = NULL;
        return result;
    }
    return ESP_OK;
}

esp_err_t agent_transport_stop(void)
{
    if (!s_agent.initialized || (!s_agent.running && s_agent.ws == NULL)) {
        return ESP_OK;
    }
    s_agent.running = false;
    s_agent.reconnect_requested = false;
    agent_cancel_world_disconnect();
    for (size_t attempt = 0U; attempt < 250U && s_agent.worker_task != NULL; ++attempt) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (s_agent.worker_task != NULL) {
        return ESP_ERR_TIMEOUT;
    }
    if (s_agent.ws != NULL) {
        (void)esp_websocket_client_stop(s_agent.ws);
        (void)esp_websocket_client_destroy(s_agent.ws);
        s_agent.ws = NULL;
    }
    uint64_t disconnected_at_ms = agent_now_ms();
    taskENTER_CRITICAL(&s_agent.lock);
    if (s_agent.connected) {
        s_agent.last_disconnect_at_ms = disconnected_at_ms;
    }
    s_agent.socket_connected = false;
    s_agent.connected = false;
    s_agent.handshake_sent = false;
    s_agent.metrics.connected = false;
    s_agent.metrics.handshake_sent = false;
    taskEXIT_CRITICAL(&s_agent.lock);
    agent_reset_rx();
    (void)world_service_set_agent_connected(false);
    return ESP_OK;
}

bool agent_transport_is_connected(void)
{
    return agent_connected();
}

void agent_transport_get_snapshot(agent_transport_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }
    uint64_t now = agent_now_ms();
    taskENTER_CRITICAL(&s_agent.lock);
    *snapshot = s_agent.metrics;
    if (!s_agent.connected && s_agent.last_disconnect_at_ms > 0U) {
        snapshot->disconnected_duration_ms = now - s_agent.last_disconnect_at_ms;
    }
    taskEXIT_CRITICAL(&s_agent.lock);
}
