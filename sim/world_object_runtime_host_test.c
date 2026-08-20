#include <stdio.h>
#include <string.h>

#include "world_object_registry.h"
#include "world_service.h"

typedef struct {
    uint64_t monotonic_ms;
    uint64_t wall_ms;
} object_test_clock_t;

static object_test_clock_t s_clock = {
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
    return ((object_test_clock_t *)user_data)->monotonic_ms;
}

static uint64_t host_wall_ms(void *user_data)
{
    return ((object_test_clock_t *)user_data)->wall_ms;
}

static world_action_request_t object_request(const char *action_id,
                                             world_action_tool_t tool,
                                             const char *target_id)
{
    world_action_request_t request = {
        .action_id = action_id,
        .tool = tool,
        .timeout_ms = 1000U,
    };
    request.arguments.target_id = target_id;
    return request;
}

static const world_object_state_t *snapshot_object(
    const world_service_snapshot_t *snapshot, const char *object_id)
{
    for (size_t index = 0U; index < snapshot->object_count; ++index) {
        if (strcmp(snapshot->objects[index].object_id, object_id) == 0) {
            return &snapshot->objects[index];
        }
    }
    return NULL;
}

static int complete_object_action(world_action_request_t *request,
                                  world_action_event_t *completed,
                                  world_object_animation_t expected_animation)
{
    world_action_event_t event = {0};
    CHECK(world_service_submit(request, &event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_ACCEPTED);
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_STARTED);
    world_service_snapshot_t running = {0};
    world_service_get_snapshot(&running);
    CHECK(running.active_animation == expected_animation);
    CHECK(strcmp(running.active_action_id, request->action_id) == 0);
    CHECK(world_service_complete_active(completed) == ESP_OK);
    CHECK(completed->status == WORLD_ACTION_STATUS_COMPLETED);
    CHECK(completed->result.object.action ==
          (world_object_action_t)(request->tool - WORLD_ACTION_OBJECT_FIRST));
    CHECK(strcmp(completed->result.object.object_id, request->arguments.target_id) == 0);
    return 0;
}

