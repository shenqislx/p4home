#pragma once

#include "lvgl.h"

static inline const lv_font_t *ui_pages_text_font(void)
{
#if LV_FONT_SOURCE_HAN_SANS_SC_16_CJK
    return &lv_font_source_han_sans_sc_16_cjk;
#else
    return LV_FONT_DEFAULT;
#endif
}
