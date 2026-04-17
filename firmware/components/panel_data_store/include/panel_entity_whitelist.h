#pragma once

#include <stddef.h>

#include "esp_err.h"
#include "panel_data_store.h"

esp_err_t panel_entity_whitelist_load(void);
size_t panel_entity_whitelist_count(void);
const panel_sensor_t *panel_entity_whitelist_at(size_t index);
