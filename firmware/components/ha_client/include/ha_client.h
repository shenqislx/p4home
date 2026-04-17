#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
    HA_CLIENT_STATE_IDLE = 0,
    HA_CLIENT_STATE_CONNECTING,
    HA_CLIENT_STATE_AUTHENTICATING,
    HA_CLIENT_STATE_READY,
    HA_CLIENT_STATE_ERROR,
} ha_client_state_t;

typedef struct {
    const char *entity_id;
    const char *state_text;
    const char *attributes_json;
    const char *unit_text;
    const char *friendly_name;
    const char *device_class;
    uint64_t updated_at_ms;
    bool available;
} ha_client_state_change_t;

typedef void (*ha_client_state_change_cb_t)(const ha_client_state_change_t *change, void *user_data);

typedef struct {
    ha_client_state_t state;
    uint32_t reconnect_count;
    uint32_t initial_state_count;
    uint32_t total_event_count;
    uint32_t events_per_minute;
    uint64_t connected_duration_ms;
    uint64_t last_connected_at_ms;
    uint64_t last_ready_at_ms;
    uint64_t last_event_at_ms;
    const char *last_error_text;
} ha_client_metrics_t;

esp_err_t ha_client_init(void);
esp_err_t ha_client_start(void);
esp_err_t ha_client_stop(void);
esp_err_t ha_client_restart(void);
esp_err_t ha_client_wait_ready(uint32_t timeout_ms);
bool ha_client_ready(void);
ha_client_state_t ha_client_state(void);
const char *ha_client_state_text(void);
const char *ha_client_last_error_text(void);
esp_err_t ha_client_set_state_change_callback(ha_client_state_change_cb_t callback, void *user_data);
bool ha_client_subscription_ready(void);
uint32_t ha_client_initial_state_count(void);
esp_err_t ha_client_get_metrics(ha_client_metrics_t *metrics);
