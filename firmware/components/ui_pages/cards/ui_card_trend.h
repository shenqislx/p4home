#pragma once

#include "lvgl.h"
#include "panel_data_store.h"

lv_obj_t *ui_card_trend_create(lv_obj_t *parent, const panel_sensor_t *sensor);
void ui_card_trend_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor);
