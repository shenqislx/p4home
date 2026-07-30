#pragma once

/* Host shim for the few FreeRTOS primitives the UI layer touches.
 *
 * WARNING: the critical sections are no-ops here. The simulator is single
 * threaded, so it will never reproduce a race between the LVGL lock and the HA
 * callback task. Concurrency correctness has to be verified on hardware. */

#include <stdint.h>

typedef int portMUX_TYPE;

#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(mux) do { (void)(mux); } while (0)
#define portEXIT_CRITICAL(mux) do { (void)(mux); } while (0)

#define pdMS_TO_TICKS(ms) (ms)
#define portTICK_PERIOD_MS 1
