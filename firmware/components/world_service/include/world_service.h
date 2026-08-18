#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define WORLD_SERVICE_ACTION_QUEUE_CAPACITY 8U
#define WORLD_SERVICE_ACTION_RECORD_CAPACITY 128U
#define WORLD_SERVICE_OBSERVER_CAPACITY 4U
#define WORLD_SERVICE_ACTION_ID_MAX_BYTES 128U
#define WORLD_SERVICE_SAY_TEXT_MAX_CHARS 256U
#define WORLD_SERVICE_SAY_TEXT_MAX_BYTES (WORLD_SERVICE_SAY_TEXT_MAX_CHARS * 4U)
#define WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS 600000U

typedef enum {
    WORLD_ROOM_PRIMARY_BEDROOM = 0,
    WORLD_ROOM_STUDY,
    WORLD_ROOM_GUEST_ROOM,
    WORLD_ROOM_ENTRY,
    WORLD_ROOM_LIVING_ROOM,
    WORLD_ROOM_KITCHEN,
    WORLD_ROOM_COUNT,
} world_room_id_t;

typedef enum {
    WORLD_ACTIVITY_IDLE = 0,
    WORLD_ACTIVITY_SLEEP,
} world_activity_t;

typedef enum {
    WORLD_SPEECH_TONE_DEFAULT = 0,
    WORLD_SPEECH_TONE_MUTED,
    WORLD_SPEECH_TONE_SLEEP,
    WORLD_SPEECH_TONE_COOL,
    WORLD_SPEECH_TONE_BRIGHT,
} world_speech_tone_t;

typedef enum {
    WORLD_ACTION_CHARACTER_GET_STATE = 0,
    WORLD_ACTION_CHARACTER_GO_TO_ROOM,
    WORLD_ACTION_CHARACTER_SET_ACTIVITY,
    WORLD_ACTION_CHARACTER_SAY,
    WORLD_ACTION_GET_SNAPSHOT,
} world_action_tool_t;

typedef enum {
    WORLD_ACTION_STATUS_ACCEPTED = 0,
    WORLD_ACTION_STATUS_STARTED,
    WORLD_ACTION_STATUS_COMPLETED,
    WORLD_ACTION_STATUS_FAILED,
} world_action_status_t;

typedef enum {
    WORLD_ACTION_ERROR_NONE = 0,
    WORLD_ACTION_ERROR_INVALID_ARGUMENT,
    WORLD_ACTION_ERROR_QUEUE_FULL,
    WORLD_ACTION_ERROR_DEADLINE_EXCEEDED,
    WORLD_ACTION_ERROR_CANCELLED,
    WORLD_ACTION_ERROR_ACTION_ID_CONFLICT,
    WORLD_ACTION_ERROR_DEVICE_BUSY,
    WORLD_ACTION_ERROR_ACTION_NOT_FOUND,
} world_action_error_t;

typedef struct {
    world_room_id_t room;
    world_activity_t activity;
    bool speaking;
    char active_action_id[WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
    uint32_t state_version;
    uint64_t observed_at_ms;
    char speech_text[WORLD_SERVICE_SAY_TEXT_MAX_BYTES + 1U];
    uint32_t speech_revision;
    world_speech_tone_t speech_tone;
    bool agent_connected;
} world_service_snapshot_t;

typedef struct {
    const char *action_id;
    world_action_tool_t tool;
    union {
        world_room_id_t room;
        world_activity_t activity;
        const char *text;
    } arguments;
    uint32_t timeout_ms;
} world_action_request_t;

typedef struct {
    world_action_status_t status;
    char action_id[WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
    world_action_tool_t tool;
    uint8_t queue_position;
    uint64_t occurred_at_ms;
    uint32_t state_version;
    world_action_error_t error;
    bool retryable;
    bool from_cache;
    union {
        world_room_id_t room;
        world_activity_t activity;
        char text[WORLD_SERVICE_SAY_TEXT_MAX_BYTES + 1U];
        world_service_snapshot_t snapshot;
    } result;
} world_action_event_t;

typedef uint64_t (*world_service_clock_cb_t)(void *user_data);
typedef void (*world_service_observer_cb_t)(const world_service_snapshot_t *snapshot,
                                            void *user_data);

typedef struct {
    world_service_clock_cb_t monotonic_ms;
    world_service_clock_cb_t wall_ms;
    void *clock_user_data;
    uint32_t idempotency_retention_ms;
    size_t action_record_capacity;
} world_service_config_t;

typedef struct {
    bool ha_connected;
    size_t online_entities;
    size_t lights_on_total;
    size_t climates_on_total;
    bool room_lit[WORLD_ROOM_COUNT];
    bool room_climate_on[WORLD_ROOM_COUNT];
} world_local_fallback_context_t;

esp_err_t world_service_init(const world_service_config_t *config);
bool world_service_is_ready(void);
esp_err_t world_service_add_observer(world_service_observer_cb_t observer, void *user_data);
void world_service_get_snapshot(world_service_snapshot_t *snapshot);

esp_err_t world_service_set_agent_connected(bool connected);
esp_err_t world_service_apply_local_fallback(const world_local_fallback_context_t *context);

esp_err_t world_service_submit(const world_action_request_t *request,
                               world_action_event_t *event);
esp_err_t world_service_start_next(world_action_event_t *event);
esp_err_t world_service_complete_active(world_action_event_t *event);
/* Returns one expired accepted/started action per call. Call until NOT_FOUND. */
esp_err_t world_service_expire_next_due(world_action_event_t *event);
esp_err_t world_service_cancel(const char *action_id, world_action_event_t *event);

size_t world_service_queue_length(void);
size_t world_service_record_count(void);

const char *world_service_room_text(world_room_id_t room);
const char *world_service_tool_text(world_action_tool_t tool);
const char *world_service_error_text(world_action_error_t error);
