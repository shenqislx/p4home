#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "world_object_registry.h"
#include "world_service.h"

typedef struct {
    uint64_t monotonic_ms;
    uint64_t wall_ms;
    size_t observer_calls;
} host_clock_t;

static host_clock_t s_clock = {
    .monotonic_ms = 1000U,
    .wall_ms = 1787616000000ULL,
};

#define CHECK(condition)                                                         \
    do {                                                                         \
        if (!(condition)) {                                                       \
            fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                    #condition);                                                  \
            return 1;                                                            \
        }                                                                        \
    } while (0)

static uint64_t host_monotonic_ms(void *user_data)
{
    return ((host_clock_t *)user_data)->monotonic_ms;
}

static uint64_t host_wall_ms(void *user_data)
{
    return ((host_clock_t *)user_data)->wall_ms;
}

static void host_observer(const world_service_snapshot_t *snapshot, void *user_data)
{
    host_clock_t *clock = user_data;
    if (snapshot != NULL) {
        clock->observer_calls++;
    }
}

static void advance_clock(uint64_t delta_ms)
{
    s_clock.monotonic_ms += delta_ms;
    s_clock.wall_ms += delta_ms;
}

static world_action_request_t request_for(const char *action_id,
                                          world_action_tool_t tool)
{
    world_action_request_t request = {
        .action_id = action_id,
        .tool = tool,
        .timeout_ms = 1000U,
    };
    return request;
}

static int run_action(world_action_request_t *request, world_action_event_t *completed)
{
    world_action_event_t event = {0};
    CHECK(world_service_submit(request, &event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_ACCEPTED);
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_STARTED);
    CHECK(strcmp(event.action_id, request->action_id) == 0);
    CHECK(world_service_complete_active(completed) == ESP_OK);
    CHECK(completed->status == WORLD_ACTION_STATUS_COMPLETED);
    return 0;
}

