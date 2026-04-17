#include "ui_card_multiline.h"

#include <stdio.h>

static const char *ui_card_multiline_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static void ui_card_multiline_set_labels(lv_obj_t *card, const panel_sensor_t *sensor)
{
    lv_obj_t *title = lv_obj_get_child(card, 0);
    lv_obj_t *value = lv_obj_get_child(card, 1);
    lv_obj_t *meta = lv_obj_get_child(card, 2);
    char meta_text[64];
    lv_label_set_text(title, ui_card_multiline_safe_text(sensor->label, sensor->entity_id));
    lv_label_set_text(value, ui_card_multiline_safe_text(sensor->value_text, "--"));
    snprintf(meta_text, sizeof(meta_text), "%s | %s",
             ui_card_multiline_safe_text(sensor->group, "default"),
             ui_card_multiline_safe_text(sensor->icon, "sensor"));
    lv_label_set_text(meta, meta_text);
}

lv_obj_t *ui_card_multiline_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_size(card, 280, 120);
    lv_obj_set_style_bg_color(card, lv_color_hex(0x24203a), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 18, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);
    lv_obj_t *title = lv_label_create(card);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_obj_t *value = lv_label_create(card);
    lv_obj_set_width(value, 248);
    lv_label_set_long_mode(value, LV_LABEL_LONG_WRAP);
    lv_obj_align(value, LV_ALIGN_TOP_LEFT, 0, 28);
    lv_obj_t *meta = lv_label_create(card);
    lv_obj_align(meta, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    ui_card_multiline_set_labels(card, sensor);
    return card;
}

void ui_card_multiline_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_multiline_set_labels(card, sensor);
}
