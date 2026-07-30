#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "lvgl.h"

/* The inhabitant of the pixel house, plus its companion.
 *
 * The sense of life comes from intent, not from frame rate: the actor walks to
 * whichever room just had its lights turned on, goes to bed when the house goes
 * dark, and dozes off when Home Assistant is unreachable. At 8 FPS a deliberate
 * four-frame walk cycle reads far better than a smoothly interpolated slide. */

typedef enum {
    UI_ACTOR_STATE_IDLE = 0,
    UI_ACTOR_STATE_WALK,
    UI_ACTOR_STATE_SLEEP,
    UI_ACTOR_STATE_DOZE, /* offline: same pose as sleep, different dialogue */
} ui_actor_state_t;

/* `house` is the cutaway container; the actor is positioned in its art grid. */
esp_err_t ui_home_actor_create(lv_obj_t *house);

/* Ask the actor to head for a room. Ignored while asleep unless `force`. */
void ui_home_actor_go_to_room(size_t room_index, bool force);

void ui_home_actor_set_state(ui_actor_state_t state);
ui_actor_state_t ui_home_actor_state(void);
size_t ui_home_actor_room(void);

/* --- HUD dialogue --------------------------------------------------------- */

esp_err_t ui_home_actor_create_dialog(lv_obj_t *parent, int32_t art_w, int32_t art_h);

/* Starts the typewriter on a new line. Repeated calls with the same text are
 * ignored so a refresh storm does not restart the reveal. */
void ui_home_actor_say(const char *text, uint32_t accent);
