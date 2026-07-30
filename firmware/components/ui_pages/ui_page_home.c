#include "ui_page_home.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "ha_client.h"
#include "panel_data_store.h"
#include "time_service.h"
#include "ui_fonts.h"
#include "ui_pages.h"
#include "ui_pixel_theme.h"

static const char *TAG = "ui_home";

#define UI_HOME_ROOM_COUNT 4U
#define UI_HOME_STAR_COUNT 5U
#define UI_HOME_AIR_LINE_COUNT 3U

typedef struct {
    const char *title;
    const char *group_a;
    const char *group_b;
    uint32_t floor;
    uint32_t floor_alt;
    uint32_t accent;
} ui_home_room_def_t;

typedef struct {
    lv_obj_t *floor;
    lv_obj_t *light_glow;
    lv_obj_t *lamp;
    lv_obj_t *window;
    lv_obj_t *title;
    lv_obj_t *meta;
    lv_obj_t *air_lines[UI_HOME_AIR_LINE_COUNT];
    size_t light_total;
    size_t light_online;
    size_t light_on;
    size_t climate_total;
    size_t climate_on;
    double temperature_sum;
    size_t temperature_count;
} ui_home_room_view_t;

typedef struct {
    size_t entities;
    size_t online;
    size_t lights_on;
    size_t climates_on;
} ui_home_summary_t;

static const ui_home_room_def_t s_room_defs[UI_HOME_ROOM_COUNT] = {
    {
        .title = "客厅",
        .group_a = "客厅",
        .group_b = "玄关",
        .floor = 0x18313a,
        .floor_alt = 0x1d3942,
        .accent = UI_PIXEL_COLOR_CYAN,
    },
    {
        .title = "主卧",
        .group_a = "主卧",
        .group_b = "阳台卧",
        .floor = 0x2b2741,
        .floor_alt = 0x332d4c,
        .accent = 0xc084fc,
    },
    {
        .title = "餐厨",
        .group_a = "餐厅",
        .group_b = "厨房",
        .floor = 0x3a3020,
        .floor_alt = 0x443925,
        .accent = UI_PIXEL_COLOR_YELLOW,
    },
    {
        .title = "书房",
        .group_a = "书房",
        .group_b = "阳台",
        .floor = 0x203249,
        .floor_alt = 0x263b54,
        .accent = UI_PIXEL_COLOR_BLUE,
    },
};

static lv_obj_t *s_root;
static lv_obj_t *s_house;
static lv_obj_t *s_sky_strip;
static lv_obj_t *s_moon;
static lv_obj_t *s_stars[UI_HOME_STAR_COUNT];
static lv_obj_t *s_player;
static lv_obj_t *s_player_shadow;
static lv_obj_t *s_companion;
static lv_obj_t *s_dialog_panel;
static lv_obj_t *s_dialog_message;
static lv_obj_t *s_home_summary;
static lv_obj_t *s_connection_badge;
static ui_home_room_view_t s_rooms[UI_HOME_ROOM_COUNT];
static lv_timer_t *s_animation_timer;
static portMUX_TYPE s_refresh_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_refresh_queued;
static bool s_ready;
static uint32_t s_animation_tick;

