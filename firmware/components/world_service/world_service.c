#include "world_service.h"

#include <ctype.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "world_object_registry.h"
#ifdef ESP_PLATFORM
#include "esp_heap_caps.h"
#endif

typedef struct {
    bool used;
    char action_id[WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
    world_action_tool_t tool;
    union {
        world_room_id_t room;
        world_activity_t activity;
        char text[WORLD_SERVICE_SAY_TEXT_MAX_BYTES + 1U];
        char target_id[WORLD_OBJECT_ID_MAX_BYTES + 1U];
    } arguments;
    uint32_t timeout_ms;
    uint64_t accepted_at_monotonic_ms;
    uint64_t terminal_at_monotonic_ms;
    world_action_event_t latest_event;
} world_action_record_t;

typedef struct {
    bool initialized;
    world_service_clock_cb_t monotonic_ms;
    world_service_clock_cb_t wall_ms;
    void *clock_user_data;
    uint32_t retention_ms;
    size_t record_capacity;
    world_service_snapshot_t snapshot;
    world_action_record_t *records;
    size_t queue[WORLD_SERVICE_ACTION_QUEUE_CAPACITY];
    size_t queue_count;
    size_t active_record;
    world_service_observer_cb_t observers[WORLD_SERVICE_OBSERVER_CAPACITY];
    void *observer_user_data[WORLD_SERVICE_OBSERVER_CAPACITY];
    size_t observer_count;
    bool object_external_occupied[WORLD_SERVICE_OBJECT_CAPACITY];
    bool object_character_occupied[WORLD_SERVICE_OBJECT_CAPACITY];
} world_service_state_t;

static portMUX_TYPE s_world_lock = portMUX_INITIALIZER_UNLOCKED;
static world_service_state_t s_world;

#define WORLD_NO_RECORD SIZE_MAX

static world_action_record_t *world_allocate_records(size_t capacity)
{
#ifdef ESP_PLATFORM
    return heap_caps_calloc(capacity, sizeof(world_action_record_t),
                            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    return calloc(capacity, sizeof(world_action_record_t));
#endif
}

static void world_free_records(world_action_record_t *records)
{
#ifdef ESP_PLATFORM
    heap_caps_free(records);
#else
    free(records);
#endif
}

static uint64_t world_default_clock_ms(void *user_data)
{
    (void)user_data;
    return (uint64_t)(esp_timer_get_time() / 1000);
}

static size_t world_bounded_length(const char *text, size_t maximum)
{
    if (text == NULL) {
        return maximum + 1U;
    }
    size_t length = 0U;
    while (length <= maximum && text[length] != '\0') {
        length++;
    }
    return length;
}

static bool world_valid_utf8_text(const char *text, size_t byte_length)
{
    const unsigned char *bytes = (const unsigned char *)text;
    size_t offset = 0U;
    size_t characters = 0U;
    while (offset < byte_length) {
        uint32_t codepoint = bytes[offset];
        size_t width = 1U;
        uint32_t minimum = 0U;
        if (codepoint <= 0x7FU) {
            width = 1U;
        } else if (codepoint >= 0xC2U && codepoint <= 0xDFU) {
            width = 2U;
            minimum = 0x80U;
            codepoint &= 0x1FU;
        } else if (codepoint >= 0xE0U && codepoint <= 0xEFU) {
            width = 3U;
            minimum = 0x800U;
            codepoint &= 0x0FU;
        } else if (codepoint >= 0xF0U && codepoint <= 0xF4U) {
            width = 4U;
            minimum = 0x10000U;
            codepoint &= 0x07U;
        } else {
            return false;
        }
        if (offset + width > byte_length) {
            return false;
        }
        for (size_t index = 1U; index < width; ++index) {
            unsigned char continuation = bytes[offset + index];
            if ((continuation & 0xC0U) != 0x80U) {
                return false;
            }
            codepoint = (codepoint << 6U) | (uint32_t)(continuation & 0x3FU);
        }
        if (codepoint < minimum || codepoint > 0x10FFFFU ||
            (codepoint >= 0xD800U && codepoint <= 0xDFFFU)) {
            return false;
        }
        offset += width;
        characters++;
        if (characters > WORLD_SERVICE_SAY_TEXT_MAX_CHARS) {
            return false;
        }
    }
    return characters > 0U;
}

static void world_copy_text(char *destination, size_t destination_size, const char *source)
{
    if (destination == NULL || destination_size == 0U) {
        return;
    }
    snprintf(destination, destination_size, "%s", source != NULL ? source : "");
}

static uint64_t world_monotonic_now(void)
{
    return s_world.monotonic_ms(s_world.clock_user_data);
}

static uint64_t world_wall_now(void)
{
    return s_world.wall_ms(s_world.clock_user_data);
}

static bool world_valid_action_id(const char *action_id)
{
    size_t length = world_bounded_length(action_id, WORLD_SERVICE_ACTION_ID_MAX_BYTES);
    if (length == 0U || length > WORLD_SERVICE_ACTION_ID_MAX_BYTES ||
        !isalnum((unsigned char)action_id[0])) {
        return false;
    }
    for (size_t index = 1U; index < length; ++index) {
        unsigned char character = (unsigned char)action_id[index];
        if (!isalnum(character) && character != '.' && character != '_' &&
            character != ':' && character != '-') {
            return false;
        }
    }
    return true;
}

static bool world_valid_object_id(const char *object_id)
{
    size_t length = world_bounded_length(object_id, WORLD_OBJECT_ID_MAX_BYTES);
    if (length < 3U || length > WORLD_OBJECT_ID_MAX_BYTES ||
        !islower((unsigned char)object_id[0])) {
        return false;
    }
    bool separator_seen = false;
    for (size_t index = 1U; index < length; ++index) {
        unsigned char character = (unsigned char)object_id[index];
        if (character == '.') {
            if (separator_seen || index + 1U >= length ||
                !islower((unsigned char)object_id[index + 1U])) {
                return false;
            }
            separator_seen = true;
        } else if (!islower(character) && !isdigit(character) && character != '_') {
            return false;
        }
    }
    return separator_seen;
}

static bool world_tool_is_object_action(world_action_tool_t tool)
{
    return tool >= WORLD_ACTION_OBJECT_FIRST && tool <= WORLD_ACTION_OBJECT_LAST;
}

static world_object_action_t world_object_action_for_tool(world_action_tool_t tool)
{
    switch (tool) {
    case WORLD_ACTION_CHARACTER_GO_TO_OBJECT: return WORLD_OBJECT_ACTION_GO_TO;
    case WORLD_ACTION_CHARACTER_SIT: return WORLD_OBJECT_ACTION_SIT;
    case WORLD_ACTION_CHARACTER_LOOK_AT: return WORLD_OBJECT_ACTION_LOOK_AT;
    case WORLD_ACTION_CHARACTER_INTERACT: return WORLD_OBJECT_ACTION_INTERACT;
    default: return WORLD_OBJECT_ACTION_COUNT;
    }
}

static bool world_valid_request(const world_action_request_t *request)
{
    if (request == NULL || !world_valid_action_id(request->action_id) ||
        request->timeout_ms < 100U || request->timeout_ms > 120000U ||
        request->tool < WORLD_ACTION_V1_FIRST ||
        request->tool > WORLD_ACTION_OBJECT_LAST) {
        return false;
    }
    switch (request->tool) {
    case WORLD_ACTION_CHARACTER_GO_TO_ROOM:
        return request->arguments.room >= WORLD_ROOM_PRIMARY_BEDROOM &&
               request->arguments.room < WORLD_ROOM_COUNT;
    case WORLD_ACTION_CHARACTER_SET_ACTIVITY:
        return request->arguments.activity == WORLD_ACTIVITY_IDLE ||
               request->arguments.activity == WORLD_ACTIVITY_SLEEP;
    case WORLD_ACTION_CHARACTER_SAY: {
        size_t length = world_bounded_length(request->arguments.text,
                                             WORLD_SERVICE_SAY_TEXT_MAX_BYTES);
        return length > 0U && length <= WORLD_SERVICE_SAY_TEXT_MAX_BYTES &&
               world_valid_utf8_text(request->arguments.text, length);
    }
    case WORLD_ACTION_CHARACTER_GET_STATE:
    case WORLD_ACTION_GET_SNAPSHOT:
        return true;
    case WORLD_ACTION_CHARACTER_GO_TO_OBJECT:
    case WORLD_ACTION_CHARACTER_SIT:
    case WORLD_ACTION_CHARACTER_LOOK_AT:
    case WORLD_ACTION_CHARACTER_INTERACT:
        return world_valid_object_id(request->arguments.target_id);
    default:
        return false;
    }
}

static bool world_request_matches(const world_action_record_t *record,
                                  const world_action_request_t *request)
{
    if (record->tool != request->tool) {
        return false;
    }
    switch (request->tool) {
    case WORLD_ACTION_CHARACTER_GO_TO_ROOM:
        return record->arguments.room == request->arguments.room;
    case WORLD_ACTION_CHARACTER_SET_ACTIVITY:
        return record->arguments.activity == request->arguments.activity;
    case WORLD_ACTION_CHARACTER_SAY:
        return strcmp(record->arguments.text, request->arguments.text) == 0;
    case WORLD_ACTION_CHARACTER_GET_STATE:
    case WORLD_ACTION_GET_SNAPSHOT:
        return true;
    case WORLD_ACTION_CHARACTER_GO_TO_OBJECT:
    case WORLD_ACTION_CHARACTER_SIT:
    case WORLD_ACTION_CHARACTER_LOOK_AT:
    case WORLD_ACTION_CHARACTER_INTERACT:
        return strcmp(record->arguments.target_id, request->arguments.target_id) == 0;
    default:
        return false;
    }
}

static void world_copy_request(world_action_record_t *record,
                               const world_action_request_t *request)
{
    record->tool = request->tool;
    record->timeout_ms = request->timeout_ms;
    world_copy_text(record->action_id, sizeof(record->action_id), request->action_id);
    switch (request->tool) {
    case WORLD_ACTION_CHARACTER_GO_TO_ROOM:
        record->arguments.room = request->arguments.room;
        break;
    case WORLD_ACTION_CHARACTER_SET_ACTIVITY:
        record->arguments.activity = request->arguments.activity;
        break;
    case WORLD_ACTION_CHARACTER_SAY:
        world_copy_text(record->arguments.text, sizeof(record->arguments.text),
                        request->arguments.text);
        break;
    case WORLD_ACTION_CHARACTER_GO_TO_OBJECT:
    case WORLD_ACTION_CHARACTER_SIT:
    case WORLD_ACTION_CHARACTER_LOOK_AT:
    case WORLD_ACTION_CHARACTER_INTERACT:
        world_copy_text(record->arguments.target_id, sizeof(record->arguments.target_id),
                        request->arguments.target_id);
        break;
    case WORLD_ACTION_CHARACTER_GET_STATE:
    case WORLD_ACTION_GET_SNAPSHOT:
    default:
        break;
    }
}

static void world_snapshot_locked(world_service_snapshot_t *snapshot)
{
    *snapshot = s_world.snapshot;
    snapshot->observed_at_ms = world_wall_now();
}

static void world_notify_observer(void)
{
    world_service_observer_cb_t observers[WORLD_SERVICE_OBSERVER_CAPACITY] = {0};
    void *user_data[WORLD_SERVICE_OBSERVER_CAPACITY] = {0};
    size_t observer_count = 0U;
    world_service_snapshot_t snapshot = {0};
    portENTER_CRITICAL(&s_world_lock);
    if (s_world.initialized) {
        world_snapshot_locked(&snapshot);
        observer_count = s_world.observer_count;
        memcpy(observers, s_world.observers, sizeof(observers));
        memcpy(user_data, s_world.observer_user_data, sizeof(user_data));
    }
    portEXIT_CRITICAL(&s_world_lock);
    for (size_t index = 0U; index < observer_count; ++index) {
        observers[index](&snapshot, user_data[index]);
    }
}

static void world_event_base_locked(world_action_event_t *event,
                                    const world_action_record_t *record,
                                    world_action_status_t status)
{
    memset(event, 0, sizeof(*event));
    event->status = status;
    event->tool = record->tool;
    event->occurred_at_ms = world_wall_now();
    event->state_version = s_world.snapshot.state_version;
    world_copy_text(event->action_id, sizeof(event->action_id), record->action_id);
}

static void world_set_failure_locked(world_action_record_t *record,
                                     world_action_error_t error,
                                     bool retryable)
{
    world_event_base_locked(&record->latest_event, record, WORLD_ACTION_STATUS_FAILED);
    record->latest_event.error = error;
    record->latest_event.retryable = retryable;
    record->terminal_at_monotonic_ms = world_monotonic_now();
}

static size_t world_find_record_locked(const char *action_id)
{
    for (size_t index = 0U; index < s_world.record_capacity; ++index) {
        if (s_world.records[index].used &&
            strcmp(s_world.records[index].action_id, action_id) == 0) {
            return index;
        }
    }
    return WORLD_NO_RECORD;
}

static void world_prune_records_locked(uint64_t now_ms)
{
    if (now_ms < s_world.retention_ms) {
        return;
    }
    uint64_t cutoff = now_ms - s_world.retention_ms;
    for (size_t index = 0U; index < s_world.record_capacity; ++index) {
        world_action_record_t *record = &s_world.records[index];
        bool terminal = record->latest_event.status == WORLD_ACTION_STATUS_COMPLETED ||
                        record->latest_event.status == WORLD_ACTION_STATUS_FAILED;
        if (record->used && terminal &&
            record->terminal_at_monotonic_ms <= cutoff) {
            memset(record, 0, sizeof(*record));
        }
    }
}

static size_t world_allocate_record_locked(void)
{
    for (size_t index = 0U; index < s_world.record_capacity; ++index) {
        if (!s_world.records[index].used) {
            memset(&s_world.records[index], 0, sizeof(s_world.records[index]));
            s_world.records[index].used = true;
            return index;
        }
    }
    return WORLD_NO_RECORD;
}

static void world_remove_queued_record_locked(size_t record_index)
{
    for (size_t queue_index = 0U; queue_index < s_world.queue_count; ++queue_index) {
        if (s_world.queue[queue_index] != record_index) {
            continue;
        }
        for (size_t move = queue_index + 1U; move < s_world.queue_count; ++move) {
            s_world.queue[move - 1U] = s_world.queue[move];
        }
        s_world.queue_count--;
        return;
    }
}

static bool world_record_expired_locked(const world_action_record_t *record,
                                        uint64_t now_ms)
{
    return now_ms >= record->accepted_at_monotonic_ms &&
           now_ms - record->accepted_at_monotonic_ms >= record->timeout_ms;
}

static void world_clear_active_locked(void)
{
    s_world.active_record = WORLD_NO_RECORD;
    s_world.snapshot.active_action_id[0] = '\0';
    s_world.snapshot.speaking = false;
    s_world.snapshot.active_animation = WORLD_OBJECT_ANIMATION_NONE;
}

static void world_increment_version_locked(void)
{
    if (s_world.snapshot.state_version < UINT32_MAX) {
        s_world.snapshot.state_version++;
    }
}

static size_t world_object_index_locked(const char *object_id)
{
    for (size_t index = 0U; index < s_world.snapshot.object_count; ++index) {
        if (strcmp(s_world.snapshot.objects[index].object_id, object_id) == 0) {
            return index;
        }
    }
    return WORLD_NO_RECORD;
}

static void world_refresh_object_occupied_locked(size_t index)
{
    s_world.snapshot.objects[index].occupied =
        s_world.object_external_occupied[index] || s_world.object_character_occupied[index];
}

static void world_release_character_occupancy_locked(void)
{
    for (size_t index = 0U; index < s_world.snapshot.object_count; ++index) {
        if (s_world.object_character_occupied[index]) {
            s_world.object_character_occupied[index] = false;
            world_refresh_object_occupied_locked(index);
        }
    }
}

static world_action_error_t world_object_request_error_locked(
    const world_action_record_t *record)
{
    const world_object_definition_t *definition =
        world_object_registry_find(record->arguments.target_id);
    if (definition == NULL) {
        return WORLD_ACTION_ERROR_UNKNOWN_OBJECT;
    }
    world_object_action_t action = world_object_action_for_tool(record->tool);
    if (!world_object_supports_action(definition, action)) {
        return WORLD_ACTION_ERROR_UNSUPPORTED_OBJECT_ACTION;
    }
    size_t object_index = world_object_index_locked(record->arguments.target_id);
    if (object_index == WORLD_NO_RECORD ||
        !s_world.snapshot.objects[object_index].available) {
        return WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE;
    }
    if (s_world.object_external_occupied[object_index]) {
        return WORLD_ACTION_ERROR_OBJECT_OCCUPIED;
    }
    if (action != WORLD_OBJECT_ACTION_GO_TO &&
        strcmp(s_world.snapshot.target_object_id, record->arguments.target_id) != 0) {
        return WORLD_ACTION_ERROR_OBJECT_NOT_REACHED;
    }
    return WORLD_ACTION_ERROR_NONE;
}

static bool world_object_error_retryable(world_action_error_t error)
{
    return error == WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE ||
           error == WORLD_ACTION_ERROR_OBJECT_OCCUPIED;
}

static void world_initialize_objects_locked(void)
{
    _Static_assert(WORLD_SERVICE_OBJECT_CAPACITY == WORLD_OBJECT_REGISTRY_CAPACITY,
                   "world snapshot and registry capacities must match");
    s_world.snapshot.object_count = world_object_registry_count();
    for (size_t index = 0U; index < s_world.snapshot.object_count; ++index) {
        const world_object_definition_t *definition = world_object_registry_at(index);
        world_object_state_t *state = &s_world.snapshot.objects[index];
        world_copy_text(state->object_id, sizeof(state->object_id), definition->object_id);
        state->room = definition->room;
        state->available = definition->default_available;
        state->occupied = false;
    }
    s_world.snapshot.character_facing = WORLD_OBJECT_FACING_RIGHT;
    s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_STANDING;
    s_world.snapshot.active_animation = WORLD_OBJECT_ANIMATION_NONE;
}

esp_err_t world_service_init(const world_service_config_t *config)
{
    world_service_clock_cb_t monotonic = config != NULL && config->monotonic_ms != NULL
                                               ? config->monotonic_ms
                                               : world_default_clock_ms;
    world_service_clock_cb_t wall = config != NULL && config->wall_ms != NULL
                                          ? config->wall_ms
                                          : world_default_clock_ms;
    uint32_t retention = config != NULL && config->idempotency_retention_ms != 0U
                             ? config->idempotency_retention_ms
                             : WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS;
    size_t capacity = config != NULL && config->action_record_capacity != 0U
                          ? config->action_record_capacity
                          : WORLD_SERVICE_ACTION_RECORD_CAPACITY;
    if (retention < WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS || capacity == 0U ||
        capacity > WORLD_SERVICE_ACTION_RECORD_CAPACITY) {
        return ESP_ERR_INVALID_ARG;
    }

    portENTER_CRITICAL(&s_world_lock);
    if (s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_OK;
    }
    portEXIT_CRITICAL(&s_world_lock);

    world_action_record_t *records = world_allocate_records(capacity);
    if (records == NULL) {
        return ESP_ERR_NO_MEM;
    }

    portENTER_CRITICAL(&s_world_lock);
    if (s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        world_free_records(records);
        return ESP_OK;
    }
    memset(&s_world, 0, sizeof(s_world));
    s_world.records = records;
    s_world.monotonic_ms = monotonic;
    s_world.wall_ms = wall;
    s_world.clock_user_data = config != NULL ? config->clock_user_data : NULL;
    s_world.retention_ms = retention;
    s_world.record_capacity = capacity;
    s_world.active_record = WORLD_NO_RECORD;
    s_world.snapshot.room = WORLD_ROOM_LIVING_ROOM;
    s_world.snapshot.activity = WORLD_ACTIVITY_IDLE;
    s_world.snapshot.speech_tone = WORLD_SPEECH_TONE_DEFAULT;
    s_world.snapshot.state_version = 1U;
    s_world.snapshot.observed_at_ms = world_wall_now();
    world_initialize_objects_locked();
    s_world.initialized = true;
    portEXIT_CRITICAL(&s_world_lock);
    return ESP_OK;
}

bool world_service_is_ready(void)
{
    portENTER_CRITICAL(&s_world_lock);
    bool ready = s_world.initialized;
    portEXIT_CRITICAL(&s_world_lock);
    return ready;
}

esp_err_t world_service_add_observer(world_service_observer_cb_t observer, void *user_data)
{
    if (observer == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    for (size_t index = 0U; index < s_world.observer_count; ++index) {
        if (s_world.observers[index] == observer &&
            s_world.observer_user_data[index] == user_data) {
            portEXIT_CRITICAL(&s_world_lock);
            return ESP_OK;
        }
    }
    if (s_world.observer_count >= WORLD_SERVICE_OBSERVER_CAPACITY) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NO_MEM;
    }
    s_world.observers[s_world.observer_count] = observer;
    s_world.observer_user_data[s_world.observer_count] = user_data;
    s_world.observer_count++;
    portEXIT_CRITICAL(&s_world_lock);
    return ESP_OK;
}

void world_service_get_snapshot(world_service_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }
    memset(snapshot, 0, sizeof(*snapshot));
    portENTER_CRITICAL(&s_world_lock);
    if (s_world.initialized) {
        world_snapshot_locked(snapshot);
    }
    portEXIT_CRITICAL(&s_world_lock);
}

esp_err_t world_service_set_agent_connected(bool connected)
{
    bool changed = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    changed = s_world.snapshot.agent_connected != connected;
    s_world.snapshot.agent_connected = connected;
    portEXIT_CRITICAL(&s_world_lock);
    if (changed) {
        world_notify_observer();
    }
    return ESP_OK;
}

static bool world_apply_desired_locked(world_room_id_t room,
                                       world_activity_t activity,
                                       const char *speech,
                                       world_speech_tone_t tone)
{
    bool changed = s_world.snapshot.room != room ||
                   s_world.snapshot.activity != activity ||
                   strcmp(s_world.snapshot.speech_text, speech) != 0 ||
                   s_world.snapshot.speech_tone != tone;
    if (!changed) {
        return false;
    }
    s_world.snapshot.room = room;
    s_world.snapshot.activity = activity;
    world_copy_text(s_world.snapshot.speech_text, sizeof(s_world.snapshot.speech_text), speech);
    s_world.snapshot.speech_tone = tone;
    s_world.snapshot.speech_revision++;
    world_increment_version_locked();
    return true;
}

esp_err_t world_service_apply_local_fallback(const world_local_fallback_context_t *context)
{
    if (context == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    bool changed = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_world.snapshot.agent_connected) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_OK;
    }

    if (!context->ha_connected || context->online_entities == 0U) {
        changed = world_apply_desired_locked(s_world.snapshot.room, WORLD_ACTIVITY_SLEEP,
                                             "信号断了…先打个盹",
                                             WORLD_SPEECH_TONE_MUTED);
    } else if (context->lights_on_total == 0U && context->climates_on_total == 0U) {
        changed = world_apply_desired_locked(WORLD_ROOM_PRIMARY_BEDROOM,
                                             WORLD_ACTIVITY_SLEEP,
                                             "全屋熄灯，去睡了",
                                             WORLD_SPEECH_TONE_SLEEP);
    } else {
        world_room_id_t destination = s_world.snapshot.room;
        bool found = false;
        for (size_t index = 0U; index < WORLD_ROOM_COUNT && !found; ++index) {
            if (context->room_climate_on[index]) {
                destination = (world_room_id_t)index;
                found = true;
            }
        }
        for (size_t index = 0U; index < WORLD_ROOM_COUNT && !found; ++index) {
            if (context->room_lit[index]) {
                destination = (world_room_id_t)index;
                found = true;
            }
        }
        char speech[WORLD_SERVICE_SAY_TEXT_MAX_BYTES + 1U];
        world_speech_tone_t tone = WORLD_SPEECH_TONE_DEFAULT;
        if (found && context->room_climate_on[destination]) {
            snprintf(speech, sizeof(speech), "%s在制冷，好凉快", world_service_room_text(destination));
            tone = WORLD_SPEECH_TONE_COOL;
        } else if (context->lights_on_total >= 8U) {
            snprintf(speech, sizeof(speech), "%s", "灯火通明！氛围值拉满");
            tone = WORLD_SPEECH_TONE_BRIGHT;
        } else {
            snprintf(speech, sizeof(speech), "去%s看看", world_service_room_text(destination));
        }
        changed = world_apply_desired_locked(destination, WORLD_ACTIVITY_IDLE, speech, tone);
    }
    portEXIT_CRITICAL(&s_world_lock);
    if (changed) {
        world_notify_observer();
    }
    return ESP_OK;
}

