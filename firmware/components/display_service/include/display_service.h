#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "lvgl.h"

esp_err_t display_service_init(void);
bool display_service_is_ready(void);
lv_display_t *display_service_get_handle(void);
esp_err_t display_service_set_touch_state(bool attached);
esp_err_t display_service_record_touch_sample(uint16_t x, uint16_t y, uint32_t click_count);
void display_service_log_summary(void);
