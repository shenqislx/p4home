#include "board_support.h"

#include <stdbool.h>

#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "board_support";
static bool s_board_initialized;

esp_err_t board_support_init(void)
{
    if (s_board_initialized) {
        ESP_LOGI(TAG, "board support already initialized");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "starting minimal board initialization");

    /* Keep M1 initialization intentionally narrow. Real peripheral bring-up
     * will be added incrementally after the boot diagnostics baseline is stable.
     */
    s_board_initialized = true;

    ESP_LOGI(TAG, "minimal board initialization complete");
    return ESP_OK;
}

const char *board_support_get_name(void)
{
    return "ESP32-P4 Function EV Board";
}

void board_support_log_summary(void)
{
    ESP_LOGI(TAG, "board=%s target=%s initialized=%s",
             board_support_get_name(),
             CONFIG_IDF_TARGET,
             s_board_initialized ? "yes" : "no");
}
