#pragma once

#include <stdbool.h>

#include "esp_err.h"

esp_err_t board_support_init(void);
const char *board_support_get_name(void);
void board_support_log_summary(void);
bool board_support_display_ready(void);
bool board_support_touch_ready(void);
bool board_support_touch_detected(void);
