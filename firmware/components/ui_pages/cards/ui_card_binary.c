#include "ui_card_binary.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ha_client.h"
#include "ui_fonts.h"
#include "ui_pixel_theme.h"

static const char *TAG = "ui_card_binary";

typedef struct {
    lv_obj_t *group;
    lv_obj_t *title_depth;
    lv_obj_t *title;
    lv_obj_t *state;
    lv_obj_t *accent_bar;
    lv_obj_t *indicator;
    lv_obj_t *toggle;
    char entity_id[128];
    char domain[16];
    char on_service[24];
    char off_service[24];
    char last_error[32];
    uint32_t binding_generation;
    uint32_t visual_key;
    bool pending;
    bool deleted;
} ui_card_binary_ctx_t;

typedef struct {
    ui_card_binary_ctx_t *ctx;
    char entity_id[128];
    char domain[16];
    char service[24];
    uint32_t binding_generation;
    bool target_on;
} ui_card_binary_call_task_arg_t;

typedef struct {
    ui_card_binary_ctx_t *ctx;
    uint32_t binding_generation;
    bool target_on;
    esp_err_t result;
} ui_card_binary_call_result_t;

static void ui_card_binary_call_task(void *arg);

static const char *ui_card_binary_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

typedef struct {
    const char *match;
    const char *short_title;
} ui_card_binary_title_map_t;

static const char *ui_card_binary_short_title(const char *label)
{
    static const ui_card_binary_title_map_t title_map[] = {
        {"展示灯", "展示"},
        {"杯子灯", "杯灯"},
        {"镜柜灯", "镜灯"},
        {"吸顶灯", "顶灯"},
        {"风扇灯", "风扇"},
        {"过道开关", "过道"},
        {"过道灯", "过道"},
        {"衣橱灯", "衣橱"},
        {"吧台灯", "吧台"},
        {"大灯", "主灯"},
        {"射灯", "射灯"},
        {"壁灯", "壁灯"},
        {"筒灯", "筒灯"},
        {"柜灯", "柜灯"},
        {"花灯", "花灯"},
        {"线灯", "线灯"},
    };

    if (label != NULL) {
        for (size_t i = 0; i < sizeof(title_map) / sizeof(title_map[0]); ++i) {
            if (strstr(label, title_map[i].match) != NULL) {
                return title_map[i].short_title;
            }
        }
    }
    return "照明";
}

static bool ui_card_binary_is_on(const panel_sensor_t *sensor)
{
    return sensor != NULL &&
           (strcmp(sensor->value_text, "on") == 0 || strcmp(sensor->value_text, "open") == 0 ||
            strcmp(sensor->value_text, "detected") == 0);
}

static bool ui_card_binary_is_controllable(const panel_sensor_t *sensor)
{
    return sensor != NULL && sensor->control_domain[0] != '\0' &&
           sensor->control_on_service[0] != '\0' && sensor->control_off_service[0] != '\0';
}

static void ui_card_binary_set_text_if_changed(lv_obj_t *label, const char *text)
{
    if (label != NULL && text != NULL && strcmp(lv_label_get_text(label), text) != 0) {
        lv_label_set_text(label, text);
    }
}

