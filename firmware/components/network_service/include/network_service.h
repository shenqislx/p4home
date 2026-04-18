#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_netif.h"

typedef struct {
    bool ready;
    bool esp_netif_ready;
    bool event_loop_ready;
    bool sta_netif_ready;
    bool hosted_transport_up;
    bool netif_up;
    bool wifi_started;
    bool wifi_connected;
    bool wifi_has_ip;
    esp_netif_dhcp_status_t dhcp_client_status;
    uint32_t retry_count;
    const char *hostname;
    const char *device_id;
    const char *mac_text;
    const char *ip_text;
    const char *last_disconnect_reason;
} network_service_snapshot_t;

esp_err_t network_service_init(void);
bool network_service_is_ready(void);
bool network_service_esp_netif_ready(void);
bool network_service_event_loop_ready(void);
bool network_service_sta_netif_ready(void);
bool network_service_wifi_started(void);
bool network_service_wifi_connected(void);
bool network_service_wifi_has_ip(void);
const char *network_service_hostname(void);
const char *network_service_device_id(void);
const char *network_service_mac_text(void);
const char *network_service_ip_text(void);
const char *network_service_last_disconnect_reason(void);
uint32_t network_service_wifi_retry_count(void);

/**
 * @brief Wait until Wi-Fi reaches the GOT_IP state.
 *
 * @param timeout_ms Maximum time to wait. 0 means poll (return immediately).
 * @return ESP_OK if Wi-Fi has an IP when this call returns,
 *         ESP_ERR_TIMEOUT if it doesn't, or
 *         ESP_ERR_INVALID_STATE if Wi-Fi was never started.
 */
esp_err_t network_service_wait_connected(uint32_t timeout_ms);

void network_service_get_snapshot(network_service_snapshot_t *snapshot);
void network_service_log_summary(void);
