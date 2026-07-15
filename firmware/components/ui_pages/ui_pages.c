#include "ui_pages.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "audio_service.h"
#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "gateway_service.h"
#include "settings_service.h"
#include "ui_fonts.h"
#include "ui_page_climate.h"
#include "ui_page_dashboard.h"
#include "ui_page_quick_modes.h"

static const char *TAG = "ui_pages";
static bool s_display_ready;
static lv_obj_t *s_home_page;
static lv_obj_t *s_settings_page;
static lv_obj_t *s_gateway_page;
static lv_obj_t *s_dashboard_nav_button;
static lv_obj_t *s_climate_nav_button;
static lv_obj_t *s_quick_modes_nav_button;
static lv_obj_t *s_home_nav_button;
static lv_obj_t *s_settings_nav_button;
static lv_obj_t *s_gateway_nav_button;
static lv_obj_t *s_touch_status_label;
static lv_obj_t *s_touch_hint_label;
static lv_obj_t *s_audio_status_label;
static lv_obj_t *s_audio_metrics_label;
static lv_obj_t *s_audio_meter_label;
static lv_obj_t *s_audio_meter_button_label;
static lv_obj_t *s_audio_meter_bar;
static lv_obj_t *s_voice_status_label;
static lv_obj_t *s_voice_metrics_label;
static lv_obj_t *s_settings_boot_count_label;
static lv_obj_t *s_settings_startup_page_label;
static lv_obj_t *s_settings_runtime_label;
static lv_obj_t *s_settings_hint_label;
static lv_obj_t *s_gateway_registration_label;
static lv_obj_t *s_gateway_state_label;
static lv_obj_t *s_gateway_command_label;
static lv_obj_t *s_gateway_hint_label;
static uint32_t s_touch_click_count;
static TaskHandle_t s_audio_meter_task;
static bool s_audio_meter_running;
static bool s_backlight_enabled;
static bool s_touch_attached;

typedef enum {
    DISPLAY_AUDIO_ACTION_TONE,
    DISPLAY_AUDIO_ACTION_MIC_CAPTURE,
} display_audio_action_t;

static ui_pages_page_t s_current_page = UI_PAGES_PAGE_DASHBOARD;

static ui_pages_page_t ui_pages_startup_page_to_display_page(settings_service_startup_page_t page);

const char *ui_pages_page_to_text(ui_pages_page_t page)
{
    switch (page) {
    case UI_PAGES_PAGE_HOME:
        return "home";
    case UI_PAGES_PAGE_SETTINGS:
        return "settings";
    case UI_PAGES_PAGE_GATEWAY:
        return "gateway";
    case UI_PAGES_PAGE_DASHBOARD:
        return "dashboard";
    case UI_PAGES_PAGE_CLIMATE:
        return "climate";
    case UI_PAGES_PAGE_QUICK_MODES:
        return "modes";
    default:
        return "unknown";
    }
}

static const char *ui_pages_page_to_label(ui_pages_page_t page)
{
    switch (page) {
    case UI_PAGES_PAGE_HOME:
        return "Home";
    case UI_PAGES_PAGE_SETTINGS:
        return "Settings";
    case UI_PAGES_PAGE_GATEWAY:
        return "Gateway";
    case UI_PAGES_PAGE_DASHBOARD:
        return "Lights";
    case UI_PAGES_PAGE_CLIMATE:
        return "Climate";
    case UI_PAGES_PAGE_QUICK_MODES:
        return "Modes";
    default:
        return "Unknown";
    }
}

static const char *ui_pages_text_to_page_label(const char *text)
{
    if (text == NULL || text[0] == '\0') {
        return "None";
    }
    if (strcmp(text, "home") == 0) {
        return "Home";
    }
    if (strcmp(text, "settings") == 0) {
        return "Settings";
    }
    if (strcmp(text, "gateway") == 0) {
        return "Gateway";
    }
    if (strcmp(text, "dashboard") == 0) {
        return "Lights";
    }
    if (strcmp(text, "climate") == 0) {
        return "Climate";
    }
    if (strcmp(text, "modes") == 0) {
        return "Modes";
    }
    return text;
}

static const char *ui_pages_owner_to_label(const char *owner)
{
    if (owner == NULL || owner[0] == '\0' || strcmp(owner, "idle") == 0) {
        return "Idle";
    }
    if (strcmp(owner, "display_mic_meter") == 0) {
        return "Mic Meter";
    }
    if (strcmp(owner, "sr_service") == 0) {
        return "Voice Service";
    }
    return owner;
}

static const char *ui_pages_gateway_command_to_label(const char *command)
{
    if (command == NULL || command[0] == '\0' || strcmp(command, "none") == 0) {
        return "None";
    }
    if (strcmp(command, "sync_state") == 0) {
        return "Sync State";
    }
    if (strcmp(command, "show_home") == 0) {
        return "Show Home";
    }
    if (strcmp(command, "show_settings") == 0) {
        return "Show Settings";
    }
    return command;
}

static const char *ui_pages_gateway_status_to_label(const char *status)
{
    if (status == NULL || status[0] == '\0' || strcmp(status, "idle") == 0) {
        return "Idle";
    }
    if (strcmp(status, "queued") == 0) {
        return "Queued";
    }
    if (strcmp(status, "handled") == 0 || strcmp(status, "ok") == 0) {
        return "Handled";
    }
    if (strcmp(status, "failed") == 0) {
        return "Failed";
    }
    return status;
}

static const char *ui_pages_gateway_source_to_label(const char *source)
{
    if (source == NULL || source[0] == '\0' || strcmp(source, "none") == 0) {
        return "None";
    }
    if (strcmp(source, "display_ui") == 0) {
        return "Local UI";
    }
    return source;
}

static const char *ui_pages_voice_state_to_label(const char *state)
{
    if (state == NULL || state[0] == '\0' || strcmp(state, "disabled") == 0) {
        return "Disabled";
    }
    if (strcmp(state, "ready") == 0) {
        return "Ready";
    }
    if (strcmp(state, "running") == 0) {
        return "Running";
    }
    if (strcmp(state, "error") == 0) {
        return "Error";
    }
    return state;
}

static const char *ui_pages_startup_page_to_label(settings_service_startup_page_t page)
{
    return ui_pages_page_to_label(ui_pages_startup_page_to_display_page(page));
}

static const char *ui_pages_gateway_command_type_to_label(gateway_service_command_type_t command_type)
{
    return ui_pages_gateway_command_to_label(gateway_service_command_type_text(command_type));
}