static void ui_page_home_make_passive(lv_obj_t *object)
{
    lv_obj_clear_flag(object, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
}

static void ui_page_home_style_block(lv_obj_t *object, uint32_t background,
                                     uint32_t border, int32_t border_width)
{
    lv_obj_set_style_bg_color(object, lv_color_hex(background), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(object, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(object, border_width, LV_PART_MAIN);
    lv_obj_set_style_border_color(object, lv_color_hex(border), LV_PART_MAIN);
    lv_obj_set_style_radius(object, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(object, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(object, 0, LV_PART_MAIN);
}

static lv_obj_t *ui_page_home_rect(lv_obj_t *parent, int32_t x, int32_t y,
                                   int32_t width, int32_t height,
                                   uint32_t background, uint32_t border,
                                   int32_t border_width)
{
    lv_obj_t *object = lv_obj_create(parent);
    if (object == NULL) {
        return NULL;
    }
    lv_obj_set_size(object, width, height);
    lv_obj_set_pos(object, x, y);
    ui_page_home_style_block(object, background, border, border_width);
    ui_page_home_make_passive(object);
    return object;
}

static lv_obj_t *ui_page_home_label(lv_obj_t *parent, const char *text,
                                    int32_t x, int32_t y, uint32_t color,
                                    const lv_font_t *font)
{
    lv_obj_t *label = lv_label_create(parent);
    if (label == NULL) {
        return NULL;
    }
    lv_label_set_text(label, text);
    lv_obj_set_pos(label, x, y);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_hex(color), LV_PART_MAIN);
    ui_page_home_make_passive(label);
    return label;
}

static bool ui_page_home_room_matches(size_t index, const char *group)
{
    if (index >= UI_HOME_ROOM_COUNT || group == NULL) {
        return false;
    }
    return strcmp(group, s_room_defs[index].group_a) == 0 ||
           strcmp(group, s_room_defs[index].group_b) == 0;
}

static bool ui_page_home_is_binary_on(const panel_sensor_t *sensor)
{
    return sensor != NULL && sensor->available &&
           (strcmp(sensor->value_text, "on") == 0 ||
            strcmp(sensor->value_text, "true") == 0 ||
            strcmp(sensor->value_text, "1") == 0);
}

static void ui_page_home_reset_aggregates(void)
{
    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        s_rooms[i].light_total = 0U;
        s_rooms[i].light_online = 0U;
        s_rooms[i].light_on = 0U;
        s_rooms[i].climate_total = 0U;
        s_rooms[i].climate_on = 0U;
        s_rooms[i].temperature_sum = 0.0;
        s_rooms[i].temperature_count = 0U;
    }
}

static bool ui_page_home_collect(const panel_sensor_t *sensor, void *user_data)
{
    ui_home_summary_t *summary = (ui_home_summary_t *)user_data;
    if (sensor == NULL || summary == NULL) {
        return true;
    }

    summary->entities++;
    summary->online += sensor->available ? 1U : 0U;
    if (sensor->kind == PANEL_SENSOR_KIND_BINARY && ui_page_home_is_binary_on(sensor)) {
        summary->lights_on++;
    }
    if (sensor->kind == PANEL_SENSOR_KIND_CLIMATE && sensor->available &&
        strcmp(sensor->value_text, "off") != 0) {
        summary->climates_on++;
    }

    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        if (!ui_page_home_room_matches(i, sensor->group)) {
            continue;
        }
        ui_home_room_view_t *room = &s_rooms[i];
        if (sensor->kind == PANEL_SENSOR_KIND_BINARY && strcmp(sensor->icon, "light") == 0) {
            room->light_total++;
            room->light_online += sensor->available ? 1U : 0U;
            room->light_on += ui_page_home_is_binary_on(sensor) ? 1U : 0U;
        } else if (sensor->kind == PANEL_SENSOR_KIND_CLIMATE) {
            room->climate_total++;
            if (sensor->available && strcmp(sensor->value_text, "off") != 0) {
                room->climate_on++;
            }
            if (sensor->available && sensor->has_current_temperature) {
                double temperature = sensor->current_temperature;
                if (strcmp(sensor->unit, "F") == 0) {
                    temperature = (temperature - 32.0) * (5.0 / 9.0);
                }
                room->temperature_sum += temperature;
                room->temperature_count++;
            }
        }
    }
    return true;
}

static void ui_page_home_apply_environment(void)
{
    time_t now = time(NULL);
    struct tm local = {0};
    bool clock_ready = time_service_is_synced() && localtime_r(&now, &local) != NULL;
    bool daytime = clock_ready && local.tm_hour >= 7 && local.tm_hour < 18;

    lv_obj_set_style_bg_color(s_sky_strip,
                              lv_color_hex(daytime ? 0x397e92 : 0x11152e),
                              LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_moon,
                              lv_color_hex(daytime ? UI_PIXEL_COLOR_YELLOW : 0xd8e4ff),
                              LV_PART_MAIN);
    for (size_t i = 0; i < UI_HOME_STAR_COUNT; ++i) {
        lv_obj_set_style_bg_opa(s_stars[i], daytime ? LV_OPA_20 : LV_OPA_COVER,
                                LV_PART_MAIN);
    }
}

static void ui_page_home_apply_room(size_t index)
{
    ui_home_room_view_t *room = &s_rooms[index];
    const ui_home_room_def_t *def = &s_room_defs[index];
    bool has_data = room->light_online > 0U || room->temperature_count > 0U;
    bool lit = room->light_on > 0U;
    bool climate = room->climate_on > 0U;

    lv_obj_set_style_bg_color(room->floor,
                              lv_color_hex(lit ? def->floor_alt : def->floor),
                              LV_PART_MAIN);
    lv_obj_set_style_bg_opa(room->light_glow, lit ? LV_OPA_30 : LV_OPA_TRANSP,
                            LV_PART_MAIN);
    lv_obj_set_style_bg_color(room->lamp,
                              lv_color_hex(lit ? UI_PIXEL_COLOR_YELLOW : 0x56636a),
                              LV_PART_MAIN);
    lv_obj_set_style_border_color(room->lamp,
                                  lv_color_hex(lit ? 0xffefad : 0x27343a),
                                  LV_PART_MAIN);
    lv_obj_set_style_bg_color(room->window,
                              lv_color_hex(lit ? 0xffd36a : 0x142a43),
                              LV_PART_MAIN);
    lv_obj_set_style_border_color(room->window,
                                  lv_color_hex(lit ? UI_PIXEL_COLOR_YELLOW
                                                   : UI_PIXEL_COLOR_BLUE),
                                  LV_PART_MAIN);
    lv_obj_set_style_text_color(room->title,
                                lv_color_hex(lit || climate ? def->accent
                                                           : UI_PIXEL_COLOR_INK),
                                LV_PART_MAIN);

    for (size_t i = 0; i < UI_HOME_AIR_LINE_COUNT; ++i) {
        lv_obj_set_style_bg_opa(room->air_lines[i],
                                climate ? (i == (s_animation_tick % UI_HOME_AIR_LINE_COUNT)
                                               ? LV_OPA_COVER
                                               : LV_OPA_40)
                                        : LV_OPA_TRANSP,
                                LV_PART_MAIN);
    }

    char meta[64];
    if (!has_data) {
        snprintf(meta, sizeof(meta), "WAITING...");
    } else if (room->temperature_count > 0U) {
        snprintf(meta, sizeof(meta), "LAMP %u/%u  AIR %s  %.1fC",
                 (unsigned)room->light_on,
                 (unsigned)room->light_total,
                 climate ? "ON" : "OFF",
                 room->temperature_sum / (double)room->temperature_count);
    } else {
        snprintf(meta, sizeof(meta), "LAMP %u/%u",
                 (unsigned)room->light_on,
                 (unsigned)room->light_total);
    }
    lv_label_set_text(room->meta, meta);
    lv_obj_set_style_text_color(room->meta,
                                lv_color_hex(lit || climate ? def->accent
                                                           : UI_PIXEL_COLOR_MUTED),
                                LV_PART_MAIN);
}

static void ui_page_home_apply_dialog(const ui_home_summary_t *summary)
{
    bool connected = ha_client_ready();
    const char *message = "任务：等待家园连接";
    uint32_t accent = UI_PIXEL_COLOR_YELLOW;

    if (connected && summary->lights_on == 0U && summary->climates_on == 0U) {
        message = "家园很安静，可以休息";
        accent = UI_PIXEL_COLOR_CYAN;
    } else if (connected && summary->lights_on >= 6U) {
        message = "灯火通明！氛围值拉满";
        accent = UI_PIXEL_COLOR_YELLOW;
    } else if (connected && summary->climates_on > 0U) {
        message = "清凉魔法正在生效";
        accent = UI_PIXEL_COLOR_BLUE;
    } else if (connected) {
        message = "欢迎回家，勇者";
        accent = UI_PIXEL_COLOR_CYAN;
    }

    lv_label_set_text(s_dialog_message, message);
    lv_obj_set_style_border_color(s_dialog_panel, lv_color_hex(accent), LV_PART_MAIN);

    char summary_text[80];
    snprintf(summary_text, sizeof(summary_text), "LIGHT %02u  AIR %02u\nONLINE %02u/%02u",
             (unsigned)summary->lights_on,
             (unsigned)summary->climates_on,
             (unsigned)summary->online,
             (unsigned)summary->entities);
    lv_label_set_text(s_home_summary, summary_text);

    lv_label_set_text(s_connection_badge, connected ? "WORLD // ONLINE"
                                                     : "WORLD // CONNECTING");
    lv_obj_set_style_text_color(s_connection_badge,
                                lv_color_hex(connected ? UI_PIXEL_COLOR_CYAN
                                                       : UI_PIXEL_COLOR_YELLOW),
                                LV_PART_MAIN);
}

static void ui_page_home_refresh_locked(void)
{
    if (!s_ready && s_root == NULL) {
        return;
    }
    ui_home_summary_t summary = {0};
    ui_page_home_reset_aggregates();
    panel_data_store_iterate(ui_page_home_collect, &summary);
    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        ui_page_home_apply_room(i);
    }
    ui_page_home_apply_environment();
    ui_page_home_apply_dialog(&summary);
}

static void ui_page_home_refresh_async(void *user_data)
{
    (void)user_data;
    portENTER_CRITICAL(&s_refresh_lock);
    s_refresh_queued = false;
    portEXIT_CRITICAL(&s_refresh_lock);
    ui_page_home_refresh_locked();
}

static void ui_page_home_store_observer(const panel_sensor_t *sensor, void *user_data)
{
    (void)user_data;
    if (sensor == NULL ||
        (sensor->kind != PANEL_SENSOR_KIND_BINARY &&
         sensor->kind != PANEL_SENSOR_KIND_CLIMATE)) {
        return;
    }
    bool should_queue = false;
    portENTER_CRITICAL(&s_refresh_lock);
    if (!s_refresh_queued) {
        s_refresh_queued = true;
        should_queue = true;
    }
    portEXIT_CRITICAL(&s_refresh_lock);
    if (should_queue) {
        if (lv_async_call(ui_page_home_refresh_async, NULL) != LV_RESULT_OK) {
            portENTER_CRITICAL(&s_refresh_lock);
            s_refresh_queued = false;
            portEXIT_CRITICAL(&s_refresh_lock);
        }
    }
}

static void ui_page_home_room_event(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }
    size_t index = (size_t)(uintptr_t)lv_event_get_user_data(event);
    if (index >= UI_HOME_ROOM_COUNT) {
        return;
    }
    ui_pages_page_t target = s_rooms[index].climate_total > 0U
                                 ? UI_PAGES_PAGE_CLIMATE
                                 : UI_PAGES_PAGE_DASHBOARD;
    ESP_LOGW(TAG, "VERIFY:ui:rpg_room:PASS room=%s target=%s",
             s_room_defs[index].title, ui_pages_page_to_text(target));
    ui_pages_show_page_locked(target);
}

