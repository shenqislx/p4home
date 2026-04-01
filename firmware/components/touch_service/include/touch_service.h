#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t touch_service_run_diagnostics(void);
bool touch_service_gt911_detected(void);
bool touch_service_bsp_touch_ready(void);
uint8_t touch_service_get_gt911_address(void);
void touch_service_log_summary(void);
