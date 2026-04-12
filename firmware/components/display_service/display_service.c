#include "display_service.h"

#include <inttypes.h>
#include <stdio.h>

#include "audio_service.h"
#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "display_service";
static lv_display_t *s_display;
static bool s_display_ready;
static bsp_lcd_handles_t s_lcd_handles;
static lv_obj_t *s_touch_status_label;
static lv_obj_t *s_touch_hint_label;
static lv_obj_t *s_audio_status_label;
static lv_obj_t *s_audio_metrics_label;
static lv_obj_t *s_audio_meter_label;
static lv_obj_t *s_audio_meter_button_label;
static lv_obj_t *s_audio_meter_bar;
static uint32_t s_touch_click_count;
static TaskHandle_t s_audio_meter_task;
static bool s_audio_meter_running;

typedef enum {
    DISPLAY_AUDIO_ACTION_TONE,
    DISPLAY_AUDIO_ACTION_MIC_CAPTURE,
} display_audio_action_t;

static void display_service_update_meter_ui_locked(const char *status_text,
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
                          meter_running ? "Stop Mic Meter" : "Start Mic Meter");
    }
}

static void display_service_update_audio_labels_locked(const char *status_text,
                                                       const char *metrics_text)
{
    display_service_update_meter_ui_locked(status_text, -1, metrics_text, s_audio_meter_running);
}

static esp_err_t display_service_update_audio_labels(const char *status_text,
                                                     const char *metrics_text)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    display_service_update_audio_labels_locked(status_text, metrics_text);
    bsp_display_unlock();
    return ESP_OK;
}

static esp_err_t display_service_update_meter_ui(const char *status_text,
                                                 int meter_value,
                                                 const char *metrics_text,
                                                 bool meter_running)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    display_service_update_meter_ui_locked(status_text, meter_value, metrics_text, meter_running);
    bsp_display_unlock();
    return ESP_OK;
}

static int display_service_mean_abs_to_percent(uint32_t mean_abs)
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

static void display_service_audio_meter_task(void *parameter)
{
    (void)parameter;
    uint32_t sample_counter = 0;

    esp_err_t ret = audio_service_begin_microphone_stream_for("display_mic_meter");
    if (ret != ESP_OK) {
        char status_text[96];
        snprintf(status_text, sizeof(status_text),
                 "Mic meter unavailable: %s owns audio.",
                 audio_service_current_owner());
        display_service_update_meter_ui(status_text, 0, NULL, false);
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
                     "Mic meter capture failed: %s",
                     esp_err_to_name(ret));
            display_service_update_meter_ui(status_text, 0, NULL, true);
            vTaskDelay(pdMS_TO_TICKS(250));
            continue;
        }

        char metrics_text[160];
        const int meter_value = display_service_mean_abs_to_percent(snapshot.mean_abs);
        snprintf(metrics_text, sizeof(metrics_text),
                 "meter=%d%% bytes=%" PRIu32 " peak=%u mean=%" PRIu32 " nonzero=%" PRIu32,
                 meter_value,
                 snapshot.bytes_read,
                 snapshot.peak_abs,
                 snapshot.mean_abs,
                 snapshot.nonzero_samples);
        display_service_update_meter_ui("Mic meter active: speak near the onboard microphone.",
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
    display_service_update_meter_ui("Mic meter stopped.", 0, NULL, false);
    s_audio_meter_task = NULL;
    vTaskDelete(NULL);
}

