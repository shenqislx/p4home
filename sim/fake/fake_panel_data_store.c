#include <stdio.h>
#include <string.h>

#include "fake_backend.h"

#define FAKE_STORE_MAX_ENTITIES 64U
#define FAKE_STORE_MAX_OBSERVERS 8U

typedef struct {
    panel_data_store_observer_cb_t callback;
    void *user_data;
} fake_observer_t;

static panel_sensor_t s_entities[FAKE_STORE_MAX_ENTITIES];
static size_t s_count;
static fake_observer_t s_observers[FAKE_STORE_MAX_OBSERVERS];
static size_t s_observer_count;

static panel_sensor_t *fake_store_find(const char *entity_id)
{
    for (size_t i = 0; i < s_count; ++i) {
        if (strcmp(s_entities[i].entity_id, entity_id) == 0) {
            return &s_entities[i];
        }
    }
    return NULL;
}

static void fake_store_notify(const panel_sensor_t *sensor)
{
    for (size_t i = 0; i < s_observer_count; ++i) {
        if (s_observers[i].callback != NULL) {
            s_observers[i].callback(sensor, s_observers[i].user_data);
        }
    }
}

static void fake_store_add_light(const char *entity_id, const char *label, const char *group)
{
    if (s_count >= FAKE_STORE_MAX_ENTITIES) {
        return;
    }
    panel_sensor_t *sensor = &s_entities[s_count++];
    memset(sensor, 0, sizeof(*sensor));
    snprintf(sensor->entity_id, sizeof(sensor->entity_id), "%s", entity_id);
    snprintf(sensor->label, sizeof(sensor->label), "%s", label);
    snprintf(sensor->group, sizeof(sensor->group), "%s", group);
    snprintf(sensor->icon, sizeof(sensor->icon), "light");
    snprintf(sensor->value_text, sizeof(sensor->value_text), "off");
    snprintf(sensor->control_domain, sizeof(sensor->control_domain), "switch");
    sensor->kind = PANEL_SENSOR_KIND_BINARY;
    sensor->available = true;
    sensor->freshness = PANEL_SENSOR_FRESHNESS_FRESH;
}

static void fake_store_add_climate(const char *entity_id, const char *label, const char *group)
{
    if (s_count >= FAKE_STORE_MAX_ENTITIES) {
        return;
    }
    panel_sensor_t *sensor = &s_entities[s_count++];
    memset(sensor, 0, sizeof(*sensor));
    snprintf(sensor->entity_id, sizeof(sensor->entity_id), "%s", entity_id);
    snprintf(sensor->label, sizeof(sensor->label), "%s", label);
    snprintf(sensor->group, sizeof(sensor->group), "%s", group);
    snprintf(sensor->icon, sizeof(sensor->icon), "climate");
    snprintf(sensor->value_text, sizeof(sensor->value_text), "off");
    snprintf(sensor->unit, sizeof(sensor->unit), "C");
    sensor->kind = PANEL_SENSOR_KIND_CLIMATE;
    sensor->current_temperature = 26.5;
    sensor->target_temperature = 24.0;
    sensor->has_current_temperature = true;
    sensor->has_target_temperature = true;
    sensor->available = true;
    sensor->freshness = PANEL_SENSOR_FRESHNESS_FRESH;
}

