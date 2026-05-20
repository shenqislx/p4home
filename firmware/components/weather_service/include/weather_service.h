#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    bool initialized;
    bool started;
    bool available;
    uint32_t success_count;
    uint32_t failure_count;
    uint64_t last_success_ms;
    const char *last_error;
} weather_service_snapshot_t;

esp_err_t weather_service_init(void);
esp_err_t weather_service_start(void);
bool weather_service_is_available(void);
void weather_service_get_snapshot(weather_service_snapshot_t *snapshot);
