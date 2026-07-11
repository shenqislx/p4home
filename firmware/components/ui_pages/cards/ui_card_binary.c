#include "ui_card_binary.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ha_client.h"
#include "ui_fonts.h"

static const char *TAG = "ui_card_binary";

typedef struct {
    lv_obj_t *title;
    lv_obj_t *value;
    lv_obj_t *meta;
    lv_obj_t *toggle;
    char entity_id[128];
    char domain[16];
    char on_service[24];
    char off_service[24];
    char last_error[32];
    bool pending;
    bool deleted;
} ui_card_binary_ctx_t;

typedef struct {
    ui_card_binary_ctx_t *ctx;
    bool target_on;
} ui_card_binary_call_task_arg_t;

typedef struct {
    ui_card_binary_ctx_t *ctx;
    bool target_on;
    esp_err_t result;
} ui_card_binary_call_result_t;

static const char *ui_card_binary_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static const char *ui_card_binary_status_text(const panel_sensor_t *sensor)
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

static void ui_card_binary_style_labels(lv_obj_t *title, lv_obj_t *value, lv_obj_t *meta)
{
    lv_obj_set_style_text_color(title, lv_color_hex(0xe5edf5), LV_PART_MAIN);
    lv_obj_set_style_text_color(value, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_style_text_color(meta, lv_color_hex(0xa8b3c2), LV_PART_MAIN);
    lv_obj_set_style_text_font(title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_font(value, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_font(meta, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_width(title, 188);
    lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(value, 188);
    lv_label_set_long_mode(value, LV_LABEL_LONG_DOT);
    lv_obj_set_width(meta, 188);
    lv_label_set_long_mode(meta, LV_LABEL_LONG_DOT);
}

static void ui_card_binary_set_visual(lv_obj_t *card, const panel_sensor_t *sensor, bool on)
{
    uint32_t color = on ? 0x16331f : 0x2a1f24;
    uint32_t border = 0x334155;
    uint32_t border_width = 0;
    if (!sensor->available) {
        color = 0x2f1f24;
        border = 0x7f1d1d;
        border_width = 2;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_UNKNOWN) {
        color = 0x202632;
        border = 0x475569;
        border_width = 2;
    } else if (sensor->freshness == PANEL_SENSOR_FRESHNESS_STALE) {
        color = 0x30291d;
        border = 0x854d0e;
        border_width = 2;
    }
    lv_obj_set_style_bg_color(card, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_border_color(card, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_border_width(card, border_width, LV_PART_MAIN);
}

static void ui_card_binary_set_labels(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_binary_ctx_t *ctx = (ui_card_binary_ctx_t *)lv_obj_get_user_data(card);
    if (ctx == NULL || sensor == NULL) {
        return;
    }

    bool on = ui_card_binary_is_on(sensor);
    bool controllable = ui_card_binary_is_controllable(sensor);
    char meta_text[64];

    lv_label_set_text(ctx->title, ui_card_binary_safe_text(sensor->label, sensor->entity_id));
    lv_label_set_text(ctx->value, !sensor->available ? "Offline" : (on ? "On" : "Off"));

    if (controllable) {
        snprintf(ctx->entity_id, sizeof(ctx->entity_id), "%s", sensor->entity_id);
        snprintf(ctx->domain, sizeof(ctx->domain), "%s", sensor->control_domain);
        snprintf(ctx->on_service, sizeof(ctx->on_service), "%s", sensor->control_on_service);
        snprintf(ctx->off_service, sizeof(ctx->off_service), "%s", sensor->control_off_service);
    }

    if (ctx->pending) {
        snprintf(meta_text, sizeof(meta_text), "%.16s | Sending",
                 ui_card_binary_safe_text(sensor->group, "Default"));
    } else if (ctx->last_error[0] != '\0') {
        snprintf(meta_text, sizeof(meta_text), "%.16s | %.16s",
                 ui_card_binary_safe_text(sensor->group, "Default"), ctx->last_error);
    } else {
        snprintf(meta_text, sizeof(meta_text), "%.16s | %s",
                 ui_card_binary_safe_text(sensor->group, "Default"),
                 ui_card_binary_status_text(sensor));
    }
    lv_label_set_text(ctx->meta, meta_text);

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

static void ui_card_binary_apply_call_result_on_lvgl(void *user_data)
{
    ui_card_binary_call_result_t *result = (ui_card_binary_call_result_t *)user_data;
    if (result == NULL) {
        return;
    }
    ui_card_binary_ctx_t *ctx = result->ctx;
    if (ctx != NULL && !ctx->deleted) {
        ctx->pending = false;
        if (result->result == ESP_OK) {
            ctx->last_error[0] = '\0';
            lv_label_set_text(ctx->meta, "Control | Sent");
        } else {
            snprintf(ctx->last_error, sizeof(ctx->last_error), "Failed");
            lv_label_set_text(ctx->meta, "Control | Failed");
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
    char domain[sizeof(ctx->domain)] = {0};
    char service[sizeof(ctx->on_service)] = {0};
    char entity_id[sizeof(ctx->entity_id)] = {0};
    snprintf(domain, sizeof(domain), "%s", ctx->domain);
    snprintf(service, sizeof(service), "%s", target_on ? ctx->on_service : ctx->off_service);
    snprintf(entity_id, sizeof(entity_id), "%s", ctx->entity_id);
    free(task_arg);

    esp_err_t err = ha_client_call_entity_service(domain, service, entity_id, 0);
    ESP_LOGI(TAG, "control call entity=%s service=%s.%s result=%s",
             entity_id, domain, service, esp_err_to_name(err));

    ui_card_binary_call_result_t *result = calloc(1U, sizeof(*result));
    if (result != NULL) {
        result->ctx = ctx;
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

    ui_card_binary_call_task_arg_t *task_arg = calloc(1U, sizeof(*task_arg));
    if (task_arg == NULL) {
        return;
    }
    task_arg->ctx = ctx;
    task_arg->target_on = lv_obj_has_state(ctx->toggle, LV_STATE_CHECKED);
    ctx->pending = true;
    ctx->last_error[0] = '\0';
    lv_obj_add_state(ctx->toggle, LV_STATE_DISABLED);
    lv_label_set_text(ctx->meta, "Control | Sending");

    BaseType_t ok = xTaskCreate(ui_card_binary_call_task, "p4home_ctl", 4096, task_arg,
                                tskIDLE_PRIORITY + 3, NULL);
    if (ok != pdPASS) {
        ctx->pending = false;
        snprintf(ctx->last_error, sizeof(ctx->last_error), "Failed");
        lv_obj_remove_state(ctx->toggle, LV_STATE_DISABLED);
        lv_label_set_text(ctx->meta, "Control | Failed");
        free(task_arg);
    }
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
    lv_obj_set_user_data(card, ctx);
    lv_obj_add_event_cb(card, ui_card_binary_delete_cb, LV_EVENT_DELETE, ctx);
    lv_obj_set_size(card, 220, 180);
    lv_obj_set_style_border_width(card, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(card, 16, LV_PART_MAIN);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(card, 22, LV_PART_MAIN);
    lv_obj_set_style_shadow_spread(card, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(card, lv_color_hex(0x22c55e), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(card, LV_OPA_20, LV_PART_MAIN);

    ctx->title = lv_label_create(card);
    lv_obj_align(ctx->title, LV_ALIGN_TOP_LEFT, 0, 0);
    ctx->value = lv_label_create(card);
    lv_obj_align(ctx->value, LV_ALIGN_LEFT_MID, 0, 4);
    ctx->meta = lv_label_create(card);
    lv_obj_align(ctx->meta, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    if (ui_card_binary_is_controllable(sensor)) {
        ctx->toggle = lv_switch_create(card);
        lv_obj_set_size(ctx->toggle, 64, 36);
        lv_obj_align(ctx->toggle, LV_ALIGN_RIGHT_MID, 0, 4);
        lv_obj_add_event_cb(ctx->toggle, ui_card_binary_toggle_event_cb, LV_EVENT_VALUE_CHANGED, ctx);
        lv_obj_set_width(ctx->value, 112);
    }

    ui_card_binary_style_labels(ctx->title, ctx->value, ctx->meta);
    ui_card_binary_set_labels(card, sensor);
    return card;
}

void ui_card_binary_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_binary_set_labels(card, sensor);
}
