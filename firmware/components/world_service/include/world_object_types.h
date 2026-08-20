#pragma once

#include <stdint.h>

#define WORLD_OBJECT_ID_MAX_BYTES 64U
#define WORLD_OBJECT_ROOM_ART_X_MAX 48
#define WORLD_OBJECT_ROOM_FLOOR_Y_MAX 34

typedef enum {
    WORLD_OBJECT_ACTION_GO_TO = 0,
    WORLD_OBJECT_ACTION_SIT,
    WORLD_OBJECT_ACTION_LOOK_AT,
    WORLD_OBJECT_ACTION_INTERACT,
    WORLD_OBJECT_ACTION_COUNT,
} world_object_action_t;

#define WORLD_OBJECT_ACTION_MASK(action) (1U << (unsigned)(action))

typedef enum {
    WORLD_OBJECT_FACING_LEFT = 0,
    WORLD_OBJECT_FACING_RIGHT,
} world_object_facing_t;

typedef enum {
    WORLD_OBJECT_ANIMATION_NONE = 0,
    WORLD_OBJECT_ANIMATION_CAT_WALK,
    WORLD_OBJECT_ANIMATION_CAT_SIT,
    WORLD_OBJECT_ANIMATION_CAT_LOOK,
    WORLD_OBJECT_ANIMATION_CAT_PAW,
} world_object_animation_t;

typedef enum {
    WORLD_CHARACTER_POSE_STANDING = 0,
    WORLD_CHARACTER_POSE_SITTING,
} world_character_pose_t;
