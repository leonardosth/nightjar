#pragma once

#include "frame_warp_predictor.hpp"
#include "host_http_client.hpp"
#include "stream_telemetry.hpp"
#include "tizen_audio_decoder.hpp"
#include "tizen_video_decoder.hpp"
#include "warp_gl_renderer.hpp"

#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace nightjar::tizen {

struct StreamOptions {
    std::string host_address;
    int app_id = 0;
    bool resume = false;
    uint32_t width = 3840;
    uint32_t height = 2160;
    uint32_t fps = 60;
    std::string codec = "hevc";
    uint32_t bitrate_mbps = 100;
    bool hdr = false;
    bool surround51 = false;
    bool frame_warp_enabled = true;
    bool frame_warp_lens = true;
    uint16_t frame_warp_mask_width = 1024;
    bool use_video_texture = true;
    uint32_t active_gamepad_mask = 1;
};

struct SessionEvent {
    std::string type; // "terminated" | "conn_status"
    int code = 0;
};

struct SessionStats {
    uint32_t rx_fps = 0;
    uint32_t decoded_fps = 0;
    uint32_t rendered_fps = 0;
    bool hdr_active = false;
    bool direct_scanout = false;
};

struct VideoUnitTiming {
    uint16_t host_latency_tenth_ms = 0;
    uint64_t receive_us = 0;
    uint64_t enqueue_us = 0;
};

struct TelemetrySnapshot {
    uint32_t rx_fps = 0;
    uint32_t decoded_fps = 0;
    uint32_t shown_fps = 0;
    uint32_t draw_fps = 0;
    uint32_t display_hz = 0;
    uint32_t tags_fps = 0;
    uint32_t warp_redraw_fps = 0;

    uint32_t rx_total = 0;
    uint32_t decoded_total = 0;
    uint32_t shown_total = 0;
    uint32_t net_dropped = 0;
    uint32_t skipped = 0;
    uint32_t unresolved = 0;
    uint32_t append_err = 0;
    uint32_t fill_err = 0;

    LatencySnapshot host_lat;
    LatencySnapshot net_lat;
    LatencySnapshot dec_lat;
    LatencySnapshot present_lat;

    double mbps = 0.0;
    uint32_t rtt_ms = 0;
    uint32_t rtt_var_ms = 0;
};

class NightjarSession {
public:
    explicit NightjarSession(HostHttpClient& http);
    ~NightjarSession();

    bool init_media_on_main_thread(const StreamOptions& opts, std::string& out_error);
    bool connect_on_worker_thread(std::string& out_error);
    void stop_network_on_worker();
    void shutdown_media_on_main_thread();

    // Control & media callbacks (called from moonlight-common-c threads)
    void on_stage_starting(const char* name);
    void on_stage_complete(const char* name);
    void on_stage_failed(const char* name, int error_code);
    void on_log_message(const char* msg);
    void on_connection_started();
    void on_connection_terminated(int error_code);
    void on_connection_status_update(int status);
    void on_control_packet(uint16_t msg_type, const uint8_t* payload, size_t len);
    int on_video_decode_unit(
        const uint8_t* data,
        size_t len,
        uint32_t frame_number,
        int64_t pts_us,
        bool keyframe,
        const VideoUnitTiming& timing = {});
    int on_audio_init(const AudioConfig& cfg);
    void on_audio_packet(const uint8_t* data, size_t len);

    // Input (wire-counted immediately before ENet send)
    void send_mouse_move(int16_t dx, int16_t dy);
    void send_mouse_button(uint8_t action, int button);
    void send_mouse_wheel(int8_t clicks);
    void send_controller_arrival(uint8_t controller_idx, uint16_t active_mask);
    void send_controller_packet(
        uint16_t controller_idx,
        uint16_t active_mask,
        int button_flags,
        uint8_t left_trigger,
        uint8_t right_trigger,
        int16_t lx,
        int16_t ly,
        int16_t rx,
        int16_t ry);
    void send_key(uint16_t key_code, uint8_t action, uint8_t modifiers);
    void set_frame_warp_enabled(bool enabled);

