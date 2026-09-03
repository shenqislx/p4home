#pragma once

#include "world_service.h"

/* Simulator-only semantic view of the pixels selected by the renderer. This
 * deliberately stays outside include/ so production callers retain the
 * snapshot-only ui_home_actor public boundary. */
typedef struct {
    int16_t art_x;
    int16_t floor_y;
    world_object_facing_t facing;
    world_character_pose_t pose;
    world_object_animation_t animation;
    bool moving;
    bool sleeping;
    char target_object_id[WORLD_OBJECT_ID_MAX_BYTES + 1U];
    int16_t pet_art_x;
    int16_t pet_floor_y;
    int16_t pet_target_art_x;
    int16_t pet_target_floor_y;
    size_t pet_room;
    size_t pet_target_room;
    uint16_t pet_ticks_until_target;
    uint32_t pet_target_revision;
    bool pet_moving;
} ui_home_actor_render_snapshot_t;

void ui_home_actor_get_render_snapshot(ui_home_actor_render_snapshot_t *snapshot);
