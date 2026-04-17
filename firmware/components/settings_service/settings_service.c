#include "settings_service.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static const char *TAG = "settings_service";
static const char *SETTINGS_NAMESPACE = "p4home";
static const char *SETTINGS_KEY_BOOT_COUNT = "boot_count";
static const char *SETTINGS_KEY_STARTUP_PAGE = "startup_page";
static const char *SETTINGS_HA_NAMESPACE = "p4home_ha";
static const char *SETTINGS_KEY_HA_URL = "url";
static const char *SETTINGS_KEY_HA_TOKEN = "token";
static const char *SETTINGS_KEY_HA_VERIFY_TLS = "verify_tls";

typedef struct {
    bool initialized;
    uint32_t boot_count;
    settings_service_startup_page_t startup_page;
} settings_service_state_t;

typedef struct {
    bool present;
    bool verify_tls;
    char url[P4HOME_HA_URL_MAX_LEN];
    char token[P4HOME_HA_TOKEN_MAX_LEN];
} settings_service_ha_cache_t;

static settings_service_state_t s_state = {
    .initialized = false,
    .boot_count = 0,
    .startup_page = SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD,
};
static settings_service_ha_cache_t s_ha_cache = {
    .present = false,
    .verify_tls = true,
};
static portMUX_TYPE s_ha_lock = portMUX_INITIALIZER_UNLOCKED;

static const char *settings_service_page_to_text(settings_service_startup_page_t page)
{
    switch (page) {
    case SETTINGS_SERVICE_STARTUP_PAGE_HOME:
        return "home";
    case SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS:
        return "settings";
    case SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD:
        return "dashboard";
    default:
        return "unknown";
    }
}

static settings_service_startup_page_t settings_service_normalize_page(uint8_t raw_page)
{
    switch ((settings_service_startup_page_t)raw_page) {
    case SETTINGS_SERVICE_STARTUP_PAGE_HOME:
    case SETTINGS_SERVICE_STARTUP_PAGE_SETTINGS:
    case SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD:
        return (settings_service_startup_page_t)raw_page;
    default:
        return SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD;
    }
}

static esp_err_t settings_service_open_handle(nvs_open_mode_t mode, nvs_handle_t *handle)
{
    ESP_RETURN_ON_FALSE(handle != NULL, ESP_ERR_INVALID_ARG, TAG, "handle is required");
    return nvs_open(SETTINGS_NAMESPACE, mode, handle);
}

static esp_err_t settings_service_open_ha_handle(nvs_open_mode_t mode, nvs_handle_t *handle)
{
    ESP_RETURN_ON_FALSE(handle != NULL, ESP_ERR_INVALID_ARG, TAG, "handle is required");
    return nvs_open(SETTINGS_HA_NAMESPACE, mode, handle);
}

static void settings_service_ha_refresh_present_locked(void)
{
    s_ha_cache.present = s_ha_cache.url[0] != '\0' && s_ha_cache.token[0] != '\0';
}

static void settings_service_ha_format_token_masked(char *buffer, size_t buffer_len, const char *token)
{
    if (buffer == NULL || buffer_len == 0U) {
        return;
    }
    if (token == NULL || token[0] == '\0') {
        snprintf(buffer, buffer_len, "(empty)");
        return;
    }

    size_t token_len = strlen(token);
    const char *tail = token_len > 4U ? token + token_len - 4U : token;
    size_t tail_len = strlen(tail);
    if (buffer_len <= 4U) {
        snprintf(buffer, buffer_len, "***");
        return;
    }

    buffer[0] = '*';
    buffer[1] = '*';
    buffer[2] = '*';
    size_t copy_len = tail_len;
    if (copy_len > buffer_len - 4U) {
        copy_len = buffer_len - 4U;
    }
    memcpy(buffer + 3, tail, copy_len);
    buffer[3 + copy_len] = '\0';
}

