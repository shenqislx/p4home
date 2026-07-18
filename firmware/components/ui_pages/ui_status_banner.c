#include "ui_status_banner.h"

#include <stdio.h>
#include <string.h>

#include "ha_client.h"
#include "network_service.h"
#include "panel_data_store.h"
#include "sdkconfig.h"
#include "time_service.h"
#include "ui_fonts.h"
#include "ui_pixel_theme.h"

static lv_obj_t *s_banner;
static lv_obj_t *s_wifi_label;
static lv_obj_t *s_ha_label;
static lv_obj_t *s_time_label;
static lv_timer_t *s_timer;
static char s_wifi_text[64];
static char s_ha_text[64];
static char s_time_text[64];

static void ui_status_banner_timer_cb(lv_timer_t *timer)
{
    (void)timer;
    ui_status_banner_tick();
}

esp_err_t ui_status_banner_init(lv_obj_t *parent)
{
    if (s_banner != NULL) {
        return ESP_OK;
    }

    s_banner = lv_obj_create(parent);
    lv_obj_set_size(s_banner, 944, CONFIG_P4HOME_UI_STATUS_BANNER_HEIGHT);
    lv_obj_align(s_banner, LV_ALIGN_TOP_LEFT, 0, 0);
    ui_pixel_style_surface(s_banner, UI_PIXEL_COLOR_PANEL, UI_PIXEL_COLOR_GRID);
    lv_obj_set_style_pad_all(s_banner, 8, LV_PART_MAIN);

    s_wifi_label = lv_label_create(s_banner);
    lv_obj_set_width(s_wifi_label, 270);
    lv_label_set_long_mode(s_wifi_label, LV_LABEL_LONG_CLIP);
    lv_obj_set_style_text_align(s_wifi_label, LV_TEXT_ALIGN_LEFT, LV_PART_MAIN);
    lv_obj_set_style_text_font(s_wifi_label, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_align(s_wifi_label, LV_ALIGN_LEFT_MID, 12, 0);
    s_ha_label = lv_label_create(s_banner);
    lv_obj_set_width(s_ha_label, 240);
    lv_label_set_long_mode(s_ha_label, LV_LABEL_LONG_CLIP);
    lv_obj_set_style_text_align(s_ha_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_style_text_font(s_ha_label, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_align(s_ha_label, LV_ALIGN_CENTER, 0, 0);
    s_time_label = lv_label_create(s_banner);
    lv_obj_set_width(s_time_label, 220);
    lv_label_set_long_mode(s_time_label, LV_LABEL_LONG_CLIP);
    lv_obj_set_style_text_align(s_time_label, LV_TEXT_ALIGN_RIGHT, LV_PART_MAIN);
    lv_obj_set_style_text_font(s_time_label, ui_pages_pixel_font(), LV_PART_MAIN);
    lv_obj_align(s_time_label, LV_ALIGN_RIGHT_MID, -12, 0);

    s_timer = lv_timer_create(ui_status_banner_timer_cb, 1000, NULL);
    ui_status_banner_tick();
    return ESP_OK;
}

void ui_status_banner_tick(void)
{
    if (s_banner == NULL) {
        return;
    }

    char ip_text[24];
    snprintf(ip_text, sizeof(ip_text), "%s", network_service_ip_text());
    char wifi_now[64];
    snprintf(wifi_now, sizeof(wifi_now), "NET[%s] %s",
             network_service_wifi_has_ip() ? "UP" : (network_service_wifi_connected() ? "WAIT" : "DOWN"),
             CONFIG_P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX && ip_text[0] != '\0' ? ip_text : "");
    if (strcmp(wifi_now, s_wifi_text) != 0) {
        snprintf(s_wifi_text, sizeof(s_wifi_text), "%s", wifi_now);
        lv_label_set_text(s_wifi_label, s_wifi_text);
    }
    lv_obj_set_style_text_color(s_wifi_label,
                                lv_color_hex(network_service_wifi_has_ip()
                                                 ? UI_PIXEL_COLOR_CYAN
                                                 : UI_PIXEL_COLOR_YELLOW),
                                LV_PART_MAIN);

    ha_client_metrics_t metrics = {0};
    (void)ha_client_get_metrics(&metrics);
    char ha_now[64];
    snprintf(ha_now, sizeof(ha_now), "HA[%s] D:%u E:%u",
             ha_client_ready() ? "UP" : "WAIT",
             (unsigned)panel_data_store_entity_count(),
             (unsigned)metrics.events_per_minute);
    if (strcmp(ha_now, s_ha_text) != 0) {
        snprintf(s_ha_text, sizeof(s_ha_text), "%s", ha_now);
        lv_label_set_text(s_ha_label, s_ha_text);
    }
    lv_obj_set_style_text_color(s_ha_label,
                                lv_color_hex(ha_client_ready()
                                                 ? UI_PIXEL_COLOR_CYAN
                                                 : UI_PIXEL_COLOR_YELLOW),
                                LV_PART_MAIN);

    char time_now[32];
    char iso[40] = {0};
    if (time_service_format_now_iso8601(iso, sizeof(iso)) != ESP_OK) {
        snprintf(iso, sizeof(iso), "%s", "--");
    }
    char compact_time[17] = "--";
    if (time_service_is_synced() && strlen(iso) >= 16U) {
        memcpy(compact_time, iso, 16U);
        compact_time[16] = '\0';
        compact_time[10] = ' ';
    }
    snprintf(time_now, sizeof(time_now), "CLK %s", compact_time);
    if (strcmp(time_now, s_time_text) != 0) {
        snprintf(s_time_text, sizeof(s_time_text), "%s", time_now);
        lv_label_set_text(s_time_label, s_time_text);
    }
    lv_obj_set_style_text_color(s_time_label, lv_color_hex(UI_PIXEL_COLOR_MUTED), LV_PART_MAIN);
}
