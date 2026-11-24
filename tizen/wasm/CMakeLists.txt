cmake_minimum_required(VERSION 3.16)
project(nightjar_tizen_wasm LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Portable Frame Warp v1 core (compiles both natively for unit tests and under Samsung Emscripten SDK)
add_library(nightjar_frame_warp STATIC
    src/frame_warp_protocol.cpp
    src/frame_warp_predictor.cpp
)
target_include_directories(nightjar_frame_warp PUBLIC src)

if(EMSCRIPTEN)
    include(FetchContent)
    find_package(Python3 REQUIRED COMPONENTS Interpreter)

    option(TIZEN_WASM_SDK "Enable Samsung Tizen WASM Player (kVideoTexture) & Sockets Extension" ON)
    option(ENABLE_MOONLIGHT_TRANSPORT "Fetch and link moonlight-common-c with Frame Warp v1 hooks" ON)

    set(NIGHTJAR_WASM_LIBS nightjar_frame_warp)
    set(NIGHTJAR_WASM_DEFS "")

    if(TIZEN_WASM_SDK)
        list(APPEND NIGHTJAR_WASM_DEFS TIZEN_WASM_SDK=1)
    endif()

    if(ENABLE_MOONLIGHT_TRANSPORT)
        FetchContent_Declare(
            moonlight_common_c
            GIT_REPOSITORY https://github.com/moonlight-stream/moonlight-common-c.git
            GIT_TAG        master
            GIT_SHALLOW    TRUE
            GIT_SUBMODULES_RECURSE TRUE
        )
        FetchContent_Populate(moonlight_common_c)

        execute_process(
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/patch_moonlight_frame_warp.py" "${moonlight_common_c_SOURCE_DIR}"
            RESULT_VARIABLE PATCH_RES
        )
        if(NOT PATCH_RES EQUAL 0)
            message(FATAL_ERROR "Failed to patch moonlight-common-c with Frame Warp v1 hooks")
        endif()

        set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
        add_subdirectory("${moonlight_common_c_SOURCE_DIR}" "${moonlight_common_c_BINARY_DIR}")
        list(APPEND NIGHTJAR_WASM_LIBS moonlight-common-c)
        list(APPEND NIGHTJAR_WASM_DEFS NIGHTJAR_HAVE_MOONLIGHT=1)
    endif()

    find_package(OpenSSL QUIET)
    find_package(CURL QUIET)
    if(OpenSSL_FOUND AND CURL_FOUND)
        list(APPEND NIGHTJAR_WASM_LIBS OpenSSL::SSL OpenSSL::Crypto CURL::libcurl)
        list(APPEND NIGHTJAR_WASM_DEFS NIGHTJAR_HAVE_CURL_OPENSSL=1)
    else()
        message(STATUS "OpenSSL or libcurl not found in sysroot; HostHttpClient will build in stub mode")
    endif()

    add_executable(nightjar_tizen
        src/host_http_client.cpp
        src/tizen_video_decoder.cpp
        src/warp_gl_renderer.cpp
        src/nightjar_session.cpp
        src/main.cpp
    )
    target_link_libraries(nightjar_tizen PRIVATE ${NIGHTJAR_WASM_LIBS})
    target_compile_definitions(nightjar_tizen PRIVATE ${NIGHTJAR_WASM_DEFS})

    set_target_properties(nightjar_tizen PROPERTIES
        SUFFIX ".js"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../app/wasm"
    )

    target_compile_options(nightjar_tizen PRIVATE
        -O3
        -pthread
        -fno-rtti
    )

    set(EM_LINK_FLAGS
        "-O3"
        "-pthread"
        "-s USE_PTHREADS=1"
        "-s PTHREAD_POOL_SIZE=8"
        "-s PROXY_TO_PTHREAD=1"
        "-s USE_WEBGL2=1"
        "-s FULL_ES3=1"
        "-s ALLOW_MEMORY_GROWTH=1"
        "-s INITIAL_MEMORY=67108864"
        "-s MODULARIZE=1"
        "-s EXPORT_NAME=NightjarWasmModule"
        "--bind"
    )
    if(TIZEN_WASM_SDK)
        list(APPEND EM_LINK_FLAGS
            "-s ENVIRONMENT_MAY_BE_TIZEN=1"
            "-s WEBSOCKET_SUBPROTOCOL=binary"
        )
    endif()
    string(JOIN " " EM_LINK_FLAGS_STR ${EM_LINK_FLAGS})
    set_target_properties(nightjar_tizen PROPERTIES LINK_FLAGS "${EM_LINK_FLAGS_STR}")
else()
    enable_testing()
    add_executable(frame_warp_cpp_test
        src/host_http_client.cpp
        tests/frame_warp_test.cpp
    )
    target_link_libraries(frame_warp_cpp_test PRIVATE nightjar_frame_warp)
    add_test(NAME frame_warp_cpp_test COMMAND frame_warp_cpp_test)
endif()
