#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "lvgl.h"
#include "panel_data_store.h"

esp_err_t ui_page_climate_init(void);
void ui_page_climate_show(void);
void ui_page_climate_on_sensor_update(const panel_sensor_t *sensor);
lv_obj_t *ui_page_climate_root(void);
bool ui_page_climate_ready(void);
size_t ui_page_climate_card_count(void);