static ui_pages_page_t ui_pages_startup_page_to_display_page(settings_service_startup_page_t page)
{
    return page == SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS
               ? UI_PAGES_PAGE_SETTINGS
               : (page == SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD ? UI_PAGES_PAGE_DASHBOARD
                                                                  : UI_PAGES_PAGE_HOME);
}

static settings_service_startup_page_t ui_pages_page_to_startup_page(ui_pages_page_t page)
{
    return page == UI_PAGES_PAGE_SETTINGS ? SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS
         : (page == UI_PAGES_PAGE_DASHBOARD ? SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD
                                            : SETTINGS_SERVICE_STARTUP_PAGE_HOME);
}

static void ui_pages_style_nav_button_locked(lv_obj_t *button, bool selected)
{
    if (button == NULL) {
        return;
    }

    lv_obj_set_style_bg_color(button,
                              selected ? lv_palette_main(LV_PALETTE_BLUE) : lv_color_hex(0x30363d),
                              LV_PART_MAIN);
    lv_obj_set_style_bg_opa(button, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(button, 0, LV_PART_MAIN);
}

static void ui_pages_update_meter_ui_locked(const char *status_text,
                                                   int meter_value,
                                                   const char *metrics_text,
                                                   bool meter_running)
{
    if (s_audio_status_label != NULL && status_text != NULL) {
        lv_label_set_text(s_audio_status_label, status_text);
    }
    if (s_audio_meter_bar != NULL && meter_value >= 0) {
        lv_bar_set_value(s_audio_meter_bar, meter_value, LV_ANIM_ON);
    }
    if (s_audio_metrics_label != NULL && metrics_text != NULL) {
        lv_label_set_text(s_audio_metrics_label, metrics_text);
    }
    if (s_audio_meter_button_label != NULL) {
        lv_label_set_text(s_audio_meter_button_label,
                          meter_running ? "Stop Meter" : "Start Meter");
    }
    if (s_current_page == UI_PAGES_PAGE_SETTINGS) {
        ui_pages_refresh_settings_locked(NULL);
    } else if (s_current_page == UI_PAGES_PAGE_GATEWAY) {
        ui_pages_refresh_gateway_locked(NULL);
    }
}

static void ui_pages_update_audio_labels_locked(const char *status_text,
                                                       const char *metrics_text)
{
    ui_pages_update_meter_ui_locked(status_text, -1, metrics_text, s_audio_meter_running);
}

esp_err_t ui_pages_update_audio_labels(const char *status_text, const char *metrics_text)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    ui_pages_update_audio_labels_locked(status_text, metrics_text);
    bsp_display_unlock();
    return ESP_OK;
}

static esp_err_t ui_pages_update_voice_labels_locked(const char *status_text,
                                                            const char *metrics_text)
{
    if (s_voice_status_label != NULL && status_text != NULL) {
        lv_label_set_text(s_voice_status_label, status_text);
    }
    if (s_voice_metrics_label != NULL && metrics_text != NULL) {
        lv_label_set_text(s_voice_metrics_label, metrics_text);
    }
    if (s_current_page == UI_PAGES_PAGE_SETTINGS) {
        ui_pages_refresh_settings_locked(NULL);
    } else if (s_current_page == UI_PAGES_PAGE_GATEWAY) {
        ui_pages_refresh_gateway_locked(NULL);
    }
    return ESP_OK;
}

esp_err_t ui_pages_update_voice_labels(const char *status_text, const char *metrics_text)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    ui_pages_update_voice_labels_locked(status_text, metrics_text);
    bsp_display_unlock();
    return ESP_OK;
}

esp_err_t ui_pages_update_meter_ui(const char *status_text,
                                   int meter_value,
                                   const char *metrics_text,
                                   bool meter_running)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    ui_pages_update_meter_ui_locked(status_text, meter_value, metrics_text, meter_running);
    bsp_display_unlock();
    return ESP_OK;
}

static int ui_pages_mean_abs_to_percent(uint32_t mean_abs)
{
    // Favor low-to-mid speech amplitudes so the bar remains useful during
    // near-field voice testing on the EVB's onboard microphone.
    if (mean_abs <= 64U) {
        return (int)((mean_abs * 12U) / 64U);
    }
    if (mean_abs <= 256U) {
        return 12 + (int)(((mean_abs - 64U) * 18U) / 192U);
    }
    if (mean_abs <= 1024U) {
        return 30 + (int)(((mean_abs - 256U) * 30U) / 768U);
    }
    if (mean_abs <= 4096U) {
        return 60 + (int)(((mean_abs - 1024U) * 30U) / 3072U);
    }
    if (mean_abs <= 8192U) {
        return 90 + (int)(((mean_abs - 4096U) * 10U) / 4096U);
    }
    if (mean_abs >= 16384U) {
        return 100;
    }
    return 95 + (int)(((mean_abs - 8192U) * 5U) / 8192U);
}

static void ui_pages_audio_meter_task(void *parameter)
{
    (void)parameter;
    uint32_t sample_counter = 0;

    esp_err_t ret = audio_service_begin_microphone_stream_for("display_mic_meter");
    if (ret != ESP_OK) {
        char status_text[96];
        snprintf(status_text, sizeof(status_text),
                 "Mic meter unavailable: audio is in use by %s",
                 audio_service_current_owner());
        ui_pages_update_meter_ui(status_text, 0, NULL, false);
        s_audio_meter_running = false;
        s_audio_meter_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    while (s_audio_meter_running) {
        audio_service_microphone_snapshot_t snapshot = {0};
        ret = audio_service_read_microphone_stream(&snapshot);
        if (ret != ESP_OK) {
            char status_text[96];
            snprintf(status_text, sizeof(status_text),
                     "Meter capture failed: %s",
                     esp_err_to_name(ret));
            ui_pages_update_meter_ui(status_text, 0, NULL, true);
            vTaskDelay(pdMS_TO_TICKS(250));
            continue;
        }

        char metrics_text[160];
        const int meter_value = ui_pages_mean_abs_to_percent(snapshot.mean_abs);
        snprintf(metrics_text, sizeof(metrics_text),
                 "Level=%d%% Bytes=%" PRIu32 " Peak=%u Mean=%" PRIu32 " Active=%" PRIu32,
                 meter_value,
                 snapshot.bytes_read,
                 snapshot.peak_abs,
                 snapshot.mean_abs,
                 snapshot.nonzero_samples);
        ui_pages_update_meter_ui("Mic meter running: speak near the onboard microphone",
                                        meter_value,
                                        metrics_text,
                                        true);
        sample_counter++;
        if ((sample_counter % 4U) == 0U) {
            ESP_LOGI(TAG,
                     "mic meter sample=%" PRIu32 " level=%d%% peak=%u mean=%" PRIu32 " nonzero=%" PRIu32,
                     sample_counter,
                     meter_value,
                     snapshot.peak_abs,
                     snapshot.mean_abs,
                     snapshot.nonzero_samples);
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }

    ret = audio_service_end_microphone_stream();
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "failed to stop microphone stream cleanly: %s", esp_err_to_name(ret));
    }
    ui_pages_update_meter_ui("Mic meter stopped", 0, NULL, false);
    s_audio_meter_task = NULL;
    vTaskDelete(NULL);
}

