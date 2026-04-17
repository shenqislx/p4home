#include "ui_page_dashboard.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "ui_card_binary.h"
#include "ui_card_multiline.h"
#include "ui_card_numeric.h"
#include "ui_status_banner.h"

static const char *TAG = "ui_dashboard";

typedef struct {
    bool used;
    char entity_id[48];
    panel_sensor_kind_t kind;
    lv_obj_t *card;
} ui_dashboard_slot_t;

static lv_obj_t *s_root;
static lv_obj_t *s_grid;
static bool s_ready;
static ui_dashboard_slot_t s_slots[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES];
static size_t s_slot_count;

static lv_obj_t *ui_page_dashboard_create_card(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    if (sensor->kind == PANEL_SENSOR_KIND_NUMERIC) {
        return ui_card_numeric_create(parent, sensor);
    }
    if (sensor->kind == PANEL_SENSOR_KIND_BINARY) {
        return ui_card_binary_create(parent, sensor);
    }
    return ui_card_multiline_create(parent, sensor);
}

static void ui_page_dashboard_apply_card(lv_obj_t *card, panel_sensor_kind_t kind, const panel_sensor_t *sensor)
{
    if (kind == PANEL_SENSOR_KIND_NUMERIC) {
        ui_card_numeric_apply_locked(card, sensor);
    } else if (kind == PANEL_SENSOR_KIND_BINARY) {
        ui_card_binary_apply_locked(card, sensor);
    } else {
        ui_card_multiline_apply_locked(card, sensor);
    }
}

static int ui_page_dashboard_find_slot(const char *entity_id)
{
    for (size_t i = 0; i < s_slot_count; ++i) {
        if (s_slots[i].used && strcmp(s_slots[i].entity_id, entity_id) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static bool ui_page_dashboard_build_one(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (s_slot_count >= CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES) {
        return false;
    }
    ui_dashboard_slot_t *slot = &s_slots[s_slot_count];
    slot->card = ui_page_dashboard_create_card(s_grid, sensor);
    slot->kind = sensor->kind;
    slot->used = true;
    snprintf(slot->entity_id, sizeof(slot->entity_id), "%s", sensor->entity_id);
    s_slot_count++;
    return true;
}

static void ui_page_dashboard_apply_on_lvgl(void *ctx)
{
    panel_sensor_t *sensor = (panel_sensor_t *)ctx;
    if (sensor == NULL || s_root == NULL) {
        return;
    }
    int index = ui_page_dashboard_find_slot(sensor->entity_id);
    if (index < 0) {
        if (s_slot_count < CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES) {
            ui_dashboard_slot_t *slot = &s_slots[s_slot_count];
            slot->card = ui_page_dashboard_create_card(s_grid, sensor);
            slot->kind = sensor->kind;
            slot->used = true;
            snprintf(slot->entity_id, sizeof(slot->entity_id), "%s", sensor->entity_id);
            s_slot_count++;
        }
    } else {
        ui_page_dashboard_apply_card(s_slots[index].card, s_slots[index].kind, sensor);
    }
    free(sensor);
}

static void ui_page_dashboard_store_observer(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (sensor == NULL) {
        return;
    }
    panel_sensor_t *copy = malloc(sizeof(panel_sensor_t));
    if (copy == NULL) {
        return;
    }
    *copy = *sensor;
    lv_async_call(ui_page_dashboard_apply_on_lvgl, copy);
}

esp_err_t ui_page_dashboard_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    lv_obj_t *screen = lv_screen_active();
    s_root = lv_obj_create(screen);
    lv_obj_set_size(s_root, 944, 456);
    lv_obj_align(s_root, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_root, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_root, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_root, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_root, LV_OBJ_FLAG_SCROLLABLE);

    ESP_RETURN_ON_ERROR(ui_status_banner_init(s_root), TAG, "failed to init dashboard status banner");

    s_grid = lv_obj_create(s_root);
    lv_obj_set_size(s_grid, 944, 456 - CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT - 8);
    lv_obj_align(s_grid, LV_ALIGN_TOP_LEFT, 0, CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT + 8);
    lv_obj_set_style_bg_opa(s_grid, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_grid, 0, LV_PART_MAIN);
    lv_obj_set_layout(s_grid, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(s_grid, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_style_pad_row(s_grid, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_column(s_grid, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_grid, 0, LV_PART_MAIN);

    panel_data_store_iterate(ui_page_dashboard_build_one, NULL);
    panel_data_store_set_observer(ui_page_dashboard_store_observer, NULL);
    s_ready = true;
    return ESP_OK;
}

void ui_page_dashboard_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
    }
}

void ui_page_dashboard_on_sensor_update(const panel_sensor_t *sensor)
{
    ui_page_dashboard_store_observer(sensor, NULL);
}

lv_obj_t *ui_page_dashboard_root(void)
{
    return s_root;
}

bool ui_page_dashboard_ready(void)
{
    return s_ready;
}

size_t ui_page_dashboard_card_count(void)
{
    return s_slot_count;
}
