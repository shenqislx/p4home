#include "ui_card_climate.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ha_client.h"
#include "ui_fonts.h"

static const char *TAG = "ui_card_climate";

typedef struct ui_card_climate_ctx ui_card_climate_ctx_t;

typedef struct {
    ui_card_climate_ctx_t *ctx;
    int value;
} ui_card_climate_binding_t;

typedef struct {
    ui_card_climate_ctx_t *ctx;
    char service[24];
    char service_data[256];
    uint32_t binding_generation;
} ui_card_climate_call_arg_t;

typedef struct {
    ui_card_climate_ctx_t *ctx;
    uint32_t binding_generation;
    esp_err_t result;
} ui_card_climate_call_result_t;

struct ui_card_climate_ctx {
    lv_obj_t *title;
    lv_obj_t *mode_status;
    lv_obj_t *current_temperature;
    lv_obj_t *target_temperature;
    lv_obj_t *power_button;
    lv_obj_t *temperature_buttons[2];
    lv_obj_t *mode_buttons[4];
    lv_obj_t *meta;
    ui_card_climate_binding_t power_binding;
    ui_card_climate_binding_t temperature_bindings[2];
    ui_card_climate_binding_t mode_bindings[4];
    char entity_id[128];
    char unit[8];
    char current_mode[16];
    char supported_modes[80];
    char last_error[24];
    double target_raw;
    double min_raw;
    double max_raw;
    uint32_t binding_generation;
    bool available;
    bool has_target;
    bool pending;
    bool deleted;
};

static const char *s_mode_names[] = {"cool", "heat", "dry", "fan_only"};
static const char *s_mode_labels[] = {"制冷", "制热", "除湿", "送风"};

static bool ui_card_climate_is_fahrenheit(const char *unit)
{
    return unit != NULL && strcmp(unit, "F") == 0;
}

static double ui_card_climate_to_display(const ui_card_climate_ctx_t *ctx, double raw)
{
    return ui_card_climate_is_fahrenheit(ctx->unit) ? (raw - 32.0) * (5.0 / 9.0) : raw;
}

static double ui_card_climate_to_raw(const ui_card_climate_ctx_t *ctx, double display)
{
    return ui_card_climate_is_fahrenheit(ctx->unit) ? display * (9.0 / 5.0) + 32.0 : display;
}

static void ui_card_climate_set_temperature_text(lv_obj_t *label, double temperature)
{
    char text[24];
    snprintf(text, sizeof(text), "%.1f°C", temperature);
    lv_label_set_text(label, text);
}

static const char *ui_card_climate_mode_label(const char *mode)
{
    if (mode == NULL || mode[0] == '\0' || strcmp(mode, "off") == 0) {
        return "关闭";
    }
    for (size_t i = 0; i < sizeof(s_mode_names) / sizeof(s_mode_names[0]); ++i) {
        if (strcmp(mode, s_mode_names[i]) == 0) {
            return s_mode_labels[i];
        }
    }
    return mode;
}

static bool ui_card_climate_supports_mode(const ui_card_climate_ctx_t *ctx, const char *mode)
{
    if (ctx == NULL || mode == NULL || mode[0] == '\0') {
        return false;
    }
    size_t mode_len = strlen(mode);
    const char *cursor = ctx->supported_modes;
    while (cursor != NULL && cursor[0] != '\0') {
        const char *end = strchr(cursor, ',');
        size_t token_len = end != NULL ? (size_t)(end - cursor) : strlen(cursor);
        if (token_len == mode_len && strncmp(cursor, mode, mode_len) == 0) {
            return true;
        }
        cursor = end != NULL ? end + 1 : NULL;
    }
    return false;
}

