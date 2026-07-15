#include "ui_page_quick_modes.h"

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ha_client.h"
#include "panel_data_store.h"
#include "ui_fonts.h"

static const char *TAG = "ui_quick_modes";

#define UI_QUICK_MODE_COUNT 4U

typedef struct {
    const char *entity_id;
    const char *title;
    const char *summary;
    uint32_t color;
} ui_quick_mode_def_t;

typedef struct {
    lv_obj_t *button;
    lv_obj_t *state;
    bool available;
} ui_quick_mode_view_t;

typedef struct {
    size_t index;
} ui_quick_mode_task_arg_t;

typedef struct {
    size_t index;
    esp_err_t result;
} ui_quick_mode_result_t;

static const ui_quick_mode_def_t s_modes[UI_QUICK_MODE_COUNT] = {
    {
        .entity_id = "script.p4home_home_mode",
        .title = "回家模式",
        .summary = "迎宾照明  风管机制冷",
        .color = 0x24624a,
    },
    {
        .entity_id = "script.p4home_away_mode",
        .title = "离家模式",
        .summary = "全屋灯具与空调关闭",
        .color = 0x424b55,
    },
    {
        .entity_id = "script.p4home_sleep_mode",
        .title = "睡眠模式",
        .summary = "全屋熄灯  主卧制冷",
        .color = 0x28567a,
    },
    {
        .entity_id = "script.p4home_comfort_mode",
        .title = "舒适模式",
        .summary = "重点区域照明",
        .color = 0x896a25,
    },
};

static lv_obj_t *s_root;
static lv_obj_t *s_status;
static ui_quick_mode_view_t s_views[UI_QUICK_MODE_COUNT];
static int s_pending_index = -1;
static bool s_has_action_status;
static bool s_ready;

