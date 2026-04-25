#include "panel_data_store.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ha_client.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "time_service.h"

static const char *TAG = "panel_store";

typedef struct {
    panel_sensor_sample_t samples[CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS];
    size_t count;
    size_t head;
    uint64_t last_sample_ms;
} panel_sensor_history_t;

typedef struct {
    bool initialized;
    panel_sensor_t entities[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES];
    panel_sensor_history_t history[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES];
    size_t count;
    size_t rejected_count;
    SemaphoreHandle_t mutex;
    panel_data_store_observer_cb_t observer;
    void *observer_user;
} panel_data_store_ctx_t;

static panel_data_store_ctx_t s_store;

static int panel_data_store_find_index_locked(const char *entity_id)
{
    for (size_t i = 0; i < s_store.count; ++i) {
        if (strcmp(s_store.entities[i].entity_id, entity_id) == 0) {
            return (int)i;
        }
    }
    return -1;
}

static bool panel_data_store_is_trend_source(const panel_sensor_t *sensor)
{
    return sensor != NULL && sensor->kind == PANEL_SENSOR_KIND_NUMERIC;
}

static uint64_t panel_data_store_sample_time_ms(const panel_sensor_t *sensor, uint64_t now_ms)
{
    if (now_ms != 0U) {
        return now_ms;
    }
    if (sensor != NULL && sensor->updated_at_ms != 0U) {
        return sensor->updated_at_ms;
    }
    return time_service_last_sync_epoch_ms();
}

static void panel_data_store_append_sample_locked(size_t index,
                                                  const panel_sensor_t *sensor,
                                                  uint64_t now_ms,
                                                  bool force)
{
    if (index >= s_store.count || !panel_data_store_is_trend_source(sensor) || !sensor->available) {
        return;
    }

    uint64_t sample_ms = panel_data_store_sample_time_ms(sensor, now_ms);
    if (sample_ms == 0U) {
        return;
    }

    panel_sensor_history_t *history = &s_store.history[index];
    if (!force && history->count > 0U &&
        sample_ms < history->last_sample_ms + CONFIG_P4HOME_PANEL_STORE_SAMPLE_INTERVAL_MS) {
        return;
    }

    size_t write = history->count < CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS
                       ? history->count
                       : history->head;
    history->samples[write].timestamp_ms = sample_ms;
    history->samples[write].value = sensor->value_numeric;
    if (history->count < CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS) {
        history->count++;
    } else {
        history->head = (history->head + 1U) % CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS;
    }
    history->last_sample_ms = sample_ms;
}

static panel_sensor_freshness_t panel_data_store_compute_freshness(uint64_t now_ms, uint64_t updated_at_ms)
{
    if (updated_at_ms == 0U || now_ms == 0U) {
        return PANEL_SENSOR_FRESHNESS_UNKNOWN;
    }
    if (now_ms < updated_at_ms) {
        return PANEL_SENSOR_FRESHNESS_FRESH;
    }
    return (now_ms - updated_at_ms) > CONFIG_P4HOME_PANEL_STORE_STALE_MS
               ? PANEL_SENSOR_FRESHNESS_STALE
               : PANEL_SENSOR_FRESHNESS_FRESH;
}

static const char *panel_data_store_json_string(cJSON *root, const char *name)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

static bool panel_data_store_json_number(cJSON *root, const char *name, double *value)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (!cJSON_IsNumber(item) || value == NULL) {
        return false;
    }
    *value = item->valuedouble;
    return true;
}

static cJSON *panel_data_store_json_array(cJSON *root, const char *name)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    return cJSON_IsArray(item) ? item : NULL;
}

static bool panel_data_store_unit_is_fahrenheit(const char *unit)
{
    return unit != NULL && (strcmp(unit, "F") == 0 || strcmp(unit, "°F") == 0);
}

static bool panel_data_store_unit_is_celsius(const char *unit)
{
    return unit != NULL && (strcmp(unit, "C") == 0 || strcmp(unit, "°C") == 0);
}

static bool panel_data_store_sensor_wants_celsius(const panel_sensor_t *sensor)
{
    return sensor != NULL &&
           (panel_data_store_unit_is_celsius(sensor->unit) ||
            strcmp(sensor->icon, "thermometer") == 0);
}

