#include "weather_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "network_service.h"
#include "panel_data_store.h"
#include "sdkconfig.h"
#include "time_service.h"

static const char *TAG = "weather_service";

#ifndef CONFIG_P4HOME_WEATHER_ENABLE
#define CONFIG_P4HOME_WEATHER_ENABLE 0
#endif
#ifndef CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK
#define CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK 0
#endif

#define WEATHER_SERVICE_TASK_STACK_SIZE 8192U

typedef struct {
    bool initialized;
    bool started;
    bool available;
    uint32_t success_count;
    uint32_t failure_count;
    uint64_t last_success_ms;
    char last_error[32];
    TaskHandle_t task;
} weather_service_state_t;

typedef struct {
    bool has_current_temp;
    bool has_current_humidity;
    bool has_current_wind;
    bool has_today_high;
    bool has_today_low;
    bool has_today_rain;
    bool has_tomorrow_high;
    bool has_tomorrow_low;
    bool has_tomorrow_rain;
    bool has_aqi;
    bool has_pm25;
    bool has_pm10;
    double current_temp;
    double current_humidity;
    double current_wind;
    double today_high;
    double today_low;
    double today_rain;
    double tomorrow_high;
    double tomorrow_low;
    double tomorrow_rain;
    double aqi;
    double pm25;
    double pm10;
    int current_code;
    int today_code;
    int tomorrow_code;
} weather_data_t;

static weather_service_state_t s_weather;
static portMUX_TYPE s_weather_lock = portMUX_INITIALIZER_UNLOCKED;

static void weather_service_set_error(const char *error)
{
    taskENTER_CRITICAL(&s_weather_lock);
    s_weather.failure_count++;
    snprintf(s_weather.last_error, sizeof(s_weather.last_error), "%s", error != NULL ? error : "error");
    taskEXIT_CRITICAL(&s_weather_lock);
}

static void weather_service_set_success(void)
{
    taskENTER_CRITICAL(&s_weather_lock);
    s_weather.available = true;
    s_weather.success_count++;
    s_weather.last_success_ms = time_service_now_epoch_ms();
    snprintf(s_weather.last_error, sizeof(s_weather.last_error), "%s", "idle");
    taskEXIT_CRITICAL(&s_weather_lock);
}

static const char *weather_service_code_text(int code)
{
    if (code == 0) {
        return "Sunny";
    }
    if (code >= 1 && code <= 3) {
        return "Cloudy";
    }
    if (code == 45 || code == 48) {
        return "Fog";
    }
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
        return "Rain";
    }
    if (code >= 71 && code <= 77) {
        return "Snow";
    }
    if (code >= 95 && code <= 99) {
        return "Thunderstorm";
    }
    return "Weather";
}

static bool weather_service_json_number(cJSON *root, const char *name, double *value)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (!cJSON_IsNumber(item) || value == NULL) {
        return false;
    }
    *value = item->valuedouble;
    return true;
}

static bool weather_service_json_array_number(cJSON *root, const char *name, int index, double *value)
{
    cJSON *array = cJSON_GetObjectItemCaseSensitive(root, name);
    cJSON *item = cJSON_IsArray(array) ? cJSON_GetArrayItem(array, index) : NULL;
    if (!cJSON_IsNumber(item) || value == NULL) {
        return false;
    }
    *value = item->valuedouble;
    return true;
}

static const char *weather_service_scheme(void)
{
#if CONFIG_P4HOME_WEATHER_USE_TLS
    return "https";
#else
    return "http";
#endif
}

static const char *weather_service_timezone_query(void)
{
    if (strcmp(CONFIG_P4HOME_WEATHER_TIMEZONE, "Asia/Shanghai") == 0) {
        return "Asia%2FShanghai";
    }
    return CONFIG_P4HOME_WEATHER_TIMEZONE;
}

