#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "world_service.h"
static uint64_t clock_ms = 1000;
static uint64_t now(void *unused) { (void)unused; return clock_ms; }
static world_action_request_t move(const char *id, world_actor_id_t actor, world_room_id_t room) {
    world_action_request_t r = {.action_id=id, .actor_id=actor,
        .origin=actor == WORLD_ACTOR_CAT ? WORLD_ORIGIN_AUTONOMY : WORLD_ORIGIN_USER,
        .tool=WORLD_ACTION_CHARACTER_GO_TO_ROOM, .timeout_ms=1000};
    r.arguments.room=room; return r;
}
static world_action_event_t execute(world_action_request_t r) {
    world_action_event_t e;
    assert(world_service_submit(&r,&e)==ESP_OK && e.status==WORLD_ACTION_STATUS_ACCEPTED);
    assert(world_service_start_next(&e)==ESP_OK && e.actor_id==r.actor_id);
    assert(world_service_complete_active(&e)==ESP_OK && e.status==WORLD_ACTION_STATUS_COMPLETED);
    return e;
}
int main(void) {
    world_service_config_t config={.monotonic_ms=now,.wall_ms=now};
    assert(world_service_init(&config)==ESP_OK); world_service_enable_multi_actor();
    world_action_event_t e; world_service_snapshot_t both[WORLD_ACTOR_COUNT];
    e=execute(move("cat-move",WORLD_ACTOR_CAT,WORLD_ROOM_STUDY));
    assert(e.actor_id==WORLD_ACTOR_CAT); world_service_get_actors(both);
    assert(both[0].room==WORLD_ROOM_LIVING_ROOM && both[0].state_version==1);
    assert(both[1].room==WORLD_ROOM_STUDY && both[1].state_version==3);
    assert(both[0].world_version==both[1].world_version);
    world_action_request_t conflict=move("cat-move",WORLD_ACTOR_HUMAN,WORLD_ROOM_STUDY);
    assert(world_service_submit(&conflict,&e)==ESP_OK && e.error==WORLD_ACTION_ERROR_ACTION_ID_CONFLICT);
    world_action_request_t c1=move("cat-active",WORLD_ACTOR_CAT,WORLD_ROOM_KITCHEN);
    world_action_request_t c2=move("cat-queued1",WORLD_ACTOR_CAT,WORLD_ROOM_ENTRY);
    world_action_request_t c3=move("cat-queued2",WORLD_ACTOR_CAT,WORLD_ROOM_STUDY);
    world_action_request_t c4=move("cat-overflow",WORLD_ACTOR_CAT,WORLD_ROOM_LIVING_ROOM);
    assert(world_service_submit(&c1,&e)==ESP_OK); assert(world_service_start_next(&e)==ESP_OK);
    assert(world_service_submit(&c2,&e)==ESP_OK && e.status==WORLD_ACTION_STATUS_ACCEPTED);
    assert(world_service_submit(&c3,&e)==ESP_OK && e.status==WORLD_ACTION_STATUS_ACCEPTED);
    assert(world_service_submit(&c4,&e)==ESP_OK && e.error==WORLD_ACTION_ERROR_QUEUE_FULL);
    world_action_request_t h=move("human-move",WORLD_ACTOR_HUMAN,WORLD_ROOM_ENTRY);
    assert(world_service_submit(&h,&e)==ESP_OK && e.status==WORLD_ACTION_STATUS_ACCEPTED);
    assert(world_service_start_next(&e)==ESP_ERR_INVALID_STATE);
    for(int i=0;i<3;i++) assert(world_service_preempt_cat_next(&e)==ESP_OK && e.actor_id==WORLD_ACTOR_CAT && e.error==WORLD_ACTION_ERROR_CANCELLED);
    assert(world_service_preempt_cat_next(&e)==ESP_ERR_NOT_FOUND);
    assert(world_service_start_next(&e)==ESP_OK && e.actor_id==WORLD_ACTOR_HUMAN);
    world_action_request_t busy=move("cat-busy",WORLD_ACTOR_CAT,WORLD_ROOM_ENTRY);
    assert(world_service_submit(&busy,&e)==ESP_OK && e.error==WORLD_ACTION_ERROR_DEVICE_BUSY);
    assert(world_service_complete_active(&e)==ESP_OK);
    world_service_get_actors(both); assert(both[0].room==WORLD_ROOM_ENTRY && both[1].room==WORLD_ROOM_STUDY);
    assert(world_service_set_user_interaction_active(true)==ESP_OK);
    busy.action_id="cat-voice-busy";
    assert(world_service_submit(&busy,&e)==ESP_OK && e.error==WORLD_ACTION_ERROR_DEVICE_BUSY);
    assert(world_service_set_user_interaction_active(false)==ESP_OK);
    assert(world_service_preempt_cat_next(&e)==ESP_ERR_NOT_FOUND);
    // Shared sofa ownership is acquired only by sitting; Human cannot evict Cat.
    world_action_request_t object=move("cat-sofa",WORLD_ACTOR_CAT,WORLD_ROOM_LIVING_ROOM);
    object.tool=WORLD_ACTION_CHARACTER_GO_TO_OBJECT; object.arguments.target_id="living_room.sofa";execute(object);
    object.action_id="cat-sit"; object.tool=WORLD_ACTION_CHARACTER_SIT;execute(object);
    world_service_get_actors(both); assert(both[1].character_pose==WORLD_CHARACTER_POSE_SITTING);
    assert(both[0].objects[0].occupied_by_actor==WORLD_ACTOR_CAT);
    object.action_id="human-sofa";object.actor_id=WORLD_ACTOR_HUMAN;object.origin=WORLD_ORIGIN_USER;object.tool=WORLD_ACTION_CHARACTER_GO_TO_OBJECT;
    assert(world_service_submit(&object,&e)==ESP_OK && e.error==WORLD_ACTION_ERROR_OBJECT_OCCUPIED);
    assert(world_service_set_object_available("living_room.sofa",false)==ESP_OK);
    world_service_get_actors(both);assert(both[1].character_pose==WORLD_CHARACTER_POSE_STANDING && both[1].target_object_id[0]=='\0');
    assert(both[0].objects[0].occupied_by_actor==WORLD_ACTOR_NONE);
    // Expiry must version only the actor whose active action expired.
    world_service_get_actors(both);uint32_t human_version=both[0].state_version;
    busy.action_id="cat-timeout"; assert(world_service_submit(&busy,&e)==ESP_OK);
    assert(world_service_start_next(&e)==ESP_OK);clock_ms+=1001;
    assert(world_service_expire_next_due(&e)==ESP_OK && e.actor_id==WORLD_ACTOR_CAT && e.error==WORLD_ACTION_ERROR_DEADLINE_EXCEEDED);
    world_service_get_actors(both);assert(both[0].state_version==human_version && !world_service_has_active_action());
    // Cat work never resets the Human ten-minute idle clock.
    assert(world_service_update_sleep_clock(true,true)==ESP_OK); clock_ms+=WORLD_SERVICE_SLEEP_IDLE_MS;
    execute(move("cat-before-human-sleep",WORLD_ACTOR_CAT,WORLD_ROOM_KITCHEN));
    assert(world_service_update_sleep_clock(true,true)==ESP_OK);world_service_get_actors(both);
    assert(both[0].activity==WORLD_ACTIVITY_SLEEP && both[1].activity==WORLD_ACTIVITY_IDLE);
    puts("VERIFY:v4:actor_isolation_preemption_occupancy_timeout_sleep:PASS");return 0;
}
