#include "ui_card_numeric.h"

#include <stdio.h>

#include "ui_fonts.h"

static const char *ui_card_numeric_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static const char *ui_card_numeric_status_text(const panel_sensor_t *sensor)
{
    if (!sensor->available) {
        return "offline";
    }
    if (sensor->freshness == PANEL_SENSOR_FRESHNESS_UNKNOWN) {
        return "loading";
    }
    if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        return "stale";
    }
    return "live";
}

static void ui_card_numeric_apply_visual(lv_obj_t *card, const panel_sensor_t *sensor)
{
    uint32_t color = 0x1f2a37;
    uint32_t border = 0x334155;
    if (!sensor->available) {
        color = 0x2f1f24;
        border = 0x7f1d1d;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_UNKNOWN) {
        color = 0x202632;
        border = 0x475569;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        color = 0x30291d;
        border = 0x854d0e;
    }
    lv_obj_set_style_bg_color(card, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, sensor->freshness == PANEL_SENSOR_FRESHNESS_FRESH && sensor->available ? 0 : 2,
                                  LV_PART_MAIN);
}

static void ui_card_numeric_set_labels(lv_obj_t *card, const panel_sensor_t *sensor)
{
    lv_obj_t *title = lv_obj_get_child(card, 0);
    lv_obj_t *value = lv_obj_get_child(card, 1);
    lv_obj_t *meta = lv_obj_get_child(card, 2);
    char value_text[48];
    char meta_text[48];
    lv_label_set_text(title, ui_card_numeric_safe_text(sensor->label, sensor->entity_id));
    if (sensor->unit[0] != '\0') {
        snprintf(value_text, sizeof(value_text), "%.1f %s", sensor->value_numeric, sensor->unit);
    } else {
        snprintf(value_text, sizeof(value_text), "%.1f", sensor->value_numeric);
    }
    snprintf(meta_text, sizeof(meta_text), "%s | %s",
             ui_card_numeric_safe_text(sensor->group, "default"),
             ui_card_numeric_status_text(sensor));
    lv_label_set_text(value, value_text);
    lv_label_set_text(meta, meta_text);
    ui_card_numeric_apply_visual(card, sensor);
}

static void ui_card_numeric_style_labels(lv_obj_t *title, lv_obj_t *value, lv_obj_t *meta)
{
    lv_obj_set_style_text_color(title, lv_color_hex(0xe5edf5), LV_PART_MAIN);
    lv_obj_set_style_text_color(value, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_style_text_color(meta, lv_color_hex(0xa8b3c2), LV_PART_MAIN);
    lv_obj_set_style_text_font(title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_font(value, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_font(meta, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_width(title, 248);
    lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(value, 248);
    lv_label_set_long_mode(value, LV_LABEL_LONG_DOT);
    lv_obj_set_width(meta, 248);
    lv_label_set_long_mode(meta, LV_LABEL_LONG_DOT);
}

lv_obj_t *ui_card_numeric_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_size(card, 280, 120);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x1f2a37), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 18, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(card);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_t *value = lv_label_create(card);
    lv_obj_align(value, LV_ALIGN_LEFT_MID, 0, 4);
    lv_obj_t *meta = lv_label_create(card);
    lv_obj_align(meta, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    ui_card_numeric_style_labels(title, value, meta);
    ui_card_numeric_set_labels(card, sensor);
    return card;
}

void ui_card_numeric_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_numeric_set_labels(card, sensor);
}