static const char *panel_data_store_normalize_unit_text(const char *unit)
{
    if (panel_data_store_unit_is_celsius(unit)) {
        return "C";
    }
    if (panel_data_store_unit_is_fahrenheit(unit)) {
        return "F";
    }
    return unit;
}

static void panel_data_store_copy_ascii_text(char *dst, size_t dst_len, const char *src, const char *fallback)
{
    if (dst == NULL || dst_len == 0U) {
        return;
    }
    const char *text = (src != NULL && src[0] != '\0') ? src : fallback;
    if (text == NULL) {
        text = "";
    }
    snprintf(dst, dst_len, "%s", text);
}

static void panel_data_store_ascii_state(const ha_client_state_change_t *change,
                                         char *buffer,
                                         size_t buffer_len)
{
    panel_data_store_copy_ascii_text(buffer, buffer_len,
                                     change != NULL ? change->state_text : NULL,
                                     "state");
}

static bool panel_data_store_format_weather_summary(const ha_client_state_change_t *change,
                                                    char *buffer,
                                                    size_t buffer_len,
                                                    double *temperature_out)
{
    if (change == NULL || change->attributes_json == NULL || buffer == NULL || buffer_len == 0U) {
        return false;
    }

    cJSON *attrs = cJSON_Parse(change->attributes_json);
    if (attrs == NULL) {
        return false;
    }

    double temperature = 0.0;
    double humidity = 0.0;
    double wind_speed = 0.0;
    bool has_temperature = panel_data_store_json_number(attrs, "temperature", &temperature);
    bool has_humidity = panel_data_store_json_number(attrs, "humidity", &humidity);
    bool has_wind_speed = panel_data_store_json_number(attrs, "wind_speed", &wind_speed);
    double aqi = 0.0;
    bool has_aqi = panel_data_store_json_number(attrs, "air_quality_index", &aqi) ||
                   panel_data_store_json_number(attrs, "aqi", &aqi) ||
                   panel_data_store_json_number(attrs, "air_quality", &aqi);
    const char *temperature_unit = panel_data_store_json_string(attrs, "temperature_unit");
    const char *wind_speed_unit = panel_data_store_json_string(attrs, "wind_speed_unit");
    temperature_unit = panel_data_store_normalize_unit_text(temperature_unit);
    wind_speed_unit = panel_data_store_normalize_unit_text(wind_speed_unit);
    if (has_temperature && panel_data_store_unit_is_fahrenheit(temperature_unit)) {
        temperature = (temperature - 32.0) * (5.0 / 9.0);
        temperature_unit = "C";
    }
    if (has_temperature && temperature_out != NULL) {
        *temperature_out = temperature;
    }
    char temperature_unit_ascii[12] = {0};
    char wind_speed_unit_ascii[20] = {0};
    panel_data_store_copy_ascii_text(temperature_unit_ascii, sizeof(temperature_unit_ascii),
                                     temperature_unit, "");
    panel_data_store_copy_ascii_text(wind_speed_unit_ascii, sizeof(wind_speed_unit_ascii),
                                     wind_speed_unit, "");
    char state_text[32] = {0};
    panel_data_store_ascii_state(change, state_text, sizeof(state_text));
    char now_line[72] = {0};
    if (has_temperature && has_humidity && has_wind_speed) {
        snprintf(now_line, sizeof(now_line), "当前 %.16s %.1f%.4s H%.0f%% W%.1f%.8s",
                 state_text, temperature, temperature_unit_ascii, humidity, wind_speed, wind_speed_unit_ascii);
    } else if (has_temperature && has_humidity) {
        snprintf(now_line, sizeof(now_line), "当前 %.16s %.1f%.4s H%.0f%%",
                 state_text, temperature, temperature_unit_ascii, humidity);
    } else if (has_temperature) {
        snprintf(now_line, sizeof(now_line), "当前 %.16s %.1f%.4s", state_text, temperature, temperature_unit_ascii);
    } else {
        snprintf(now_line, sizeof(now_line), "当前 %.16s", state_text);
    }

    char today_line[56] = "今日 晴雨-- 最高-- 最低-- 雨-- AQI--";
    char tomorrow_line[56] = "明日 晴雨-- 最高-- 最低-- 雨-- AQI--";
    cJSON *forecast = panel_data_store_json_array(attrs, "forecast");
    for (int i = 0; forecast != NULL && i < 2; ++i) {
        cJSON *item = cJSON_GetArrayItem(forecast, i);
        if (!cJSON_IsObject(item)) {
            continue;
        }
        const char *condition = panel_data_store_json_string(item, "condition");
        double high = 0.0;
        double low = 0.0;
        double rain = 0.0;
        double forecast_aqi = 0.0;
        bool has_high = panel_data_store_json_number(item, "temperature", &high);
        bool has_low = panel_data_store_json_number(item, "templow", &low);
        bool has_rain = panel_data_store_json_number(item, "precipitation_probability", &rain);
        bool has_forecast_aqi = panel_data_store_json_number(item, "air_quality_index", &forecast_aqi) ||
                                panel_data_store_json_number(item, "aqi", &forecast_aqi) ||
                                panel_data_store_json_number(item, "air_quality", &forecast_aqi);
        char high_text[8] = "--";
        char low_text[8] = "--";
        char rain_text[8] = "--";
        char aqi_text[8] = "--";
        if (has_high) {
            snprintf(high_text, sizeof(high_text), "%.0f", high);
        }
        if (has_low) {
            snprintf(low_text, sizeof(low_text), "%.0f", low);
        }
        if (has_rain) {
            snprintf(rain_text, sizeof(rain_text), "%.0f%%", rain);
        }
        if (has_forecast_aqi || has_aqi) {
            snprintf(aqi_text, sizeof(aqi_text), "%.0f", has_forecast_aqi ? forecast_aqi : aqi);
        }
        char *line = i == 0 ? today_line : tomorrow_line;
        size_t line_len = i == 0 ? sizeof(today_line) : sizeof(tomorrow_line);
        snprintf(line, line_len, "%s %.12s %.6s/%.6s 雨%.6s AQI%.6s",
                 i == 0 ? "今日" : "明日",
                 condition != NULL ? condition : "--",
                 high_text,
                 low_text,
                 rain_text,
                 aqi_text);
    }

    snprintf(buffer, buffer_len, "%s\n%s\n%s", now_line, today_line, tomorrow_line);

    cJSON_Delete(attrs);
    return true;
}

