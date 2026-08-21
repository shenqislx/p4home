#include "ui_async.h"

#include "bsp/esp32_p4_function_ev_board.h"

lv_result_t ui_async_call(lv_async_cb_t callback, void *user_data)
{
    if (callback == NULL || !bsp_display_lock(0)) {
        return LV_RESULT_INVALID;
    }

    lv_result_t result = lv_async_call(callback, user_data);
    if (result != LV_RESULT_OK) {
        /*
         * The callback owns any heap payload and often clears a pending UI
         * state.  Running it synchronously under the same recursive mutex is
         * the fail-safe path when LVGL cannot allocate its async timer.
         */
        callback(user_data);
        result = LV_RESULT_OK;
    }
    bsp_display_unlock();
    return result;
}
