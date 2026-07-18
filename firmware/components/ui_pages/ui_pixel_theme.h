#pragma once

#include <stdint.h>

#include "lvgl.h"

#define UI_PIXEL_COLOR_SCREEN 0x080c10
#define UI_PIXEL_COLOR_PANEL 0x101820
#define UI_PIXEL_COLOR_PANEL_ALT 0x151f29
#define UI_PIXEL_COLOR_INK 0xe8f0f2
#define UI_PIXEL_COLOR_MUTED 0x8fa3ad
#define UI_PIXEL_COLOR_GRID 0x29404b
#define UI_PIXEL_COLOR_CYAN 0x35d0ba
#define UI_PIXEL_COLOR_BLUE 0x45a6ff
#define UI_PIXEL_COLOR_YELLOW 0xf3c64e
#define UI_PIXEL_COLOR_RED 0xe56b6f

static inline void ui_pixel_style_surface(lv_obj_t *obj, uint32_t background, uint32_t border)
{
    lv_obj_set_style_bg_color(obj, lv_color_hex(background), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_grad_dir(obj, LV_GRAD_DIR_NONE, LV_PART_MAIN);
    lv_obj_set_style_border_color(obj, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(obj, 2, LV_PART_MAIN);
    lv_obj_set_style_radius(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_outline_width(obj, 0, LV_PART_MAIN);
}

static inline void ui_pixel_style_card(lv_obj_t *obj, uint32_t background, uint32_t accent)
{
    ui_pixel_style_surface(obj, background, accent);
    lv_obj_set_style_shadow_width(obj, 8, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(obj, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_offset_x(obj, 4, LV_PART_MAIN);
    lv_obj_set_style_shadow_offset_y(obj, 4, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(obj, lv_color_hex(0x020405), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(obj, LV_OPA_60, LV_PART_MAIN);
    lv_obj_set_style_outline_width(obj, 1, LV_PART_MAIN);
    lv_obj_set_style_outline_pad(obj, 1, LV_PART_MAIN);
    lv_obj_set_style_outline_color(obj, lv_color_hex(accent), LV_PART_MAIN);
    lv_obj_set_style_outline_opa(obj, LV_OPA_30, LV_PART_MAIN);
}

static inline void ui_pixel_style_button(lv_obj_t *button, uint32_t background, uint32_t border)
{
    ui_pixel_style_surface(button, background, border);
    lv_obj_set_style_shadow_width(button, 5, LV_PART_MAIN);
    lv_obj_set_style_shadow_offset_x(button, 3, LV_PART_MAIN);
    lv_obj_set_style_shadow_offset_y(button, 3, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(button, lv_color_hex(0x020405), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(button, LV_OPA_60, LV_PART_MAIN);
    lv_obj_set_style_outline_width(button, 1, LV_PART_MAIN);
    lv_obj_set_style_outline_pad(button, 0, LV_PART_MAIN);
    lv_obj_set_style_outline_color(button, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_outline_opa(button, LV_OPA_30, LV_PART_MAIN);
    /* Keep press feedback inside the existing bounds. Translating a shadowed
     * object forces a large invalidation area and can visibly tear on the P4
     * display path when several buttons change state together. */
    lv_obj_set_style_bg_color(button, lv_color_hex(background),
                              LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_border_color(button, lv_color_hex(UI_PIXEL_COLOR_INK),
                                  LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_outline_color(button, lv_color_hex(UI_PIXEL_COLOR_INK),
                                   LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_outline_opa(button, LV_OPA_60, LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_translate_x(button, 0, LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_translate_y(button, 0, LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x11171d),
                              LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_set_style_border_color(button, lv_color_hex(0x26333a),
                                  LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_set_style_shadow_opa(button, LV_OPA_TRANSP, LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_set_style_outline_opa(button, LV_OPA_TRANSP, LV_PART_MAIN | LV_STATE_DISABLED);
}
