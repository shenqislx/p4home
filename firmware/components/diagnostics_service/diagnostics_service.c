#include "diagnostics_service.h"

#include <inttypes.h>
#include <stdbool.h>

#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_idf_version.h"
#include "esp_ota_ops.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "esp_timer.h"

static const char *TAG = "diagnostics";
static int64_t s_last_heartbeat_us;

static const char *reset_reason_to_string(esp_reset_reason_t reason)
{
    switch (reason) {
    case ESP_RST_UNKNOWN:
        return "unknown";
    case ESP_RST_POWERON:
        return "poweron";
    case ESP_RST_EXT:
        return "external-pin";
    case ESP_RST_SW:
        return "software";
    case ESP_RST_PANIC:
        return "panic";
    case ESP_RST_INT_WDT:
        return "interrupt-watchdog";
    case ESP_RST_TASK_WDT:
        return "task-watchdog";
    case ESP_RST_WDT:
        return "other-watchdog";
    case ESP_RST_DEEPSLEEP:
        return "deepsleep";
    case ESP_RST_BROWNOUT:
        return "brownout";
    case ESP_RST_SDIO:
        return "sdio";
    case ESP_RST_USB:
        return "usb";
    case ESP_RST_JTAG:
        return "jtag";
    case ESP_RST_EFUSE:
        return "efuse";
    case ESP_RST_PWR_GLITCH:
        return "power-glitch";
    case ESP_RST_CPU_LOCKUP:
        return "cpu-lockup";
    default:
        return "unmapped";
    }
}

void diagnostics_service_log_boot_banner(void)
{
    const esp_app_desc_t *app_desc = esp_app_get_description();
    esp_reset_reason_t reset_reason = esp_reset_reason();

    ESP_LOGI(TAG, "p4home firmware starting");
    ESP_LOGI(TAG, "project=%s version=%s", app_desc->project_name, app_desc->version);
    ESP_LOGI(TAG, "idf=%s compiled=%s %s", esp_get_idf_version(), app_desc->date, app_desc->time);
    ESP_LOGI(TAG, "reset_reason=%s (%d)", reset_reason_to_string(reset_reason), reset_reason);
}

void diagnostics_service_log_chip_summary(void)
{
    esp_chip_info_t chip_info;
    uint32_t flash_size = 0;
    esp_err_t flash_err = esp_flash_get_size(NULL, &flash_size);

    esp_chip_info(&chip_info);

    ESP_LOGI(TAG,
             "chip model=%d target=%s revision=%u cores=%u features=0x%" PRIx32,
             chip_info.model,
             CONFIG_IDF_TARGET,
             (unsigned)chip_info.revision,
             (unsigned)chip_info.cores,
             chip_info.features);

    if (flash_err == ESP_OK) {
        ESP_LOGI(TAG, "flash size=%" PRIu32 " bytes (%" PRIu32 " MB)",
                 flash_size,
                 flash_size / (1024U * 1024U));
    } else {
        ESP_LOGW(TAG, "flash size query failed: %s", esp_err_to_name(flash_err));
    }

#if CONFIG_SPIRAM
    bool psram_ready = esp_psram_is_initialized();
    size_t psram_size = psram_ready ? esp_psram_get_size() : 0;

    if (psram_ready) {
        ESP_LOGI(TAG, "psram configured=yes initialized=yes size=%u bytes (%u MB)",
                 (unsigned)psram_size,
                 (unsigned)(psram_size / (1024U * 1024U)));
    } else {
        ESP_LOGW(TAG, "psram configured=yes initialized=no");
    }
#else
    ESP_LOGI(TAG, "psram configured=no");
#endif
}

void diagnostics_service_log_partition_summary(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *boot = esp_ota_get_boot_partition();

    if (running != NULL) {
        ESP_LOGI(TAG, "running partition label=%s subtype=0x%02x address=0x%" PRIx32 " size=%" PRIu32,
                 running->label,
                 running->subtype,
                 running->address,
                 running->size);
    } else {
        ESP_LOGW(TAG, "running partition unavailable");
    }

    if (boot != NULL) {
        ESP_LOGI(TAG, "boot partition label=%s subtype=0x%02x address=0x%" PRIx32 " size=%" PRIu32,
                 boot->label,
                 boot->subtype,
                 boot->address,
                 boot->size);
    } else {
        ESP_LOGW(TAG, "boot partition unavailable");
    }
}

void diagnostics_service_log_memory_summary(void)
{
    size_t free_heap = esp_get_free_heap_size();
    size_t minimum_free_heap = esp_get_minimum_free_heap_size();

    ESP_LOGI(TAG, "heap free=%u bytes min_free=%u bytes",
             (unsigned)free_heap,
             (unsigned)minimum_free_heap);
}

void diagnostics_service_log_runtime_heartbeat(void)
{
    int64_t uptime_us = esp_timer_get_time();
    int64_t delta_us = s_last_heartbeat_us == 0 ? 0 : uptime_us - s_last_heartbeat_us;

    s_last_heartbeat_us = uptime_us;

    ESP_LOGI(TAG, "heartbeat uptime_ms=%" PRIi64 " delta_ms=%" PRIi64,
             uptime_us / 1000,
             delta_us / 1000);
}
