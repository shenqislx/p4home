#include <string.h>

#include "fake_backend.h"
#include "ha_client.h"

static bool s_ready = true;
static ha_client_state_change_cb_t s_callback;
static void *s_callback_user_data;

void fake_ha_set_ready(bool ready)
{
    s_ready = ready;
}

esp_err_t ha_client_init(void)
{
    return ESP_OK;
}

esp_err_t ha_client_start(void)
{
    return ESP_OK;
}

esp_err_t ha_client_stop(void)
{
    return ESP_OK;
}

esp_err_t ha_client_restart(void)
{
    return ESP_OK;
}

esp_err_t ha_client_wait_ready(uint32_t timeout_ms)
{
    (void)timeout_ms;
    return s_ready ? ESP_OK : ESP_ERR_TIMEOUT;
}

bool ha_client_ready(void)
{
    return s_ready;
}

ha_client_state_t ha_client_state(void)
{
    return s_ready ? HA_CLIENT_STATE_READY : HA_CLIENT_STATE_CONNECTING;
}

const char *ha_client_state_text(void)
{
    return s_ready ? "ready" : "connecting";
}

const char *ha_client_last_error_text(void)
{
    return "";
}

esp_err_t ha_client_set_initial_state_entities(const char *const *entity_ids, size_t count)
{
    (void)entity_ids;
    (void)count;
    return ESP_OK;
}

esp_err_t ha_client_set_state_change_callback(ha_client_state_change_cb_t callback, void *user_data)
{
    s_callback = callback;
    s_callback_user_data = user_data;
    return ESP_OK;
}

bool ha_client_subscription_ready(void)
{
    return s_ready;
}

uint32_t ha_client_initial_state_count(void)
{
    return (uint32_t)panel_data_store_entity_count();
}

esp_err_t ha_client_get_metrics(ha_client_metrics_t *metrics)
{
    if (metrics == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(metrics, 0, sizeof(*metrics));
    metrics->state = ha_client_state();
    metrics->initial_state_count = ha_client_initial_state_count();
    metrics->events_per_minute = 12;
    metrics->last_error_text = "";
    return ESP_OK;
}

esp_err_t ha_client_call_service(const ha_client_call_service_request_t *request)
{
    (void)request;
    return s_ready ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t ha_client_call_entity_service(const char *domain, const char *service,
                                        const char *entity_id, uint32_t timeout_ms)
{
    (void)domain;
    (void)service;
    (void)entity_id;
    (void)timeout_ms;
    return s_ready ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t ha_client_request_json(const char *type, const char *fields_json,
                                 char **result_json, uint32_t timeout_ms)
{
    (void)type;
    (void)fields_json;
    (void)timeout_ms;
    if (result_json != NULL) {
        *result_json = NULL;
    }
    return ESP_ERR_NOT_FOUND;
}

void ha_client_free_json(char *json)
{
    (void)json;
}
