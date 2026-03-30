#pragma once

#include "esp_err.h"

esp_err_t board_support_init(void);
const char *board_support_get_name(void);
void board_support_log_summary(void);
