#pragma once

#include "frame_warp_predictor.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

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
    uint32_t fps = 60;
    bool hdr10 = false;
    bool use_video_texture = true;
    std::function<void()> on_need_idr;
};

/**
 * 3-slot texture lifecycle ring for `RenderingMode::kVideoTexture`.
 * Guarantees that the texture currently displayed by WebGL (including 120 Hz inter-frame
 * Frame Warp redraws) is never recycled back to the hardware decoder until a newer decoded
 * frame replaces it.
 */
class TextureRing {
public:
    enum class SlotState { Free, Filling, Ready, Displaying };

    void init(std::array<GLuint, 3> textures);
    void reset();

    // Picks a Free slot to pass to FillTextureWithNextFrame (at most one fill in flight).
    std::optional<size_t> acquire_for_fill();
    GLuint texture_at(size_t slot) const { return slots_[slot].tex; }
    void mark_filled(size_t slot, uint32_t frame_number);
    void mark_fill_aborted(size_t slot);

    // Promotes Ready -> Displaying, returning the previous Displaying texture to RecycleTexture().
    bool swap_to_display(uint32_t& out_frame, std::optional<GLuint>& out_recycle);
    GLuint current_display_texture() const;

private:
    struct Slot {
        GLuint tex = 0;
        SlotState state = SlotState::Free;
        uint32_t frame_number = 0;
    };
    mutable std::mutex mu_;
    std::array<Slot, 3> slots_{};
    std::optional<size_t> displaying_;
    std::optional<size_t> ready_;
    bool filling_in_flight_ = false;
};

/**
 * Hardware video decoder wrapper for Samsung Tizen WASM Player (`emscripten-1.39.4.7`).
 *
 * Uses `samsung::wasm::ElementaryMediaStreamSource` with `LatencyMode::kUltraLow`:
 *  - `RenderingMode::kVideoTexture` when Frame Warp is active (3-slot GL_TEXTURE_EXTERNAL_OES ring)
 *  - `RenderingMode::kMediaElement` when direct hardware scanout / HDR10 passthrough is active
 */
class TizenVideoDecoder {
public:
    explicit TizenVideoDecoder(std::shared_ptr<frame_warp::FrameWarp> warp);
    ~TizenVideoDecoder();

    bool initialize(const VideoConfig& config);
    bool register_gl_context();
    void attach_texture_ring(std::array<GLuint, 3> textures);
    bool submit_access_unit(const uint8_t* data, size_t size, uint32_t frame_number, int64_t pts_us, bool keyframe);

    // Drives asynchronous FillTextureWithNextFrame into a free slot and promotes ready frames.
    bool poll_next_frame(GLuint& out_tex, uint32_t& out_frame);
    GLuint current_display_texture() const { return ring_.current_display_texture(); }

    void* emss_source() const;
    bool is_direct_scanout() const { return !config_.use_video_texture; }

    void shutdown();

private:
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    VideoConfig config_;
    bool initialized_ = false;
    uint64_t submitted_packets_ = 0;
    int64_t last_pts_us_ = -1;
    std::atomic<uint32_t> latest_submitted_frame_{0};

    std::mutex pending_mu_;
    std::deque<std::pair<int64_t, uint32_t>> pending_frames_;
    TextureRing ring_;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace nightjar::tizen
