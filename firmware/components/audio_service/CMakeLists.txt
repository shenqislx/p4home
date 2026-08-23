idf_component_register(SRCS "audio_service.c" "audio_service_lease.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp32_p4_function_ev_board espressif__esp_codec_dev)
