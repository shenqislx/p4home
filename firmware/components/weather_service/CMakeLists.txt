idf_component_register(SRCS "weather_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_http_client esp-tls json network_service panel_data_store time_service)
