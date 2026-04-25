#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

esp_err_t time_service_init(void);
bool time_service_is_synced(void);
esp_err_t time_service_wait_synced(uint32_t timeout_ms);
const char *time_service_tz_text(void);
esp_err_t time_service_format_now_iso8601(char *buffer, size_t buffer_len);
uint64_t time_service_last_sync_epoch_ms(void);
uint64_t time_service_now_epoch_ms(void);
