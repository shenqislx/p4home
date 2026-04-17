#include "panel_data_store.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ha_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "panel_store";

typedef struct {
    bool initialized;
    panel_sensor_t entities[CONFIG_P4HOME_PANEL_STORE_MAX_ENTITIES];
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

static panel_sensor_freshness_t panel_data_store_compute_freshness(uint64_t now_ms, uint64_t updated_at_ms)
{
    if (updated_at_ms == 0U) {
        return PANEL_SENSOR_FRESHNESS_UNKNOWN;
    }
    return (now_ms - updated_at_ms) > CONFIG_P4HOME_PANEL_STORE_STALE_MS
               ? PANEL_SENSOR_FRESHNESS_STALE
               : PANEL_SENSOR_FRESHNESS_FRESH;
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
    sensor.freshness = panel_data_store_compute_freshness(ha_client_initial_state_count() > 0U
                                                              ? change->updated_at_ms
                                                              : 0U,
                                                          change->updated_at_ms);

    if (sensor.kind == PANEL_SENSOR_KIND_NUMERIC) {
        sensor.value_numeric = strtod(change->state_text, NULL);
        snprintf(sensor.value_text, sizeof(sensor.value_text), "%s", change->state_text);
    } else {
        snprintf(sensor.value_text, sizeof(sensor.value_text), "%s", change->state_text);
    }

    if (change->unit_text != NULL && change->unit_text[0] != '\0') {
        snprintf(sensor.unit, sizeof(sensor.unit), "%s", change->unit_text);
    }

    (void)panel_data_store_update(&sensor);
}