static int ui_page_quick_modes_find(const char *entity_id)
{
    if (entity_id == NULL) {
        return -1;
    }
    for (size_t i = 0; i < UI_QUICK_MODE_COUNT; ++i) {
        if (strcmp(s_modes[i].entity_id, entity_id) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static void ui_page_quick_modes_refresh_buttons(void)
{
    size_t available_count = 0U;
    for (size_t i = 0; i < UI_QUICK_MODE_COUNT; ++i) {
        available_count += s_views[i].available ? 1U : 0U;
        bool disabled = s_pending_index >= 0 || !s_views[i].available;
        if (disabled) {
            lv_obj_add_state(s_views[i].button, LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(s_views[i].button, LV_STATE_DISABLED);
        }
        if (s_pending_index == (int)i) {
            lv_label_set_text(s_views[i].state, "正在执行");
        } else {
            lv_label_set_text(s_views[i].state, s_views[i].available ? "可用" : "等待连接");
        }
    }
    if (s_pending_index < 0 && s_status != NULL) {
        if (available_count < UI_QUICK_MODE_COUNT) {
            s_has_action_status = false;
            lv_label_set_text(s_status, "等待 Home Assistant");
        } else if (!s_has_action_status) {
            lv_label_set_text(s_status, "Home Assistant 已连接");
        }
    }
}

static void ui_page_quick_modes_apply_result(void *user_data)
{
    ui_quick_mode_result_t *result = (ui_quick_mode_result_t *)user_data;
    if (result == NULL || result->index >= UI_QUICK_MODE_COUNT) {
        free(result);
        return;
    }

    s_pending_index = -1;
    ui_page_quick_modes_refresh_buttons();
    if (result->result == ESP_OK) {
        lv_label_set_text_fmt(s_status, "%s已发送", s_modes[result->index].title);
        lv_label_set_text(s_views[result->index].state, "已发送");
    } else {
        lv_label_set_text_fmt(s_status, "%s执行失败", s_modes[result->index].title);
        lv_label_set_text(s_views[result->index].state, "执行失败");
    }
    free(result);
}

static void ui_page_quick_modes_task(void *arg)
{
    ui_quick_mode_task_arg_t *task_arg = (ui_quick_mode_task_arg_t *)arg;
    if (task_arg == NULL || task_arg->index >= UI_QUICK_MODE_COUNT) {
        free(task_arg);
        vTaskDelete(NULL);
        return;
    }

    size_t index = task_arg->index;
    free(task_arg);
    esp_err_t err = ha_client_call_entity_service("script", "turn_on",
                                                  s_modes[index].entity_id, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "quick mode failed entity=%s result=%s",
                 s_modes[index].entity_id, esp_err_to_name(err));
    }

    ui_quick_mode_result_t *result = calloc(1U, sizeof(*result));
    if (result != NULL) {
        result->index = index;
        result->result = err;
        lv_async_call(ui_page_quick_modes_apply_result, result);
    }
    vTaskDelete(NULL);
}

static void ui_page_quick_modes_click(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED || s_pending_index >= 0) {
        return;
    }

    size_t index = (size_t)(uintptr_t)lv_event_get_user_data(event);
    if (index >= UI_QUICK_MODE_COUNT || !s_views[index].available) {
        return;
    }

    ui_quick_mode_task_arg_t *arg = calloc(1U, sizeof(*arg));
    if (arg == NULL) {
        return;
    }
    arg->index = index;
    s_pending_index = (int)index;
    s_has_action_status = true;
    lv_label_set_text_fmt(s_status, "正在执行%s", s_modes[index].title);
    ui_page_quick_modes_refresh_buttons();
    if (xTaskCreate(ui_page_quick_modes_task, "p4home_quick", 4096, arg,
                    tskIDLE_PRIORITY + 3, NULL) != pdPASS) {
        s_pending_index = -1;
        free(arg);
        ui_page_quick_modes_refresh_buttons();
        lv_label_set_text(s_status, "执行失败");
    }
}

static void ui_page_quick_modes_apply_sensor(void *user_data)
{
    panel_sensor_t *sensor = (panel_sensor_t *)user_data;
    if (sensor == NULL) {
        return;
    }
    int index = ui_page_quick_modes_find(sensor->entity_id);
    if (index >= 0) {
        s_views[index].available = sensor->available;
        if (s_pending_index < 0) {
            ui_page_quick_modes_refresh_buttons();
        }
    }
    free(sensor);
}

static void ui_page_quick_modes_store_observer(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (sensor == NULL || ui_page_quick_modes_find(sensor->entity_id) < 0) {
        return;
    }
    panel_sensor_t *copy = malloc(sizeof(*copy));
    if (copy == NULL) {
        return;
    }
    *copy = *sensor;
    lv_async_call(ui_page_quick_modes_apply_sensor, copy);
}

static lv_obj_t *ui_page_quick_modes_create_button(lv_obj_t *parent, size_t index,
                                                    int32_t x, int32_t y)
{
    lv_obj_t *button = lv_button_create(parent);
    if (button == NULL) {
        return NULL;
    }
    lv_obj_set_size(button, 456, 190);
    lv_obj_set_pos(button, x, y);
    lv_obj_set_style_radius(button, 8, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(s_modes[index].color), LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x252b32), LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_add_event_cb(button, ui_page_quick_modes_click, LV_EVENT_CLICKED,
                        (void *)(uintptr_t)index);

    lv_obj_t *title = lv_label_create(button);
    lv_label_set_text(title, s_modes[index].title);
    lv_obj_set_style_text_font(title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_white(), LV_PART_MAIN);
    lv_obj_set_pos(title, 8, 10);

    lv_obj_t *summary = lv_label_create(button);
    lv_label_set_text(summary, s_modes[index].summary);
    lv_obj_set_style_text_font(summary, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(summary, lv_color_hex(0xdce5ed), LV_PART_MAIN);
    lv_obj_set_pos(summary, 8, 64);

    s_views[index].state = lv_label_create(button);
    lv_obj_set_style_text_font(s_views[index].state, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_views[index].state, lv_color_hex(0xb9c6d2), LV_PART_MAIN);
    lv_obj_set_pos(s_views[index].state, 8, 124);
    return button;
}

esp_err_t ui_page_quick_modes_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_root = lv_obj_create(lv_screen_active());
    ESP_RETURN_ON_FALSE(s_root != NULL, ESP_ERR_NO_MEM, TAG, "quick modes root alloc failed");
    lv_obj_set_size(s_root, 944, 456);
    lv_obj_align(s_root, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_root, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_root, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_root, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_root, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title = lv_label_create(s_root);
    lv_label_set_text(title, "快捷模式");
    lv_obj_set_style_text_font(title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(0xe5edf5), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 4, 0);

    s_status = lv_label_create(s_root);
    lv_label_set_text(s_status, "等待 Home Assistant");
    lv_obj_set_width(s_status, 420);
    lv_obj_set_style_text_align(s_status, LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
    lv_obj_set_style_text_font(s_status, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_status, lv_color_hex(0x9babbc), LV_PART_MAIN);
    lv_obj_align(s_status, LV_ALIGN_TOP_RIGHT, -4, 0);

    lv_obj_t *grid = lv_obj_create(s_root);
    ESP_RETURN_ON_FALSE(grid != NULL, ESP_ERR_NO_MEM, TAG, "quick modes grid alloc failed");
    lv_obj_set_size(grid, 944, 414);
    lv_obj_align(grid, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_obj_set_style_bg_opa(grid, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(grid, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(grid, 0, LV_PART_MAIN);
    lv_obj_clear_flag(grid, LV_OBJ_FLAG_SCROLLABLE);

    for (size_t i = 0; i < UI_QUICK_MODE_COUNT; ++i) {
        int32_t x = (i % 2U) == 0U ? 0 : 488;
        int32_t y = i < 2U ? 0 : 220;
        s_views[i].button = ui_page_quick_modes_create_button(grid, i, x, y);
        ESP_RETURN_ON_FALSE(s_views[i].button != NULL, ESP_ERR_NO_MEM, TAG,
                            "quick mode button alloc failed");
        panel_sensor_t sensor;
        if (panel_data_store_get_snapshot(s_modes[i].entity_id, &sensor)) {
            s_views[i].available = sensor.available;
        }
    }
    ui_page_quick_modes_refresh_buttons();
    ESP_RETURN_ON_ERROR(panel_data_store_add_observer(ui_page_quick_modes_store_observer, NULL),
                        TAG, "failed to attach quick modes observer");
    s_ready = true;
    ESP_LOGW(TAG, "quick modes page ready buttons=%u", (unsigned)UI_QUICK_MODE_COUNT);
    return ESP_OK;
}

void ui_page_quick_modes_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
    }
}

lv_obj_t *ui_page_quick_modes_root(void)
{
    return s_root;
}

bool ui_page_quick_modes_ready(void)
{
    return s_ready;
}
