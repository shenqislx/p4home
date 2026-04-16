#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

/** Must match `display_service_page_t` numeric values. */
typedef enum {
    UI_PAGES_PAGE_HOME = 0,
    UI_PAGES_PAGE_SETTINGS = 1,
    UI_PAGES_PAGE_GATEWAY = 2,
} ui_pages_page_t;

esp_err_t ui_pages_render_bootstrap(void);

void ui_pages_show_page_locked(ui_pages_page_t page);
ui_pages_page_t ui_pages_current_page(void);
const char *ui_pages_page_to_text(ui_pages_page_t page);
const char *ui_pages_current_page_text(void);
bool ui_pages_audio_meter_running(void);

void ui_pages_refresh_gateway_locked(const char *status_text);
void ui_pages_refresh_settings_locked(const char *status_text);

esp_err_t ui_pages_update_meter_ui(const char *status_text,
                                   int meter_value,
                                   const char *metrics_text,
                                   bool meter_running);
esp_err_t ui_pages_update_audio_labels(const char *status_text, const char *metrics_text);
esp_err_t ui_pages_update_voice_labels(const char *status_text, const char *metrics_text);

esp_err_t ui_pages_set_touch_state_locked(bool attached);
esp_err_t ui_pages_record_touch_sample_locked(uint16_t x, uint16_t y, uint32_t click_count);

bool ui_pages_touch_attached(void);
bool ui_pages_backlight_enabled(void);
void ui_pages_set_backlight_enabled(bool enabled);
