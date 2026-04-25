#include "ui_card_trend.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sdkconfig.h"
#include "ui_fonts.h"

#define UI_CARD_TREND_POINTS CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS

typedef struct {
    lv_obj_t *title;
    lv_obj_t *value;
    lv_obj_t *meta;
    lv_obj_t *chart;
    lv_chart_series_t *series;
    int32_t values[UI_CARD_TREND_POINTS];
} ui_card_trend_ctx_t;

static const char *ui_card_trend_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static void ui_card_trend_copy_text(char *dst, size_t dst_len, const char *text)
{
    if (dst == NULL || dst_len == 0U) {
        return;
    }
    if (text == NULL) {
        text = "";
    }
    size_t len = strnlen(text, dst_len - 1U);
    memcpy(dst, text, len);
    dst[len] = '\0';
}

static void ui_card_trend_append_text(char *dst, size_t dst_len, const char *text)
{
    if (dst == NULL || dst_len == 0U) {
        return;
    }
    size_t used = strnlen(dst, dst_len);
    if (used >= dst_len - 1U) {
        dst[dst_len - 1U] = '\0';
        return;
    }
    ui_card_trend_copy_text(dst + used, dst_len - used, text);
}

static const char *ui_card_trend_status_text(const panel_sensor_t *sensor)
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

static lv_color_t ui_card_trend_accent(const panel_sensor_t *sensor)
{
    if (strcmp(sensor->icon, "thermometer") == 0) {
        return lv_color_hex(0x38bdf8);
    }
    if (strcmp(sensor->icon, "water") == 0 || strcmp(sensor->group, "水机") == 0) {
        return lv_color_hex(0x2dd4bf);
    }
    if (strcmp(sensor->icon, "battery") == 0) {
        return lv_color_hex(0xa3e635);
    }
    if (strcmp(sensor->icon, "weather") == 0) {
        return lv_color_hex(0xfacc15);
    }
    return lv_color_hex(0x60a5fa);
}

static void ui_card_trend_delete_cb(lv_event_t *event)
{
    free(lv_event_get_user_data(event));
}

