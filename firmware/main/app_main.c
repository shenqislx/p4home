#include <stdbool.h>
#include <inttypes.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "board_support.h"
#include "diagnostics_service.h"

static const char *TAG = "p4home_main";

static void log_verify_marker(const char *area, const char *check, bool pass)
{
    ESP_LOGW(TAG, "VERIFY:%s:%s:%s", area, check, pass ? "PASS" : "FAIL");
}

void app_main(void)
{
    diagnostics_service_log_boot_banner();

    ESP_ERROR_CHECK(board_support_init());

    board_support_log_summary();
    diagnostics_service_log_chip_summary();
    diagnostics_service_log_partition_summary();
    diagnostics_service_log_memory_summary();

    ESP_LOGW(TAG, "boot diagnostics baseline active");
    ESP_LOGW(TAG, "network ready=%s stack_ready=%s event_loop_ready=%s sta_netif_ready=%s hostname=%s device_id=%s mac=%s",
             board_support_network_ready() ? "yes" : "no",
             board_support_network_stack_ready() ? "yes" : "no",
             board_support_network_event_loop_ready() ? "yes" : "no",
             board_support_network_sta_netif_ready() ? "yes" : "no",
             board_support_network_hostname(),
             board_support_network_device_id(),
             board_support_network_mac_text());
    ESP_LOGW(TAG, "gateway ready=%s registered=%s state_synced=%s command_mailbox_ready=%s last_sync_reason=%s last_command=%s/%s",
             board_support_gateway_ready() ? "yes" : "no",
             board_support_gateway_registered() ? "yes" : "no",
             board_support_gateway_state_synced() ? "yes" : "no",
             board_support_gateway_command_mailbox_ready() ? "yes" : "no",
             board_support_gateway_last_sync_reason(),
             board_support_gateway_last_command_type_text(),
             board_support_gateway_last_command_status_text());
    ESP_LOGW(TAG, "settings service ready=%s boot_count=%" PRIu32 " startup_page=%s",
             board_support_settings_ready() ? "yes" : "no",
             board_support_boot_count(),
             board_support_startup_page_text());
    ESP_LOGW(TAG, "display bootstrap ready=%s",
             board_support_display_ready() ? "yes" : "no");
    ESP_LOGW(TAG, "touch diagnostics gt911_detected=%s bsp_touch_ready=%s lvgl_indev_ready=%s",
             board_support_touch_detected() ? "yes" : "no",
             board_support_touch_ready() ? "yes" : "no",
             board_support_touch_indev_ready() ? "yes" : "no");
    ESP_LOGW(TAG, "audio service speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s busy=%s owner=%s",
             board_support_audio_speaker_ready() ? "yes" : "no",
             board_support_audio_microphone_ready() ? "yes" : "no",
             board_support_audio_tone_played() ? "yes" : "no",
             board_support_audio_microphone_capture_ready() ? "yes" : "no",
             board_support_audio_busy() ? "yes" : "no",
             board_support_audio_owner_text());
    ESP_LOGW(TAG, "sr service dependency_declared=%s afe_config_ready=%s afe_ready=%s afe_runtime_ready=%s runtime_loop_started=%s runtime_loop_active=%s wake_state_machine_started=%s command_model_ready=%s command_set_ready=%s voice_state=%s last_command=%s",
             board_support_sr_dependency_declared() ? "yes" : "no",
             board_support_sr_afe_config_ready() ? "yes" : "no",
             board_support_sr_afe_ready() ? "yes" : "no",
             board_support_sr_afe_runtime_ready() ? "yes" : "no",
             board_support_sr_runtime_loop_started() ? "yes" : "no",
             board_support_sr_runtime_loop_active() ? "yes" : "no",
             board_support_sr_wake_state_machine_started() ? "yes" : "no",
             board_support_sr_command_model_ready() ? "yes" : "no",
             board_support_sr_command_set_ready() ? "yes" : "no",
             board_support_sr_voice_state_text(),
             board_support_sr_command_text());
    ESP_LOGW(TAG, "sr service models_available=%s model_count=%u status=%s",
             board_support_sr_models_available() ? "yes" : "no",
             board_support_sr_model_count(),
             board_support_sr_status_text());

    log_verify_marker("boot", "board_init", true);
    log_verify_marker("network", "stack", board_support_network_stack_ready());
    log_verify_marker("network", "event_loop", board_support_network_event_loop_ready());
    log_verify_marker("network", "sta_netif", board_support_network_sta_netif_ready());
    log_verify_marker("gateway", "registration", board_support_gateway_registered());
    log_verify_marker("gateway", "state_sync", board_support_gateway_state_synced());
    log_verify_marker("gateway", "command_mailbox", board_support_gateway_command_selftest_passed());
    log_verify_marker("settings", "nvs", board_support_settings_ready());
    log_verify_marker("display", "bootstrap", board_support_display_ready());
    log_verify_marker("touch", "detect", board_support_touch_detected());
    log_verify_marker("touch", "lvgl_indev", board_support_touch_indev_ready());
    log_verify_marker("audio", "speaker", board_support_audio_speaker_ready());
    log_verify_marker("audio", "microphone", board_support_audio_microphone_ready());
    log_verify_marker("audio", "tone_played", board_support_audio_tone_played());
    log_verify_marker("audio", "mic_capture", board_support_audio_microphone_capture_ready());
    log_verify_marker("sr", "models", board_support_sr_models_available());
    log_verify_marker("sr", "afe_preflight", board_support_sr_afe_ready());
    log_verify_marker("sr", "afe_runtime", board_support_sr_afe_runtime_ready());
    log_verify_marker("sr", "runtime_loop", board_support_sr_runtime_loop_started());
    log_verify_marker("sr", "wake_state_machine", board_support_sr_wake_state_machine_started());
    log_verify_marker("sr", "command_model", board_support_sr_command_model_ready());
    log_verify_marker("sr", "command_set", board_support_sr_command_set_ready());

    TickType_t last_heartbeat_tick = xTaskGetTickCount();
    while (true) {
        if (board_support_gateway_ready()) {
            esp_err_t gateway_ret = board_support_gateway_process_pending_command();
            if (gateway_ret != ESP_OK) {
                ESP_LOGW(TAG, "gateway command processing failed: %s", esp_err_to_name(gateway_ret));
            }

            gateway_ret = board_support_gateway_publish_state("runtime-poll");
            if (gateway_ret != ESP_OK) {
                ESP_LOGW(TAG, "gateway state publish failed: %s", esp_err_to_name(gateway_ret));
            }
        }

        const TickType_t now = xTaskGetTickCount();
        if ((now - last_heartbeat_tick) >= pdMS_TO_TICKS(10000)) {
            diagnostics_service_log_runtime_heartbeat();
            last_heartbeat_tick = now;
        }

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