int main(void)
{
    CHECK(world_object_registry_count() == WORLD_OBJECT_REGISTRY_CAPACITY);
    const world_object_definition_t *sofa =
        world_object_registry_find("living_room.sofa");
    CHECK(sofa != NULL);
    CHECK(sofa->room == WORLD_ROOM_LIVING_ROOM);
    CHECK(sofa->anchor_art_x == 10);
    CHECK(sofa->anchor_floor_y == 32);
    CHECK(sofa->facing == WORLD_OBJECT_FACING_RIGHT);
    CHECK(sofa->default_available);
    CHECK(world_object_supports_action(sofa, WORLD_OBJECT_ACTION_GO_TO));
    CHECK(world_object_supports_action(sofa, WORLD_OBJECT_ACTION_SIT));
    CHECK(world_object_animation_for(sofa, WORLD_OBJECT_ACTION_SIT) ==
          WORLD_OBJECT_ANIMATION_CAT_SIT);

    const world_object_definition_t *desk = world_object_registry_find("study.desk");
    CHECK(desk != NULL);
    CHECK(!world_object_supports_action(desk, WORLD_OBJECT_ACTION_SIT));
    CHECK(world_object_animation_for(desk, WORLD_OBJECT_ACTION_SIT) ==
          WORLD_OBJECT_ANIMATION_NONE);
    CHECK(world_object_registry_find("living_room.missing") == NULL);
    CHECK(world_object_registry_at(WORLD_OBJECT_REGISTRY_CAPACITY) == NULL);

    world_service_config_t config = {
        .monotonic_ms = host_monotonic_ms,
        .wall_ms = host_wall_ms,
        .clock_user_data = &s_clock,
        .idempotency_retention_ms = WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS,
        .action_record_capacity = WORLD_SERVICE_ACTION_RECORD_CAPACITY,
    };
    CHECK(world_service_init(&config) == ESP_OK);
    CHECK(world_service_add_observer(host_observer, &s_clock) == ESP_OK);
    CHECK(world_service_add_observer(host_observer, &s_clock) == ESP_OK);

    world_local_fallback_context_t fallback = {
        .ha_connected = true,
        .online_entities = 12U,
        .lights_on_total = 2U,
    };
    fallback.room_lit[WORLD_ROOM_STUDY] = true;
    fallback.room_climate_on[WORLD_ROOM_STUDY] = true;
    CHECK(world_service_apply_local_fallback(&fallback) == ESP_OK);
    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.room == WORLD_ROOM_STUDY);
    CHECK(snapshot.activity == WORLD_ACTIVITY_IDLE);
    CHECK(strstr(snapshot.speech_text, "书房") != NULL);

    CHECK(world_service_set_agent_connected(true) == ESP_OK);
    fallback.lights_on_total = 0U;
    memset(fallback.room_lit, 0, sizeof(fallback.room_lit));
    memset(fallback.room_climate_on, 0, sizeof(fallback.room_climate_on));
    CHECK(world_service_apply_local_fallback(&fallback) == ESP_OK);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.room == WORLD_ROOM_STUDY);
    CHECK(snapshot.activity == WORLD_ACTIVITY_IDLE);

    world_action_event_t completed = {0};
    world_action_request_t get_state = request_for("host-get-state", WORLD_ACTION_CHARACTER_GET_STATE);
    CHECK(run_action(&get_state, &completed) == 0);
    CHECK(completed.result.snapshot.room == WORLD_ROOM_STUDY);

    world_action_request_t go_to = request_for("host-go-room", WORLD_ACTION_CHARACTER_GO_TO_ROOM);
    go_to.arguments.room = WORLD_ROOM_KITCHEN;
    CHECK(run_action(&go_to, &completed) == 0);
    CHECK(completed.result.room == WORLD_ROOM_KITCHEN);

    world_action_request_t set_activity = request_for("host-set-activity",
                                                      WORLD_ACTION_CHARACTER_SET_ACTIVITY);
    set_activity.arguments.activity = WORLD_ACTIVITY_SLEEP;
    CHECK(run_action(&set_activity, &completed) == 0);
    CHECK(completed.result.activity == WORLD_ACTIVITY_SLEEP);

    world_action_request_t say = request_for("host-say", WORLD_ACTION_CHARACTER_SAY);
    say.arguments.text = "我到餐厨了";
    CHECK(run_action(&say, &completed) == 0);
    CHECK(strcmp(completed.result.text, say.arguments.text) == 0);

    char unicode_text[WORLD_SERVICE_SAY_TEXT_MAX_CHARS * 3U + 1U];
    for (size_t index = 0U; index < WORLD_SERVICE_SAY_TEXT_MAX_CHARS; ++index) {
        memcpy(&unicode_text[index * 3U], "猫", 3U);
    }
    unicode_text[sizeof(unicode_text) - 1U] = '\0';
    world_action_request_t unicode_say = request_for("host-unicode-say",
                                                      WORLD_ACTION_CHARACTER_SAY);
    unicode_say.arguments.text = unicode_text;
    CHECK(run_action(&unicode_say, &completed) == 0);
    CHECK(strcmp(completed.result.text, unicode_text) == 0);

    char too_many_characters[WORLD_SERVICE_SAY_TEXT_MAX_CHARS + 2U];
    memset(too_many_characters, 'x', sizeof(too_many_characters) - 1U);
    too_many_characters[sizeof(too_many_characters) - 1U] = '\0';
    world_action_request_t invalid_say = request_for("host-invalid-say",
                                                      WORLD_ACTION_CHARACTER_SAY);
    invalid_say.arguments.text = too_many_characters;
    CHECK(world_service_submit(&invalid_say, &completed) == ESP_ERR_INVALID_ARG);

    world_action_request_t get_snapshot = request_for("host-get-snapshot",
                                                       WORLD_ACTION_GET_SNAPSHOT);
    CHECK(run_action(&get_snapshot, &completed) == 0);
    CHECK(completed.result.snapshot.room == WORLD_ROOM_KITCHEN);
    CHECK(completed.result.snapshot.activity == WORLD_ACTIVITY_SLEEP);

    uint32_t version_before_duplicate = completed.state_version;
    world_action_event_t duplicate = {0};
    CHECK(world_service_submit(&say, &duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_COMPLETED);
    CHECK(duplicate.from_cache);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.state_version == version_before_duplicate);
    world_action_request_t conflict = say;
    conflict.arguments.text = "冲突文本";
    CHECK(world_service_submit(&conflict, &duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(duplicate.error == WORLD_ACTION_ERROR_ACTION_ID_CONFLICT);

    char queue_ids[9][32];
    for (size_t index = 0U; index < 9U; ++index) {
        snprintf(queue_ids[index], sizeof(queue_ids[index]), "host-queue-%u", (unsigned)index);
        world_action_request_t queued = request_for(queue_ids[index],
                                                    WORLD_ACTION_CHARACTER_GET_STATE);
        CHECK(world_service_submit(&queued, &duplicate) == ESP_OK);
        if (index < WORLD_SERVICE_ACTION_QUEUE_CAPACITY) {
            CHECK(duplicate.status == WORLD_ACTION_STATUS_ACCEPTED);
        } else {
            CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
            CHECK(duplicate.error == WORLD_ACTION_ERROR_QUEUE_FULL);
            CHECK(duplicate.retryable);
        }
    }
    CHECK(world_service_queue_length() == WORLD_SERVICE_ACTION_QUEUE_CAPACITY);
    CHECK(world_service_cancel(queue_ids[0], &duplicate) == ESP_OK);
    CHECK(duplicate.error == WORLD_ACTION_ERROR_CANCELLED);
    CHECK(world_service_cancel(queue_ids[0], &duplicate) == ESP_OK);
    CHECK(duplicate.from_cache);
    for (size_t index = 1U; index < 8U; ++index) {
        CHECK(world_service_cancel(queue_ids[index], &duplicate) == ESP_OK);
    }
    CHECK(world_service_queue_length() == 0U);

    world_action_request_t active_capacity = request_for(
        "host-active-capacity", WORLD_ACTION_CHARACTER_GET_STATE);
    CHECK(world_service_submit(&active_capacity, &duplicate) == ESP_OK);
    CHECK(world_service_start_next(&duplicate) == ESP_OK);
    for (size_t index = 0U; index < WORLD_SERVICE_ACTION_QUEUE_CAPACITY; ++index) {
        snprintf(queue_ids[index], sizeof(queue_ids[index]), "host-active-queue-%u",
                 (unsigned)index);
        world_action_request_t queued = request_for(queue_ids[index],
                                                    WORLD_ACTION_CHARACTER_GET_STATE);
        CHECK(world_service_submit(&queued, &duplicate) == ESP_OK);
        if (index + 1U < WORLD_SERVICE_ACTION_QUEUE_CAPACITY) {
            CHECK(duplicate.status == WORLD_ACTION_STATUS_ACCEPTED);
        } else {
            CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
            CHECK(duplicate.error == WORLD_ACTION_ERROR_QUEUE_FULL);
        }
    }
    CHECK(world_service_queue_length() == WORLD_SERVICE_ACTION_QUEUE_CAPACITY);
    CHECK(world_service_cancel(active_capacity.action_id, &duplicate) == ESP_OK);
    for (size_t index = 0U; index + 1U < WORLD_SERVICE_ACTION_QUEUE_CAPACITY; ++index) {
        CHECK(world_service_cancel(queue_ids[index], &duplicate) == ESP_OK);
    }
    CHECK(world_service_queue_length() == 0U);

    world_action_request_t accepted_timeout = request_for(
        "host-accepted-timeout", WORLD_ACTION_CHARACTER_GET_STATE);
    accepted_timeout.timeout_ms = 100U;
    CHECK(world_service_submit(&accepted_timeout, &duplicate) == ESP_OK);
    advance_clock(100U);
    CHECK(world_service_start_next(&duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(duplicate.error == WORLD_ACTION_ERROR_DEADLINE_EXCEEDED);

    char due_ids[3][32];
    for (size_t index = 0U; index < 3U; ++index) {
        snprintf(due_ids[index], sizeof(due_ids[index]), "host-due-queue-%u",
                 (unsigned)index);
        world_action_request_t due = request_for(due_ids[index],
                                                 WORLD_ACTION_CHARACTER_GET_STATE);
        due.timeout_ms = 100U;
        CHECK(world_service_submit(&due, &duplicate) == ESP_OK);
        CHECK(duplicate.status == WORLD_ACTION_STATUS_ACCEPTED);
    }
    advance_clock(100U);
    for (size_t index = 0U; index < 3U; ++index) {
        CHECK(world_service_expire_next_due(&duplicate) == ESP_OK);
        CHECK(strcmp(duplicate.action_id, due_ids[index]) == 0);
        CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
        CHECK(duplicate.error == WORLD_ACTION_ERROR_DEADLINE_EXCEEDED);
    }
    CHECK(world_service_expire_next_due(&duplicate) == ESP_ERR_NOT_FOUND);
    CHECK(world_service_queue_length() == 0U);
    world_action_request_t expired_duplicate = request_for(
        due_ids[0], WORLD_ACTION_CHARACTER_GET_STATE);
    expired_duplicate.timeout_ms = 100U;
    CHECK(world_service_submit(&expired_duplicate, &duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(duplicate.error == WORLD_ACTION_ERROR_DEADLINE_EXCEEDED);
    CHECK(duplicate.from_cache);

    world_action_request_t started_timeout = request_for(
        "host-started-timeout", WORLD_ACTION_CHARACTER_GET_STATE);
    started_timeout.timeout_ms = 100U;
    CHECK(world_service_submit(&started_timeout, &duplicate) == ESP_OK);
    CHECK(world_service_start_next(&duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_STARTED);
    CHECK(world_service_expire_next_due(&duplicate) == ESP_ERR_NOT_FOUND);
    advance_clock(100U);
    CHECK(world_service_expire_next_due(&duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(duplicate.error == WORLD_ACTION_ERROR_DEADLINE_EXCEEDED);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.active_action_id[0] == '\0');

    unsigned fill_index = 0U;
    while (world_service_record_count() < WORLD_SERVICE_ACTION_RECORD_CAPACITY) {
        char action_id[40];
        snprintf(action_id, sizeof(action_id), "host-cache-fill-%u", fill_index++);
        world_action_request_t fill = request_for(action_id, WORLD_ACTION_CHARACTER_GET_STATE);
        CHECK(run_action(&fill, &completed) == 0);
    }
    world_action_request_t overflow = request_for("host-cache-overflow",
                                                  WORLD_ACTION_CHARACTER_GET_STATE);
    CHECK(world_service_submit(&overflow, &duplicate) == ESP_ERR_NO_MEM);
    advance_clock(WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS);
    CHECK(world_service_submit(&overflow, &duplicate) == ESP_OK);
    CHECK(duplicate.status == WORLD_ACTION_STATUS_ACCEPTED);

    CHECK(s_clock.observer_calls > 0U);
    printf("world_service_host_test: PASS records=%u observer_calls=%u state_version=%u\n",
           (unsigned)world_service_record_count(), (unsigned)s_clock.observer_calls,
           (unsigned)snapshot.state_version);
    return 0;
}
