#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "panel_data_store.h"

/* Scripted stand-ins for the device-side services.
 *
 * These implement the real ha_client / panel_data_store / time_service headers,
 * so any signature drift in the firmware breaks the simulator build rather than
 * silently diverging. */

/* Advance the virtual wall clock. The day/night sky, moon phase and window
 * light all read the clock, and a real 24 h cycle is not reviewable, so the
 * simulator replays a whole day in seconds. */
void fake_clock_set_epoch(uint64_t epoch_ms);
void fake_clock_advance(uint64_t delta_ms);
uint64_t fake_clock_epoch(void);
void fake_clock_set_synced(bool synced);

void fake_ha_set_ready(bool ready);

/* Seed the store from the same panel_entities.json groups the firmware uses. */
void fake_store_seed(void);

/* Push a state change through the normal observer path. */
void fake_store_set_binary(const char *entity_id, bool on);
void fake_store_set_climate(const char *entity_id, const char *mode,
                            double current_c, double target_c);
void fake_store_set_available(const char *entity_id, bool available);

/* Condition string as weather_service would publish it: sunny, cloudy, rainy,
 * snowy, fog. Drives the particle pool and the sky opacity. */
void fake_store_set_weather(const char *condition);

/* Bulk helpers used by the scripted scenarios. */
void fake_store_set_group_lights(const char *group, bool on);
void fake_store_set_all_lights(bool on);
void fake_store_set_all_available(bool available);

/* --- Scenario script ------------------------------------------------------- */

typedef struct {
    const char *label;
    uint32_t at_tick;  /* in 125 ms simulator ticks */
    void (*apply)(void);
} fake_scenario_step_t;

/* Runs the built-in walkthrough: lights on room by room, climate on, all-dark
 * night-idle timing, offline, recover. Returns false once the script has finished. */
bool fake_scenario_step(uint32_t tick);
uint32_t fake_scenario_length_ticks(void);
const char *fake_scenario_current_label(void);
