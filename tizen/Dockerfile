# Builds Nightjar's Samsung Tizen OS 10 WASM streaming & Frame Warp engine
# Uses Samsung's official Emscripten 1.39.4.7 SDK (Tizen WASM Player + Tizen Sockets + OpenSSL/cURL ports).
#
# Usage:
#   docker build -f tizen/Dockerfile -t nightjar-tizen-wasm .
#   docker run --rm -v "${PWD}/tizen/app/wasm:/out" nightjar-tizen-wasm
FROM ubuntu:22.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y \
    ca-certificates \
    cmake \
    git \
    ninja-build \
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

WORKDIR /src
COPY tizen/wasm /src/wasm

RUN mkdir -p /src/build /src/app/wasm && \
    cmake \
      -DCMAKE_TOOLCHAIN_FILE=/opt/emscripten-release-bundle/emsdk/fastcomp/emscripten/cmake/Modules/Platform/Emscripten.cmake \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DTIZEN_WASM_SDK=ON \
      -DENABLE_MOONLIGHT_TRANSPORT=ON \
      -S /src/wasm \
      -B /src/build && \
    cmake --build /src/build

FROM alpine:3.20
COPY --from=builder /src/app/wasm /wasm
CMD ["sh", "-c", "cp -rv /wasm/* /out/"]
