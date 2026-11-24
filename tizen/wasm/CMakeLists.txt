cmake_minimum_required(VERSION 3.10)
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
    option(TIZEN_WASM_SDK "Enable Samsung Tizen WASM Player (kVideoTexture) & Sockets Extension" ON)
    option(ENABLE_MOONLIGHT_TRANSPORT "Link pre-fetched moonlight-common-c with Frame Warp v1 hooks" ON)
    set(MOONLIGHT_COMMON_C_DIR "/opt/moonlight-common-c" CACHE PATH "Path to patched moonlight-common-c")

    add_compile_options(-w -s WASM=1 -Os -DSAMSUNG_WRT -DOS_WASM -DNDEBUG)

    set(NIGHTJAR_WASM_LIBS nightjar_frame_warp)
    set(NIGHTJAR_WASM_DEFS NIGHTJAR_HAVE_CURL_OPENSSL=1)

    if(TIZEN_WASM_SDK)
        list(APPEND NIGHTJAR_WASM_DEFS TIZEN_WASM_SDK=1)
    endif()

    if(ENABLE_MOONLIGHT_TRANSPORT AND EXISTS "${MOONLIGHT_COMMON_C_DIR}/src/Limelight.h")
        set(ML_DIR "${MOONLIGHT_COMMON_C_DIR}")

        file(GLOB ML_RS_SOURCES "${ML_DIR}/reedsolomon/*.c")
        add_library(moonlight_rs STATIC ${ML_RS_SOURCES})
        target_include_directories(moonlight_rs PUBLIC "${ML_DIR}/reedsolomon")
        target_compile_features(moonlight_rs PUBLIC c_std_99)

        add_library(moonlight_enet STATIC
            "${ML_DIR}/enet/callbacks.c"
            "${ML_DIR}/enet/compress.c"
            "${ML_DIR}/enet/host.c"
            "${ML_DIR}/enet/list.c"
            "${ML_DIR}/enet/packet.c"
            "${ML_DIR}/enet/peer.c"
            "${ML_DIR}/enet/protocol.c"
            "${ML_DIR}/enet/unix.c"
        )
        target_compile_definitions(moonlight_enet PUBLIC
            LC_CHROME
            HAS_SOCKLEN_T=1
            HAS_FCNTL=1
            NO_MSGAPI=1
        )
        target_include_directories(moonlight_enet PUBLIC "${ML_DIR}/enet/include")

        file(GLOB ML_CORE_SOURCES "${ML_DIR}/src/*.c")
        add_library(moonlight_common_c STATIC ${ML_CORE_SOURCES})
        target_compile_definitions(moonlight_common_c PUBLIC LC_CHROME)
        target_include_directories(moonlight_common_c PUBLIC
            "${ML_DIR}/src"
            "${ML_DIR}/enet/include"
            "${ML_DIR}/reedsolomon"
        )
        target_compile_features(moonlight_common_c PUBLIC c_std_99)
        set_target_properties(moonlight_common_c PROPERTIES
            COMPILE_FLAGS "-s USE_CRYPTO=1 -s USE_SSL=1"
        )

        list(APPEND NIGHTJAR_WASM_LIBS moonlight_common_c moonlight_enet moonlight_rs)
        list(APPEND NIGHTJAR_WASM_DEFS NIGHTJAR_HAVE_MOONLIGHT=1)
    endif()

    add_executable(nightjar_tizen
        src/libchelper.c
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
        COMPILE_FLAGS "-pthread -s USE_CRYPTO=1 -s USE_SSL=1 -s USE_CURL=1"
    )

    set(EM_LINK_FLAGS
        "--bind"
        "-pthread"
        "-Os"
        "-s TOTAL_MEMORY=134217728"
        "-s TOTAL_STACK=16777216"
        "-s NO_EXIT_RUNTIME=1"
        "-s USE_PTHREADS=1"
        "-s PTHREAD_POOL_SIZE=12"
        "-s WASM=1"
        "-s MODULARIZE=1"
        "-s EXPORT_NAME=NightjarWasmModule"
        "-s USE_CRYPTO=1"
        "-s USE_SSL=1"
        "-s USE_CURL=1"
    )
    if(TIZEN_WASM_SDK)
        list(APPEND EM_LINK_FLAGS "-s ENVIRONMENT_MAY_BE_TIZEN")
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
