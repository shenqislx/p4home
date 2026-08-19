idf_component_register(SRCS "agent_transport.c"
                       INCLUDE_DIRS "include"
                       REQUIRES app_update esp_timer esp_websocket_client json mbedtls world_service)
