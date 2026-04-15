#include "settings_service.h"

#include <inttypes.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "settings_service";
static const char *SETTINGS_NAMESPACE = "p4home";
static const char *SETTINGS_KEY_BOOT_COUNT = "boot_count";
static const char *SETTINGS_KEY_STARTUP_PAGE = "startup_page";

typedef struct {
    bool initialized;
    uint32_t boot_count;
    settings_service_startup_page_t startup_page;
} settings_service_state_t;

static settings_service_state_t s_state = {
    .initialized = false,
    .boot_count = 0,
    .startup_page = SETTINGS_SERVICE_STARTUP_PAGE_HOME,
};

static const char *settings_service_page_to_text(settings_service_startup_page_t page)
{
    switch (page) {
    case SETTINGS_SERVICE_STARTUP_PAGE_HOME:
        return "home";
    case SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS:
        return "settings";
    default:
        return "unknown";
    }
}

static settings_service_startup_page_t settings_service_normalize_page(uint8_t raw_page)
{
    switch ((settings_service_startup_page_t)raw_page) {
    case SETTINGS_SERVICE_STARTUP_PAGE_HOME:
    case SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS:
        return (settings_service_startup_page_t)raw_page;
    default:
        return SETTINGS_SERVICE_STARTUP_PAGE_HOME;
    }
}

static esp_err_t settings_service_open_handle(nvs_open_mode_t mode, nvs_handle_t *handle)
{
    ESP_RETURN_ON_FALSE(handle != NULL, ESP_ERR_INVALID_ARG, TAG, "handle is required");
    return nvs_open(SETTINGS_NAMESPACE, mode, handle);
}

esp_err_t settings_service_init(void)
{
    if (s_state.initialized) {
        ESP_LOGI(TAG, "settings service already initialized");
        return ESP_OK;
    }

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "nvs init returned %s, erasing flash settings partition", esp_err_to_name(err));
        ESP_RETURN_ON_ERROR(nvs_flash_erase(), TAG, "failed to erase NVS partition");
        err = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(err, TAG, "failed to init NVS flash");

    nvs_handle_t handle = 0;
    ESP_RETURN_ON_ERROR(settings_service_open_handle(NVS_READWRITE, &handle), TAG,
                        "failed to open settings namespace");

    uint32_t boot_count = 0;
    err = nvs_get_u32(handle, SETTINGS_KEY_BOOT_COUNT, &boot_count);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to read boot_count");
    }

    uint8_t raw_startup_page = (uint8_t)SETTINGS_SERVICE_STARTUP_PAGE_HOME;
    err = nvs_get_u8(handle, SETTINGS_KEY_STARTUP_PAGE, &raw_startup_page);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to read startup_page");
    }

    s_state.boot_count = boot_count + 1U;
    s_state.startup_page = settings_service_normalize_page(raw_startup_page);

    err = nvs_set_u32(handle, SETTINGS_KEY_BOOT_COUNT, s_state.boot_count);
    if (err != ESP_OK) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to store boot_count");
    }

    err = nvs_commit(handle);
    if (err != ESP_OK) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to commit boot_count");
    }

    nvs_close(handle);

    s_state.initialized = true;
    ESP_LOGI(TAG, "settings ready boot_count=%" PRIu32 " startup_page=%s",
             s_state.boot_count,
             settings_service_page_to_text(s_state.startup_page));
    return ESP_OK;
}

bool settings_service_is_ready(void)
{
    return s_state.initialized;
}

uint32_t settings_service_boot_count(void)
{
    return s_state.boot_count;
}

settings_service_startup_page_t settings_service_startup_page(void)
{
    return s_state.startup_page;
}

const char *settings_service_startup_page_text(void)
{
    return settings_service_page_to_text(s_state.startup_page);
}

esp_err_t settings_service_set_startup_page(settings_service_startup_page_t page)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG,
                        "settings service not initialized");

    const settings_service_startup_page_t normalized_page =
        settings_service_normalize_page((uint8_t)page);
    nvs_handle_t handle = 0;
    esp_err_t err = settings_service_open_handle(NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to open settings namespace for write");

    err = nvs_set_u8(handle, SETTINGS_KEY_STARTUP_PAGE, (uint8_t)normalized_page);
    if (err != ESP_OK) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to store startup_page");
    }

    err = nvs_commit(handle);
    if (err != ESP_OK) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to commit startup_page");
    }
    nvs_close(handle);

    s_state.startup_page = normalized_page;
    ESP_LOGI(TAG, "startup_page saved as %s", settings_service_page_to_text(s_state.startup_page));
    return ESP_OK;
}

void settings_service_get_snapshot(settings_service_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->ready = s_state.initialized;
    snapshot->boot_count = s_state.boot_count;
    snapshot->startup_page = s_state.startup_page;
    snapshot->startup_page_text = settings_service_page_to_text(s_state.startup_page);
}

void settings_service_log_summary(void)
{
    ESP_LOGI(TAG, "settings ready=%s boot_count=%" PRIu32 " startup_page=%s",
             s_state.initialized ? "yes" : "no",
             s_state.boot_count,
             settings_service_page_to_text(s_state.startup_page));
}
