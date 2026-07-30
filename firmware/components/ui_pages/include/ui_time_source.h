#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

/* Wall-clock indirection for the UI layer.
 *
 * The day/night sky, moon phase and window-light effects are driven by the real
 * clock, which makes them impossible to review on hardware: a full cycle takes
 * 24 hours. Routing those reads through this seam lets the host simulator
 * replay a whole day in seconds while the firmware keeps using time_service. */

typedef struct {
    /* Returns false when no trustworthy wall clock is available yet, in which
     * case callers must fall back to their waiting/unknown presentation. */
    bool (*now)(void *user_data, struct tm *out_local);
    void *user_data;
} ui_time_source_t;

/* Install an override. Passing NULL restores the default time_service path. */
void ui_time_source_set(const ui_time_source_t *source);

/* Fill *out_local with local time. Returns false if the clock is not synced. */
bool ui_time_source_local(struct tm *out_local);

/* 0..7 moon phase index: 0 = new, 4 = full. Returns false without a clock. */
bool ui_time_source_moon_phase(uint8_t *out_phase);
