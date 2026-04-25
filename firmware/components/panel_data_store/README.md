# panel_data_store

Thread-safe in-memory cache for Home Assistant entities shown by the panel.

The entity list is still compile-time data from `panel_entities.json`. Startup
parses that file into `panel_sensor_t` seeds and registers them before HA starts
delivering state updates.

## Freshness Time Base

`updated_at_ms` is HA epoch time in milliseconds. Callers must pass epoch
milliseconds to `panel_data_store_tick_freshness()`, normally from
`time_service_now_epoch_ms()`. Passing `0` leaves entities in `unknown` freshness
instead of mixing boot uptime with HA timestamps.

Observer callbacks may run from the HA client task. UI consumers must copy data
and switch to the LVGL task with `lv_async_call` before touching LVGL objects.