static void ui_pages_audio_action_task(void *parameter)
{
    display_audio_action_t action = (display_audio_action_t)(intptr_t)parameter;
    const bool is_tone = (action == DISPLAY_AUDIO_ACTION_TONE);
    const char *start_text = is_tone ? "Speaker test: playing a 500ms tone"
                                     : "Microphone test: capturing PCM";

    if (ui_pages_update_audio_labels(start_text, NULL) != ESP_OK) {
        ESP_LOGW(TAG, "failed to update audio start status");
    }

    esp_err_t ret = is_tone ? audio_service_play_test_tone()
                            : audio_service_capture_microphone_sample();
    if (ret != ESP_OK) {
        char status_text[96];
        if (ret == ESP_ERR_INVALID_STATE && audio_service_is_busy()) {
            snprintf(status_text, sizeof(status_text),
                     "%s unavailable: audio is in use by %s",
                     is_tone ? "Speaker test" : "Microphone test",
                     audio_service_current_owner());
        } else {
            snprintf(status_text, sizeof(status_text),
                     "%s failed: %s",
                     is_tone ? "Speaker test" : "Microphone test",
                     esp_err_to_name(ret));
        }
        ui_pages_update_audio_labels(status_text, NULL);
        ESP_LOGW(TAG, "%s action failed: %s",
                 is_tone ? "speaker" : "microphone",
                 esp_err_to_name(ret));
        vTaskDelete(NULL);
        return;
    }

    char status_text[96];
    char metrics_text[160];
    if (is_tone) {
        snprintf(status_text, sizeof(status_text),
                 "Speaker test complete: confirm the tone was audible");
        snprintf(metrics_text, sizeof(metrics_text),
                 "Speaker=%s Mic=%s Tone=%s Capture=%s",
                 audio_service_speaker_ready() ? "Yes" : "No",
                 audio_service_microphone_ready() ? "Yes" : "No",
                 audio_service_tone_played() ? "Yes" : "No",
                 audio_service_microphone_capture_ready() ? "Yes" : "No");
    } else {
        snprintf(status_text, sizeof(status_text),
                 "Microphone capture complete: check serial logs and metrics");
        snprintf(metrics_text, sizeof(metrics_text),
                 "Bytes=%" PRIu32 " Peak=%u Mean=%" PRIu32 " Active=%" PRIu32,
                 audio_service_microphone_bytes_read(),
                 audio_service_microphone_peak_abs(),
                 audio_service_microphone_mean_abs(),
                 audio_service_microphone_nonzero_samples());
    }
    ui_pages_update_audio_labels(status_text, metrics_text);
    audio_service_log_summary();
    vTaskDelete(NULL);
}

static void ui_pages_audio_button_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    const display_audio_action_t action = (display_audio_action_t)(intptr_t)lv_event_get_user_data(event);
    if (audio_service_is_busy()) {
        char status_text[96];
        snprintf(status_text, sizeof(status_text),
                 "Audio unavailable: in use by %s",
                 audio_service_current_owner());
        ui_pages_update_audio_labels_locked(status_text, NULL);
        return;
    }

    ui_pages_update_audio_labels_locked(action == DISPLAY_AUDIO_ACTION_TONE
                                                   ? "Speaker test: creating task"
                                                   : "Microphone test: creating capture task",
                                               NULL);

    const BaseType_t task_created = xTaskCreate(ui_pages_audio_action_task,
                                                action == DISPLAY_AUDIO_ACTION_TONE
                                                    ? "audio_tone"
                                                    : "audio_capture",
                                                4096,
                                                (void *)(intptr_t)action,
                                                5,
                                                NULL);
    if (task_created != pdPASS) {
        ui_pages_update_audio_labels_locked("Failed to create audio task", NULL);
        ESP_LOGW(TAG, "failed to create audio action task");
    }
}

static void ui_pages_audio_meter_button_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    if (s_audio_meter_running) {
        s_audio_meter_running = false;
        ui_pages_update_meter_ui_locked("Stopping mic meter", 0, NULL, false);
        return;
    }

    if (audio_service_is_busy()) {
        char status_text[96];
        snprintf(status_text, sizeof(status_text),
                 "Mic meter unavailable: audio is in use by %s",
                 audio_service_current_owner());
        s_audio_meter_running = false;
        ui_pages_update_meter_ui_locked(status_text, 0, NULL, false);
        return;
    }

    s_audio_meter_running = true;
    ui_pages_update_meter_ui_locked("Mic meter: creating capture loop", 0, NULL, true);
    const BaseType_t task_created = xTaskCreate(ui_pages_audio_meter_task,
                                                "audio_meter",
                                                4096,
                                                NULL,
                                                5,
                                                &s_audio_meter_task);
    if (task_created != pdPASS) {
        s_audio_meter_running = false;
        ui_pages_update_meter_ui_locked("Failed to create mic meter task", 0, NULL, false);
        ESP_LOGW(TAG, "failed to create mic meter task");
    }
}

static void ui_pages_touch_demo_event_cb(lv_event_t *event)
{
    lv_event_code_t code = lv_event_get_code(event);

    if (code != LV_EVENT_PRESSED && code != LV_EVENT_CLICKED) {
        return;
    }

    lv_indev_t *indev = lv_indev_active();
    lv_point_t point = {0};
    if (indev != NULL) {
        lv_indev_get_point(indev, &point);
    }

    if (code == LV_EVENT_PRESSED) {
        if (s_touch_status_label != NULL) {
            lv_label_set_text_fmt(s_touch_status_label,
                                  "Touch pressed (%" PRId32 ", %" PRId32 ")",
                                  point.x,
                                  point.y);
        }
        ESP_LOGI(TAG, "touch press at x=%" PRId32 " y=%" PRId32, point.x, point.y);
        return;
    }

    s_touch_click_count++;
    if (s_touch_status_label != NULL) {
        lv_label_set_text_fmt(s_touch_status_label,
                              "Touches=%" PRIu32 " Position=(%" PRId32 ", %" PRId32 ")",
                              s_touch_click_count,
                              point.x,
                              point.y);
    }
    ESP_LOGI(TAG, "touch click #%" PRIu32 " at x=%" PRId32 " y=%" PRId32,
             s_touch_click_count,
             point.x,
             point.y);
}

