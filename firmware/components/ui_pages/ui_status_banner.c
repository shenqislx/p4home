#include "ui_status_banner.h"

#include <stdio.h>
#include <string.h>

#include "ha_client.h"
#include "network_service.h"
#include "panel_data_store.h"
#include "sdkconfig.h"
#include "time_service.h"

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
    lv_obj_set_style_bg_color(s_banner, lv_color_hex(0x111827), LV_PART_MAIN);
    lv_obj_set_style_border_width(s_banner, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s_banner, 14, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_banner, 8, LV_PART_MAIN);

    s_wifi_label = lv_label_create(s_banner);
    lv_obj_align(s_wifi_label, LV_ALIGN_LEFT_MID, 12, 0);
    s_ha_label = lv_label_create(s_banner);
    lv_obj_align(s_ha_label, LV_ALIGN_CENTER, 0, 0);
    s_time_label = lv_label_create(s_banner);
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
    snprintf(wifi_now, sizeof(wifi_now), "WiFi %s %s%s%s",
             network_service_wifi_has_ip() ? "up" : (network_service_wifi_connected() ? "..." : "x"),
             CONFIG_P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX && ip_text[0] != '\0' ? ip_text : "",
             CONFIG_P4HOME_UI_STATUS_BANNER_ENABLE_IP_SUFFIX && ip_text[0] != '\0' ? " " : "",
             network_service_last_disconnect_reason());
    if (strcmp(wifi_now, s_wifi_text) != 0) {
        snprintf(s_wifi_text, sizeof(s_wifi_text), "%s", wifi_now);
        lv_label_set_text(s_wifi_label, s_wifi_text);
    }

    ha_client_metrics_t metrics = {0};
    (void)ha_client_get_metrics(&metrics);
    char ha_now[64];
    snprintf(ha_now, sizeof(ha_now), "HA %s n=%u e=%u",
             ha_client_state_text(),
             (unsigned)panel_data_store_entity_count(),
             (unsigned)metrics.events_per_minute);
    if (strcmp(ha_now, s_ha_text) != 0) {
        snprintf(s_ha_text, sizeof(s_ha_text), "%s", ha_now);
        lv_label_set_text(s_ha_label, s_ha_text);
    }

    char time_now[64];
    char iso[40] = {0};
    if (time_service_format_now_iso8601(iso, sizeof(iso)) != ESP_OK) {
        snprintf(iso, sizeof(iso), "%s", "--");
    }
    snprintf(time_now, sizeof(time_now), "%s %s", time_service_is_synced() ? "CLK" : "CLK?", iso);
    if (strcmp(time_now, s_time_text) != 0) {
        snprintf(s_time_text, sizeof(s_time_text), "%s", time_now);
        lv_label_set_text(s_time_label, s_time_text);
    }
}