void fake_store_seed(void)
{
    s_count = 0;

    /* Mirrors the group names in panel_data_store/panel_entities.json so the
     * room aggregation in ui_page_home is exercised the same way as on device. */
    fake_store_add_light("switch.living_spot", "客厅射灯", "客厅");
    fake_store_add_light("switch.living_main", "客厅大灯", "客厅");
    fake_store_add_light("switch.living_display", "客厅展示灯", "客厅");
    fake_store_add_light("switch.living_wall", "客厅壁灯", "客厅");
    fake_store_add_light("switch.living_downlight", "客厅筒灯", "客厅");

    fake_store_add_light("switch.dining_cabinet", "餐厅柜灯", "餐厅");
    fake_store_add_light("switch.dining_main", "餐厅大灯", "餐厅");
    fake_store_add_light("switch.kitchen_main", "厨房大灯", "厨房");
    fake_store_add_light("switch.arch_strip", "拱门灯带", "拱门");

    fake_store_add_light("switch.study_main", "书房大灯", "书房");
    fake_store_add_light("switch.study_desk", "书房台灯", "书房");
    fake_store_add_light("switch.balcony_main", "阳台灯", "阳台");
    fake_store_add_light("switch.guest_bath", "客卫灯", "客卫");
    fake_store_add_light("switch.guest_room", "阳台卧灯", "阳台卧");

    fake_store_add_light("switch.entry_main", "玄关灯", "玄关");
    fake_store_add_light("switch.entry_strip", "玄关灯带", "玄关");
    fake_store_add_light("switch.master_main", "主卧大灯", "主卧");
    fake_store_add_light("switch.master_bed", "主卧床头灯", "主卧");
    fake_store_add_light("switch.master_bath", "主卫灯", "主卫");
    fake_store_add_light("switch.closet_main", "衣帽间灯", "衣帽间");

    fake_store_add_climate("climate.living", "客厅空调", "客厅");
    fake_store_add_climate("climate.master", "主卧空调", "主卧");
    fake_store_add_climate("climate.study", "书房空调", "书房");
    fake_store_add_climate("climate.guest", "阳台卧空调", "阳台卧");

    /* weather_service publishes a pipe-delimited forecast into a TEXT entity
     * tagged with the "weather" icon; the home page parses the condition out of
     * the second field. */
    if (s_count < FAKE_STORE_MAX_ENTITIES) {
        panel_sensor_t *sensor = &s_entities[s_count++];
        memset(sensor, 0, sizeof(*sensor));
        snprintf(sensor->entity_id, sizeof(sensor->entity_id), "sensor.weather_today");
        snprintf(sensor->label, sizeof(sensor->label), "今日天气");
        snprintf(sensor->icon, sizeof(sensor->icon), "weather");
        snprintf(sensor->value_text, sizeof(sensor->value_text), "Today|Clear|Now 26 High 30 Low 18");
        sensor->kind = PANEL_SENSOR_KIND_TEXT;
        sensor->available = true;
        sensor->freshness = PANEL_SENSOR_FRESHNESS_FRESH;
    }
}

void fake_store_set_weather(const char *condition)
{
    panel_sensor_t *sensor = fake_store_find("sensor.weather_today");
    if (sensor == NULL) {
        return;
    }
    snprintf(sensor->value_text, sizeof(sensor->value_text), "Today|%s|Now 26 High 30 Low 18", condition);
    sensor->updated_at_ms = fake_clock_epoch();
    fake_store_notify(sensor);
}

void fake_store_set_binary(const char *entity_id, bool on)
{
    panel_sensor_t *sensor = fake_store_find(entity_id);
    if (sensor == NULL) {
        return;
    }
    snprintf(sensor->value_text, sizeof(sensor->value_text), "%s", on ? "on" : "off");
    sensor->updated_at_ms = fake_clock_epoch();
    fake_store_notify(sensor);
}

void fake_store_set_climate(const char *entity_id, const char *mode,
                            double current_c, double target_c)
{
    panel_sensor_t *sensor = fake_store_find(entity_id);
    if (sensor == NULL) {
        return;
    }
    snprintf(sensor->value_text, sizeof(sensor->value_text), "%s", mode);
    sensor->current_temperature = current_c;
    sensor->target_temperature = target_c;
    sensor->has_current_temperature = true;
    sensor->has_target_temperature = true;
    sensor->updated_at_ms = fake_clock_epoch();
    fake_store_notify(sensor);
}