void ui_pages_refresh_settings_locked(const char *status_text)
{
    if (s_settings_boot_count_label != NULL) {
        lv_label_set_text_fmt(s_settings_boot_count_label,
                              "Boot count: %" PRIu32,
                              settings_service_boot_count());
    }

    if (s_settings_startup_page_label != NULL) {
        lv_label_set_text_fmt(s_settings_startup_page_label,
                              "Startup page: %s",
                              ui_pages_startup_page_to_label(settings_service_startup_page()));
    }

    if (s_settings_runtime_label != NULL) {
        lv_label_set_text_fmt(s_settings_runtime_label,
                              "Current page=%s Backlight=%s Touches=%" PRIu32 " Audio owner=%s",
                              ui_pages_page_to_label(s_current_page),
                              s_backlight_enabled ? "On" : "Off",
                              s_touch_click_count,
                              ui_pages_owner_to_label(audio_service_current_owner()));
    }

    if (s_settings_hint_label != NULL) {
        if (!settings_service_is_ready()) {
            lv_label_set_text(s_settings_hint_label,
                              "NVS is unavailable; startup page cannot be saved.");
        } else if (status_text != NULL) {
            lv_label_set_text(s_settings_hint_label, status_text);
        } else {
            lv_label_set_text(s_settings_hint_label,
                              "Save the page to show automatically after reboot.");
        }
    }
}

void ui_pages_refresh_gateway_locked(const char *status_text)
{
    gateway_service_snapshot_t snapshot = {0};
    gateway_service_get_snapshot(&snapshot);

    if (s_gateway_registration_label != NULL) {
        lv_label_set_text_fmt(s_gateway_registration_label,
                              "Registered=%s Generation=%" PRIu32 "\n"
                              "Device=%s\n"
                              "Host=%s\n"
                              "Board=%s\n"
                              "Version=%s\n"
                              "Capabilities=%s",
                              snapshot.registered ? "Yes" : "No",
                              snapshot.registration_generation,
                              snapshot.device_id,
                              snapshot.hostname,
                              snapshot.board_name,
                              snapshot.app_version,
                              snapshot.capabilities);
    }

    if (s_gateway_state_label != NULL) {
        lv_label_set_text_fmt(s_gateway_state_label,
                              "State synced=%s Generation=%" PRIu32 " Reason=%s\n"
                              "Page=%s Startup=%s Backlight=%s\n"
                              "Network=%s Display=%s Touch=%s Audio busy=%s Voice=%s\n"
                              "Audio owner=%s Voice state=%s",
                              snapshot.state_synced ? "Yes" : "No",
                              snapshot.state_generation,
                              snapshot.last_sync_reason,
                              ui_pages_text_to_page_label(snapshot.active_page),
                              ui_pages_text_to_page_label(snapshot.startup_page),
                              snapshot.backlight_enabled ? "On" : "Off",
                              snapshot.network_ready ? "Yes" : "No",
                              snapshot.display_ready ? "Yes" : "No",
                              snapshot.touch_ready ? "Yes" : "No",
                              snapshot.audio_busy ? "Yes" : "No",
                              snapshot.sr_ready ? "Yes" : "No",
                              ui_pages_owner_to_label(snapshot.audio_owner),
                              ui_pages_voice_state_to_label(snapshot.voice_state));
    }

    if (s_gateway_command_label != NULL) {
        lv_label_set_text_fmt(s_gateway_command_label,
                              "Pending=%s ID=%" PRIu32 " Source=%s\n"
                              "Last=%s ID=%" PRIu32 " Status=%s\n"
                              "Detail=%s",
                              ui_pages_gateway_command_to_label(snapshot.pending_command_type),
                              snapshot.pending_command_id,
                              ui_pages_gateway_source_to_label(snapshot.pending_command_source),
                              ui_pages_gateway_command_to_label(snapshot.last_command_type),
                              snapshot.last_command_id,
                              ui_pages_gateway_status_to_label(snapshot.last_command_status),
                              snapshot.last_command_detail);
    }

    if (s_gateway_hint_label != NULL) {
        if (status_text != NULL) {
            lv_label_set_text(s_gateway_hint_label, status_text);
        } else {
            lv_label_set_text(s_gateway_hint_label,
                              "Gateway page shows registration, state sync, and command mailbox.");
        }
    }
}

void ui_pages_show_page_locked(ui_pages_page_t page)
{
    s_current_page = page;

    if (s_home_page != NULL) {
        if (page == UI_PAGES_PAGE_HOME) {
            lv_obj_clear_flag(s_home_page, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s_home_page, LV_OBJ_FLAG_HIDDEN);
        }
    }

    if (s_settings_page != NULL) {
        if (page == UI_PAGES_PAGE_SETTINGS) {
            lv_obj_clear_flag(s_settings_page, LV_OBJ_FLAG_HIDDEN);
            ui_pages_refresh_settings_locked(NULL);
        } else {
            lv_obj_add_flag(s_settings_page, LV_OBJ_FLAG_HIDDEN);
        }
    }

    if (s_gateway_page != NULL) {
        if (page == UI_PAGES_PAGE_GATEWAY) {
            lv_obj_clear_flag(s_gateway_page, LV_OBJ_FLAG_HIDDEN);
            ui_pages_refresh_gateway_locked(NULL);
        } else {
            lv_obj_add_flag(s_gateway_page, LV_OBJ_FLAG_HIDDEN);
        }
    }

    if (ui_page_dashboard_root() != NULL) {
        if (page == UI_PAGES_PAGE_DASHBOARD) {
            lv_obj_clear_flag(ui_page_dashboard_root(), LV_OBJ_FLAG_HIDDEN);
            ui_page_dashboard_show();
        } else {
            lv_obj_add_flag(ui_page_dashboard_root(), LV_OBJ_FLAG_HIDDEN);
        }
    }

    if (ui_page_climate_root() != NULL) {
        if (page == UI_PAGES_PAGE_CLIMATE) {
            lv_obj_clear_flag(ui_page_climate_root(), LV_OBJ_FLAG_HIDDEN);
            ui_page_climate_show();
        } else {
            lv_obj_add_flag(ui_page_climate_root(), LV_OBJ_FLAG_HIDDEN);
        }
    }

    if (ui_page_quick_modes_root() != NULL) {
        if (page == UI_PAGES_PAGE_QUICK_MODES) {
            lv_obj_clear_flag(ui_page_quick_modes_root(), LV_OBJ_FLAG_HIDDEN);
            ui_page_quick_modes_show();
        } else {
            lv_obj_add_flag(ui_page_quick_modes_root(), LV_OBJ_FLAG_HIDDEN);
        }
    }

    ui_pages_style_nav_button_locked(s_home_nav_button, page == UI_PAGES_PAGE_HOME);
    ui_pages_style_nav_button_locked(s_settings_nav_button, page == UI_PAGES_PAGE_SETTINGS);
    ui_pages_style_nav_button_locked(s_gateway_nav_button, page == UI_PAGES_PAGE_GATEWAY);
    ui_pages_style_nav_button_locked(s_dashboard_nav_button, page == UI_PAGES_PAGE_DASHBOARD);
    ui_pages_style_nav_button_locked(s_climate_nav_button, page == UI_PAGES_PAGE_CLIMATE);
    ui_pages_style_nav_button_locked(s_quick_modes_nav_button, page == UI_PAGES_PAGE_QUICK_MODES);
}

