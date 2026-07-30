#include <stdio.h>
#include <string.h>
#include <time.h>

#include "fake_backend.h"
#include "time_service.h"

static uint64_t s_epoch_ms = 0;
static bool s_synced = true;

void fake_clock_set_epoch(uint64_t epoch_ms)
{
    s_epoch_ms = epoch_ms;
}

void fake_clock_advance(uint64_t delta_ms)
{
    s_epoch_ms += delta_ms;
}

uint64_t fake_clock_epoch(void)
{
    return s_epoch_ms;
}

void fake_clock_set_synced(bool synced)
{
    s_synced = synced;
}

esp_err_t time_service_init(void)
{
    return ESP_OK;
}

bool time_service_is_synced(void)
{
    return s_synced;
}

esp_err_t time_service_wait_synced(uint32_t timeout_ms)
{
    (void)timeout_ms;
    return s_synced ? ESP_OK : ESP_ERR_TIMEOUT;
}

const char *time_service_tz_text(void)
{
    return "Asia/Shanghai";
}

uint64_t time_service_last_sync_epoch_ms(void)
{
    return s_epoch_ms;
}

uint64_t time_service_now_epoch_ms(void)
{
    return s_epoch_ms;
}

esp_err_t time_service_format_now_iso8601(char *buffer, size_t buffer_len)
{
    if (buffer == NULL || buffer_len == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_synced) {
        snprintf(buffer, buffer_len, "--");
        return ESP_ERR_INVALID_STATE;
    }
    time_t seconds = (time_t)(s_epoch_ms / 1000U);
    struct tm local = {0};
    if (gmtime_r(&seconds, &local) == NULL) {
        return ESP_FAIL;
    }
    strftime(buffer, buffer_len, "%Y-%m-%dT%H:%M:%S", &local);
    return ESP_OK;
}