esp_err_t world_service_set_object_available(const char *object_id, bool available)
{
    if (!world_valid_object_id(object_id)) {
        return ESP_ERR_INVALID_ARG;
    }
    bool changed = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    size_t index = world_object_index_locked(object_id);
    if (index == WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NOT_FOUND;
    }
    changed = s_world.snapshot.objects[index].available != available;
    s_world.snapshot.objects[index].available = available;
    if (!available &&
        strcmp(s_world.snapshot.target_object_id, object_id) == 0) {
        if (s_world.object_character_occupied[index]) {
            s_world.object_character_occupied[index] = false;
            world_refresh_object_occupied_locked(index);
        }
        s_world.snapshot.target_object_id[0] = '\0';
        s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_STANDING;
        changed = true;
    }
    if (changed) {
        world_increment_version_locked();
    }
    portEXIT_CRITICAL(&s_world_lock);
    if (changed) {
        world_notify_observer();
    }
    return ESP_OK;
}

esp_err_t world_service_set_object_occupied(const char *object_id, bool occupied)
{
    if (!world_valid_object_id(object_id)) {
        return ESP_ERR_INVALID_ARG;
    }
    bool changed = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    size_t index = world_object_index_locked(object_id);
    if (index == WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NOT_FOUND;
    }
    changed = s_world.object_external_occupied[index] != occupied;
    s_world.object_external_occupied[index] = occupied;
    world_refresh_object_occupied_locked(index);
    if (occupied && strcmp(s_world.snapshot.target_object_id, object_id) == 0) {
        if (s_world.object_character_occupied[index]) {
            s_world.object_character_occupied[index] = false;
            world_refresh_object_occupied_locked(index);
        }
        s_world.snapshot.target_object_id[0] = '\0';
        s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_STANDING;
        changed = true;
    }
    if (changed) {
        world_increment_version_locked();
    }
    portEXIT_CRITICAL(&s_world_lock);
    if (changed) {
        world_notify_observer();
    }
    return ESP_OK;
}

