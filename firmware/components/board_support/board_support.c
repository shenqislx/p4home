#include "board_support.h"

#include <stdbool.h>

#include "display_service.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "touch_service.h"

static const char *TAG = "board_support";
static bool s_board_initialized;

esp_err_t board_support_init(void)
{
    if (s_board_initialized) {
        ESP_LOGI(TAG, "board support already initialized");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "starting minimal board initialization");

    ESP_ERROR_CHECK(display_service_init());
    esp_err_t touch_ret = touch_service_run_diagnostics();
    if (touch_ret != ESP_OK) {
        ESP_LOGW(TAG, "touch diagnostics failed: %s", esp_err_to_name(touch_ret));
    }
    if (touch_service_bsp_touch_ready()) {
        touch_ret = touch_service_attach_to_lvgl(display_service_get_handle());
        if (touch_ret != ESP_OK) {
            ESP_LOGW(TAG, "LVGL touch attach failed: %s", esp_err_to_name(touch_ret));
        } else {
            ESP_ERROR_CHECK(display_service_set_touch_state(true));
        }
    }
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
    display_service_log_summary();
    touch_service_log_summary();
}

bool board_support_display_ready(void)
{
    return display_service_is_ready();
}

bool board_support_touch_ready(void)
{
    return touch_service_bsp_touch_ready();
}

bool board_support_touch_detected(void)
{
    return touch_service_gt911_detected();
}

bool board_support_touch_indev_ready(void)
{
    return touch_service_lvgl_indev_ready();
}
