#include "ui_page_energy.h"

#include <inttypes.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ha_client.h"
#include "time_service.h"
#include "ui_fonts.h"
#include "ui_pixel_theme.h"

static const char *TAG = "ui_energy";

#define UI_ENERGY_DAYS 7U
#define UI_ENERGY_SEGMENTS 12U
#define UI_ENERGY_MAX_SOURCES 4U

typedef struct {
    double days[UI_ENERGY_DAYS];
    size_t source_count;
    bool whole_home_grid;
    bool valid;
    char status[48];
} ui_energy_update_t;

static lv_obj_t *s_root;
static lv_obj_t *s_total;
static lv_obj_t *s_status;
static lv_obj_t *s_values[UI_ENERGY_DAYS];
static lv_obj_t *s_tracks[UI_ENERGY_DAYS];
static size_t s_lit_segments[UI_ENERGY_DAYS];
static bool s_ready;

static void ui_page_energy_format_kwh(char *buffer, size_t buffer_len,
                                      double value, const char *prefix)
{
    double nonnegative = isfinite(value) && value > 0.0 ? value : 0.0;
    int64_t tenths = (int64_t)llround(nonnegative * 10.0);
    snprintf(buffer, buffer_len, "%s%" PRId64 ".%" PRId64 " kWh",
             prefix != NULL ? prefix : "", tenths / 10, tenths % 10);
}

static void ui_page_energy_draw_track(lv_event_t *event)
{
    lv_obj_t *track = lv_event_get_target_obj(event);
    size_t day = (size_t)(uintptr_t)lv_event_get_user_data(event);
    if (track == NULL || day >= UI_ENERGY_DAYS) {
        return;
    }

    lv_area_t content;
    lv_obj_get_content_coords(track, &content);
    const int32_t gap = 5;
    int32_t width = lv_area_get_width(&content);
    int32_t segment_width = (width - gap * ((int32_t)UI_ENERGY_SEGMENTS - 1)) /
                            (int32_t)UI_ENERGY_SEGMENTS;
    lv_layer_t *layer = lv_event_get_layer(event);
    for (size_t segment = 0; segment < UI_ENERGY_SEGMENTS; ++segment) {
        bool active = segment < s_lit_segments[day];
        uint32_t color = segment >= 10U ? UI_PIXEL_COLOR_RED
                          : segment >= 7U ? UI_PIXEL_COLOR_YELLOW
                                         : UI_PIXEL_COLOR_CYAN;
        lv_draw_rect_dsc_t draw_dsc;
        lv_draw_rect_dsc_init(&draw_dsc);
        draw_dsc.bg_color = lv_color_hex(active ? color : UI_PIXEL_COLOR_PANEL_ALT);
        draw_dsc.bg_opa = active ? LV_OPA_COVER : LV_OPA_50;
        draw_dsc.radius = 0;

        lv_area_t block = content;
        block.x1 += (int32_t)segment * (segment_width + gap);
        block.x2 = block.x1 + segment_width - 1;
        lv_draw_rect(layer, &draw_dsc, &block);
    }
}

static void ui_page_energy_format_iso(time_t timestamp, char *buffer, size_t buffer_len)
{
    struct tm utc = {0};
    gmtime_r(&timestamp, &utc);
    strftime(buffer, buffer_len, "%Y-%m-%dT%H:%M:%SZ", &utc);
}

static size_t ui_page_energy_collect_sources(cJSON *prefs, char ids[][128], size_t max_ids,
                                             bool *whole_home_grid)
{
    size_t count = 0U;
    if (whole_home_grid != NULL) {
        *whole_home_grid = false;
    }
    cJSON *sources = cJSON_GetObjectItemCaseSensitive(prefs, "energy_sources");
    cJSON *source = NULL;
    cJSON_ArrayForEach(source, sources) {
        cJSON *type = cJSON_GetObjectItemCaseSensitive(source, "type");
        cJSON *stat = cJSON_GetObjectItemCaseSensitive(source, "stat_energy_from");
        if (!cJSON_IsString(type) || strcmp(type->valuestring, "grid") != 0 ||
            !cJSON_IsString(stat) || stat->valuestring[0] == '\0') {
            continue;
        }
        snprintf(ids[count++], 128, "%s", stat->valuestring);
        if (count >= max_ids) {
            return count;
        }
    }

    if (count > 0U) {
        if (whole_home_grid != NULL) {
            *whole_home_grid = true;
        }
        return count;
    }
    cJSON *devices = cJSON_GetObjectItemCaseSensitive(prefs, "device_consumption");
    cJSON *device = NULL;
    cJSON_ArrayForEach(device, devices) {
        cJSON *stat = cJSON_GetObjectItemCaseSensitive(device, "stat_consumption");
        if (!cJSON_IsString(stat) || stat->valuestring[0] == '\0') {
            continue;
        }
        snprintf(ids[count++], 128, "%s", stat->valuestring);
        if (count >= max_ids) {
            break;
        }
    }
    return count;
}

