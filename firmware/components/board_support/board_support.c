#include "board_support.h"

#include <stdbool.h>
#include <string.h>

#include "audio_service.h"
#include "display_service.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "gateway_service.h"
#include "network_service.h"
#include "sdkconfig.h"
#include "settings_service.h"
#include "sr_service.h"
#include "touch_service.h"

static const char *TAG = "board_support";
static bool s_board_initialized;

static esp_err_t board_support_publish_gateway_state_internal(const char *reason)
{
    gateway_service_panel_state_t panel_state = {
        .network_ready = network_service_is_ready(),
        .display_ready = display_service_is_ready(),
        .backlight_enabled = display_service_backlight_enabled(),
        .touch_ready = touch_service_lvgl_indev_ready(),
        .audio_busy = audio_service_is_busy(),
        .sr_ready = sr_service_afe_runtime_ready(),
        .active_page = display_service_current_page_text(),
        .startup_page = settings_service_startup_page_text(),
        .audio_owner = audio_service_current_owner(),
        .voice_state = sr_service_voice_state_text(),
    };

    esp_err_t err = gateway_service_publish_panel_state(&panel_state, reason);
    if (err == ESP_OK && display_service_is_ready()) {
        esp_err_t display_err = display_service_refresh_gateway_page();
        if (display_err != ESP_OK) {
            ESP_LOGW(TAG, "failed to refresh gateway page: %s", esp_err_to_name(display_err));
        }
    }
    return err;
}

static esp_err_t board_support_process_gateway_command_internal(bool *processed)
{
    if (processed != NULL) {
        *processed = false;
    }

    gateway_service_command_t command = {0};
    if (!gateway_service_take_pending_command(&command)) {
        return ESP_OK;
    }

    if (processed != NULL) {
        *processed = true;
    }

    esp_err_t action_err = ESP_OK;
    const char *detail = "command applied";

    switch (command.type) {
    case GATEWAY_SERVICE_COMMAND_SYNC_STATE:
        action_err = board_support_publish_gateway_state_internal("command-sync-state");
        detail = "state sync executed";
        break;
    case GATEWAY_SERVICE_COMMAND_SHOW_HOME:
        action_err = display_service_show_page(DISPLAY_SERVICE_PAGE_HOME);
        detail = "home page requested";
        break;
    case GATEWAY_SERVICE_COMMAND_SHOW_SETTINGS:
        action_err = display_service_show_page(DISPLAY_SERVICE_PAGE_SETTINGS);
        detail = "settings page requested";
        break;
    default:
        action_err = ESP_ERR_NOT_SUPPORTED;
        detail = "unsupported command";
        break;
    }

    if (action_err == ESP_OK && command.type != GATEWAY_SERVICE_COMMAND_SYNC_STATE) {
        action_err = board_support_publish_gateway_state_internal("command-applied");
        detail = "command applied and state synced";
    }

    gateway_service_complete_command(&command, action_err == ESP_OK,
                                     action_err == ESP_OK ? detail : esp_err_to_name(action_err));

    if (display_service_is_ready()) {
        esp_err_t display_err = display_service_refresh_gateway_page();
        if (display_err != ESP_OK) {
            ESP_LOGW(TAG, "failed to refresh gateway page after command: %s",
                     esp_err_to_name(display_err));
        }
    }

    if (action_err != ESP_OK) {
        ESP_LOGW(TAG, "gateway command %s failed: %s",
                 command.type_text,
                 esp_err_to_name(action_err));
    } else {
        ESP_LOGI(TAG, "gateway command %s applied from %s",
                 command.type_text,
                 command.source);
    }

    return action_err;
}

