#include "ui_card_weather.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ui_fonts.h"

typedef struct {
    lv_obj_t *title;
    lv_obj_t *current;
    lv_obj_t *today;
    lv_obj_t *tomorrow;
    lv_obj_t *meta;
} ui_card_weather_ctx_t;

static const char *ui_card_weather_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static const char *ui_card_weather_status_text(const panel_sensor_t *sensor)
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

static void ui_card_weather_copy_line(char *dst, size_t dst_len, const char *text, size_t line_index)
{
    if (dst == NULL || dst_len == 0U) {
        return;
    }
    dst[0] = '\0';
    if (text == NULL || text[0] == '\0') {
        snprintf(dst, dst_len, "--");
        return;
    }

    const char *start = text;
    for (size_t i = 0; i < line_index; ++i) {
        start = strchr(start, '\n');
        if (start == NULL) {
            snprintf(dst, dst_len, "--");
            return;
        }
        start++;
    }

    const char *end = strchr(start, '\n');
    size_t len = end != NULL ? (size_t)(end - start) : strlen(start);
    if (len >= dst_len) {
        len = dst_len - 1U;
    }
    memcpy(dst, start, len);
    dst[len] = '\0';
}

static void ui_card_weather_delete_cb(lv_event_t *event)
{
    free(lv_event_get_user_data(event));
}

static void ui_card_weather_style_label(lv_obj_t *label, lv_color_t color, int32_t width)
{
    lv_obj_set_width(label, width);
    lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(label, color, LV_PART_MAIN);
}

static void ui_card_weather_apply_visual(lv_obj_t *card, const panel_sensor_t *sensor)
{
    uint32_t grad = 0x1f2937;
    uint32_t border = 0xfacc15;
    lv_opa_t shadow = LV_OPA_30;
    if (!sensor->available) {
        grad = 0x331821;
        border = 0x7f1d1d;
        shadow = LV_OPA_10;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        grad = 0x33290d;
        border = 0x854d0e;
        shadow = LV_OPA_20;
    }

    lv_obj_set_style_bg_color(card, lv_color_hex(0x0f172a), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_color(card, lv_color_hex(grad), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_dir(card, LV_GRAD_DIR_HOR, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(card, 28, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(card, lv_color_hex(0xfacc15), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(card, shadow, LV_PART_MAIN);
}

lv_obj_t *ui_card_weather_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    ui_card_weather_ctx_t *ctx = calloc(1U, sizeof(*ctx));
    if (ctx == NULL) {
        return NULL;
    }

    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_user_data(card, ctx);
    lv_obj_add_event_cb(card, ui_card_weather_delete_cb, LV_EVENT_DELETE, ctx);
    lv_obj_set_size(card, 452, 180);
    lv_obj_set_style_radius(card, 16, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    ctx->title = lv_label_create(card);
    ui_card_weather_style_label(ctx->title, lv_color_hex(0xfff7d6), 190);
    lv_obj_align(ctx->title, LV_ALIGN_TOP_LEFT, 0, 0);

    ctx->current = lv_label_create(card);
    ui_card_weather_style_label(ctx->current, lv_color_white(), 404);
    lv_obj_align(ctx->current, LV_ALIGN_TOP_LEFT, 0, 36);

    ctx->today = lv_label_create(card);
    ui_card_weather_style_label(ctx->today, lv_color_hex(0xdbeafe), 404);
    lv_obj_align(ctx->today, LV_ALIGN_TOP_LEFT, 0, 76);

    ctx->tomorrow = lv_label_create(card);
    ui_card_weather_style_label(ctx->tomorrow, lv_color_hex(0xc4b5fd), 404);
    lv_obj_align(ctx->tomorrow, LV_ALIGN_TOP_LEFT, 0, 106);

    ctx->meta = lv_label_create(card);
    ui_card_weather_style_label(ctx->meta, lv_color_hex(0xa8b3c2), 404);
    lv_obj_align(ctx->meta, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    ui_card_weather_apply_locked(card, sensor);
    return card;
}

void ui_card_weather_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_weather_ctx_t *ctx = (ui_card_weather_ctx_t *)lv_obj_get_user_data(card);
    if (ctx == NULL || sensor == NULL) {
        return;
    }

    char title_text[64];
    char current_text[80];
    char today_text[64];
    char tomorrow_text[64];
    char meta_text[80];
    snprintf(title_text, sizeof(title_text), "%s / %s",
             ui_card_weather_safe_text(sensor->group, "室外"),
             ui_card_weather_safe_text(sensor->label, "天气"));
    ui_card_weather_copy_line(current_text, sizeof(current_text), sensor->value_text, 0);
    ui_card_weather_copy_line(today_text, sizeof(today_text), sensor->value_text, 1);
    ui_card_weather_copy_line(tomorrow_text, sizeof(tomorrow_text), sensor->value_text, 2);
    snprintf(meta_text, sizeof(meta_text), "weather | 今日明日 | %s", ui_card_weather_status_text(sensor));

    lv_label_set_text(ctx->title, title_text);
    lv_label_set_text(ctx->current, current_text);
    lv_label_set_text(ctx->today, today_text);
    lv_label_set_text(ctx->tomorrow, tomorrow_text);
    lv_label_set_text(ctx->meta, meta_text);
    ui_card_weather_apply_visual(card, sensor);
}
