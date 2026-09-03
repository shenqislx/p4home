#include "ui_home_actor.h"
#include "ui_home_actor_test.h"

#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ui_fonts.h"
#include "ui_home_rooms.h"
#include "ui_pixel_art.h"
#include "ui_pixel_fx.h"
#include "ui_pixel_palette.h"
#include "world_object_registry.h"

static const char *TAG = "ui_actor";

#define UI_ACTOR_ART_W 8
#define UI_ACTOR_ART_H 13
#define UI_ACTOR_PET_ART_W 10
#define UI_ACTOR_DIALOG_PAGE_MAX 224U
#define UI_ACTOR_DIALOG_TEXT_MAX (CONVERSATION_UI_DIALOG_TEXT_MAX_BYTES + 1U)
#define UI_ACTOR_DIALOG_PAGE_HOLD_TICKS 24U
#define UI_ACTOR_PET_ART_H 6
#define UI_ACTOR_PET_IDLE_TICKS 80U
#define UI_ACTOR_PET_ROOM_MARGIN 8
#define UI_ACTOR_DEFERRED_ANIMATION_CAPACITY WORLD_SERVICE_ACTION_QUEUE_CAPACITY

/* Floor lines the actor stands on, in house art pixels. */
#define UI_ACTOR_UPPER_FLOOR_Y (UI_HOME_UPPER_ART_Y + UI_HOME_ROOM_ART_H - UI_ACTOR_ART_H - 2)
#define UI_ACTOR_LOWER_FLOOR_Y (UI_HOME_LOWER_ART_Y + UI_HOME_ROOM_ART_H - UI_ACTOR_ART_H - 2)
#define UI_ACTOR_STAIR_X (UI_HOME_STAIR_ART_X + 2)

typedef struct {
    int16_t x;
    int16_t y;
} ui_actor_point_t;

typedef enum {
    UI_ACTOR_RENDER_IDLE = 0,
    UI_ACTOR_RENDER_WALK,
    UI_ACTOR_RENDER_SLEEP,
    UI_ACTOR_RENDER_DOZE,
    UI_ACTOR_RENDER_OBJECT_IDLE,
    UI_ACTOR_RENDER_OBJECT_SIT,
    UI_ACTOR_RENDER_OBJECT_LOOK,
    UI_ACTOR_RENDER_OBJECT_PAW,
} ui_actor_render_state_t;

static lv_obj_t *s_actor;
static lv_obj_t *s_actor_shadow;
static lv_obj_t *s_pet;
static lv_obj_t *s_dialog_panel;
static lv_obj_t *s_dialog_label;
static lv_obj_t *s_dialog_cursor;

static ui_actor_render_state_t s_state = UI_ACTOR_RENDER_IDLE;
static world_activity_t s_desired_activity = WORLD_ACTIVITY_IDLE;
static world_speech_tone_t s_desired_tone = WORLD_SPEECH_TONE_DEFAULT;
static size_t s_room = WORLD_ROOM_LIVING_ROOM;
static world_object_facing_t s_facing = WORLD_OBJECT_FACING_RIGHT;
static world_character_pose_t s_object_pose = WORLD_CHARACTER_POSE_STANDING;
static world_object_animation_t s_active_animation = WORLD_OBJECT_ANIMATION_NONE;
static char s_target_object_id[WORLD_OBJECT_ID_MAX_BYTES + 1U];
static ui_actor_point_t s_pos;
static ui_actor_point_t s_target;
/* Two-leg route so crossing storeys goes via the stairs instead of through the
 * floor slab. */
static ui_actor_point_t s_waypoint;
static bool s_has_waypoint;

static uint8_t s_walk_frame;
static uint8_t s_idle_frame;
static uint16_t s_blink_countdown = 60U;
static bool s_blinking;