esp_err_t world_service_submit(const world_action_request_t *request,
                               world_action_event_t *event)
{
    if (event == NULL || !world_valid_request(request)) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(event, 0, sizeof(*event));
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    uint64_t now_ms = world_monotonic_now();
    world_prune_records_locked(now_ms);
    size_t existing_index = world_find_record_locked(request->action_id);
    if (existing_index != WORLD_NO_RECORD) {
        world_action_record_t *existing = &s_world.records[existing_index];
        if (!world_request_matches(existing, request)) {
            world_event_base_locked(event, existing, WORLD_ACTION_STATUS_FAILED);
            event->error = WORLD_ACTION_ERROR_ACTION_ID_CONFLICT;
            event->retryable = false;
        } else {
            *event = existing->latest_event;
            event->from_cache = true;
        }
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_OK;
    }

    size_t record_index = world_allocate_record_locked();
    if (record_index == WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NO_MEM;
    }
    world_action_record_t *record = &s_world.records[record_index];
    world_copy_request(record, request);
    record->accepted_at_monotonic_ms = now_ms;
    world_action_error_t object_error = world_tool_is_object_action(record->tool)
                                            ? world_object_request_error_locked(record)
                                            : WORLD_ACTION_ERROR_NONE;
    if (object_error != WORLD_ACTION_ERROR_NONE) {
        world_set_failure_locked(record, object_error,
                                 world_object_error_retryable(object_error));
    } else {
        size_t in_flight = s_world.queue_count +
                           (s_world.active_record != WORLD_NO_RECORD ? 1U : 0U);
        if (in_flight >= WORLD_SERVICE_ACTION_QUEUE_CAPACITY) {
            world_set_failure_locked(record, WORLD_ACTION_ERROR_QUEUE_FULL, true);
        } else {
            world_event_base_locked(&record->latest_event, record, WORLD_ACTION_STATUS_ACCEPTED);
            record->latest_event.queue_position = (uint8_t)in_flight;
            s_world.queue[s_world.queue_count++] = record_index;
        }
    }
    *event = record->latest_event;
    portEXIT_CRITICAL(&s_world_lock);
    return ESP_OK;
}

