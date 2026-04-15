idf_component_register(SRCS "display_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES audio_service esp32_p4_function_ev_board gateway_service lvgl settings_service)