static void ui_page_home_shortcut_event(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }
    ui_pages_page_t target = (ui_pages_page_t)(intptr_t)lv_event_get_user_data(event);
    ui_pages_show_page_locked(target);
}

static void ui_page_home_add_floor_grid(lv_obj_t *room, int32_t width, int32_t height,
                                        uint32_t color)
{
    for (int32_t x = 30; x < width; x += 32) {
        lv_obj_t *line = ui_page_home_rect(room, x, 0, 1, height, color, color, 0);
        if (line != NULL) {
            lv_obj_set_style_bg_opa(line, LV_OPA_10, LV_PART_MAIN);
        }
    }
    for (int32_t y = 30; y < height; y += 32) {
        lv_obj_t *line = ui_page_home_rect(room, 0, y, width, 1, color, color, 0);
        if (line != NULL) {
            lv_obj_set_style_bg_opa(line, LV_OPA_10, LV_PART_MAIN);
        }
    }
}

static void ui_page_home_add_air_effect(ui_home_room_view_t *room,
                                        int32_t x, int32_t y)
{
    static const int32_t widths[UI_HOME_AIR_LINE_COUNT] = {28, 20, 12};
    for (size_t i = 0; i < UI_HOME_AIR_LINE_COUNT; ++i) {
        room->air_lines[i] =
            ui_page_home_rect(room->floor, x + (int32_t)i * 7,
                              y + (int32_t)i * 8, widths[i], 3,
                              UI_PIXEL_COLOR_BLUE, UI_PIXEL_COLOR_BLUE, 0);
        if (room->air_lines[i] != NULL) {
            lv_obj_set_style_bg_opa(room->air_lines[i], LV_OPA_TRANSP, LV_PART_MAIN);
        }
    }
}

