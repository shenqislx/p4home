#pragma once

#include "lvgl.h"

/*
 * lv_async_call() mutates LVGL-owned queues and allocators.  It is therefore
 * subject to the same BSP display mutex as every other LVGL API, even though
 * the callback itself runs later on the LVGL task.
 */
lv_result_t ui_async_call(lv_async_cb_t callback, void *user_data);