esp_err_t world_service_start_next(world_action_event_t *event)
{
    if (event == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    bool notify = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_world.active_record != WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_world.queue_count == 0U) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NOT_FOUND;
    }
    size_t record_index = s_world.queue[0];
    world_remove_queued_record_locked(record_index);
    world_action_record_t *record = &s_world.records[record_index];
    uint64_t now_ms = world_monotonic_now();
    world_action_error_t object_error = world_tool_is_object_action(record->tool)
                                            ? world_object_request_error_locked(record)
                                            : WORLD_ACTION_ERROR_NONE;
    if (world_record_expired_locked(record, now_ms)) {
        world_set_failure_locked(record, WORLD_ACTION_ERROR_DEADLINE_EXCEEDED, false);
    } else if (object_error != WORLD_ACTION_ERROR_NONE) {
        world_set_failure_locked(record, object_error,
                                 world_object_error_retryable(object_error));
    } else {
        s_world.active_record = record_index;
        world_copy_text(s_world.snapshot.active_action_id,
                        sizeof(s_world.snapshot.active_action_id), record->action_id);
        s_world.snapshot.speaking = record->tool == WORLD_ACTION_CHARACTER_SAY;
        if (world_tool_is_object_action(record->tool)) {
            const world_object_definition_t *definition =
                world_object_registry_find(record->arguments.target_id);
            s_world.snapshot.active_animation = world_object_animation_for(
                definition, world_object_action_for_tool(record->tool));
        }
        world_increment_version_locked();
        world_event_base_locked(&record->latest_event, record, WORLD_ACTION_STATUS_STARTED);
        notify = true;
    }
    *event = record->latest_event;
    portEXIT_CRITICAL(&s_world_lock);
    if (notify) {
        world_notify_observer();
    }
    return ESP_OK;
}

