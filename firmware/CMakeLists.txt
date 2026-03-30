cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Trim M1 builds to the components actually used by the current firmware entrypoint.
idf_build_set_property(MINIMAL_BUILD ON)
project(p4home_firmware)
