#include "display_service.h"

#include <stdio.h>

#include "audio_service.h"
#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "ui_pages.h"

static const char *TAG = "display_service";
static lv_display_t *s_display;
static bool s_display_ready;
static bsp_lcd_handles_t s_lcd_handles;

static inline ui_pages_page_t display_to_ui_page(display_service_page_t page)
{
    return (ui_pages_page_t)page;
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
    ESP_RETURN_ON_ERROR(ui_pages_render_bootstrap(), TAG,
                        "failed to render bootstrap screen");

    s_display_ready = true;
    ui_pages_set_backlight_enabled(true);
    ESP_LOGI(TAG, "display bootstrap ready: %dx%d panel=%p",
             BSP_LCD_H_RES,
             BSP_LCD_V_RES,
             (void *)s_lcd_handles.panel);
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

esp_err_t display_service_show_page(display_service_page_t page)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    ui_pages_show_page_locked(display_to_ui_page(page));
    bsp_display_unlock();
    return ESP_OK;
}

const char *display_service_current_page_text(void)
{
    return ui_pages_current_page_text();
}

esp_err_t display_service_refresh_gateway_page(void)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    if (ui_pages_current_page() != UI_PAGES_PAGE_GATEWAY) {
        return ESP_OK;
    }
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    ui_pages_refresh_gateway_locked(NULL);
    bsp_display_unlock();
    return ESP_OK;
}

esp_err_t display_service_set_touch_state(bool attached)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    esp_err_t err = ui_pages_set_touch_state_locked(attached);
    bsp_display_unlock();
    return err;
}

esp_err_t display_service_record_touch_sample(uint16_t x, uint16_t y, uint32_t click_count)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL");

    esp_err_t err = ui_pages_record_touch_sample_locked(x, y, click_count);
    bsp_display_unlock();
    return err;
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

    esp_err_t err =
        ui_pages_update_meter_ui(NULL, -1, metrics_text, ui_pages_audio_meter_running());
    if (err == ESP_OK && ui_pages_current_page() == UI_PAGES_PAGE_SETTINGS) {
        ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                            "failed to lock LVGL");
        ui_pages_refresh_settings_locked(NULL);
        bsp_display_unlock();
    } else if (err == ESP_OK && ui_pages_current_page() == UI_PAGES_PAGE_GATEWAY) {
        ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                            "failed to lock LVGL");
        ui_pages_refresh_gateway_locked(NULL);
        bsp_display_unlock();
    }
    return err;
}

esp_err_t display_service_set_voice_state(const char *status_text, const char *metrics_text)
{
    return ui_pages_update_voice_labels(status_text, metrics_text);
}

esp_err_t display_service_set_backlight_enabled(bool enabled)
{
    esp_err_t err = enabled ? bsp_display_backlight_on() : bsp_display_backlight_off();
    ESP_RETURN_ON_ERROR(err, TAG, "failed to change display backlight");
    ui_pages_set_backlight_enabled(enabled);

    if (s_display_ready && ui_pages_current_page() == UI_PAGES_PAGE_SETTINGS) {
        ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                            "failed to lock LVGL");
        ui_pages_refresh_settings_locked(NULL);
        bsp_display_unlock();
    } else if (s_display_ready && ui_pages_current_page() == UI_PAGES_PAGE_GATEWAY) {
        ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                            "failed to lock LVGL");
        ui_pages_refresh_gateway_locked(NULL);
        bsp_display_unlock();
    }
    return ESP_OK;
}

bool display_service_backlight_enabled(void)
{
    return ui_pages_backlight_enabled();
}

void display_service_log_summary(void)
{
    ESP_LOGI(TAG, "display ready=%s resolution=%dx%d handle=%p touch=%s backlight=%s panel=%p io=%p",
             display_service_is_ready() ? "yes" : "no",
             BSP_LCD_H_RES,
             BSP_LCD_V_RES,
             (void *)s_display,
             ui_pages_touch_attached() ? "yes" : "no",
             ui_pages_backlight_enabled() ? "on" : "off",
             (void *)s_lcd_handles.panel,
             (void *)s_lcd_handles.io);
}