esp_err_t world_service_complete_active(world_action_event_t *event)
{
    if (event == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_world.active_record == WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NOT_FOUND;
    }
    world_action_record_t *record = &s_world.records[s_world.active_record];
    uint64_t now_ms = world_monotonic_now();
    world_action_error_t object_error = world_tool_is_object_action(record->tool)
                                            ? world_object_request_error_locked(record)
                                            : WORLD_ACTION_ERROR_NONE;
    if (world_record_expired_locked(record, now_ms)) {
        world_clear_active_locked();
        world_increment_version_locked();
        world_set_failure_locked(record, WORLD_ACTION_ERROR_DEADLINE_EXCEEDED, false);
    } else if (object_error != WORLD_ACTION_ERROR_NONE) {
        world_clear_active_locked();
        world_increment_version_locked();
        world_set_failure_locked(record, object_error,
                                 world_object_error_retryable(object_error));
    } else {
        world_clear_active_locked();
        switch (record->tool) {
        case WORLD_ACTION_CHARACTER_GO_TO_ROOM:
            world_release_character_occupancy_locked();
            s_world.snapshot.room = record->arguments.room;
            s_world.snapshot.target_object_id[0] = '\0';
            s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_STANDING;
            break;
        case WORLD_ACTION_CHARACTER_SET_ACTIVITY:
            s_world.snapshot.activity = record->arguments.activity;
            break;
        case WORLD_ACTION_CHARACTER_SAY:
            world_copy_text(s_world.snapshot.speech_text,
                            sizeof(s_world.snapshot.speech_text), record->arguments.text);
            s_world.snapshot.speech_revision++;
            s_world.snapshot.speech_tone = WORLD_SPEECH_TONE_DEFAULT;
            break;
        case WORLD_ACTION_CHARACTER_GO_TO_OBJECT: {
            const world_object_definition_t *definition =
                world_object_registry_find(record->arguments.target_id);
            world_release_character_occupancy_locked();
            s_world.snapshot.room = definition->room;
            s_world.snapshot.activity = WORLD_ACTIVITY_IDLE;
            world_copy_text(s_world.snapshot.target_object_id,
                            sizeof(s_world.snapshot.target_object_id), definition->object_id);
            s_world.snapshot.character_art_x = definition->anchor_art_x;
            s_world.snapshot.character_floor_y = definition->anchor_floor_y;
            s_world.snapshot.character_facing = definition->facing;
            s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_STANDING;
            break;
        }
        case WORLD_ACTION_CHARACTER_SIT: {
            size_t object_index = world_object_index_locked(record->arguments.target_id);
            world_release_character_occupancy_locked();
            s_world.object_character_occupied[object_index] = true;
            world_refresh_object_occupied_locked(object_index);
            s_world.snapshot.character_pose = WORLD_CHARACTER_POSE_SITTING;
            break;
        }
        case WORLD_ACTION_CHARACTER_LOOK_AT:
        case WORLD_ACTION_CHARACTER_INTERACT: {
            const world_object_definition_t *definition =
                world_object_registry_find(record->arguments.target_id);
            s_world.snapshot.character_facing = definition->facing;
            break;
        }
        case WORLD_ACTION_CHARACTER_GET_STATE:
        case WORLD_ACTION_GET_SNAPSHOT:
        default:
            break;
        }
        world_increment_version_locked();
        world_event_base_locked(&record->latest_event, record, WORLD_ACTION_STATUS_COMPLETED);
        switch (record->tool) {
        case WORLD_ACTION_CHARACTER_GO_TO_ROOM:
            record->latest_event.result.room = s_world.snapshot.room;
            break;
        case WORLD_ACTION_CHARACTER_SET_ACTIVITY:
            record->latest_event.result.activity = s_world.snapshot.activity;
            break;
        case WORLD_ACTION_CHARACTER_SAY:
            world_copy_text(record->latest_event.result.text,
                            sizeof(record->latest_event.result.text), record->arguments.text);
            break;
        case WORLD_ACTION_CHARACTER_GET_STATE:
        case WORLD_ACTION_GET_SNAPSHOT:
            world_snapshot_locked(&record->latest_event.result.snapshot);
            break;
        case WORLD_ACTION_CHARACTER_GO_TO_OBJECT:
        case WORLD_ACTION_CHARACTER_SIT:
        case WORLD_ACTION_CHARACTER_LOOK_AT:
        case WORLD_ACTION_CHARACTER_INTERACT:
            world_copy_text(record->latest_event.result.object.object_id,
                            sizeof(record->latest_event.result.object.object_id),
                            record->arguments.target_id);
            record->latest_event.result.object.action =
                world_object_action_for_tool(record->tool);
            record->latest_event.result.object.pose = s_world.snapshot.character_pose;
            break;
        default:
            break;
        }
        record->terminal_at_monotonic_ms = now_ms;
    }
    *event = record->latest_event;
    portEXIT_CRITICAL(&s_world_lock);
    world_notify_observer();
    return ESP_OK;
}

