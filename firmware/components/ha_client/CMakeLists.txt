idf_component_register(SRCS "ha_client.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_http_client esp_websocket_client esp-tls json network_service settings_service time_service
                       PRIV_REQUIRES esp_event freertos mbedtls esp_timer)
