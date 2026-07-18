#pragma once

#include "lvgl.h"

LV_FONT_DECLARE(ui_font_source_han_sans_sc_16);
LV_FONT_DECLARE(ui_font_pixel_modes_48);
LV_FONT_DECLARE(ui_font_pixel_lights_32);

static inline const lv_font_t *ui_pages_text_font(void)
{
    return &ui_font_source_han_sans_sc_16;
}

static inline const lv_font_t *ui_pages_weather_font(void)
{
    return ui_pages_text_font();
}

static inline const lv_font_t *ui_pages_pixel_font(void)
{
    return &lv_font_unscii_16;
}

static inline const lv_font_t *ui_pages_mode_pixel_font(void)
{
    return &ui_font_pixel_modes_48;
}

static inline const lv_font_t *ui_pages_lights_pixel_font(void)
{
    return &ui_font_pixel_lights_32;
}
