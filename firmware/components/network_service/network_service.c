#include "network_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"

static const char *TAG = "network_service";
static const char *DEFAULT_HOSTNAME_PREFIX = "p4home-p4";

typedef struct {
    bool initialized;
    bool esp_netif_ready;
    bool event_loop_ready;
    bool sta_netif_ready;
    esp_netif_t *sta_netif;
    uint8_t mac[6];
    char mac_text[18];
    char hostname[32];
    char device_id[24];
} network_service_state_t;

static network_service_state_t s_state;

static void network_service_format_identity_strings(void)
{
    snprintf(s_state.mac_text, sizeof(s_state.mac_text),
             "%02x:%02x:%02x:%02x:%02x:%02x",
             s_state.mac[0], s_state.mac[1], s_state.mac[2],
             s_state.mac[3], s_state.mac[4], s_state.mac[5]);
    snprintf(s_state.hostname, sizeof(s_state.hostname),
             "%s-%02x%02x%02x",
             DEFAULT_HOSTNAME_PREFIX,
             s_state.mac[3], s_state.mac[4], s_state.mac[5]);
    snprintf(s_state.device_id, sizeof(s_state.device_id),
             "p4-%02x%02x%02x",
             s_state.mac[3], s_state.mac[4], s_state.mac[5]);
}

static esp_err_t network_service_init_tcpip_stack(void)
{
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK) {
        s_state.esp_netif_ready = true;
        return ESP_OK;
    }
    return err;
}

static esp_err_t network_service_init_default_event_loop(void)
{
    esp_err_t err = esp_event_loop_create_default();
    if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) {
        s_state.event_loop_ready = true;
        return ESP_OK;
    }
    return err;
}

static esp_err_t network_service_init_identity(void)
{
    esp_err_t err = esp_base_mac_addr_get(s_state.mac);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to read base mac");
    network_service_format_identity_strings();
    return ESP_OK;
}

static esp_err_t network_service_init_sta_netif(void)
{
    esp_netif_config_t sta_cfg = ESP_NETIF_DEFAULT_WIFI_STA();
    s_state.sta_netif = esp_netif_new(&sta_cfg);
    ESP_RETURN_ON_FALSE(s_state.sta_netif != NULL, ESP_FAIL, TAG,
                        "failed to create wifi sta-shaped esp_netif");

    esp_err_t err = esp_netif_set_hostname(s_state.sta_netif, s_state.hostname);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to set wifi sta hostname");

    s_state.sta_netif_ready = true;
    return ESP_OK;
}

esp_err_t network_service_init(void)
{
    if (s_state.initialized) {
        ESP_LOGI(TAG, "network service already initialized");
        return ESP_OK;
    }

    memset(&s_state, 0, sizeof(s_state));

    ESP_RETURN_ON_ERROR(network_service_init_tcpip_stack(), TAG,
                        "failed to init tcpip stack");
    ESP_RETURN_ON_ERROR(network_service_init_default_event_loop(), TAG,
                        "failed to init default event loop");
    ESP_RETURN_ON_ERROR(network_service_init_identity(), TAG,
                        "failed to init network identity");
    ESP_RETURN_ON_ERROR(network_service_init_sta_netif(), TAG,
                        "failed to init sta netif");

    s_state.initialized = true;

    ESP_LOGI(TAG,
             "network ready hostname=%s device_id=%s mac=%s sta_netif=%p",
             s_state.hostname,
             s_state.device_id,
             s_state.mac_text,
             (void *)s_state.sta_netif);
    return ESP_OK;
}

bool network_service_is_ready(void)
{
    return s_state.initialized;
}

bool network_service_esp_netif_ready(void)
{
    return s_state.esp_netif_ready;
}

bool network_service_event_loop_ready(void)
{
    return s_state.event_loop_ready;
}

bool network_service_sta_netif_ready(void)
{
    return s_state.sta_netif_ready;
}

const char *network_service_hostname(void)
{
    return s_state.hostname[0] != '\0' ? s_state.hostname : "unset";
}

const char *network_service_device_id(void)
{
    return s_state.device_id[0] != '\0' ? s_state.device_id : "unset";
}

const char *network_service_mac_text(void)
{
    return s_state.mac_text[0] != '\0' ? s_state.mac_text : "unset";
}

void network_service_get_snapshot(network_service_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    snapshot->ready = s_state.initialized;
    snapshot->esp_netif_ready = s_state.esp_netif_ready;
    snapshot->event_loop_ready = s_state.event_loop_ready;
    snapshot->sta_netif_ready = s_state.sta_netif_ready;
    snapshot->hostname = network_service_hostname();
    snapshot->device_id = network_service_device_id();
    snapshot->mac_text = network_service_mac_text();
}

void network_service_log_summary(void)
{
    ESP_LOGI(TAG,
             "network ready=%s esp_netif_ready=%s event_loop_ready=%s sta_netif_ready=%s hostname=%s device_id=%s mac=%s",
             s_state.initialized ? "yes" : "no",
             s_state.esp_netif_ready ? "yes" : "no",
             s_state.event_loop_ready ? "yes" : "no",
             s_state.sta_netif_ready ? "yes" : "no",
             network_service_hostname(),
             network_service_device_id(),
             network_service_mac_text());
}
