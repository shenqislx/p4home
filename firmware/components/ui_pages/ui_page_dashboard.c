#include "ui_page_dashboard.h"

#include <inttypes.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ha_client.h"
#include "sdkconfig.h"
#include "time_service.h"
#include "ui_card_action.h"
#include "ui_card_binary.h"
#include "ui_card_multiline.h"
#include "ui_card_numeric.h"
#include "ui_card_trend.h"
#include "ui_card_weather.h"
#include "ui_fonts.h"
#include "ui_status_banner.h"

static const char *TAG = "ui_dashboard";

#define UI_DASHBOARD_CARDS_PER_PAGE 8U
#define UI_DASHBOARD_PAGER_HEIGHT 40
#define UI_DASHBOARD_PAGER_GAP 8

typedef struct {
    bool used;
    bool logged_ready_value;
    char entity_id[128];
    panel_sensor_kind_t kind;
} ui_dashboard_slot_t;

static lv_obj_t *s_root;
static lv_obj_t *s_grid;
static lv_obj_t *s_pager;
static lv_obj_t *s_pager_title;
static lv_obj_t *s_page_label;
static lv_obj_t *s_prev_button;
static lv_obj_t *s_next_button;
static bool s_ready;
static ui_dashboard_slot_t s_slots[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES];
static size_t s_slot_count;
static lv_timer_t *s_refresh_timer;
static uint32_t s_apply_count;
static size_t s_current_page;
static lv_obj_t *s_page_cards[UI_DASHBOARD_CARDS_PER_PAGE];
static panel_sensor_kind_t s_page_card_kinds[UI_DASHBOARD_CARDS_PER_PAGE];

static lv_obj_t *ui_page_dashboard_create_card(lv_obj_t *parent, const panel_sensor_t *sensor);
static void ui_page_dashboard_apply_card(lv_obj_t *card, panel_sensor_kind_t kind,
                                         const panel_sensor_t *sensor);

static void ui_page_dashboard_bind_page_locked(void)
{
    size_t first = s_current_page * UI_DASHBOARD_CARDS_PER_PAGE;
    for (size_t i = 0; i < UI_DASHBOARD_CARDS_PER_PAGE; ++i) {
        size_t slot_index = first + i;
        if (slot_index >= s_slot_count) {
            if (s_page_cards[i] != NULL) {
                lv_obj_add_flag(s_page_cards[i], LV_OBJ_FLAG_HIDDEN);
            }
            continue;
        }

        panel_sensor_t sensor;
        if (!panel_data_store_get_snapshot(s_slots[slot_index].entity_id, &sensor)) {
            continue;
        }

        if (s_page_cards[i] != NULL && s_page_card_kinds[i] != sensor.kind) {
            lv_obj_delete(s_page_cards[i]);
            s_page_cards[i] = NULL;
        }
        if (s_page_cards[i] == NULL) {
            s_page_cards[i] = ui_page_dashboard_create_card(s_grid, &sensor);
            s_page_card_kinds[i] = sensor.kind;
        } else {
            ui_page_dashboard_apply_card(s_page_cards[i], s_page_card_kinds[i], &sensor);
        }
        if (s_page_cards[i] != NULL) {
            lv_obj_clear_flag(s_page_cards[i], LV_OBJ_FLAG_HIDDEN);
        }
    }
}

static size_t ui_page_dashboard_page_count(void)
{
    size_t page_count = (s_slot_count + UI_DASHBOARD_CARDS_PER_PAGE - 1U) /
                        UI_DASHBOARD_CARDS_PER_PAGE;
    return page_count > 0U ? page_count : 1U;
}