static void ui_pages_nav_button_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    ui_pages_page_t page = (ui_pages_page_t)(intptr_t)lv_event_get_user_data(event);
    ui_pages_show_page_locked(page);
}

static void ui_pages_save_startup_page_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    ui_pages_page_t page = (ui_pages_page_t)(intptr_t)lv_event_get_user_data(event);
    esp_err_t err = settings_service_set_startup_page(ui_pages_page_to_startup_page(page));
    if (err != ESP_OK) {
        char hint_text[96];
        snprintf(hint_text, sizeof(hint_text),
                 "Failed to save startup page: %s",
                 esp_err_to_name(err));
        ui_pages_refresh_settings_locked(hint_text);
        ESP_LOGW(TAG, "failed to save startup page: %s", esp_err_to_name(err));
        return;
    }

    char hint_text[96];
    snprintf(hint_text, sizeof(hint_text),
             "Saved startup page: %s",
             ui_pages_page_to_label(page));
    ui_pages_refresh_settings_locked(hint_text);
}

static void ui_pages_gateway_command_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    gateway_service_command_type_t command_type =
        (gateway_service_command_type_t)(intptr_t)lv_event_get_user_data(event);
    esp_err_t err = gateway_service_enqueue_command(command_type, "display_ui", ui_pages_page_to_text(s_current_page));

    char hint_text[128];
    if (err != ESP_OK) {
        snprintf(hint_text, sizeof(hint_text),
                 "Failed to queue command: %s %s",
                 ui_pages_gateway_command_type_to_label(command_type),
                 esp_err_to_name(err));
        ui_pages_refresh_gateway_locked(hint_text);
        ESP_LOGW(TAG, "failed to queue gateway command %s: %s",
                 gateway_service_command_type_text(command_type),
                 esp_err_to_name(err));
        return;
    }

    snprintf(hint_text, sizeof(hint_text),
             "Command queued: %s",
             ui_pages_gateway_command_type_to_label(command_type));
    ui_pages_refresh_gateway_locked(hint_text);
}


