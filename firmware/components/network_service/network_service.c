#include "network_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_hosted.h"
#include "esp_hosted_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_ip_addr.h"
#include "esp_wifi.h"
#include "esp_wifi_default.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/portmacro.h"
#include "freertos/task.h"
#include "freertos/timers.h"
#include "sdkconfig.h"

static const char *TAG = "network_service";
static const char *DEFAULT_HOSTNAME_PREFIX = "p4home-p4";

#define NETWORK_SERVICE_CONNECTED_BIT   BIT0
#define NETWORK_SERVICE_GOT_IP_BIT      BIT1
#define NETWORK_SERVICE_FAIL_BIT        BIT2
#define NETWORK_SERVICE_TRANSPORT_BIT   BIT3

#define NETWORK_SERVICE_BACKOFF_MIN_MS  1000U
#define NETWORK_SERVICE_BACKOFF_MAX_MS  30000U
#define NETWORK_SERVICE_SLOW_RETRY_MS   60000U
#define NETWORK_SERVICE_TRANSPORT_WAIT_MS 5000U

typedef struct {
    bool initialized;
    bool esp_netif_ready;
    bool event_loop_ready;
    bool sta_netif_ready;
    bool hosted_transport_up;
    bool wifi_started;
    bool wifi_connected;
    bool wifi_has_ip;
    esp_netif_t *sta_netif;
    uint8_t mac[6];
    char mac_text[18];
    char hostname[32];
    char device_id[24];
    char ip_text[16];
    char last_disconnect_reason[24];
    uint32_t retry_count;
    uint32_t next_backoff_ms;
    EventGroupHandle_t event_group;
    TimerHandle_t reconnect_timer;
    esp_event_handler_instance_t wifi_handler;
    esp_event_handler_instance_t ip_handler;
    esp_event_handler_instance_t lost_ip_handler;
    esp_event_handler_instance_t hosted_handler;
} network_service_state_t;

static network_service_state_t s_state;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;

static bool network_service_netif_is_up(void)
{
    return s_state.sta_netif != NULL && esp_netif_is_netif_up(s_state.sta_netif);
}

static esp_netif_dhcp_status_t network_service_dhcp_status(void)
{
    esp_netif_dhcp_status_t dhcp_status = ESP_NETIF_DHCP_STOPPED;
    if (s_state.sta_netif == NULL) {
        return dhcp_status;
    }

    if (esp_netif_dhcpc_get_status(s_state.sta_netif, &dhcp_status) != ESP_OK) {
        return ESP_NETIF_DHCP_STOPPED;
    }
    return dhcp_status;
}

static void network_service_log_netif_ip_state(const char *prefix)
{
    if (s_state.sta_netif == NULL) {
        ESP_LOGW(TAG, "%s netif unavailable", prefix);
        return;
    }

    esp_netif_ip_info_t ip_info = {0};
    esp_netif_dns_info_t dns_info = {0};
    esp_netif_dhcp_status_t dhcp_status = ESP_NETIF_DHCP_STOPPED;
    esp_err_t ip_err = esp_netif_get_ip_info(s_state.sta_netif, &ip_info);
    esp_err_t dns_err = esp_netif_get_dns_info(s_state.sta_netif, ESP_NETIF_DNS_MAIN, &dns_info);
    esp_err_t dhcp_err = esp_netif_dhcpc_get_status(s_state.sta_netif, &dhcp_status);

    if (ip_err == ESP_OK && dns_err == ESP_OK && dhcp_err == ESP_OK) {
        ESP_LOGW(TAG,
                 "%s dhcp=%d ip=" IPSTR " netmask=" IPSTR " gw=" IPSTR " dns1=" IPSTR,
                 prefix,
                 (int)dhcp_status,
                 IP2STR(&ip_info.ip),
                 IP2STR(&ip_info.netmask),
                 IP2STR(&ip_info.gw),
                 IP2STR(&dns_info.ip.u_addr.ip4));
        return;
    }

    ESP_LOGW(TAG,
             "%s failed to read ip state ip_err=%s dns_err=%s dhcp_err=%s",
             prefix,
             esp_err_to_name(ip_err),
             esp_err_to_name(dns_err),
             esp_err_to_name(dhcp_err));
}

