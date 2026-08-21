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
#include "ui_async.h"
#include "ui_fonts.h"
#include "ui_pixel_theme.h"

static const char *TAG = "ui_quick_modes";

#define UI_QUICK_MODE_COUNT 4U
#define UI_QUICK_MODE_CARD_WIDTH 448
#define UI_QUICK_MODE_CARD_HEIGHT 182

typedef struct {
    const char *entity_id;
    const char *title;
    uint32_t color;
    uint32_t accent;
} ui_quick_mode_def_t;

typedef struct {
    lv_obj_t *button;
    lv_obj_t *indicator_glow;
    lv_obj_t *indicator;
    uint32_t indicator_color;
    bool available;
} ui_quick_mode_view_t;

typedef struct {
    size_t index;
    esp_err_t result;
} ui_quick_mode_task_arg_t;

static const ui_quick_mode_def_t s_modes[UI_QUICK_MODE_COUNT] = {
    {
        .entity_id = "script.p4home_home_mode",
        .title = "回家",
        .color = 0x24624a,
        .accent = UI_PIXEL_COLOR_CYAN,
    },
    {
        .entity_id = "script.p4home_away_mode",
        .title = "离家",
        .color = 0x424b55,
        .accent = UI_PIXEL_COLOR_MUTED,
    },
    {
        .entity_id = "script.p4home_sleep_mode",
        .title = "睡眠",
        .color = 0x28567a,
        .accent = UI_PIXEL_COLOR_BLUE,
    },
    {
        .entity_id = "script.p4home_comfort_mode",
        .title = "舒适",
        .color = 0x896a25,
        .accent = UI_PIXEL_COLOR_YELLOW,
    },
};

static lv_obj_t *s_root;
static lv_obj_t *s_status;
static lv_obj_t *s_director_depth;
static lv_obj_t *s_director;
static lv_obj_t *s_director_title;
static lv_obj_t *s_director_stage;
static lv_obj_t *s_director_progress;
static lv_obj_t *s_director_steps[3];
static lv_timer_t *s_director_timer;
static ui_quick_mode_view_t s_views[UI_QUICK_MODE_COUNT];
static int s_pending_index = -1;
static bool s_has_action_status;
static bool s_director_active;
static bool s_director_call_finished;
static bool s_director_call_success;
static bool s_director_result_ready;
static uint32_t s_director_tick;
static uint32_t s_director_result_ticks;
static bool s_ready;

static void ui_page_quick_modes_set_step(size_t index, uint32_t color)
{
    if (index >= 3U || s_director_steps[index] == NULL) {
        return;
    }
    lv_obj_set_style_bg_color(s_director_steps[index], lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_director_steps[index], lv_color_hex(color), LV_PART_MAIN);
}

