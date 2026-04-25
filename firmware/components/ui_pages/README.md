# ui_pages

LVGL 页面与控件实现：`ui_pages.c` 负责 Home / Settings / Gateway 三页 UI、音频/触摸/网关相关回调，以及仪表条等运行时更新。

`display_service` 仅负责 DSI/LVGL 显示初始化与对外的 `display_service_*` API，具体页面内容由本组件渲染。

## Dashboard

Dashboard cards are built from `panel_data_store` snapshots seeded by
`panel_entities.json`. Numeric, binary, text, and timestamp entities keep their
existing card types.

Store observer callbacks do not touch LVGL directly. They copy the sensor state
and schedule `lv_async_call`; a LVGL timer also refreshes snapshots every 2s so
freshness, HA disconnects, and offline states remain visible even without a new
HA event.