static esp_err_t network_service_apply_static_ip(void)
{
#if CONFIG_P4HOME_WIFI_STATIC_IP_ENABLE
    esp_netif_ip_info_t ip_info = {0};
    esp_netif_dns_info_t dns1 = {0};
    esp_netif_dns_info_t dns2 = {0};

    bool ok = ip4addr_aton(CONFIG_P4HOME_WIFI_STATIC_IP_ADDR, &ip_info.ip);
    ok = ok && ip4addr_aton(CONFIG_P4HOME_WIFI_STATIC_IP_NETMASK, &ip_info.netmask);
    ok = ok && ip4addr_aton(CONFIG_P4HOME_WIFI_STATIC_IP_GATEWAY, &ip_info.gw);
    ok = ok && ip4addr_aton(CONFIG_P4HOME_WIFI_STATIC_IP_DNS1, &dns1.ip.u_addr.ip4);
    ok = ok && ip4addr_aton(CONFIG_P4HOME_WIFI_STATIC_IP_DNS2, &dns2.ip.u_addr.ip4);
    ESP_RETURN_ON_FALSE(ok, ESP_ERR_INVALID_ARG, TAG,
                        "invalid static ip configuration");

    esp_err_t err = esp_netif_dhcpc_stop(s_state.sta_netif);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED) {
        return err;
    }
    ESP_RETURN_ON_ERROR(esp_netif_set_ip_info(s_state.sta_netif, &ip_info), TAG,
                        "failed to set static ip info");
    ESP_RETURN_ON_ERROR(esp_netif_set_dns_info(s_state.sta_netif, ESP_NETIF_DNS_MAIN, &dns1), TAG,
                        "failed to set primary dns");
    ESP_RETURN_ON_ERROR(esp_netif_set_dns_info(s_state.sta_netif, ESP_NETIF_DNS_BACKUP, &dns2), TAG,
                        "failed to set secondary dns");

    ESP_LOGW(TAG,
             "static ip enabled for debug ip=%s netmask=%s gw=%s dns1=%s dns2=%s",
             CONFIG_P4HOME_WIFI_STATIC_IP_ADDR,
             CONFIG_P4HOME_WIFI_STATIC_IP_NETMASK,
             CONFIG_P4HOME_WIFI_STATIC_IP_GATEWAY,
             CONFIG_P4HOME_WIFI_STATIC_IP_DNS1,
             CONFIG_P4HOME_WIFI_STATIC_IP_DNS2);
    return ESP_OK;
#else
    return ESP_OK;
#endif
}

static const char *network_service_disconnect_reason_to_text(uint8_t reason)
{
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:
        return "no_ap_found";
    case WIFI_REASON_AUTH_FAIL:
        return "auth_fail";
    case WIFI_REASON_AUTH_EXPIRE:
        return "auth_expire";
    case WIFI_REASON_ASSOC_LEAVE:
        return "assoc_leave";
    case WIFI_REASON_ASSOC_EXPIRE:
        return "assoc_expire";
    case WIFI_REASON_BEACON_TIMEOUT:
        return "beacon_timeout";
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
        return "handshake_timeout";
    case WIFI_REASON_CONNECTION_FAIL:
        return "connection_fail";
    default:
        break;
    }
    static char buf[24];
    snprintf(buf, sizeof(buf), "reason_%u", (unsigned)reason);
    return buf;
}

static void network_service_format_identity_strings(void)
{
    snprintf(s_state.mac_text, sizeof(s_state.mac_text),
             "%02x:%02x:%02x:%02x:%02x:%02x",
             s_state.mac[0], s_state.mac[1], s_state.mac[2],
             s_state.mac[3], s_state.mac[4], s_state.mac[5]);
    snprintf(s_state.hostname, sizeof(s_state.hostname),
             "%s-%02x%02x%02x",
             DEFAULT_HOSTNAME_PREFIX,
             s_state.mac[3], s_state.mac[4], s_state.mac[5]);
    snprintf(s_state.device_id, sizeof(s_state.device_id),
             "p4-%02x%02x%02x",
             s_state.mac[3], s_state.mac[4], s_state.mac[5]);
}

