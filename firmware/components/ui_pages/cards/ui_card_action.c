#include "ui_card_action.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ha_client.h"
#include "ui_fonts.h"
#include "ui_pixel_theme.h"

static const char *TAG = "ui_card_action";

typedef struct {
    lv_obj_t *title;
    lv_obj_t *button;
    lv_obj_t *button_label;
    lv_obj_t *meta;
    char entity_id[128];
    char domain[16];
    char service[24];
    bool pending;
    bool deleted;
} ui_card_action_ctx_t;

typedef struct {
    ui_card_action_ctx_t *ctx;
} ui_card_action_task_arg_t;

typedef struct {
    ui_card_action_ctx_t *ctx;
    esp_err_t result;
} ui_card_action_result_t;

static const char *ui_card_action_safe_text(const char *text, const char *fallback)
{
    return (text != NULL && text[0] != '\0') ? text : fallback;
}

static bool ui_card_action_is_configured(const panel_sensor_t *sensor)
{
    return sensor != NULL && sensor->control_domain[0] != '\0' &&
           sensor->control_on_service[0] != '\0';
}

static void ui_card_action_set_meta(ui_card_action_ctx_t *ctx, const panel_sensor_t *sensor, const char *status)
{
    char meta_text[64];
    snprintf(meta_text, sizeof(meta_text), "%.16s | %s",
             ui_card_action_safe_text(sensor != NULL ? sensor->group : NULL, "Scene"),
             ui_card_action_safe_text(status, "Ready"));
    lv_label_set_text(ctx->meta, meta_text);
}

static void ui_card_action_apply_result_on_lvgl(void *user_data)
{
    ui_card_action_result_t *result = (ui_card_action_result_t *)user_data;
    if (result == NULL) {
        return;
    }
    ui_card_action_ctx_t *ctx = result->ctx;
    if (ctx != NULL && !ctx->deleted) {
        ctx->pending = false;
        lv_obj_remove_state(ctx->button, LV_STATE_DISABLED);
        lv_label_set_text(ctx->meta, result->result == ESP_OK ? "Action | Sent" : "Action | Failed");
    }
    free(result);
}

static void ui_card_action_task(void *arg)
{
    ui_card_action_task_arg_t *task_arg = (ui_card_action_task_arg_t *)arg;
    if (task_arg == NULL) {
        vTaskDelete(NULL);
        return;
    }

    ui_card_action_ctx_t *ctx = task_arg->ctx;
    char entity_id[sizeof(ctx->entity_id)] = {0};
    char domain[sizeof(ctx->domain)] = {0};
    char service[sizeof(ctx->service)] = {0};
    snprintf(entity_id, sizeof(entity_id), "%s", ctx->entity_id);
    snprintf(domain, sizeof(domain), "%s", ctx->domain);
    snprintf(service, sizeof(service), "%s", ctx->service);
    free(task_arg);

    esp_err_t err = ha_client_call_entity_service(domain, service, entity_id, 0);
    ESP_LOGI(TAG, "action call entity=%s service=%s.%s result=%s",
             entity_id, domain, service, esp_err_to_name(err));

    ui_card_action_result_t *result = calloc(1U, sizeof(*result));
    if (result != NULL) {
        result->ctx = ctx;
        result->result = err;
        lv_async_call(ui_card_action_apply_result_on_lvgl, result);
    }
    vTaskDelete(NULL);
}

static void ui_card_action_click_cb(lv_event_t *event)
{
    ui_card_action_ctx_t *ctx = (ui_card_action_ctx_t *)lv_event_get_user_data(event);
    if (ctx == NULL || ctx->pending || ctx->deleted) {
        return;
    }

    ui_card_action_task_arg_t *task_arg = calloc(1U, sizeof(*task_arg));
    if (task_arg == NULL) {
        return;
    }
    task_arg->ctx = ctx;
    ctx->pending = true;
    lv_obj_add_state(ctx->button, LV_STATE_DISABLED);
    lv_label_set_text(ctx->meta, "Action | Sending");

    BaseType_t ok = xTaskCreate(ui_card_action_task, "p4home_action", 4096, task_arg,
                                tskIDLE_PRIORITY + 3, NULL);
    if (ok != pdPASS) {
        ctx->pending = false;
        lv_obj_remove_state(ctx->button, LV_STATE_DISABLED);
        lv_label_set_text(ctx->meta, "Action | Failed");
        free(task_arg);
    }
}