static void ui_page_dashboard_update_page_locked(void)
{
    size_t page_count = ui_page_dashboard_page_count();
    if (s_current_page >= page_count) {
        s_current_page = page_count - 1U;
    }

    ui_page_dashboard_bind_page_locked();

    if (s_page_label != NULL) {
        char page_text[24];
        snprintf(page_text, sizeof(page_text), "%u / %u",
                 (unsigned)(s_current_page + 1U), (unsigned)page_count);
        lv_label_set_text(s_page_label, page_text);
    }
    if (s_pager_title != NULL) {
        char title_text[32];
        snprintf(title_text, sizeof(title_text), "Lights  %u", (unsigned)s_slot_count);
        lv_label_set_text(s_pager_title, title_text);
    }
    if (s_prev_button != NULL) {
        if (s_current_page == 0U) {
            lv_obj_add_state(s_prev_button, LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(s_prev_button, LV_STATE_DISABLED);
        }
    }
    if (s_next_button != NULL) {
        if (s_current_page + 1U >= page_count) {
            lv_obj_add_state(s_next_button, LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(s_next_button, LV_STATE_DISABLED);
        }
    }
}

static void ui_page_dashboard_page_button_cb(lv_event_t *event)
{
    intptr_t direction = (intptr_t)lv_event_get_user_data(event);
    size_t page_count = ui_page_dashboard_page_count();
    if (direction < 0 && s_current_page > 0U) {
        s_current_page--;
    } else if (direction > 0 && s_current_page + 1U < page_count) {
        s_current_page++;
    }
    ui_page_dashboard_update_page_locked();
}

static lv_obj_t *ui_page_dashboard_create_page_button(lv_obj_t *parent, const char *symbol,
                                                       lv_align_t align, int32_t x_offset,
                                                       intptr_t direction)
{
    lv_obj_t *button = lv_button_create(parent);
    lv_obj_set_size(button, 44, 36);
    lv_obj_align(button, align, x_offset, 0);
    lv_obj_set_style_radius(button, 8, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x263241), LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x17202b), LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_add_event_cb(button, ui_page_dashboard_page_button_cb, LV_EVENT_CLICKED,
                        (void *)direction);

    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, symbol);
    lv_obj_center(label);
    return button;
}

static lv_obj_t *ui_page_dashboard_create_card(lv_obj_t *parent, const panel_sensor_t *sensor)
{
    if (sensor->kind == PANEL_SENSOR_KIND_TEXT && strcmp(sensor->icon, "weather") == 0) {
        return ui_card_weather_create(parent, sensor);
    }
    if (sensor->kind == PANEL_SENSOR_KIND_NUMERIC) {
        return ui_card_trend_create(parent, sensor);
    }
    if (sensor->kind == PANEL_SENSOR_KIND_ACTION) {
        return ui_card_action_create(parent, sensor);
    }
    if (sensor->kind == PANEL_SENSOR_KIND_BINARY) {
        return ui_card_binary_create(parent, sensor);
    }
    return ui_card_multiline_create(parent, sensor);
}