static void ui_card_climate_set_controls_disabled(ui_card_climate_ctx_t *ctx, bool disabled)
{
    if (ctx == NULL) {
        return;
    }
    lv_obj_t *controls[] = {
        ctx->power_button,
        ctx->temperature_buttons[0],
        ctx->temperature_buttons[1],
        ctx->mode_buttons[0],
        ctx->mode_buttons[1],
        ctx->mode_buttons[2],
        ctx->mode_buttons[3],
    };
    for (size_t i = 0; i < sizeof(controls) / sizeof(controls[0]); ++i) {
        if (controls[i] == NULL) {
            continue;
        }
        if (disabled) {
            lv_obj_add_state(controls[i], LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(controls[i], LV_STATE_DISABLED);
        }
    }
}

static void ui_card_climate_style_mode_buttons(ui_card_climate_ctx_t *ctx)
{
    static const uint32_t active_colors[] = {0x167c91, 0xb84a32, 0x9a7b16, 0x287a4b};
    for (size_t i = 0; i < sizeof(s_mode_names) / sizeof(s_mode_names[0]); ++i) {
        bool active = strcmp(ctx->current_mode, s_mode_names[i]) == 0;
        bool supported = ui_card_climate_supports_mode(ctx, s_mode_names[i]);
        lv_obj_set_style_bg_color(ctx->mode_buttons[i],
                                  lv_color_hex(active ? active_colors[i] : 0x29313a),
                                  LV_PART_MAIN);
        lv_obj_set_style_border_width(ctx->mode_buttons[i], active ? 2 : 0, LV_PART_MAIN);
        lv_obj_set_style_border_color(ctx->mode_buttons[i], lv_color_hex(0xe5edf5), LV_PART_MAIN);
        if (!supported || !ctx->available || ctx->pending) {
            lv_obj_add_state(ctx->mode_buttons[i], LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(ctx->mode_buttons[i], LV_STATE_DISABLED);
        }
    }
}

static void ui_card_climate_set_visual(lv_obj_t *card, ui_card_climate_ctx_t *ctx)
{
    uint32_t background = 0x20242a;
    uint32_t border = 0x394552;
    if (!ctx->available) {
        background = 0x2f2023;
        border = 0x8d3440;
    } else if (strcmp(ctx->current_mode, "cool") == 0) {
        background = 0x17343b;
        border = 0x35b6d1;
    } else if (strcmp(ctx->current_mode, "heat") == 0) {
        background = 0x3a241e;
        border = 0xe06a4f;
    } else if (strcmp(ctx->current_mode, "dry") == 0) {
        background = 0x343019;
        border = 0xd4ad2f;
    } else if (strcmp(ctx->current_mode, "fan_only") == 0) {
        background = 0x1d3325;
        border = 0x52b877;
    }
    lv_obj_set_style_bg_color(card, lv_color_hex(background), LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, 2, LV_PART_MAIN);
}

static void ui_card_climate_apply_labels(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_climate_ctx_t *ctx = (ui_card_climate_ctx_t *)lv_obj_get_user_data(card);
    if (ctx == NULL || sensor == NULL) {
        return;
    }

    if (ctx->entity_id[0] != '\0' && strcmp(ctx->entity_id, sensor->entity_id) != 0) {
        ctx->binding_generation++;
        ctx->pending = false;
        ctx->last_error[0] = '\0';
    }
    snprintf(ctx->entity_id, sizeof(ctx->entity_id), "%s", sensor->entity_id);
    snprintf(ctx->unit, sizeof(ctx->unit), "%s", sensor->unit);
    snprintf(ctx->current_mode, sizeof(ctx->current_mode), "%.*s",
             (int)sizeof(ctx->current_mode) - 1, sensor->value_text);
    snprintf(ctx->supported_modes, sizeof(ctx->supported_modes), "%s", sensor->supported_modes);
    ctx->target_raw = sensor->target_temperature;
    ctx->min_raw = sensor->min_temperature;
    ctx->max_raw = sensor->max_temperature;
    ctx->available = sensor->available;
    ctx->has_target = sensor->has_target_temperature;

    lv_label_set_text(ctx->title, sensor->label[0] != '\0' ? sensor->label : sensor->entity_id);
    lv_label_set_text_fmt(ctx->mode_status, "当前模式  %s",
                          sensor->available ? ui_card_climate_mode_label(sensor->value_text) : "离线");
    if (sensor->has_current_temperature) {
        ui_card_climate_set_temperature_text(
            ctx->current_temperature,
            ui_card_climate_to_display(ctx, sensor->current_temperature));
    } else {
        lv_label_set_text(ctx->current_temperature, "--.-°C");
    }
    if (sensor->has_target_temperature) {
        ui_card_climate_set_temperature_text(
            ctx->target_temperature,
            ui_card_climate_to_display(ctx, sensor->target_temperature));
    } else {
        lv_label_set_text(ctx->target_temperature, "--.-°C");
    }

    if (ctx->pending) {
        lv_label_set_text(ctx->meta, "正在发送控制指令");
    } else if (ctx->last_error[0] != '\0') {
        lv_label_set_text(ctx->meta, "控制失败");
    } else {
        lv_label_set_text_fmt(ctx->meta, "%s | %s", sensor->group,
                              sensor->available ? "在线" : "离线");
    }

    bool on = sensor->available && strcmp(sensor->value_text, "off") != 0;
    lv_obj_set_style_bg_color(ctx->power_button,
                              lv_color_hex(on ? 0xe06a4f : 0x394552), LV_PART_MAIN);
    ui_card_climate_set_controls_disabled(ctx, !sensor->available || ctx->pending);
    if (!sensor->has_target_temperature) {
        lv_obj_add_state(ctx->temperature_buttons[0], LV_STATE_DISABLED);
        lv_obj_add_state(ctx->temperature_buttons[1], LV_STATE_DISABLED);
    }
    ui_card_climate_style_mode_buttons(ctx);
    ui_card_climate_set_visual(card, ctx);
}

static void ui_card_climate_apply_call_result(void *user_data)
{
    ui_card_climate_call_result_t *result = (ui_card_climate_call_result_t *)user_data;
    if (result == NULL) {
        return;
    }
    ui_card_climate_ctx_t *ctx = result->ctx;
    if (ctx != NULL && !ctx->deleted && ctx->binding_generation == result->binding_generation) {
        ctx->pending = false;
        if (result->result == ESP_OK) {
            ctx->last_error[0] = '\0';
            lv_label_set_text(ctx->meta, "控制指令已发送");
            ui_card_climate_set_controls_disabled(ctx, !ctx->available);
            ui_card_climate_style_mode_buttons(ctx);
        } else {
            snprintf(ctx->last_error, sizeof(ctx->last_error), "%s", "failed");
            lv_label_set_text(ctx->meta, "控制失败");
            panel_sensor_t sensor;
            if (panel_data_store_get_snapshot(ctx->entity_id, &sensor)) {
                ui_card_climate_apply_labels(lv_obj_get_parent(ctx->title), &sensor);
            }
        }
    }
    free(result);
}

static void ui_card_climate_call_task(void *arg)
{
    ui_card_climate_call_arg_t *task_arg = (ui_card_climate_call_arg_t *)arg;
    if (task_arg == NULL) {
        vTaskDelete(NULL);
        return;
    }
    ui_card_climate_ctx_t *ctx = task_arg->ctx;
    uint32_t generation = task_arg->binding_generation;
    char service[sizeof(task_arg->service)];
    char service_data[sizeof(task_arg->service_data)];
    snprintf(service, sizeof(service), "%s", task_arg->service);
    snprintf(service_data, sizeof(service_data), "%s", task_arg->service_data);
    free(task_arg);

    ha_client_call_service_request_t request = {
        .domain = "climate",
        .service = service,
        .service_data_json = service_data,
        .timeout_ms = 0,
    };
    esp_err_t err = ha_client_call_service(&request);
    ESP_LOGI(TAG, "climate control service=%s result=%s", service, esp_err_to_name(err));

    ui_card_climate_call_result_t *result = calloc(1U, sizeof(*result));
    if (result != NULL) {
        result->ctx = ctx;
        result->binding_generation = generation;
        result->result = err;
        lv_async_call(ui_card_climate_apply_call_result, result);
    }
    vTaskDelete(NULL);
}

static void ui_card_climate_request(ui_card_climate_ctx_t *ctx, const char *service,
                                    const char *service_data)
{
    if (ctx == NULL || ctx->pending || ctx->deleted || !ctx->available) {
        return;
    }
    ui_card_climate_call_arg_t *arg = calloc(1U, sizeof(*arg));
    if (arg == NULL) {
        return;
    }
    arg->ctx = ctx;
    arg->binding_generation = ctx->binding_generation;
    snprintf(arg->service, sizeof(arg->service), "%s", service);
    snprintf(arg->service_data, sizeof(arg->service_data), "%s", service_data);
    ctx->pending = true;
    ctx->last_error[0] = '\0';
    ui_card_climate_set_controls_disabled(ctx, true);
    lv_label_set_text(ctx->meta, "正在发送控制指令");
    if (xTaskCreate(ui_card_climate_call_task, "p4home_climate", 4096, arg,
                    tskIDLE_PRIORITY + 3, NULL) != pdPASS) {
        ctx->pending = false;
        snprintf(ctx->last_error, sizeof(ctx->last_error), "%s", "failed");
        lv_label_set_text(ctx->meta, "控制失败");
        ui_card_climate_set_controls_disabled(ctx, false);
        free(arg);
    }
}

static void ui_card_climate_power_event(lv_event_t *event)
{
    ui_card_climate_binding_t *binding = (ui_card_climate_binding_t *)lv_event_get_user_data(event);
    if (binding == NULL || binding->ctx == NULL) {
        return;
    }
    ui_card_climate_ctx_t *ctx = binding->ctx;
    char data[176];
    snprintf(data, sizeof(data), "{\"entity_id\":\"%s\"}", ctx->entity_id);
    ui_card_climate_request(ctx, strcmp(ctx->current_mode, "off") == 0 ? "turn_on" : "turn_off", data);
}

static void ui_card_climate_temperature_event(lv_event_t *event)
{
    ui_card_climate_binding_t *binding = (ui_card_climate_binding_t *)lv_event_get_user_data(event);
    if (binding == NULL || binding->ctx == NULL || !binding->ctx->has_target) {
        return;
    }
    ui_card_climate_ctx_t *ctx = binding->ctx;
    double display_min = round(ui_card_climate_to_display(ctx, ctx->min_raw));
    double display_max = round(ui_card_climate_to_display(ctx, ctx->max_raw));
    double display_target = round(ui_card_climate_to_display(ctx, ctx->target_raw)) + binding->value;
    if (display_target < display_min) {
        display_target = display_min;
    } else if (display_target > display_max) {
        display_target = display_max;
    }
    double raw_target = ui_card_climate_to_raw(ctx, display_target);
    ctx->target_raw = raw_target;
    ui_card_climate_set_temperature_text(ctx->target_temperature,
                                         ui_card_climate_to_display(ctx, raw_target));
    char data[224];
    snprintf(data, sizeof(data), "{\"entity_id\":\"%s\",\"temperature\":%.2f}",
             ctx->entity_id, raw_target);
    ui_card_climate_request(ctx, "set_temperature", data);
}

static void ui_card_climate_mode_event(lv_event_t *event)
{
    ui_card_climate_binding_t *binding = (ui_card_climate_binding_t *)lv_event_get_user_data(event);
    if (binding == NULL || binding->ctx == NULL || binding->value < 0 || binding->value >= 4) {
        return;
    }
    ui_card_climate_ctx_t *ctx = binding->ctx;
    const char *mode = s_mode_names[binding->value];
    if (!ui_card_climate_supports_mode(ctx, mode)) {
        return;
    }
    snprintf(ctx->current_mode, sizeof(ctx->current_mode), "%s", mode);
    lv_label_set_text_fmt(ctx->mode_status, "当前模式  %s", ui_card_climate_mode_label(mode));
    ui_card_climate_style_mode_buttons(ctx);
    char data[224];
    snprintf(data, sizeof(data), "{\"entity_id\":\"%s\",\"hvac_mode\":\"%s\"}",
             ctx->entity_id, mode);
    ui_card_climate_request(ctx, "set_hvac_mode", data);
}

static lv_obj_t *ui_card_climate_create_button(lv_obj_t *parent, int32_t x, int32_t y,
                                                int32_t width, int32_t height, const char *text,
                                                lv_event_cb_t callback, void *user_data)
{
    lv_obj_t *button = lv_button_create(parent);
    lv_obj_set_size(button, width, height);
    lv_obj_set_pos(button, x, y);
    lv_obj_set_style_radius(button, 8, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x29313a), LV_PART_MAIN);
    lv_obj_add_event_cb(button, callback, LV_EVENT_CLICKED, user_data);
    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(label);
    return button;
}

static void ui_card_climate_delete_event(lv_event_t *event)
{
    ui_card_climate_ctx_t *ctx = (ui_card_climate_ctx_t *)lv_event_get_user_data(event);
    if (ctx != NULL) {
        ctx->deleted = true;
        free(ctx);
    }
}

lv_obj_t *ui_card_climate_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    ui_card_climate_ctx_t *ctx = calloc(1U, sizeof(*ctx));
    if (ctx == NULL) {
        return NULL;
    }
    lv_obj_t *card = lv_obj_create(parent);
    if (card == NULL) {
        free(ctx);
        return NULL;
    }
    lv_obj_set_user_data(card, ctx);
    lv_obj_add_event_cb(card, ui_card_climate_delete_event, LV_EVENT_DELETE, ctx);
    lv_obj_set_size(card, 760, 402);
    lv_obj_set_style_radius(card, 8, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);
    lv_obj_clear_flag(card, LV_OBJ_FLAG_SCROLLABLE);

    ctx->title = lv_label_create(card);
    lv_obj_set_width(ctx->title, 600);
    lv_label_set_long_mode(ctx->title, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(ctx->title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->title, lv_color_hex(0xf4f7fa), LV_PART_MAIN);
    lv_obj_set_pos(ctx->title, 0, 2);

    ctx->power_binding = (ui_card_climate_binding_t){.ctx = ctx, .value = 0};
    ctx->power_button = ui_card_climate_create_button(card, 632, 0, 88, 58, LV_SYMBOL_POWER,
                                                       ui_card_climate_power_event,
                                                       &ctx->power_binding);

    ctx->mode_status = lv_label_create(card);
    lv_obj_set_style_text_font(ctx->mode_status, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->mode_status, lv_color_hex(0xb8c4d0), LV_PART_MAIN);
    lv_obj_set_pos(ctx->mode_status, 0, 40);

    lv_obj_t *current_caption = lv_label_create(card);
    lv_label_set_text(current_caption, "当前温度");
    lv_obj_set_style_text_font(current_caption, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(current_caption, lv_color_hex(0x8fa0b2), LV_PART_MAIN);
    lv_obj_set_pos(current_caption, 0, 76);
    ctx->current_temperature = lv_label_create(card);
    lv_obj_set_style_text_font(ctx->current_temperature, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->current_temperature, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_pos(ctx->current_temperature, 0, 112);

    lv_obj_t *target_caption = lv_label_create(card);
    lv_label_set_text(target_caption, "设定温度");
    lv_obj_set_style_text_font(target_caption, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(target_caption, lv_color_hex(0x8fa0b2), LV_PART_MAIN);
    lv_obj_set_pos(target_caption, 300, 76);
    ctx->target_temperature = lv_label_create(card);
    lv_obj_set_width(ctx->target_temperature, 108);
    lv_obj_set_style_text_font(ctx->target_temperature, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->target_temperature, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_style_text_align(ctx->target_temperature, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_pos(ctx->target_temperature, 400, 121);

    ctx->temperature_bindings[0] = (ui_card_climate_binding_t){.ctx = ctx, .value = -1};
    ctx->temperature_bindings[1] = (ui_card_climate_binding_t){.ctx = ctx, .value = 1};
    ctx->temperature_buttons[0] =
        ui_card_climate_create_button(card, 300, 100, 84, 64, LV_SYMBOL_MINUS,
                                      ui_card_climate_temperature_event,
                                      &ctx->temperature_bindings[0]);
    ctx->temperature_buttons[1] =
        ui_card_climate_create_button(card, 524, 100, 84, 64, LV_SYMBOL_PLUS,
                                      ui_card_climate_temperature_event,
                                      &ctx->temperature_bindings[1]);

    lv_obj_t *mode_caption = lv_label_create(card);
    lv_label_set_text(mode_caption, "模式切换");
    lv_obj_set_style_text_font(mode_caption, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(mode_caption, lv_color_hex(0x8fa0b2), LV_PART_MAIN);
    lv_obj_set_pos(mode_caption, 0, 174);

    for (int i = 0; i < 4; ++i) {
        ctx->mode_bindings[i] = (ui_card_climate_binding_t){.ctx = ctx, .value = i};
        int32_t x = (i % 2) * 370;
        int32_t y = 202 + (i / 2) * 74;
        ctx->mode_buttons[i] =
            ui_card_climate_create_button(card, x, y, 350, 62, s_mode_labels[i],
                                          ui_card_climate_mode_event, &ctx->mode_bindings[i]);
    }

    ctx->meta = lv_label_create(card);
    lv_obj_set_width(ctx->meta, 720);
    lv_label_set_long_mode(ctx->meta, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_font(ctx->meta, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(ctx->meta, lv_color_hex(0x9babbc), LV_PART_MAIN);
    lv_obj_set_pos(ctx->meta, 0, 348);

    ui_card_climate_apply_labels(card, sensor);
    return card;
}

void ui_card_climate_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    if (card != NULL) {
        ui_card_climate_apply_labels(card, sensor);
    }
}