static esp_err_t network_service_init_tcpip_stack(void)
{
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK) {
        s_state.esp_netif_ready = true;
        return ESP_OK;
    }
    return err;
}

static esp_err_t network_service_init_default_event_loop(void)
{
    esp_err_t err = esp_event_loop_create_default();
    if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) {
        s_state.event_loop_ready = true;
        return ESP_OK;
    }
    return err;
}

static esp_err_t network_service_init_identity(void)
{
    esp_err_t err = esp_base_mac_addr_get(s_state.mac);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to read base mac");
    network_service_format_identity_strings();
    return ESP_OK;
}

static esp_err_t network_service_init_sta_netif(void)
{
    s_state.sta_netif = esp_netif_create_default_wifi_sta();
    ESP_RETURN_ON_FALSE(s_state.sta_netif != NULL, ESP_FAIL, TAG,
                        "failed to create default wifi sta netif");

    esp_err_t err = esp_netif_set_hostname(s_state.sta_netif, s_state.hostname);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to set wifi sta hostname");

    s_state.sta_netif_ready = true;
    return ESP_OK;
}

/** Caller must hold `s_state_lock`. */
static uint32_t network_service_next_backoff_locked(void)
{
    uint32_t backoff = s_state.next_backoff_ms;
    if (backoff < NETWORK_SERVICE_BACKOFF_MIN_MS) {
        backoff = NETWORK_SERVICE_BACKOFF_MIN_MS;
    }
    uint32_t doubled = backoff * 2U;
    if (doubled > NETWORK_SERVICE_BACKOFF_MAX_MS) {
        doubled = NETWORK_SERVICE_BACKOFF_MAX_MS;
    }
    s_state.next_backoff_ms = doubled;
    return backoff;
}

/** Caller must hold `s_state_lock`. */
static void network_service_reset_backoff_locked(void)
{
    s_state.next_backoff_ms = NETWORK_SERVICE_BACKOFF_MIN_MS;
}

static void network_service_reconnect_timer_cb(TimerHandle_t xTimer)
{
    (void)xTimer;
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
        ESP_LOGW(TAG, "esp_wifi_connect() on retry failed: %s", esp_err_to_name(err));
    }
}

static void network_service_schedule_retry(uint32_t delay_ms)
{
    if (s_state.reconnect_timer == NULL) {
        return;
    }
    if (xTimerIsTimerActive(s_state.reconnect_timer) == pdTRUE) {
        (void)xTimerStop(s_state.reconnect_timer, 0);
    }
    (void)xTimerChangePeriod(s_state.reconnect_timer, pdMS_TO_TICKS(delay_ms), 0);
}

