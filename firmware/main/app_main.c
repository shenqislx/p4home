#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "board_support.h"
#include "diagnostics_service.h"

static const char *TAG = "p4home_main";

void app_main(void)
{
    diagnostics_service_log_boot_banner();

    ESP_ERROR_CHECK(board_support_init());

    board_support_log_summary();
    diagnostics_service_log_chip_summary();
    diagnostics_service_log_partition_summary();
    diagnostics_service_log_memory_summary();

    ESP_LOGI(TAG, "boot diagnostics baseline active");
    ESP_LOGI(TAG, "display bootstrap ready=%s",
             board_support_display_ready() ? "yes" : "no");
    ESP_LOGI(TAG, "touch diagnostics gt911_detected=%s bsp_touch_ready=%s",
             board_support_touch_detected() ? "yes" : "no",
             board_support_touch_ready() ? "yes" : "no");

    while (true) {
        diagnostics_service_log_runtime_heartbeat();
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
