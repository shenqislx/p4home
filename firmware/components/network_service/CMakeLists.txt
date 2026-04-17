idf_component_register(SRCS "network_service.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_event esp_netif esp_wifi nvs_flash esp_wifi_remote)
