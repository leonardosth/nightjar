#include "tizen_video_decoder.hpp"
#include "codec_capabilities.hpp"

#include <algorithm>
#include <cmath>

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
#include <samsung/html/html_media_element.h>
#include <samsung/html/html_media_element_listener.h>
#include <samsung/wasm/elementary_media_packet.h>
#include <samsung/wasm/elementary_media_stream_source.h>
#include <samsung/wasm/elementary_media_stream_source_listener.h>
#include <samsung/wasm/elementary_media_track.h>
#include <samsung/wasm/elementary_media_track_listener.h>
#include <samsung/wasm/elementary_video_track_config.h>
#include <samsung/wasm/operation_result.h>
#endif

namespace nightjar::tizen {

void TextureRing::init(std::array<GLuint, 3> textures) {
    std::lock_guard<std::mutex> lk(mu_);
    for (size_t i = 0; i < 3; ++i) {
        slots_[i] = Slot{textures[i], SlotState::Free, 0, true, 0};
    }
    displaying_.reset();
    ready_.reset();
    filling_in_flight_ = false;
    ++generation_;
}

void TextureRing::reset() {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& s : slots_) {
        s.state = SlotState::Free;
        s.frame_number = 0;
        s.is_tagged = true;
        s.filled_us = 0;
    }
    displaying_.reset();
    ready_.reset();
    filling_in_flight_ = false;
    ++generation_;
}

uint64_t TextureRing::generation() const {
    std::lock_guard<std::mutex> lk(mu_);
    return generation_;
}

std::optional<size_t> TextureRing::acquire_for_fill() {
    std::lock_guard<std::mutex> lk(mu_);
    if (filling_in_flight_) return std::nullopt;
    for (size_t i = 0; i < 3; ++i) {
        if (slots_[i].state == SlotState::Free && slots_[i].tex != 0) {
            slots_[i].state = SlotState::Filling;
            filling_in_flight_ = true;
            return i;
        }
    }
    return std::nullopt;
}

void TextureRing::mark_filled(
    size_t slot,
    uint32_t frame_number,
    std::optional<GLuint>& out_superseded,
    std::optional<uint64_t> expected_gen,
    bool is_tagged,
    uint64_t filled_us) {
    std::lock_guard<std::mutex> lk(mu_);
    out_superseded.reset();
    if (expected_gen.has_value() && *expected_gen != generation_) return;
    if (slot >= 3) return;
    if (ready_.has_value() && *ready_ != slot) {
        size_t old_ready = *ready_;
        out_superseded = slots_[old_ready].tex;
        slots_[old_ready].state = SlotState::Free;
    }
    slots_[slot].frame_number = frame_number;
    slots_[slot].is_tagged = is_tagged;
    slots_[slot].filled_us = filled_us;
    slots_[slot].state = SlotState::Ready;
    ready_ = slot;
    filling_in_flight_ = false;
}

void TextureRing::mark_fill_aborted(size_t slot, std::optional<uint64_t> expected_gen) {
    std::lock_guard<std::mutex> lk(mu_);
    if (expected_gen.has_value() && *expected_gen != generation_) return;
    if (slot >= 3) return;
    if (slots_[slot].state == SlotState::Filling) {
        slots_[slot].state = SlotState::Free;
    }
    filling_in_flight_ = false;
}

bool TextureRing::swap_to_display(
    uint32_t& out_frame,
    std::optional<GLuint>& out_recycle,
    bool* out_tagged,
    uint64_t* out_filled_us) {
    std::lock_guard<std::mutex> lk(mu_);
    out_recycle.reset();
    if (!ready_.has_value()) return false;

    size_t next_slot = *ready_;
    ready_.reset();

    if (displaying_.has_value() && *displaying_ != next_slot) {
        size_t old_slot = *displaying_;
        out_recycle = slots_[old_slot].tex;
        slots_[old_slot].state = SlotState::Free;
    }
    slots_[next_slot].state = SlotState::Displaying;
    displaying_ = next_slot;
    out_frame = slots_[next_slot].frame_number;
    if (out_tagged) *out_tagged = slots_[next_slot].is_tagged;
    if (out_filled_us) *out_filled_us = slots_[next_slot].filled_us;
    return true;
}

