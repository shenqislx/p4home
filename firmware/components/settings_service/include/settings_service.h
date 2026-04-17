#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
    SETTINGS_SERVICE_STARTUP_PAGE_HOME = 0,
    SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS = 1,
    SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD = 2,
} settings_service_startup_page_t;

#define P4HOME_HA_URL_MAX_LEN 192
#define P4HOME_HA_TOKEN_MAX_LEN 256

typedef struct {
    bool ready;
    uint32_t boot_count;
    settings_service_startup_page_t startup_page;
    const char *startup_page_text;
} settings_service_snapshot_t;

esp_err_t settings_service_init(void);
bool settings_service_is_ready(void);
uint32_t settings_service_boot_count(void);
settings_service_startup_page_t settings_service_startup_page(void);
const char *settings_service_startup_page_text(void);
esp_err_t settings_service_set_startup_page(settings_service_startup_page_t page);
esp_err_t settings_service_ha_get_url(char *buffer, size_t buffer_len);
esp_err_t settings_service_ha_get_token(char *buffer, size_t buffer_len);
bool settings_service_ha_verify_tls(void);
bool settings_service_ha_credentials_present(void);
esp_err_t settings_service_ha_set_url(const char *url);
esp_err_t settings_service_ha_set_token(const char *token);
esp_err_t settings_service_ha_set_verify_tls(bool verify_tls);
void settings_service_ha_log_summary(void);
void settings_service_get_snapshot(settings_service_snapshot_t *snapshot);
void settings_service_log_summary(void);
