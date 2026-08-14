#include "display_service.h"

#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "ui_pages.h"

static const char *TAG = "display_service";
static lv_display_t *s_display;
static bool s_display_ready;
static bsp_lcd_handles_t s_lcd_handles;
static void *s_lvgl_ext_memory;
static lv_mem_pool_t s_lvgl_ext_pool;
static lv_obj_t *s_wake_overlay;
static lv_timer_t *s_backlight_timer;
static bool s_backlight_forced_off;

typedef enum {
    DISPLAY_BACKLIGHT_BRIGHT = 0,
    DISPLAY_BACKLIGHT_DIM,
    DISPLAY_BACKLIGHT_OFF,
} display_backlight_state_t;

static display_backlight_state_t s_backlight_state = DISPLAY_BACKLIGHT_BRIGHT;

#define DISPLAY_SERVICE_LVGL_EXT_POOL_BYTES (64U * 1024U)
#define DISPLAY_SERVICE_DIM_AFTER_MS         (60U * 1000U)
#define DISPLAY_SERVICE_DIM_PERCENT          20

static esp_err_t display_service_apply_backlight_locked(display_backlight_state_t state)
{
    if (state == s_backlight_state) {
        return ESP_OK;
    }

    int percent = state == DISPLAY_BACKLIGHT_BRIGHT ? 100
                  : state == DISPLAY_BACKLIGHT_DIM ? DISPLAY_SERVICE_DIM_PERCENT
                                                   : 0;
    ESP_RETURN_ON_ERROR(bsp_display_brightness_set(percent), TAG,
                        "failed to set adaptive backlight");
    s_backlight_state = state;
    ui_pages_set_backlight_enabled(state != DISPLAY_BACKLIGHT_OFF);

    if (s_wake_overlay != NULL) {
        if (state == DISPLAY_BACKLIGHT_OFF) {
            lv_obj_clear_flag(s_wake_overlay, LV_OBJ_FLAG_HIDDEN);
            lv_obj_move_foreground(s_wake_overlay);
        } else {
            lv_obj_add_flag(s_wake_overlay, LV_OBJ_FLAG_HIDDEN);
        }
    }
    ESP_LOGW(TAG, "VERIFY:power:backlight:%s percent=%d",
             state == DISPLAY_BACKLIGHT_BRIGHT ? "BRIGHT"
             : state == DISPLAY_BACKLIGHT_DIM ? "DIM"
                                              : "OFF",
             percent);
    return ESP_OK;
}

static void display_service_wake_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_PRESSED) {
        return;
    }
    s_backlight_forced_off = false;
    lv_display_trigger_activity(s_display);
    (void)display_service_apply_backlight_locked(DISPLAY_BACKLIGHT_BRIGHT);
}

static void display_service_backlight_timer_cb(lv_timer_t *timer)
{
    (void)timer;
    if (s_display == NULL || s_backlight_forced_off) {
        return;
    }
    uint32_t inactive_ms = lv_display_get_inactive_time(s_display);
    display_backlight_state_t next = inactive_ms >= DISPLAY_SERVICE_DIM_AFTER_MS
                                         ? DISPLAY_BACKLIGHT_DIM
                                         : DISPLAY_BACKLIGHT_BRIGHT;
    (void)display_service_apply_backlight_locked(next);
}

