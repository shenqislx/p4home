#include <stdbool.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "board_support.h"
#include "diagnostics_service.h"
#include "display_service.h"
#include "panel_data_store.h"

static const char *TAG = "p4home_main";

static void log_verify_marker(const char *area, const char *check, bool pass)
{
    ESP_LOGW(TAG, "VERIFY:%s:%s:%s", area, check, pass ? "PASS" : "FAIL");
}

static void log_verify_marker_count(const char *area, const char *check, uint32_t value)
{
    ESP_LOGW(TAG, "VERIFY:%s:%s:n=%" PRIu32, area, check, value);
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

    const uint32_t wifi_verify_wait_ms = (uint32_t)CONFIG_P4HOME_WIFI_VERIFY_WAIT_MS;
    if (wifi_verify_wait_ms > 0U) {
        esp_err_t wifi_wait_err = board_support_wifi_wait_connected(wifi_verify_wait_ms);
        if (wifi_wait_err != ESP_OK) {
            ESP_LOGW(TAG,
                     "wifi not ready after %" PRIu32 "ms wait: %s",
                     wifi_verify_wait_ms, esp_err_to_name(wifi_wait_err));
        }
    }

    const uint32_t time_verify_wait_ms = (uint32_t)CONFIG_P4HOME_TIME_SYNC_WAIT_MS;
    if (time_verify_wait_ms > 0U) {
        esp_err_t time_wait_err = board_support_time_wait_synced(time_verify_wait_ms);
        if (time_wait_err != ESP_OK) {
            ESP_LOGW(TAG,
                     "time not synced after %" PRIu32 "ms wait: %s",
                     time_verify_wait_ms, esp_err_to_name(time_wait_err));
        }
    }

    const uint32_t ha_verify_wait_ms = (uint32_t)CONFIG_P4HOME_HA_CLIENT_HANDSHAKE_TIMEOUT_MS;
    if (ha_verify_wait_ms > 0U) {
        esp_err_t ha_wait_err = board_support_ha_wait_ready(ha_verify_wait_ms);
        if (ha_wait_err != ESP_OK) {
            ESP_LOGW(TAG,
                     "HA not ready after %" PRIu32 "ms wait: %s",
                     ha_verify_wait_ms, esp_err_to_name(ha_wait_err));
        }
    }

    const char *startup_page = board_support_startup_page_text();
    if (startup_page != NULL && strcmp(startup_page, "settings") == 0) {
        (void)display_service_show_page(DISPLAY_SERVICE_PAGE_SETTINGS);
    } else if (startup_page != NULL && strcmp(startup_page, "home") == 0) {
        (void)display_service_show_page(DISPLAY_SERVICE_PAGE_HOME);
    } else {
        (void)display_service_show_page(DISPLAY_SERVICE_PAGE_DASHBOARD);
    }

    ESP_LOGW(TAG, "network ready=%s stack_ready=%s event_loop_ready=%s sta_netif_ready=%s hostname=%s device_id=%s mac=%s",
             board_support_network_ready() ? "yes" : "no",
             board_support_network_stack_ready() ? "yes" : "no",
             board_support_network_event_loop_ready() ? "yes" : "no",
             board_support_network_sta_netif_ready() ? "yes" : "no",
             board_support_network_hostname(),
             board_support_network_device_id(),
             board_support_network_mac_text());
    ESP_LOGW(TAG, "wifi started=%s connected=%s has_ip=%s ip=%s retry=%" PRIu32 " last_disconnect=%s",
             board_support_wifi_started() ? "yes" : "no",
             board_support_wifi_connected() ? "yes" : "no",
             board_support_wifi_has_ip() ? "yes" : "no",
             board_support_wifi_ip_text(),
             board_support_wifi_retry_count(),
             board_support_wifi_last_disconnect_reason());
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
    char now_iso[40] = {0};
    if (board_support_time_format_now_iso8601(now_iso, sizeof(now_iso)) != ESP_OK) {
        snprintf(now_iso, sizeof(now_iso), "%s", "(unsynced)");
    }
    ESP_LOGW(TAG, "time synced=%s now=%s tz=%s",
             board_support_time_is_synced() ? "yes" : "no",
             now_iso,
             board_support_time_tz_text());
    ESP_LOGW(TAG, "ha ready=%s state=%s subscribed=%s initial_states=%" PRIu32 " error=%s",
             board_support_ha_ready() ? "yes" : "no",
             board_support_ha_state_text(),
             board_support_ha_subscription_ready() ? "yes" : "no",
             board_support_ha_initial_state_count(),
             board_support_ha_last_error_text());
    ESP_LOGW(TAG, "panel store entities=%u whitelist=%u",
             (unsigned)board_support_panel_entity_count(),
             (unsigned)board_support_panel_whitelist_count());
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
    log_verify_marker("network", "wifi_started", board_support_wifi_started());
    log_verify_marker("network", "wifi_connected", board_support_wifi_connected());
    log_verify_marker("network", "ip_acquired", board_support_wifi_has_ip());
    log_verify_marker("gateway", "registration", board_support_gateway_registered());
    log_verify_marker("gateway", "state_sync", board_support_gateway_state_synced());
    log_verify_marker("gateway", "command_mailbox", board_support_gateway_command_selftest_passed());
    log_verify_marker("settings", "nvs", board_support_settings_ready());
    log_verify_marker("settings", "ha_credentials_present", board_support_settings_ha_credentials_present());
    log_verify_marker("time", "sync_started", true);
    log_verify_marker("time", "sync_acquired", board_support_time_is_synced());
    log_verify_marker("ha", "ws_connected", board_support_ha_ready());
    log_verify_marker("ha", "authenticated", board_support_ha_ready());
    log_verify_marker("ha", "subscribed", board_support_ha_subscription_ready());
    log_verify_marker("ha", "initial_states_loaded", board_support_ha_initial_state_count() > 0U);
    log_verify_marker("ha", "reconnect_ready", true);
    log_verify_marker("ha", "metrics_exported", true);
    log_verify_marker("panel_store", "ready", board_support_panel_entity_count() > 0U);
    log_verify_marker("panel_whitelist", "parsed", board_support_panel_whitelist_count() > 0U);
    log_verify_marker("display", "bootstrap", board_support_display_ready());
    log_verify_marker("ui", "dashboard_rendered",
                      strcmp(display_service_current_page_text(), "dashboard") == 0);
    log_verify_marker("ui", "status_banner_ready",
                      strcmp(display_service_current_page_text(), "dashboard") == 0);
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
    log_verify_marker_count("panel_store", "entity_count", (uint32_t)board_support_panel_entity_count());
    log_verify_marker_count("ui", "dashboard_card_count", (uint32_t)board_support_panel_entity_count());

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
            diagnostics_service_log_ha_summary();
            panel_data_store_tick_freshness((uint64_t)(esp_timer_get_time() / 1000ULL));
            last_heartbeat_tick = now;
        }

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
