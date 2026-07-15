#include "ui_page_climate.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ui_card_climate.h"
#include "ui_fonts.h"

static const char *TAG = "ui_climate";

#define UI_CLIMATE_MAX_CARDS 4U

typedef struct {
    char entity_id[128];
    panel_sensor_t sensor;
    bool logged_ready;
} ui_climate_slot_t;

static lv_obj_t *s_root;
static lv_obj_t *s_grid;
static lv_obj_t *s_card;
static lv_obj_t *s_summary;
static ui_climate_slot_t s_slots[UI_CLIMATE_MAX_CARDS];
static size_t s_slot_count;
static size_t s_current_index;
static bool s_ready;

static int ui_page_climate_find_slot(const char *entity_id)
{
    for (size_t i = 0; i < s_slot_count; ++i) {
        if (strcmp(s_slots[i].entity_id, entity_id) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static bool ui_page_climate_build_one(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (sensor->kind != PANEL_SENSOR_KIND_CLIMATE) {
        return true;
    }
    if (s_slot_count >= UI_CLIMATE_MAX_CARDS) {
        return false;
    }
    snprintf(s_slots[s_slot_count].entity_id, sizeof(s_slots[s_slot_count].entity_id), "%s",
             sensor->entity_id);
    s_slots[s_slot_count].sensor = *sensor;
    s_slot_count++;
    return true;
}

static void ui_page_climate_update_pager_locked(void)
{
    if (s_card == NULL || s_summary == NULL || s_slot_count == 0U) {
        return;
    }
    lv_label_set_text_fmt(s_summary, "%u / %u | Home Assistant",
                          (unsigned)(s_current_index + 1U), (unsigned)s_slot_count);
    ui_card_climate_apply_locked(s_card, &s_slots[s_current_index].sensor);
}

static void ui_page_climate_page_event(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED || s_slot_count == 0U) {
        return;
    }
    int direction = (int)(intptr_t)lv_event_get_user_data(event);
    s_current_index = direction < 0
                          ? (s_current_index + s_slot_count - 1U) % s_slot_count
                          : (s_current_index + 1U) % s_slot_count;
    ui_page_climate_update_pager_locked();
}

static lv_obj_t *ui_page_climate_create_page_button(lv_obj_t *parent, int32_t x,
                                                     const char *symbol, int direction)
{
    lv_obj_t *button = lv_button_create(parent);
    if (button == NULL) {
        return NULL;
    }
    lv_obj_set_size(button, 72, 104);
    lv_obj_set_pos(button, x, 155);
    lv_obj_set_style_radius(button, 8, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x29313a), LV_PART_MAIN);
    lv_obj_add_event_cb(button, ui_page_climate_page_event, LV_EVENT_CLICKED,
                        (void *)(intptr_t)direction);
    lv_obj_t *label = lv_label_create(button);
    if (label != NULL) {
        lv_label_set_text(label, symbol);
        lv_obj_set_style_text_font(label, ui_pages_text_font(), LV_PART_MAIN);
        lv_obj_set_style_text_color(label, lv_color_white(), LV_PART_MAIN);
        lv_obj_center(label);
    }
    return button;
}

static void ui_page_climate_apply_on_lvgl(void *user_data)
{
    panel_sensor_t *sensor = (panel_sensor_t *)user_data;
    if (sensor == NULL) {
        return;
    }
    int index = ui_page_climate_find_slot(sensor->entity_id);
    if (index >= 0) {
        ui_climate_slot_t *slot = &s_slots[index];
        slot->sensor = *sensor;
        if (!slot->logged_ready && sensor->available && sensor->has_current_temperature &&
            sensor->has_target_temperature) {
            ESP_LOGI(TAG, "climate ready id=%s mode=%s current=%.1f target=%.1f unit=%s",
                     sensor->entity_id, sensor->value_text, sensor->current_temperature,
                     sensor->target_temperature, sensor->unit);
            slot->logged_ready = true;
        }
        if ((size_t)index == s_current_index) {
            ui_card_climate_apply_locked(s_card, sensor);
        }
    }
    free(sensor);
}

static void ui_page_climate_store_observer(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (sensor == NULL || sensor->kind != PANEL_SENSOR_KIND_CLIMATE) {
        return;
    }
    panel_sensor_t *copy = malloc(sizeof(*copy));
    if (copy == NULL) {
        return;
    }
    *copy = *sensor;
    lv_async_call(ui_page_climate_apply_on_lvgl, copy);
}

esp_err_t ui_page_climate_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_root = lv_obj_create(lv_screen_active());
    ESP_RETURN_ON_FALSE(s_root != NULL, ESP_ERR_NO_MEM, TAG, "climate root alloc failed");
    lv_obj_set_size(s_root, 944, 456);
    lv_obj_align(s_root, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_root, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_root, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_root, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_root, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title = lv_label_create(s_root);
    lv_label_set_text(title, "空调控制");
    lv_obj_set_style_text_font(title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0xe5edf5), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 4, 0);

    s_summary = lv_label_create(s_root);
    lv_label_set_text(s_summary, "-- / -- | Home Assistant");
    lv_obj_set_style_text_font(s_summary, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_summary, lv_color_hex(0x8fa0b2), LV_PART_MAIN);
    lv_obj_align(s_summary, LV_ALIGN_TOP_RIGHT, -4, 0);

    s_grid = lv_obj_create(s_root);
    ESP_RETURN_ON_FALSE(s_grid != NULL, ESP_ERR_NO_MEM, TAG, "climate grid alloc failed");
    lv_obj_set_size(s_grid, 944, 414);
    lv_obj_align(s_grid, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_obj_set_style_bg_opa(s_grid, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_grid, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_grid, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_grid, LV_OBJ_FLAG_SCROLLABLE);

    panel_data_store_iterate(ui_page_climate_build_one, NULL);
    ESP_RETURN_ON_FALSE(s_slot_count == UI_CLIMATE_MAX_CARDS, ESP_ERR_NOT_FOUND, TAG,
                        "expected four climate entities");
    s_card = ui_card_climate_create(s_grid, &s_slots[0].sensor);
    ESP_RETURN_ON_FALSE(s_card != NULL, ESP_ERR_NO_MEM, TAG, "climate card alloc failed");
    lv_obj_align(s_card, LV_ALIGN_TOP_MID, 0, 6);
    ESP_RETURN_ON_FALSE(ui_page_climate_create_page_button(s_grid, 8, LV_SYMBOL_LEFT, -1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "climate previous button alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_climate_create_page_button(s_grid, 864, LV_SYMBOL_RIGHT, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "climate next button alloc failed");
    ui_page_climate_update_pager_locked();
    ESP_RETURN_ON_ERROR(panel_data_store_add_observer(ui_page_climate_store_observer, NULL), TAG,
                        "failed to attach climate observer");
    s_ready = true;
    ESP_LOGW(TAG, "climate page ready devices=%u visible_cards=1", (unsigned)s_slot_count);
    return ESP_OK;
}

void ui_page_climate_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
        ESP_LOGI(TAG, "climate page visible cards=%u", (unsigned)s_slot_count);
    }
}

void ui_page_climate_on_sensor_update(const panel_sensor_t *sensor)
{
    ui_page_climate_store_observer(sensor, NULL);
}

lv_obj_t *ui_page_climate_root(void)
{
    return s_root;
}

bool ui_page_climate_ready(void)
{
    return s_ready;
}

size_t ui_page_climate_card_count(void)
{
    return s_slot_count;
}