static esp_err_t ui_page_home_create_room(lv_obj_t *parent, size_t index,
                                          int32_t x, int32_t y,
                                          int32_t width, int32_t height)
{
    ui_home_room_view_t *room = &s_rooms[index];
    const ui_home_room_def_t *def = &s_room_defs[index];

    room->floor = lv_button_create(parent);
    ESP_RETURN_ON_FALSE(room->floor != NULL, ESP_ERR_NO_MEM, TAG,
                        "room floor alloc failed");
    lv_obj_set_size(room->floor, width, height);
    lv_obj_set_pos(room->floor, x, y);
    ui_page_home_style_block(room->floor, def->floor, 0x594b3a, 2);
    lv_obj_add_event_cb(room->floor, ui_page_home_room_event, LV_EVENT_CLICKED,
                        (void *)(uintptr_t)index);

    ui_page_home_add_floor_grid(room->floor, width, height, def->accent);

    room->light_glow = ui_page_home_rect(room->floor, 22, 30, width - 44, height - 54,
                                         UI_PIXEL_COLOR_YELLOW,
                                         UI_PIXEL_COLOR_YELLOW, 0);
    ESP_RETURN_ON_FALSE(room->light_glow != NULL, ESP_ERR_NO_MEM, TAG,
                        "room glow alloc failed");
    lv_obj_set_style_bg_opa(room->light_glow, LV_OPA_TRANSP, LV_PART_MAIN);

    lv_obj_t *name_plate =
        ui_page_home_rect(room->floor, 10, 9, 70, 28, 0x0b1015, def->accent, 2);
    ESP_RETURN_ON_FALSE(name_plate != NULL, ESP_ERR_NO_MEM, TAG,
                        "room name plate alloc failed");
    room->title = ui_page_home_label(name_plate, def->title, 8, 3,
                                     UI_PIXEL_COLOR_INK, ui_pages_text_font());
    ESP_RETURN_ON_FALSE(room->title != NULL, ESP_ERR_NO_MEM, TAG,
                        "room title alloc failed");

    room->meta = ui_page_home_label(room->floor, "WAITING...", 11, height - 24,
                                    UI_PIXEL_COLOR_MUTED, ui_pages_pixel_font());
    ESP_RETURN_ON_FALSE(room->meta != NULL, ESP_ERR_NO_MEM, TAG,
                        "room meta alloc failed");
    lv_obj_set_width(room->meta, width - 20);
    lv_label_set_long_mode(room->meta, LV_LABEL_LONG_CLIP);

    room->window = ui_page_home_rect(room->floor, width - 76, 10, 54, 18,
                                     0x142a43, UI_PIXEL_COLOR_BLUE, 2);
    ESP_RETURN_ON_FALSE(room->window != NULL, ESP_ERR_NO_MEM, TAG,
                        "room window alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(room->window, 25, 0, 2, 16,
                                         0xd8e4ff, 0xd8e4ff, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "window split alloc failed");

    room->lamp = ui_page_home_rect(room->floor, width - 38, height - 43, 14, 14,
                                   0x56636a, 0x27343a, 2);
    ESP_RETURN_ON_FALSE(room->lamp != NULL, ESP_ERR_NO_MEM, TAG,
                        "room lamp alloc failed");
    ui_page_home_add_air_effect(room, width - 70, 42);
    return ESP_OK;
}

static esp_err_t ui_page_home_add_living_furniture(void)
{
    lv_obj_t *room = s_rooms[0].floor;
    lv_obj_t *rug = ui_page_home_rect(room, 92, 78, 154, 88, 0x225563, 0x3b8391, 3);
    ESP_RETURN_ON_FALSE(rug != NULL, ESP_ERR_NO_MEM, TAG, "living rug alloc failed");
    for (int32_t x = 12; x < 140; x += 20) {
        ESP_RETURN_ON_FALSE(ui_page_home_rect(rug, x, 10, 7, 64,
                                             0x2e6a76, 0x2e6a76, 0) != NULL,
                            ESP_ERR_NO_MEM, TAG, "rug pattern alloc failed");
    }

    lv_obj_t *sofa = ui_page_home_rect(room, 36, 55, 58, 120, 0x9b5b4b, 0xd18468, 3);
    ESP_RETURN_ON_FALSE(sofa != NULL, ESP_ERR_NO_MEM, TAG, "sofa alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(sofa, 8, 12, 40, 42,
                                         0xb96d58, 0x65392f, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "sofa cushion alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(sofa, 8, 64, 40, 42,
                                         0xb96d58, 0x65392f, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "sofa cushion alloc failed");

    lv_obj_t *table = ui_page_home_rect(room, 137, 98, 70, 42,
                                       0x7d5434, 0xc18a50, 3);
    ESP_RETURN_ON_FALSE(table != NULL, ESP_ERR_NO_MEM, TAG, "coffee table alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(table, 26, 13, 18, 14,
                                         0x51a66f, 0x8bd18f, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "table plant alloc failed");

    lv_obj_t *tv = ui_page_home_rect(room, 257, 58, 54, 78,
                                    0x0b1015, 0x6b7880, 3);
    ESP_RETURN_ON_FALSE(tv != NULL, ESP_ERR_NO_MEM, TAG, "tv alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(tv, 8, 9, 38, 52,
                                         0x173c50, UI_PIXEL_COLOR_CYAN, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "tv screen alloc failed");
    return ESP_OK;
}

