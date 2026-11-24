#pragma once

#include "frame_warp_predictor.hpp"

#include <cstdint>
#include <memory>
#include <string>

#ifdef __EMSCRIPTEN__
#include <GLES3/gl3.h>
#else
using GLuint = unsigned int;
#endif

namespace nightjar::tizen {

struct VideoConfig {
    std::string codec = "hevc"; // "h264", "hevc", "av1"
    uint32_t width = 3840;
    uint32_t height = 2160;
    uint32_t fps = 120;
};

/**
 * Hardware video decoder wrapper for Samsung Tizen OS 10 WASM Player.
 *
 * Uses `samsung::wasm::ElementaryMediaStreamSource` configured with:
 *   - `LatencyMode::kUltraLow` (bypasses VOD buffering for game streaming)
 *   - `RenderingMode::kVideoTexture` (decodes directly into a WebGL2/GLES3 GPU texture)
 *
 * Every submitted elementary packet records `(pts_us -> rtp_frame_number)` in
 * `FrameWarp::note_frame_pts`, so when `fill_next_frame()` populates the GL texture
 * we immediately recover the exact frame number for Frame Warp tag lookup.
 */
class TizenVideoDecoder {
public:
    explicit TizenVideoDecoder(std::shared_ptr<frame_warp::FrameWarp> warp);
    ~TizenVideoDecoder();

    bool initialize(const VideoConfig& config);
    bool register_gl_context();
    bool submit_access_unit(const uint8_t* data, size_t size, uint32_t frame_number, int64_t pts_us, bool keyframe);

    // Populates `target_texture` with the latest hardware-decoded frame (zero-copy on Tizen).
    // Returns true if a new frame was latched, writing its RTP frame number into `out_frame`.
    bool fill_next_frame(GLuint target_texture, uint32_t& out_frame);

    void shutdown();

private:
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    VideoConfig config_;
    bool initialized_ = false;
    uint32_t last_frame_number_ = 0;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace nightjar::tizen
