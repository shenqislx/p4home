#pragma once

#include <stdbool.h>

#include "esp_err.h"

esp_err_t display_service_init(void);
bool display_service_is_ready(void);
void display_service_log_summary(void);