GLuint TextureRing::current_display_texture() const {
    std::lock_guard<std::mutex> lk(mu_);
    if (!displaying_.has_value()) return 0;
    return slots_[*displaying_].tex;
}

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
struct TizenVideoDecoder::Impl
    : public samsung::wasm::ElementaryMediaStreamSourceListener,
      public samsung::wasm::ElementaryMediaTrackListener {
    std::unique_ptr<samsung::html::HTMLMediaElement> media_element;
    std::unique_ptr<samsung::wasm::ElementaryMediaStreamSource> source;
    samsung::wasm::ElementaryMediaTrack video_track;
    std::atomic<samsung::wasm::SessionId> session_id{0};
    std::atomic<bool> track_open{false};
    bool has_track = false;
    bool use_video_texture = true;
    std::string codec = "hevc";
    uint32_t width = 3840;
    uint32_t height = 2160;
    uint32_t fps = 60;
    bool hdr10 = false;
    std::function<void()> on_need_idr;
    std::function<void(void*)> on_source_ready_for_tracks;
    std::function<void()> on_track_closed;
    TextureRing* ring_ref = nullptr;
    PendingFrameQueue* pending_ref = nullptr;

    // Live diagnostics surfaced in the TV overlay
    std::atomic<int> src_closed_count{0};
    std::atomic<int> open_pending_count{0};
    std::atomic<int> vtrack_op{-1};
    std::atomic<int> open_op{-1};
    std::atomic<int> play_op{-1};
    std::atomic<int> reg_gl_ok{-1};
    std::atomic<uint32_t> append_ok{0};
    std::atomic<uint32_t> append_err{0};
    std::atomic<int> last_append_op{-1};
    std::atomic<int> last_fill_op{-1};

    void attach_tracks_and_open() {
        if (!source) return;
        src_closed_count.fetch_add(1, std::memory_order_relaxed);
        if (!has_track) {
            const uint32_t eff_fps = fps ? fps : 60u;
            const std::string primary_mime = build_video_mime(codec, width, height, eff_fps, hdr10);
            auto try_add = [&](const std::string& mime) {
                return source->AddTrack(samsung::wasm::ElementaryVideoTrackConfig{
                    mime,
                    {},
                    width,
                    height,
                    eff_fps,
                    1u,
                });
            };
            auto add_res = try_add(primary_mime);
            if (!add_res) {
                std::string fallback_mime = (codec == "av1")
                    ? "video/mp4; codecs=\"av01.0.08M.08\""
                    : (codec == "h264")
                        ? "video/mp4; codecs=\"avc1.4d401f\""
                        : "video/mp4; codecs=\"hev1.1.6.L93.B0\"";
                if (fallback_mime != primary_mime) {
                    add_res = try_add(fallback_mime);
                }
            }
            vtrack_op.store(static_cast<int>(add_res.operation_result), std::memory_order_relaxed);
            if (!add_res) {
                return;
            }
            video_track = std::move(add_res.value);
            video_track.SetListener(this);
            has_track = true;

            if (on_source_ready_for_tracks) {
                on_source_ready_for_tracks(static_cast<void*>(source.get()));
            }
            if (use_video_texture) {
                auto rg = video_track.RegisterCurrentGraphicsContext();
                reg_gl_ok.store(rg ? 1 : 0, std::memory_order_relaxed);
            }
        }
        source->Open([this](samsung::wasm::OperationResult r) {
            open_op.store(static_cast<int>(r), std::memory_order_relaxed);
        });
    }

    void OnSourceClosed() override {
        // Fired when HTMLMediaElement::SetSrc() finishes transitioning kDetached -> kClosed,
        // and whenever the source later closes. Safe point to AddTrack() and Open().
        attach_tracks_and_open();
    }

    void OnSourceOpenPending() override {
        open_pending_count.fetch_add(1, std::memory_order_relaxed);
        if (media_element) {
            media_element->Play([this](samsung::wasm::OperationResult r) {
                play_op.store(static_cast<int>(r), std::memory_order_relaxed);
            });
        }
    }

    void OnTrackOpen() override {
        track_open.store(true, std::memory_order_release);
        if (on_need_idr) on_need_idr();
    }

    void OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) override {
        track_open.store(false, std::memory_order_release);
        if (ring_ref) ring_ref->reset();
        if (pending_ref) pending_ref->clear();
        if (on_track_closed) on_track_closed();
    }

    void OnSessionIdChanged(samsung::wasm::SessionId new_id) override {
        session_id.store(new_id, std::memory_order_release);
        if (track_open.load(std::memory_order_acquire) && on_need_idr) {
            on_need_idr();
        }
    }
};
#else
struct TizenVideoDecoder::Impl {};
#endif

