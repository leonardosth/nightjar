#include "nightjar_session.hpp"

#include <chrono>

namespace nightjar::tizen {

namespace {

uint64_t steady_now_us() {
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
}

} // namespace

NightjarSession::NightjarSession() = default;
NightjarSession::~NightjarSession() { stop(); }

uint64_t NightjarSession::now_us() const {
    uint64_t now = steady_now_us();
    return now >= epoch_us_ ? (now - epoch_us_) : 0;
}

bool NightjarSession::start(const StreamOptions& opts) {
    stop();
    opts_ = opts;
    epoch_us_ = steady_now_us();

    warp_ = std::make_shared<frame_warp::FrameWarp>(
        std::optional<uint8_t>(0),
        opts.frame_warp_mask_width
    );
    (void)warp_->request(opts.frame_warp_enabled, opts.frame_warp_lens);

    if (!renderer_.init(static_cast<int>(opts.width), static_cast<int>(opts.height))) {
        return false;
    }

    decoder_ = std::make_unique<TizenVideoDecoder>(warp_);
    VideoConfig vcfg;
    vcfg.codec = opts.codec;
    vcfg.width = opts.width;
    vcfg.height = opts.height;
    vcfg.fps = opts.fps;
    if (!decoder_->initialize(vcfg)) {
        return false;
    }
    decoder_->register_gl_context();

    running_.store(true, std::memory_order_release);
    return true;
}

void NightjarSession::stop() {
    running_.store(false, std::memory_order_release);
    if (decoder_) {
        decoder_->shutdown();
        decoder_.reset();
    }
    renderer_.destroy();
    warp_.reset();
}

void NightjarSession::on_control_packet(uint16_t msg_type, const uint8_t* payload, size_t len) {
    if (!warp_ || !payload) return;
    switch (msg_type) {
        case frame_warp::kMsgModel:
            if (auto m = frame_warp::Model::decode(payload, len)) {
                warp_->on_model(*m);
            }
            break;
        case frame_warp::kMsgTags:
            if (auto t = frame_warp::Tags::decode(payload, len)) {
                warp_->on_tags(*t, now_us());
            }
            break;
        case frame_warp::kMsgMask:
            if (auto mask = frame_warp::Mask::decode(payload, len)) {
                warp_->on_mask(std::move(*mask));
            }
            break;
        default:
            break;
    }
}

void NightjarSession::send_mouse_move(int16_t dx, int16_t dy) {
    if (!warp_) return;
    warp_->note_mouse(dx, dy, now_us());
}

void NightjarSession::send_controller_packet(uint16_t controller_idx, int16_t rx, int16_t ry) {
    if (!warp_) return;
    warp_->note_controller(controller_idx, rx, ry, now_us());
}

void NightjarSession::on_display_refresh() {
    if (!running_.load(std::memory_order_acquire) || !warp_ || !decoder_) return;
    uint64_t t_us = now_us();
    uint32_t frame_number = 0;

    if (decoder_->fill_next_frame(renderer_.video_texture(), frame_number)) {
        auto w = opts_.frame_warp_enabled ? warp_->warp(frame_number, t_us) : frame_warp::Warp{};
        renderer_.sync_hud_mask(*warp_);
        renderer_.draw(w, frame_number, warp_->input_seq());
    } else if (opts_.frame_warp_enabled) {
        renderer_.maybe_redraw_between_frames(*warp_, t_us);
    }
}

frame_warp::Status NightjarSession::frame_warp_status() const {
    if (!warp_) return frame_warp::Status{};
    return warp_->status(now_us());
}

} // namespace nightjar::tizen
