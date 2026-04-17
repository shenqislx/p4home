#include "time_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "network_service.h"
#include "sdkconfig.h"

static const char *TAG = "time_service";

#define TIME_SYNC_STARTED_BIT  BIT0
#define TIME_SYNC_ACQUIRED_BIT BIT1

typedef struct {
    bool initialized;
    bool sync_started;
    bool synced;
    EventGroupHandle_t event_group;
    TaskHandle_t task_handle;
    uint64_t last_sync_epoch_ms;
} time_service_state_t;

static time_service_state_t s_state;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;

static void time_service_sync_notification_cb(struct timeval *tv)
{
    uint64_t epoch_ms = 0U;
    if (tv != NULL) {
        epoch_ms = ((uint64_t)tv->tv_sec * 1000ULL) + ((uint64_t)tv->tv_usec / 1000ULL);
    }

    taskENTER_CRITICAL(&s_state_lock);
    s_state.synced = true;
    s_state.last_sync_epoch_ms = epoch_ms;
    taskEXIT_CRITICAL(&s_state_lock);

    if (s_state.event_group != NULL) {
        xEventGroupSetBits(s_state.event_group, TIME_SYNC_ACQUIRED_BIT);
    }
}

static void time_service_task(void *arg)
{
    (void)arg;

    while (true) {
        esp_err_t err = network_service_wait_connected(CONFIG_P4HOME_TIME_WAIT_WIFI_MS);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Wi-Fi not ready for SNTP: %s", esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(CONFIG_P4HOME_TIME_SYNC_RETRY_MS));
            continue;
        }

        esp_sntp_stop();
        esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
        esp_sntp_setservername(0, CONFIG_P4HOME_TIME_NTP_SERVER_0);
        esp_sntp_setservername(1, CONFIG_P4HOME_TIME_NTP_SERVER_1);
        esp_sntp_setservername(2, CONFIG_P4HOME_TIME_NTP_SERVER_2);
        esp_sntp_set_time_sync_notification_cb(time_service_sync_notification_cb);
        esp_sntp_init();

        taskENTER_CRITICAL(&s_state_lock);
        s_state.sync_started = true;
        taskEXIT_CRITICAL(&s_state_lock);
        xEventGroupSetBits(s_state.event_group, TIME_SYNC_STARTED_BIT);

        ESP_LOGI(TAG, "SNTP started servers=%s,%s,%s",
                 CONFIG_P4HOME_TIME_NTP_SERVER_0,
                 CONFIG_P4HOME_TIME_NTP_SERVER_1,
                 CONFIG_P4HOME_TIME_NTP_SERVER_2);
        vTaskDelete(NULL);
    }
}

esp_err_t time_service_init(void)
{
#if !CONFIG_P4HOME_TIME_ENABLE
    return ESP_OK;
#else
    if (s_state.initialized) {
        return ESP_OK;
    }

    memset(&s_state, 0, sizeof(s_state));
    s_state.event_group = xEventGroupCreate();
    ESP_RETURN_ON_FALSE(s_state.event_group != NULL, ESP_ERR_NO_MEM, TAG, "time event group alloc failed");

    setenv("TZ", CONFIG_P4HOME_TIME_TZ, 1);
    tzset();

    BaseType_t task_ok = xTaskCreate(time_service_task, "p4home_time_svc", 3072, NULL,
                                     tskIDLE_PRIORITY + 3, &s_state.task_handle);
    ESP_RETURN_ON_FALSE(task_ok == pdPASS, ESP_ERR_NO_MEM, TAG, "failed to create time task");

    s_state.initialized = true;
    return ESP_OK;
#endif
}

bool time_service_is_synced(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    bool synced = s_state.synced;
    taskEXIT_CRITICAL(&s_state_lock);
    return synced;
}

esp_err_t time_service_wait_synced(uint32_t timeout_ms)
{
    ESP_RETURN_ON_FALSE(s_state.initialized && s_state.event_group != NULL, ESP_ERR_INVALID_STATE, TAG,
                        "time service not initialized");
    EventBits_t bits = xEventGroupGetBits(s_state.event_group);
    if ((bits & TIME_SYNC_ACQUIRED_BIT) != 0U) {
        return ESP_OK;
    }
    if (timeout_ms == 0U) {
        return ESP_ERR_TIMEOUT;
    }

    bits = xEventGroupWaitBits(s_state.event_group, TIME_SYNC_ACQUIRED_BIT, pdFALSE, pdFALSE,
                               pdMS_TO_TICKS(timeout_ms));
    return (bits & TIME_SYNC_ACQUIRED_BIT) != 0U ? ESP_OK : ESP_ERR_TIMEOUT;
}

const char *time_service_tz_text(void)
{
    return CONFIG_P4HOME_TIME_TZ;
}

esp_err_t time_service_format_now_iso8601(char *buffer, size_t buffer_len)
{
    ESP_RETURN_ON_FALSE(buffer != NULL && buffer_len > 0U, ESP_ERR_INVALID_ARG, TAG, "buffer is required");
    time_t now = time(NULL);
    struct tm local_tm = {0};
    localtime_r(&now, &local_tm);
    size_t written = strftime(buffer, buffer_len, "%Y-%m-%dT%H:%M:%S%z", &local_tm);
    ESP_RETURN_ON_FALSE(written > 0U, ESP_FAIL, TAG, "failed to format current time");
    return ESP_OK;
}

uint64_t time_service_last_sync_epoch_ms(void)
{
    taskENTER_CRITICAL(&s_state_lock);
    uint64_t epoch_ms = s_state.last_sync_epoch_ms;
    taskEXIT_CRITICAL(&s_state_lock);
    return epoch_ms;
}