esp_err_t ui_pages_render_bootstrap(void)
{
    
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0d1117), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_text_font(screen, ui_pages_text_font(), LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "p4home");
    lv_obj_set_style_text_color(title, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 40, 24);

    lv_obj_t *subtitle = lv_label_create(screen);
    lv_label_set_text(subtitle, "Local hardware dashboard");
    lv_obj_set_style_text_font(subtitle, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(subtitle, lv_color_hex(0x8b949e), LV_PART_MAIN);
    lv_obj_align(subtitle, LV_ALIGN_TOP_LEFT, 40, 58);

    s_quick_modes_nav_button = lv_button_create(screen);
    lv_obj_set_size(s_quick_modes_nav_button, 104, 44);
    lv_obj_align(s_quick_modes_nav_button, LV_ALIGN_TOP_RIGHT, -600, 28);
    lv_obj_add_event_cb(s_quick_modes_nav_button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_QUICK_MODES);
    lv_obj_t *quick_modes_nav_label = lv_label_create(s_quick_modes_nav_button);
    lv_label_set_text(quick_modes_nav_label, "Modes");
    lv_obj_set_style_text_font(quick_modes_nav_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(quick_modes_nav_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(quick_modes_nav_label);

    s_dashboard_nav_button = lv_button_create(screen);
    lv_obj_set_size(s_dashboard_nav_button, 104, 44);
    lv_obj_align(s_dashboard_nav_button, LV_ALIGN_TOP_RIGHT, -488, 28);
    lv_obj_add_event_cb(s_dashboard_nav_button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_DASHBOARD);
    lv_obj_t *dashboard_nav_label = lv_label_create(s_dashboard_nav_button);
    lv_label_set_text(dashboard_nav_label, "Lights");
    lv_obj_set_style_text_font(dashboard_nav_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(dashboard_nav_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(dashboard_nav_label);

    s_climate_nav_button = lv_button_create(screen);
    lv_obj_set_size(s_climate_nav_button, 104, 44);
    lv_obj_align(s_climate_nav_button, LV_ALIGN_TOP_RIGHT, -376, 28);
    lv_obj_add_event_cb(s_climate_nav_button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_CLIMATE);
    lv_obj_t *climate_nav_label = lv_label_create(s_climate_nav_button);
    lv_label_set_text(climate_nav_label, "Climate");
    lv_obj_set_style_text_font(climate_nav_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(climate_nav_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(climate_nav_label);

    s_home_nav_button = lv_button_create(screen);
    lv_obj_set_size(s_home_nav_button, 104, 44);
    lv_obj_align(s_home_nav_button, LV_ALIGN_TOP_RIGHT, -264, 28);
    lv_obj_add_event_cb(s_home_nav_button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_HOME);
    lv_obj_t *home_nav_label = lv_label_create(s_home_nav_button);
    lv_label_set_text(home_nav_label, "Home");
    lv_obj_set_style_text_font(home_nav_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(home_nav_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(home_nav_label);

    s_settings_nav_button = lv_button_create(screen);
    lv_obj_set_size(s_settings_nav_button, 104, 44);
    lv_obj_align(s_settings_nav_button, LV_ALIGN_TOP_RIGHT, -152, 28);
    lv_obj_add_event_cb(s_settings_nav_button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_SETTINGS);
    lv_obj_t *settings_nav_label = lv_label_create(s_settings_nav_button);
    lv_label_set_text(settings_nav_label, "Settings");
    lv_obj_set_style_text_font(settings_nav_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(settings_nav_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(settings_nav_label);

    s_gateway_nav_button = lv_button_create(screen);
    lv_obj_set_size(s_gateway_nav_button, 104, 44);
    lv_obj_align(s_gateway_nav_button, LV_ALIGN_TOP_RIGHT, -40, 28);
    lv_obj_add_event_cb(s_gateway_nav_button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_GATEWAY);
    lv_obj_t *gateway_nav_label = lv_label_create(s_gateway_nav_button);
    lv_label_set_text(gateway_nav_label, "Gateway");
    lv_obj_set_style_text_font(gateway_nav_label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(gateway_nav_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(gateway_nav_label);

    s_home_page = lv_obj_create(screen);
    lv_obj_set_size(s_home_page, 944, 456);
    lv_obj_align(s_home_page, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_home_page, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_home_page, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_home_page, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_home_page, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *summary = lv_label_create(s_home_page);
    lv_label_set_text_fmt(summary,
                          "ESP32-P4 EVB V1.4\n"
                          "Screen %dx%d\n"
                          "IDF %s\n"
                          "Diagnostics ready",
                          BSP_LCD_H_RES,
                          BSP_LCD_V_RES,
                          esp_get_idf_version());
    lv_obj_set_style_text_color(summary, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_set_style_text_line_space(summary, 10, LV_PART_MAIN);
    lv_obj_align(summary, LV_ALIGN_TOP_LEFT, 0, 0);

    lv_obj_t *touch_button = lv_button_create(s_home_page);
    lv_obj_set_size(touch_button, 280, 72);
    lv_obj_align(touch_button, LV_ALIGN_TOP_LEFT, 0, 124);
    lv_obj_set_style_bg_color(touch_button, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_add_event_cb(touch_button, ui_pages_touch_demo_event_cb, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(touch_button, ui_pages_touch_demo_event_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *touch_button_label = lv_label_create(touch_button);
    lv_label_set_text(touch_button_label, "Touch Test");
    lv_obj_set_style_text_color(touch_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(touch_button_label);

    lv_obj_t *tone_button = lv_button_create(s_home_page);
    lv_obj_set_size(tone_button, 224, 64);
    lv_obj_align(tone_button, LV_ALIGN_TOP_LEFT, 0, 228);
    lv_obj_set_style_bg_color(tone_button, lv_palette_main(LV_PALETTE_GREEN), LV_PART_MAIN);
    lv_obj_add_event_cb(tone_button, ui_pages_audio_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)DISPLAY_AUDIO_ACTION_TONE);

    lv_obj_t *tone_button_label = lv_label_create(tone_button);
    lv_label_set_text(tone_button_label, "Play Tone");
    lv_obj_set_style_text_color(tone_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(tone_button_label);

    lv_obj_t *mic_button = lv_button_create(s_home_page);
    lv_obj_set_size(mic_button, 224, 64);
    lv_obj_align(mic_button, LV_ALIGN_TOP_LEFT, 248, 228);
    lv_obj_set_style_bg_color(mic_button, lv_palette_main(LV_PALETTE_ORANGE), LV_PART_MAIN);
    lv_obj_add_event_cb(mic_button, ui_pages_audio_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)DISPLAY_AUDIO_ACTION_MIC_CAPTURE);

    lv_obj_t *mic_button_label = lv_label_create(mic_button);
    lv_label_set_text(mic_button_label, "Capture Mic");
    lv_obj_set_style_text_color(mic_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(mic_button_label);

    lv_obj_t *meter_button = lv_button_create(s_home_page);
    lv_obj_set_size(meter_button, 224, 64);
    lv_obj_align(meter_button, LV_ALIGN_TOP_LEFT, 496, 228);
    lv_obj_set_style_bg_color(meter_button, lv_palette_main(LV_PALETTE_RED), LV_PART_MAIN);
    lv_obj_add_event_cb(meter_button, ui_pages_audio_meter_button_event_cb, LV_EVENT_CLICKED, NULL);

    s_audio_meter_button_label = lv_label_create(meter_button);
    lv_label_set_text(s_audio_meter_button_label, "Start Meter");
    lv_obj_set_style_text_color(s_audio_meter_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(s_audio_meter_button_label);

    s_audio_meter_label = lv_label_create(s_home_page);
    lv_label_set_text(s_audio_meter_label, "Mic Level");
    lv_obj_set_style_text_color(s_audio_meter_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_audio_meter_label, LV_ALIGN_BOTTOM_LEFT, 0, -118);

    s_audio_meter_bar = lv_bar_create(s_home_page);
    lv_obj_set_size(s_audio_meter_bar, 320, 12);
    lv_bar_set_range(s_audio_meter_bar, 0, 100);
    lv_bar_set_value(s_audio_meter_bar, 0, LV_ANIM_OFF);
    lv_obj_align(s_audio_meter_bar, LV_ALIGN_BOTTOM_LEFT, 70, -112);

    s_touch_status_label = lv_label_create(s_home_page);
    lv_label_set_text(s_touch_status_label, "Touch waiting: input device not connected");
    lv_obj_set_style_text_color(s_touch_status_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_touch_status_label, LV_ALIGN_BOTTOM_LEFT, 0, -148);

    s_touch_hint_label = lv_label_create(s_home_page);
    lv_label_set_text(s_touch_hint_label, "Touch connected: verify center and corners");
    lv_obj_set_style_text_color(s_touch_hint_label, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_align(s_touch_hint_label, LV_ALIGN_BOTTOM_LEFT, 0, -120);

    s_voice_status_label = lv_label_create(s_home_page);
    lv_label_set_text(s_voice_status_label, "Voice standby: waiting for runtime");
    lv_obj_set_style_text_color(s_voice_status_label, lv_color_hex(0xffd866), LV_PART_MAIN);
    lv_obj_align(s_voice_status_label, LV_ALIGN_BOTTOM_LEFT, 0, -92);

    s_voice_metrics_label = lv_label_create(s_home_page);
    lv_label_set_text(s_voice_metrics_label, "Voice state=Disabled Command=None Backlight=On");
    lv_obj_set_style_text_color(s_voice_metrics_label, lv_color_hex(0xffa657), LV_PART_MAIN);
    lv_obj_align(s_voice_metrics_label, LV_ALIGN_BOTTOM_LEFT, 0, -64);

    s_audio_status_label = lv_label_create(s_home_page);
    lv_label_set_text(s_audio_status_label, "Audio ready: use the buttons above to diagnose");
    lv_obj_set_style_text_color(s_audio_status_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_audio_status_label, LV_ALIGN_BOTTOM_LEFT, 0, -36);

    s_audio_metrics_label = lv_label_create(s_home_page);
    lv_label_set_text(s_audio_metrics_label, "Speaker=No Mic=No Tone=No Capture=No");
    lv_obj_set_style_text_color(s_audio_metrics_label, lv_color_hex(0x58a6ff), LV_PART_MAIN);
    lv_obj_align(s_audio_metrics_label, LV_ALIGN_BOTTOM_LEFT, 0, -12);

    s_settings_page = lv_obj_create(screen);
    lv_obj_set_size(s_settings_page, 944, 456);
    lv_obj_align(s_settings_page, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_settings_page, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_settings_page, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_settings_page, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_settings_page, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *settings_title = lv_label_create(s_settings_page);
    lv_label_set_text(settings_title, "Local Settings");
    lv_obj_set_style_text_color(settings_title, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(settings_title, LV_ALIGN_TOP_LEFT, 0, 0);

    lv_obj_t *settings_summary = lv_label_create(s_settings_page);
    lv_label_set_text(settings_summary, "Save a local startup page for the hardware diagnostics UI.");
    lv_obj_set_width(settings_summary, 720);
    lv_label_set_long_mode(settings_summary, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(settings_summary, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(settings_summary, LV_ALIGN_TOP_LEFT, 0, 42);

    s_settings_boot_count_label = lv_label_create(s_settings_page);
    lv_obj_set_style_text_color(s_settings_boot_count_label, lv_color_hex(0x58a6ff), LV_PART_MAIN);
    lv_obj_align(s_settings_boot_count_label, LV_ALIGN_TOP_LEFT, 0, 108);

    s_settings_startup_page_label = lv_label_create(s_settings_page);
    lv_obj_set_style_text_color(s_settings_startup_page_label, lv_color_hex(0x7ee787), LV_PART_MAIN);
    lv_obj_align(s_settings_startup_page_label, LV_ALIGN_TOP_LEFT, 0, 140);

    s_settings_runtime_label = lv_label_create(s_settings_page);
    lv_obj_set_width(s_settings_runtime_label, 820);
    lv_label_set_long_mode(s_settings_runtime_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(s_settings_runtime_label, lv_color_hex(0xffd866), LV_PART_MAIN);
    lv_obj_align(s_settings_runtime_label, LV_ALIGN_TOP_LEFT, 0, 184);

    lv_obj_t *save_home_button = lv_button_create(s_settings_page);
    lv_obj_set_size(save_home_button, 220, 64);
    lv_obj_align(save_home_button, LV_ALIGN_TOP_LEFT, 0, 268);
    lv_obj_set_style_bg_color(save_home_button, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_add_event_cb(save_home_button, ui_pages_save_startup_page_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_HOME);
    lv_obj_t *save_home_label = lv_label_create(save_home_button);
    lv_label_set_text(save_home_label, "Save Home");
    lv_obj_set_style_text_color(save_home_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(save_home_label);

    lv_obj_t *save_settings_button = lv_button_create(s_settings_page);
    lv_obj_set_size(save_settings_button, 220, 64);
    lv_obj_align(save_settings_button, LV_ALIGN_TOP_LEFT, 244, 268);
    lv_obj_set_style_bg_color(save_settings_button, lv_palette_main(LV_PALETTE_DEEP_ORANGE), LV_PART_MAIN);
    lv_obj_add_event_cb(save_settings_button, ui_pages_save_startup_page_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_SETTINGS);
    lv_obj_t *save_settings_label = lv_label_create(save_settings_button);
    lv_label_set_text(save_settings_label, "Save Settings");
    lv_obj_set_style_text_color(save_settings_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(save_settings_label);

    lv_obj_t *save_dashboard_button = lv_button_create(s_settings_page);
    lv_obj_set_size(save_dashboard_button, 220, 64);
    lv_obj_align(save_dashboard_button, LV_ALIGN_TOP_LEFT, 488, 268);
    lv_obj_set_style_bg_color(save_dashboard_button, lv_palette_main(LV_PALETTE_GREEN), LV_PART_MAIN);
    lv_obj_add_event_cb(save_dashboard_button, ui_pages_save_startup_page_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)UI_PAGES_PAGE_DASHBOARD);
    lv_obj_t *save_dashboard_label = lv_label_create(save_dashboard_button);
    lv_label_set_text(save_dashboard_label, "Save Dashboard");
    lv_obj_set_style_text_color(save_dashboard_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(save_dashboard_label);

    s_settings_hint_label = lv_label_create(s_settings_page);
    lv_obj_set_width(s_settings_hint_label, 840);
    lv_label_set_long_mode(s_settings_hint_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(s_settings_hint_label, lv_color_hex(0x8b949e), LV_PART_MAIN);
    lv_obj_align(s_settings_hint_label, LV_ALIGN_TOP_LEFT, 0, 352);

    lv_obj_t *settings_device_label = lv_label_create(s_settings_page);
    lv_label_set_text_fmt(settings_device_label,
                          "Board: ESP32-P4 EV Board\n"
                          "Screen: %dx%d\n"
                          "Touch, audio, and voice diagnostics are on Home.",
                          BSP_LCD_H_RES,
                          BSP_LCD_V_RES);
    lv_obj_set_style_text_color(settings_device_label, lv_color_hex(0x8b949e), LV_PART_MAIN);
    lv_obj_align(settings_device_label, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    s_gateway_page = lv_obj_create(screen);
    lv_obj_set_size(s_gateway_page, 944, 456);
    lv_obj_align(s_gateway_page, LV_ALIGN_TOP_LEFT, 40, 104);
    lv_obj_set_style_bg_opa(s_gateway_page, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_gateway_page, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_gateway_page, 0, LV_PART_MAIN);
    lv_obj_clear_flag(s_gateway_page, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *gateway_title = lv_label_create(s_gateway_page);
    lv_label_set_text(gateway_title, "Gateway Status");
    lv_obj_set_style_text_color(gateway_title, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(gateway_title, LV_ALIGN_TOP_LEFT, 0, 0);

    lv_obj_t *gateway_summary = lv_label_create(s_gateway_page);
    lv_label_set_text(gateway_summary, "This page shows device registration, panel state sync, and command mailbox.");
    lv_obj_set_width(gateway_summary, 840);
    lv_label_set_long_mode(gateway_summary, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(gateway_summary, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(gateway_summary, LV_ALIGN_TOP_LEFT, 0, 36);

    s_gateway_registration_label = lv_label_create(s_gateway_page);
    lv_obj_set_width(s_gateway_registration_label, 420);
    lv_label_set_long_mode(s_gateway_registration_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(s_gateway_registration_label, lv_color_hex(0x58a6ff), LV_PART_MAIN);
    lv_obj_align(s_gateway_registration_label, LV_ALIGN_TOP_LEFT, 0, 96);

    s_gateway_state_label = lv_label_create(s_gateway_page);
    lv_obj_set_width(s_gateway_state_label, 460);
    lv_label_set_long_mode(s_gateway_state_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(s_gateway_state_label, lv_color_hex(0x7ee787), LV_PART_MAIN);
    lv_obj_align(s_gateway_state_label, LV_ALIGN_TOP_RIGHT, 0, 96);

    s_gateway_command_label = lv_label_create(s_gateway_page);
    lv_obj_set_width(s_gateway_command_label, 840);
    lv_label_set_long_mode(s_gateway_command_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(s_gateway_command_label, lv_color_hex(0xffd866), LV_PART_MAIN);
    lv_obj_align(s_gateway_command_label, LV_ALIGN_TOP_LEFT, 0, 256);

    lv_obj_t *sync_button = lv_button_create(s_gateway_page);
    lv_obj_set_size(sync_button, 200, 60);
    lv_obj_align(sync_button, LV_ALIGN_BOTTOM_LEFT, 0, -68);
    lv_obj_set_style_bg_color(sync_button, lv_palette_main(LV_PALETTE_GREEN), LV_PART_MAIN);
    lv_obj_add_event_cb(sync_button, ui_pages_gateway_command_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)GATEWAY_SERVICE_COMMAND_SYNC_STATE);
    lv_obj_t *sync_button_label = lv_label_create(sync_button);
    lv_label_set_text(sync_button_label, "Sync State");
    lv_obj_set_style_text_color(sync_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(sync_button_label);

    lv_obj_t *home_button = lv_button_create(s_gateway_page);
    lv_obj_set_size(home_button, 200, 60);
    lv_obj_align(home_button, LV_ALIGN_BOTTOM_LEFT, 224, -68);
    lv_obj_set_style_bg_color(home_button, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_add_event_cb(home_button, ui_pages_gateway_command_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)GATEWAY_SERVICE_COMMAND_SHOW_HOME);
    lv_obj_t *home_button_label = lv_label_create(home_button);
    lv_label_set_text(home_button_label, "Show Home");
    lv_obj_set_style_text_color(home_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(home_button_label);

    lv_obj_t *settings_button = lv_button_create(s_gateway_page);
    lv_obj_set_size(settings_button, 224, 60);
    lv_obj_align(settings_button, LV_ALIGN_BOTTOM_LEFT, 448, -68);
    lv_obj_set_style_bg_color(settings_button, lv_palette_main(LV_PALETTE_DEEP_ORANGE), LV_PART_MAIN);
    lv_obj_add_event_cb(settings_button, ui_pages_gateway_command_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)GATEWAY_SERVICE_COMMAND_SHOW_SETTINGS);
    lv_obj_t *settings_button_label = lv_label_create(settings_button);
    lv_label_set_text(settings_button_label, "Show Settings");
    lv_obj_set_style_text_color(settings_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(settings_button_label);

    s_gateway_hint_label = lv_label_create(s_gateway_page);
    lv_obj_set_width(s_gateway_hint_label, 840);
    lv_label_set_long_mode(s_gateway_hint_label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(s_gateway_hint_label, lv_color_hex(0x8b949e), LV_PART_MAIN);
    lv_obj_align(s_gateway_hint_label, LV_ALIGN_BOTTOM_LEFT, 0, 0);

    ESP_RETURN_ON_ERROR(ui_page_dashboard_init(), TAG, "failed to init dashboard page");
    if (ui_page_dashboard_root() != NULL) {
        lv_obj_add_flag(ui_page_dashboard_root(), LV_OBJ_FLAG_HIDDEN);
    }

    ESP_RETURN_ON_ERROR(ui_page_climate_init(), TAG, "failed to init climate page");
    if (ui_page_climate_root() != NULL) {
        lv_obj_add_flag(ui_page_climate_root(), LV_OBJ_FLAG_HIDDEN);
    }

    ESP_RETURN_ON_ERROR(ui_page_quick_modes_init(), TAG, "failed to init quick modes page");
    if (ui_page_quick_modes_root() != NULL) {
        lv_obj_add_flag(ui_page_quick_modes_root(), LV_OBJ_FLAG_HIDDEN);
    }

    ui_pages_refresh_settings_locked(NULL);
    ui_pages_refresh_gateway_locked(NULL);
    ui_pages_show_page_locked(ui_pages_startup_page_to_display_page(
        settings_service_startup_page()));

    s_display_ready = true;
    bsp_display_unlock();
    return ESP_OK;
}

ui_pages_page_t ui_pages_current_page(void)
{
    return s_current_page;
}

const char *ui_pages_current_page_text(void)
{
    return ui_pages_page_to_text(s_current_page);
}

bool ui_pages_audio_meter_running(void)
{
    return s_audio_meter_running;
}

bool ui_pages_touch_attached(void)
{
    return s_touch_attached;
}

bool ui_pages_backlight_enabled(void)
{
    return s_backlight_enabled;
}

void ui_pages_set_backlight_enabled(bool enabled)
{
    s_backlight_enabled = enabled;
}

esp_err_t ui_pages_set_touch_state_locked(bool attached)
{
    if (s_touch_status_label != NULL) {
        lv_label_set_text(s_touch_status_label,
                          attached ? "Touch ready: tap the button to verify"
                                   : "Touch waiting: input device not connected");
    }

    s_touch_attached = attached;
    if (s_current_page == UI_PAGES_PAGE_GATEWAY) {
        ui_pages_refresh_gateway_locked(NULL);
    }
    return ESP_OK;
}

esp_err_t ui_pages_record_touch_sample_locked(uint16_t x, uint16_t y, uint32_t click_count)
{
    if (s_touch_status_label != NULL) {
        lv_label_set_text_fmt(s_touch_status_label,
                              "Touches=%" PRIu32 " Position=(%u, %u)",
                              click_count,
                              x,
                              y);
    }
    if (s_touch_hint_label != NULL) {
        lv_label_set_text(s_touch_hint_label,
                          "Touch connected: verify center and corners");
    }
    if (s_current_page == UI_PAGES_PAGE_SETTINGS) {
        ui_pages_refresh_settings_locked(NULL);
    } else if (s_current_page == UI_PAGES_PAGE_GATEWAY) {
        ui_pages_refresh_gateway_locked(NULL);
    }
    return ESP_OK;
}
