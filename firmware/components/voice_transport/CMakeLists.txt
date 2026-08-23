idf_component_register(SRCS "voice_transport.c"
                       REQUIRES esp_websocket_client json mbedtls nvs_flash sr_service voice_protocol esp_timer
                       INCLUDE_DIRS "include")