static esp_err_t weather_service_http_get(const char *url, char **out_body)
{
    ESP_RETURN_ON_FALSE(url != NULL && out_body != NULL, ESP_ERR_INVALID_ARG, TAG, "bad http args");
    *out_body = NULL;

    esp_http_client_config_t config = {
        .url = url,
        .timeout_ms = CONFIG_P4HOME_WEATHER_CONNECT_TIMEOUT_MS,
        .buffer_size = 1024,
#if CONFIG_P4HOME_WEATHER_USE_TLS
        .crt_bundle_attach = esp_crt_bundle_attach,
#endif
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    ESP_RETURN_ON_FALSE(client != NULL, ESP_ERR_NO_MEM, TAG, "weather http init failed");

    char *body = calloc(1U, CONFIG_P4HOME_WEATHER_HTTP_MAX_BYTES + 1U);
    if (body == NULL) {
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "weather http open failed: %s", esp_err_to_name(err));
        free(body);
        esp_http_client_cleanup(client);
        return err;
    }

    int64_t content_length = esp_http_client_fetch_headers(client);
    if (content_length < 0) {
        ESP_LOGW(TAG, "weather http header fetch failed");
        free(body);
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_FAIL;
    }

    int total = 0;
    while (total < CONFIG_P4HOME_WEATHER_HTTP_MAX_BYTES) {
        int read_len = esp_http_client_read(client, body + total,
                                           CONFIG_P4HOME_WEATHER_HTTP_MAX_BYTES - total);
        if (read_len < 0) {
            ESP_LOGW(TAG, "weather http read failed");
            err = ESP_FAIL;
            break;
        }
        if (read_len == 0) {
            break;
        }
        total += read_len;
    }
    int status = esp_http_client_get_status_code(client);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (err != ESP_OK || status < 200 || status >= 300 || total == 0) {
        ESP_LOGW(TAG, "weather http invalid response err=%s status=%d bytes=%d",
                 esp_err_to_name(err), status, total);
        free(body);
        return ESP_FAIL;
    }

    body[total] = '\0';
    *out_body = body;
    return ESP_OK;
}

static esp_err_t weather_service_fetch_forecast(weather_data_t *data)
{
    char url[512];
    int written = snprintf(url, sizeof(url),
                           "%s://api.open-meteo.com/v1/forecast"
                           "?latitude=%s&longitude=%s&timezone=%s"
                           "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m"
                           "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
                           "&forecast_days=2",
                           weather_service_scheme(),
                           CONFIG_P4HOME_WEATHER_LATITUDE,
                           CONFIG_P4HOME_WEATHER_LONGITUDE,
                           weather_service_timezone_query());
    ESP_RETURN_ON_FALSE(written > 0 && (size_t)written < sizeof(url), ESP_ERR_INVALID_SIZE,
                        TAG, "forecast url too long");

    char *body = NULL;
    ESP_RETURN_ON_ERROR(weather_service_http_get(url, &body), TAG, "forecast fetch failed");
    cJSON *root = cJSON_Parse(body);
    free(body);
    ESP_RETURN_ON_FALSE(root != NULL, ESP_FAIL, TAG, "forecast json parse failed");

    cJSON *current = cJSON_GetObjectItemCaseSensitive(root, "current");
    cJSON *daily = cJSON_GetObjectItemCaseSensitive(root, "daily");
    double value = 0.0;
    if (cJSON_IsObject(current)) {
        data->has_current_temp = weather_service_json_number(current, "temperature_2m", &data->current_temp);
        data->has_current_humidity =
            weather_service_json_number(current, "relative_humidity_2m", &data->current_humidity);
        data->has_current_wind = weather_service_json_number(current, "wind_speed_10m", &data->current_wind);
        if (weather_service_json_number(current, "weather_code", &value)) {
            data->current_code = (int)value;
        }
    }
    if (cJSON_IsObject(daily)) {
        if (weather_service_json_array_number(daily, "weather_code", 0, &value)) {
            data->today_code = (int)value;
        }
        if (weather_service_json_array_number(daily, "weather_code", 1, &value)) {
            data->tomorrow_code = (int)value;
        }
        data->has_today_high = weather_service_json_array_number(daily, "temperature_2m_max", 0, &data->today_high);
        data->has_today_low = weather_service_json_array_number(daily, "temperature_2m_min", 0, &data->today_low);
        data->has_today_rain =
            weather_service_json_array_number(daily, "precipitation_probability_max", 0, &data->today_rain);
        data->has_tomorrow_high =
            weather_service_json_array_number(daily, "temperature_2m_max", 1, &data->tomorrow_high);
        data->has_tomorrow_low =
            weather_service_json_array_number(daily, "temperature_2m_min", 1, &data->tomorrow_low);
        data->has_tomorrow_rain =
            weather_service_json_array_number(daily, "precipitation_probability_max", 1, &data->tomorrow_rain);
    }

    cJSON_Delete(root);
    return data->has_current_temp ? ESP_OK : ESP_FAIL;
}