static esp_err_t ui_page_home_add_bedroom_furniture(void)
{
    lv_obj_t *room = s_rooms[1].floor;
    lv_obj_t *bed = ui_page_home_rect(room, 46, 52, 126, 132,
                                     0x785b93, 0xc084fc, 3);
    ESP_RETURN_ON_FALSE(bed != NULL, ESP_ERR_NO_MEM, TAG, "bed alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(bed, 10, 10, 48, 32,
                                         0xe0d3eb, 0xffffff, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "pillow alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(bed, 68, 10, 48, 32,
                                         0xe0d3eb, 0xffffff, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "pillow alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(bed, 9, 50, 108, 72,
                                         0x9b76b5, 0x5a416d, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "blanket alloc failed");

    lv_obj_t *nightstand = ui_page_home_rect(room, 184, 58, 46, 46,
                                            0x6b4936, 0xb97c52, 3);
    ESP_RETURN_ON_FALSE(nightstand != NULL, ESP_ERR_NO_MEM, TAG,
                        "nightstand alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(nightstand, 16, 15, 12, 12,
                                         UI_PIXEL_COLOR_YELLOW, 0xffefad, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "night lamp alloc failed");

    lv_obj_t *wardrobe = ui_page_home_rect(room, 251, 48, 70, 116,
                                          0x614a3f, 0xa97d62, 3);
    ESP_RETURN_ON_FALSE(wardrobe != NULL, ESP_ERR_NO_MEM, TAG,
                        "wardrobe alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(wardrobe, 33, 8, 2, 98,
                                         0xa97d62, 0xa97d62, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wardrobe split alloc failed");
    return ESP_OK;
}

static esp_err_t ui_page_home_add_kitchen_furniture(void)
{
    lv_obj_t *room = s_rooms[2].floor;
    lv_obj_t *counter = ui_page_home_rect(room, 36, 48, 54, 132,
                                         0x6e6b5f, 0xbab298, 3);
    ESP_RETURN_ON_FALSE(counter != NULL, ESP_ERR_NO_MEM, TAG,
                        "counter alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(counter, 10, 15, 34, 30,
                                         0x222b2d, 0x8fa3ad, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "stove alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(counter, 10, 72, 34, 42,
                                         0x456f79, 0x8fa3ad, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "sink alloc failed");

    lv_obj_t *table = ui_page_home_rect(room, 139, 81, 104, 72,
                                       0x8a603c, 0xd19a5f, 3);
    ESP_RETURN_ON_FALSE(table != NULL, ESP_ERR_NO_MEM, TAG,
                        "dining table alloc failed");
    static const int32_t chair_pos[4][2] = {
        {152, 57}, {207, 57}, {152, 157}, {207, 157},
    };
    for (size_t i = 0; i < 4U; ++i) {
        ESP_RETURN_ON_FALSE(ui_page_home_rect(room, chair_pos[i][0], chair_pos[i][1],
                                             24, 18, 0x5a4535, 0xa97d62, 2) != NULL,
                            ESP_ERR_NO_MEM, TAG, "chair alloc failed");
    }

    lv_obj_t *fridge = ui_page_home_rect(room, 273, 48, 52, 104,
                                        0xb7c3c7, 0xe8f0f2, 3);
    ESP_RETURN_ON_FALSE(fridge != NULL, ESP_ERR_NO_MEM, TAG,
                        "fridge alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(fridge, 7, 47, 38, 3,
                                         0x74858d, 0x74858d, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "fridge split alloc failed");
    return ESP_OK;
}

static esp_err_t ui_page_home_add_study_furniture(void)
{
    lv_obj_t *room = s_rooms[3].floor;
    lv_obj_t *bookcase = ui_page_home_rect(room, 36, 47, 58, 135,
                                          0x634833, 0xae7650, 3);
    ESP_RETURN_ON_FALSE(bookcase != NULL, ESP_ERR_NO_MEM, TAG,
                        "bookcase alloc failed");
    static const uint32_t book_colors[4] = {
        UI_PIXEL_COLOR_RED, UI_PIXEL_COLOR_BLUE, UI_PIXEL_COLOR_YELLOW,
        UI_PIXEL_COLOR_CYAN,
    };
    for (size_t row = 0; row < 3U; ++row) {
        for (size_t col = 0; col < 4U; ++col) {
            ESP_RETURN_ON_FALSE(
                ui_page_home_rect(bookcase, 7 + (int32_t)col * 11,
                                  9 + (int32_t)row * 40, 7, 27,
                                  book_colors[(row + col) % 4U],
                                  book_colors[(row + col) % 4U], 0) != NULL,
                ESP_ERR_NO_MEM, TAG, "book alloc failed");
        }
    }

    lv_obj_t *desk = ui_page_home_rect(room, 136, 60, 151, 61,
                                      0x7e573a, 0xc58c59, 3);
    ESP_RETURN_ON_FALSE(desk != NULL, ESP_ERR_NO_MEM, TAG, "desk alloc failed");
    lv_obj_t *monitor = ui_page_home_rect(desk, 48, 8, 56, 36,
                                         0x101820, UI_PIXEL_COLOR_BLUE, 2);
    ESP_RETURN_ON_FALSE(monitor != NULL, ESP_ERR_NO_MEM, TAG,
                        "monitor alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(monitor, 7, 7, 42, 22,
                                         0x214a67, UI_PIXEL_COLOR_CYAN, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "monitor screen alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(room, 190, 135, 44, 40,
                                         0x50606a, 0x9aabb3, 3) != NULL,
                        ESP_ERR_NO_MEM, TAG, "desk chair alloc failed");
    return ESP_OK;
}