static void network_service_wifi_event_handler(void *arg,
                                               esp_event_base_t base,
                                               int32_t id,
                                               void *data)
{
    (void)arg;
    (void)base;

    switch (id) {
    case WIFI_EVENT_STA_START: {
        ESP_LOGW(TAG, "wifi sta started, connecting");
        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
            ESP_LOGW(TAG, "esp_wifi_connect() failed: %s", esp_err_to_name(err));
        }
        break;
    }
    case WIFI_EVENT_STA_CONNECTED: {
        taskENTER_CRITICAL(&s_state_lock);
        s_state.wifi_connected = true;
        network_service_reset_backoff_locked();
        taskEXIT_CRITICAL(&s_state_lock);
        if (s_state.event_group != NULL) {
            xEventGroupSetBits(s_state.event_group, NETWORK_SERVICE_CONNECTED_BIT);
        }
        ESP_LOGW(TAG, "wifi connected (waiting for ip)");
        network_service_log_netif_ip_state("post-connect");
        break;
    }
    case WIFI_EVENT_STA_DISCONNECTED: {
        const wifi_event_sta_disconnected_t *ev = (const wifi_event_sta_disconnected_t *)data;
        uint8_t reason = (ev != NULL) ? ev->reason : 0U;
        const char *reason_text = network_service_disconnect_reason_to_text(reason);

        taskENTER_CRITICAL(&s_state_lock);
        s_state.wifi_connected = false;
        s_state.wifi_has_ip = false;
        s_state.ip_text[0] = '\0';
        snprintf(s_state.last_disconnect_reason, sizeof(s_state.last_disconnect_reason),
                 "%s", reason_text);
        s_state.retry_count++;
        uint32_t retries = s_state.retry_count;
        uint32_t delay_ms = (retries <= (uint32_t)CONFIG_P4HOME_WIFI_MAX_RETRY)
                                ? network_service_next_backoff_locked()
                                : NETWORK_SERVICE_SLOW_RETRY_MS;
        taskEXIT_CRITICAL(&s_state_lock);

        if (s_state.event_group != NULL) {
            xEventGroupClearBits(s_state.event_group,
                                 NETWORK_SERVICE_CONNECTED_BIT | NETWORK_SERVICE_GOT_IP_BIT);
            if (retries > (uint32_t)CONFIG_P4HOME_WIFI_MAX_RETRY) {
                xEventGroupSetBits(s_state.event_group, NETWORK_SERVICE_FAIL_BIT);
            }
        }

        ESP_LOGW(TAG,
                 "wifi disconnected reason=%s retry=%" PRIu32 " next_attempt_in=%" PRIu32 "ms",
                 reason_text, retries, delay_ms);
        network_service_schedule_retry(delay_ms);
        break;
    }
    default:
        break;
    }
}

static void network_service_hosted_event_handler(void *arg,
                                                 esp_event_base_t base,
                                                 int32_t id,
                                                 void *data)
{
    (void)arg;
    (void)base;

    switch (id) {
    case ESP_HOSTED_EVENT_TRANSPORT_UP:
        taskENTER_CRITICAL(&s_state_lock);
        s_state.hosted_transport_up = true;
        taskEXIT_CRITICAL(&s_state_lock);
        if (s_state.event_group != NULL) {
            xEventGroupSetBits(s_state.event_group, NETWORK_SERVICE_TRANSPORT_BIT);
        }
        ESP_LOGW(TAG, "hosted transport up");
        break;
    case ESP_HOSTED_EVENT_TRANSPORT_DOWN:
    case ESP_HOSTED_EVENT_TRANSPORT_FAILURE:
        taskENTER_CRITICAL(&s_state_lock);
        s_state.hosted_transport_up = false;
        taskEXIT_CRITICAL(&s_state_lock);
        if (s_state.event_group != NULL) {
            xEventGroupClearBits(s_state.event_group, NETWORK_SERVICE_TRANSPORT_BIT);
        }
        ESP_LOGW(TAG, "hosted transport %s",
                 id == ESP_HOSTED_EVENT_TRANSPORT_DOWN ? "down" : "failure");
        break;
    case ESP_HOSTED_EVENT_CP_INIT: {
        const esp_hosted_event_init_t *ev = (const esp_hosted_event_init_t *)data;
        ESP_LOGW(TAG, "hosted coprocessor init reason=%" PRIu16,
                 ev != NULL ? ev->reason : 0U);
        break;
    }
    default:
        break;
    }
}

