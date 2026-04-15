#pragma once

#include <stdbool.h>

#include "esp_err.h"

typedef struct {
    bool ready;
    bool esp_netif_ready;
    bool event_loop_ready;
    bool sta_netif_ready;
    const char *hostname;
    const char *device_id;
    const char *mac_text;
} network_service_snapshot_t;

esp_err_t network_service_init(void);
bool network_service_is_ready(void);
bool network_service_esp_netif_ready(void);
bool network_service_event_loop_ready(void);
bool network_service_sta_netif_ready(void);
const char *network_service_hostname(void);
const char *network_service_device_id(void);
const char *network_service_mac_text(void);
void network_service_get_snapshot(network_service_snapshot_t *snapshot);
void network_service_log_summary(void);