static esp_err_t display_service_start_backlight_policy(void)
{
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL for backlight policy");
    s_wake_overlay = lv_obj_create(lv_layer_top());
    if (s_wake_overlay != NULL) {
        lv_obj_set_size(s_wake_overlay, LV_PCT(100), LV_PCT(100));
        lv_obj_align(s_wake_overlay, LV_ALIGN_CENTER, 0, 0);
        lv_obj_set_style_bg_opa(s_wake_overlay, LV_OPA_TRANSP, LV_PART_MAIN);
        lv_obj_set_style_border_width(s_wake_overlay, 0, LV_PART_MAIN);
        lv_obj_set_style_pad_all(s_wake_overlay, 0, LV_PART_MAIN);
        lv_obj_clear_flag(s_wake_overlay, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(s_wake_overlay, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_event_cb(s_wake_overlay, display_service_wake_event_cb,
                            LV_EVENT_PRESSED, NULL);
    }
    if (s_wake_overlay != NULL) {
        s_backlight_timer = lv_timer_create(display_service_backlight_timer_cb, 1000, NULL);
    }
    bsp_display_unlock();

    ESP_RETURN_ON_FALSE(s_wake_overlay != NULL && s_backlight_timer != NULL,
                        ESP_ERR_NO_MEM, TAG, "failed to create backlight policy objects");
    ESP_LOGW(TAG, "adaptive backlight enabled default=100%% dim=%u ms/%d%%",
             (unsigned)DISPLAY_SERVICE_DIM_AFTER_MS, DISPLAY_SERVICE_DIM_PERCENT);
    return ESP_OK;
}

static esp_err_t display_service_add_lvgl_psram_pool(void)
{
    if (s_lvgl_ext_pool != NULL) {
        return ESP_OK;
    }

    s_lvgl_ext_memory = heap_caps_malloc(DISPLAY_SERVICE_LVGL_EXT_POOL_BYTES,
                                         MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    ESP_RETURN_ON_FALSE(s_lvgl_ext_memory != NULL, ESP_ERR_NO_MEM, TAG,
                        "failed to allocate LVGL PSRAM pool");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL for pool extension");
    s_lvgl_ext_pool = lv_mem_add_pool(s_lvgl_ext_memory,
                                      DISPLAY_SERVICE_LVGL_EXT_POOL_BYTES);
    bsp_display_unlock();
    if (s_lvgl_ext_pool == NULL) {
        heap_caps_free(s_lvgl_ext_memory);
        s_lvgl_ext_memory = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "LVGL PSRAM pool added: %u bytes",
             (unsigned)DISPLAY_SERVICE_LVGL_EXT_POOL_BYTES);
    return ESP_OK;
}

static inline ui_pages_page_t display_to_ui_page(display_service_page_t page)
{
    switch (page) {
    case DISPLAY_SERVICE_PAGE_HOME:
        return UI_PAGES_PAGE_HOME;
    case DISPLAY_SERVICE_PAGE_DASHBOARD:
        return UI_PAGES_PAGE_DASHBOARD;
    case DISPLAY_SERVICE_PAGE_CLIMATE:
        return UI_PAGES_PAGE_CLIMATE;
    case DISPLAY_SERVICE_PAGE_QUICK_MODES:
        return UI_PAGES_PAGE_QUICK_MODES;
    case DISPLAY_SERVICE_PAGE_ENERGY:
        return UI_PAGES_PAGE_ENERGY;
    default:
        return UI_PAGES_PAGE_HOME;
    }
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
            /* Must stay false. esp_lvgl_port_disp.c:440 allocates a third
             * buffer_size * color_bytes block (1024 * 50 * 2 = 100 KB of
             * internal DMA RAM) whenever sw_rotate is set, but :644 only ever
             * reads it when the display rotation is non-zero. This panel never
             * rotates - the mirroring it does need is done in hardware by
             * esp_lcd_panel_mirror() - so leaving this true burned 100 KB for
             * nothing. That headroom is what pays for the LVGL heap below. */
            .sw_rotate = false,
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
    size_t internal_before = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    ESP_RETURN_ON_ERROR(display_service_start_lcd_without_touch(), TAG,
                        "failed to start LCD/LVGL bootstrap");
    size_t internal_after = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    /* One draw buffer of 1024x50 RGB565 is 100 KB. With sw_rotate disabled the
     * cost here should be roughly that, not double it. */
    ESP_LOGW(TAG, "VERIFY:display:draw_buffers:cost=%uKB sw_rotate=off",
             (unsigned)((internal_before - internal_after) / 1024U));
    ESP_RETURN_ON_ERROR(display_service_add_lvgl_psram_pool(), TAG,
                        "failed to extend LVGL memory pool");
    ESP_RETURN_ON_ERROR(bsp_display_backlight_on(), TAG,
                        "failed to enable display backlight");
    ESP_RETURN_ON_ERROR(ui_pages_render_bootstrap(), TAG,
                        "failed to render bootstrap screen");
    ESP_RETURN_ON_ERROR(display_service_start_backlight_policy(), TAG,
                        "failed to start adaptive backlight policy");

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

esp_err_t display_service_set_audio_state(bool speaker_ready, bool microphone_ready)
{
    (void)speaker_ready;
    (void)microphone_ready;
    return s_display_ready ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t display_service_set_voice_state(const char *status_text, const char *metrics_text)
{
    (void)status_text;
    (void)metrics_text;
    return s_display_ready ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t display_service_set_backlight_enabled(bool enabled)
{
    ESP_RETURN_ON_FALSE(s_display_ready, ESP_ERR_INVALID_STATE, TAG,
                        "display not ready");
    ESP_RETURN_ON_FALSE(bsp_display_lock(0), ESP_ERR_TIMEOUT, TAG,
                        "failed to lock LVGL for backlight change");
    s_backlight_forced_off = !enabled;
    if (enabled) {
        lv_display_trigger_activity(s_display);
    }
    esp_err_t err = display_service_apply_backlight_locked(
        enabled ? DISPLAY_BACKLIGHT_BRIGHT : DISPLAY_BACKLIGHT_OFF);
    bsp_display_unlock();
    return err;
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
