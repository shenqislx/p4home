#include "display_service.h"

#include <inttypes.h>

#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"

static const char *TAG = "display_service";
static lv_display_t *s_display;
static bool s_display_ready;
static bsp_lcd_handles_t s_lcd_handles;
static lv_obj_t *s_touch_status_label;
static lv_obj_t *s_touch_hint_label;
static uint32_t s_touch_click_count;

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
    lv_obj_set_size(touch_button, 280, 84);
    lv_obj_align(touch_button, LV_ALIGN_CENTER, 0, 40);
    lv_obj_set_style_bg_color(touch_button, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_add_event_cb(touch_button, display_service_touch_demo_event_cb, LV_EVENT_PRESSED, NULL);
    lv_obj_add_event_cb(touch_button, display_service_touch_demo_event_cb, LV_EVENT_CLICKED, NULL);

    lv_obj_t *touch_button_label = lv_label_create(touch_button);
    lv_label_set_text(touch_button_label, "Tap To Validate Touch");
    lv_obj_set_style_text_color(touch_button_label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(touch_button_label);

    s_touch_status_label = lv_label_create(screen);
    lv_label_set_text(s_touch_status_label, "Touch pending: indev not attached");
    lv_obj_set_style_text_color(s_touch_status_label, lv_color_hex(0xd0d7de), LV_PART_MAIN);
    lv_obj_align(s_touch_status_label, LV_ALIGN_BOTTOM_LEFT, 40, -72);

    s_touch_hint_label = lv_label_create(screen);
    lv_label_set_text(s_touch_hint_label, "Waiting for next milestone: touch, navigation, data.");
    lv_obj_set_style_text_color(s_touch_hint_label, lv_palette_main(LV_PALETTE_BLUE), LV_PART_MAIN);
    lv_obj_align(s_touch_hint_label, LV_ALIGN_BOTTOM_LEFT, 40, -32);

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
