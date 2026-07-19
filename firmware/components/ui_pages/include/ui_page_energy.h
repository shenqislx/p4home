#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "lvgl.h"

esp_err_t ui_page_energy_init(void);
void ui_page_energy_show(void);
lv_obj_t *ui_page_energy_root(void);
bool ui_page_energy_ready(void);
