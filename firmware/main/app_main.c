#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "diagnostics_service.h"

static const char *TAG = "p4home_main";

static void log_chip_summary(void)
{
    esp_chip_info_t chip_info;
    uint32_t flash_size = 0;

    esp_chip_info(&chip_info);
    esp_flash_get_size(NULL, &flash_size);

    ESP_LOGI(TAG, "chip cores=%d revision=%d flash=%luMB",
             chip_info.cores,
             chip_info.revision,
             (unsigned long)(flash_size / (1024 * 1024)));
}

void app_main(void)
{
    diagnostics_service_log_banner();
    log_chip_summary();

    ESP_LOGI(TAG, "firmware scaffold booted");

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