static char *ui_page_energy_build_statistics_fields(char ids[][128], size_t count)
{
    time_t now = time(NULL);
    struct tm local = {0};
    localtime_r(&now, &local);
    local.tm_hour = 0;
    local.tm_min = 0;
    local.tm_sec = 0;
    time_t start = mktime(&local) - (time_t)(UI_ENERGY_DAYS - 1U) * 24 * 60 * 60;
    char start_text[32] = {0};
    char end_text[32] = {0};
    ui_page_energy_format_iso(start, start_text, sizeof(start_text));
    ui_page_energy_format_iso(now, end_text, sizeof(end_text));

    cJSON *fields = cJSON_CreateObject();
    cJSON *statistic_ids = cJSON_AddArrayToObject(fields, "statistic_ids");
    for (size_t i = 0; i < count; ++i) {
        cJSON_AddItemToArray(statistic_ids, cJSON_CreateString(ids[i]));
    }
    cJSON_AddStringToObject(fields, "start_time", start_text);
    cJSON_AddStringToObject(fields, "end_time", end_text);
    cJSON_AddStringToObject(fields, "period", "day");
    cJSON *units = cJSON_AddObjectToObject(fields, "units");
    cJSON_AddStringToObject(units, "energy", "kWh");
    cJSON *types = cJSON_AddArrayToObject(fields, "types");
    cJSON_AddItemToArray(types, cJSON_CreateString("change"));
    char *json = cJSON_PrintUnformatted(fields);
    cJSON_Delete(fields);
    return json;
}

static bool ui_page_energy_parse_statistics(cJSON *result, char ids[][128], size_t count,
                                            double days[UI_ENERGY_DAYS])
{
    bool found = false;
    memset(days, 0, sizeof(double) * UI_ENERGY_DAYS);
    for (size_t source = 0; source < count; ++source) {
        cJSON *rows = cJSON_GetObjectItemCaseSensitive(result, ids[source]);
        if (!cJSON_IsArray(rows)) {
            continue;
        }
        int row_count = cJSON_GetArraySize(rows);
        int first = row_count > (int)UI_ENERGY_DAYS ? row_count - (int)UI_ENERGY_DAYS : 0;
        size_t output = UI_ENERGY_DAYS - (size_t)(row_count - first);
        for (int row_index = first; row_index < row_count && output < UI_ENERGY_DAYS;
             ++row_index, ++output) {
            cJSON *row = cJSON_GetArrayItem(rows, row_index);
            cJSON *change = cJSON_IsObject(row)
                                ? cJSON_GetObjectItemCaseSensitive(row, "change")
                                : NULL;
            if (cJSON_IsNumber(change) && isfinite(change->valuedouble)) {
                days[output] += change->valuedouble > 0.0 ? change->valuedouble : 0.0;
                found = true;
            }
        }
    }
    return found;
}

static void ui_page_energy_apply_update(void *user_data)
{
    ui_energy_update_t *update = (ui_energy_update_t *)user_data;
    if (update == NULL) {
        return;
    }
    double maximum = 0.0;
    double total = 0.0;
    for (size_t day = 0; day < UI_ENERGY_DAYS; ++day) {
        if (update->days[day] > maximum) {
            maximum = update->days[day];
        }
        total += update->days[day];
    }
    if (maximum < 0.01) {
        maximum = 1.0;
    }

    for (size_t day = 0; day < UI_ENERGY_DAYS; ++day) {
        char value_text[32];
        ui_page_energy_format_kwh(value_text, sizeof(value_text), update->days[day], NULL);
        lv_label_set_text(s_values[day], value_text);
        size_t lit = update->valid && update->days[day] > 0.0
                         ? (size_t)ceil((update->days[day] / maximum) * UI_ENERGY_SEGMENTS)
                         : 0U;
        if (lit > UI_ENERGY_SEGMENTS) {
            lit = UI_ENERGY_SEGMENTS;
        }
        s_lit_segments[day] = lit;
        lv_obj_invalidate(s_tracks[day]);
    }
    char total_text[48];
    ui_page_energy_format_kwh(total_text, sizeof(total_text), total, "7D HOME  ");
    lv_label_set_text(s_total, total_text);
    lv_label_set_text(s_status, update->status);
    ESP_LOGW(TAG, "VERIFY:ui:energy_data:%s sources=%u total_7d=%.2f",
             update->valid ? "PASS" : "PENDING",
             (unsigned)update->source_count, total);
    free(update);
}

