# Builds Nightjar's Samsung Tizen OS 10 WASM streaming & Frame Warp engine
# Includes moonlight-common-c (patched with Frame Warp v1 0x5543..=0x5546 hooks),
# OpenSSL + libcurl (mTLS pairing & /serverinfo), and Tizen WASM Player (kVideoTexture).
#
# Usage:
#   docker build -f tizen/Dockerfile -t nightjar-tizen-wasm .
#   docker run --rm -v "${PWD}/tizen/app/wasm:/out" nightjar-tizen-wasm
FROM ghcr.io/oneliberty/moonlight-chrome-tizen:samsung_wasm AS builder

WORKDIR /src
COPY tizen/wasm /src/wasm

RUN mkdir -p /src/build /src/app/wasm && cd /src/build && \
    emcmake cmake -GNinja \
        -DCMAKE_BUILD_TYPE=Release \
        -DTIZEN_WASM_SDK=ON \
        -DENABLE_MOONLIGHT_TRANSPORT=ON \
        /src/wasm && \
    ninja

FROM alpine:3.20
COPY --from=builder /src/app/wasm /wasm
CMD ["sh", "-c", "cp -rv /wasm/* /out/"]