int main(void)
{
    world_service_config_t config = {
        .monotonic_ms = host_monotonic_ms,
        .wall_ms = host_wall_ms,
        .clock_user_data = &s_clock,
        .idempotency_retention_ms = WORLD_SERVICE_IDEMPOTENCY_RETENTION_MS,
        .action_record_capacity = WORLD_SERVICE_ACTION_RECORD_CAPACITY,
    };
    CHECK(world_service_init(&config) == ESP_OK);

    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.object_count == WORLD_OBJECT_REGISTRY_CAPACITY);
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_STANDING);
    CHECK(snapshot.target_object_id[0] == '\0');
    CHECK(snapshot.active_animation == WORLD_OBJECT_ANIMATION_NONE);
    CHECK(snapshot_object(&snapshot, "living_room.sofa") != NULL);
    CHECK(snapshot_object(&snapshot, "living_room.sofa")->available);
    CHECK(!snapshot_object(&snapshot, "living_room.sofa")->occupied);

    world_action_event_t event = {0};
    world_action_request_t unknown = object_request(
        "object-unknown", WORLD_ACTION_CHARACTER_GO_TO_OBJECT, "living_room.missing");
    CHECK(world_service_submit(&unknown, &event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(event.error == WORLD_ACTION_ERROR_UNKNOWN_OBJECT);
    CHECK(world_service_submit(&unknown, &event) == ESP_OK);
    CHECK(event.from_cache);
    world_action_request_t conflict = unknown;
    conflict.arguments.target_id = "study.desk";
    CHECK(world_service_submit(&conflict, &event) == ESP_OK);
    CHECK(event.error == WORLD_ACTION_ERROR_ACTION_ID_CONFLICT);

    world_action_request_t unsupported = object_request(
        "object-unsupported", WORLD_ACTION_CHARACTER_SIT, "study.desk");
    CHECK(world_service_submit(&unsupported, &event) == ESP_OK);
    CHECK(event.error == WORLD_ACTION_ERROR_UNSUPPORTED_OBJECT_ACTION);

    CHECK(world_service_set_object_available("living_room.window", false) == ESP_OK);
    world_action_request_t unavailable = object_request(
        "object-unavailable", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.window");
    CHECK(world_service_submit(&unavailable, &event) == ESP_OK);
    CHECK(event.error == WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE);
    CHECK(event.retryable);
    CHECK(world_service_set_object_available("living_room.window", true) == ESP_OK);

    CHECK(world_service_set_object_occupied("living_room.window", true) == ESP_OK);
    world_action_request_t occupied = object_request(
        "object-occupied", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.window");
    CHECK(world_service_submit(&occupied, &event) == ESP_OK);
    CHECK(event.error == WORLD_ACTION_ERROR_OBJECT_OCCUPIED);
    CHECK(event.retryable);
    CHECK(world_service_set_object_occupied("living_room.window", false) == ESP_OK);

    world_action_request_t not_reached = object_request(
        "object-not-reached", WORLD_ACTION_CHARACTER_SIT, "living_room.sofa");
    CHECK(world_service_submit(&not_reached, &event) == ESP_OK);
    CHECK(event.error == WORLD_ACTION_ERROR_OBJECT_NOT_REACHED);

    world_action_event_t completed = {0};
    world_action_request_t go_sofa = object_request(
        "object-go-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT, "living_room.sofa");
    CHECK(complete_object_action(&go_sofa, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_WALK) == 0);
    world_service_get_snapshot(&snapshot);
    CHECK(strcmp(snapshot.target_object_id, "living_room.sofa") == 0);
    CHECK(snapshot.room == WORLD_ROOM_LIVING_ROOM);
    CHECK(snapshot.character_art_x == 10);
    CHECK(snapshot.character_floor_y == 32);
    CHECK(snapshot.character_facing == WORLD_OBJECT_FACING_RIGHT);
    CHECK(snapshot.active_animation == WORLD_OBJECT_ANIMATION_NONE);

    world_action_request_t look_sofa = object_request(
        "object-look-sofa", WORLD_ACTION_CHARACTER_LOOK_AT, "living_room.sofa");
    CHECK(complete_object_action(&look_sofa, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_LOOK) == 0);
    world_action_request_t interact_sofa = object_request(
        "object-interact-sofa", WORLD_ACTION_CHARACTER_INTERACT,
        "living_room.sofa");
    CHECK(complete_object_action(&interact_sofa, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_PAW) == 0);
    world_action_request_t sit_sofa = object_request(
        "object-sit-sofa", WORLD_ACTION_CHARACTER_SIT, "living_room.sofa");
    CHECK(complete_object_action(&sit_sofa, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_SIT) == 0);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_SITTING);
    CHECK(snapshot_object(&snapshot, "living_room.sofa")->occupied);

    world_action_request_t cancel_window = object_request(
        "object-cancel-window", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.window");
    CHECK(world_service_submit(&cancel_window, &event) == ESP_OK);
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_STARTED);
    CHECK(world_service_cancel(cancel_window.action_id, &event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(event.error == WORLD_ACTION_ERROR_CANCELLED);
    world_service_get_snapshot(&snapshot);
    CHECK(strcmp(snapshot.target_object_id, "living_room.sofa") == 0);
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_SITTING);
    CHECK(snapshot.active_animation == WORLD_OBJECT_ANIMATION_NONE);
    CHECK(snapshot_object(&snapshot, "living_room.sofa")->occupied);
    CHECK(world_service_cancel(cancel_window.action_id, &event) == ESP_OK);
    CHECK(event.from_cache);

    world_action_request_t go_desk = object_request(
        "object-go-desk", WORLD_ACTION_CHARACTER_GO_TO_OBJECT, "study.desk");
    CHECK(complete_object_action(&go_desk, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_WALK) == 0);
    world_service_get_snapshot(&snapshot);
    CHECK(strcmp(snapshot.target_object_id, "study.desk") == 0);
    CHECK(snapshot.room == WORLD_ROOM_STUDY);
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_STANDING);
    CHECK(!snapshot_object(&snapshot, "living_room.sofa")->occupied);

    world_action_request_t deadline = object_request(
        "object-deadline", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.window");
    deadline.timeout_ms = 100U;
    CHECK(world_service_submit(&deadline, &event) == ESP_OK);
    s_clock.monotonic_ms += 100U;
    s_clock.wall_ms += 100U;
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(event.error == WORLD_ACTION_ERROR_DEADLINE_EXCEEDED);

    world_action_request_t queued_unavailable = object_request(
        "object-queued-unavailable", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.window");
    CHECK(world_service_submit(&queued_unavailable, &event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_ACCEPTED);
    CHECK(world_service_set_object_available("living_room.window", false) == ESP_OK);
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(event.error == WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE);
    CHECK(event.retryable);
    CHECK(world_service_set_object_available("living_room.window", true) == ESP_OK);

    world_action_request_t active_occupied = object_request(
        "object-active-occupied", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.window");
    CHECK(world_service_submit(&active_occupied, &event) == ESP_OK);
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_STARTED);
    CHECK(world_service_set_object_occupied("living_room.window", true) == ESP_OK);
    CHECK(world_service_complete_active(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(event.error == WORLD_ACTION_ERROR_OBJECT_OCCUPIED);
    CHECK(event.retryable);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.active_animation == WORLD_OBJECT_ANIMATION_NONE);
    CHECK(strcmp(snapshot.target_object_id, "study.desk") == 0);
    CHECK(world_service_set_object_occupied("living_room.window", false) == ESP_OK);

    CHECK(world_service_set_object_occupied("study.desk", true) == ESP_OK);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.target_object_id[0] == '\0');
    CHECK(snapshot_object(&snapshot, "study.desk")->occupied);
    CHECK(world_service_set_object_occupied("study.desk", false) == ESP_OK);
    world_action_request_t return_desk = object_request(
        "object-return-desk", WORLD_ACTION_CHARACTER_GO_TO_OBJECT, "study.desk");
    CHECK(complete_object_action(&return_desk, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_WALK) == 0);

    CHECK(world_service_set_object_available("study.desk", false) == ESP_OK);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.target_object_id[0] == '\0');
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_STANDING);
    CHECK(!snapshot_object(&snapshot, "study.desk")->available);
    CHECK(world_service_set_object_available("study.desk", true) == ESP_OK);

    world_action_request_t go_sofa_again = object_request(
        "object-go-sofa-again", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    CHECK(complete_object_action(&go_sofa_again, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_WALK) == 0);
    world_action_request_t active_sit_unavailable = object_request(
        "object-active-sit-unavailable", WORLD_ACTION_CHARACTER_SIT,
        "living_room.sofa");
    CHECK(world_service_submit(&active_sit_unavailable, &event) == ESP_OK);
    CHECK(world_service_start_next(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_STARTED);
    CHECK(world_service_set_object_available("living_room.sofa", false) == ESP_OK);
    CHECK(world_service_complete_active(&event) == ESP_OK);
    CHECK(event.status == WORLD_ACTION_STATUS_FAILED);
    CHECK(event.error == WORLD_ACTION_ERROR_OBJECT_UNAVAILABLE);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.target_object_id[0] == '\0');
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_STANDING);
    CHECK(!snapshot_object(&snapshot, "living_room.sofa")->occupied);
    CHECK(world_service_set_object_available("living_room.sofa", true) == ESP_OK);

    world_action_request_t offline_go_sofa = object_request(
        "object-offline-go-sofa", WORLD_ACTION_CHARACTER_GO_TO_OBJECT,
        "living_room.sofa");
    CHECK(complete_object_action(&offline_go_sofa, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_WALK) == 0);
    world_action_request_t offline_sit_sofa = object_request(
        "object-offline-sit-sofa", WORLD_ACTION_CHARACTER_SIT,
        "living_room.sofa");
    CHECK(complete_object_action(&offline_sit_sofa, &completed,
                                 WORLD_OBJECT_ANIMATION_CAT_SIT) == 0);
    CHECK(world_service_set_agent_connected(true) == ESP_OK);
    CHECK(world_service_set_agent_connected(false) == ESP_OK);
    world_service_get_snapshot(&snapshot);
    CHECK(!snapshot.agent_connected);
    CHECK(snapshot.target_object_id[0] == '\0');
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_STANDING);
    CHECK(!snapshot_object(&snapshot, "living_room.sofa")->occupied);
    world_local_fallback_context_t fallback = {
        .ha_connected = true,
        .online_entities = 1U,
        .lights_on_total = 1U,
    };
    fallback.room_lit[WORLD_ROOM_ENTRY] = true;
    CHECK(world_service_apply_local_fallback(&fallback) == ESP_OK);
    world_service_get_snapshot(&snapshot);
    CHECK(snapshot.target_object_id[0] == '\0');
    CHECK(snapshot.character_pose == WORLD_CHARACTER_POSE_STANDING);
    CHECK(snapshot.room == WORLD_ROOM_ENTRY);
    CHECK(!snapshot_object(&snapshot, "living_room.sofa")->occupied);

    CHECK(strcmp(world_service_tool_text(WORLD_ACTION_CHARACTER_GO_TO_OBJECT),
                 "character.go_to") == 0);
    CHECK(strcmp(world_service_error_text(WORLD_ACTION_ERROR_UNKNOWN_OBJECT),
                 "UNKNOWN_OBJECT") == 0);
    CHECK(strcmp(world_service_pose_text(WORLD_CHARACTER_POSE_SITTING),
                 "sitting") == 0);
    return 0;
}
