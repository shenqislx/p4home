#include "ui_pages.h"

#include <stdint.h>

#include "bsp/esp32_p4_function_ev_board.h"
#include "esp_check.h"
#include "esp_log.h"
#include "ui_fonts.h"
#include "ui_page_climate.h"
#include "ui_page_dashboard.h"
#include "ui_page_quick_modes.h"

static const char *TAG = "ui_pages";
static bool s_display_ready;
static bool s_backlight_enabled;
static bool s_touch_attached;
static lv_obj_t *s_dashboard_nav_button;
static lv_obj_t *s_climate_nav_button;
static lv_obj_t *s_quick_modes_nav_button;
static ui_pages_page_t s_current_page = UI_PAGES_PAGE_DASHBOARD;

const char *ui_pages_page_to_text(ui_pages_page_t page)
{
    switch (page) {
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

void ui_pages_show_page_locked(ui_pages_page_t page)
{
    if (page < UI_PAGES_PAGE_DASHBOARD || page > UI_PAGES_PAGE_QUICK_MODES) {
        ESP_LOGW(TAG, "unsupported page=%d; falling back to dashboard", (int)page);
        page = UI_PAGES_PAGE_DASHBOARD;
    }
    s_current_page = page;

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

static lv_obj_t *ui_pages_create_nav_button(lv_obj_t *screen,
                                             const char *label_text,
                                             int32_t x_offset,
                                             ui_pages_page_t page)
{
    lv_obj_t *button = lv_button_create(screen);
    if (button == NULL) {
        return NULL;
    }
    lv_obj_set_size(button, 104, 44);
    lv_obj_align(button, LV_ALIGN_TOP_RIGHT, x_offset, 28);
    lv_obj_add_event_cb(button, ui_pages_nav_button_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)page);

    lv_obj_t *label = lv_label_create(button);
    if (label == NULL) {
        lv_obj_delete(button);
        return NULL;
    }
    lv_label_set_text(label, label_text);
    lv_obj_set_style_text_font(label, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_white(), LV_PART_MAIN);
    lv_obj_center(label);
    return button;
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
    lv_label_set_text(subtitle, "Home Assistant Smart Panel");
    lv_obj_set_style_text_font(subtitle, ui_pages_text_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(subtitle, lv_color_hex(0x8b949e), LV_PART_MAIN);
    lv_obj_align(subtitle, LV_ALIGN_TOP_LEFT, 40, 58);

    s_quick_modes_nav_button =
        ui_pages_create_nav_button(screen, "Modes", -264, UI_PAGES_PAGE_QUICK_MODES);
    s_dashboard_nav_button =
        ui_pages_create_nav_button(screen, "Lights", -152, UI_PAGES_PAGE_DASHBOARD);
    s_climate_nav_button =
        ui_pages_create_nav_button(screen, "Climate", -40, UI_PAGES_PAGE_CLIMATE);
    if (s_quick_modes_nav_button == NULL || s_dashboard_nav_button == NULL ||
        s_climate_nav_button == NULL) {
        bsp_display_unlock();
        return ESP_ERR_NO_MEM;
    }

    esp_err_t err = ui_page_dashboard_init();
    if (err == ESP_OK) {
        err = ui_page_climate_init();
    }
    if (err == ESP_OK) {
        err = ui_page_quick_modes_init();
    }
    if (err != ESP_OK) {
        bsp_display_unlock();
        ESP_LOGE(TAG, "failed to initialize product pages: %s", esp_err_to_name(err));
        return err;
    }

    if (ui_page_climate_root() != NULL) {
        lv_obj_add_flag(ui_page_climate_root(), LV_OBJ_FLAG_HIDDEN);
    }
    if (ui_page_quick_modes_root() != NULL) {
        lv_obj_add_flag(ui_page_quick_modes_root(), LV_OBJ_FLAG_HIDDEN);
    }
    ui_pages_show_page_locked(UI_PAGES_PAGE_DASHBOARD);

    s_display_ready = true;
    bsp_display_unlock();
    ESP_LOGI(TAG, "product UI ready: Modes, Lights, Climate");
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
    if (!s_display_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    s_touch_attached = attached;
    return ESP_OK;
}
