cmake_minimum_required(VERSION 3.16)
project(p4home_pixel_sim C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# LVGL source location. Defaults to the ESP-IDF component manager download cache
# so the simulator builds offline; override with -DLVGL_DIR=... to point at an
# extracted managed_components copy instead.
if(NOT DEFINED LVGL_DIR)
    file(GLOB LVGL_CANDIDATES
         "${CMAKE_CURRENT_SOURCE_DIR}/../firmware/managed_components/lvgl__lvgl"
         "$ENV{HOME}/.cache/Espressif/ComponentManager/*/lvgl__lvgl_9.*"
         "/root/.cache/Espressif/ComponentManager/*/lvgl__lvgl_9.*")
    foreach(candidate ${LVGL_CANDIDATES})
        if(EXISTS "${candidate}/lvgl.h")
            set(LVGL_DIR "${candidate}")
            break()
        endif()
    endforeach()
endif()

if(NOT LVGL_DIR OR NOT EXISTS "${LVGL_DIR}/lvgl.h")
    message(FATAL_ERROR
            "LVGL source not found. Pass -DLVGL_DIR=/path/to/lvgl (needs 9.4+).")
endif()
message(STATUS "Using LVGL from ${LVGL_DIR}")

set(FIRMWARE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../firmware")
set(UI_PAGES_DIR "${FIRMWARE_DIR}/components/ui_pages")
set(UI_ART_DIR "${FIRMWARE_DIR}/components/ui_pixel_art")

# Nothing here needs LVGL's bundled demos, examples or ThorVG, and skipping them
# keeps the host build to a few seconds.
set(LV_BUILD_CONF_DIR "${CMAKE_CURRENT_SOURCE_DIR}" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)

add_subdirectory("${LVGL_DIR}" lvgl_build EXCLUDE_FROM_ALL)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2 REQUIRED sdl2)

# CONFIGURE_DEPENDS so adding a .pxart and regenerating does not leave a stale
# source list behind.
file(GLOB UI_ART_SOURCES CONFIGURE_DEPENDS "${UI_ART_DIR}/sprites/*.c")

# Only the pixel home page and its dependencies are built. The other four pages
# would pull network_service, the card widgets and the weather parser into the
# host build for no review value, so sim_ui_shell.c provides the screen chrome
# and navigation bar in place of ui_pages.c.
add_executable(pixel_sim
    main.c
    sim_ui_shell.c
    shim/esp_err.c
    fake/fake_time.c
    fake/fake_ha_client.c
    fake/fake_panel_data_store.c
    fake/fake_scenario.c
    "${UI_PAGES_DIR}/ui_page_home.c"
    "${UI_PAGES_DIR}/ui_home_rooms.c"
    "${UI_PAGES_DIR}/ui_home_actor.c"
    "${UI_PAGES_DIR}/ui_pixel_fx.c"
    "${UI_PAGES_DIR}/ui_time_source.c"
    "${UI_PAGES_DIR}/fonts/ui_font_source_han_sans_sc_16.c"
    "${UI_PAGES_DIR}/fonts/ui_font_pixel_modes_48.c"
    ${UI_ART_SOURCES}
)

target_include_directories(pixel_sim PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/shim"
    "${CMAKE_CURRENT_SOURCE_DIR}/fake"
    "${UI_PAGES_DIR}"
    "${UI_PAGES_DIR}/include"
    "${UI_ART_DIR}/include"
    "${FIRMWARE_DIR}/components/ha_client/include"
    "${FIRMWARE_DIR}/components/panel_data_store/include"
    "${FIRMWARE_DIR}/components/time_service/include"
    ${SDL2_INCLUDE_DIRS}
)

target_compile_options(pixel_sim PRIVATE -Wall -Wextra -Wno-unused-parameter -g -O1)
target_link_libraries(pixel_sim PRIVATE lvgl ${SDL2_LIBRARIES} m)
target_link_directories(pixel_sim PRIVATE ${SDL2_LIBRARY_DIRS})