static esp_err_t settings_service_ha_load_from_nvs(void)
{
    nvs_handle_t handle = 0;
    esp_err_t err = settings_service_open_ha_handle(NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "failed to open HA settings namespace");

    char url[P4HOME_HA_URL_MAX_LEN] = {0};
    char token[P4HOME_HA_TOKEN_MAX_LEN] = {0};
    size_t url_len = sizeof(url);
    size_t token_len = sizeof(token);
    uint8_t verify_tls = CONFIG_P4HOME_HA_VERIFY_TLS ? 1U : 0U;

    err = nvs_get_str(handle, SETTINGS_KEY_HA_URL, url, &url_len);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to read HA url");
    }

    err = nvs_get_str(handle, SETTINGS_KEY_HA_TOKEN, token, &token_len);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to read HA token");
    }

    err = nvs_get_u8(handle, SETTINGS_KEY_HA_VERIFY_TLS, &verify_tls);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        ESP_RETURN_ON_ERROR(err, TAG, "failed to read HA TLS flag");
    }

    nvs_close(handle);

    taskENTER_CRITICAL(&s_ha_lock);
    snprintf(s_ha_cache.url, sizeof(s_ha_cache.url), "%s", url);
    snprintf(s_ha_cache.token, sizeof(s_ha_cache.token), "%s", token);
    s_ha_cache.verify_tls = verify_tls != 0U;
    settings_service_ha_refresh_present_locked();
    taskEXIT_CRITICAL(&s_ha_lock);
    return ESP_OK;
}

static esp_err_t settings_service_ha_seed_from_kconfig(void)
{
#if !CONFIG_P4HOME_HA_SEED_NVS_ON_BOOT
    return ESP_OK;
#else
    if (strlen(CONFIG_P4HOME_HA_URL) == 0U && strlen(CONFIG_P4HOME_HA_TOKEN) == 0U) {
        return ESP_OK;
    }

    nvs_handle_t handle = 0;
    esp_err_t err = settings_service_open_ha_handle(NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    char existing_url[P4HOME_HA_URL_MAX_LEN] = {0};
    char existing_token[P4HOME_HA_TOKEN_MAX_LEN] = {0};
    size_t existing_url_len = sizeof(existing_url);
    size_t existing_token_len = sizeof(existing_token);
    bool has_existing_url = nvs_get_str(handle, SETTINGS_KEY_HA_URL, existing_url, &existing_url_len) == ESP_OK;
    bool has_existing_token =
        nvs_get_str(handle, SETTINGS_KEY_HA_TOKEN, existing_token, &existing_token_len) == ESP_OK;

    if (!has_existing_url && strlen(CONFIG_P4HOME_HA_URL) > 0U) {
        ESP_RETURN_ON_ERROR(nvs_set_str(handle, SETTINGS_KEY_HA_URL, CONFIG_P4HOME_HA_URL), TAG,
                            "failed to seed HA url");
    }
    if (!has_existing_token && strlen(CONFIG_P4HOME_HA_TOKEN) > 0U) {
        ESP_RETURN_ON_ERROR(nvs_set_str(handle, SETTINGS_KEY_HA_TOKEN, CONFIG_P4HOME_HA_TOKEN), TAG,
                            "failed to seed HA token");
    }
    ESP_RETURN_ON_ERROR(nvs_set_u8(handle, SETTINGS_KEY_HA_VERIFY_TLS,
                                   CONFIG_P4HOME_HA_VERIFY_TLS ? 1U : 0U),
                        TAG, "failed to seed HA TLS");
    ESP_RETURN_ON_ERROR(nvs_commit(handle), TAG, "failed to commit HA seed");
    nvs_close(handle);
    return ESP_OK;
#endif
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

    uint8_t raw_startup_page = (uint8_t)SETTINGS_SERVICE_STARTUP_PAGE_DASHBOARD;
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

    err = settings_service_ha_seed_from_kconfig();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "HA seed from Kconfig failed: %s", esp_err_to_name(err));
    }
    err = settings_service_ha_load_from_nvs();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "HA load from NVS failed: %s", esp_err_to_name(err));
    }

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

