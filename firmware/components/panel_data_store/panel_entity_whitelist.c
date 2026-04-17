#include "panel_entity_whitelist.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"

extern const char panel_entities_json_start[] asm("_binary_panel_entities_json_start");
extern const char panel_entities_json_end[] asm("_binary_panel_entities_json_end");

static const char *TAG = "panel_whitelist";

static panel_sensor_t s_whitelist[CONFIG_P4HOME_ENTITY_WHITELIST_MAX_ENTITIES];
static size_t s_whitelist_count;

static panel_sensor_kind_t panel_entity_kind_from_text(const char *kind)
{
    if (kind == NULL) {
        return PANEL_SENSOR_KIND_TEXT;
    }
    if (strcmp(kind, "numeric") == 0) {
        return PANEL_SENSOR_KIND_NUMERIC;
    }
    if (strcmp(kind, "binary") == 0) {
        return PANEL_SENSOR_KIND_BINARY;
    }
    if (strcmp(kind, "timestamp") == 0) {
        return PANEL_SENSOR_KIND_TIMESTAMP;
    }
    return PANEL_SENSOR_KIND_TEXT;
}

esp_err_t panel_entity_whitelist_load(void)
{
#if !CONFIG_P4HOME_ENTITY_WHITELIST_EMBEDDED
    return ESP_ERR_NOT_SUPPORTED;
#else
    s_whitelist_count = 0U;
    const size_t json_len = (size_t)(panel_entities_json_end - panel_entities_json_start);
    cJSON *root = cJSON_ParseWithLength(panel_entities_json_start, json_len);
    ESP_RETURN_ON_FALSE(root != NULL, ESP_FAIL, TAG, "failed to parse embedded whitelist");
    cJSON *entities = cJSON_GetObjectItemCaseSensitive(root, "entities");
    ESP_RETURN_ON_FALSE(cJSON_IsArray(entities), ESP_ERR_INVALID_ARG, TAG,
                        "embedded whitelist entities is not an array");

    cJSON *entry = NULL;
    cJSON_ArrayForEach(entry, entities) {
        if (!cJSON_IsObject(entry) || s_whitelist_count >= CONFIG_P4HOME_ENTITY_WHITELIST_MAX_ENTITIES) {
            break;
        }
        cJSON *entity_id = cJSON_GetObjectItemCaseSensitive(entry, "entity_id");
        cJSON *label = cJSON_GetObjectItemCaseSensitive(entry, "label");
        cJSON *unit = cJSON_GetObjectItemCaseSensitive(entry, "unit");
        cJSON *icon = cJSON_GetObjectItemCaseSensitive(entry, "icon");
        cJSON *group = cJSON_GetObjectItemCaseSensitive(entry, "group");
        cJSON *kind = cJSON_GetObjectItemCaseSensitive(entry, "kind");
        if (!cJSON_IsString(entity_id) || !cJSON_IsString(label)) {
            continue;
        }

        panel_sensor_t sensor = {0};
        snprintf(sensor.entity_id, sizeof(sensor.entity_id), "%s", entity_id->valuestring);
        snprintf(sensor.label, sizeof(sensor.label), "%s", label->valuestring);
        if (cJSON_IsString(unit)) {
            snprintf(sensor.unit, sizeof(sensor.unit), "%s", unit->valuestring);
        }
        if (cJSON_IsString(icon)) {
            snprintf(sensor.icon, sizeof(sensor.icon), "%s", icon->valuestring);
        }
        if (cJSON_IsString(group)) {
            snprintf(sensor.group, sizeof(sensor.group), "%s", group->valuestring);
        } else {
            snprintf(sensor.group, sizeof(sensor.group), "%s", "默认");
        }
        sensor.kind = panel_entity_kind_from_text(cJSON_IsString(kind) ? kind->valuestring : NULL);
        sensor.freshness = PANEL_SENSOR_FRESHNESS_UNKNOWN;
        sensor.available = false;
        s_whitelist[s_whitelist_count++] = sensor;
        (void)panel_data_store_register(&sensor);
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "panel whitelist parsed n=%u", (unsigned)s_whitelist_count);
    return s_whitelist_count > 0U ? ESP_OK : ESP_ERR_NOT_FOUND;
#endif
}

size_t panel_entity_whitelist_count(void)
{
    return s_whitelist_count;
}

const panel_sensor_t *panel_entity_whitelist_at(size_t index)
{
    if (index >= s_whitelist_count) {
        return NULL;
    }
    return &s_whitelist[index];
}
