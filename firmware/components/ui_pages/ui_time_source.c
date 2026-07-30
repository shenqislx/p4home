#include "ui_time_source.h"

#include <string.h>

#include "time_service.h"

static ui_time_source_t s_override;
static bool s_has_override;

void ui_time_source_set(const ui_time_source_t *source)
{
    if (source == NULL || source->now == NULL) {
        memset(&s_override, 0, sizeof(s_override));
        s_has_override = false;
        return;
    }
    s_override = *source;
    s_has_override = true;
}

bool ui_time_source_local(struct tm *out_local)
{
    if (out_local == NULL) {
        return false;
    }
    memset(out_local, 0, sizeof(*out_local));

    if (s_has_override) {
        return s_override.now(s_override.user_data, out_local);
    }
    if (!time_service_is_synced()) {
        return false;
    }
    time_t now = time(NULL);
    return localtime_r(&now, out_local) != NULL;
}

bool ui_time_source_moon_phase(uint8_t *out_phase)
{
    struct tm local = {0};
    if (out_phase == NULL || !ui_time_source_local(&local)) {
        return false;
    }

    /* Conway's approximation: accurate to about a day, which is well inside the
     * resolution of an 8-frame phase sprite. */
    int year = local.tm_year + 1900;
    int month = local.tm_mon + 1;
    int day = local.tm_mday;

    int golden = year % 100 % 19;
    if (golden > 9) {
        golden -= 19;
    }
    double age = ((golden * 11) % 30) + month + day;
    if (month < 3) {
        age += 2.0;
    }
    age -= (year < 2000) ? 4.0 : 8.3;

    int days = (int)(age + 0.5) % 30;
    if (days < 0) {
        days += 30;
    }

    /* Map the 0..29 day age onto 8 sprite frames. */
    *out_phase = (uint8_t)((days * 8) / 30 % 8);
    return true;
}
