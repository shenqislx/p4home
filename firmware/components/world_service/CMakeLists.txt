idf_component_register(SRCS "world_service.c" "world_object_registry.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_timer freertos heap)