static void display_service_audio_action_task(void *parameter)
{
    display_audio_action_t action = (display_audio_action_t)(intptr_t)parameter;
    const bool is_tone = (action == DISPLAY_AUDIO_ACTION_TONE);
    const char *start_text = is_tone ? "Speaker test requested: playing 500 ms tone..."
                                     : "Mic sample requested: capturing PCM...";

    if (display_service_update_audio_labels(start_text, NULL) != ESP_OK) {
        ESP_LOGW(TAG, "failed to update audio start status");
    }

    esp_err_t ret = is_tone ? audio_service_play_test_tone()
                            : audio_service_capture_microphone_sample();
    if (ret != ESP_OK) {
        char status_text[96];
        if (ret == ESP_ERR_INVALID_STATE && audio_service_is_busy()) {
            snprintf(status_text, sizeof(status_text),
                     "%s unavailable: %s owns audio.",
                     is_tone ? "Speaker test" : "Mic sample",
                     audio_service_current_owner());
        } else {
            snprintf(status_text, sizeof(status_text),
                     "%s failed: %s",
                     is_tone ? "Speaker test" : "Mic sample",
                     esp_err_to_name(ret));
        }
        display_service_update_audio_labels(status_text, NULL);
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
                 "Speaker tone played. Confirm whether the tone was audible.");
        snprintf(metrics_text, sizeof(metrics_text),
                 "speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s",
                 audio_service_speaker_ready() ? "yes" : "no",
                 audio_service_microphone_ready() ? "yes" : "no",
                 audio_service_tone_played() ? "yes" : "no",
                 audio_service_microphone_capture_ready() ? "yes" : "no");
    } else {
        snprintf(status_text, sizeof(status_text),
                 "Mic sample captured. Check serial log and metrics below.");
        snprintf(metrics_text, sizeof(metrics_text),
                 "bytes=%" PRIu32 " peak=%u mean=%" PRIu32 " nonzero=%" PRIu32,
                 audio_service_microphone_bytes_read(),
                 audio_service_microphone_peak_abs(),
                 audio_service_microphone_mean_abs(),
                 audio_service_microphone_nonzero_samples());
    }
    display_service_update_audio_labels(status_text, metrics_text);
    audio_service_log_summary();
    vTaskDelete(NULL);
}

static void display_service_audio_button_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    const display_audio_action_t action = (display_audio_action_t)(intptr_t)lv_event_get_user_data(event);
    if (audio_service_is_busy()) {
        char status_text[96];
        snprintf(status_text, sizeof(status_text),
                 "Audio unavailable: %s owns audio.",
                 audio_service_current_owner());
        display_service_update_audio_labels_locked(status_text, NULL);
        return;
    }

    display_service_update_audio_labels_locked(action == DISPLAY_AUDIO_ACTION_TONE
                                                   ? "Speaker test requested: creating tone task..."
                                                   : "Mic sample requested: creating capture task...",
                                               NULL);

    const BaseType_t task_created = xTaskCreate(display_service_audio_action_task,
                                                action == DISPLAY_AUDIO_ACTION_TONE
                                                    ? "audio_tone"
                                                    : "audio_capture",
                                                4096,
                                                (void *)(intptr_t)action,
                                                5,
                                                NULL);
    if (task_created != pdPASS) {
        display_service_update_audio_labels_locked("Failed to create audio task.", NULL);
        ESP_LOGW(TAG, "failed to create audio action task");
    }
}

static void display_service_audio_meter_button_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }

    if (s_audio_meter_running) {
        s_audio_meter_running = false;
        display_service_update_meter_ui_locked("Stopping mic meter...", 0, NULL, false);
        return;
    }

    if (audio_service_is_busy()) {
        char status_text[96];
        snprintf(status_text, sizeof(status_text),
                 "Mic meter unavailable: %s owns audio.",
                 audio_service_current_owner());
        s_audio_meter_running = false;
        display_service_update_meter_ui_locked(status_text, 0, NULL, false);
        return;
    }

    s_audio_meter_running = true;
    display_service_update_meter_ui_locked("Mic meter requested: creating capture loop...", 0, NULL, true);
    const BaseType_t task_created = xTaskCreate(display_service_audio_meter_task,
                                                "audio_meter",
                                                4096,
                                                NULL,
                                                5,
                                                &s_audio_meter_task);
    if (task_created != pdPASS) {
        s_audio_meter_running = false;
        display_service_update_meter_ui_locked("Failed to create mic meter task.", 0, NULL, false);
        ESP_LOGW(TAG, "failed to create mic meter task");
    }
}

