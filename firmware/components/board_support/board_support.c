#include "board_support.h"

#include <stdbool.h>

#include "audio_service.h"
#include "display_service.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "settings_service.h"
#include "sr_service.h"
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

    esp_err_t settings_ret = settings_service_init();
    if (settings_ret != ESP_OK) {
        ESP_LOGW(TAG, "settings service init failed: %s", esp_err_to_name(settings_ret));
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
    display_service_log_summary();
    touch_service_log_summary();
    audio_service_log_summary();
    sr_service_log_summary();
}

bool board_support_display_ready(void)
{
    return display_service_is_ready();
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
