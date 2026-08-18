#pragma once

#include <stdint.h>

static inline int64_t esp_timer_get_time(void)
{
#ifdef WORLD_SERVICE_HOST_TEST
    return 0;
#else
    extern uint32_t lv_tick_get(void);
    return (int64_t)lv_tick_get() * 1000;
#endif
}