static esp_err_t weather_service_fetch_air_quality(weather_data_t *data)
{
    char url[384];
    int written = snprintf(url, sizeof(url),
                           "%s://air-quality-api.open-meteo.com/v1/air-quality"
                           "?latitude=%s&longitude=%s&timezone=%s&current=us_aqi,pm2_5,pm10&forecast_days=1",
                           weather_service_scheme(),
                           CONFIG_P4HOME_WEATHER_LATITUDE,
                           CONFIG_P4HOME_WEATHER_LONGITUDE,
                           weather_service_timezone_query());
    ESP_RETURN_ON_FALSE(written > 0 && (size_t)written < sizeof(url), ESP_ERR_INVALID_SIZE,
                        TAG, "air quality url too long");

    char *body = NULL;
    ESP_RETURN_ON_ERROR(weather_service_http_get(url, &body), TAG, "air quality fetch failed");
    cJSON *root = cJSON_Parse(body);
    free(body);
    ESP_RETURN_ON_FALSE(root != NULL, ESP_FAIL, TAG, "air quality json parse failed");

    cJSON *current = cJSON_GetObjectItemCaseSensitive(root, "current");
    if (cJSON_IsObject(current)) {
        data->has_aqi = weather_service_json_number(current, "us_aqi", &data->aqi);
        data->has_pm25 = weather_service_json_number(current, "pm2_5", &data->pm25);
        data->has_pm10 = weather_service_json_number(current, "pm10", &data->pm10);
    }
    cJSON_Delete(root);
    return data->has_aqi || data->has_pm25 || data->has_pm10 ? ESP_OK : ESP_FAIL;
}

static void weather_service_format_number(char *dst, size_t dst_len, bool has_value, double value, const char *suffix)
{
    if (dst == NULL || dst_len == 0U) {
        return;
    }
    if (!has_value) {
        snprintf(dst, dst_len, "--");
        return;
    }
    snprintf(dst, dst_len, "%.0f%s", value, suffix != NULL ? suffix : "");
}

static esp_err_t weather_service_publish(const weather_data_t *data)
{
    char temp[12], humidity[12], wind[12], today_high[12], today_low[12], today_rain[12];
    char tomorrow_high[12], tomorrow_low[12], tomorrow_rain[12], aqi[12], pm25[12];
    weather_service_format_number(temp, sizeof(temp), data->has_current_temp, data->current_temp, "C");
    weather_service_format_number(humidity, sizeof(humidity), data->has_current_humidity, data->current_humidity, "%");
    weather_service_format_number(wind, sizeof(wind), data->has_current_wind, data->current_wind, "");
    weather_service_format_number(today_high, sizeof(today_high), data->has_today_high, data->today_high, "C");
    weather_service_format_number(today_low, sizeof(today_low), data->has_today_low, data->today_low, "C");
    weather_service_format_number(today_rain, sizeof(today_rain), data->has_today_rain, data->today_rain, "%");
    weather_service_format_number(tomorrow_high, sizeof(tomorrow_high), data->has_tomorrow_high,
                                  data->tomorrow_high, "C");
    weather_service_format_number(tomorrow_low, sizeof(tomorrow_low), data->has_tomorrow_low,
                                  data->tomorrow_low, "C");
    weather_service_format_number(tomorrow_rain, sizeof(tomorrow_rain), data->has_tomorrow_rain,
                                  data->tomorrow_rain, "%");
    weather_service_format_number(aqi, sizeof(aqi), data->has_aqi, data->aqi, "");
    weather_service_format_number(pm25, sizeof(pm25), data->has_pm25, data->pm25, "");

    panel_sensor_t sensor = {
        .kind = PANEL_SENSOR_KIND_TEXT,
        .value_numeric = data->has_current_temp ? data->current_temp : 0.0,
        .freshness = PANEL_SENSOR_FRESHNESS_FRESH,
        .available = true,
    };
    snprintf(sensor.entity_id, sizeof(sensor.entity_id), "%s", CONFIG_P4HOME_WEATHER_PANEL_ENTITY_ID);
    snprintf(sensor.label, sizeof(sensor.label), "%s", "Weather");
    snprintf(sensor.icon, sizeof(sensor.icon), "%s", "weather");
    snprintf(sensor.group, sizeof(sensor.group), "%s", "Outdoor");
    snprintf(sensor.value_text, sizeof(sensor.value_text),
             "Today|%s|Now %s High %s Low %s|Rain chance %s|AQI %s PM2.5 %s\n"
             "Tomorrow|%s|High %s Low %s|Rain chance %s|AQI -- PM2.5 %s",
             weather_service_code_text(data->current_code), temp, today_high, today_low, today_rain, aqi, pm25,
             weather_service_code_text(data->tomorrow_code), tomorrow_high, tomorrow_low, tomorrow_rain, pm25);
    sensor.updated_at_ms = time_service_now_epoch_ms();
    if (sensor.updated_at_ms == 0U) {
        sensor.updated_at_ms = time_service_last_sync_epoch_ms();
    }
    return panel_data_store_update(&sensor);
}

