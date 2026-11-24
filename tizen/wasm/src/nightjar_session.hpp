#pragma once

#include "frame_warp_predictor.hpp"
#include "tizen_video_decoder.hpp"
#include "warp_gl_renderer.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

namespace nightjar::tizen {

struct StreamOptions {
    std::string host_address;
    uint32_t width = 3840;
    uint32_t height = 2160;
    uint32_t fps = 120;
    std::string codec = "hevc";
    uint32_t bitrate_mbps = 100;
    bool frame_warp_enabled = true;
    bool frame_warp_lens = true;
    uint16_t frame_warp_mask_width = 1024;
};

/**
 * Coordinates the Nightjar Tizen streaming session:
 *  - Advertises & negotiates Frame Warp v1 (<FrameWarpVersion>1 in /serverinfo,
 *    0x5543..0x5546 in RTSP DESCRIBE a=x-rl-control)
 *  - Dispatches encrypted ENet control packets (0x5544 Model, 0x5545 Tags, 0x5546 Mask)
 *    directly into FrameWarp
 *  - Wire-counts relative mouse & controller packets immediately before ENet send
 *  - Drives TizenVideoDecoder (kVideoTexture) -> WarpGlRenderer on every display refresh
 */
class NightjarSession {
public:
    NightjarSession();
    ~NightjarSession();

    bool start(const StreamOptions& opts);
    void stop();

    // Called from control thread on SS_ENC_CONTROL_V2 receive
    void on_control_packet(uint16_t msg_type, const uint8_t* payload, size_t len);

    // Called at wire-emit time (right before sending 0x0206 input packet over ENet)
    void send_mouse_move(int16_t dx, int16_t dy);
    void send_controller_packet(uint16_t controller_idx, int16_t rx, int16_t ry);

    // Called on every TV display refresh (requestAnimationFrame / 60-144 Hz)
    void on_display_refresh();

    frame_warp::Status frame_warp_status() const;

private:
    uint64_t now_us() const;

    StreamOptions opts_;
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    std::unique_ptr<TizenVideoDecoder> decoder_;
    WarpGlRenderer renderer_;
    std::atomic<bool> running_{false};
    uint64_t epoch_us_ = 0;
};

} // namespace nightjar::tizen