typedef struct {
    world_object_animation_t animation;
    char action_id[WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
    char target_object_id[WORLD_OBJECT_ID_MAX_BYTES + 1U];
} ui_actor_deferred_animation_t;

typedef enum {
    UI_ACTOR_DEFERRED_WAIT = 0,
    UI_ACTOR_DEFERRED_READY,
    UI_ACTOR_DEFERRED_DROP,
} ui_actor_deferred_status_t;

static ui_actor_deferred_animation_t
    s_deferred_animations[UI_ACTOR_DEFERRED_ANIMATION_CAPACITY];
static size_t s_deferred_animation_head;
static size_t s_deferred_animation_count;
static uint8_t s_deferred_animation_frames_remaining;
static bool s_deferred_animation_playing;
static char s_deferred_playing_action_id[WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
static char s_seen_deferred_action_ids[UI_ACTOR_DEFERRED_ANIMATION_CAPACITY]
                                      [WORLD_SERVICE_ACTION_ID_MAX_BYTES + 1U];
static size_t s_seen_deferred_action_head;
static size_t s_seen_deferred_action_count;

static ui_actor_point_t s_pet_pos;
static ui_actor_point_t s_pet_target;
static ui_actor_point_t s_pet_waypoint;
static size_t s_pet_room = WORLD_ROOM_LIVING_ROOM;
static size_t s_pet_target_room = WORLD_ROOM_LIVING_ROOM;
static uint16_t s_pet_idle_ticks_remaining;
static uint32_t s_pet_target_revision;
static bool s_pet_has_waypoint;
static bool s_pet_moving;
static uint8_t s_pet_frame;

static char s_dialog_full[UI_ACTOR_DIALOG_TEXT_MAX];
static size_t s_dialog_length;
static size_t s_dialog_page_start;
static size_t s_dialog_page_end;
static size_t s_dialog_revealed;
static uint16_t s_dialog_page_hold;
static bool s_cursor_visible;
static uint32_t s_speech_revision;
static uint32_t s_conversation_epoch;
static uint32_t s_conversation_revision;
static uint32_t s_local_conversation_revision;
static bool s_dialog_is_conversation;
static char s_conversation_dialog[CONVERSATION_UI_DIALOG_TEXT_MAX_BYTES + 1U];

static const lv_image_dsc_t *const s_idle_frames[] = ACTOR_IDLE_FRAMES;
static const lv_image_dsc_t *const s_walk_frames[] = ACTOR_WALK_FRAMES;
static const lv_image_dsc_t *const s_sleep_frames[] = ACTOR_SLEEP_FRAMES;
static const lv_image_dsc_t *const s_object_idle_frames[] = ACTOR_OBJECT_IDLE_FRAMES;
static const lv_image_dsc_t *const s_object_walk_frames[] = ACTOR_OBJECT_WALK_FRAMES;
static const lv_image_dsc_t *const s_sit_frames[] = ACTOR_SIT_FRAMES;
static const lv_image_dsc_t *const s_look_frames[] = ACTOR_LOOK_FRAMES;
static const lv_image_dsc_t *const s_paw_frames[] = ACTOR_PAW_FRAMES;
static const lv_image_dsc_t *const s_pet_frames[] = PET_IDLE_FRAMES;

static void ui_home_actor_set_render_state(ui_actor_render_state_t state);
static void ui_home_actor_say(const char *text, uint32_t accent, bool log_text);
static ui_actor_render_state_t ui_home_actor_desired_rest_state(
    world_speech_tone_t tone);

static bool ui_home_actor_is_deferred_animation(world_object_animation_t animation)
{
    return animation == WORLD_OBJECT_ANIMATION_CAT_SIT ||
           animation == WORLD_OBJECT_ANIMATION_CAT_LOOK ||
           animation == WORLD_OBJECT_ANIMATION_CAT_PAW;
}

static bool ui_home_actor_has_seen_deferred_action(const char *action_id)
{
    if (strcmp(action_id, s_deferred_playing_action_id) == 0) {
        return true;
    }
    for (size_t offset = 0U; offset < s_deferred_animation_count; ++offset) {
        size_t index = (s_deferred_animation_head + offset) %
                       UI_ACTOR_DEFERRED_ANIMATION_CAPACITY;
        if (strcmp(action_id, s_deferred_animations[index].action_id) == 0) {
            return true;
        }
    }
    for (size_t offset = 0U; offset < s_seen_deferred_action_count; ++offset) {
        size_t index = (s_seen_deferred_action_head + offset) %
                       UI_ACTOR_DEFERRED_ANIMATION_CAPACITY;
        if (strcmp(action_id, s_seen_deferred_action_ids[index]) == 0) {
            return true;
        }
    }
    return false;
}

static void ui_home_actor_mark_deferred_action_seen(const char *action_id)
{
    size_t index = 0U;
    if (s_seen_deferred_action_count < UI_ACTOR_DEFERRED_ANIMATION_CAPACITY) {
        index = (s_seen_deferred_action_head + s_seen_deferred_action_count) %
                UI_ACTOR_DEFERRED_ANIMATION_CAPACITY;
        s_seen_deferred_action_count++;
    } else {
        index = s_seen_deferred_action_head;
        s_seen_deferred_action_head = (s_seen_deferred_action_head + 1U) %
                                      UI_ACTOR_DEFERRED_ANIMATION_CAPACITY;
    }
    snprintf(s_seen_deferred_action_ids[index],
             sizeof(s_seen_deferred_action_ids[index]), "%s", action_id);
}

static void ui_home_actor_clear_deferred_animations(void)
{
    memset(s_deferred_animations, 0, sizeof(s_deferred_animations));
    s_deferred_animation_head = 0U;
    s_deferred_animation_count = 0U;
    s_deferred_animation_frames_remaining = 0U;
    s_deferred_animation_playing = false;
    s_deferred_playing_action_id[0] = '\0';
    s_active_animation = WORLD_OBJECT_ANIMATION_NONE;
}

static void ui_home_actor_queue_deferred_animation(
    const char *action_id, const char *target_object_id,
    world_object_animation_t animation)
{
    if (action_id == NULL || action_id[0] == '\0' ||
        target_object_id == NULL || target_object_id[0] == '\0' ||
        !ui_home_actor_is_deferred_animation(animation) ||
        ui_home_actor_has_seen_deferred_action(action_id)) {
        return;
    }
    ui_home_actor_mark_deferred_action_seen(action_id);
    if (s_deferred_animation_count >= UI_ACTOR_DEFERRED_ANIMATION_CAPACITY) {
        ESP_LOGW(TAG, "deferred Human animation queue full; dropping action=%s",
                 action_id);
        return;
    }
    size_t tail = (s_deferred_animation_head + s_deferred_animation_count) %
                  UI_ACTOR_DEFERRED_ANIMATION_CAPACITY;
    s_deferred_animations[tail].animation = animation;
    snprintf(s_deferred_animations[tail].action_id,
             sizeof(s_deferred_animations[tail].action_id), "%s", action_id);
    snprintf(s_deferred_animations[tail].target_object_id,
             sizeof(s_deferred_animations[tail].target_object_id), "%s",
             target_object_id);
    s_deferred_animation_count++;
}

static ui_actor_deferred_status_t ui_home_actor_deferred_status(
    const ui_actor_deferred_animation_t *deferred)
{
    world_action_event_t event = {0};
    if (world_service_get_action_event(deferred->action_id, &event) != ESP_OK ||
        event.status == WORLD_ACTION_STATUS_FAILED) {
        return UI_ACTOR_DEFERRED_DROP;
    }
    return event.status == WORLD_ACTION_STATUS_COMPLETED
               ? UI_ACTOR_DEFERRED_READY
               : UI_ACTOR_DEFERRED_WAIT;
}

/* Returns true when WALK was replaced by an animation or the stable pose. */
static bool ui_home_actor_begin_next_deferred_animation(void)
{
    while (s_deferred_animation_count > 0U) {
        ui_actor_deferred_animation_t *deferred =
            &s_deferred_animations[s_deferred_animation_head];
        ui_actor_deferred_status_t status =
            ui_home_actor_deferred_status(deferred);
        if (status == UI_ACTOR_DEFERRED_WAIT) {
            return false;
        }
        s_deferred_animation_head =
            (s_deferred_animation_head + 1U) % UI_ACTOR_DEFERRED_ANIMATION_CAPACITY;
        s_deferred_animation_count--;
        if (status == UI_ACTOR_DEFERRED_DROP ||
            strcmp(deferred->target_object_id, s_target_object_id) != 0) {
            continue;
        }
        world_object_animation_t animation = deferred->animation;
        s_deferred_animation_playing = true;
        snprintf(s_deferred_playing_action_id,
                 sizeof(s_deferred_playing_action_id), "%s", deferred->action_id);
        s_active_animation = animation;
        if (animation == WORLD_OBJECT_ANIMATION_CAT_SIT) {
            s_deferred_animation_frames_remaining = ACTOR_SIT_FRAME_COUNT / 2U;
            ui_home_actor_set_render_state(UI_ACTOR_RENDER_OBJECT_SIT);
        } else if (animation == WORLD_OBJECT_ANIMATION_CAT_LOOK) {
            s_deferred_animation_frames_remaining = ACTOR_LOOK_FRAME_COUNT / 2U;
            ui_home_actor_set_render_state(UI_ACTOR_RENDER_OBJECT_LOOK);
        } else {
            s_deferred_animation_frames_remaining = ACTOR_PAW_FRAME_COUNT / 2U;
            ui_home_actor_set_render_state(UI_ACTOR_RENDER_OBJECT_PAW);
        }
        return true;
    }
    s_deferred_animation_playing = false;
    s_deferred_playing_action_id[0] = '\0';
    s_active_animation = WORLD_OBJECT_ANIMATION_NONE;
    ui_home_actor_set_render_state(
        ui_home_actor_desired_rest_state(s_desired_tone));
    return true;
}

static bool ui_home_actor_finish_deferred_animation_if_due(void)
{
    if (!s_deferred_animation_playing ||
        s_deferred_animation_frames_remaining > 0U) {
        return false;
    }
    s_deferred_animation_playing = false;
    s_deferred_playing_action_id[0] = '\0';
    (void)ui_home_actor_begin_next_deferred_animation();
    return true;
}

static bool ui_home_actor_snapshot_starts_movement(
    const world_service_snapshot_t *snapshot)
{
    if (snapshot->active_action_id[0] == '\0') {
        return false;
    }
    world_action_event_t event = {0};
    if (world_service_get_action_event(snapshot->active_action_id, &event) != ESP_OK ||
        event.status != WORLD_ACTION_STATUS_STARTED) {
        return false;
    }
    return event.tool == WORLD_ACTION_CHARACTER_GO_TO_ROOM ||
           event.tool == WORLD_ACTION_CHARACTER_GO_TO_OBJECT;
}

static bool ui_home_actor_room_index(world_room_id_t room, size_t *room_index)
{
    static const world_room_id_t world_rooms[UI_HOME_ROOM_COUNT] = {
        WORLD_ROOM_PRIMARY_BEDROOM,
        WORLD_ROOM_STUDY,
        WORLD_ROOM_GUEST_ROOM,
        WORLD_ROOM_ENTRY,
        WORLD_ROOM_LIVING_ROOM,
        WORLD_ROOM_KITCHEN,
    };
    for (size_t index = 0U; index < UI_HOME_ROOM_COUNT; ++index) {
        if (world_rooms[index] == room) {
            *room_index = index;
            return true;
        }
    }
    return false;
}

static size_t ui_home_actor_dialog_page_end(size_t start)
{
    if (start >= s_dialog_length) {
        return s_dialog_length;
    }
    size_t end = start + UI_ACTOR_DIALOG_PAGE_MAX - 1U;
    if (end >= s_dialog_length) {
        return s_dialog_length;
    }
    while (end > start && ((unsigned char)s_dialog_full[end] & 0xC0U) == 0x80U) {
        end--;
    }
    return end;
}

static size_t ui_home_actor_direction_offset(size_t frames_per_direction)
{
    return s_facing == WORLD_OBJECT_FACING_RIGHT ? frames_per_direction : 0U;
}

static ui_actor_render_state_t ui_home_actor_desired_rest_state(world_speech_tone_t tone)
{
    switch (s_active_animation) {
    case WORLD_OBJECT_ANIMATION_CAT_SIT:
        return UI_ACTOR_RENDER_OBJECT_SIT;
    case WORLD_OBJECT_ANIMATION_CAT_LOOK:
        return UI_ACTOR_RENDER_OBJECT_LOOK;
    case WORLD_OBJECT_ANIMATION_CAT_PAW:
        return UI_ACTOR_RENDER_OBJECT_PAW;
    case WORLD_OBJECT_ANIMATION_CAT_WALK:
        return UI_ACTOR_RENDER_WALK;
    case WORLD_OBJECT_ANIMATION_NONE:
    default:
        break;
    }
    if (s_target_object_id[0] != '\0') {
        return s_object_pose == WORLD_CHARACTER_POSE_SITTING
                   ? UI_ACTOR_RENDER_OBJECT_SIT
                   : UI_ACTOR_RENDER_OBJECT_IDLE;
    }
    if (s_desired_activity != WORLD_ACTIVITY_SLEEP) {
        return UI_ACTOR_RENDER_IDLE;
    }
    return tone == WORLD_SPEECH_TONE_MUTED ? UI_ACTOR_RENDER_DOZE
                                           : UI_ACTOR_RENDER_SLEEP;
}

static int16_t ui_home_actor_room_stand_x(size_t room_index)
{
    const ui_home_room_def_t *def = ui_home_room_def(room_index);
    int32_t origin_x = 0;
    ui_home_room_origin(room_index, &origin_x, NULL);
    return (int16_t)(origin_x + (def != NULL ? def->stand_art_x : 24));
}

static int16_t ui_home_actor_room_floor_y(size_t room_index)
{
    const ui_home_room_def_t *def = ui_home_room_def(room_index);
    bool upper = def != NULL && def->level == 0;
    return (int16_t)(upper ? UI_ACTOR_UPPER_FLOOR_Y : UI_ACTOR_LOWER_FLOOR_Y);
}

static bool ui_home_actor_object_target(const world_service_snapshot_t *snapshot,
                                        size_t room_index,
                                        ui_actor_point_t *target)
{
    if (snapshot->target_object_id[0] == '\0' || target == NULL) {
        return false;
    }
    int32_t origin_x = 0;
    int32_t origin_y = 0;
    ui_home_room_origin(room_index, &origin_x, &origin_y);
    target->x = (int16_t)(origin_x + snapshot->character_art_x);
    target->y = (int16_t)(origin_y + snapshot->character_floor_y - UI_ACTOR_ART_H);
    return true;
}

/* s_pos is the top-left of a standing actor, so the floor line is always
 * s_pos.y + UI_ACTOR_ART_H. The lying-down pose is only 8 art px tall, so
 * placing it at s_pos would leave it floating; anchor every pose to that floor
 * line instead of to the top-left. */
static void ui_home_actor_place(void)
{
    if (s_actor == NULL) {
        return;
    }
    int32_t art_h = lv_obj_get_height(s_actor) / UI_PX_SCALE;
    if (art_h <= 0) {
        art_h = UI_ACTOR_ART_H;
    }
    int16_t draw_y = (int16_t)(s_pos.y + UI_ACTOR_ART_H - art_h);
    ui_pixel_fx_sprite_move(s_actor, s_pos.x, draw_y);
    if (s_actor_shadow != NULL) {
        int32_t art_w = lv_obj_get_width(s_actor) / UI_PX_SCALE;
        lv_obj_set_size(s_actor_shadow, UI_PX(art_w > 0 ? art_w : UI_ACTOR_ART_W), UI_PX(1));
        lv_obj_set_pos(s_actor_shadow, UI_PX(s_pos.x), UI_PX(s_pos.y + UI_ACTOR_ART_H));
    }
}

/* Every pose change has to re-anchor, because the poses differ in height. */
static void ui_home_actor_set_pose(const lv_image_dsc_t *src)
{
    if (s_actor == NULL || src == NULL) {
        return;
    }
    ui_pixel_fx_sprite_set_src(s_actor, src);
    ui_home_actor_place();
}

static ui_actor_point_t ui_home_actor_pet_room_target(size_t room_index,
                                                      uint32_t target_revision)
{
    int32_t origin_x = 0;
    ui_home_room_origin(room_index, &origin_x, NULL);
    const int16_t alternate_offset =
        (int16_t)(UI_HOME_ROOM_ART_W - UI_ACTOR_PET_ART_W - UI_ACTOR_PET_ROOM_MARGIN);
    ui_actor_point_t target = {
        .x = (int16_t)(origin_x + ((target_revision & 1U) != 0U
                                      ? UI_ACTOR_PET_ROOM_MARGIN
                                      : alternate_offset)),
        .y = (int16_t)(ui_home_actor_room_floor_y(room_index) + UI_ACTOR_ART_H -
                       UI_ACTOR_PET_ART_H),
    };
    return target;
}

static void ui_home_actor_place_pet(void)
{
    if (s_pet == NULL) {
        return;
    }
    ui_pixel_fx_sprite_move(s_pet, s_pet_pos.x, s_pet_pos.y);
}

static void ui_home_actor_pet_choose_target(void)
{
    /* This deterministic route is deliberately local. It neither consumes the
     * Human position nor introduces a global PRNG side effect. */
    static const size_t route[UI_HOME_ROOM_COUNT] = {
        WORLD_ROOM_LIVING_ROOM,
        WORLD_ROOM_KITCHEN,
        WORLD_ROOM_GUEST_ROOM,
        WORLD_ROOM_STUDY,
        WORLD_ROOM_PRIMARY_BEDROOM,
        WORLD_ROOM_ENTRY,
    };
    size_t route_index = 0U;
    while (route_index < UI_HOME_ROOM_COUNT && route[route_index] != s_pet_room) {
        route_index++;
    }
    s_pet_target_room = route[(route_index + 1U) % UI_HOME_ROOM_COUNT];
    s_pet_target_revision++;
    s_pet_target = ui_home_actor_pet_room_target(s_pet_target_room,
                                                  s_pet_target_revision);
    if (s_pet_target.y != s_pet_pos.y) {
        s_pet_waypoint.x = UI_ACTOR_STAIR_X;
        s_pet_waypoint.y = s_pet_target.y;
        s_pet_has_waypoint = true;
    } else {
        s_pet_has_waypoint = false;
    }
    s_pet_moving = true;
}

static void ui_home_actor_advance_pet(uint32_t tick)
{
    if (s_pet == NULL) {
        return;
    }
    if (!s_pet_moving) {
        if (s_pet_idle_ticks_remaining > 0U) {
            s_pet_idle_ticks_remaining--;
        }
        if (s_pet_idle_ticks_remaining == 0U) {
            ui_home_actor_pet_choose_target();
        }
        return;
    }
    if ((tick % 2U) != 0U) {
        return;
    }

    ui_actor_point_t goal = s_pet_has_waypoint ? s_pet_waypoint : s_pet_target;
    if (s_pet_pos.x != goal.x) {
        s_pet_pos.x = (int16_t)(s_pet_pos.x + (goal.x > s_pet_pos.x ? 1 : -1));
    } else if (s_pet_pos.y != goal.y) {
        s_pet_pos.y = (int16_t)(s_pet_pos.y + (goal.y > s_pet_pos.y ? 1 : -1));
    } else if (s_pet_has_waypoint) {
        s_pet_has_waypoint = false;
    } else {
        s_pet_room = s_pet_target_room;
        s_pet_moving = false;
        s_pet_idle_ticks_remaining = UI_ACTOR_PET_IDLE_TICKS;
    }
    ui_home_actor_place_pet();
}

static bool ui_home_actor_tick(uint32_t tick, void *user_data)
{
    (void)user_data;
    if (s_actor == NULL) {
        return true;
    }

    /* A following action may still be active when the previous deferred
     * animation ends. Poll its retained lifecycle without losing the stable
     * pose, then start it exactly once after it becomes terminal-success. */
    if (!s_deferred_animation_playing && s_deferred_animation_count > 0U &&
        s_state != UI_ACTOR_RENDER_WALK && s_pos.x == s_target.x &&
        s_pos.y == s_target.y && ui_home_actor_begin_next_deferred_animation()) {
        goto actor_tick_complete;
    }

    switch (s_state) {
    case UI_ACTOR_RENDER_WALK: {
        ui_actor_point_t goal = s_has_waypoint ? s_waypoint : s_target;
        /* One art pixel per tick, so the walk cycle and the travel distance stay
         * in lockstep and never look like sliding. */
        if (s_pos.x != goal.x) {
            s_pos.x = (int16_t)(s_pos.x + (goal.x > s_pos.x ? 1 : -1));
        } else if (s_pos.y != goal.y) {
            s_pos.y = (int16_t)(s_pos.y + (goal.y > s_pos.y ? 1 : -1));
        } else if (s_has_waypoint) {
            s_has_waypoint = false;
        } else {
            if (s_deferred_animation_count > 0U &&
                ui_home_actor_begin_next_deferred_animation()) {
                s_walk_frame = 0;
                break;
            }
            if (s_active_animation != WORLD_OBJECT_ANIMATION_CAT_WALK) {
                ui_home_actor_set_render_state(
                    ui_home_actor_desired_rest_state(s_desired_tone));
                s_walk_frame = 0;
                break;
            }
            /* Object go_to does not publish the destination anchor until the
             * action completes. Keep cycling the authoritative walk binding
             * in place during that execution window instead of dropping back
             * to idle after the first frame. */
        }
        if (s_target_object_id[0] != '\0') {
            const size_t frames_per_direction = ACTOR_OBJECT_WALK_FRAME_COUNT / 2U;
            s_walk_frame = (uint8_t)((s_walk_frame + 1U) % frames_per_direction);
            ui_home_actor_set_pose(
                s_object_walk_frames[ui_home_actor_direction_offset(frames_per_direction) +
                                     s_walk_frame]);
        } else {
            s_walk_frame = (uint8_t)((s_walk_frame + 1U) % ACTOR_WALK_FRAME_COUNT);
            ui_home_actor_set_pose(s_walk_frames[s_walk_frame]);
        }
        ui_home_actor_place();
        break;
    }
    case UI_ACTOR_RENDER_OBJECT_SIT: {
        if (ui_home_actor_finish_deferred_animation_if_due()) {
            break;
        }
        const size_t frames_per_direction = ACTOR_SIT_FRAME_COUNT / 2U;
        if ((tick % 8U) == 0U) {
            s_idle_frame = (uint8_t)((s_idle_frame + 1U) % frames_per_direction);
            ui_home_actor_set_pose(
                s_sit_frames[ui_home_actor_direction_offset(frames_per_direction) +
                             s_idle_frame]);
            if (s_deferred_animation_playing) {
                s_deferred_animation_frames_remaining--;
            }
        }
        break;
    }
    case UI_ACTOR_RENDER_OBJECT_LOOK: {
        if (ui_home_actor_finish_deferred_animation_if_due()) {
            break;
        }
        const size_t frames_per_direction = ACTOR_LOOK_FRAME_COUNT / 2U;
        if ((tick % 2U) == 0U) {
            s_idle_frame = (uint8_t)((s_idle_frame + 1U) % frames_per_direction);
            ui_home_actor_set_pose(
                s_look_frames[ui_home_actor_direction_offset(frames_per_direction) +
                              s_idle_frame]);
            if (s_deferred_animation_playing) {
                s_deferred_animation_frames_remaining--;
            }
        }
        break;
    }
    case UI_ACTOR_RENDER_OBJECT_PAW: {
        if (ui_home_actor_finish_deferred_animation_if_due()) {
            break;
        }
        const size_t frames_per_direction = ACTOR_PAW_FRAME_COUNT / 2U;
        s_idle_frame = (uint8_t)((s_idle_frame + 1U) % frames_per_direction);
        ui_home_actor_set_pose(
            s_paw_frames[ui_home_actor_direction_offset(frames_per_direction) +
                         s_idle_frame]);
        if (s_deferred_animation_playing) {
            s_deferred_animation_frames_remaining--;
        }
        break;
    }
    case UI_ACTOR_RENDER_OBJECT_IDLE:
        /* Static object-idle art is installed when the render state changes.
         * Reapplying the same image every 125 ms invalidates the LVGL object
         * and spends draw budget without changing a pixel. */
        break;
    case UI_ACTOR_RENDER_SLEEP:
    case UI_ACTOR_RENDER_DOZE:
        if ((tick % 8U) == 0U) {
            s_idle_frame = (uint8_t)((s_idle_frame + 1U) % ACTOR_SLEEP_FRAME_COUNT);
            ui_home_actor_set_pose(s_sleep_frames[s_idle_frame]);
        }
        break;
    case UI_ACTOR_RENDER_IDLE:
    default:
        if (s_blinking) {
            s_blinking = false;
            ui_home_actor_set_pose(s_idle_frames[s_idle_frame]);
        } else if (s_blink_countdown > 0U) {
            s_blink_countdown--;
        } else {
            /* Irregular blink interval; a fixed one reads as a machine. */
            s_blink_countdown = (uint16_t)(40U + (tick * 37U) % 60U);
            s_blinking = true;
            ui_home_actor_set_pose(&actor_blink);
        }
        if (!s_blinking && (tick % 8U) == 0U) {
            s_idle_frame = (uint8_t)((s_idle_frame + 1U) % ACTOR_IDLE_FRAME_COUNT);
            ui_home_actor_set_pose(s_idle_frames[s_idle_frame]);
        }
        break;
    }

actor_tick_complete:
    ui_home_actor_advance_pet(tick);
    if ((tick % 4U) == 0U && s_pet != NULL) {
        s_pet_frame = (uint8_t)((s_pet_frame + 1U) % PET_IDLE_FRAME_COUNT);
        ui_pixel_fx_sprite_set_src(s_pet, s_pet_frames[s_pet_frame]);
    }

    /* Typewriter reveal: two characters per tick. Long v1 say payloads are
     * paged through the fixed-size HUD without truncating UTF-8 code points. */
    if (s_dialog_label != NULL && s_dialog_revealed < s_dialog_page_end) {
        for (int step = 0; step < 2 && s_dialog_revealed < s_dialog_page_end; ++step) {
            s_dialog_revealed++;
            while (s_dialog_revealed < s_dialog_page_end &&
                   ((unsigned char)s_dialog_full[s_dialog_revealed] & 0xC0U) == 0x80U) {
                s_dialog_revealed++;
            }
        }
        char partial[UI_ACTOR_DIALOG_PAGE_MAX];
        size_t copy = s_dialog_revealed - s_dialog_page_start;
        memcpy(partial, &s_dialog_full[s_dialog_page_start], copy);
        partial[copy] = '\0';
        lv_label_set_text(s_dialog_label, partial);
    } else if (s_dialog_label != NULL && s_dialog_page_end < s_dialog_length) {
        if (++s_dialog_page_hold >= UI_ACTOR_DIALOG_PAGE_HOLD_TICKS) {
            s_dialog_page_start = s_dialog_page_end;
            s_dialog_page_end = ui_home_actor_dialog_page_end(s_dialog_page_start);
            s_dialog_revealed = s_dialog_page_start;
            s_dialog_page_hold = 0U;
            s_cursor_visible = false;
            if (s_dialog_cursor != NULL) {
                lv_obj_set_style_opa(s_dialog_cursor, LV_OPA_TRANSP, LV_PART_MAIN);
            }
            lv_label_set_text(s_dialog_label, "");
        }
    } else if (s_dialog_cursor != NULL && (tick % 4U) == 0U) {
        s_cursor_visible = !s_cursor_visible;
        lv_obj_set_style_opa(s_dialog_cursor,
                             s_cursor_visible ? LV_OPA_COVER : LV_OPA_TRANSP,
                             LV_PART_MAIN);
    }
    return true;
}

esp_err_t ui_home_actor_create(lv_obj_t *house)
{
    ESP_RETURN_ON_FALSE(house != NULL, ESP_ERR_INVALID_ARG, TAG, "null house");

    ui_home_actor_clear_deferred_animations();
    memset(s_seen_deferred_action_ids, 0, sizeof(s_seen_deferred_action_ids));
    s_seen_deferred_action_head = 0U;
    s_seen_deferred_action_count = 0U;
    world_service_snapshot_t snapshot = {0};
    world_service_get_snapshot(&snapshot);
    size_t snapshot_room = 0U;
    if (ui_home_actor_room_index(snapshot.room, &snapshot_room)) {
        s_room = snapshot_room;
        s_desired_activity = snapshot.activity;
        s_desired_tone = snapshot.speech_tone;
        s_facing = snapshot.character_facing;
        s_object_pose = snapshot.character_pose;
        s_active_animation = snapshot.active_animation;
        snprintf(s_target_object_id, sizeof(s_target_object_id), "%s",
                 snapshot.target_object_id);
    }

    if (!ui_home_actor_object_target(&snapshot, s_room, &s_pos)) {
        s_pos.x = ui_home_actor_room_stand_x(s_room);
        s_pos.y = ui_home_actor_room_floor_y(s_room);
    }
    s_target = s_pos;
    /* Cat owns an independent firmware-local state. Never seed it from the
     * Human snapshot, even when the Human reconnects in another room. */
    s_pet_room = WORLD_ROOM_LIVING_ROOM;
    s_pet_target_room = WORLD_ROOM_LIVING_ROOM;
    s_pet_target_revision = 0U;
    s_pet_pos = ui_home_actor_pet_room_target(s_pet_room, s_pet_target_revision);
    s_pet_target = s_pet_pos;
    s_pet_has_waypoint = false;
    s_pet_moving = false;
    s_pet_idle_ticks_remaining = UI_ACTOR_PET_IDLE_TICKS;

    /* A hard-edged shadow, not a soft one: soft shadows fight the pixel grid. */
    s_actor_shadow = lv_obj_create(house);
    ESP_RETURN_ON_FALSE(s_actor_shadow != NULL, ESP_ERR_NO_MEM, TAG, "shadow alloc failed");
    lv_obj_set_size(s_actor_shadow, UI_PX(UI_ACTOR_ART_W), UI_PX(1));
    lv_obj_set_style_bg_color(s_actor_shadow, lv_color_hex(UI_PAL_SHADOW), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_actor_shadow, LV_OPA_50, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_actor_shadow, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s_actor_shadow, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_actor_shadow, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    /* Created after the rooms and the shell so it draws over the furniture. */
    s_actor = ui_pixel_fx_sprite(house, &actor_idle_0, s_pos.x, s_pos.y);
    ESP_RETURN_ON_FALSE(s_actor != NULL, ESP_ERR_NO_MEM, TAG, "actor alloc failed");

    s_pet = ui_pixel_fx_sprite(house, &pet_idle_0, s_pet_pos.x, s_pet_pos.y);
    ESP_RETURN_ON_FALSE(s_pet != NULL, ESP_ERR_NO_MEM, TAG, "pet alloc failed");

    ui_home_actor_place();
    ui_home_actor_set_render_state(
        ui_home_actor_desired_rest_state(snapshot.speech_tone));
    ESP_RETURN_ON_ERROR(ui_pixel_fx_register(ui_home_actor_tick, NULL, 1, 0), TAG,
                        "actor tick registration failed");
    return ESP_OK;
}

static void ui_home_actor_go_to_target(size_t room_index, ui_actor_point_t target)
{
    const ui_home_room_def_t *def = ui_home_room_def(room_index);
    if (def == NULL || s_actor == NULL) {
        return;
    }
    if (room_index == s_room && target.x == s_pos.x && target.y == s_pos.y) {
        return;
    }

    s_room = room_index;
    s_target = target;

    /* Crossing storeys routes through the stair run so the actor never walks
     * through the floor slab. */
    if (s_target.y != s_pos.y) {
        s_waypoint.x = UI_ACTOR_STAIR_X;
        s_waypoint.y = s_target.y;
        s_has_waypoint = true;
    } else {
        s_has_waypoint = false;
    }
    s_state = UI_ACTOR_RENDER_WALK;
    if (s_target_object_id[0] != '\0') {
        const size_t frames_per_direction = ACTOR_OBJECT_WALK_FRAME_COUNT / 2U;
        ui_home_actor_set_pose(
            s_object_walk_frames[ui_home_actor_direction_offset(frames_per_direction)]);
    } else {
        ui_home_actor_set_pose(s_walk_frames[0]);
    }
    ESP_LOGI(TAG, "actor heading to %s", def->title);
}

static void ui_home_actor_go_to_room(size_t room_index)
{
    ui_actor_point_t target = {
        .x = ui_home_actor_room_stand_x(room_index),
        .y = ui_home_actor_room_floor_y(room_index),
    };
    ui_home_actor_go_to_target(room_index, target);
}

static void ui_home_actor_set_render_state(ui_actor_render_state_t state)
{
    if (s_actor == NULL || s_state == state) {
        return;
    }
    s_state = state;
    s_idle_frame = 0;
    switch (state) {
    case UI_ACTOR_RENDER_OBJECT_SIT:
        ui_home_actor_set_pose(
            s_sit_frames[ui_home_actor_direction_offset(ACTOR_SIT_FRAME_COUNT / 2U)]);
        break;
    case UI_ACTOR_RENDER_OBJECT_LOOK:
        ui_home_actor_set_pose(
            s_look_frames[ui_home_actor_direction_offset(ACTOR_LOOK_FRAME_COUNT / 2U)]);
        break;
    case UI_ACTOR_RENDER_OBJECT_PAW:
        ui_home_actor_set_pose(
            s_paw_frames[ui_home_actor_direction_offset(ACTOR_PAW_FRAME_COUNT / 2U)]);
        break;
    case UI_ACTOR_RENDER_OBJECT_IDLE:
        ui_home_actor_set_pose(
            s_object_idle_frames[ui_home_actor_direction_offset(1U)]);
        break;
    case UI_ACTOR_RENDER_SLEEP:
    case UI_ACTOR_RENDER_DOZE:
        ui_home_actor_set_pose(s_sleep_frames[0]);
        break;
    case UI_ACTOR_RENDER_WALK:
        ui_home_actor_set_pose(s_walk_frames[0]);
        break;
    case UI_ACTOR_RENDER_IDLE:
    default:
        ui_home_actor_set_pose(s_idle_frames[0]);
        break;
    }
}

void ui_home_actor_apply_snapshot(const world_service_snapshot_t *snapshot)
{
    size_t room_index = 0U;
    if (snapshot == NULL || s_actor == NULL ||
        !ui_home_actor_room_index(snapshot->room, &room_index)) {
        return;
    }
    char previous_target[sizeof(s_target_object_id)];
    snprintf(previous_target, sizeof(previous_target), "%s", s_target_object_id);
    world_character_pose_t previous_pose = s_object_pose;
    world_object_animation_t previous_animation = s_active_animation;
    world_object_facing_t previous_facing = s_facing;
    bool target_changed = strcmp(previous_target, snapshot->target_object_id) != 0;
    if (ui_home_actor_snapshot_starts_movement(snapshot) || target_changed) {
        /* A newer movement/target invalidates visual work queued for the old
         * location. The authoritative snapshot below supplies the new route. */
        ui_home_actor_clear_deferred_animations();
    }
    s_desired_activity = snapshot->activity;
    s_desired_tone = snapshot->speech_tone;
    s_facing = snapshot->character_facing;
    s_object_pose = snapshot->character_pose;
    world_object_animation_t incoming_animation = snapshot->active_animation;
    if (s_state == UI_ACTOR_RENDER_WALK &&
        ui_home_actor_is_deferred_animation(incoming_animation)) {
        /* Device actions can complete faster than a cross-room walk. Preserve
         * their order locally and render them only after the target is reached. */
        ui_home_actor_queue_deferred_animation(snapshot->active_action_id,
                                                snapshot->target_object_id,
                                                incoming_animation);
    } else if (!s_deferred_animation_playing) {
        s_active_animation = incoming_animation;
    }
    snprintf(s_target_object_id, sizeof(s_target_object_id), "%s",
             snapshot->target_object_id);
    ui_actor_point_t object_target = {0};
    if (ui_home_actor_object_target(snapshot, room_index, &object_target)) {
        if (object_target.x != s_pos.x || object_target.y != s_pos.y ||
            room_index != s_room) {
            ui_home_actor_go_to_target(room_index, object_target);
        } else if (s_state != UI_ACTOR_RENDER_WALK) {
            ui_home_actor_set_render_state(
                ui_home_actor_desired_rest_state(snapshot->speech_tone));
        }
    } else if (room_index != s_room) {
        ui_home_actor_go_to_room(room_index);
    } else if (s_state != UI_ACTOR_RENDER_WALK) {
        ui_home_actor_set_render_state(
            ui_home_actor_desired_rest_state(snapshot->speech_tone));
    }
    if (snapshot->speech_revision != 0U && snapshot->speech_revision != s_speech_revision) {
        uint32_t accent = UI_PAL_ACCENT_CYAN;
        switch (snapshot->speech_tone) {
        case WORLD_SPEECH_TONE_MUTED:
            accent = UI_PAL_MUTED;
            break;
        case WORLD_SPEECH_TONE_SLEEP:
            accent = UI_PAL_ACCENT_VIOLET;
            break;
        case WORLD_SPEECH_TONE_COOL:
            accent = UI_PAL_COOL_LIGHT;
            break;
        case WORLD_SPEECH_TONE_BRIGHT:
            accent = UI_PAL_LAMP_HI;
            break;
        case WORLD_SPEECH_TONE_DEFAULT:
        default:
            break;
        }
        ui_home_actor_say(snapshot->speech_text, accent, true);
        s_dialog_is_conversation = false;
        s_speech_revision = snapshot->speech_revision;
    }
    if (snapshot->target_object_id[0] != '\0' &&
        (strcmp(previous_target, snapshot->target_object_id) != 0 ||
         previous_pose != snapshot->character_pose ||
         previous_animation != snapshot->active_animation ||
         previous_facing != snapshot->character_facing)) {
        ESP_LOGW(TAG,
                 "VERIFY:phase3d:ui_object_state:PASS target=%s facing=%s pose=%s animation=%s anchor_x=%d floor_y=%d",
                 snapshot->target_object_id,
                 snapshot->character_facing == WORLD_OBJECT_FACING_LEFT ? "left" : "right",
                 world_service_pose_text(snapshot->character_pose),
                 world_object_animation_text(snapshot->active_animation),
                 (int)s_target.x, (int)(s_target.y + UI_ACTOR_ART_H));
    } else if (!snapshot->agent_connected && previous_target[0] != '\0' &&
               snapshot->target_object_id[0] == '\0') {
        ESP_LOGW(TAG,
                 "VERIFY:phase3d:ui_agent_offline:PASS released_target=%s fallback_room=%s",
                 previous_target, world_service_room_text(snapshot->room));
    }
}

void ui_home_actor_apply_conversation(const conversation_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }
    if (snapshot->local_stage != CONVERSATION_LOCAL_STAGE_IDLE) {
        if (snapshot->local_revision == s_local_conversation_revision) return;
        const char *text = "请说话…";
        if (snapshot->local_stage == CONVERSATION_LOCAL_STAGE_CONNECTING) {
            text = "正在连接，请稍后…";
        } else if (snapshot->local_stage == CONVERSATION_LOCAL_STAGE_PROMPTING) {
            text = "在呢，请说话…";
        } else if (snapshot->local_stage == CONVERSATION_LOCAL_STAGE_TRANSCRIBING) {
            text = "正在识别…";
        }
        ui_home_actor_say(text, UI_PAL_ACCENT_VIOLET, false);
        s_dialog_is_conversation = true;
        s_local_conversation_revision = snapshot->local_revision;
        ESP_LOGW(TAG, "VERIFY:voice:ui_local:PASS stage=%s",
                 conversation_service_local_stage_text(snapshot->local_stage));
        return;
    }
    if (!snapshot->available) return;
    const conversation_update_t *update = &snapshot->update;
    if (s_dialog_is_conversation && update->epoch == s_conversation_epoch &&
        update->revision == s_conversation_revision) {
        return;
    }

    const char *role = "结果";
    uint32_t accent = UI_PAL_ACCENT_CYAN;
    switch (update->response_role) {
    case CONVERSATION_ROLE_HUMAN:
        role = "Human";
        accent = UI_PAL_ACCENT_VIOLET;
        break;
    case CONVERSATION_ROLE_ROBOT:
        role = "Robot";
        accent = UI_PAL_LAMP_HI;
        break;
    case CONVERSATION_ROLE_MIXED:
        role = "Human + Robot";
        accent = UI_PAL_COOL_LIGHT;
        break;
    case CONVERSATION_ROLE_SYSTEM:
        role = "系统";
        accent = UI_PAL_MUTED;
        break;
    case CONVERSATION_ROLE_NONE:
    default:
        break;
    }

    switch (update->stage) {
    case CONVERSATION_STAGE_LISTENING:
        snprintf(s_conversation_dialog, sizeof(s_conversation_dialog), "正在聆听…");
        break;
    case CONVERSATION_STAGE_TRANSCRIBING:
        snprintf(s_conversation_dialog, sizeof(s_conversation_dialog),
                 update->user_text[0] == '\0' ? "正在识别…" : "你：%s\n正在识别…",
                 update->user_text);
        break;
    case CONVERSATION_STAGE_THINKING:
        snprintf(s_conversation_dialog, sizeof(s_conversation_dialog),
                 "你：%s\n正在思考…", update->user_text);
        break;
    case CONVERSATION_STAGE_COMPLETED:
        snprintf(s_conversation_dialog, sizeof(s_conversation_dialog),
                 "你：%s\n%s：%s", update->user_text, role, update->response_text);
        break;
    case CONVERSATION_STAGE_FAILED:
    case CONVERSATION_STAGE_CANCELLED:
        snprintf(s_conversation_dialog, sizeof(s_conversation_dialog),
                 "%s：%s", role, update->response_text);
        break;
    default:
        return;
    }

    ui_home_actor_say(s_conversation_dialog, accent, false);
    s_dialog_is_conversation = true;
    s_conversation_epoch = update->epoch;
    s_conversation_revision = update->revision;
    ESP_LOGW(TAG,
             "VERIFY:phase5e:ui_conversation:PASS epoch=%lu revision=%lu stage=%s role=%s execution=%s",
             (unsigned long)update->epoch, (unsigned long)update->revision,
             conversation_service_stage_text(update->stage),
             conversation_service_role_text(update->response_role),
             conversation_service_execution_text(update->execution_status));
    if (conversation_service_mark_rendered(update) != ESP_OK) {
        ESP_LOGW(TAG, "conversation render acknowledgement rejected");
    }
}

void ui_home_actor_get_render_snapshot(ui_home_actor_render_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }
    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->art_x = s_pos.x;
    snapshot->floor_y = (int16_t)(s_pos.y + UI_ACTOR_ART_H);
    snapshot->facing = s_facing;
    snapshot->pose = s_object_pose;
    snapshot->animation = s_state == UI_ACTOR_RENDER_WALK
                              ? WORLD_OBJECT_ANIMATION_CAT_WALK
                              : s_state == UI_ACTOR_RENDER_OBJECT_SIT
                                    ? WORLD_OBJECT_ANIMATION_CAT_SIT
                                    : s_state == UI_ACTOR_RENDER_OBJECT_LOOK
                                          ? WORLD_OBJECT_ANIMATION_CAT_LOOK
                                          : s_state == UI_ACTOR_RENDER_OBJECT_PAW
                                                ? WORLD_OBJECT_ANIMATION_CAT_PAW
                                                : WORLD_OBJECT_ANIMATION_NONE;
    snapshot->moving = s_state == UI_ACTOR_RENDER_WALK;
    snprintf(snapshot->target_object_id, sizeof(snapshot->target_object_id), "%s",
             s_target_object_id);
    snapshot->pet_art_x = s_pet_pos.x;
    snapshot->pet_floor_y = (int16_t)(s_pet_pos.y + UI_ACTOR_PET_ART_H);
    snapshot->pet_target_art_x = s_pet_target.x;
    snapshot->pet_target_floor_y = (int16_t)(s_pet_target.y + UI_ACTOR_PET_ART_H);
    snapshot->pet_room = s_pet_room;
    snapshot->pet_target_room = s_pet_target_room;
    snapshot->pet_ticks_until_target = s_pet_idle_ticks_remaining;
    snapshot->pet_target_revision = s_pet_target_revision;
    snapshot->pet_moving = s_pet_moving;
}

esp_err_t ui_home_actor_create_dialog(lv_obj_t *parent, int32_t art_w, int32_t art_h)
{
    ESP_RETURN_ON_FALSE(parent != NULL, ESP_ERR_INVALID_ARG, TAG, "null dialog parent");

    s_dialog_panel = lv_obj_create(parent);
    ESP_RETURN_ON_FALSE(s_dialog_panel != NULL, ESP_ERR_NO_MEM, TAG, "dialog alloc failed");
    lv_obj_set_size(s_dialog_panel, UI_PX(art_w), UI_PX(art_h));
    lv_obj_set_style_bg_color(s_dialog_panel, lv_color_hex(UI_PAL_PANEL), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_dialog_panel, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_dialog_panel, UI_PX(1), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_dialog_panel, lv_color_hex(UI_PAL_ACCENT_CYAN),
                                  LV_PART_MAIN);
    lv_obj_set_style_radius(s_dialog_panel, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_dialog_panel, UI_PX(2), LV_PART_MAIN);
    lv_obj_clear_flag(s_dialog_panel, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    s_dialog_label = lv_label_create(s_dialog_panel);
    ESP_RETURN_ON_FALSE(s_dialog_label != NULL, ESP_ERR_NO_MEM, TAG,
                        "dialog label alloc failed");
    lv_label_set_long_mode(s_dialog_label, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(s_dialog_label, UI_PX(art_w) - UI_PX(6));
    lv_obj_set_style_text_font(s_dialog_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_dialog_label, lv_color_hex(UI_PAL_INK), LV_PART_MAIN);
    lv_label_set_text(s_dialog_label, "");
    lv_obj_set_pos(s_dialog_label, 0, 0);

    /* The blinking JRPG "continue" caret. Built from two blocks rather than
     * LV_SYMBOL_DOWN: the symbols live in the Montserrat fallback, not in the
     * pixel font, so a glyph here renders as a tofu box - and a hand-placed
     * two-step wedge is the correct shape on a 4 px grid anyway. */
    s_dialog_cursor = lv_obj_create(s_dialog_panel);
    ESP_RETURN_ON_FALSE(s_dialog_cursor != NULL, ESP_ERR_NO_MEM, TAG,
                        "dialog cursor alloc failed");
    lv_obj_set_size(s_dialog_cursor, UI_PX(4), UI_PX(2));
    lv_obj_set_style_bg_opa(s_dialog_cursor, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_dialog_cursor, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_dialog_cursor, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_dialog_cursor, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(s_dialog_cursor, LV_ALIGN_BOTTOM_RIGHT, 0, 0);

    static const struct {
        int32_t x;
        int32_t w;
        int32_t y;
    } caret_rows[] = {{0, 4, 0}, {1, 2, 1}};
    for (size_t i = 0; i < sizeof(caret_rows) / sizeof(caret_rows[0]); ++i) {
        lv_obj_t *row = lv_obj_create(s_dialog_cursor);
        ESP_RETURN_ON_FALSE(row != NULL, ESP_ERR_NO_MEM, TAG, "caret row alloc failed");
        lv_obj_set_size(row, UI_PX(caret_rows[i].w), UI_PX(1));
        lv_obj_set_pos(row, UI_PX(caret_rows[i].x), UI_PX(caret_rows[i].y));
        lv_obj_set_style_bg_color(row, lv_color_hex(UI_PAL_ACCENT_CYAN), LV_PART_MAIN);
        lv_obj_set_style_bg_opa(row, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_border_width(row, 0, LV_PART_MAIN);
        lv_obj_set_style_radius(row, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(row, 0, LV_PART_MAIN);
        lv_obj_clear_flag(row, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    }
    return ESP_OK;
}

static void ui_home_actor_say(const char *text, uint32_t accent, bool log_text)
{
    if (text == NULL || s_dialog_label == NULL) {
        return;
    }
    size_t length = strlen(text);
    size_t copy = length < sizeof(s_dialog_full) ? length : sizeof(s_dialog_full) - 1U;
    if (copy < length) {
        while (copy > 0U && ((unsigned char)text[copy] & 0xC0U) == 0x80U) {
            copy--;
        }
    }
    memcpy(s_dialog_full, text, copy);
    s_dialog_full[copy] = '\0';
    s_dialog_length = copy;
    s_dialog_page_start = 0U;
    s_dialog_page_end = ui_home_actor_dialog_page_end(0U);
    s_dialog_revealed = 0U;
    s_dialog_page_hold = 0U;
    s_cursor_visible = false;
    lv_label_set_text(s_dialog_label, "");
    if (s_dialog_panel != NULL) {
        lv_obj_set_style_border_color(s_dialog_panel, lv_color_hex(accent), LV_PART_MAIN);
    }
    if (s_dialog_cursor != NULL) {
        lv_obj_set_style_opa(s_dialog_cursor, LV_OPA_TRANSP, LV_PART_MAIN);
        uint32_t count = lv_obj_get_child_count(s_dialog_cursor);
        for (uint32_t i = 0; i < count; ++i) {
            lv_obj_set_style_bg_color(lv_obj_get_child(s_dialog_cursor, i),
                                      lv_color_hex(accent), LV_PART_MAIN);
        }
    }
    if (log_text) {
        ESP_LOGI(TAG, "say: %s", s_dialog_full);
    } else {
        ESP_LOGI(TAG, "voice dialog updated bytes=%u", (unsigned)s_dialog_length);
    }
}
