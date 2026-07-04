cmake_minimum_required(VERSION 3.10)
project(driver_nearsecvr VERSION 1.0)

# SteamVR driver DLLs must use the C++11 standard (or higher)
set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX_STANDARD_REQUIRED True)

# The output library MUST be named "driver_<name>" for SteamVR to load it
set(DRIVER_NAME "driver_nearsecvr")

# Add the OpenVR headers and libs (You must download the SDK and place it in the "openvr" folder)
# GitHub: https://github.com/ValveSoftware/openvr
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/openvr/headers)

if(WIN32)
    # SteamVR requires 64-bit drivers in a bin/win64/ folder
    set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} /SUBSYSTEM:WINDOWS")
    link_directories(${CMAKE_CURRENT_SOURCE_DIR}/openvr/lib/win64)
    set(OPENVR_LIB openvr_api)
    set(PLATFORM_LIBS ws2_32)
else()
    # Linux setup (SteamVR looks in bin/linux64/)
    link_directories(${CMAKE_CURRENT_SOURCE_DIR}/openvr/lib/linux64)
    set(OPENVR_LIB openvr_api)
    set(PLATFORM_LIBS pthread)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fPIC")
endif()

# Build the shared library (.dll or .so)
add_library(${DRIVER_NAME} SHARED driver_nearsec_vr.cpp)

# Link dependencies
target_link_libraries(${DRIVER_NAME} ${OPENVR_LIB} ${PLATFORM_LIBS})

# Prefix lib name adjustment for Linux so it matches what SteamVR expects
if(UNIX AND NOT APPLE)
    set_target_properties(${DRIVER_NAME} PROPERTIES PREFIX "")
endif()
