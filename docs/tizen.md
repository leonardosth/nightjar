# Nightjar for Samsung Tizen OS 10 TV

[Nightjar docs](index.md) · [Code map](code-map.md) · [Frame Warp Protocol](protocol/frame-warp.md)

Nightjar's Tizen TV port runs on **Samsung Smart TVs with Tizen OS 10** (Chromium M130, `required_version="6.0"`) for 4K 60/120 fps low-latency streaming (100–150 Mbps) with capability-gated **Frame Warp v1** (`0x5543..0x5546`).

---

## Architecture

1. **Single-worker C++17 WASM engine (`tizen/wasm/`)**:
   - Built with Samsung's Emscripten 1.39.4.7 SDK (`TIZEN_WASM_SDK`, Tizen Sockets Extension, OpenSSL/libcurl) and pinned `moonlight-common-c` + `libopus` 1.5.2.
   - All network, mTLS pairing (with X.509 certificate pinning), RTSP, ENet control, and RSA-2048 identity generation run on a single persistent `WorkerQueue` pthread — never blocking the browser main thread.
2. **Dual hardware video pipeline (`TizenVideoDecoder` + `WarpGlRenderer`)**:
   - Uses `samsung::wasm::ElementaryMediaStreamSource` in `LatencyMode::kUltraLow`.
   - **Frame Warp path (`RenderingMode::kVideoTexture`)**: decodes HEVC (up to Level 5.2 `hev1.1.6.L156.B0` for 4K120), AV1 (`av01.0.13M.08`), or H.264 directly into a **3-slot `GL_TEXTURE_EXTERNAL_OES` `TextureRing`** so the displayed frame stays valid across 120 Hz inter-frame redraws until replaced. Monotonic PTS values are matched back to exact RTP `frameNumber`s via `HTMLMediaElement::GetCurrentTime()` + `FrameRing::lookup_nearest`.
   - **Direct scanout / HDR10 path (`RenderingMode::kMediaElement`)**: when Frame Warp is off, not offered by the host, or HDR10 (10-bit Main10) is enabled, frames go straight to the hardware `<video id="tizen-video-sink">` plane with zero shader pass and native HDR10 metadata passthrough.
3. **Low-latency Opus audio (`TizenAudioDecoder`)**:
   - Decodes stereo or 5.1 multistream Opus via `libopus` into `SampleFormat::kS16` PCM packets fed into a second `ElementaryMediaTrack` on the same `ElementaryMediaStreamSource`.
4. **10-foot TV UI (`tizen/app/`)**:
   - Localized in English (`en`) and Brazilian Portuguese (`pt-BR`), 2D spatial D-pad/gamepad focus, W3C-to-Moonlight gamepad flag mapping with active controller bitmask and idle deduplication, app library picker (launch, resume, quit), concurrent PIN pairing with cancellation, and Tizen screensaver suppression (`webapis.appcommon.setScreenSaver`).

---

## Building and Installing on Samsung S85F (Tizen OS 10)

### 1. Build the WASM engine (Docker)

```powershell
mkdir tizen\app\wasm -Force
docker build -f tizen/Dockerfile -t nightjar-tizen-wasm .
docker run --rm -v "${PWD}\tizen\app\wasm:/out" nightjar-tizen-wasm
```

### 2. Package, sign, and deploy `.wgt` via `sdb`

Enable Developer Mode on the TV (**Apps → `12345` → Developer Mode ON → enter PC IP → reboot TV**), then run:

```powershell
.\tizen\build-wgt.ps1 -Profile <YOUR_TIZEN_PROFILE> -TvIp <TV_IP>
```

---

## 4K 60/120 fps Validation Checklist (S85F)

1. Enable **Performance Overlay** in **Settings**.
2. Start a 4K 60 fps @ 100 Mbps HEVC stream and verify `FPS (Rx/Dec/Ren)` shows `60 / 60 / 120` during camera motion with `Frame Warp: LOCKED (Active)` and `untagged` staying near `0`.
3. Raise to 4K 120 fps @ 100–150 Mbps (HEVC and AV1) and confirm `Dec` keeps up with `Rx`. If `Dec` falls behind `Rx` in `kVideoTexture` mode at 4K120, test 4K60 + Frame Warp (120 Hz inter-frame redraws) vs 4K120 direct scanout (`Frame Warp: OFF`).

---

## Troubleshooting

- **Install error `[118]`**: Regenerate your Samsung Distributor Certificate tied to the TV's DUID in Tizen Studio Certificate Manager, then re-run `build-wgt.ps1`.
- **Pairing rejected or hangs**: Ensure no other pairing dialog is open on the host; click **Cancel** on the TV to send `/unpair` and retry.