static void ui_page_dashboard_apply_card(lv_obj_t *card, panel_sensor_kind_t kind, const panel_sensor_t *sensor)
{
    if (sensor->kind == PANEL_SENSOR_KIND_TEXT && strcmp(sensor->icon, "weather") == 0) {
        ui_card_weather_apply_locked(card, sensor);
    } else if (sensor->kind == PANEL_SENSOR_KIND_NUMERIC) {
        ui_card_trend_apply_locked(card, sensor);
    } else if (kind == PANEL_SENSOR_KIND_ACTION) {
        ui_card_action_apply_locked(card, sensor);
    } else if (kind == PANEL_SENSOR_KIND_NUMERIC) {
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
    if (sensor->kind == PANEL_SENSOR_KIND_CLIMATE || sensor->kind == PANEL_SENSOR_KIND_ACTION) {
        return true;
    }
    if (s_slot_count >= CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES) {
        return false;
    }
    ui_dashboard_slot_t *slot = &s_slots[s_slot_count];
    slot->kind = sensor->kind;
    slot->used = true;
    snprintf(slot->entity_id, sizeof(slot->entity_id), "%s", sensor->entity_id);
    s_slot_count++;
    return true;
}

static void ui_page_dashboard_apply_snapshot_locked(const panel_sensor_t *sensor)
{
    if (sensor == NULL || sensor->kind == PANEL_SENSOR_KIND_CLIMATE ||
        sensor->kind == PANEL_SENSOR_KIND_ACTION) {
        return;
    }
    panel_sensor_t display_sensor = *sensor;
    int index = ui_page_dashboard_find_slot(display_sensor.entity_id);
    if (index < 0) {
        if (s_slot_count < CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES) {
            ui_dashboard_slot_t *slot = &s_slots[s_slot_count];
            slot->kind = display_sensor.kind;
            slot->used = true;
            slot->logged_ready_value = false;
            snprintf(slot->entity_id, sizeof(slot->entity_id), "%s", display_sensor.entity_id);
            s_slot_count++;
            index = (int)(s_slot_count - 1U);
            ui_page_dashboard_update_page_locked();
        }
    } else {
        size_t first = s_current_page * UI_DASHBOARD_CARDS_PER_PAGE;
        size_t slot_index = (size_t)index;
        if (slot_index >= first && slot_index < first + UI_DASHBOARD_CARDS_PER_PAGE) {
            size_t page_index = slot_index - first;
            if (s_page_cards[page_index] != NULL) {
                ui_page_dashboard_apply_card(s_page_cards[page_index],
                                             s_page_card_kinds[page_index], &display_sensor);
            }
        }
    }

    s_apply_count++;
    if (s_apply_count <= 8U || (s_apply_count % 16U) == 0U) {
        ESP_LOGW(TAG, "dashboard_apply count=%" PRIu32 " cards=%u children=%u ha=%s id=%.*s value_present=%s",
                 s_apply_count,
                 (unsigned)s_slot_count,
                 (unsigned)ui_page_dashboard_grid_child_count(),
                 ha_client_ready() ? "ready" : "not_ready",
                 24,
                 display_sensor.entity_id,
                 display_sensor.value_text[0] != '\0' ? "yes" : "no");
    }
    if (index >= 0 && ha_client_ready() && display_sensor.value_text[0] != '\0' &&
        !s_slots[index].logged_ready_value) {
        s_slots[index].logged_ready_value = true;
        ESP_LOGW(TAG, "dashboard_value_ready slot=%d id=%.*s value_present=yes unit=%.*s",
                 index,
                 32,
                 display_sensor.entity_id,
                 8,
                 display_sensor.unit);
    }
}

static void ui_page_dashboard_apply_on_lvgl(void *ctx)
{
    panel_sensor_t *sensor = (panel_sensor_t *)ctx;
    if (sensor == NULL) {
        return;
    }
    if (s_root != NULL) {
        ui_page_dashboard_apply_snapshot_locked(sensor);
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

static bool ui_page_dashboard_refresh_one(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    ui_page_dashboard_apply_snapshot_locked(sensor);
    return true;
}

static void ui_page_dashboard_refresh_timer_cb(lv_timer_t *timer)
{
    (void)timer;
    if (s_root == NULL) {
        return;
    }
    panel_data_store_tick_freshness(time_service_now_epoch_ms());
    panel_data_store_iterate(ui_page_dashboard_refresh_one, NULL);
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
    lv_obj_set_size(s_grid, 944,
                    456 - CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT - 8 -
                        UI_DASHBOARD_PAGER_HEIGHT - UI_DASHBOARD_PAGER_GAP);
    lv_obj_align(s_grid, LV_ALIGN_TOP_LEFT, 0, CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT + 8);
    lv_obj_set_style_bg_opa(s_grid, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_grid, 0, LV_PART_MAIN);
    lv_obj_set_layout(s_grid, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(s_grid, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_style_pad_row(s_grid, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_column(s_grid, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_grid, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_grid, LV_OBJ_FLAG_SCROLLABLE);

    s_pager = lv_obj_create(s_root);
    lv_obj_set_size(s_pager, 944, UI_DASHBOARD_PAGER_HEIGHT);
    lv_obj_align(s_pager, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_obj_set_style_bg_opa(s_pager, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_pager, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_pager, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_pager, LV_OBJ_FLAG_SCROLLABLE);

    s_pager_title = lv_label_create(s_pager);
    lv_obj_set_style_text_font(s_pager_title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_pager_title, lv_color_hex(0xa8b3c2), LV_PART_MAIN);
    lv_obj_align(s_pager_title, LV_ALIGN_LEFT_MID, 4, 0);

    s_page_label = lv_label_create(s_pager);
    lv_obj_set_style_text_font(s_page_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_page_label, lv_color_hex(0xe5edf5), LV_PART_MAIN);
    lv_obj_align(s_page_label, LV_ALIGN_CENTER, 0, 0);

    s_prev_button = ui_page_dashboard_create_page_button(s_pager, LV_SYMBOL_LEFT,
                                                         LV_ALIGN_CENTER, -82, -1);
    s_next_button = ui_page_dashboard_create_page_button(s_pager, LV_SYMBOL_RIGHT,
                                                         LV_ALIGN_CENTER, 82, 1);

    panel_data_store_iterate(ui_page_dashboard_build_one, NULL);
    ui_page_dashboard_update_page_locked();
    ESP_RETURN_ON_ERROR(panel_data_store_add_observer(ui_page_dashboard_store_observer, NULL), TAG,
                        "failed to attach dashboard observer");
    s_refresh_timer = lv_timer_create(ui_page_dashboard_refresh_timer_cb, 2000, NULL);
    s_ready = true;
    return ESP_OK;
}

void ui_page_dashboard_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
        ESP_LOGW(TAG, "dashboard_visible=%s cards=%u children=%u",
                 ui_page_dashboard_visible() ? "yes" : "no",
                 (unsigned)s_slot_count,
                 (unsigned)ui_page_dashboard_grid_child_count());
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

size_t ui_page_dashboard_grid_child_count(void)
{
    return s_grid != NULL ? lv_obj_get_child_count(s_grid) : 0U;
}

bool ui_page_dashboard_visible(void)
{
    return s_root != NULL && !lv_obj_has_flag(s_root, LV_OBJ_FLAG_HIDDEN);
}