static void ui_card_binary_set_visual(lv_obj_t *card, const panel_sensor_t *sensor, bool on)
{
    ui_card_binary_ctx_t *ctx = (ui_card_binary_ctx_t *)lv_obj_get_user_data(card);
    uint32_t color = on ? 0x3a3218 : 0x1a2028;
    uint32_t border = on ? 0xf3c64e : 0x344150;
    uint32_t accent = on ? UI_PIXEL_COLOR_YELLOW : UI_PIXEL_COLOR_CYAN;
    uint32_t border_width = on ? 2 : 1;
    uint32_t visual_key = on ? 1U : 0U;
    if (!sensor->available) {
        color = 0x2f1f24;
        border = 0x7f1d1d;
        accent = UI_PIXEL_COLOR_RED;
        border_width = 2;
        visual_key = 2U;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_UNKNOWN) {
        color = 0x202632;
        border = 0x475569;
        accent = UI_PIXEL_COLOR_MUTED;
        border_width = 2;
        visual_key = 3U;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        color = 0x30291d;
        border = 0x854d0e;
        accent = UI_PIXEL_COLOR_YELLOW;
        border_width = 2;
        visual_key = 4U;
    }
    if (ctx != NULL && ctx->visual_key == visual_key) {
        return;
    }
    if (ctx != NULL) {
        ctx->visual_key = visual_key;
    }
    ui_pixel_style_card(card, color, border);
    lv_obj_set_style_border_width(card, border_width, LV_PART_MAIN);
    if (ctx != NULL) {
        lv_obj_set_style_bg_color(ctx->accent_bar, lv_color_hex(accent), LV_PART_MAIN);
        lv_obj_set_style_bg_color(ctx->indicator, lv_color_hex(accent), LV_PART_MAIN);
        lv_obj_set_style_text_color(ctx->title_depth, lv_color_hex(accent), LV_PART_MAIN);
    }
}

