#pragma once

#include "frame_warp_predictor.hpp"
#include "host_http_client.hpp"
#include "tizen_video_decoder.hpp"
#include "warp_gl_renderer.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

namespace nightjar::tizen {

struct StreamOptions {
    std::string host_address;
    int app_id = 0;
    bool resume = false;
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
 * Coordinates the Nightjar Tizen streaming session over moonlight-common-c + Tizen Sockets:
 *  - Probes /serverinfo (<FrameWarpVersion>), launches/resumes app over mTLS HTTPS
 *  - Starts RTSP + ENet (SS_ENC_CONTROL_V2) + RTP/FEC video & audio via LiStartConnection
 *  - Detects 0x5543 on RTSP a=x-rl-control and sends 0x5543 FrameWarpRequest on connect
 *  - Dispatches 0x5544 (Model), 0x5545 (Tags), 0x5546 (Mask) directly into FrameWarp
 *  - Wire-counts relative mouse & controller packets right before LiSend* calls
 *  - Drives TizenVideoDecoder (kVideoTexture) -> WarpGlRenderer on every TV display refresh
 */
class NightjarSession {
public:
    explicit NightjarSession(HostHttpClient& http);
    ~NightjarSession();

    bool start(const StreamOptions& opts, std::string& out_error);
    void stop();

    // Control stream hooks (called from moonlight-common-c control thread)
    void on_connection_started();
    void on_control_packet(uint16_t msg_type, const uint8_t* payload, size_t len);
    int on_video_decode_unit(const uint8_t* data, size_t len, uint32_t frame_number, int64_t pts_us, bool keyframe);
    void on_audio_packet(const uint8_t* data, size_t len);

    // Input (wire-counted immediately before ENet send)
    void send_mouse_move(int16_t dx, int16_t dy);
    void send_mouse_button(uint8_t action, int button);
    void send_controller_packet(
        uint16_t controller_idx,
        int button_flags,
        uint8_t left_trigger,
        uint8_t right_trigger,
        int16_t lx,
        int16_t ly,
        int16_t rx,
        int16_t ry);
    void send_key(int16_t key_code, uint8_t action, uint8_t modifiers);
    void set_frame_warp_enabled(bool enabled);

    // Called on every TV display refresh (requestAnimationFrame / 60-144 Hz)
    void on_display_refresh();

    frame_warp::Status frame_warp_status() const;
    bool frame_warp_negotiated() const { return frame_warp_negotiated_.load(std::memory_order_acquire); }

private:
    uint64_t now_us() const;
    void send_frame_warp_request(bool enabled);

    HostHttpClient& http_;
    StreamOptions opts_;
    int host_frame_warp_version_ = 0;
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    std::unique_ptr<TizenVideoDecoder> decoder_;
    WarpGlRenderer renderer_;
    std::atomic<bool> running_{false};
    std::atomic<bool> frame_warp_negotiated_{false};
    uint64_t epoch_us_ = 0;
};

} // namespace nightjar::tizen
