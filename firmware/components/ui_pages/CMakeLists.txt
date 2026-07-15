idf_component_register(SRCS "ui_pages.c" "ui_page_dashboard.c" "ui_page_climate.c" "ui_status_banner.c" "cards/ui_card_numeric.c" "cards/ui_card_binary.c" "cards/ui_card_multiline.c" "cards/ui_card_trend.c" "cards/ui_card_weather.c" "cards/ui_card_action.c" "cards/ui_card_climate.c" "fonts/ui_font_source_han_sans_sc_16.c"
                       INCLUDE_DIRS "include" "." "cards"
                       REQUIRES audio_service esp32_p4_function_ev_board gateway_service ha_client lvgl network_service panel_data_store settings_service time_service)
