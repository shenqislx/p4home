#pragma once

/* Host shim for the BSP surface ui_pages.c uses. The simulator drives LVGL from
 * a single thread, so the display lock is a no-op that always succeeds. */

#include <stdbool.h>

#include "esp_err.h"

#define BSP_LCD_H_RES 1024
#define BSP_LCD_V_RES 600

static inline bool bsp_display_lock(unsigned timeout_ms)
{
    (void)timeout_ms;
    return true;
}

static inline void bsp_display_unlock(void) {}

static inline esp_err_t bsp_display_brightness_set(int percent)
{
    (void)percent;
    return ESP_OK;
}