static esp_err_t settings_service_ha_write_string(const char *key,
                                                  const char *value,
                                                  char *cache,
                                                  size_t cache_len)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG, "settings service not initialized");
    ESP_RETURN_ON_FALSE(key != NULL && value != NULL && cache != NULL, ESP_ERR_INVALID_ARG, TAG,
                        "invalid HA write args");

    nvs_handle_t handle = 0;
    esp_err_t err = settings_service_open_ha_handle(NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to open HA settings namespace for write");

    err = nvs_set_str(handle, key, value);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to commit HA string");

    taskENTER_CRITICAL(&s_ha_lock);
    snprintf(cache, cache_len, "%s", value);
    settings_service_ha_refresh_present_locked();
    taskEXIT_CRITICAL(&s_ha_lock);
    return ESP_OK;
}

esp_err_t settings_service_ha_get_url(char *buffer, size_t buffer_len)
{
    ESP_RETURN_ON_FALSE(buffer != NULL && buffer_len > 0U, ESP_ERR_INVALID_ARG, TAG, "buffer is required");
    taskENTER_CRITICAL(&s_ha_lock);
    snprintf(buffer, buffer_len, "%s", s_ha_cache.url);
    taskEXIT_CRITICAL(&s_ha_lock);
    return ESP_OK;
}

esp_err_t settings_service_ha_get_token(char *buffer, size_t buffer_len)
{
    ESP_RETURN_ON_FALSE(buffer != NULL && buffer_len > 0U, ESP_ERR_INVALID_ARG, TAG, "buffer is required");
    taskENTER_CRITICAL(&s_ha_lock);
    snprintf(buffer, buffer_len, "%s", s_ha_cache.token);
    taskEXIT_CRITICAL(&s_ha_lock);
    return ESP_OK;
}

bool settings_service_ha_verify_tls(void)
{
    taskENTER_CRITICAL(&s_ha_lock);
    bool verify_tls = s_ha_cache.verify_tls;
    taskEXIT_CRITICAL(&s_ha_lock);
    return verify_tls;
}

bool settings_service_ha_credentials_present(void)
{
    taskENTER_CRITICAL(&s_ha_lock);
    bool present = s_ha_cache.present;
    taskEXIT_CRITICAL(&s_ha_lock);
    return present;
}

esp_err_t settings_service_ha_set_url(const char *url)
{
    return settings_service_ha_write_string(SETTINGS_KEY_HA_URL, url, s_ha_cache.url,
                                            sizeof(s_ha_cache.url));
}

esp_err_t settings_service_ha_set_token(const char *token)
{
    return settings_service_ha_write_string(SETTINGS_KEY_HA_TOKEN, token, s_ha_cache.token,
                                            sizeof(s_ha_cache.token));
}

esp_err_t settings_service_ha_set_verify_tls(bool verify_tls)
{
    ESP_RETURN_ON_FALSE(s_state.initialized, ESP_ERR_INVALID_STATE, TAG, "settings service not initialized");

    nvs_handle_t handle = 0;
    esp_err_t err = settings_service_open_ha_handle(NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to open HA settings namespace for TLS write");
    err = nvs_set_u8(handle, SETTINGS_KEY_HA_VERIFY_TLS, verify_tls ? 1U : 0U);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    ESP_RETURN_ON_ERROR(err, TAG, "failed to commit HA TLS");

    taskENTER_CRITICAL(&s_ha_lock);
    s_ha_cache.verify_tls = verify_tls;
    taskEXIT_CRITICAL(&s_ha_lock);
    return ESP_OK;
}

void settings_service_ha_log_summary(void)
{
    char token_masked[24];
    char url[P4HOME_HA_URL_MAX_LEN];
    bool verify_tls = false;
    bool present = false;

    taskENTER_CRITICAL(&s_ha_lock);
    snprintf(url, sizeof(url), "%s", s_ha_cache.url);
    verify_tls = s_ha_cache.verify_tls;
    present = s_ha_cache.present;
    settings_service_ha_format_token_masked(token_masked, sizeof(token_masked), s_ha_cache.token);
    taskEXIT_CRITICAL(&s_ha_lock);

    ESP_LOGI(TAG, "ha_settings present=%s verify_tls=%s url=%s token=%s",
             present ? "yes" : "no",
             verify_tls ? "yes" : "no",
             url[0] != '\0' ? url : "(empty)",
             token_masked);
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
    settings_service_ha_log_summary();
}