static esp_err_t ui_page_home_create_player(lv_obj_t *parent)
{
    s_player_shadow = ui_page_home_rect(parent, 336, 204, 38, 14,
                                        0x020405, 0x020405, 0);
    ESP_RETURN_ON_FALSE(s_player_shadow != NULL, ESP_ERR_NO_MEM, TAG,
                        "player shadow alloc failed");
    lv_obj_set_style_bg_opa(s_player_shadow, LV_OPA_40, LV_PART_MAIN);

    s_player = lv_obj_create(parent);
    ESP_RETURN_ON_FALSE(s_player != NULL, ESP_ERR_NO_MEM, TAG,
                        "player alloc failed");
    lv_obj_set_size(s_player, 32, 48);
    lv_obj_set_pos(s_player, 339, 164);
    lv_obj_set_style_bg_opa(s_player, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_player, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_player, 0, LV_PART_MAIN);
    ui_page_home_make_passive(s_player);

    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_player, 7, 2, 18, 9,
                                         0x382720, 0x382720, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "player hair alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_player, 5, 10, 22, 13,
                                         0xf1b886, 0x5e382c, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "player face alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_player, 3, 23, 26, 16,
                                         UI_PIXEL_COLOR_RED, 0x702f38, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "player body alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_player, 4, 39, 9, 8,
                                         0x354f7a, 0x17233a, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "player leg alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_player, 19, 39, 9, 8,
                                         0x354f7a, 0x17233a, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "player leg alloc failed");

    s_companion = lv_obj_create(parent);
    ESP_RETURN_ON_FALSE(s_companion != NULL, ESP_ERR_NO_MEM, TAG,
                        "companion alloc failed");
    lv_obj_set_size(s_companion, 26, 30);
    lv_obj_set_pos(s_companion, 385, 184);
    lv_obj_set_style_bg_opa(s_companion, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_companion, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_companion, 0, LV_PART_MAIN);
    ui_page_home_make_passive(s_companion);
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_companion, 4, 8, 18, 17,
                                         UI_PIXEL_COLOR_CYAN, 0xd7fff8, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "companion body alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_companion, 3, 3, 7, 8,
                                         UI_PIXEL_COLOR_CYAN, 0xd7fff8, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "companion ear alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_companion, 16, 3, 7, 8,
                                         UI_PIXEL_COLOR_CYAN, 0xd7fff8, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "companion ear alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_companion, 9, 13, 3, 3,
                                         0x071014, 0x071014, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "companion eye alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_companion, 15, 13, 3, 3,
                                         0x071014, 0x071014, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "companion eye alloc failed");
    return ESP_OK;
}

static lv_obj_t *ui_page_home_create_shortcut(lv_obj_t *parent, int32_t y,
                                               const char *title, const char *meta,
                                               uint32_t accent,
                                               ui_pages_page_t target)
{
    lv_obj_t *button = lv_button_create(parent);
    if (button == NULL) {
        return NULL;
    }
    lv_obj_set_size(button, 196, 54);
    lv_obj_set_pos(button, 8, y);
    ui_pixel_style_button(button, 0x101820, accent);
    lv_obj_set_style_pad_all(button, 0, LV_PART_MAIN);
    lv_obj_add_event_cb(button, ui_page_home_shortcut_event, LV_EVENT_CLICKED,
                        (void *)(intptr_t)target);

    lv_obj_t *label = ui_page_home_label(button, title, 12, 7,
                                         UI_PIXEL_COLOR_INK, ui_pages_text_font());
    if (label == NULL) {
        lv_obj_delete(button);
        return NULL;
    }
    lv_obj_t *meta_label = ui_page_home_label(button, meta, 12, 31,
                                              accent, ui_pages_pixel_font());
    if (meta_label == NULL) {
        lv_obj_delete(button);
        return NULL;
    }
    lv_obj_t *arrow = ui_page_home_label(button, ">", 176, 18,
                                         accent, ui_pages_pixel_font());
    if (arrow == NULL) {
        lv_obj_delete(button);
        return NULL;
    }
    return button;
}