static void network_service_ip_event_handler(void *arg,
                                             esp_event_base_t base,
                                             int32_t id,
                                             void *data)
{
    (void)arg;
    (void)base;

    if (id == IP_EVENT_STA_LOST_IP) {
        taskENTER_CRITICAL(&s_state_lock);
        s_state.wifi_has_ip = false;
        s_state.ip_text[0] = '\0';
        taskEXIT_CRITICAL(&s_state_lock);
        if (s_state.event_group != NULL) {
            xEventGroupClearBits(s_state.event_group, NETWORK_SERVICE_GOT_IP_BIT);
        }
        ESP_LOGW(TAG, "wifi lost ip");
        network_service_log_netif_ip_state("post-lost-ip");
        return;
    }

    if (id != IP_EVENT_STA_GOT_IP) {
        return;
    }

    const ip_event_got_ip_t *ev = (const ip_event_got_ip_t *)data;
    if (ev == NULL) {
        return;
    }

    char ip_text[16];
    snprintf(ip_text, sizeof(ip_text), IPSTR, IP2STR(&ev->ip_info.ip));

    taskENTER_CRITICAL(&s_state_lock);
    s_state.wifi_has_ip = true;
    s_state.wifi_connected = true;
    s_state.retry_count = 0U;
    network_service_reset_backoff_locked();
    snprintf(s_state.ip_text, sizeof(s_state.ip_text), "%s", ip_text);
    taskEXIT_CRITICAL(&s_state_lock);

    if (s_state.event_group != NULL) {
        xEventGroupClearBits(s_state.event_group, NETWORK_SERVICE_FAIL_BIT);
        xEventGroupSetBits(s_state.event_group,
                           NETWORK_SERVICE_CONNECTED_BIT | NETWORK_SERVICE_GOT_IP_BIT);
    }
    ESP_LOGW(TAG, "wifi got ip=%s", ip_text);
    network_service_log_netif_ip_state("post-got-ip");
}

static esp_err_t network_service_register_event_handlers(void)
{
    esp_err_t err = esp_event_handler_instance_register(ESP_HOSTED_EVENT, ESP_EVENT_ANY_ID,
                                                        &network_service_hosted_event_handler,
                                                        NULL, &s_state.hosted_handler);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to register hosted event handler");

    err = esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                              &network_service_wifi_event_handler,
                                              NULL, &s_state.wifi_handler);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to register wifi event handler");

    err = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                              &network_service_ip_event_handler,
                                              NULL, &s_state.ip_handler);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to register ip event handler");
    err = esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_LOST_IP,
                                              &network_service_ip_event_handler,
                                              NULL, &s_state.lost_ip_handler);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to register lost ip event handler");
    return ESP_OK;
}

static esp_err_t network_service_prepare_hosted_transport(uint32_t timeout_ms)
{
    ESP_RETURN_ON_FALSE(s_state.event_group != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "hosted transport wait requires event group");

    taskENTER_CRITICAL(&s_state_lock);
    bool transport_up = s_state.hosted_transport_up;
    taskEXIT_CRITICAL(&s_state_lock);
    if (transport_up) {
        xEventGroupSetBits(s_state.event_group, NETWORK_SERVICE_TRANSPORT_BIT);
        ESP_LOGW(TAG, "hosted transport already up");
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(esp_hosted_connect_to_slave(), TAG,
                        "failed to connect hosted transport to slave");

    EventBits_t bits = xEventGroupWaitBits(s_state.event_group,
                                           NETWORK_SERVICE_TRANSPORT_BIT,
                                           pdFALSE, pdTRUE,
                                           pdMS_TO_TICKS(timeout_ms));
    if ((bits & NETWORK_SERVICE_TRANSPORT_BIT) == 0U) {
        return ESP_ERR_TIMEOUT;
    }
    return ESP_OK;
}

static esp_err_t network_service_wifi_start_internal(void)
{
#if CONFIG_P4HOME_WIFI_AUTOSTART
    if (strlen(CONFIG_P4HOME_WIFI_SSID) == 0U) {
        ESP_LOGW(TAG, "wifi ssid not configured, skipping auto connect");
        return ESP_OK;
    }

    s_state.event_group = xEventGroupCreate();
    ESP_RETURN_ON_FALSE(s_state.event_group != NULL, ESP_ERR_NO_MEM, TAG,
                        "event group alloc failed");

    s_state.reconnect_timer = xTimerCreate("p4home_wifi_retry",
                                           pdMS_TO_TICKS(NETWORK_SERVICE_BACKOFF_MIN_MS),
                                           pdFALSE, NULL,
                                           network_service_reconnect_timer_cb);
    ESP_RETURN_ON_FALSE(s_state.reconnect_timer != NULL, ESP_ERR_NO_MEM, TAG,
                        "reconnect timer alloc failed");

    ESP_RETURN_ON_ERROR(network_service_register_event_handlers(), TAG,
                        "event handler register failed");
    ESP_RETURN_ON_ERROR(network_service_prepare_hosted_transport(NETWORK_SERVICE_TRANSPORT_WAIT_MS),
                        TAG, "hosted transport not ready");

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init_cfg), TAG, "esp_wifi_init failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG,
                        "esp_wifi_set_storage failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG,
                        "esp_wifi_set_mode failed");
    ESP_RETURN_ON_ERROR(network_service_apply_static_ip(), TAG,
                        "failed to apply network addressing");

    wifi_config_t cfg = {0};
    strncpy((char *)cfg.sta.ssid, CONFIG_P4HOME_WIFI_SSID, sizeof(cfg.sta.ssid) - 1);
    strncpy((char *)cfg.sta.password, CONFIG_P4HOME_WIFI_PASSWORD,
            sizeof(cfg.sta.password) - 1);
    cfg.sta.threshold.authmode = WIFI_AUTH_OPEN;
    cfg.sta.pmf_cfg.capable = true;
    cfg.sta.pmf_cfg.required = false;

    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &cfg), TAG,
                        "esp_wifi_set_config failed");

    network_service_reset_backoff_locked();

    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed");

    taskENTER_CRITICAL(&s_state_lock);
    s_state.wifi_started = true;
    taskEXIT_CRITICAL(&s_state_lock);

    ESP_LOGI(TAG, "wifi sta start requested ssid=%s", CONFIG_P4HOME_WIFI_SSID);
    return ESP_OK;
