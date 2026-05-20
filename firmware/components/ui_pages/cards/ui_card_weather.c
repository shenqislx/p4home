#include "ui_card_weather.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ui_fonts.h"

typedef struct {
    lv_obj_t *title;
    lv_obj_t *meta;
    lv_obj_t *today_panel;
    lv_obj_t *tomorrow_panel;
    lv_obj_t *today_icon;
    lv_obj_t *tomorrow_icon;
    lv_obj_t *today_icon_label;
    lv_obj_t *tomorrow_icon_label;
    lv_obj_t *today_condition;
    lv_obj_t *tomorrow_condition;
    lv_obj_t *today_temp;
    lv_obj_t *tomorrow_temp;
    lv_obj_t *today_rain;
    lv_obj_t *tomorrow_rain;
    lv_obj_t *today_air;
    lv_obj_t *tomorrow_air;
} ui_card_weather_ctx_t;

typedef struct {
    char title[16];
    char condition[20];
    char temp[128];
    char rain[128];
    char air[128];
} ui_card_weather_day_t;

static const char *ui_card_weather_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static const char *ui_card_weather_status_text(const panel_sensor_t *sensor)
{
    if (!sensor->available) {
        return "Offline";
    }
    if (sensor->freshness == PANEL_SENSOR_FRESHNESS_UNKNOWN) {
        return "Loading";
    }
    if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        return "Stale";
    }
    return "Online";
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

static void ui_card_weather_copy_field(char *dst, size_t dst_len, const char *line, size_t field_index)
{
    if (dst == NULL || dst_len == 0U) {
        return;
    }
    dst[0] = '\0';
    if (line == NULL || line[0] == '\0') {
        snprintf(dst, dst_len, "--");
        return;
    }

    const char *start = line;
    for (size_t i = 0; i < field_index; ++i) {
        start = strchr(start, '|');
        if (start == NULL) {
            snprintf(dst, dst_len, "--");
            return;
        }
        start++;
    }

    const char *end = strchr(start, '|');
    size_t len = end != NULL ? (size_t)(end - start) : strlen(start);
    if (len >= dst_len) {
        len = dst_len - 1U;
    }
    memcpy(dst, start, len);
    dst[len] = '\0';
}

static void ui_card_weather_parse_day(ui_card_weather_day_t *day, const char *line, const char *fallback_title)
{
    if (day == NULL) {
        return;
    }
    memset(day, 0, sizeof(*day));
    snprintf(day->title, sizeof(day->title), "%s", fallback_title);
    snprintf(day->condition, sizeof(day->condition), "%s", "--");
    snprintf(day->temp, sizeof(day->temp), "%s", "Temp --");
    snprintf(day->rain, sizeof(day->rain), "%s", "Rain --");
    snprintf(day->air, sizeof(day->air), "%s", "Air --");

    if (line == NULL || line[0] == '\0' || strcmp(line, "--") == 0) {
        return;
    }

    if (strchr(line, '|') == NULL) {
        snprintf(day->temp, sizeof(day->temp), "%s", line);
        return;
    }

    ui_card_weather_copy_field(day->title, sizeof(day->title), line, 0);
    ui_card_weather_copy_field(day->condition, sizeof(day->condition), line, 1);
    char value[96];
    ui_card_weather_copy_field(value, sizeof(value), line, 2);
    snprintf(day->temp, sizeof(day->temp), "Temp %s", value);
    ui_card_weather_copy_field(value, sizeof(value), line, 3);
    snprintf(day->rain, sizeof(day->rain), "%s", value);
    ui_card_weather_copy_field(value, sizeof(value), line, 4);
    snprintf(day->air, sizeof(day->air), "Air %s", value);
}

static void ui_card_weather_delete_cb(lv_event_t *event)
{
    free(lv_event_get_user_data(event));
}

