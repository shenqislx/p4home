# ui_pages

LVGL 页面与控件实现：`ui_pages.c` 负责 Home / Settings / Gateway 三页 UI、音频/触摸/网关相关回调，以及仪表条等运行时更新。

`display_service` 仅负责 DSI/LVGL 显示初始化与对外的 `display_service_*` API，具体页面内容由本组件渲染。