static void weather_service_task(void *arg)
{
    (void)arg;
    while (true) {
        if (network_service_wait_connected(30000) != ESP_OK) {
            weather_service_set_error("net_wait_timeout");
            vTaskDelay(pdMS_TO_TICKS(30000));
            continue;
        }
#if CONFIG_P4HOME_WEATHER_USE_TLS
        if (time_service_wait_synced(30000) != ESP_OK) {
            weather_service_set_error("time_wait_timeout");
            ESP_LOGW(TAG, "time not synced, delaying weather HTTPS fetch");
            vTaskDelay(pdMS_TO_TICKS(10000));
            continue;
        }
#endif

        weather_data_t data = {0};
        esp_err_t forecast_err = weather_service_fetch_forecast(&data);
        esp_err_t air_err = forecast_err == ESP_OK ? weather_service_fetch_air_quality(&data) : ESP_FAIL;
        if (forecast_err == ESP_OK && weather_service_publish(&data) == ESP_OK) {
            weather_service_set_success();
            ESP_LOGW(TAG, "weather_ready source=open-meteo temp=%.1f aqi=%s%.0f air=%s",
                     data.current_temp,
                     data.has_aqi ? "" : "--",
                     data.has_aqi ? data.aqi : 0.0,
                     air_err == ESP_OK ? "ok" : "missing");
            vTaskDelay(pdMS_TO_TICKS(CONFIG_P4HOME_WEATHER_REFRESH_MS));
        } else {
            weather_service_set_error(forecast_err != ESP_OK ? "forecast_failed" : "publish_failed");
            vTaskDelay(pdMS_TO_TICKS(60000));
        }
    }
}

esp_err_t weather_service_init(void)
{
#if !CONFIG_P4HOME_WEATHER_ENABLE
    return ESP_OK;
#else
    if (s_weather.initialized) {
        return ESP_OK;
    }
    memset(&s_weather, 0, sizeof(s_weather));
    snprintf(s_weather.last_error, sizeof(s_weather.last_error), "%s", "idle");
    s_weather.initialized = true;
    return ESP_OK;
#endif
}

esp_err_t weather_service_start(void)
{
#if !CONFIG_P4HOME_WEATHER_ENABLE
    return ESP_OK;
#else
    ESP_RETURN_ON_FALSE(s_weather.initialized, ESP_ERR_INVALID_STATE, TAG, "weather service not initialized");
    if (s_weather.started) {
        return ESP_OK;
    }
#if CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK
    BaseType_t ok = xTaskCreateWithCaps(
        weather_service_task, "p4home_weather", WEATHER_SERVICE_TASK_STACK_SIZE, NULL,
        tskIDLE_PRIORITY + 3, &s_weather.task, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    BaseType_t ok = xTaskCreate(weather_service_task, "p4home_weather",
                                WEATHER_SERVICE_TASK_STACK_SIZE, NULL,
                                tskIDLE_PRIORITY + 3, &s_weather.task);
#endif
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_ERR_NO_MEM, TAG, "failed to create weather task");
#if CONFIG_P4HOME_PHASE5B_VALIDATION
    ESP_LOGW(TAG,
             "VERIFY:phase5b:background_stack:PASS task=weather external=%s size=%u",
             CONFIG_P4HOME_BACKGROUND_TASKS_EXTERNAL_STACK ? "yes" : "no",
             WEATHER_SERVICE_TASK_STACK_SIZE);
#endif
    s_weather.started = true;
    return ESP_OK;
#endif
}

bool weather_service_is_available(void)
{
    taskENTER_CRITICAL(&s_weather_lock);
    bool available = s_weather.available;
    taskEXIT_CRITICAL(&s_weather_lock);
    return available;
}

void weather_service_get_snapshot(weather_service_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }
    taskENTER_CRITICAL(&s_weather_lock);
    snapshot->initialized = s_weather.initialized;
    snapshot->started = s_weather.started;
    snapshot->available = s_weather.available;
    snapshot->success_count = s_weather.success_count;
    snapshot->failure_count = s_weather.failure_count;
    snapshot->last_success_ms = s_weather.last_success_ms;
    snapshot->last_error = s_weather.last_error;
    taskEXIT_CRITICAL(&s_weather_lock);
}