static void display_service_touch_demo_event_cb(lv_event_t *event)
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
                                  "Touch active at (%" PRId32 ", %" PRId32 ")",
                                  point.x,
                                  point.y);
        }
        ESP_LOGI(TAG, "touch press at x=%" PRId32 " y=%" PRId32, point.x, point.y);
        return;
    }

    s_touch_click_count++;
    if (s_touch_status_label != NULL) {
        lv_label_set_text_fmt(s_touch_status_label,
                              "Touch clicks=%" PRIu32 " last=(%" PRId32 ", %" PRId32 ")",
                              s_touch_click_count,
                              point.x,
                              point.y);
    }
    ESP_LOGI(TAG, "touch click #%" PRIu32 " at x=%" PRId32 " y=%" PRId32,
             s_touch_click_count,
             point.x,
             point.y);
}

static esp_err_t display_service_start_lcd_without_touch(void)
{
    const bsp_display_cfg_t cfg = {
        .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
        .buffer_size = BSP_LCD_DRAW_BUFF_SIZE,
        .double_buffer = BSP_LCD_DRAW_BUFF_DOUBLE,
        .hw_cfg = {
            .hdmi_resolution = BSP_HDMI_RES_NONE,
            .dsi_bus = {
                .phy_clk_src = 0,
                .lane_bit_rate_mbps = BSP_LCD_MIPI_DSI_LANE_BITRATE_MBPS,
            },
        },
        .flags = {
#if CONFIG_BSP_LCD_COLOR_FORMAT_RGB888
            .buff_dma = false,
#else
            .buff_dma = true,
#endif
            .buff_spiram = false,
            .sw_rotate = true,
        },
    };

    ESP_RETURN_ON_ERROR(lvgl_port_init(&cfg.lvgl_port_cfg), TAG,
                        "failed to init LVGL port");
    ESP_RETURN_ON_ERROR(bsp_display_new_with_handles(&cfg.hw_cfg, &s_lcd_handles), TAG,
                        "failed to init LCD panel");

    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = s_lcd_handles.io,
        .panel_handle = s_lcd_handles.panel,
        .control_handle = s_lcd_handles.control,
        .buffer_size = cfg.buffer_size,
        .double_buffer = cfg.double_buffer,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        .rotation = {
            .swap_xy = false,
            .mirror_x = true,
            .mirror_y = true,
        },
#if LVGL_VERSION_MAJOR >= 9
#if CONFIG_BSP_LCD_COLOR_FORMAT_RGB888
        .color_format = LV_COLOR_FORMAT_RGB888,
#else
        .color_format = LV_COLOR_FORMAT_RGB565,
#endif
#endif
        .flags = {
            .buff_dma = cfg.flags.buff_dma,
            .buff_spiram = cfg.flags.buff_spiram,
#if LVGL_VERSION_MAJOR >= 9
            .swap_bytes = (BSP_LCD_BIGENDIAN ? true : false),
#endif
            .sw_rotate = cfg.flags.sw_rotate,
        },
    };
    const lvgl_port_display_dsi_cfg_t dsi_cfg = {
        .flags = {
            .avoid_tearing = false,
        },
    };

    s_display = lvgl_port_add_disp_dsi(&disp_cfg, &dsi_cfg);
    ESP_RETURN_ON_FALSE(s_display != NULL, ESP_FAIL, TAG,
                        "failed to register DSI display with LVGL");
    return ESP_OK;
}

