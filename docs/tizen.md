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
   - **Frame Warp path (`RenderingMode::kVideoTexture`)**: decodes HEVC (up to Level 5.2 `hev1.1.6.L156.B0` for 4K120), AV1 (`av01.0.13M.08`), or H.264 directly into a **3-slot `GL_TEXTURE_EXTERNAL_OES` `TextureRing`** with chained `FillTextureWithNextFrame` calls so decoded frames never stall behind `requestAnimationFrame`. Frames are matched back to RTP `frameNumber`s via `HTMLMediaElement::GetCurrentTime()` + `FrameRing::lookup_nearest` with `PendingFrameQueue` FIFO fallback, keeping the displayed frame valid across 120 Hz inter-frame redraws until replaced.
   - **Direct scanout / HDR10 path (`RenderingMode::kMediaElement`)**: when Frame Warp is off, not offered by the host, or HDR10 (10-bit Main10) is enabled, frames go straight to the hardware `<video id="tizen-video-sink">` plane with zero shader pass and native HDR10 metadata passthrough. HDR10 and Frame Warp are mutually exclusive because Tizen's WebGL 1.0 `kVideoTexture` canvas is an 8-bit SDR surface (`fwState: hdr-direct` when HDR10 is active).
3. **Low-latency Opus audio (`TizenAudioDecoder`)**:
   - Decodes stereo or 5.1 multistream Opus via `libopus` into `SampleFormat::kS16` PCM packets fed into a second `ElementaryMediaTrack` on the same `ElementaryMediaStreamSource`.
4. **10-foot TV UI & Controls (`tizen/app/`)**:
   - Localized in English (`en`) and Brazilian Portuguese (`pt-BR`), 1-click **Quick Start / Resume** Continue card, inline horizontal PC & App rows, compacted W3C-to-Moonlight controller slots (`assignControllerSlots`) with edge-triggered A/B navigation (`NavRepeat`), Xbox **Hold Start (650 ms)** Mouse Mode (Left Stick cursor, A/RT left-click, B/LT right-click, X middle-click, D-Pad/Right Stick scroll), concurrent PIN pairing with cancellation, and Tizen screensaver suppression (`webapis.appcommon.setScreenSaver`).

---

## Building and Installing on Samsung S85F (Tizen OS 10)

### 1. Build the WASM engine (Docker or GitHub Actions)

```powershell
mkdir tizen\app\wasm -Force
docker build -f tizen/Dockerfile -t nightjar-tizen-wasm .
docker run --rm -v "${PWD}\tizen\app\wasm:/out" nightjar-tizen-wasm
```

### 2. Package, sign, and deploy `.wgt` via `sdb`

Enable Developer Mode on the TV (**Apps → `12345` → Developer Mode ON → enter PC IP → reboot TV**), then run:

```powershell
.\tizen\build-wgt.ps1 -FetchLatestWasm -Profile <YOUR_TIZEN_PROFILE> -TvIp <TV_IP>
```

---

## Performance Overlay & Frame Warp Diagnostics (S85F)

1. Enable **Performance Overlay** in **Settings** (or via the in-stream menu).
2. Read the live telemetry rows:
   - **FPS**: `rx` (received from host) · `dec` (hardware decoded) · `screen` (new decoded frames shown) · `drawn` (WebGL draws including inter-frame Frame Warp redraws) · `Hz` (TV `requestAnimationFrame` refresh rate).
   - **Totals**: `rx` · `screen` · `net lost` (RTP frame gaps) · `TV skipped` (unconsumed `Ready` frames overwritten) · `no id` (frames decoded without a pending queue entry).
   - **Host encode / Network / TV decode / Queue → screen**: `min / avg / max ms` per 1 s rolling window, plus ENet RTT (`±var`) and bitrate (`Mbps`). In direct video mode, `TV decode` shows `getVideoPlaybackQuality()` totals/drops when available.
   - **Frame Warp state**: `direct`, `off`, `connecting`, `host-no-fw`, `rtsp-no-fw` (host did not offer `0x5543` in RTSP), `request-failed`, `waiting-model`, `learning`, or `active` (`LOCKED`).
   - **FW tags**: `tags/s`, `lead` (`last_tag_frame - last_shown_frame`), `model` generation + `M/S` lock flags, and host `lag ms`.
3. For perceptible between-frame smoothness with Frame Warp, verify `Hz` is `120` (on a 60 Hz output, between-frame redraws have no intermediate refresh to fill; 120 fps stream + 120 Hz panel gives the lowest latency).

---

## Troubleshooting

- **Install error `[118]`**: Regenerate your Samsung Distributor Certificate tied to the TV's DUID in Tizen Studio Certificate Manager, then re-run `build-wgt.ps1`.
- **Pairing rejected or hangs**: Ensure no other pairing dialog is open on the host; click **Cancel** on the TV to send `/unpair` and retry.