esp_err_t panel_data_store_init(void)
{
    if (s_store.initialized) {
        return ESP_OK;
    }

    memset(&s_store, 0, sizeof(s_store));
    s_store.mutex = xSemaphoreCreateMutex();
    ESP_RETURN_ON_FALSE(s_store.mutex != NULL, ESP_ERR_NO_MEM, TAG, "panel store mutex alloc failed");
#if CONFIG_P4HOME_PANEL_STORE_AUTOSTART
    ESP_RETURN_ON_ERROR(ha_client_set_state_change_callback(panel_data_store_on_ha_state_change, NULL),
                        TAG, "failed to attach HA callback");
#endif
    s_store.initialized = true;
    return ESP_OK;
}

esp_err_t panel_data_store_register(const panel_sensor_t *seed)
{
    ESP_RETURN_ON_FALSE(seed != NULL, ESP_ERR_INVALID_ARG, TAG, "seed is required");
    ESP_RETURN_ON_FALSE(s_store.initialized, ESP_ERR_INVALID_STATE, TAG, "panel store not initialized");
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    int existing = panel_data_store_find_index_locked(seed->entity_id);
    if (existing >= 0) {
        s_store.entities[existing] = *seed;
        memset(&s_store.history[existing], 0, sizeof(s_store.history[existing]));
        xSemaphoreGive(s_store.mutex);
        return ESP_OK;
    }
    if (s_store.count >= CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES) {
        s_store.rejected_count++;
        xSemaphoreGive(s_store.mutex);
        return ESP_ERR_NO_MEM;
    }
    s_store.entities[s_store.count++] = *seed;
    xSemaphoreGive(s_store.mutex);
    return ESP_OK;
}