esp_err_t world_service_expire_next_due(world_action_event_t *event)
{
    if (event == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    bool notify = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }

    uint64_t now_ms = world_monotonic_now();
    size_t record_index = WORLD_NO_RECORD;
    if (s_world.active_record != WORLD_NO_RECORD &&
        world_record_expired_locked(&s_world.records[s_world.active_record], now_ms)) {
        record_index = s_world.active_record;
        world_clear_active_locked();
        world_increment_version_locked();
        notify = true;
    } else {
        for (size_t queue_index = 0U; queue_index < s_world.queue_count; ++queue_index) {
            size_t queued_record = s_world.queue[queue_index];
            if (world_record_expired_locked(&s_world.records[queued_record], now_ms)) {
                record_index = queued_record;
                world_remove_queued_record_locked(record_index);
                break;
            }
        }
    }
    if (record_index == WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NOT_FOUND;
    }

    world_action_record_t *record = &s_world.records[record_index];
    world_set_failure_locked(record, WORLD_ACTION_ERROR_DEADLINE_EXCEEDED, false);
    *event = record->latest_event;
    portEXIT_CRITICAL(&s_world_lock);
    if (notify) {
        world_notify_observer();
    }
    return ESP_OK;
}

esp_err_t world_service_cancel(const char *action_id, world_action_event_t *event)
{
    if (event == NULL || !world_valid_action_id(action_id)) {
        return ESP_ERR_INVALID_ARG;
    }
    bool notify = false;
    portENTER_CRITICAL(&s_world_lock);
    if (!s_world.initialized) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_INVALID_STATE;
    }
    size_t record_index = world_find_record_locked(action_id);
    if (record_index == WORLD_NO_RECORD) {
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_ERR_NOT_FOUND;
    }
    world_action_record_t *record = &s_world.records[record_index];
    if (record->latest_event.status == WORLD_ACTION_STATUS_COMPLETED ||
        record->latest_event.status == WORLD_ACTION_STATUS_FAILED) {
        *event = record->latest_event;
        event->from_cache = true;
        portEXIT_CRITICAL(&s_world_lock);
        return ESP_OK;
    }
    world_remove_queued_record_locked(record_index);
    if (s_world.active_record == record_index) {
        world_clear_active_locked();
        world_increment_version_locked();
        notify = true;
    }
    world_set_failure_locked(record, WORLD_ACTION_ERROR_CANCELLED, false);
    *event = record->latest_event;
    portEXIT_CRITICAL(&s_world_lock);
    if (notify) {
        world_notify_observer();
    }
    return ESP_OK;
}