static void ui_card_binary_set_labels(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_binary_ctx_t *ctx = (ui_card_binary_ctx_t *)lv_obj_get_user_data(card);
    if (ctx == NULL || sensor == NULL) {
        return;
    }

    bool on = ui_card_binary_is_on(sensor);
    bool controllable = ui_card_binary_is_controllable(sensor);
    const char *state_text;

    if (ctx->entity_id[0] != '\0' && strcmp(ctx->entity_id, sensor->entity_id) != 0) {
        ctx->binding_generation++;
        ctx->pending = false;
        ctx->last_error[0] = '\0';
    }

    ui_card_binary_set_text_if_changed(ctx->group,
                                       ui_card_binary_safe_text(sensor->group, "LIGHT"));
    const char *short_title = ui_card_binary_short_title(sensor->label);
    ui_card_binary_set_text_if_changed(ctx->title_depth, short_title);
    ui_card_binary_set_text_if_changed(ctx->title, short_title);

    if (controllable) {
        snprintf(ctx->entity_id, sizeof(ctx->entity_id), "%s", sensor->entity_id);
        snprintf(ctx->domain, sizeof(ctx->domain), "%s", sensor->control_domain);
        snprintf(ctx->on_service, sizeof(ctx->on_service), "%s", sensor->control_on_service);
        snprintf(ctx->off_service, sizeof(ctx->off_service), "%s", sensor->control_off_service);
    }

    if (!sensor->available || ctx->last_error[0] != '\0') {
        state_text = "ERR";
    } else if (ctx->pending || sensor->freshness == PANEL_SENSOR_FRESHNESS_UNKNOWN) {
        state_text = "...";
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        state_text = "OLD";
    } else {
        state_text = on ? "ON" : "OFF";
    }
    ui_card_binary_set_text_if_changed(ctx->state, state_text);

    if (ctx->toggle != NULL) {
        if (on) {
            lv_obj_add_state(ctx->toggle, LV_STATE_CHECKED);
        } else {
            lv_obj_remove_state(ctx->toggle, LV_STATE_CHECKED);
        }
        if (!sensor->available || !controllable || ctx->pending) {
            lv_obj_add_state(ctx->toggle, LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(ctx->toggle, LV_STATE_DISABLED);
        }
    }

    ui_card_binary_set_visual(card, sensor, on);
}

static void ui_card_binary_request_control(ui_card_binary_ctx_t *ctx, bool target_on)
{
    if (ctx == NULL || ctx->pending || ctx->deleted || ctx->toggle == NULL ||
        lv_obj_has_state(ctx->toggle, LV_STATE_DISABLED)) {
        return;
    }

    ui_card_binary_call_task_arg_t *task_arg = calloc(1U, sizeof(*task_arg));
    if (task_arg == NULL) {
        return;
    }
    task_arg->ctx = ctx;
    task_arg->target_on = target_on;
    task_arg->binding_generation = ctx->binding_generation;
    snprintf(task_arg->entity_id, sizeof(task_arg->entity_id), "%s", ctx->entity_id);
    snprintf(task_arg->domain, sizeof(task_arg->domain), "%s", ctx->domain);
    snprintf(task_arg->service, sizeof(task_arg->service), "%s",
             target_on ? ctx->on_service : ctx->off_service);
    ctx->pending = true;
    ctx->last_error[0] = '\0';
    lv_obj_add_state(ctx->toggle, LV_STATE_DISABLED);
    ui_card_binary_set_text_if_changed(ctx->state, "...");

    BaseType_t ok = xTaskCreate(ui_card_binary_call_task, "p4home_ctl", 4096, task_arg,
                                tskIDLE_PRIORITY + 3, NULL);
    if (ok != pdPASS) {
        ctx->pending = false;
        snprintf(ctx->last_error, sizeof(ctx->last_error), "Failed");
        lv_obj_remove_state(ctx->toggle, LV_STATE_DISABLED);
        ui_card_binary_set_text_if_changed(ctx->state, "ERR");
        free(task_arg);
    }
}

static void ui_card_binary_apply_call_result_on_lvgl(void *user_data)
{
    ui_card_binary_call_result_t *result = (ui_card_binary_call_result_t *)user_data;
    if (result == NULL) {
        return;
    }
    ui_card_binary_ctx_t *ctx = result->ctx;
    if (ctx != NULL && !ctx->deleted &&
        ctx->binding_generation == result->binding_generation) {
        ctx->pending = false;
        if (result->result == ESP_OK) {
            ctx->last_error[0] = '\0';
            ui_card_binary_set_text_if_changed(ctx->state, result->target_on ? "ON" : "OFF");
        } else {
            snprintf(ctx->last_error, sizeof(ctx->last_error), "Failed");
            ui_card_binary_set_text_if_changed(ctx->state, "ERR");
            if (ctx->toggle != NULL) {
                if (result->target_on) {
                    lv_obj_remove_state(ctx->toggle, LV_STATE_CHECKED);
                } else {
                    lv_obj_add_state(ctx->toggle, LV_STATE_CHECKED);
                }
                lv_obj_remove_state(ctx->toggle, LV_STATE_DISABLED);
            }
        }
    }
    free(result);
}

static void ui_card_binary_call_task(void *arg)
{
    ui_card_binary_call_task_arg_t *task_arg = (ui_card_binary_call_task_arg_t *)arg;
    if (task_arg == NULL) {
        vTaskDelete(NULL);
        return;
    }

    ui_card_binary_ctx_t *ctx = task_arg->ctx;
    bool target_on = task_arg->target_on;
    uint32_t binding_generation = task_arg->binding_generation;
    char domain[sizeof(task_arg->domain)] = {0};
    char service[sizeof(task_arg->service)] = {0};
    char entity_id[sizeof(task_arg->entity_id)] = {0};
    snprintf(domain, sizeof(domain), "%s", task_arg->domain);
    snprintf(service, sizeof(service), "%s", task_arg->service);
    snprintf(entity_id, sizeof(entity_id), "%s", task_arg->entity_id);
    free(task_arg);

    esp_err_t err = ha_client_call_entity_service(domain, service, entity_id, 0);
    ESP_LOGI(TAG, "control call entity=%s service=%s.%s result=%s",
             entity_id, domain, service, esp_err_to_name(err));

    ui_card_binary_call_result_t *result = calloc(1U, sizeof(*result));
    if (result != NULL) {
        result->ctx = ctx;
        result->binding_generation = binding_generation;
        result->target_on = target_on;
        result->result = err;
        lv_async_call(ui_card_binary_apply_call_result_on_lvgl, result);
    }
    vTaskDelete(NULL);
}

static void ui_card_binary_toggle_event_cb(lv_event_t *event)
{
    ui_card_binary_ctx_t *ctx = (ui_card_binary_ctx_t *)lv_event_get_user_data(event);
    if (ctx == NULL || ctx->pending || ctx->deleted || ctx->toggle == NULL) {
        return;
    }

    ui_card_binary_request_control(ctx, lv_obj_has_state(ctx->toggle, LV_STATE_CHECKED));
}

static void ui_card_binary_card_click_cb(lv_event_t *event)
{
    ui_card_binary_ctx_t *ctx = (ui_card_binary_ctx_t *)lv_event_get_user_data(event);
    if (ctx == NULL || ctx->toggle == NULL || ctx->pending || ctx->deleted ||
        lv_obj_has_state(ctx->toggle, LV_STATE_DISABLED)) {
        return;
    }

    bool target_on = !lv_obj_has_state(ctx->toggle, LV_STATE_CHECKED);
    if (target_on) {
        lv_obj_add_state(ctx->toggle, LV_STATE_CHECKED);
    } else {
        lv_obj_remove_state(ctx->toggle, LV_STATE_CHECKED);
    }
    ui_card_binary_request_control(ctx, target_on);
}

static void ui_card_binary_delete_cb(lv_event_t *event)
{
    ui_card_binary_ctx_t *ctx = (ui_card_binary_ctx_t *)lv_event_get_user_data(event);
    if (ctx != NULL) {
        ctx->deleted = true;
        free(ctx);
    }
}

lv_obj_t *ui_card_binary_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    ui_card_binary_ctx_t *ctx = calloc(1U, sizeof(*ctx));
    if (ctx == NULL) {
        return NULL;
    }

    lv_obj_t *card = lv_obj_create(parent);
    if (card == NULL) {
        free(ctx);
        return NULL;
    }
    ctx->visual_key = UINT32_MAX;
    lv_obj_set_user_data(card, ctx);
    lv_obj_add_event_cb(card, ui_card_binary_delete_cb, LV_EVENT_DELETE, ctx);
    lv_obj_set_size(card, 220, 148);
    ui_pixel_style_card(card, UI_PIXEL_COLOR_PANEL, UI_PIXEL_COLOR_GRID);
    lv_obj_set_style_pad_all(card, 10, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(card, ui_card_binary_card_click_cb, LV_EVENT_CLICKED, ctx);

    lv_obj_t *depth_strip = lv_obj_create(card);
    lv_obj_set_size(depth_strip, 196, 6);
    lv_obj_align(depth_strip, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_bg_color(depth_strip, lv_color_hex(0x020405), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(depth_strip, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(depth_strip, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(depth_strip, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(depth_strip, 0, LV_PART_MAIN);
    lv_obj_clear_flag(depth_strip, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    ctx->accent_bar = lv_obj_create(card);
    lv_obj_set_size(ctx->accent_bar, 6, 92);
    lv_obj_align(ctx->accent_bar, LV_ALIGN_LEFT_MID, 0, -2);
    lv_obj_set_style_bg_opa(ctx->accent_bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(ctx->accent_bar, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(ctx->accent_bar, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(ctx->accent_bar, 0, LV_PART_MAIN);
    lv_obj_clear_flag(ctx->accent_bar, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    ctx->indicator = lv_obj_create(card);
    lv_obj_set_size(ctx->indicator, 10, 10);
    lv_obj_align(ctx->indicator, LV_ALIGN_TOP_RIGHT, 0, 0);
    lv_obj_set_style_bg_opa(ctx->indicator, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_color(ctx->indicator, lv_color_hex(UI_PIXEL_COLOR_INK), LV_PART_MAIN);
    lv_obj_set_style_border_width(ctx->indicator, 1, LV_PART_MAIN);
    lv_obj_set_style_radius(ctx->indicator, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(ctx->indicator, 0, LV_PART_MAIN);
    lv_obj_clear_flag(ctx->indicator, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    ctx->group = lv_label_create(card);
    if (ctx->group == NULL) {
        lv_obj_delete(card);
        return NULL;
    }
    lv_obj_set_width(ctx->group, 120);
    lv_label_set_long_mode(ctx->group, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(ctx->group, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->group, lv_color_hex(UI_PIXEL_COLOR_MUTED), LV_PART_MAIN);
    lv_obj_align(ctx->group, LV_ALIGN_TOP_LEFT, 14, 0);

    ctx->title_depth = lv_label_create(card);
    if (ctx->title_depth == NULL) {
        lv_obj_delete(card);
        return NULL;
    }
    lv_obj_set_style_text_font(ctx->title_depth, ui_pages_lights_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_letter_space(ctx->title_depth, 3, LV_PART_MAIN);
    lv_obj_align(ctx->title_depth, LV_ALIGN_LEFT_MID, 17, -2);

    ctx->title = lv_label_create(card);
    if (ctx->title == NULL) {
        lv_obj_delete(card);
        return NULL;
    }
    lv_obj_set_style_text_font(ctx->title, ui_pages_lights_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_letter_space(ctx->title, 3, LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->title, lv_color_hex(UI_PIXEL_COLOR_INK), LV_PART_MAIN);
    lv_obj_align(ctx->title, LV_ALIGN_LEFT_MID, 14, -5);

    ctx->state = lv_label_create(card);
    if (ctx->state == NULL) {
        lv_obj_delete(card);
        return NULL;
    }
    lv_obj_set_style_text_font(ctx->state, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->state, lv_color_hex(UI_PIXEL_COLOR_MUTED), LV_PART_MAIN);
    lv_obj_align(ctx->state, LV_ALIGN_BOTTOM_LEFT, 14, -10);
    if (ui_card_binary_is_controllable(sensor)) {
        ctx->toggle = lv_switch_create(card);
        if (ctx->toggle == NULL) {
            lv_obj_delete(card);
            return NULL;
        }
        lv_obj_set_size(ctx->toggle, 58, 34);
        lv_obj_align(ctx->toggle, LV_ALIGN_RIGHT_MID, 0, 14);
        lv_obj_set_style_bg_color(ctx->toggle, lv_color_hex(0xf3c64e),
                                 LV_PART_INDICATOR | LV_STATE_CHECKED);
        lv_obj_set_style_bg_color(ctx->toggle, lv_color_hex(UI_PIXEL_COLOR_GRID), LV_PART_MAIN);
        lv_obj_set_style_bg_color(ctx->toggle, lv_color_hex(0xe5edf5), LV_PART_KNOB);
        lv_obj_set_style_radius(ctx->toggle, 0, LV_PART_MAIN);
        lv_obj_set_style_radius(ctx->toggle, 0, LV_PART_INDICATOR);
        lv_obj_set_style_radius(ctx->toggle, 0, LV_PART_KNOB);
        lv_obj_set_style_shadow_width(ctx->toggle, 4, LV_PART_MAIN);
        lv_obj_set_style_shadow_offset_x(ctx->toggle, 2, LV_PART_MAIN);
        lv_obj_set_style_shadow_offset_y(ctx->toggle, 2, LV_PART_MAIN);
        lv_obj_set_style_shadow_color(ctx->toggle, lv_color_hex(0x020405), LV_PART_MAIN);
        lv_obj_set_style_shadow_opa(ctx->toggle, LV_OPA_60, LV_PART_MAIN);
        lv_obj_set_style_outline_width(ctx->toggle, 1, LV_PART_MAIN);
        lv_obj_set_style_outline_pad(ctx->toggle, 1, LV_PART_MAIN);
        lv_obj_set_style_outline_color(ctx->toggle, lv_color_hex(UI_PIXEL_COLOR_GRID), LV_PART_MAIN);
        lv_obj_set_style_outline_color(ctx->toggle, lv_color_hex(UI_PIXEL_COLOR_YELLOW),
                                       LV_PART_MAIN | LV_STATE_CHECKED);
        lv_obj_set_style_outline_opa(ctx->toggle, LV_OPA_40, LV_PART_MAIN);
        lv_obj_add_event_cb(ctx->toggle, ui_card_binary_toggle_event_cb, LV_EVENT_VALUE_CHANGED, ctx);
    }

    ui_card_binary_set_labels(card, sensor);
    return card;
}

void ui_card_binary_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_binary_set_labels(card, sensor);
}
