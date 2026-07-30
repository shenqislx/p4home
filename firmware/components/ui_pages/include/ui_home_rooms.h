#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "lvgl.h"
#include "panel_data_store.h"

/* The six rooms of the cutaway house, and the aggregation of Home Assistant
 * entities onto them.
 *
 * The previous top-down floor plan only surfaced 8 of the 12 groups in
 * panel_entities.json. A two-storey, three-bay cutaway has room for all of
 * them, and unlike a floor plan it has a horizon, which is what makes the sky,
 * weather and window-light effects possible at all. */

#define UI_HOME_ROOM_COUNT 6U
#define UI_HOME_ROOM_MAX_GROUPS 3U

/* House interior geometry in art pixels (1 art px = UI_PX(1) device px). */
#define UI_HOME_HOUSE_ART_W 176
#define UI_HOME_HOUSE_ART_H 90
#define UI_HOME_ROOM_ART_W 56
#define UI_HOME_ROOM_ART_H 34
#define UI_HOME_ROOF_ART_H 14
#define UI_HOME_SLAB_ART_Y 48
#define UI_HOME_UPPER_ART_Y 14
#define UI_HOME_LOWER_ART_Y 52
#define UI_HOME_FOUNDATION_ART_Y 86
/* Stair run in the centre bay, ascending to the right against the bay wall. */
#define UI_HOME_STAIR_ART_X 100

typedef struct {
    const char *title;
    const char *groups[UI_HOME_ROOM_MAX_GROUPS];
    uint8_t bay;   /* 0..2 left to right */
    uint8_t level; /* 0 = upper, 1 = lower */
    uint32_t accent;
    const lv_image_dsc_t *art;
    /* Lamp anchor inside the room, in art pixels relative to the room origin.
     * The light cone and the light-on sparkle both hang off this point. */
    int16_t lamp_art_x;
    int16_t lamp_art_y;
    /* Where the actor stands when it walks to this room. */
    int16_t stand_art_x;
    /* Optional palette-cycled patch over a screen, hob or water surface in the
     * baked room art. Zero width means the room has none. Palette cycling costs
     * one small colour write per tick and is the cheapest effect available. */
    int16_t glow_art_x;
    int16_t glow_art_y;
    int16_t glow_art_w;
    int16_t glow_art_h;
    uint8_t glow_kind; /* ui_fx_cycle_kind_t */
} ui_home_room_def_t;

typedef struct {
    size_t light_total;
    size_t light_online;
    size_t light_on;
    size_t climate_total;
    size_t climate_on;
    double temperature_sum;
    size_t temperature_count;
    size_t offline_count;
} ui_home_room_state_t;

typedef struct {
    size_t entities;
    size_t online;
    size_t lights_on;
    size_t lights_total;
    size_t climates_on;
} ui_home_summary_t;

const ui_home_room_def_t *ui_home_room_def(size_t index);

/* Art-pixel origin of a room's interior within the house. */
void ui_home_room_origin(size_t index, int32_t *out_art_x, int32_t *out_art_y);

/* Builds the shell (walls, floor slab, roof, foundation) plus the six rooms.
 * `house` must be UI_PX(UI_HOME_HOUSE_ART_W) x UI_PX(UI_HOME_HOUSE_ART_H). */
esp_err_t ui_home_rooms_create(lv_obj_t *house, lv_event_cb_t room_click_cb);

void ui_home_rooms_reset_aggregates(void);

/* Folds one entity into whichever rooms claim its group, and into the summary. */
void ui_home_rooms_collect(const panel_sensor_t *sensor, ui_home_summary_t *summary);

const ui_home_room_state_t *ui_home_room_state(size_t index);

/* How a room looks with its own lamp off. Driven by the sky phase: at midday
 * daylight through the windows is enough to read the furniture clearly, at night
 * an unlit room is nearly black. This is what makes the interior track the time
 * of day instead of looking permanently nocturnal. */
typedef struct {
    lv_opa_t unlit_art_opa;
    uint32_t unlit_wall_colour;
} ui_home_ambient_t;

void ui_home_rooms_set_ambient(const ui_home_ambient_t *ambient);

/* Pushes the aggregated state onto the widgets: light cones, lamp glow, offline
 * hatching, labels. Uses the ambient set by ui_home_rooms_set_ambient(). */
void ui_home_rooms_apply(size_t index);

/* Blends the exterior surfaces (roof, outer walls, foundation) `opa` of the way
 * towards `colour`, so the house tracks the sky instead of staying at midday
 * brightness after dark. Cheap: a style write per surface, only on a phase
 * change. */
void ui_home_rooms_set_shell_tint(uint32_t colour, lv_opa_t opa);

bool ui_home_room_is_lit(size_t index);
bool ui_home_room_has_climate_on(size_t index);
bool ui_home_room_has_data(size_t index);

/* Objects the effect layer needs to hang animations on. */
lv_obj_t *ui_home_room_container(size_t index);
lv_obj_t *ui_home_room_light_cone(size_t index);