static void ui_card_action_delete_cb(lv_event_t *event)
{
    ui_card_action_ctx_t *ctx = (ui_card_action_ctx_t *)lv_event_get_user_data(event);
    if (ctx != NULL) {
        ctx->deleted = true;
        free(ctx);
    }
}

static void ui_card_action_set_labels(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_action_ctx_t *ctx = (ui_card_action_ctx_t *)lv_obj_get_user_data(card);
    if (ctx == NULL || sensor == NULL) {
        return;
    }

    lv_label_set_text(ctx->title, ui_card_action_safe_text(sensor->label, sensor->entity_id));
    if (ui_card_action_is_configured(sensor)) {
        snprintf(ctx->entity_id, sizeof(ctx->entity_id), "%s", sensor->entity_id);
        snprintf(ctx->domain, sizeof(ctx->domain), "%s", sensor->control_domain);
        snprintf(ctx->service, sizeof(ctx->service), "%s", sensor->control_on_service);
        lv_obj_remove_state(ctx->button, LV_STATE_DISABLED);
        ui_card_action_set_meta(ctx, sensor, ctx->pending ? "Sending" : "Ready");
    } else {
        lv_obj_add_state(ctx->button, LV_STATE_DISABLED);
        ui_card_action_set_meta(ctx, sensor, "Unavailable");
    }
}

lv_obj_t *ui_card_action_create(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    ui_card_action_ctx_t *ctx = calloc(1U, sizeof(*ctx));
    if (ctx == NULL) {
        return NULL;
    }

    lv_obj_t *card = lv_obj_create(parent);
    lv_obj_set_user_data(card, ctx);
    lv_obj_add_event_cb(card, ui_card_action_delete_cb, LV_EVENT_DELETE, ctx);
    lv_obj_set_size(card, 280, 120);
    ui_pixel_style_card(card, UI_PIXEL_COLOR_PANEL, UI_PIXEL_COLOR_GRID);
    lv_obj_set_style_pad_all(card, 16, LV_PART_MAIN);

    ctx->title = lv_label_create(card);
    lv_obj_set_width(ctx->title, 156);
    lv_label_set_long_mode(ctx->title, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_color(ctx->title, lv_color_hex(0xe5edf5), LV_PART_MAIN);
    lv_obj_set_style_text_font(ctx->title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_align(ctx->title, LV_ALIGN_TOP_LEFT, 0, 0);

    ctx->button = lv_button_create(card);
    lv_obj_set_size(ctx->button, 82, 44);
    lv_obj_align(ctx->button, LV_ALIGN_TOP_RIGHT, 0, 0);
    ui_pixel_style_button(ctx->button, 0x164e63, UI_PIXEL_COLOR_CYAN);
    lv_obj_add_event_cb(ctx->button, ui_card_action_click_cb, LV_EVENT_CLICKED, ctx);

    ctx->button_label = lv_label_create(ctx->button);
    lv_label_set_text(ctx->button_label, "Run");
    lv_obj_set_style_text_color(ctx->button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_style_text_font(ctx->button_label, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_center(ctx->button_label);

    ctx->meta = lv_label_create(card);
    lv_obj_set_width(ctx->meta, 248);
    lv_label_set_long_mode(ctx->meta, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_color(ctx->meta, lv_color_hex(0xa8b3c2), LV_PART_MAIN);
    lv_obj_set_style_text_font(ctx->meta, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_align(ctx->meta, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    ui_card_action_set_labels(card, sensor);
    return card;
}

void ui_card_action_apply_locked(lv_obj_t *card, const panel_sensor_t *sensor)
{
    ui_card_action_set_labels(card, sensor);
}