TizenVideoDecoder::TizenVideoDecoder(std::shared_ptr<frame_warp::FrameWarp> warp)
    : warp_(std::move(warp)), impl_(std::make_unique<Impl>()) {}

TizenVideoDecoder::~TizenVideoDecoder() {
    shutdown();
}

void TizenVideoDecoder::reset_pts_origin() {
    std::lock_guard<std::mutex> lk(pts_mu_);
    has_pts_origin_ = false;
    pts_origin_us_ = 0;
    wall_origin_us_ = 0;
    last_pts_us_ = 0;
}

bool TizenVideoDecoder::initialize(const VideoConfig& config, std::string* out_error) {
    shutdown();
    alive_ = std::make_shared<std::atomic<bool>>(true);
    config_ = config;
    submitted_packets_ = 0;
    reset_pts_origin();
    pending_.clear();
    decode_latency_.roll();
    decoded_total_.store(0, std::memory_order_relaxed);
    superseded_total_.store(0, std::memory_order_relaxed);
    unresolved_total_.store(0, std::memory_order_relaxed);
    fill_err_total_.store(0, std::memory_order_relaxed);
    append_err_total_.store(0, std::memory_order_relaxed);
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    using LatencyMode = samsung::wasm::ElementaryMediaStreamSource::LatencyMode;
    using RenderingMode = samsung::wasm::ElementaryMediaStreamSource::RenderingMode;

    impl_->on_need_idr = config.on_need_idr;
    impl_->on_source_ready_for_tracks = config.on_source_ready_for_tracks;
    impl_->on_track_closed = [this]() { reset_pts_origin(); };
    impl_->ring_ref = &ring_;
    impl_->pending_ref = &pending_;
    impl_->use_video_texture = config.use_video_texture;
    impl_->codec = config.codec;
    impl_->width = config.width;
    impl_->height = config.height;
    impl_->fps = config.fps ? config.fps : 60u;
    impl_->hdr10 = config.hdr10;
    impl_->media_element = std::make_unique<samsung::html::HTMLMediaElement>("tizen-video-sink");
    const RenderingMode rmode = config.use_video_texture
        ? RenderingMode::kVideoTexture
        : RenderingMode::kMediaElement;

    impl_->source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(LatencyMode::kUltraLow, rmode);
    if (!impl_->source->IsValid()) {
        impl_->source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(LatencyMode::kLow, rmode);
    }
    if (!impl_->source->IsValid()) {
        impl_->source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(LatencyMode::kNormal, rmode);
    }

    const bool src_valid = impl_->source->IsValid();
    const bool el_valid = impl_->media_element->IsValid();
    if (!src_valid || !el_valid) {
        if (out_error) {
            *out_error = std::string("EMSS invalid: srcValid=") + (src_valid ? "1" : "0") +
                         " elValid=" + (el_valid ? "1" : "0") +
                         " rmode=" + (config.use_video_texture ? "kVideoTexture" : "kMediaElement");
        }
        return false;
    }

    impl_->source->SetListener(impl_.get());
    auto set_src_res = impl_->media_element->SetSrc(impl_->source.get());
    if (!set_src_res) {
        if (out_error) {
            *out_error = "SetSrc failed: op=" + std::to_string(static_cast<int>(set_src_res.operation_result));
        }
        return false;
    }
    // Tracks are added in OnSourceClosed() once SetSrc() completes kDetached -> kClosed.
#else
    (void)out_error;
#endif
    initialized_ = true;
    return true;
}

void TizenVideoDecoder::open_source() {
    // Opening is triggered automatically in OnSourceClosed() right after AddTrack() succeeds.
}

void* TizenVideoDecoder::emss_source() const {
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    return impl_ && impl_->source ? static_cast<void*>(impl_->source.get()) : nullptr;
#else
    return nullptr;
#endif
}

void TizenVideoDecoder::attach_texture_ring(std::array<GLuint, 3> textures) {
    ring_.init(textures);
}

bool TizenVideoDecoder::register_gl_context() {
    if (!initialized_ || !config_.use_video_texture) return true;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track) return false;
    return static_cast<bool>(impl_->video_track.RegisterCurrentGraphicsContext());
