#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef enum {
    SETTINGS_SERVICE_STARTUP_PAGE_HOME = 0,
    SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS = 1,
} settings_service_startup_page_t;

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
void settings_service_get_snapshot(settings_service_snapshot_t *snapshot);
void settings_service_log_summary(void);