esp_err_t panel_data_store_update(const panel_sensor_t *sensor)
{
    ESP_RETURN_ON_FALSE(sensor != NULL, ESP_ERR_INVALID_ARG, TAG, "sensor is required");
    ESP_RETURN_ON_FALSE(s_store.initialized, ESP_ERR_INVALID_STATE, TAG, "panel store not initialized");

    panel_sensor_t applied = {0};
    bool notify = false;

    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    int index = panel_data_store_find_index_locked(sensor->entity_id);
    if (index < 0) {
        s_store.rejected_count++;
        xSemaphoreGive(s_store.mutex);
        return ESP_ERR_NOT_FOUND;
    }

    panel_sensor_t *dst = &s_store.entities[index];
    if (sensor->label[0] != '\0') {
        snprintf(dst->label, sizeof(dst->label), "%s", sensor->label);
    }
    if (sensor->unit[0] != '\0') {
        snprintf(dst->unit, sizeof(dst->unit), "%s", sensor->unit);
    }
    if (sensor->icon[0] != '\0') {
        snprintf(dst->icon, sizeof(dst->icon), "%s", sensor->icon);
    }
    if (sensor->group[0] != '\0') {
        snprintf(dst->group, sizeof(dst->group), "%s", sensor->group);
    }
    if (sensor->kind != PANEL_SENSOR_KIND_NUMERIC || dst->kind == PANEL_SENSOR_KIND_NUMERIC) {
        dst->kind = sensor->kind;
    }
    dst->value_numeric = sensor->value_numeric;
    snprintf(dst->value_text, sizeof(dst->value_text), "%s", sensor->value_text);
    dst->updated_at_ms = sensor->updated_at_ms;
    dst->available = sensor->available;
    dst->freshness = sensor->freshness;
    panel_data_store_append_sample_locked((size_t)index, dst,
                                          sensor->updated_at_ms != 0U ? sensor->updated_at_ms
                                                                      : time_service_now_epoch_ms(),
                                          s_store.history[index].count == 0U);
    applied = *dst;
    notify = s_store.observer != NULL;
    panel_data_store_observer_cb_t observer = s_store.observer;
    void *observer_user = s_store.observer_user;
    xSemaphoreGive(s_store.mutex);

    if (notify) {
        observer(&applied, observer_user);
    }
    return ESP_OK;
}

size_t panel_data_store_get_samples(const char *entity_id, panel_sensor_sample_t *samples, size_t max_samples)
{
    if (entity_id == NULL || samples == NULL || max_samples == 0U || !s_store.initialized) {
        return 0U;
    }

    size_t copied = 0U;
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    int index = panel_data_store_find_index_locked(entity_id);
    if (index >= 0) {
        const panel_sensor_history_t *history = &s_store.history[index];
        size_t count = history->count < max_samples ? history->count : max_samples;
        size_t start = history->count == CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS ? history->head : 0U;
        if (history->count > count) {
            start = (start + history->count - count) % CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS;
        }
        for (size_t i = 0; i < count; ++i) {
            samples[i] = history->samples[(start + i) % CONFIG_P4HOME_PANEL_STORE_HISTORY_POINTS];
        }
        copied = count;
    }
    xSemaphoreGive(s_store.mutex);
    return copied;
}

bool panel_data_store_get_snapshot(const char *entity_id, panel_sensor_t *sensor)
{
    if (entity_id == NULL || sensor == NULL || !s_store.initialized) {
        return false;
    }
    bool found = false;
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    int index = panel_data_store_find_index_locked(entity_id);
    if (index >= 0) {
        *sensor = s_store.entities[index];
        found = true;
    }
    xSemaphoreGive(s_store.mutex);
    return found;
}

size_t panel_data_store_entity_count(void)
{
    size_t count = 0;
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    count = s_store.count;
    xSemaphoreGive(s_store.mutex);
    return count;
}

size_t panel_data_store_rejected_count(void)
{
    size_t count = 0;
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    count = s_store.rejected_count;
    xSemaphoreGive(s_store.mutex);
    return count;
}

void panel_data_store_tick_freshness(uint64_t now_ms)
{
    if (!s_store.initialized) {
        return;
    }
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    for (size_t i = 0; i < s_store.count; ++i) {
        s_store.entities[i].freshness =
            panel_data_store_compute_freshness(now_ms, s_store.entities[i].updated_at_ms);
        panel_data_store_append_sample_locked(i, &s_store.entities[i], now_ms, false);
    }
    xSemaphoreGive(s_store.mutex);
}

