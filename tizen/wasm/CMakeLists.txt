cmake_minimum_required(VERSION 3.16)
project(nightjar_tizen_wasm LANGUAGES CXX)

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
    option(TIZEN_WASM_SDK "Enable Samsung Tizen WASM Player (kVideoTexture) & Sockets Extension" ON)

    add_executable(nightjar_tizen
        src/tizen_video_decoder.cpp
        src/warp_gl_renderer.cpp
        src/nightjar_session.cpp
        src/main.cpp
    )
    target_link_libraries(nightjar_tizen PRIVATE nightjar_frame_warp)

    set_target_properties(nightjar_tizen PROPERTIES
        SUFFIX ".js"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../app/wasm"
    )

    target_compile_options(nightjar_tizen PRIVATE
        -O3
        -pthread
        -fno-rtti
    )

    if(TIZEN_WASM_SDK)
        target_compile_definitions(nightjar_tizen PRIVATE TIZEN_WASM_SDK=1)
    endif()

    set(EM_LINK_FLAGS
        "-O3"
        "-pthread"
        "-s USE_PTHREADS=1"
        "-s PTHREAD_POOL_SIZE=6"
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
    add_executable(frame_warp_cpp_test tests/frame_warp_test.cpp)
    target_link_libraries(frame_warp_cpp_test PRIVATE nightjar_frame_warp)
    add_test(NAME frame_warp_cpp_test COMMAND frame_warp_cpp_test)
endif()
