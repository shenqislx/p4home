idf_component_register(SRCS "touch_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp32_p4_function_ev_board esp_driver_i2c esp_lcd espressif__esp_lcd_touch_gt911)
