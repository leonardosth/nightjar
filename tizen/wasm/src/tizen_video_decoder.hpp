#pragma once

#include "frame_warp_predictor.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
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
    uint32_t fps = 60;
    bool hdr10 = false;
    bool use_video_texture = true;
    std::function<void()> on_need_idr;
    // Invoked on the main thread when EMSS transitions kDetached -> kClosed (safe to call AddTrack).
    std::function<void(void* emss_source_ptr)> on_source_ready_for_tracks;
};

/**
 * 3-slot texture lifecycle ring for `RenderingMode::kVideoTexture`.
 * Guarantees that the texture currently displayed by WebGL (including 120 Hz inter-frame
 * Frame Warp redraws) is never recycled back to the hardware decoder until replaced, and
 * guards async callbacks with a monotonic generation counter.
 */
class TextureRing {
public:
    enum class SlotState { Free, Filling, Ready, Displaying };

    void init(std::array<GLuint, 3> textures);
    void reset();
    uint64_t generation() const;

    // Picks a Free slot to pass to FillTextureWithNextFrame (at most one fill in flight).
    std::optional<size_t> acquire_for_fill();
    GLuint texture_at(size_t slot) const { return slots_[slot].tex; }

    // Marks slot Ready; if an unconsumed Ready slot existed, frees it and returns its texture in out_superseded.
    void mark_filled(
        size_t slot,
        uint32_t frame_number,
        std::optional<GLuint>& out_superseded,
        std::optional<uint64_t> expected_gen = std::nullopt,
        bool is_tagged = true);
    void mark_filled(size_t slot, uint32_t frame_number) {
        std::optional<GLuint> ignored;
        mark_filled(slot, frame_number, ignored, std::nullopt, true);
    }
    void mark_fill_aborted(size_t slot, std::optional<uint64_t> expected_gen = std::nullopt);

    // Promotes Ready -> Displaying, returning the previous Displaying texture to RecycleTexture().
    bool swap_to_display(uint32_t& out_frame, std::optional<GLuint>& out_recycle, bool* out_tagged = nullptr);
    GLuint current_display_texture() const;

private:
    struct Slot {
        GLuint tex = 0;
        SlotState state = SlotState::Free;
        uint32_t frame_number = 0;
        bool is_tagged = true;
    };
    mutable std::mutex mu_;
    std::array<Slot, 3> slots_{};
    std::optional<size_t> displaying_;
    std::optional<size_t> ready_;
    bool filling_in_flight_ = false;
    uint64_t generation_ = 1;
};

/**
 * Hardware video decoder wrapper for Samsung Tizen WASM Player (`emscripten-1.39.4.7`).
 */
class TizenVideoDecoder {
public:
    explicit TizenVideoDecoder(std::shared_ptr<frame_warp::FrameWarp> warp);
    ~TizenVideoDecoder();

    // Creates EMSS and adds the video track (does NOT call source->Open() yet so caller can add audio track first).
    bool initialize(const VideoConfig& config, std::string* out_error = nullptr);
    // Opens the EMSS after all tracks (video + audio) have been added on the main thread.
    void open_source();
    bool register_gl_context();
    void attach_texture_ring(std::array<GLuint, 3> textures);
    bool submit_access_unit(const uint8_t* data, size_t size, uint32_t frame_number, int64_t pts_us, bool keyframe);

    // Drives async FillTextureWithNextFrame into a Free slot and promotes Ready frames.
    // Sets `out_tagged = false` when GetCurrentTime() could not match a FrameRing entry within tolerance.
    bool poll_next_frame(GLuint& out_tex, uint32_t& out_frame, bool& out_tagged);
    GLuint current_display_texture() const { return ring_.current_display_texture(); }

    void* emss_source() const;
    bool is_direct_scanout() const { return !config_.use_video_texture; }

    void shutdown();

private:
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    VideoConfig config_;
    bool initialized_ = false;
    uint64_t submitted_packets_ = 0;
    std::shared_ptr<std::atomic<bool>> alive_ = std::make_shared<std::atomic<bool>>(true);
    TextureRing ring_;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace nightjar::tizen
