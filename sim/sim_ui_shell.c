#include <stdio.h>

#include "esp_check.h"
#include "esp_log.h"
#include "ui_fonts.h"
#include "ui_page_home.h"
#include "ui_pages.h"
#include "ui_pixel_palette.h"
#include "world_service.h"

/* Stands in for ui_pages.c inside the simulator.
 *
 * The real shell initialises all five product pages, which would drag
 * network_service, the card widgets and the weather parser into the host build
 * for no benefit. The simulator exists to review the pixel home page, so this
 * builds the same screen chrome and navigation bar but only instantiates Home;
 * navigating away just logs the target. */

static const char *TAG = "sim_shell";
static ui_pages_page_t s_current_page = UI_PAGES_PAGE_HOME;
static bool s_backlight_enabled = true;
static bool s_touch_attached = true;

const char *ui_pages_page_to_text(ui_pages_page_t page)
{
    switch (page) {
    case UI_PAGES_PAGE_HOME:
        return "home";
    case UI_PAGES_PAGE_DASHBOARD:
        return "dashboard";
    case UI_PAGES_PAGE_CLIMATE:
        return "climate";
    case UI_PAGES_PAGE_QUICK_MODES:
        return "modes";
    case UI_PAGES_PAGE_ENERGY:
        return "energy";
    default:
        return "unknown";
    }
}

void ui_pages_show_page_locked(ui_pages_page_t page)
{
    s_current_page = page;
    if (ui_page_home_root() != NULL) {
        if (page == UI_PAGES_PAGE_HOME) {
            lv_obj_clear_flag(ui_page_home_root(), LV_OBJ_FLAG_HIDDEN);
            ui_page_home_show();
        } else {
            ESP_LOGI(TAG, "page %s is not built in the simulator; staying on home",
                     ui_pages_page_to_text(page));
            s_current_page = UI_PAGES_PAGE_HOME;
        }
    }
}

static void sim_nav_event_cb(lv_event_t *event)
{
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
        return;
    }
    ui_pages_page_t page = (ui_pages_page_t)(intptr_t)lv_event_get_user_data(event);
    ESP_LOGW(TAG, "VERIFY:ui:navigation:PASS page=%s", ui_pages_page_to_text(page));
    ui_pages_show_page_locked(page);
}

static lv_obj_t *sim_create_nav_button(lv_obj_t *screen, const char *text,
                                       int32_t x_offset, ui_pages_page_t page)
{
    lv_obj_t *button = lv_button_create(screen);
    if (button == NULL) {
        return NULL;
    }
    lv_obj_set_size(button, 116, 44);
    lv_obj_align(button, LV_ALIGN_TOP_RIGHT, x_offset, 28);
    lv_obj_set_style_radius(button, 0, LV_PART_MAIN);
    lv_obj_set_style_bg_color(button, lv_color_hex(UI_PAL_PANEL), LV_PART_MAIN);
    lv_obj_set_style_border_width(button, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(button,
                                  lv_color_hex(page == UI_PAGES_PAGE_HOME
                                                   ? UI_PAL_ACCENT_CYAN
                                                   : UI_PAL_GRID),
                                  LV_PART_MAIN);
    lv_obj_add_event_cb(button, sim_nav_event_cb, LV_EVENT_CLICKED,
                        (void *)(intptr_t)page);

    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_hex(UI_PAL_INK), LV_PART_MAIN);
    lv_obj_center(label);
    return button;
}

esp_err_t ui_pages_render_bootstrap(void)
{
    ESP_RETURN_ON_ERROR(world_service_init(NULL), TAG, "world service init failed");
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(UI_PAL_SCREEN), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_text_font(screen, ui_pages_text_font(), LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "P4HOME // CTRL");
    lv_obj_set_style_text_font(title, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(title, lv_color_hex(UI_PAL_ACCENT_CYAN), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 40, 24);

    lv_obj_t *subtitle = lv_label_create(screen);
    lv_label_set_text(subtitle, "SIM // RGB565 8FPS");
    lv_obj_set_style_text_font(subtitle, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_set_style_text_color(subtitle, lv_color_hex(UI_PAL_MUTED), LV_PART_MAIN);
    lv_obj_align(subtitle, LV_ALIGN_TOP_LEFT, 40, 58);

    lv_obj_t *rule = lv_obj_create(screen);
    lv_obj_set_size(rule, 944, 2);
    lv_obj_align(rule, LV_ALIGN_TOP_LEFT, 40, 88);
    lv_obj_set_style_bg_color(rule, lv_color_hex(UI_PAL_GRID), LV_PART_MAIN);
    lv_obj_set_style_border_width(rule, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(rule, 0, LV_PART_MAIN);

    sim_create_nav_button(screen, "HOME", -520, UI_PAGES_PAGE_HOME);
    sim_create_nav_button(screen, "MODES", -400, UI_PAGES_PAGE_QUICK_MODES);
    sim_create_nav_button(screen, "ENERGY", -280, UI_PAGES_PAGE_ENERGY);
    sim_create_nav_button(screen, "LIGHTS", -160, UI_PAGES_PAGE_DASHBOARD);
    sim_create_nav_button(screen, "CLIMATE", -40, UI_PAGES_PAGE_CLIMATE);

    ESP_RETURN_ON_ERROR(ui_page_home_init(), TAG, "home page init failed");
    ui_pages_show_page_locked(UI_PAGES_PAGE_HOME);
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

esp_err_t ui_pages_set_touch_state_locked(bool attached)
{
    s_touch_attached = attached;
    return ESP_OK;
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