#else
    ESP_LOGI(TAG, "wifi autostart disabled via Kconfig");
    return ESP_OK;
#endif
}

esp_err_t network_service_init(void)
{
    if (s_state.initialized) {
        ESP_LOGI(TAG, "network service already initialized");
        return ESP_OK;
    }

    memset(&s_state, 0, sizeof(s_state));
    s_state.next_backoff_ms = NETWORK_SERVICE_BACKOFF_MIN_MS;
    snprintf(s_state.last_disconnect_reason, sizeof(s_state.last_disconnect_reason), "none");

    ESP_RETURN_ON_ERROR(network_service_init_tcpip_stack(), TAG,
                        "failed to init tcpip stack");
    ESP_RETURN_ON_ERROR(network_service_init_default_event_loop(), TAG,
                        "failed to init default event loop");
    ESP_RETURN_ON_ERROR(network_service_init_identity(), TAG,
                        "failed to init network identity");
    ESP_RETURN_ON_ERROR(network_service_init_sta_netif(), TAG,
                        "failed to init sta netif");

    s_state.initialized = true;

    esp_err_t wifi_err = network_service_wifi_start_internal();
    if (wifi_err != ESP_OK) {
        ESP_LOGW(TAG, "wifi start failed: %s", esp_err_to_name(wifi_err));
    }

    ESP_LOGI(TAG,
             "network ready hostname=%s device_id=%s mac=%s sta_netif=%p wifi_started=%s",
             s_state.hostname,
             s_state.device_id,
             s_state.mac_text,
             (void *)s_state.sta_netif,
             s_state.wifi_started ? "yes" : "no");
    return ESP_OK;
}

bool network_service_is_ready(void)
{
    return s_state.initialized;
}

bool network_service_esp_netif_ready(void)
{
    return s_state.esp_netif_ready;
}

bool network_service_event_loop_ready(void)
{
    return s_state.event_loop_ready;
}

bool network_service_sta_netif_ready(void)
{
    return s_state.sta_netif_ready;
}

bool network_service_wifi_started(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool started = s_state.wifi_started;
    taskEXIT_CRITICAL(&s_state_lock);
    return started;
}

static bool network_service_hosted_transport_up(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool transport_up = s_state.hosted_transport_up;
    taskEXIT_CRITICAL(&s_state_lock);
    return transport_up;
}

bool network_service_wifi_connected(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool connected = s_state.wifi_connected;
    taskEXIT_CRITICAL(&s_state_lock);
    return connected;
}

