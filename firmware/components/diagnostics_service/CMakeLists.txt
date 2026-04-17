idf_component_register(SRCS "diagnostics_service.c"
                       REQUIRES app_update esp_app_format esp_partition esp_psram esp_timer ha_client spi_flash
                       INCLUDE_DIRS "include")
