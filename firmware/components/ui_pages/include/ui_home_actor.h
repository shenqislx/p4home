#pragma once

#include <stddef.h>

#include "esp_err.h"
#include "lvgl.h"
#include "world_service.h"

/* The pixel-house actor view and its companion. Semantic room/activity intent
 * belongs to world_service; this module only animates copied snapshots. */

/* `house` is the cutaway container; the actor is positioned in its art grid. */
esp_err_t ui_home_actor_create(lv_obj_t *house);

/* Render a copied world snapshot. This view never decides or exposes semantic
 * room/activity truth; it only animates toward the service-owned state. */
void ui_home_actor_apply_snapshot(const world_service_snapshot_t *snapshot);

/* --- HUD dialogue --------------------------------------------------------- */

esp_err_t ui_home_actor_create_dialog(lv_obj_t *parent, int32_t art_w, int32_t art_h);
