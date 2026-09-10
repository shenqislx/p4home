# Keep the installed SDK immutable. Compile a generated copy with both buffered
# readiness checks fixed; upstream source changes force a compatibility review.
idf_component_get_property(p4home_tcp_lib tcp_transport COMPONENT_LIB)
idf_component_get_property(p4home_tcp_dir tcp_transport COMPONENT_DIR)
set(p4home_ws_source "${p4home_tcp_dir}/transport_ws.c")
set(p4home_ws_patch "${CMAKE_CURRENT_LIST_DIR}/../../scripts/patch-idf-ws-buffer.py")
set(p4home_ws_generated "${CMAKE_BINARY_DIR}/p4home_patches/transport_ws.c")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${p4home_ws_source}" "${p4home_ws_patch}")
execute_process(
    COMMAND "${PYTHON}" "${p4home_ws_patch}" --source "${p4home_ws_source}"
        --output "${p4home_ws_generated}"
    RESULT_VARIABLE p4home_ws_patch_result)
if(NOT p4home_ws_patch_result EQUAL 0)
    message(FATAL_ERROR "Cannot apply the P4Home WebSocket buffered readiness fix")
endif()
get_target_property(p4home_tcp_sources ${p4home_tcp_lib} SOURCES)
set(p4home_ws_found FALSE)
foreach(p4home_source IN LISTS p4home_tcp_sources)
    get_filename_component(p4home_source_name "${p4home_source}" NAME)
    if(p4home_source_name STREQUAL "transport_ws.c")
        list(REMOVE_ITEM p4home_tcp_sources "${p4home_source}")
        set(p4home_ws_found TRUE)
    endif()
endforeach()
if(NOT p4home_ws_found)
    message(FATAL_ERROR "tcp_transport no longer builds transport_ws.c; review the compatibility fix")
endif()
list(APPEND p4home_tcp_sources "${p4home_ws_generated}")
set_property(TARGET ${p4home_tcp_lib} PROPERTY SOURCES "${p4home_tcp_sources}")
