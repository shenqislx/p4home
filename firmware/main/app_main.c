#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "board_support.h"
#include "diagnostics_service.h"

static const char *TAG = "p4home_main";

static void log_verify_marker(const char *area, const char *check, bool pass)
{
    ESP_LOGI(TAG, "VERIFY:%s:%s:%s", area, check, pass ? "PASS" : "FAIL");
}

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
    ESP_LOGI(TAG, "touch diagnostics gt911_detected=%s bsp_touch_ready=%s lvgl_indev_ready=%s",
             board_support_touch_detected() ? "yes" : "no",
             board_support_touch_ready() ? "yes" : "no",
             board_support_touch_indev_ready() ? "yes" : "no");
    ESP_LOGI(TAG, "audio service speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s busy=%s",
             board_support_audio_speaker_ready() ? "yes" : "no",
             board_support_audio_microphone_ready() ? "yes" : "no",
             board_support_audio_tone_played() ? "yes" : "no",
             board_support_audio_microphone_capture_ready() ? "yes" : "no",
             board_support_audio_busy() ? "yes" : "no");
    ESP_LOGI(TAG, "sr service dependency_declared=%s afe_config_ready=%s afe_ready=%s",
             board_support_sr_dependency_declared() ? "yes" : "no",
             board_support_sr_afe_config_ready() ? "yes" : "no",
             board_support_sr_afe_ready() ? "yes" : "no");
    ESP_LOGI(TAG, "sr service models_available=%s model_count=%u status=%s",
             board_support_sr_models_available() ? "yes" : "no",
             board_support_sr_model_count(),
             board_support_sr_status_text());

    log_verify_marker("boot", "board_init", true);
    log_verify_marker("display", "bootstrap", board_support_display_ready());
    log_verify_marker("touch", "detect", board_support_touch_detected());
    log_verify_marker("touch", "lvgl_indev", board_support_touch_indev_ready());
    log_verify_marker("audio", "speaker", board_support_audio_speaker_ready());
    log_verify_marker("audio", "microphone", board_support_audio_microphone_ready());
    log_verify_marker("audio", "tone_played", board_support_audio_tone_played());
    log_verify_marker("audio", "mic_capture", board_support_audio_microphone_capture_ready());
    log_verify_marker("sr", "models", board_support_sr_models_available());
    log_verify_marker("sr", "afe_preflight", board_support_sr_afe_ready());

    while (true) {
        diagnostics_service_log_runtime_heartbeat();
        vTaskDelay(pdMS_TO_TICKS(10000));
    }
}
