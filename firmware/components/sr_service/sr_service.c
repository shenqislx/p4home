#include "sr_service.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include "audio_service.h"
#include "esp_afe_config.h"
#include "esp_afe_sr_models.h"
#include "esp_log.h"
#include "model_path.h"

static const char *TAG = "sr_service";
#define SR_SERVICE_INPUT_FORMAT "MR"
#define SR_SERVICE_MODEL_PATH "model"

static sr_service_status_t s_status;
static bool s_sr_initialized;

esp_err_t sr_service_init(void)
{
    if (s_sr_initialized) {
        ESP_LOGI(TAG, "sr service already initialized");
        return ESP_OK;
    }

    memset(&s_status, 0, sizeof(s_status));
    s_status.dependency_declared = true;
    s_status.input_format = SR_SERVICE_INPUT_FORMAT;
    s_status.model_path = SR_SERVICE_MODEL_PATH;
    s_status.microphone_ready = audio_service_microphone_ready();
    s_status.status_text = "not initialized";

    if (!s_status.microphone_ready) {
        s_status.status_text = "microphone not ready, AFE preflight incomplete";
        goto log_and_exit;
    }

    srmodel_list_t *models = esp_srmodel_init(SR_SERVICE_MODEL_PATH);
    if (models == NULL) {
        s_status.status_text = "model partition 'model' not found";
        goto log_and_exit;
    }

    s_status.model_count = (uint32_t)models->num;
    s_status.models_available = (models->num > 0);
    if (!s_status.models_available) {
        s_status.status_text = "model partition mounted but contains no SR models";
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }

    afe_config_t *afe_config = afe_config_init(SR_SERVICE_INPUT_FORMAT, models, AFE_TYPE_SR, AFE_MODE_HIGH_PERF);
    if (afe_config == NULL) {
        s_status.status_text = "afe_config_init failed";
        esp_srmodel_deinit(models);
        goto log_and_exit;
    }

    s_status.afe_config_ready = true;
    esp_afe_sr_iface_t *afe_iface = esp_afe_handle_from_config(afe_config);
    s_status.afe_ready = (afe_iface != NULL);
    s_status.status_text = s_status.afe_ready
                               ? "ESP-SR AFE preflight ready; runtime feed/fetch deferred"
                               : "AFE interface unavailable from current config";

    free(afe_config);
    esp_srmodel_deinit(models);

log_and_exit:
    ESP_LOGI(TAG,
             "preflight dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s",
             s_status.dependency_declared ? "yes" : "no",
             s_status.microphone_ready ? "yes" : "no",
             s_status.models_available ? "yes" : "no",
             s_status.model_count,
             s_status.input_format,
             s_status.model_path,
             s_status.afe_config_ready ? "yes" : "no",
             s_status.afe_ready ? "yes" : "no");
    ESP_LOGI(TAG, "status=%s", s_status.status_text);

    s_sr_initialized = true;
    return ESP_OK;
}

bool sr_service_dependency_declared(void)
{
    return s_status.dependency_declared;
}

bool sr_service_models_available(void)
{
    return s_status.models_available;
}

uint32_t sr_service_model_count(void)
{
    return s_status.model_count;
}

bool sr_service_afe_config_ready(void)
{
    return s_status.afe_config_ready;
}

bool sr_service_afe_ready(void)
{
    return s_status.afe_ready;
}

const char *sr_service_input_format(void)
{
    return s_status.input_format;
}

const char *sr_service_model_path(void)
{
    return s_status.model_path;
}

const char *sr_service_status_text(void)
{
    return s_status.status_text;
}

void sr_service_get_status(sr_service_status_t *status)
{
    if (status == NULL) {
        return;
    }

    memcpy(status, &s_status, sizeof(*status));
}

void sr_service_log_summary(void)
{
    ESP_LOGI(TAG,
             "dependency_declared=%s microphone_ready=%s models_available=%s model_count=%" PRIu32 " input_format=%s model_path=%s afe_config_ready=%s afe_ready=%s status=%s",
             s_status.dependency_declared ? "yes" : "no",
             s_status.microphone_ready ? "yes" : "no",
             s_status.models_available ? "yes" : "no",
             s_status.model_count,
             s_status.input_format,
             s_status.model_path,
             s_status.afe_config_ready ? "yes" : "no",
             s_status.afe_ready ? "yes" : "no",
             s_status.status_text);
}
