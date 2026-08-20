#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "world_object_types.h"
#include "world_service.h"

#define WORLD_OBJECT_REGISTRY_CAPACITY 3U

typedef struct {
    const char *object_id;
    world_room_id_t room;
    int16_t anchor_art_x;
    int16_t anchor_floor_y;
    world_object_facing_t facing;
    uint32_t supported_actions;
    bool default_available;
    world_object_animation_t animation_bindings[WORLD_OBJECT_ACTION_COUNT];
} world_object_definition_t;

size_t world_object_registry_count(void);
const world_object_definition_t *world_object_registry_at(size_t index);
const world_object_definition_t *world_object_registry_find(const char *object_id);
bool world_object_supports_action(const world_object_definition_t *object,
                                  world_object_action_t action);
world_object_animation_t world_object_animation_for(const world_object_definition_t *object,
                                                     world_object_action_t action);
const char *world_object_action_text(world_object_action_t action);
const char *world_object_animation_text(world_object_animation_t animation);
