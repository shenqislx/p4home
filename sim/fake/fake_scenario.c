#include <stddef.h>

#include "fake_backend.h"
#include "world_service.h"

/* A deterministic walkthrough of every state the pixel home page reacts to.
 *
 * On hardware most of these transitions either need someone flipping physical
 * switches or take a full day to occur. Replaying them on a fixed tick schedule
 * is the only practical way to review the event effects. */

static void step_reset(void)
{
    fake_ha_set_ready(false);
    fake_store_set_all_available(true);
    fake_store_set_all_lights(false);
}

static void step_connect(void)
{
    fake_ha_set_ready(true);
}

static void step_entry_on(void)
{
    fake_store_set_group_lights("玄关", true);
    fake_store_set_group_lights("拱门", true);
}

static void step_living_on(void)
{
    fake_store_set_group_lights("客厅", true);
}

static void step_kitchen_on(void)
{
    fake_store_set_group_lights("餐厅", true);
    fake_store_set_group_lights("厨房", true);
}

static void step_climate_on(void)
{
    fake_store_set_climate("climate.living", "cool", 27.8, 24.0);
}

static void step_study_on(void)
{
    fake_store_set_group_lights("书房", true);
    fake_store_set_climate("climate.study", "cool", 26.2, 25.0);
}

static void step_upstairs_on(void)
{
    fake_store_set_group_lights("主卧", true);
    fake_store_set_group_lights("主卫", true);
    fake_store_set_group_lights("衣帽间", true);
    fake_store_set_group_lights("阳台卧", true);
    fake_store_set_group_lights("阳台", true);
    fake_store_set_group_lights("客卫", true);
}

static void step_climate_off(void)
{
    fake_store_set_climate("climate.living", "off", 24.1, 24.0);
    fake_store_set_climate("climate.study", "off", 25.0, 25.0);
}

static void step_downstairs_off(void)
{
    fake_store_set_group_lights("客厅", false);
    fake_store_set_group_lights("餐厅", false);
    fake_store_set_group_lights("厨房", false);
    fake_store_set_group_lights("玄关", false);
    fake_store_set_group_lights("拱门", false);
    fake_store_set_group_lights("书房", false);
}

static void step_all_dark(void)
{
    fake_store_set_all_lights(false);
}

static void step_offline(void)
{
    fake_ha_set_ready(false);
    fake_store_set_all_available(false);
}

static void step_recover(void)
{
    fake_ha_set_ready(true);
    fake_store_set_all_available(true);
    fake_store_set_group_lights("客厅", true);
}

static void step_weather_rain(void)
{
    fake_store_set_weather("Rain");
}

static void step_weather_snow(void)
{
    fake_store_set_weather("Snow");
}

static void step_weather_fog(void)
{
    fake_store_set_weather("Fog");
}

static void step_weather_clear(void)
{
    fake_store_set_weather("Clear");
}

static void step_agent_world_action(void)
{
    world_action_event_t event = {0};
    world_action_request_t move = {
        .action_id = "sim-agent-move-1",
        .tool = WORLD_ACTION_CHARACTER_GO_TO_ROOM,
        .arguments.room = WORLD_ROOM_GUEST_ROOM,
        .timeout_ms = 5000U,
    };
    world_action_request_t say = {
        .action_id = "sim-agent-say-1",
        .tool = WORLD_ACTION_CHARACTER_SAY,
        .arguments.text = "Agent 指定我来次卧看看",
        .timeout_ms = 5000U,
    };
    (void)world_service_set_agent_connected(true);
    if (world_service_submit(&move, &event) == ESP_OK &&
        world_service_start_next(&event) == ESP_OK) {
        (void)world_service_complete_active(&event);
    }
    if (world_service_submit(&say, &event) == ESP_OK &&
        world_service_start_next(&event) == ESP_OK) {
        (void)world_service_complete_active(&event);
    }
}

static void step_agent_offline(void)
{
    (void)world_service_set_agent_connected(false);
}

static const fake_scenario_step_t s_steps[] = {
    {"00 boot: waiting for Home Assistant", 4, step_reset},
    {"01 connected, house dark", 24, step_connect},
    {"02 entry lights on", 48, step_entry_on},
    {"03 living room on", 72, step_living_on},
    {"04 kitchen and dining on", 96, step_kitchen_on},
    {"05 living climate cooling", 120, step_climate_on},
    {"06 study on, study climate cooling", 152, step_study_on},
    {"07 whole upstairs on", 184, step_upstairs_on},
    {"08 climate off", 216, step_climate_off},
    {"09 rain", 240, step_weather_rain},
    {"10 snow", 288, step_weather_snow},
    {"11 fog", 336, step_weather_fog},
    {"12 clear again", 368, step_weather_clear},
    {"12a Agent world snapshot drives actor", 376, step_agent_world_action},
    {"12b Agent offline, local fallback resumes", 388, step_agent_offline},
    {"13 downstairs off", 392, step_downstairs_off},
    {"14 all dark, actor goes to sleep", 420, step_all_dark},
    {"15 offline", 460, step_offline},
    {"16 recovered", 492, step_recover},
};

#define FAKE_SCENARIO_STEP_COUNT (sizeof(s_steps) / sizeof(s_steps[0]))

static size_t s_next;
static const char *s_label = "-- idle --";

bool fake_scenario_step(uint32_t tick)
{
    bool fired = false;
    while (s_next < FAKE_SCENARIO_STEP_COUNT && s_steps[s_next].at_tick <= tick) {
        s_steps[s_next].apply();
        s_label = s_steps[s_next].label;
        s_next++;
        fired = true;
    }
    (void)fired;
    return s_next < FAKE_SCENARIO_STEP_COUNT;
}

uint32_t fake_scenario_length_ticks(void)
{
    return s_steps[FAKE_SCENARIO_STEP_COUNT - 1U].at_tick + 32U;
}

const char *fake_scenario_current_label(void)
{
    return s_label;
}
