#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "ha_client.h"

typedef enum {
    PANEL_SENSOR_KIND_NUMERIC = 0,
    PANEL_SENSOR_KIND_BINARY,
    PANEL_SENSOR_KIND_TEXT,
    PANEL_SENSOR_KIND_TIMESTAMP,
} panel_sensor_kind_t;

typedef enum {
    PANEL_SENSOR_FRESHNESS_UNKNOWN = 0,
    PANEL_SENSOR_FRESHNESS_FRESH,
    PANEL_SENSOR_FRESHNESS_STALE,
} panel_sensor_freshness_t;

typedef struct {
    char entity_id[128];
    char label[32];
    char unit[8];
    char icon[24];
    char group[16];
    panel_sensor_kind_t kind;
    double value_numeric;
    char value_text[192];
    uint64_t updated_at_ms;
    panel_sensor_freshness_t freshness;
    bool available;
} panel_sensor_t;

typedef struct {
    uint64_t timestamp_ms;
    double value;
} panel_sensor_sample_t;

typedef void (*panel_data_store_observer_cb_t)(const panel_sensor_t *sensor, void *user_data);
typedef bool (*panel_data_store_iterate_cb_t)(const panel_sensor_t *sensor, void *user_data);

esp_err_t panel_data_store_init(void);
esp_err_t panel_data_store_register(const panel_sensor_t *seed);
esp_err_t panel_data_store_update(const panel_sensor_t *sensor);
bool panel_data_store_get_snapshot(const char *entity_id, panel_sensor_t *sensor);
size_t panel_data_store_get_samples(const char *entity_id, panel_sensor_sample_t *samples, size_t max_samples);
size_t panel_data_store_entity_count(void);
size_t panel_data_store_rejected_count(void);
void panel_data_store_tick_freshness(uint64_t now_ms);
esp_err_t panel_data_store_set_observer(panel_data_store_observer_cb_t observer, void *user_data);
void panel_data_store_iterate(panel_data_store_iterate_cb_t callback, void *user_data);
void panel_data_store_log_summary(void);
void panel_data_store_on_ha_state_change(const ha_client_state_change_t *change, void *user_data);
