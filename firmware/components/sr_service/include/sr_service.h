#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    bool dependency_declared;
    bool microphone_ready;
    bool models_available;
    bool afe_config_ready;
    bool afe_ready;
    uint32_t model_count;
    const char *input_format;
    const char *model_path;
    const char *status_text;
} sr_service_status_t;

esp_err_t sr_service_init(void);
bool sr_service_dependency_declared(void);
bool sr_service_models_available(void);
uint32_t sr_service_model_count(void);
bool sr_service_afe_config_ready(void);
bool sr_service_afe_ready(void);
const char *sr_service_input_format(void);
const char *sr_service_model_path(void);
const char *sr_service_status_text(void);
void sr_service_get_status(sr_service_status_t *status);
void sr_service_log_summary(void);
