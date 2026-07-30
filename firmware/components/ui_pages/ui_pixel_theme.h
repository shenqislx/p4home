#pragma once

#include <stdint.h>

#include "lvgl.h"
#include "ui_pixel_palette.h"

/* Aliases onto the fixed palette in ui_pixel_palette.h, which is the single
 * source of truth (scripts/pixel_palette.py parses that header so the sprite
 * generator cannot drift from it). Kept as separate names so the other four
 * pages do not need touching. */
#define UI_PIXEL_COLOR_SCREEN UI_PAL_SCREEN
#define UI_PIXEL_COLOR_PANEL UI_PAL_PANEL
#define UI_PIXEL_COLOR_PANEL_ALT UI_PAL_PANEL_ALT
#define UI_PIXEL_COLOR_INK UI_PAL_INK
#define UI_PIXEL_COLOR_MUTED UI_PAL_MUTED
#define UI_PIXEL_COLOR_GRID UI_PAL_GRID
#define UI_PIXEL_COLOR_CYAN UI_PAL_ACCENT_CYAN
#define UI_PIXEL_COLOR_BLUE UI_PAL_COOL_LIGHT
#define UI_PIXEL_COLOR_YELLOW UI_PAL_LAMP_LIGHT
#define UI_PIXEL_COLOR_RED UI_PAL_FABRIC_LIGHT

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
    lv_obj_set_style_shadow_color(obj, lv_color_hex(UI_PAL_SHADOW), LV_PART_MAIN);
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
    lv_obj_set_style_shadow_color(button, lv_color_hex(UI_PAL_SHADOW), LV_PART_MAIN);
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