static void ui_card_trend_apply_visual(lv_obj_t *card, const panel_sensor_t *sensor)
{
    uint32_t bg = 0x101827;
    uint32_t grad = 0x0f2a38;
    uint32_t border = 0x1d4ed8;
    if (strcmp(sensor->icon, "water") == 0 || strcmp(sensor->group, "水机") == 0) {
        grad = 0x0d342f;
        border = 0x0f766e;
    } else if (strcmp(sensor->icon, "battery") == 0) {
        grad = 0x26320f;
        border = 0x65a30d;
    } else if (strcmp(sensor->icon, "weather") == 0) {
        grad = 0x33290d;
        border = 0xca8a04;
    }
    if (!sensor->available) {
        grad = 0x331821;
        border = 0x7f1d1d;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        grad = 0x33290d;
        border = 0x854d0e;
    }

    lv_obj_set_style_bg_color(card, lv_color_hex(bg), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_color(card, lv_color_hex(grad), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_dir(card, LV_GRAD_DIR_VER, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(card, 24, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(card, ui_card_trend_accent(sensor), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(card, sensor->available ? LV_OPA_30 : LV_OPA_10, LV_PART_MAIN);
}

static void ui_card_trend_format_value(const panel_sensor_t *sensor, char *buffer, size_t buffer_len)
{
    if (sensor->kind == PANEL_SENSOR_KIND_TEXT) {
        ui_card_trend_copy_text(buffer, buffer_len, ui_card_trend_safe_text(sensor->value_text, "--"));
        return;
    }
    if (sensor->unit[0] != '\0') {
        snprintf(buffer, buffer_len, "%.1f %s", sensor->value_numeric, sensor->unit);
    } else {
        snprintf(buffer, buffer_len, "%.1f", sensor->value_numeric);
    }
}

static void ui_card_trend_apply_series(ui_card_trend_ctx_t *ctx, const panel_sensor_t *sensor)
{
    panel_sensor_sample_t samples[UI_CARD_TREND_POINTS];
    size_t count = panel_data_store_get_samples(sensor->entity_id, samples, UI_CARD_TREND_POINTS);
    if (count == 0U) {
        count = 1U;
        samples[0].value = sensor->value_numeric;
    }

    double min_value = samples[0].value;
    double max_value = samples[0].value;
    for (size_t i = 1U; i < count; ++i) {
        if (samples[i].value < min_value) {
            min_value = samples[i].value;
        }
        if (samples[i].value > max_value) {
            max_value = samples[i].value;
        }
    }

    double span = max_value - min_value;
    if (span < 1.0) {
        span = 1.0;
        min_value -= 0.5;
        max_value += 0.5;
    } else {
        double pad = span * 0.15;
        min_value -= pad;
        max_value += pad;
    }

    int32_t min_axis = (int32_t)floor(min_value * 10.0);
    int32_t max_axis = (int32_t)ceil(max_value * 10.0);
    if (min_axis == max_axis) {
        max_axis = min_axis + 10;
    }

    size_t fill = UI_CARD_TREND_POINTS - count;
    for (size_t i = 0U; i < fill; ++i) {
        ctx->values[i] = (int32_t)lround(samples[0].value * 10.0);
    }
    for (size_t i = 0U; i < count; ++i) {
        ctx->values[fill + i] = (int32_t)lround(samples[i].value * 10.0);
    }

    lv_chart_set_axis_range(ctx->chart, LV_CHART_AXIS_PRIMARY_Y, min_axis, max_axis);
    lv_chart_set_series_values(ctx->chart, ctx->series, ctx->values, UI_CARD_TREND_POINTS);
    lv_chart_refresh(ctx->chart);
}

lv_obj_t *ui_card_trend_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    ui_card_trend_ctx_t *ctx = calloc(1U, sizeof(*ctx));
    if (ctx == NULL) {
        return NULL;
    }

    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_user_data(card, ctx);
    lv_obj_add_event_cb(card, ui_card_trend_delete_cb, LV_EVENT_DELETE, ctx);
    lv_obj_set_size(card, 220, 180);
    lv_obj_set_style_radius(card, 16, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 14, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    ctx->title = lv_label_create(card);
    lv_obj_set_width(ctx->title, 118);
    lv_label_set_long_mode(ctx->title, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(ctx->title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->title, lv_color_hex(0xeaf2ff), LV_PART_MAIN);
    lv_obj_align(ctx->title, LV_ALIGN_TOP_LEFT, 0, 0);

    ctx->value = lv_label_create(card);
    lv_obj_set_width(ctx->value, 82);
    lv_label_set_long_mode(ctx->value, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(ctx->value, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->value, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(ctx->value, LV_ALIGN_TOP_RIGHT, 0, 0);

    ctx->chart = lv_chart_create(card);
    lv_obj_set_size(ctx->chart, 192, 92);
    lv_obj_align(ctx->chart, LV_ALIGN_TOP_LEFT, 0, 36);
    lv_chart_set_type(ctx->chart, LV_CHART_TYPE_LINE);
    lv_chart_set_point_count(ctx->chart, UI_CARD_TREND_POINTS);
    lv_chart_set_update_mode(ctx->chart, LV_CHART_UPDATE_MODE_SHIFT);
    lv_obj_set_style_bg_opa(ctx->chart, LV_OPA_10, LV_PART_MAIN);
    lv_obj_set_style_bg_color(ctx->chart, lv_color_hex(0x020617), LV_PART_MAIN);
    lv_obj_set_style_border_width(ctx->chart, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(ctx->chart, 10, LV_PART_MAIN);
    lv_obj_set_style_line_width(ctx->chart, 1, LV_PART_MAIN);
    lv_obj_set_style_line_color(ctx->chart, lv_color_hex(0x24415a), LV_PART_MAIN);
    lv_obj_set_style_line_width(ctx->chart, 3, LV_PART_ITEMS);
    lv_obj_set_style_size(ctx->chart, 0, 0, LV_PART_INDICATOR);
    ctx->series = lv_chart_add_series(ctx->chart, ui_card_trend_accent(sensor), LV_CHART_AXIS_PRIMARY_Y);

    ctx->meta = lv_label_create(card);
    lv_obj_set_width(ctx->meta, 192);
    lv_label_set_long_mode(ctx->meta, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(ctx->meta, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->meta, lv_color_hex(0x9fb4c8), LV_PART_MAIN);
    lv_obj_align(ctx->meta, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    ui_card_trend_apply_locked(card, sensor);
    return card;
}

void ui_card_trend_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_trend_ctx_t *ctx = (ui_card_trend_ctx_t *)lv_obj_get_user_data(card);
    if (ctx == NULL || sensor == NULL) {
        return;
    }

    char title_text[56];
    char value_text[80];
    char meta_text[80];
    ui_card_trend_copy_text(title_text, sizeof(title_text), ui_card_trend_safe_text(sensor->group, "位置"));
    ui_card_trend_append_text(title_text, sizeof(title_text), " / ");
    ui_card_trend_append_text(title_text, sizeof(title_text),
                              ui_card_trend_safe_text(sensor->label, sensor->entity_id));
    ui_card_trend_format_value(sensor, value_text, sizeof(value_text));
    snprintf(meta_text, sizeof(meta_text), "%s | 每小时 | %s",
             ui_card_trend_safe_text(sensor->icon, "sensor"),
             ui_card_trend_status_text(sensor));

    lv_label_set_text(ctx->title, title_text);
    lv_label_set_text(ctx->value, value_text);
    lv_label_set_text(ctx->meta, meta_text);
    lv_chart_set_series_color(ctx->chart, ctx->series, ui_card_trend_accent(sensor));
    ui_card_trend_apply_visual(card, sensor);
    ui_card_trend_apply_series(ctx, sensor);
}