void fake_store_set_available(const char *entity_id, bool available)
{
    panel_sensor_t *sensor = fake_store_find(entity_id);
    if (sensor == NULL) {
        return;
    }
    sensor->available = available;
    sensor->freshness = available ? PANEL_SENSOR_FRESHNESS_FRESH
                                  : PANEL_SENSOR_FRESHNESS_STALE;
    fake_store_notify(sensor);
}

void fake_store_set_group_lights(const char *group, bool on)
{
    for (size_t i = 0; i < s_count; ++i) {
        if (s_entities[i].kind == PANEL_SENSOR_KIND_BINARY &&
            strcmp(s_entities[i].group, group) == 0) {
            fake_store_set_binary(s_entities[i].entity_id, on);
        }
    }
}

void fake_store_set_all_lights(bool on)
{
    for (size_t i = 0; i < s_count; ++i) {
        if (s_entities[i].kind == PANEL_SENSOR_KIND_BINARY) {
            fake_store_set_binary(s_entities[i].entity_id, on);
        }
    }
}

void fake_store_set_all_available(bool available)
{
    for (size_t i = 0; i < s_count; ++i) {
        fake_store_set_available(s_entities[i].entity_id, available);
    }
}

/* --- panel_data_store.h implementation ------------------------------------ */

esp_err_t panel_data_store_init(void)
{
    return ESP_OK;
}

esp_err_t panel_data_store_register(const panel_sensor_t *seed)
{
    if (seed == NULL || s_count >= FAKE_STORE_MAX_ENTITIES) {
        return ESP_ERR_NO_MEM;
    }
    s_entities[s_count++] = *seed;
    return ESP_OK;
}

esp_err_t panel_data_store_update(const panel_sensor_t *sensor)
{
    if (sensor == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    panel_sensor_t *existing = fake_store_find(sensor->entity_id);
    if (existing == NULL) {
        return panel_data_store_register(sensor);
    }
    *existing = *sensor;
    fake_store_notify(existing);
    return ESP_OK;
}

bool panel_data_store_get_snapshot(const char *entity_id, panel_sensor_t *sensor)
{
    if (entity_id == NULL || sensor == NULL) {
        return false;
    }
    const panel_sensor_t *found = fake_store_find(entity_id);
    if (found == NULL) {
        return false;
    }
    *sensor = *found;
    return true;
}

size_t panel_data_store_get_samples(const char *entity_id, panel_sensor_sample_t *samples,
                                    size_t max_samples)
{
    (void)entity_id;
    (void)samples;
    (void)max_samples;
    return 0;
}

size_t panel_data_store_entity_count(void)
{
    return s_count;
}

size_t panel_data_store_rejected_count(void)
{
    return 0;
}

void panel_data_store_tick_freshness(uint64_t now_ms)
{
    (void)now_ms;
}

esp_err_t panel_data_store_set_observer(panel_data_store_observer_cb_t observer, void *user_data)
{
    s_observer_count = 0;
    return panel_data_store_add_observer(observer, user_data);
}

esp_err_t panel_data_store_add_observer(panel_data_store_observer_cb_t observer, void *user_data)
{
    if (observer == NULL || s_observer_count >= FAKE_STORE_MAX_OBSERVERS) {
        return ESP_ERR_NO_MEM;
    }
    s_observers[s_observer_count].callback = observer;
    s_observers[s_observer_count].user_data = user_data;
    s_observer_count++;
    return ESP_OK;
}

void panel_data_store_iterate(panel_data_store_iterate_cb_t callback, void *user_data)
{
    if (callback == NULL) {
        return;
    }
    for (size_t i = 0; i < s_count; ++i) {
        if (!callback(&s_entities[i], user_data)) {
            return;
        }
    }
}

void panel_data_store_log_summary(void) {}

void panel_data_store_on_ha_state_change(const ha_client_state_change_t *change, void *user_data)
{
    (void)change;
    (void)user_data;
}
