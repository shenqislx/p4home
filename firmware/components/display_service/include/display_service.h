#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

typedef enum {
    DISPLAY_SERVICE_PAGE_HOME = 0,
    DISPLAY_SERVICE_PAGE_SETTINGS = 1,
    DISPLAY_SERVICE_PAGE_GATEWAY = 2,
} display_service_page_t;

esp_err_t display_service_init(void);
bool display_service_is_ready(void);
lv_display_t *display_service_get_handle(void);
esp_err_t display_service_show_page(display_service_page_t page);
const char *display_service_current_page_text(void);
esp_err_t display_service_refresh_gateway_page(void);
esp_err_t display_service_set_touch_state(bool attached);
esp_err_t display_service_record_touch_sample(uint16_t x, uint16_t y, uint32_t click_count);
esp_err_t display_service_set_audio_state(bool speaker_ready, bool microphone_ready);
esp_err_t display_service_set_voice_state(const char *status_text, const char *metrics_text);
esp_err_t display_service_set_backlight_enabled(bool enabled);
bool display_service_backlight_enabled(void);
void display_service_log_summary(void);
