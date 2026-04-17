idf_component_register(SRCS "time_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_event freertos lwip
                       PRIV_REQUIRES esp_timer log network_service)
