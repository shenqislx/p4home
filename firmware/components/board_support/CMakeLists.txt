idf_component_register(SRCS "board_support.c"
                       REQUIRES audio_service display_service esp_app_format gateway_service ha_client network_service panel_data_store settings_service sr_service time_service touch_service
                       INCLUDE_DIRS "include")
