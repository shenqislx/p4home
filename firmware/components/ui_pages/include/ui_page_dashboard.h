#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "lvgl.h"
#include "panel_data_store.h"

esp_err_t ui_page_dashboard_init(void);
void ui_page_dashboard_show(void);
void ui_page_dashboard_on_sensor_update(const panel_sensor_t *sensor);
lv_obj_t *ui_page_dashboard_root(void);
bool ui_page_dashboard_ready(void);
size_t ui_page_dashboard_card_count(void);
