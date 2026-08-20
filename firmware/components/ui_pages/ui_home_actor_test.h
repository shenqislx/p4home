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
    char target_object_id[WORLD_OBJECT_ID_MAX_BYTES + 1U];
} ui_home_actor_render_snapshot_t;

void ui_home_actor_get_render_snapshot(ui_home_actor_render_snapshot_t *snapshot);
