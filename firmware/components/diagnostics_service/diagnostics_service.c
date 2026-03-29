#include "diagnostics_service.h"

#include "esp_idf_version.h"
#include "esp_log.h"

static const char *TAG = "diagnostics";

void diagnostics_service_log_banner(void)
{
    ESP_LOGI(TAG, "p4home firmware starting");
    ESP_LOGI(TAG, "idf=%s", esp_get_idf_version());
}