esp_err_t panel_data_store_set_observer(panel_data_store_observer_cb_t observer, void *user_data)
{
    if (!s_store.initialized) {
        return ESP_ERR_INVALID_STATE;
    }
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    s_store.observer = observer;
    s_store.observer_user = user_data;
    xSemaphoreGive(s_store.mutex);
    return ESP_OK;
}

void panel_data_store_iterate(panel_data_store_iterate_cb_t callback, void *user_data)
{
    if (callback == NULL || !s_store.initialized) {
        return;
    }

    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    size_t count = s_store.count;
    panel_sensor_t *snapshot = NULL;
    if (count > 0U) {
        snapshot = malloc(count * sizeof(panel_sensor_t));
    }
    if (count > 0U && snapshot == NULL) {
        xSemaphoreGive(s_store.mutex);
        ESP_LOGW(TAG, "iterate snapshot alloc failed for %u entities", (unsigned)count);
        return;
    }
    if (count > 0U) {
        memcpy(snapshot, s_store.entities, count * sizeof(panel_sensor_t));
    }
    xSemaphoreGive(s_store.mutex);

    for (size_t i = 0; i < count; ++i) {
        if (!callback(&snapshot[i], user_data)) {
            break;
        }
    }
    free(snapshot);
}

void panel_data_store_log_summary(void)
{
    size_t stale = 0U;
    xSemaphoreTake(s_store.mutex, portMAX_DELAY);
    for (size_t i = 0; i < s_store.count; ++i) {
        if (s_store.entities[i].freshness == PANEL_SENSOR_FRESHNESS_STALE) {
            stale++;
        }
    }
    ESP_LOGI(TAG, "panel_store count=%u rejected=%u stale=%u threshold_ms=%u",
             (unsigned)s_store.count, (unsigned)s_store.rejected_count, (unsigned)stale,
             (unsigned)CONFIG_P4HOME_PANEL_STORE_STALE_MS);
    xSemaphoreGive(s_store.mutex);
}

void panel_data_store_on_ha_state_change(const ha_client_state_change_t *change, void *user_data)
{
    (void)user_data;
    if (change == NULL || change->entity_id == NULL) {
        return;
    }

    panel_sensor_t sensor = {0};
    if (!panel_data_store_get_snapshot(change->entity_id, &sensor)) {
        xSemaphoreTake(s_store.mutex, portMAX_DELAY);
        s_store.rejected_count++;
        xSemaphoreGive(s_store.mutex);
        return;
    }

    sensor.updated_at_ms = change->updated_at_ms;
    sensor.available = change->available;
    sensor.freshness = change->updated_at_ms == 0U ? PANEL_SENSOR_FRESHNESS_UNKNOWN
                                                   : PANEL_SENSOR_FRESHNESS_FRESH;

    if (sensor.kind == PANEL_SENSOR_KIND_NUMERIC) {
        sensor.value_numeric = strtod(change->state_text, NULL);
        if (panel_data_store_sensor_wants_celsius(&sensor) &&
            panel_data_store_unit_is_fahrenheit(change->unit_text)) {
            sensor.value_numeric = (sensor.value_numeric - 32.0) * (5.0 / 9.0);
            snprintf(sensor.unit, sizeof(sensor.unit), "%s", "C");
        } else if (panel_data_store_sensor_wants_celsius(&sensor) &&
                   panel_data_store_unit_is_celsius(change->unit_text)) {
            snprintf(sensor.unit, sizeof(sensor.unit), "%s", "C");
        }
        snprintf(sensor.value_text, sizeof(sensor.value_text), "%.1f", sensor.value_numeric);
    } else if (sensor.kind == PANEL_SENSOR_KIND_TEXT &&
               (strncmp(sensor.entity_id, "weather.", 8) == 0 || strcmp(sensor.icon, "weather") == 0) &&
               panel_data_store_format_weather_summary(change, sensor.value_text, sizeof(sensor.value_text),
                                                       &sensor.value_numeric)) {
        /* Weather attributes are compacted into one dashboard line. */
    } else {
        panel_data_store_ascii_state(change, sensor.value_text, sizeof(sensor.value_text));
    }

    if (sensor.unit[0] == '\0' && change->unit_text != NULL && change->unit_text[0] != '\0') {
        snprintf(sensor.unit, sizeof(sensor.unit), "%s",
                 panel_data_store_normalize_unit_text(change->unit_text));
    }

    (void)panel_data_store_update(&sensor);
}
