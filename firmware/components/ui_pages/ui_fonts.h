#pragma once

#include "lvgl.h"

LV_FONT_DECLARE(ui_font_source_han_sans_sc_16);

static inline const lv_font_t *ui_pages_text_font(void)
{
    return &ui_font_source_han_sans_sc_16;
}

static inline const lv_font_t *ui_pages_weather_font(void)
{
    return ui_pages_text_font();
}