size_t world_service_queue_length(void)
{
    portENTER_CRITICAL(&s_world_lock);
    size_t length = s_world.queue_count + (s_world.active_record != WORLD_NO_RECORD ? 1U : 0U);
    portEXIT_CRITICAL(&s_world_lock);
    return length;
}

size_t world_service_record_count(void)
{
    size_t count = 0U;
    portENTER_CRITICAL(&s_world_lock);
    for (size_t index = 0U; index < s_world.record_capacity; ++index) {
        if (s_world.records[index].used) {
            count++;
        }
    }
    portEXIT_CRITICAL(&s_world_lock);
    return count;
}

const char *world_service_room_text(world_room_id_t room)
{
    static const char *const names[WORLD_ROOM_COUNT] = {
        "主卧", "书房", "次卧", "玄关", "客厅", "餐厨",
    };
    return room >= WORLD_ROOM_PRIMARY_BEDROOM && room < WORLD_ROOM_COUNT
               ? names[room]
               : "未知房间";
}

const char *world_service_tool_text(world_action_tool_t tool)
{
    static const char *const names[] = {
        "character.get_state",
        "character.go_to_room",
        "character.set_activity",
        "character.say",
        "world.get_snapshot",
        "character.go_to",
        "character.sit",
        "character.look_at",
        "character.interact",
    };
    return tool >= WORLD_ACTION_V1_FIRST && tool <= WORLD_ACTION_OBJECT_LAST
               ? names[tool]
               : "unknown";
}

const char *world_service_error_text(world_action_error_t error)
{
    static const char *const names[] = {
        "NONE",
        "INVALID_ARGUMENT",
        "QUEUE_FULL",
        "DEADLINE_EXCEEDED",
        "CANCELLED",
        "ACTION_ID_CONFLICT",
        "DEVICE_BUSY",
        "ACTION_NOT_FOUND",
        "UNKNOWN_OBJECT",
        "UNSUPPORTED_OBJECT_ACTION",
        "OBJECT_UNAVAILABLE",
        "OBJECT_OCCUPIED",
        "OBJECT_NOT_REACHED",
    };
    return error >= WORLD_ACTION_ERROR_NONE && error <= WORLD_ACTION_ERROR_OBJECT_NOT_REACHED
               ? names[error]
               : "INTERNAL";
}

const char *world_service_pose_text(world_character_pose_t pose)
{
    static const char *const names[] = {
        "standing", "sitting",
    };
    return pose >= WORLD_CHARACTER_POSE_STANDING && pose <= WORLD_CHARACTER_POSE_SITTING
               ? names[pose]
               : "unknown";
}