static void ui_card_weather_style_label(lv_obj_t *label, lv_color_t color, int32_t width)
{
    lv_obj_set_width(label, width);
    lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(label, ui_pages_weather_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(label, color, LV_PART_MAIN);
}

static const char *ui_card_weather_condition_symbol(const char *condition)
{
    if (condition != NULL && (strstr(condition, "Thunder") != NULL || strstr(condition, "Storm") != NULL)) {
        return "Storm";
    }
    if (condition != NULL && strstr(condition, "Rain") != NULL) {
        return "Rain";
    }
    if (condition != NULL && strstr(condition, "Snow") != NULL) {
        return "Snow";
    }
    if (condition != NULL && strstr(condition, "Fog") != NULL) {
        return "Fog";
    }
    if (condition != NULL && strstr(condition, "Cloud") != NULL) {
        return "Cloud";
    }
    return "Sun";
}

static lv_color_t ui_card_weather_condition_color(const char *condition)
{
    if (condition != NULL && (strstr(condition, "Thunder") != NULL || strstr(condition, "Storm") != NULL)) {
        return lv_color_hex(0xa78bfa);
    }
    if (condition != NULL && strstr(condition, "Rain") != NULL) {
        return lv_color_hex(0x38bdf8);
    }
    if (condition != NULL && strstr(condition, "Snow") != NULL) {
        return lv_color_hex(0xbae6fd);
    }
    if (condition != NULL && strstr(condition, "Fog") != NULL) {
        return lv_color_hex(0xcbd5e1);
    }
    if (condition != NULL && strstr(condition, "Cloud") != NULL) {
        return lv_color_hex(0x94a3b8);
    }
    return lv_color_hex(0xfacc15);
}

static void ui_card_weather_style_day_panel(lv_obj_t *panel)
{
    lv_obj_set_size(panel, 442, 132);
    lv_obj_set_style_radius(panel, 14, LV_PART_MAIN);
    lv_obj_set_style_pad_all(panel, 14, LV_PART_MAIN);
    lv_obj_set_style_bg_color(panel, lv_color_hex(0x101827), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_color(panel, lv_color_hex(0x102a38), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_dir(panel, LV_GRAD_DIR_VER, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(panel, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(panel, 1, LV_PART_MAIN);
    lv_obj_set_style_border_color(panel, lv_color_hex(0x1d4ed8), LV_PART_MAIN);
    lv_obj_set_style_shadow_width(panel, 18, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(panel, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(panel, lv_color_hex(0x38bdf8), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(panel, LV_OPA_20, LV_PART_MAIN);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
}

static void ui_card_weather_style_icon(lv_obj_t *icon)
{
    lv_obj_set_size(icon, 58, 58);
    lv_obj_set_style_radius(icon, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_bg_color(icon, lv_color_hex(0xfacc15), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(icon, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(icon, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(icon, lv_color_hex(0xfef3c7), LV_PART_MAIN);
    lv_obj_set_style_shadow_width(icon, 18, LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(icon, LV_OPA_40, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(icon, lv_color_hex(0xfacc15), LV_PART_MAIN);
    lv_obj_clear_flag(icon, LV_OBJ_FLAG_SCROLLABLE);
}

static lv_obj_t *ui_card_weather_create_panel_label(lv_obj_t *parent, lv_color_t color, int32_t width)
{
    lv_obj_t *label = lv_label_create(parent);
    ui_card_weather_style_label(label, color, width);
    return label;
}

static void ui_card_weather_build_day_panel(lv_obj_t *card, lv_obj_t **panel, lv_obj_t **icon,
                                            lv_obj_t **icon_label,
                                            lv_obj_t **condition, lv_obj_t **temp,
                                            lv_obj_t **rain, lv_obj_t **air, int32_t x)
{
    *panel = lv_obj_create(card);
    ui_card_weather_style_day_panel(*panel);
    lv_obj_align(*panel, LV_ALIGN_TOP_LEFT, x, 48);

    *icon = lv_obj_create(*panel);
    ui_card_weather_style_icon(*icon);
    lv_obj_align(*icon, LV_ALIGN_LEFT_MID, 0, -4);

    *icon_label = lv_label_create(*icon);
    lv_obj_set_style_text_font(*icon_label, ui_pages_weather_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(*icon_label, lv_color_hex(0x020617), LV_PART_MAIN);
    lv_obj_center(*icon_label);

    *condition = ui_card_weather_create_panel_label(*panel, lv_color_white(), 150);
    lv_obj_align(*condition, LV_ALIGN_TOP_LEFT, 78, 0);

    *temp = ui_card_weather_create_panel_label(*panel, lv_color_hex(0xfff7d6), 330);
    lv_obj_align(*temp, LV_ALIGN_TOP_LEFT, 78, 34);

    *rain = ui_card_weather_create_panel_label(*panel, lv_color_hex(0xbfdbfe), 330);
    lv_obj_align(*rain, LV_ALIGN_TOP_LEFT, 78, 66);

    *air = ui_card_weather_create_panel_label(*panel, lv_color_hex(0xd1fae5), 330);
    lv_obj_align(*air, LV_ALIGN_TOP_LEFT, 78, 98);
}

static void ui_card_weather_apply_day(ui_card_weather_day_t *day, lv_obj_t *panel, lv_obj_t *icon,
                                      lv_obj_t *icon_label, lv_obj_t *condition, lv_obj_t *temp,
                                      lv_obj_t *rain, lv_obj_t *air)
{
    lv_color_t accent = ui_card_weather_condition_color(day->condition);
    char condition_text[40];
    snprintf(condition_text, sizeof(condition_text), "%s %s", day->title, day->condition);

    lv_obj_set_style_bg_color(icon, accent, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(icon, accent, LV_PART_MAIN);
    lv_obj_set_style_border_color(panel, accent, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(panel, accent, LV_PART_MAIN);
    lv_label_set_text(icon_label, ui_card_weather_condition_symbol(day->condition));
    lv_label_set_text(condition, condition_text);
    lv_label_set_text(temp, day->temp);
    lv_label_set_text(rain, day->rain);
    lv_label_set_text(air, day->air);
}

static void ui_card_weather_apply_visual(lv_obj_t *card, const panel_sensor_t *sensor)
{
    uint32_t grad = 0x0f2a38;
    uint32_t border = 0x1d4ed8;
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

    lv_obj_set_style_bg_color(card, lv_color_hex(0x101827), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_color(card, lv_color_hex(grad), LV_PART_MAIN);
    lv_obj_set_style_bg_grad_dir(card, LV_GRAD_DIR_VER, LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(card, 24, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(card, lv_color_hex(0x38bdf8), LV_PART_MAIN);
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
    lv_obj_set_size(card, 944, 210);
    lv_obj_set_style_radius(card, 16, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    ctx->title = lv_label_create(card);
    ui_card_weather_style_label(ctx->title, lv_color_hex(0xfff7d6), 360);
    lv_obj_align(ctx->title, LV_ALIGN_TOP_LEFT, 0, 0);

    ctx->meta = lv_label_create(card);
    ui_card_weather_style_label(ctx->meta, lv_color_hex(0xa8b3c2), 360);
    lv_obj_align(ctx->meta, LV_ALIGN_TOP_RIGHT, 0, 0);

    ui_card_weather_build_day_panel(card, &ctx->today_panel, &ctx->today_icon,
                                    &ctx->today_icon_label,
                                    &ctx->today_condition, &ctx->today_temp,
                                    &ctx->today_rain, &ctx->today_air, 0);
    ui_card_weather_build_day_panel(card, &ctx->tomorrow_panel, &ctx->tomorrow_icon,
                                    &ctx->tomorrow_icon_label,
                                    &ctx->tomorrow_condition, &ctx->tomorrow_temp,
                                    &ctx->tomorrow_rain, &ctx->tomorrow_air, 470);

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
    char today_line[192];
    char tomorrow_line[192];
    char meta_text[80];
    ui_card_weather_day_t today;
    ui_card_weather_day_t tomorrow;
    snprintf(title_text, sizeof(title_text), "%s / %s",
             ui_card_weather_safe_text(sensor->group, "Outdoor"),
             ui_card_weather_safe_text(sensor->label, "Weather"));
    ui_card_weather_copy_line(today_line, sizeof(today_line), sensor->value_text, 0);
    ui_card_weather_copy_line(tomorrow_line, sizeof(tomorrow_line), sensor->value_text, 1);
    ui_card_weather_parse_day(&today, today_line, "Today");
    ui_card_weather_parse_day(&tomorrow, tomorrow_line, "Tomorrow");
    snprintf(meta_text, sizeof(meta_text), "Weather | 30 min refresh | %s", ui_card_weather_status_text(sensor));

    lv_label_set_text(ctx->title, title_text);
    lv_label_set_text(ctx->meta, meta_text);
    ui_card_weather_apply_day(&today, ctx->today_panel, ctx->today_icon, ctx->today_icon_label,
                              ctx->today_condition, ctx->today_temp,
                              ctx->today_rain, ctx->today_air);
    ui_card_weather_apply_day(&tomorrow, ctx->tomorrow_panel, ctx->tomorrow_icon, ctx->tomorrow_icon_label,
                              ctx->tomorrow_condition, ctx->tomorrow_temp,
                              ctx->tomorrow_rain, ctx->tomorrow_air);
    ui_card_weather_apply_visual(card, sensor);
}
