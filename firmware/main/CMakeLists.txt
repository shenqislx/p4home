idf_component_register(SRCS "app_main.c"
                       REQUIRES board_support diagnostics_service display_service panel_data_store touch_service ui_pages esp_timer
                       INCLUDE_DIRS ".")