static esp_err_t display_service_render_bootstrap(void)
{
    ESP_RETURN_ON_FALSE(s_display != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "display handle unavailable");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0d1117), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "p4home");
    lv_obj_set_style_text_color(title, lv_color_white(), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 40, 32);

    lv_obj_t *summary = lv_label_create(screen);
    lv_label_set_text_fmt(summary,
                          "ESP32-P4 EVB V1.4\n"
                          "Display %dx%d\n"
                          "IDF %s\n"
                          "LVGL bootstrap ready",
                          BSP_LCD_H_RES,
                          BSP_LCD_V_RES,
                          esp_get_idf_version());
    lv_obj_set_style_text_color(summary, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_set_style_text_line_space(summary, 10, LV_PART_MAIN);
    lv_obj_align(summary, LV_ALIGN_TOP_LEFT, 40, 96);

    lv_obj_t *touch_button = lv_button_create(screen);
    lv_obj_set_size(touch_button, 280, 72);
    lv_obj_align(touch_button, LV_ALIGN_CENTER, 0, 10);
    lv_obj_set_style_bg_color(touch_button, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_add_event_cb(touch_button, display_service_touch_demo_event_cb, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(touch_button, display_service_touch_demo_event_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *touch_button_label = lv_label_create(touch_button);
    lv_label_set_text(touch_button_label, "Tap To Validate Touch");
    lv_obj_set_style_text_color(touch_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(touch_button_label);

    lv_obj_t *tone_button = lv_button_create(screen);
    lv_obj_set_size(tone_button, 240, 64);
    lv_obj_align(tone_button, LV_ALIGN_CENTER, -140, 110);
    lv_obj_set_style_bg_color(tone_button, lv_palette_main(LV_PALETTE_GREEN), LV_PART_MAIN);
    lv_obj_add_event_cb(tone_button, display_service_audio_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)DISPLAY_AUDIO_ACTION_TONE);

    lv_obj_t *tone_button_label = lv_label_create(tone_button);
    lv_label_set_text(tone_button_label, "Play Test Tone");
    lv_obj_set_style_text_color(tone_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(tone_button_label);

    lv_obj_t *mic_button = lv_button_create(screen);
    lv_obj_set_size(mic_button, 240, 64);
    lv_obj_align(mic_button, LV_ALIGN_CENTER, 140, 110);
    lv_obj_set_style_bg_color(mic_button, lv_palette_main(LV_PALETTE_ORANGE), LV_PART_MAIN);
    lv_obj_add_event_cb(mic_button, display_service_audio_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)DISPLAY_AUDIO_ACTION_MIC_CAPTURE);

    lv_obj_t *mic_button_label = lv_label_create(mic_button);
    lv_label_set_text(mic_button_label, "Capture Mic Sample");
    lv_obj_set_style_text_color(mic_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(mic_button_label);

    lv_obj_t *meter_button = lv_button_create(screen);
    lv_obj_set_size(meter_button, 240, 64);
    lv_obj_align(meter_button, LV_ALIGN_CENTER, 0, 190);
    lv_obj_set_style_bg_color(meter_button, lv_palette_main(LV_PALETTE_RED), LV_PART_MAIN);
    lv_obj_add_event_cb(meter_button, display_service_audio_meter_button_event_cb, LV_EVENT_CLICKED, NULL);

    s_audio_meter_button_label = lv_label_create(meter_button);
    lv_label_set_text(s_audio_meter_button_label, "Start Mic Meter");
    lv_obj_set_style_text_color(s_audio_meter_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(s_audio_meter_button_label);

    s_audio_meter_label = lv_label_create(screen);
    lv_label_set_text(s_audio_meter_label, "Mic level");
    lv_obj_set_style_text_color(s_audio_meter_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_audio_meter_label, LV_ALIGN_BOTTOM_LEFT, 40, -118);

    s_audio_meter_bar = lv_bar_create(screen);
    lv_obj_set_size(s_audio_meter_bar, 320, 12);
    lv_bar_set_range(s_audio_meter_bar, 0, 100);
    lv_bar_set_value(s_audio_meter_bar, 0, LV_ANIM_OFF);
    lv_obj_align(s_audio_meter_bar, LV_ALIGN_BOTTOM_LEFT, 110, -112);

    s_touch_status_label = lv_label_create(screen);
    lv_label_set_text(s_touch_status_label, "Touch pending: indev not attached");
    lv_obj_set_style_text_color(s_touch_status_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_touch_status_label, LV_ALIGN_BOTTOM_LEFT, 40, -92);

    s_touch_hint_label = lv_label_create(screen);
    lv_label_set_text(s_touch_hint_label, "Touch connected: validate center and corner orientation.");
    lv_obj_set_style_text_color(s_touch_hint_label, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_align(s_touch_hint_label, LV_ALIGN_BOTTOM_LEFT, 40, -64);

    s_audio_status_label = lv_label_create(screen);
    lv_label_set_text(s_audio_status_label, "Audio ready: use the buttons below to trigger diagnostics.");
    lv_obj_set_style_text_color(s_audio_status_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_audio_status_label, LV_ALIGN_BOTTOM_LEFT, 40, -36);

    s_audio_metrics_label = lv_label_create(screen);
    lv_label_set_text(s_audio_metrics_label, "speaker_ready=no microphone_ready=no tone_played=no mic_capture_ready=no");
    lv_obj_set_style_text_color(s_audio_metrics_label, lv_color_hex(0x58a6ff), LV_PART_MAIN);
    lv_obj_align(s_audio_metrics_label, LV_ALIGN_BOTTOM_LEFT, 40, -12);

    bsp_display_unlock();
    return ESP_OK;
}

esp_err_t display_service_init(void)
{
    if (s_display_ready) {
        ESP_LOGI(TAG, "display service already initialized");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "starting display bootstrap for ESP32-P4 EVB V1.4 without touch");
    ESP_RETURN_ON_ERROR(display_service_start_lcd_without_touch(), TAG,
                        "failed to start LCD/LVGL bootstrap");
    ESP_RETURN_ON_ERROR(bsp_display_backlight_on(), TAG,
                        "failed to enable display backlight");
    ESP_RETURN_ON_ERROR(display_service_render_bootstrap(), TAG,
                        "failed to render bootstrap screen");

    s_display_ready = true;
    ESP_LOGI(TAG, "display bootstrap ready: %dx%d panel=%p",
             BSP_LCD_H_RES,
             BSP_LCD_V_RES,
             (void *)s_display);
    return ESP_OK;
}

bool display_service_is_ready(void)
{
    return s_display_ready && s_display != NULL;
}

lv_display_t *display_service_get_handle(void)
{
    return s_display;
}

esp_err_t display_service_set_touch_state(bool attached)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    if (s_touch_status_label != NULL) {
        lv_label_set_text(s_touch_status_label,
                          attached ? "Touch ready: tap button to validate input"
                                   : "Touch pending: indev not attached");
    }

    bsp_display_unlock();
    return ESP_OK;
}

esp_err_t display_service_record_touch_sample(uint16_t x, uint16_t y, uint32_t click_count)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    if (s_touch_status_label != NULL) {
        lv_label_set_text_fmt(s_touch_status_label,
                              "Touch clicks=%" PRIu32 " last=(%u, %u)",
                              click_count,
                              x,
                              y);
    }
    if (s_touch_hint_label != NULL) {
        lv_label_set_text(s_touch_hint_label,
                          "Touch connected: verify center and corner orientation.");
    }

    bsp_display_unlock();
    return ESP_OK;
}

esp_err_t display_service_set_audio_state(bool speaker_ready, bool microphone_ready)
{
    char metrics_text[96];

    snprintf(metrics_text, sizeof(metrics_text),
             "speaker_ready=%s microphone_ready=%s tone_played=%s mic_capture_ready=%s",
             speaker_ready ? "yes" : "no",
             microphone_ready ? "yes" : "no",
             audio_service_tone_played() ? "yes" : "no",
             audio_service_microphone_capture_ready() ? "yes" : "no");

    return display_service_update_meter_ui(NULL, -1, metrics_text, s_audio_meter_running);
}

void display_service_log_summary(void)
{
    ESP_LOGI(TAG, "display ready=%s resolution=%dx%d handle=%p touch=%s panel=%p io=%p",
             display_service_is_ready() ? "yes" : "no",
             BSP_LCD_H_RES,
             BSP_LCD_V_RES,
             (void *)s_display,
             bsp_display_get_input_dev() != NULL ? "yes" : "no",
             (void *)s_lcd_handles.panel,
             (void *)s_lcd_handles.io);
}