#else
    return true;
#endif
}

bool TizenVideoDecoder::submit_access_unit(
    const uint8_t* data, size_t size, uint32_t frame_number, int64_t pts_us, bool keyframe) {
    if (!initialized_ || !data || size == 0) return false;

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) {
        return true;
    }
#endif

    // Anchor video PTS at 0.0s (matching the Opus audio track) using real host frame timing
    // so variable-FPS games (e.g. 85 fps inside a 120 fps stream) never drift behind audio.
    const uint32_t fps = config_.fps ? config_.fps : 60u;
    const int64_t frame_dur_us = 1000000LL / static_cast<int64_t>(fps);
    const uint64_t now_wall_us = steady_now_us();
    int64_t effective_pts_us = 0;
    int64_t pkt_dur_us = frame_dur_us;
    {
        std::lock_guard<std::mutex> lk(pts_mu_);
        if (!has_pts_origin_) {
            has_pts_origin_ = true;
            pts_origin_us_ = pts_us;
            wall_origin_us_ = now_wall_us;
            last_pts_us_ = 0;
            effective_pts_us = 0;
        } else {
            int64_t candidate_us = 0;
            if (pts_us > pts_origin_us_) {
                candidate_us = pts_us - pts_origin_us_;
            } else if (now_wall_us > wall_origin_us_) {
                candidate_us = static_cast<int64_t>(now_wall_us - wall_origin_us_);
            } else {
                candidate_us = last_pts_us_ + frame_dur_us;
            }
            effective_pts_us = std::max(last_pts_us_ + 500LL, candidate_us);
            pkt_dur_us = std::clamp<int64_t>(effective_pts_us - last_pts_us_, 1000LL, 100000LL);
            last_pts_us_ = effective_pts_us;
        }
    }
    ++submitted_packets_;

    if (warp_) {
        warp_->note_frame_pts(effective_pts_us, frame_number);
    }

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    samsung::wasm::Seconds pts(static_cast<double>(effective_pts_us) / 1000000.0);
    samsung::wasm::Seconds dur(static_cast<double>(pkt_dur_us) / 1000000.0);
    samsung::wasm::ElementaryMediaPacket pkt{
        pts,
        pts,
        dur,
        keyframe,
        size,
        data,
        config_.width,
        config_.height,
        fps,
        1u,
        impl_->session_id.load(std::memory_order_acquire),
    };
    auto ap_res = impl_->video_track.AppendPacket(pkt);
    impl_->last_append_op.store(static_cast<int>(ap_res.operation_result), std::memory_order_relaxed);
    if (ap_res) {
        impl_->append_ok.fetch_add(1u, std::memory_order_relaxed);
        if (config_.use_video_texture) {
            pending_.push(PendingFrameQueue::Entry{frame_number, effective_pts_us, steady_now_us()});
        }
        return true;
    }
    impl_->append_err.fetch_add(1u, std::memory_order_relaxed);
    append_err_total_.fetch_add(1u, std::memory_order_relaxed);
    return false;
#else
    (void)keyframe;
    if (config_.use_video_texture) {
        pending_.push(PendingFrameQueue::Entry{frame_number, effective_pts_us, steady_now_us()});
    }
    return true;
#endif
}