bool network_service_wifi_has_ip(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool has_ip = s_state.wifi_has_ip;
    taskEXIT_CRITICAL(&s_state_lock);
    return has_ip;
}

const char *network_service_hostname(void)
{
    return s_state.hostname[0] != '\0' ? s_state.hostname : "unset";
}

const char *network_service_device_id(void)
{
    return s_state.device_id[0] != '\0' ? s_state.device_id : "unset";
}

const char *network_service_mac_text(void)
{
    return s_state.mac_text[0] != '\0' ? s_state.mac_text : "unset";
}

const char *network_service_ip_text(void)
{
    return s_state.ip_text[0] != '\0' ? s_state.ip_text : "unset";
}

const char *network_service_last_disconnect_reason(void)
{
    return s_state.last_disconnect_reason[0] != '\0' ? s_state.last_disconnect_reason : "none";
}

uint32_t network_service_wifi_retry_count(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    uint32_t retries = s_state.retry_count;
    taskEXIT_CRITICAL(&s_state_lock);
    return retries;
}

esp_err_t network_service_wait_connected(uint32_t timeout_ms)
{
    if (s_state.event_group == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    TickType_t ticks = (timeout_ms == 0U) ? 0 : pdMS_TO_TICKS(timeout_ms);
    EventBits_t bits = xEventGroupWaitBits(s_state.event_group,
                                           NETWORK_SERVICE_GOT_IP_BIT,
                                           pdFALSE, pdTRUE,
                                           ticks);
    return (bits & NETWORK_SERVICE_GOT_IP_BIT) ? ESP_OK : ESP_ERR_TIMEOUT;
}

void network_service_get_snapshot(network_service_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    snapshot->ready = s_state.initialized;
    snapshot->esp_netif_ready = s_state.esp_netif_ready;
    snapshot->event_loop_ready = s_state.event_loop_ready;
    snapshot->sta_netif_ready = s_state.sta_netif_ready;
    snapshot->hosted_transport_up = network_service_hosted_transport_up();
    snapshot->netif_up = network_service_netif_is_up();
    snapshot->dhcp_client_status = network_service_dhcp_status();
    taskENTER_CRITICAL(&s_state_lock);
    snapshot->wifi_started = s_state.wifi_started;
    snapshot->wifi_connected = s_state.wifi_connected;
    snapshot->wifi_has_ip = s_state.wifi_has_ip;
    snapshot->retry_count = s_state.retry_count;
    taskEXIT_CRITICAL(&s_state_lock);
    snapshot->hostname = network_service_hostname();
    snapshot->device_id = network_service_device_id();
    snapshot->mac_text = network_service_mac_text();
    snapshot->ip_text = network_service_ip_text();
    snapshot->last_disconnect_reason = network_service_last_disconnect_reason();
}

void network_service_log_summary(void)
{
    ESP_LOGI(TAG,
             "network ready=%s esp_netif_ready=%s event_loop_ready=%s sta_netif_ready=%s hosted_transport_up=%s netif_up=%s dhcp_status=%d hostname=%s device_id=%s mac=%s",
             s_state.initialized ? "yes" : "no",
             s_state.esp_netif_ready ? "yes" : "no",
             s_state.event_loop_ready ? "yes" : "no",
             s_state.sta_netif_ready ? "yes" : "no",
             network_service_hosted_transport_up() ? "yes" : "no",
             network_service_netif_is_up() ? "yes" : "no",
             (int)network_service_dhcp_status(),
             network_service_hostname(),
             network_service_device_id(),
             network_service_mac_text());
    ESP_LOGI(TAG,
             "wifi started=%s connected=%s has_ip=%s ip=%s retry=%" PRIu32 " last_disconnect=%s",
             network_service_wifi_started() ? "yes" : "no",
             network_service_wifi_connected() ? "yes" : "no",
             network_service_wifi_has_ip() ? "yes" : "no",
             network_service_ip_text(),
             network_service_wifi_retry_count(),
             network_service_last_disconnect_reason());
}