static esp_err_t ui_page_home_create_hud(lv_obj_t *parent)
{
    lv_obj_t *hud = lv_obj_create(parent);
    ESP_RETURN_ON_FALSE(hud != NULL, ESP_ERR_NO_MEM, TAG, "hud alloc failed");
    lv_obj_set_size(hud, 212, 456);
    lv_obj_set_pos(hud, 732, 0);
    ui_page_home_style_block(hud, 0x080c10, UI_PIXEL_COLOR_GRID, 2);
    lv_obj_clear_flag(hud, LV_OBJ_FLAG_SCROLLABLE);

    s_sky_strip = ui_page_home_rect(hud, 8, 8, 196, 58,
                                    0x11152e, UI_PIXEL_COLOR_GRID, 2);
    ESP_RETURN_ON_FALSE(s_sky_strip != NULL, ESP_ERR_NO_MEM, TAG,
                        "sky strip alloc failed");
    static const int32_t star_pos[UI_HOME_STAR_COUNT][2] = {
        {14, 14}, {45, 35}, {82, 12}, {119, 31}, {151, 15},
    };
    for (size_t i = 0; i < UI_HOME_STAR_COUNT; ++i) {
        s_stars[i] = ui_page_home_rect(s_sky_strip, star_pos[i][0], star_pos[i][1],
                                       i == 2U ? 4 : 3, i == 2U ? 4 : 3,
                                       0xdce7ff, 0xdce7ff, 0);
        ESP_RETURN_ON_FALSE(s_stars[i] != NULL, ESP_ERR_NO_MEM, TAG,
                            "star alloc failed");
    }
    s_moon = ui_page_home_rect(s_sky_strip, 168, 13, 20, 20,
                               0xd8e4ff, 0xffffff, 2);
    ESP_RETURN_ON_FALSE(s_moon != NULL, ESP_ERR_NO_MEM, TAG,
                        "moon alloc failed");

    s_connection_badge = ui_page_home_label(hud, "WORLD // CONNECTING", 12, 75,
                                            UI_PIXEL_COLOR_YELLOW,
                                            ui_pages_pixel_font());
    ESP_RETURN_ON_FALSE(s_connection_badge != NULL, ESP_ERR_NO_MEM, TAG,
                        "connection badge alloc failed");

    lv_obj_t *avatar = ui_page_home_rect(hud, 8, 102, 62, 62,
                                         0x17212a, UI_PIXEL_COLOR_CYAN, 2);
    ESP_RETURN_ON_FALSE(avatar != NULL, ESP_ERR_NO_MEM, TAG,
                        "avatar alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(avatar, 15, 13, 32, 34,
                                         UI_PIXEL_COLOR_CYAN, 0xd7fff8, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "avatar face alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(avatar, 21, 25, 5, 5,
                                         0x071014, 0x071014, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "avatar eye alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(avatar, 36, 25, 5, 5,
                                         0x071014, 0x071014, 0) != NULL,
                        ESP_ERR_NO_MEM, TAG, "avatar eye alloc failed");

    ESP_RETURN_ON_FALSE(ui_page_home_label(hud, "HOME KEEPER", 80, 108,
                                          UI_PIXEL_COLOR_INK,
                                          ui_pages_pixel_font()) != NULL,
                        ESP_ERR_NO_MEM, TAG, "keeper title alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_label(hud, "LV.04", 80, 135,
                                          UI_PIXEL_COLOR_YELLOW,
                                          ui_pages_pixel_font()) != NULL,
                        ESP_ERR_NO_MEM, TAG, "keeper level alloc failed");

    s_dialog_panel = lv_obj_create(hud);
    ESP_RETURN_ON_FALSE(s_dialog_panel != NULL, ESP_ERR_NO_MEM, TAG,
                        "dialog panel alloc failed");
    lv_obj_set_size(s_dialog_panel, 196, 104);
    lv_obj_set_pos(s_dialog_panel, 8, 174);
    ui_page_home_style_block(s_dialog_panel, 0x101820, UI_PIXEL_COLOR_CYAN, 2);
    ui_page_home_make_passive(s_dialog_panel);
    s_dialog_message = ui_page_home_label(s_dialog_panel, "任务：等待家园连接",
                                          10, 10, UI_PIXEL_COLOR_INK,
                                          ui_pages_text_font());
    ESP_RETURN_ON_FALSE(s_dialog_message != NULL, ESP_ERR_NO_MEM, TAG,
                        "dialog message alloc failed");
    lv_obj_set_width(s_dialog_message, 176);
    lv_label_set_long_mode(s_dialog_message, LV_LABEL_LONG_WRAP);

    s_home_summary = ui_page_home_label(s_dialog_panel,
                                        "LIGHT 00  AIR 00\nONLINE 00/00",
                                        10, 52, UI_PIXEL_COLOR_MUTED,
                                        ui_pages_pixel_font());
    ESP_RETURN_ON_FALSE(s_home_summary != NULL, ESP_ERR_NO_MEM, TAG,
                        "home summary alloc failed");

    ESP_RETURN_ON_FALSE(ui_page_home_create_shortcut(hud, 290, "施放场景",
                                                     "SCENE MAGIC",
                                                     UI_PIXEL_COLOR_CYAN,
                                                     UI_PAGES_PAGE_QUICK_MODES) != NULL,
                        ESP_ERR_NO_MEM, TAG, "mode shortcut create failed");
    ESP_RETURN_ON_FALSE(ui_page_home_create_shortcut(hud, 352, "查看背包",
                                                     "ALL DEVICES",
                                                     UI_PIXEL_COLOR_BLUE,
                                                     UI_PAGES_PAGE_DASHBOARD) != NULL,
                        ESP_ERR_NO_MEM, TAG, "device shortcut create failed");
    ESP_RETURN_ON_FALSE(ui_page_home_label(hud, "TAP A ROOM TO ENTER", 18, 425,
                                          UI_PIXEL_COLOR_MUTED,
                                          ui_pages_pixel_font()) != NULL,
                        ESP_ERR_NO_MEM, TAG, "hud hint alloc failed");
    return ESP_OK;
}

