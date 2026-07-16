#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

typedef enum {
    UI_PAGES_PAGE_DASHBOARD = 0,
    UI_PAGES_PAGE_CLIMATE = 1,
    UI_PAGES_PAGE_QUICK_MODES = 2,
} ui_pages_page_t;

esp_err_t ui_pages_render_bootstrap(void);

void ui_pages_show_page_locked(ui_pages_page_t page);
ui_pages_page_t ui_pages_current_page(void);
const char *ui_pages_page_to_text(ui_pages_page_t page);
const char *ui_pages_current_page_text(void);
esp_err_t ui_pages_set_touch_state_locked(bool attached);

bool ui_pages_touch_attached(void);
bool ui_pages_backlight_enabled(void);
void ui_pages_set_backlight_enabled(bool enabled);