static void ui_page_energy_fetch_task(void *arg)
{
    (void)arg;
    while (true) {
        ui_energy_update_t *update = calloc(1U, sizeof(*update));
        if (update == NULL) {
            vTaskDelay(pdMS_TO_TICKS(60000));
            continue;
        }
        snprintf(update->status, sizeof(update->status), "%s", "WAIT HA ENERGY");
        if (ha_client_wait_ready(70000) != ESP_OK) {
            snprintf(update->status, sizeof(update->status), "%s", "HA OFFLINE // RETRY");
            lv_async_call(ui_page_energy_apply_update, update);
            vTaskDelay(pdMS_TO_TICKS(60000));
            continue;
        }
        if (!time_service_is_synced()) {
            snprintf(update->status, sizeof(update->status), "%s", "WAIT CLOCK // RETRY");
            lv_async_call(ui_page_energy_apply_update, update);
            vTaskDelay(pdMS_TO_TICKS(30000));
            continue;
        }

        char *prefs_json = NULL;
        esp_err_t err = ha_client_request_json("energy/get_prefs", NULL, &prefs_json, 10000);
        cJSON *prefs = err == ESP_OK ? cJSON_Parse(prefs_json) : NULL;
        char source_ids[UI_ENERGY_MAX_SOURCES][128] = {{0}};
        size_t source_count = cJSON_IsObject(prefs)
                                  ? ui_page_energy_collect_sources(prefs, source_ids,
                                                                   UI_ENERGY_MAX_SOURCES,
                                                                   &update->whole_home_grid)
                                  : 0U;
        update->source_count = source_count;
        cJSON_Delete(prefs);
        ha_client_free_json(prefs_json);
        if (source_count == 0U) {
            snprintf(update->status, sizeof(update->status), "%s", "NO GRID SOURCE IN HA");
            lv_async_call(ui_page_energy_apply_update, update);
            vTaskDelay(pdMS_TO_TICKS(300000));
            continue;
        }

        char *fields_json = ui_page_energy_build_statistics_fields(source_ids, source_count);
        char *stats_json = NULL;
        err = fields_json != NULL
                  ? ha_client_request_json("recorder/statistics_during_period", fields_json,
                                           &stats_json, 15000)
                  : ESP_ERR_NO_MEM;
        cJSON_free(fields_json);
        cJSON *stats = err == ESP_OK ? cJSON_Parse(stats_json) : NULL;
        update->valid = cJSON_IsObject(stats) &&
                        ui_page_energy_parse_statistics(stats, source_ids, source_count,
                                                        update->days);
        snprintf(update->status, sizeof(update->status), "%s",
                 update->valid
                     ? (update->whole_home_grid ? "HA HOME GRID // SYNC OK"
                                                : "HA DEVICE SUM // SYNC OK")
                     : "NO ENERGY STATS // RETRY");
        cJSON_Delete(stats);
        ha_client_free_json(stats_json);
        lv_async_call(ui_page_energy_apply_update, update);
        vTaskDelay(pdMS_TO_TICKS(900000));
    }
}