static void ui_page_home_animation_cb(lv_timer_t *timer)
{
    (void)timer;
    s_animation_tick++;
    int32_t player_offset = (s_animation_tick & 1U) != 0U ? -2 : 0;
    int32_t companion_offset = (s_animation_tick % 3U) == 0U ? -3 : 0;
    lv_obj_set_style_translate_y(s_player, player_offset, LV_PART_MAIN);
    lv_obj_set_width(s_player_shadow,
                     (s_animation_tick & 1U) != 0U ? 34 : 38);
    lv_obj_set_style_translate_y(s_companion, companion_offset, LV_PART_MAIN);

    size_t star = s_animation_tick % UI_HOME_STAR_COUNT;
    lv_obj_set_style_bg_opa(s_stars[star],
                            (s_animation_tick & 1U) != 0U ? LV_OPA_30 : LV_OPA_COVER,
                            LV_PART_MAIN);
    for (size_t i = 0; i < UI_HOME_ROOM_COUNT; ++i) {
        bool climate = s_rooms[i].climate_on > 0U;
        for (size_t line = 0; line < UI_HOME_AIR_LINE_COUNT; ++line) {
            lv_obj_set_style_bg_opa(
                s_rooms[i].air_lines[line],
                climate ? (line == (s_animation_tick % UI_HOME_AIR_LINE_COUNT)
                               ? LV_OPA_COVER
                               : LV_OPA_40)
                        : LV_OPA_TRANSP,
                LV_PART_MAIN);
        }
    }
    if ((s_animation_tick % 8U) == 0U) {
        ui_page_home_refresh_locked();
    }
}

esp_err_t ui_page_home_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    s_root = lv_obj_create(lv_screen_active());
    ESP_RETURN_ON_FALSE(s_root != NULL, ESP_ERR_NO_MEM, TAG, "home root alloc failed");
    lv_obj_set_size(s_root, 944, 456);
    lv_obj_align(s_root, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_root, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_root, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_root, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_root, LV_OBJ_FLAG_SCROLLABLE);

    s_house = lv_obj_create(s_root);
    ESP_RETURN_ON_FALSE(s_house != NULL, ESP_ERR_NO_MEM, TAG, "house alloc failed");
    lv_obj_set_size(s_house, 720, 456);
    lv_obj_set_pos(s_house, 0, 0);
    ui_page_home_style_block(s_house, 0x090b0d, 0xc59a62, 6);
    lv_obj_set_style_pad_all(s_house, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_house, LV_OBJ_FLAG_SCROLLABLE);

    ESP_RETURN_ON_ERROR(ui_page_home_create_room(s_house, 0, 6, 6, 352, 218),
                        TAG, "living room create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_create_room(s_house, 1, 358, 6, 352, 218),
                        TAG, "bedroom create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_create_room(s_house, 2, 6, 224, 352, 222),
                        TAG, "kitchen create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_create_room(s_house, 3, 358, 224, 352, 222),
                        TAG, "study create failed");

    ESP_RETURN_ON_ERROR(ui_page_home_add_living_furniture(), TAG,
                        "living furniture create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_add_bedroom_furniture(), TAG,
                        "bedroom furniture create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_add_kitchen_furniture(), TAG,
                        "kitchen furniture create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_add_study_furniture(), TAG,
                        "study furniture create failed");

    /* Shared walls and door thresholds make the four spaces read as one map,
     * rather than four independent dashboard cards. */
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 351, 6, 8, 74,
                                         0x8b6544, 0xc59a62, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 351, 135, 8, 89,
                                         0x8b6544, 0xc59a62, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 351, 224, 8, 72,
                                         0x8b6544, 0xc59a62, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 351, 352, 8, 94,
                                         0x8b6544, 0xc59a62, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 6, 217, 286, 8,
                                         0x8b6544, 0xc59a62, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 418, 217, 292, 8,
                                         0x8b6544, 0xc59a62, 1) != NULL,
                        ESP_ERR_NO_MEM, TAG, "wall alloc failed");
    ESP_RETURN_ON_FALSE(ui_page_home_rect(s_house, 292, 215, 126, 12,
                                         0xd4ab70, 0x745032, 2) != NULL,
                        ESP_ERR_NO_MEM, TAG, "hallway threshold alloc failed");

    ESP_RETURN_ON_ERROR(ui_page_home_create_player(s_house), TAG,
                        "player create failed");
    ESP_RETURN_ON_ERROR(ui_page_home_create_hud(s_root), TAG,
                        "hud create failed");

    ESP_RETURN_ON_ERROR(panel_data_store_add_observer(ui_page_home_store_observer, NULL),
                        TAG, "failed to attach home observer");
    s_animation_timer = lv_timer_create(ui_page_home_animation_cb, 600, NULL);
    ESP_RETURN_ON_FALSE(s_animation_timer != NULL, ESP_ERR_NO_MEM, TAG,
                        "home animation timer alloc failed");
    s_ready = true;
    ui_page_home_refresh_locked();
    ESP_LOGW(TAG, "RPG home map ready rooms=%u furniture=4 hero=1",
             (unsigned)UI_HOME_ROOM_COUNT);
    return ESP_OK;
}

void ui_page_home_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
        ui_page_home_refresh_locked();
    }
}

lv_obj_t *ui_page_home_root(void)
{
    return s_root;
}

bool ui_page_home_ready(void)
{
    return s_ready;
}
