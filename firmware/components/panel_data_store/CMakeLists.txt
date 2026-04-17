idf_component_register(SRCS "panel_data_store.c" "panel_entity_whitelist.c"
                       INCLUDE_DIRS "include"
                       REQUIRES freertos ha_client json log
                       EMBED_TXTFILES "panel_entities.json")
