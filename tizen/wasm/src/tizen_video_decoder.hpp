#pragma once

#include "frame_warp_predictor.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

#ifdef __EMSCRIPTEN__
#include <GLES2/gl2.h>
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
 * Hardware video decoder wrapper for Samsung Tizen WASM Player (`emscripten-1.39.4.7`).
 *
 * Uses `samsung::wasm::ElementaryMediaStreamSource` configured with:
 *   - `LatencyMode::kUltraLow`
 *   - `RenderingMode::kVideoTexture` (populates `GL_TEXTURE_EXTERNAL_OES`)
 */
class TizenVideoDecoder {
public:
    explicit TizenVideoDecoder(std::shared_ptr<frame_warp::FrameWarp> warp);
    ~TizenVideoDecoder();

    bool initialize(const VideoConfig& config);
    bool register_gl_context();
    bool submit_access_unit(const uint8_t* data, size_t size, uint32_t frame_number, int64_t pts_us, bool keyframe);

    // Requests/latches the latest decoded video frame into `target_texture` (GL_TEXTURE_EXTERNAL_OES).
    bool fill_next_frame(GLuint target_texture, uint32_t& out_frame);
    void recycle_texture(GLuint target_texture);

    void shutdown();

private:
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    VideoConfig config_;
    bool initialized_ = false;
    std::atomic<uint32_t> latest_submitted_frame_{0};
    std::atomic<uint32_t> latched_frame_{0};
    std::atomic<bool> texture_ready_{false};
    std::atomic<bool> fill_in_flight_{false};

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace nightjar::tizen