static void ui_page_quick_modes_director_show(size_t index)
{
    if (s_director == NULL || index >= UI_QUICK_MODE_COUNT) {
        return;
    }
    s_director_tick = 0U;
    s_director_result_ticks = 0U;
    s_director_call_finished = false;
    s_director_call_success = false;
    s_director_result_ready = false;
    s_director_active = true;
    lv_label_set_text_fmt(s_director_title, "%s场景 // DIRECTOR",
                          s_modes[index].title);
    lv_label_set_text(s_director_stage, "01 // 确认场景可用");
    lv_bar_set_value(s_director_progress, 8, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(s_director_progress,
                              lv_color_hex(s_modes[index].accent), LV_PART_INDICATOR);
    lv_obj_set_style_border_color(s_director, lv_color_hex(s_modes[index].accent),
                                  LV_PART_MAIN);
    ui_page_quick_modes_set_step(0, s_modes[index].accent);
    ui_page_quick_modes_set_step(1, UI_PIXEL_COLOR_GRID);
    ui_page_quick_modes_set_step(2, UI_PIXEL_COLOR_GRID);
    lv_obj_clear_flag(s_director, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s_director_depth, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s_director_depth);
    lv_obj_move_foreground(s_director);
    if (s_director_timer != NULL) {
        lv_timer_reset(s_director_timer);
        lv_timer_resume(s_director_timer);
    }
}

static void ui_page_quick_modes_director_finalize(bool success)
{
    s_director_result_ready = true;
    s_director_result_ticks = 0U;
    lv_bar_set_value(s_director_progress, 100, LV_ANIM_ON);
    if (success) {
        lv_label_set_text(s_director_title, "场景已启程 // SENT");
        lv_label_set_text(s_director_stage, "指令已交给 Home Assistant");
        lv_obj_set_style_border_color(s_director, lv_color_hex(UI_PIXEL_COLOR_CYAN),
                                      LV_PART_MAIN);
        lv_obj_set_style_bg_color(s_director_progress,
                                  lv_color_hex(UI_PIXEL_COLOR_CYAN), LV_PART_INDICATOR);
        for (size_t i = 0; i < 3U; ++i) {
            ui_page_quick_modes_set_step(i, UI_PIXEL_COLOR_CYAN);
        }
    } else {
        lv_label_set_text(s_director_title, "场景未发送 // FAILED");
        lv_label_set_text(s_director_stage, "连接或服务调用失败");
        lv_obj_set_style_border_color(s_director, lv_color_hex(UI_PIXEL_COLOR_RED),
                                      LV_PART_MAIN);
        lv_obj_set_style_bg_color(s_director_progress,
                                  lv_color_hex(UI_PIXEL_COLOR_RED), LV_PART_INDICATOR);
        ui_page_quick_modes_set_step(2, UI_PIXEL_COLOR_RED);
    }
}

static void ui_page_quick_modes_director_apply_result(bool success)
{
    s_director_call_finished = true;
    s_director_call_success = success;
    if (s_director_tick >= 4U) {
        ui_page_quick_modes_director_finalize(success);
    }
}

static void ui_page_quick_modes_director_timer_cb(lv_timer_t *timer)
{
    if (s_director_result_ready) {
        s_director_result_ticks++;
        if (s_director_result_ticks >= 6U) {
            lv_obj_add_flag(s_director, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s_director_depth, LV_OBJ_FLAG_HIDDEN);
            s_director_active = false;
            lv_timer_pause(timer);
        }
        return;
    }

    s_director_tick++;
    if (s_director_tick == 2U) {
        lv_label_set_text(s_director_stage, "02 // 发送至 Home Assistant");
        lv_bar_set_value(s_director_progress, 36, LV_ANIM_ON);
        ui_page_quick_modes_set_step(1, UI_PIXEL_COLOR_YELLOW);
    } else if (s_director_tick >= 4U) {
        lv_label_set_text(s_director_stage, "03 // 等待家庭响应");
        lv_bar_set_value(s_director_progress, 68, LV_ANIM_ON);
        ui_page_quick_modes_set_step(2, UI_PIXEL_COLOR_BLUE);
    }
    if (s_director_tick >= 4U && s_director_call_finished) {
        ui_page_quick_modes_director_finalize(s_director_call_success);
    }
}

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

static void ui_page_quick_modes_set_indicator(size_t index, uint32_t color)
{
    if (index >= UI_QUICK_MODE_COUNT || s_views[index].indicator == NULL) {
        return;
    }
    if (s_views[index].indicator_color == color) {
        return;
    }
    s_views[index].indicator_color = color;
    if (s_views[index].indicator_glow != NULL) {
        lv_obj_set_style_bg_color(s_views[index].indicator_glow, lv_color_hex(color),
                                  LV_PART_MAIN);
    }
    lv_obj_set_style_bg_color(s_views[index].indicator, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_views[index].indicator, lv_color_hex(UI_PIXEL_COLOR_INK),
                                  LV_PART_MAIN);
}

static void ui_page_quick_modes_refresh_buttons(void)
{
    size_t available_count = 0U;
    for (size_t i = 0; i < UI_QUICK_MODE_COUNT; ++i) {
        available_count += s_views[i].available ? 1U : 0U;
        /* A pending action is rejected by the event handler. Do not restyle all
         * four large cards from inside a click callback. */
        bool disabled = !s_views[i].available;
        if (disabled) {
            lv_obj_add_state(s_views[i].button, LV_STATE_DISABLED);
        } else {
            lv_obj_remove_state(s_views[i].button, LV_STATE_DISABLED);
        }
        uint32_t indicator_color = s_pending_index == (int)i
                                       ? UI_PIXEL_COLOR_YELLOW
                                       : (s_views[i].available ? s_modes[i].accent
                                                               : UI_PIXEL_COLOR_GRID);
        ui_page_quick_modes_set_indicator(i, indicator_color);
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
    ui_quick_mode_task_arg_t *result = (ui_quick_mode_task_arg_t *)user_data;
    if (result == NULL || result->index >= UI_QUICK_MODE_COUNT) {
        free(result);
        return;
    }

    s_pending_index = -1;
    ui_page_quick_modes_refresh_buttons();
    if (result->result == ESP_OK) {
        lv_label_set_text_fmt(s_status, "%s已发送", s_modes[result->index].title);
        ui_page_quick_modes_set_indicator(result->index, s_modes[result->index].accent);
    } else {
        lv_label_set_text_fmt(s_status, "%s执行失败", s_modes[result->index].title);
        ui_page_quick_modes_set_indicator(result->index, UI_PIXEL_COLOR_RED);
    }
    ui_page_quick_modes_director_apply_result(result->result == ESP_OK);
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
    task_arg->result = ha_client_call_entity_service("script", "turn_on",
                                                     s_modes[index].entity_id, 0);
    if (task_arg->result != ESP_OK) {
        ESP_LOGW(TAG, "quick mode failed entity=%s result=%s",
                 s_modes[index].entity_id, esp_err_to_name(task_arg->result));
    }

    if (ui_async_call(ui_page_quick_modes_apply_result, task_arg) != LV_RESULT_OK) {
        free(task_arg);
    }
    vTaskDelete(NULL);
}

static void ui_page_quick_modes_click(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED ||
        s_pending_index >= 0 || s_director_active) {
        return;
    }

    size_t index = (size_t)(uintptr_t)lv_event_get_user_data(event);
    if (index >= UI_QUICK_MODE_COUNT || !s_views[index].available) {
        return;
    }

    ESP_LOGW(TAG, "VERIFY:ui:mode_click:PASS index=%u title=%s",
             (unsigned)index, s_modes[index].title);

    ui_quick_mode_task_arg_t *arg = calloc(1U, sizeof(*arg));
    if (arg == NULL) {
        return;
    }
    arg->index = index;
    s_pending_index = (int)index;
    s_has_action_status = true;
    lv_label_set_text_fmt(s_status, "正在执行%s", s_modes[index].title);
    ui_page_quick_modes_director_show(index);
    ui_page_quick_modes_refresh_buttons();
    if (xTaskCreate(ui_page_quick_modes_task, "p4home_quick", 4096, arg,
                    tskIDLE_PRIORITY + 3, NULL) != pdPASS) {
        s_pending_index = -1;
        free(arg);
        ui_page_quick_modes_refresh_buttons();
        lv_label_set_text(s_status, "执行失败");
        ui_page_quick_modes_director_apply_result(false);
    }
}

static esp_err_t ui_page_quick_modes_create_director(void)
{
    s_director_depth = lv_obj_create(s_root);
    ESP_RETURN_ON_FALSE(s_director_depth != NULL, ESP_ERR_NO_MEM, TAG,
                        "director depth alloc failed");
    lv_obj_set_size(s_director_depth, 568, 218);
    lv_obj_align(s_director_depth, LV_ALIGN_CENTER, 8, 24);
    ui_pixel_style_surface(s_director_depth, 0x020405, 0x020405);
    lv_obj_set_style_pad_all(s_director_depth, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_director_depth, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    s_director = lv_obj_create(s_root);
    ESP_RETURN_ON_FALSE(s_director != NULL, ESP_ERR_NO_MEM, TAG,
                        "director alloc failed");
    lv_obj_set_size(s_director, 568, 218);
    lv_obj_align(s_director, LV_ALIGN_CENTER, 0, 16);
    ui_pixel_style_surface(s_director, 0x101820, UI_PIXEL_COLOR_CYAN);
    lv_obj_set_style_border_width(s_director, 3, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_director, 20, LV_PART_MAIN);
    lv_obj_add_flag(s_director, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_clear_flag(s_director, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *eyebrow = lv_label_create(s_director);
    lv_label_set_text(eyebrow, "P4HOME // SCENE DIRECTOR");
    lv_obj_set_style_text_font(eyebrow, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(eyebrow, lv_color_hex(UI_PIXEL_COLOR_MUTED),
                                LV_PART_MAIN);
    lv_obj_align(eyebrow, LV_ALIGN_TOP_LEFT, 0, 0);

    s_director_title = lv_label_create(s_director);
    lv_label_set_text(s_director_title, "场景准备中");
    lv_obj_set_width(s_director_title, 510);
    lv_label_set_long_mode(s_director_title, LV_LABEL_LONG_CLIP);
    lv_obj_set_style_text_font(s_director_title, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_director_title, lv_color_hex(UI_PIXEL_COLOR_INK),
                                LV_PART_MAIN);
    lv_obj_align(s_director_title, LV_ALIGN_TOP_LEFT, 0, 34);

    s_director_stage = lv_label_create(s_director);
    lv_label_set_text(s_director_stage, "01 // 确认场景可用");
    lv_obj_set_width(s_director_stage, 510);
    lv_obj_set_style_text_font(s_director_stage, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_director_stage, lv_color_hex(0xb7c8d0), LV_PART_MAIN);
    lv_obj_align(s_director_stage, LV_ALIGN_TOP_LEFT, 0, 70);

    for (size_t i = 0; i < 3U; ++i) {
        s_director_steps[i] = lv_obj_create(s_director);
        ESP_RETURN_ON_FALSE(s_director_steps[i] != NULL, ESP_ERR_NO_MEM, TAG,
                            "director step alloc failed");
        lv_obj_set_size(s_director_steps[i], 154, 8);
        lv_obj_set_pos(s_director_steps[i], (int32_t)(i * 176U), 112);
        ui_pixel_style_surface(s_director_steps[i], UI_PIXEL_COLOR_GRID,
                               UI_PIXEL_COLOR_GRID);
        lv_obj_set_style_border_width(s_director_steps[i], 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(s_director_steps[i], 0, LV_PART_MAIN);
        lv_obj_clear_flag(s_director_steps[i],
                          LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
    }

    s_director_progress = lv_bar_create(s_director);
    ESP_RETURN_ON_FALSE(s_director_progress != NULL, ESP_ERR_NO_MEM, TAG,
                        "director progress alloc failed");
    lv_obj_set_size(s_director_progress, 510, 22);
    lv_obj_align(s_director_progress, LV_ALIGN_BOTTOM_LEFT, 0, 0);
    lv_bar_set_range(s_director_progress, 0, 100);
    lv_bar_set_value(s_director_progress, 8, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(s_director_progress, lv_color_hex(0x071014), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_director_progress, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_director_progress, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(s_director_progress, lv_color_hex(UI_PIXEL_COLOR_GRID),
                                  LV_PART_MAIN);
    lv_obj_set_style_radius(s_director_progress, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_director_progress,
                              lv_color_hex(UI_PIXEL_COLOR_CYAN), LV_PART_INDICATOR);
    lv_obj_set_style_radius(s_director_progress, 0, LV_PART_INDICATOR);

    lv_obj_add_flag(s_director_depth, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(s_director, LV_OBJ_FLAG_HIDDEN);
    s_director_timer = lv_timer_create(ui_page_quick_modes_director_timer_cb, 220, NULL);
    ESP_RETURN_ON_FALSE(s_director_timer != NULL, ESP_ERR_NO_MEM, TAG,
                        "director timer alloc failed");
    lv_timer_pause(s_director_timer);
    return ESP_OK;
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
    if (ui_async_call(ui_page_quick_modes_apply_sensor, copy) != LV_RESULT_OK) {
        free(copy);
    }
}

static lv_obj_t *ui_page_quick_modes_create_button(lv_obj_t *parent, size_t index,
                                                    int32_t x, int32_t y)
{
    lv_obj_t *deep_layer = lv_obj_create(parent);
    if (deep_layer == NULL) {
        return NULL;
    }
    lv_obj_set_size(deep_layer, UI_QUICK_MODE_CARD_WIDTH, UI_QUICK_MODE_CARD_HEIGHT);
    lv_obj_set_pos(deep_layer, x + 8, y + 8);
    ui_pixel_style_surface(deep_layer, 0x020405, 0x071014);
    lv_obj_set_style_pad_all(deep_layer, 0, LV_PART_MAIN);
    lv_obj_clear_flag(deep_layer, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *mid_layer = lv_obj_create(parent);
    if (mid_layer == NULL) {
        lv_obj_delete(deep_layer);
        return NULL;
    }
    lv_obj_set_size(mid_layer, UI_QUICK_MODE_CARD_WIDTH, UI_QUICK_MODE_CARD_HEIGHT);
    lv_obj_set_pos(mid_layer, x + 4, y + 4);
    ui_pixel_style_surface(mid_layer, 0x0c1418, s_modes[index].accent);
    lv_obj_set_style_pad_all(mid_layer, 0, LV_PART_MAIN);
    lv_obj_set_style_outline_width(mid_layer, 1, LV_PART_MAIN);
    lv_obj_set_style_outline_color(mid_layer, lv_color_hex(s_modes[index].accent), LV_PART_MAIN);
    lv_obj_set_style_outline_opa(mid_layer, LV_OPA_30, LV_PART_MAIN);
    lv_obj_clear_flag(mid_layer, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *button = lv_button_create(parent);
    if (button == NULL) {
        lv_obj_delete(mid_layer);
        lv_obj_delete(deep_layer);
        return NULL;
    }
    lv_obj_set_size(button, UI_QUICK_MODE_CARD_WIDTH, UI_QUICK_MODE_CARD_HEIGHT);
    lv_obj_set_pos(button, x, y);
    /* The two backing layers already provide depth. The interactive face is
     * deliberately shadow-free so a press only redraws its own fixed bounds. */
    ui_pixel_style_surface(button, s_modes[index].color, s_modes[index].accent);
    lv_obj_set_style_bg_color(button, lv_color_hex(s_modes[index].color),
                              LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_border_color(button, lv_color_hex(UI_PIXEL_COLOR_INK),
                                  LV_PART_MAIN | LV_STATE_PRESSED);
    lv_obj_set_style_outline_width(button, 1, LV_PART_MAIN);
    lv_obj_set_style_outline_pad(button, 0, LV_PART_MAIN);
    lv_obj_set_style_outline_color(button, lv_color_hex(s_modes[index].accent), LV_PART_MAIN);
    lv_obj_set_style_outline_opa(button, LV_OPA_30, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(0x252b32), LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_set_style_border_color(button, lv_color_hex(0x26333a),
                                  LV_PART_MAIN | LV_STATE_DISABLED);
    lv_obj_set_style_pad_all(button, 0, LV_PART_MAIN);
    lv_obj_add_event_cb(button, ui_page_quick_modes_click, LV_EVENT_CLICKED,
                        (void *)(uintptr_t)index);

    lv_obj_t *accent_bar = lv_obj_create(button);
    lv_obj_set_size(accent_bar, 8, 112);
    lv_obj_align(accent_bar, LV_ALIGN_LEFT_MID, 18, 0);
    lv_obj_set_style_bg_color(accent_bar, lv_color_hex(s_modes[index].accent), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(accent_bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(accent_bar, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(accent_bar, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(accent_bar, 0, LV_PART_MAIN);
    lv_obj_clear_flag(accent_bar, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title_shadow = lv_label_create(button);
    lv_label_set_text(title_shadow, s_modes[index].title);
    lv_obj_set_style_text_font(title_shadow, ui_pages_mode_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_letter_space(title_shadow, 8, LV_PART_MAIN);
    lv_obj_set_style_text_color(title_shadow, lv_color_hex(0x020405), LV_PART_MAIN);
    lv_obj_align(title_shadow, LV_ALIGN_CENTER, 6, 6);

    lv_obj_t *title_depth = lv_label_create(button);
    lv_label_set_text(title_depth, s_modes[index].title);
    lv_obj_set_style_text_font(title_depth, ui_pages_mode_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_letter_space(title_depth, 8, LV_PART_MAIN);
    lv_obj_set_style_text_color(title_depth, lv_color_hex(s_modes[index].accent), LV_PART_MAIN);
    lv_obj_align(title_depth, LV_ALIGN_CENTER, 3, 3);

    lv_obj_t *title = lv_label_create(button);
    lv_label_set_text(title, s_modes[index].title);
    lv_obj_set_style_text_font(title, ui_pages_mode_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_letter_space(title, 8, LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(UI_PIXEL_COLOR_INK), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, 0);

    s_views[index].indicator_glow = lv_obj_create(button);
    lv_obj_set_size(s_views[index].indicator_glow, 20, 20);
    lv_obj_align(s_views[index].indicator_glow, LV_ALIGN_BOTTOM_RIGHT, -12, -12);
    lv_obj_set_style_bg_opa(s_views[index].indicator_glow, LV_OPA_20, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_views[index].indicator_glow, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s_views[index].indicator_glow, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_views[index].indicator_glow, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_views[index].indicator_glow,
                      LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);

    s_views[index].indicator = lv_obj_create(button);
    lv_obj_set_size(s_views[index].indicator, 12, 12);
    lv_obj_align(s_views[index].indicator, LV_ALIGN_BOTTOM_RIGHT, -16, -16);
    lv_obj_set_style_radius(s_views[index].indicator, 0, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_views[index].indicator, 1, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_views[index].indicator, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_views[index].indicator, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_views[index].indicator, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
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
    lv_obj_set_style_text_color(title, lv_color_hex(UI_PIXEL_COLOR_CYAN), LV_PART_MAIN);
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
    ESP_RETURN_ON_ERROR(ui_page_quick_modes_create_director(), TAG,
                        "failed to create scene director");
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
