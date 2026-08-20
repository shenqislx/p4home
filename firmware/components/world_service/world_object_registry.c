#include "world_object_registry.h"

#include <string.h>

static const world_object_definition_t s_objects[WORLD_OBJECT_REGISTRY_CAPACITY] = {
    {
        .object_id = "living_room.sofa",
        .room = WORLD_ROOM_LIVING_ROOM,
        .anchor_art_x = 10,
        .anchor_floor_y = 32,
        .facing = WORLD_OBJECT_FACING_RIGHT,
        .supported_actions = WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_GO_TO) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_SIT) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_LOOK_AT) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_INTERACT),
        .default_available = true,
        .animation_bindings = {
            [WORLD_OBJECT_ACTION_GO_TO] = WORLD_OBJECT_ANIMATION_CAT_WALK,
            [WORLD_OBJECT_ACTION_SIT] = WORLD_OBJECT_ANIMATION_CAT_SIT,
            [WORLD_OBJECT_ACTION_LOOK_AT] = WORLD_OBJECT_ANIMATION_CAT_LOOK,
            [WORLD_OBJECT_ACTION_INTERACT] = WORLD_OBJECT_ANIMATION_CAT_PAW,
        },
    },
    {
        .object_id = "study.desk",
        .room = WORLD_ROOM_STUDY,
        .anchor_art_x = 34,
        .anchor_floor_y = 32,
        .facing = WORLD_OBJECT_FACING_LEFT,
        .supported_actions = WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_GO_TO) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_LOOK_AT) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_INTERACT),
        .default_available = true,
        .animation_bindings = {
            [WORLD_OBJECT_ACTION_GO_TO] = WORLD_OBJECT_ANIMATION_CAT_WALK,
            [WORLD_OBJECT_ACTION_LOOK_AT] = WORLD_OBJECT_ANIMATION_CAT_LOOK,
            [WORLD_OBJECT_ACTION_INTERACT] = WORLD_OBJECT_ANIMATION_CAT_PAW,
        },
    },
    {
        .object_id = "living_room.window",
        .room = WORLD_ROOM_LIVING_ROOM,
        .anchor_art_x = 40,
        .anchor_floor_y = 32,
        .facing = WORLD_OBJECT_FACING_LEFT,
        .supported_actions = WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_GO_TO) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_LOOK_AT) |
                             WORLD_OBJECT_ACTION_MASK(WORLD_OBJECT_ACTION_INTERACT),
        .default_available = true,
        .animation_bindings = {
            [WORLD_OBJECT_ACTION_GO_TO] = WORLD_OBJECT_ANIMATION_CAT_WALK,
            [WORLD_OBJECT_ACTION_LOOK_AT] = WORLD_OBJECT_ANIMATION_CAT_LOOK,
            [WORLD_OBJECT_ACTION_INTERACT] = WORLD_OBJECT_ANIMATION_CAT_PAW,
        },
    },
};

_Static_assert(sizeof(s_objects) / sizeof(s_objects[0]) == WORLD_OBJECT_REGISTRY_CAPACITY,
               "object registry capacity must match its definitions");

size_t world_object_registry_count(void)
{
    return sizeof(s_objects) / sizeof(s_objects[0]);
}

const world_object_definition_t *world_object_registry_at(size_t index)
{
    return index < world_object_registry_count() ? &s_objects[index] : NULL;
}

const world_object_definition_t *world_object_registry_find(const char *object_id)
{
    if (object_id == NULL) {
        return NULL;
    }
    for (size_t index = 0U; index < world_object_registry_count(); ++index) {
        if (strcmp(s_objects[index].object_id, object_id) == 0) {
            return &s_objects[index];
        }
    }
    return NULL;
}

bool world_object_supports_action(const world_object_definition_t *object,
                                  world_object_action_t action)
{
    return object != NULL && action >= WORLD_OBJECT_ACTION_GO_TO &&
           action < WORLD_OBJECT_ACTION_COUNT &&
           (object->supported_actions & WORLD_OBJECT_ACTION_MASK(action)) != 0U;
}

world_object_animation_t world_object_animation_for(const world_object_definition_t *object,
                                                     world_object_action_t action)
{
    if (!world_object_supports_action(object, action)) {
        return WORLD_OBJECT_ANIMATION_NONE;
    }
    return object->animation_bindings[action];
}

const char *world_object_action_text(world_object_action_t action)
{
    static const char *const names[WORLD_OBJECT_ACTION_COUNT] = {
        "go_to", "sit", "look_at", "interact",
    };
    return action >= WORLD_OBJECT_ACTION_GO_TO && action < WORLD_OBJECT_ACTION_COUNT
               ? names[action]
               : "unknown";
}

const char *world_object_animation_text(world_object_animation_t animation)
{
    static const char *const names[] = {
        "none", "cat_walk", "cat_sit", "cat_look", "cat_paw",
    };
    return animation >= WORLD_OBJECT_ANIMATION_NONE &&
                   animation <= WORLD_OBJECT_ANIMATION_CAT_PAW
               ? names[animation]
               : "unknown";
}