esp_err_t board_support_init(void)
{
    if (s_board_initialized) {
        ESP_LOGI(TAG, "board support already initialized");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "starting minimal board initialization");

    esp_err_t settings_ret = settings_service_init();
    if (settings_ret != ESP_OK) {
        ESP_LOGW(TAG, "settings service init failed: %s", esp_err_to_name(settings_ret));
    }

    esp_err_t network_ret = network_service_init();
    if (network_ret != ESP_OK) {
        ESP_LOGW(TAG, "network service init failed: %s", esp_err_to_name(network_ret));
    }

    esp_err_t gateway_ret = gateway_service_init();
    if (gateway_ret != ESP_OK) {
        ESP_LOGW(TAG, "gateway service init failed: %s", esp_err_to_name(gateway_ret));
    } else {
        const esp_app_desc_t *app_desc = esp_app_get_description();
        const gateway_service_registration_t registration = {
            .board_name = board_support_get_name(),
            .device_id = network_service_device_id(),
            .hostname = network_service_hostname(),
            .app_version = app_desc != NULL ? app_desc->version : "unknown",
            .capabilities = "display,touch,audio,sr,settings,network",
        };
        gateway_ret = gateway_service_register_device(&registration);
        if (gateway_ret != ESP_OK) {
            ESP_LOGW(TAG, "gateway registration failed: %s", esp_err_to_name(gateway_ret));
        }
    }

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

    esp_err_t audio_ret = audio_service_init();
    if (audio_ret != ESP_OK) {
        ESP_LOGW(TAG, "audio service init failed: %s", esp_err_to_name(audio_ret));
    } else {
        audio_ret = display_service_set_audio_state(audio_service_speaker_ready(),
                                                    audio_service_microphone_ready());
        if (audio_ret != ESP_OK) {
            ESP_LOGW(TAG, "audio UI state update failed: %s", esp_err_to_name(audio_ret));
        }
    }

    esp_err_t sr_ret = sr_service_init();
    if (sr_ret != ESP_OK) {
        ESP_LOGW(TAG, "sr service init failed: %s", esp_err_to_name(sr_ret));
    }

    if (gateway_service_is_ready()) {
        gateway_ret = board_support_publish_gateway_state_internal("board-init");
        if (gateway_ret != ESP_OK) {
            ESP_LOGW(TAG, "gateway state publish failed: %s", esp_err_to_name(gateway_ret));
        } else {
            gateway_ret = gateway_service_enqueue_command(GATEWAY_SERVICE_COMMAND_SYNC_STATE,
                                                          "board_selftest",
                                                          "boot");
            if (gateway_ret != ESP_OK) {
                ESP_LOGW(TAG, "gateway selftest enqueue failed: %s", esp_err_to_name(gateway_ret));
            } else {
                bool processed = false;
                gateway_ret = board_support_process_gateway_command_internal(&processed);
                if (gateway_ret != ESP_OK) {
                    ESP_LOGW(TAG, "gateway selftest command failed: %s", esp_err_to_name(gateway_ret));
                }
            }
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
    settings_service_log_summary();
    network_service_log_summary();
    gateway_service_log_summary();
    display_service_log_summary();
    touch_service_log_summary();
    audio_service_log_summary();
    sr_service_log_summary();
}

bool board_support_display_ready(void)
{
    return display_service_is_ready();
}

bool board_support_display_backlight_enabled(void)
{
    return display_service_backlight_enabled();
}

bool board_support_network_ready(void)
{
    return network_service_is_ready();
}

bool board_support_network_stack_ready(void)
{
    return network_service_esp_netif_ready();
}

bool board_support_network_event_loop_ready(void)
{
    return network_service_event_loop_ready();
}

bool board_support_network_sta_netif_ready(void)
{
    return network_service_sta_netif_ready();
}

const char *board_support_network_hostname(void)
{
    return network_service_hostname();
}

const char *board_support_network_device_id(void)
{
    return network_service_device_id();
}

const char *board_support_network_mac_text(void)
{
    return network_service_mac_text();
}

bool board_support_settings_ready(void)
{
    return settings_service_is_ready();
}

uint32_t board_support_boot_count(void)
{
    return settings_service_boot_count();
}

const char *board_support_startup_page_text(void)
{
    return settings_service_startup_page_text();
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

bool board_support_audio_speaker_ready(void)
{
    return audio_service_speaker_ready();
}

bool board_support_audio_microphone_ready(void)
{
    return audio_service_microphone_ready();
}

bool board_support_audio_tone_played(void)
{
    return audio_service_tone_played();
}

bool board_support_audio_microphone_capture_ready(void)
{
    return audio_service_microphone_capture_ready();
}

bool board_support_audio_busy(void)
{
    return audio_service_is_busy();
}

const char *board_support_audio_owner_text(void)
{
    return audio_service_current_owner();
}

bool board_support_gateway_ready(void)
{
    return gateway_service_is_ready();
}

bool board_support_gateway_registered(void)
{
    return gateway_service_is_registered();
}

bool board_support_gateway_state_synced(void)
{
    return gateway_service_state_synced();
}

bool board_support_gateway_command_mailbox_ready(void)
{
    return gateway_service_command_mailbox_ready();
}

bool board_support_gateway_command_selftest_passed(void)
{
    gateway_service_snapshot_t snapshot = {0};
    gateway_service_get_snapshot(&snapshot);
    return snapshot.last_command_id != 0U && strcmp(snapshot.last_command_status, "applied") == 0;
}

const char *board_support_gateway_last_sync_reason(void)
{
    gateway_service_snapshot_t snapshot = {0};
    gateway_service_get_snapshot(&snapshot);
    return snapshot.last_sync_reason;
}

const char *board_support_gateway_last_command_type_text(void)
{
    gateway_service_snapshot_t snapshot = {0};
    gateway_service_get_snapshot(&snapshot);
    return snapshot.last_command_type;
}

const char *board_support_gateway_last_command_status_text(void)
{
    gateway_service_snapshot_t snapshot = {0};
    gateway_service_get_snapshot(&snapshot);
    return snapshot.last_command_status;
}

esp_err_t board_support_gateway_publish_state(const char *reason)
{
    return board_support_publish_gateway_state_internal(reason);
}

esp_err_t board_support_gateway_process_pending_command(void)
{
    return board_support_process_gateway_command_internal(NULL);
}

bool board_support_sr_dependency_declared(void)
{
    return sr_service_dependency_declared();
}

bool board_support_sr_models_available(void)
{
    return sr_service_models_available();
}

unsigned int board_support_sr_model_count(void)
{
    return (unsigned int)sr_service_model_count();
}

bool board_support_sr_afe_config_ready(void)
{
    return sr_service_afe_config_ready();
}

bool board_support_sr_afe_ready(void)
{
    return sr_service_afe_ready();
}

bool board_support_sr_afe_runtime_ready(void)
{
    return sr_service_afe_runtime_ready();
}

bool board_support_sr_runtime_loop_started(void)
{
    return sr_service_runtime_loop_started();
}

bool board_support_sr_runtime_loop_active(void)
{
    return sr_service_runtime_loop_active();
}

bool board_support_sr_wake_state_machine_started(void)
{
    return sr_service_wake_state_machine_started();
}

bool board_support_sr_command_model_ready(void)
{
    return sr_service_command_model_ready();
}

bool board_support_sr_command_set_ready(void)
{
    return sr_service_command_set_ready();
}

const char *board_support_sr_voice_state_text(void)
{
    return sr_service_voice_state_text();
}

const char *board_support_sr_command_text(void)
{
    return sr_service_command_text();
}

const char *board_support_sr_status_text(void)
{
    return sr_service_status_text();
}