    // Called on every TV display refresh (requestAnimationFrame / 60-120 Hz)
    void on_display_refresh();

    std::vector<SessionEvent> drain_events();
    SessionStats session_stats() const;
    TelemetrySnapshot telemetry_snapshot() const;
    std::string fw_state(const frame_warp::Status& st) const;
    int host_frame_warp_version() const { return host_frame_warp_version_; }
    bool rtsp_frame_warp_control() const;
    uint32_t tags_total() const { return tags_total_.load(std::memory_order_relaxed); }
    uint32_t models_total() const { return models_total_.load(std::memory_order_relaxed); }
    uint32_t masks_total() const { return masks_total_.load(std::memory_order_relaxed); }
    int32_t tag_lead() const;
    std::string stage_summary() const;
    std::string decoder_summary() const;
    frame_warp::Status frame_warp_status() const;
    bool frame_warp_negotiated() const { return frame_warp_negotiated_.load(std::memory_order_acquire); }

private:
    uint64_t now_us() const;
    void send_frame_warp_request(bool enabled);
    void push_event(const char* type, int code);
    void tick_fps_window(uint64_t t_us);

    HostHttpClient& http_;
    StreamOptions opts_;
    int host_frame_warp_version_ = 0;
    std::shared_ptr<frame_warp::FrameWarp> warp_;
    std::unique_ptr<TizenVideoDecoder> decoder_;
    std::unique_ptr<TizenAudioDecoder> audio_decoder_;
    WarpGlRenderer renderer_;
    std::vector<uint8_t> decode_buf_;

    std::atomic<bool> running_{false};
    std::atomic<bool> frame_warp_negotiated_{false};
    std::atomic<bool> hdr_active_{false};
    uint64_t epoch_us_ = 0;

    mutable std::mutex events_mu_;
    std::deque<SessionEvent> events_;
    std::string stage_text_ = "init";
    std::string last_log_;

    std::atomic<uint32_t> rx_count_{0};
    std::atomic<uint32_t> dec_count_{0};
    std::atomic<uint32_t> shown_count_{0};
    std::atomic<uint32_t> draw_count_{0};
    std::atomic<uint32_t> refresh_count_{0};
    std::atomic<uint32_t> tags_window_{0};
    std::atomic<uint32_t> warp_redraw_count_{0};
    std::atomic<uint64_t> bytes_window_{0};

    std::atomic<uint32_t> rx_fps_{0};
    std::atomic<uint32_t> dec_fps_{0};
    std::atomic<uint32_t> ren_fps_{0};
    uint64_t last_fps_tick_us_ = 0;
    uint32_t prev_decoded_total_ = 0;

    std::atomic<uint32_t> rx_total_{0};
    std::atomic<uint32_t> shown_total_{0};
    std::atomic<uint32_t> net_dropped_total_{0};
    std::atomic<uint32_t> models_total_{0};
    std::atomic<uint32_t> tags_total_{0};
    std::atomic<uint32_t> masks_total_{0};
    std::atomic<uint32_t> fw_bad_packets_{0};

    std::mutex rx_frame_mu_;
    bool have_last_frame_ = false;
    uint32_t last_rx_frame_ = 0;

    std::atomic<bool> has_last_tag_frame_{false};
    std::atomic<uint32_t> last_tag_frame_{0};
    std::atomic<bool> has_last_shown_frame_{false};
    std::atomic<uint32_t> last_shown_frame_{0};

    LatencyWindow host_latency_;
    LatencyWindow net_latency_;
    LatencyWindow present_latency_;

    mutable std::mutex telemetry_mu_;
    TelemetrySnapshot telemetry_;
};

} // namespace nightjar::tizen