esp_err_t ui_page_energy_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }
    s_root = lv_obj_create(lv_screen_active());
    ESP_RETURN_ON_FALSE(s_root != NULL, ESP_ERR_NO_MEM, TAG, "energy root alloc failed");
    lv_obj_set_size(s_root, 944, 456);
    lv_obj_align(s_root, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_root, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_root, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_root, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_root, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *panel = lv_obj_create(s_root);
    ESP_RETURN_ON_FALSE(panel != NULL, ESP_ERR_NO_MEM, TAG, "energy panel alloc failed");
    lv_obj_set_size(panel, 944, 456);
    ui_pixel_style_card(panel, UI_PIXEL_COLOR_PANEL, UI_PIXEL_COLOR_GRID);
    lv_obj_set_style_pad_all(panel, 14, LV_PART_MAIN);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title = lv_label_create(panel);
    lv_label_set_text(title, "ENERGY // HOME GRID 7D");
    lv_obj_set_style_text_font(title, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(UI_PIXEL_COLOR_CYAN), LV_PART_MAIN);
    lv_obj_set_pos(title, 4, 0);

    s_total = lv_label_create(panel);
    lv_label_set_text(s_total, "7D TOTAL  --.- kWh");
    lv_obj_set_style_text_font(s_total, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_total, lv_color_hex(UI_PIXEL_COLOR_INK), LV_PART_MAIN);
    lv_obj_align(s_total, LV_ALIGN_TOP_RIGHT, -4, 0);

    static const char *day_labels[UI_ENERGY_DAYS] = {"D-6", "D-5", "D-4", "D-3", "D-2", "YDAY", "TODAY"};
    for (size_t day = 0; day < UI_ENERGY_DAYS; ++day) {
        int32_t y = 48 + (int32_t)day * 48;
        lv_obj_t *day_label = lv_label_create(panel);
        lv_label_set_text(day_label, day_labels[day]);
        lv_obj_set_width(day_label, 62);
        lv_obj_set_style_text_font(day_label, ui_pages_pixel_font(), LV_PART_MAIN);
        lv_obj_set_style_text_color(day_label,
                                    lv_color_hex(day == UI_ENERGY_DAYS - 1U
                                                     ? UI_PIXEL_COLOR_YELLOW
                                                     : UI_PIXEL_COLOR_MUTED),
                                    LV_PART_MAIN);
        lv_obj_set_pos(day_label, 4, y + 7);

        lv_obj_t *track = lv_obj_create(panel);
        ESP_RETURN_ON_FALSE(track != NULL, ESP_ERR_NO_MEM, TAG,
                            "energy track alloc failed day=%u", (unsigned)day);
        lv_obj_set_size(track, 620, 34);
        lv_obj_set_pos(track, 72, y);
        ui_pixel_style_surface(track, UI_PIXEL_COLOR_SCREEN, UI_PIXEL_COLOR_GRID);
        lv_obj_set_style_pad_all(track, 4, LV_PART_MAIN);
        lv_obj_clear_flag(track, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_event_cb(track, ui_page_energy_draw_track, LV_EVENT_DRAW_MAIN_END,
                            (void *)(uintptr_t)day);
        s_tracks[day] = track;

        s_values[day] = lv_label_create(panel);
        lv_label_set_text(s_values[day], "--.- kWh");
        lv_obj_set_width(s_values[day], 178);
        lv_obj_set_style_text_align(s_values[day], LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
        lv_obj_set_style_text_font(s_values[day], ui_pages_pixel_font(), LV_PART_MAIN);
        lv_obj_set_style_text_color(s_values[day], lv_color_hex(UI_PIXEL_COLOR_INK), LV_PART_MAIN);
        lv_obj_set_pos(s_values[day], 710, y + 7);
    }

    s_status = lv_label_create(panel);
    lv_label_set_text(s_status, "WAIT HA ENERGY");
    lv_obj_set_style_text_font(s_status, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(s_status, lv_color_hex(UI_PIXEL_COLOR_MUTED), LV_PART_MAIN);
    lv_obj_align(s_status, LV_ALIGN_BOTTOM_LEFT, 4, -2);

    ESP_RETURN_ON_FALSE(xTaskCreate(ui_page_energy_fetch_task, "p4home_energy", 8192, NULL,
                                    tskIDLE_PRIORITY + 2, NULL) == pdPASS,
                        ESP_ERR_NO_MEM, TAG, "energy task alloc failed");
    s_ready = true;
    ESP_LOGW(TAG, "energy page ready bars=%u segments=%u",
             (unsigned)UI_ENERGY_DAYS, (unsigned)UI_ENERGY_SEGMENTS);
    return ESP_OK;
}

void ui_page_energy_show(void)
{
    if (s_root != NULL) {
        lv_obj_clear_flag(s_root, LV_OBJ_FLAG_HIDDEN);
        ESP_LOGW(TAG, "VERIFY:ui:energy_page:PASS bars=%u", (unsigned)UI_ENERGY_DAYS);
    }
}

lv_obj_t *ui_page_energy_root(void)
{
    return s_root;
}

bool ui_page_energy_ready(void)
{
    return s_ready;
}