void TizenVideoDecoder::kick_fill() {
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!initialized_ || !config_.use_video_texture) return;
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) return;
    if (auto slot = ring_.acquire_for_fill()) {
        GLuint fill_tex = ring_.texture_at(*slot);
        size_t slot_idx = *slot;
        uint64_t gen = ring_.generation();
        auto alive = alive_;
        impl_->video_track.FillTextureWithNextFrame(
            fill_tex,
            [this, alive, slot_idx, gen](samsung::wasm::OperationResult res) {
                if (!alive->load(std::memory_order_acquire)) return;
                impl_->last_fill_op.store(static_cast<int>(res), std::memory_order_relaxed);
                if (res != samsung::wasm::OperationResult::kSuccess) {
                    fill_err_total_.fetch_add(1u, std::memory_order_relaxed);
                    ring_.mark_fill_aborted(slot_idx, gen);
                    if (impl_->track_open.load(std::memory_order_acquire)) {
                        kick_fill();
                    }
                    return;
                }
                const uint64_t now = steady_now_us();
                const uint32_t fps = config_.fps ? config_.fps : 60u;
                const int64_t half_frame_us = 500000LL / static_cast<int64_t>(fps);
                const int64_t tol_us = std::max<int64_t>(half_frame_us, 10000LL);
                std::optional<uint32_t> hint;
                if (impl_->media_element && warp_) {
                    auto t_res = impl_->media_element->GetCurrentTime();
                    if (t_res) {
                        int64_t cur_pts_us = static_cast<int64_t>(std::llround(t_res.value.count() * 1000000.0));
                        hint = warp_->lookup_frame_pts_nearest(cur_pts_us, tol_us);
                    }
                }
                uint32_t resolved_frame = 0;
                bool is_tagged = false;
                if (auto e = pending_.resolve(hint)) {
                    resolved_frame = e->frame;
                    is_tagged = true;
                    if (now >= e->submit_us) {
                        decode_latency_.add_us(now - e->submit_us);
                    }
                } else {
                    unresolved_total_.fetch_add(1u, std::memory_order_relaxed);
                }
                decoded_total_.fetch_add(1u, std::memory_order_relaxed);

                std::optional<GLuint> superseded;
                ring_.mark_filled(slot_idx, resolved_frame, superseded, gen, is_tagged, now);
                if (superseded.has_value() && impl_->has_track) {
                    superseded_total_.fetch_add(1u, std::memory_order_relaxed);
                    impl_->video_track.RecycleTexture(*superseded);
                }
                // Chain next fill immediately so hardware decoder never stalls behind rAF rate
                kick_fill();
            });
    }
#endif
}

bool TizenVideoDecoder::poll_next_frame(
    GLuint& out_tex, uint32_t& out_frame, bool& out_tagged, uint64_t* out_filled_us) {
    if (!initialized_ || !config_.use_video_texture) return false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) return false;

    // Kick fill before swap so synchronous callbacks become available on this vsync
    kick_fill();

    std::optional<GLuint> to_recycle;
    bool swapped = ring_.swap_to_display(out_frame, to_recycle, &out_tagged, out_filled_us);
    if (to_recycle.has_value()) {
        impl_->video_track.RecycleTexture(*to_recycle);
    }
    if (swapped) {
        out_tex = ring_.current_display_texture();
        kick_fill();
    }
    return swapped;
#else
    (void)out_tex;
    (void)out_frame;
    out_tagged = false;
    if (out_filled_us) *out_filled_us = 0;
    return false;
#endif
}

std::string TizenVideoDecoder::diagnostic_summary() const {
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_) return "no-impl";
    return "sc=" + std::to_string(impl_->src_closed_count.load(std::memory_order_relaxed)) +
           " vt=" + std::to_string(impl_->vtrack_op.load(std::memory_order_relaxed)) +
           " gl=" + std::to_string(impl_->reg_gl_ok.load(std::memory_order_relaxed)) +
           " op=" + std::to_string(impl_->open_op.load(std::memory_order_relaxed)) +
           " pd=" + std::to_string(impl_->open_pending_count.load(std::memory_order_relaxed)) +
           " pl=" + std::to_string(impl_->play_op.load(std::memory_order_relaxed)) +
           " to=" + std::to_string(impl_->track_open.load(std::memory_order_relaxed) ? 1 : 0) +
           " ap=" + std::to_string(impl_->append_ok.load(std::memory_order_relaxed)) +
           "/" + std::to_string(impl_->append_err.load(std::memory_order_relaxed)) +
           "(" + std::to_string(impl_->last_append_op.load(std::memory_order_relaxed)) + ")" +
           " fl=" + std::to_string(impl_->last_fill_op.load(std::memory_order_relaxed)) +
           " dq=" + std::to_string(pending_.size());
#else
    return "native";
#endif
}

void TizenVideoDecoder::shutdown() {
    if (alive_) {
        alive_->store(false, std::memory_order_release);
    }
    initialized_ = false;
    ring_.reset();
    pending_.clear();
    reset_pts_origin();
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (impl_) {
        if (impl_->has_track) {
            impl_->video_track.SetListener(nullptr);
        }
        if (impl_->source) {
            impl_->source->SetListener(nullptr);
        }
        impl_->track_open.store(false, std::memory_order_release);
        impl_->has_track = false;
        impl_->source.reset();
        impl_->media_element.reset();
    }
#endif
}

} // namespace nightjar::tizen
