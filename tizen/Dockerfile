# Builds Nightjar's Samsung Tizen OS 10 WASM streaming & Frame Warp engine
# Uses Samsung's official Emscripten 1.39.4.7 SDK (Tizen WASM Player + Tizen Sockets + OpenSSL/cURL ports).
FROM ubuntu:22.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Pinned upstream revisions for reproducible builds
ARG MOONLIGHT_COMMON_C_SHA=b4ee1cea3d19e13c0b37c26585e6b1ee174effcb
ARG OPUS_VERSION_TAG=v1.5.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    git \
    ninja-build \
    nodejs \
    python2 \
    python3 \
    unzip \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python2 /usr/bin/python

WORKDIR /opt
RUN wget -nv -O emscripten-1.39.4.7-linux64.zip 'https://developer.samsung.com/smarttv/file/a5013a65-af11-4b59-844f-2d34f14d19a9' \
    && unzip -q emscripten-1.39.4.7-linux64.zip \
    && rm -f emscripten-1.39.4.7-linux64.zip \
    && cd /opt/emscripten-release-bundle/emsdk \
    && ./emsdk activate latest-fastcomp

RUN mkdir -p /opt/moonlight-common-c \
    && cd /opt/moonlight-common-c \
    && git init \
    && git remote add origin https://github.com/moonlight-stream/moonlight-common-c.git \
    && git fetch --depth 1 origin "${MOONLIGHT_COMMON_C_SHA}" \
    && git checkout FETCH_HEAD \
    && git submodule update --init --recursive --depth 1

RUN git clone --depth 1 --branch "${OPUS_VERSION_TAG}" https://github.com/xiph/opus.git /opt/opus-src \
    && cmake \
      -DCMAKE_TOOLCHAIN_FILE=/opt/emscripten-release-bundle/emsdk/fastcomp/emscripten/cmake/Modules/Platform/Emscripten.cmake \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_FLAGS="-O3 -s WASM=1 -pthread" \
      -DOPUS_BUILD_PROGRAMS=OFF \
      -DOPUS_BUILD_TESTING=OFF \
      -DOPUS_BUILD_SHARED_LIBRARY=OFF \
      -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF \
      -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF \
      -DCMAKE_INSTALL_PREFIX=/opt/opus \
      -S /opt/opus-src \
      -B /opt/opus-build \
    && cmake --build /opt/opus-build \
    && cmake --install /opt/opus-build

WORKDIR /src
COPY tizen/wasm /src/wasm

RUN python3 /src/wasm/scripts/patch_moonlight_frame_warp.py /opt/moonlight-common-c && \
    mkdir -p /src/build /src/app/wasm && \
    cmake \
      -DCMAKE_TOOLCHAIN_FILE=/opt/emscripten-release-bundle/emsdk/fastcomp/emscripten/cmake/Modules/Platform/Emscripten.cmake \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DTIZEN_WASM_SDK=ON \
      -DENABLE_MOONLIGHT_TRANSPORT=ON \
      -DMOONLIGHT_COMMON_C_DIR=/opt/moonlight-common-c \
      -DOPUS_PREFIX=/opt/opus \
      -S /src/wasm \
      -B /src/build && \
    cmake --build /src/build

FROM alpine:3.20
COPY --from=builder /src/app/wasm /wasm
CMD ["sh", "-c", "cp -rv /wasm/* /out/"]
