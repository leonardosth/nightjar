#include "tizen_video_decoder.hpp"
#include "codec_capabilities.hpp"

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
        slots_[i] = Slot{textures[i], SlotState::Free, 0};
    }
    displaying_.reset();
    ready_.reset();
    filling_in_flight_ = false;
}

void TextureRing::reset() {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& s : slots_) {
        s.state = SlotState::Free;
        s.frame_number = 0;
    }
    displaying_.reset();
    ready_.reset();
    filling_in_flight_ = false;
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

void TextureRing::mark_filled(size_t slot, uint32_t frame_number) {
    std::lock_guard<std::mutex> lk(mu_);
    if (slot >= 3) return;
    slots_[slot].frame_number = frame_number;
    slots_[slot].state = SlotState::Ready;
    ready_ = slot;
    filling_in_flight_ = false;
}

void TextureRing::mark_fill_aborted(size_t slot) {
    std::lock_guard<std::mutex> lk(mu_);
    if (slot >= 3) return;
    if (slots_[slot].state == SlotState::Filling) {
        slots_[slot].state = SlotState::Free;
    }
    filling_in_flight_ = false;
}

bool TextureRing::swap_to_display(uint32_t& out_frame, std::optional<GLuint>& out_recycle) {
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
    std::function<void()> on_need_idr;

    void OnSourceClosed() override {
        if (source) {
            source->Open([](samsung::wasm::OperationResult) {});
        }
    }

    void OnSourceOpenPending() override {
        if (media_element) {
            media_element->Play([](samsung::wasm::OperationResult) {});
        }
    }

    void OnTrackOpen() override {
        track_open.store(true, std::memory_order_release);
        if (on_need_idr) on_need_idr();
    }

    void OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) override {
        track_open.store(false, std::memory_order_release);
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

bool TizenVideoDecoder::initialize(const VideoConfig& config) {
    shutdown();
    config_ = config;
    submitted_packets_ = 0;
    last_pts_us_ = -1;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    using LatencyMode = samsung::wasm::ElementaryMediaStreamSource::LatencyMode;
    using RenderingMode = samsung::wasm::ElementaryMediaStreamSource::RenderingMode;

    impl_->on_need_idr = config.on_need_idr;
    impl_->media_element = std::make_unique<samsung::html::HTMLMediaElement>("tizen-video-sink");
    impl_->source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(
        LatencyMode::kUltraLow,
        config.use_video_texture ? RenderingMode::kVideoTexture : RenderingMode::kMediaElement
    );
    impl_->source->SetListener(impl_.get());
    impl_->media_element->SetSrc(impl_->source.get());

    const std::string mime = build_video_mime(
        config.codec,
        config.width,
        config.height,
        config.fps ? config.fps : 60u,
        config.hdr10);

    auto add_res = impl_->source->AddTrack(samsung::wasm::ElementaryVideoTrackConfig{
        mime,
        {},
        config.width,
        config.height,
        config.fps ? config.fps : 60u,
        1u,
    });
    if (!add_res) {
        return false;
    }
    impl_->video_track = std::move(add_res.value);
    impl_->video_track.SetListener(impl_.get());
    impl_->has_track = true;
    impl_->source->Open([](samsung::wasm::OperationResult) {});
#endif
    initialized_ = true;
    return true;
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

    const uint32_t fps = config_.fps ? config_.fps : 60u;
    const int64_t frame_dur_us = 1000000LL / static_cast<int64_t>(fps);

    // Guarantee strictly monotonic PTS for kUltraLow hardware decoder + FrameRing lookup
    int64_t effective_pts_us = pts_us;
    if (effective_pts_us <= last_pts_us_) {
        effective_pts_us = static_cast<int64_t>(submitted_packets_) * frame_dur_us;
        if (effective_pts_us <= last_pts_us_) {
            effective_pts_us = last_pts_us_ + frame_dur_us;
        }
    }
    last_pts_us_ = effective_pts_us;
    ++submitted_packets_;

    if (warp_) {
        warp_->note_frame_pts(effective_pts_us, frame_number);
    }
    latest_submitted_frame_.store(frame_number, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lk(pending_mu_);
        pending_frames_.emplace_back(effective_pts_us, frame_number);
        while (pending_frames_.size() > 64) pending_frames_.pop_front();
    }

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) {
        return true;
    }
    samsung::wasm::Seconds pts(static_cast<double>(effective_pts_us) / 1000000.0);
    samsung::wasm::Seconds dur(1.0 / static_cast<double>(fps));
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
    return static_cast<bool>(impl_->video_track.AppendPacket(pkt));
#else
    (void)keyframe;
    return true;
#endif
}

bool TizenVideoDecoder::poll_next_frame(GLuint& out_tex, uint32_t& out_frame) {
    if (!initialized_ || !config_.use_video_texture) return false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) return false;

    std::optional<GLuint> to_recycle;
    bool swapped = ring_.swap_to_display(out_frame, to_recycle);
    if (to_recycle.has_value()) {
        impl_->video_track.RecycleTexture(*to_recycle);
    }
    if (swapped) {
        out_tex = ring_.current_display_texture();
    }

    // Always keep one async FillTextureWithNextFrame in flight on a Free slot
    if (auto slot = ring_.acquire_for_fill()) {
        GLuint fill_tex = ring_.texture_at(*slot);
        size_t slot_idx = *slot;
        impl_->video_track.FillTextureWithNextFrame(
            fill_tex,
            [this, slot_idx](samsung::wasm::OperationResult res) {
                if (res != samsung::wasm::OperationResult::kSuccess) {
                    ring_.mark_fill_aborted(slot_idx);
                    return;
                }
                const uint32_t fps = config_.fps ? config_.fps : 60u;
                const int64_t half_frame_us = 500000LL / static_cast<int64_t>(fps);
                uint32_t resolved_frame = latest_submitted_frame_.load(std::memory_order_acquire);

                if (impl_->media_element && warp_) {
                    auto t_res = impl_->media_element->GetCurrentTime();
                    if (t_res) {
                        int64_t cur_pts_us = static_cast<int64_t>(std::llround(t_res.value.count() * 1000000.0));
                        if (auto exact = warp_->lookup_frame_pts_nearest(cur_pts_us, half_frame_us)) {
                            resolved_frame = *exact;
                        } else {
                            std::lock_guard<std::mutex> lk(pending_mu_);
                            while (pending_frames_.size() > 1 && pending_frames_.front().first < cur_pts_us - half_frame_us) {
                                pending_frames_.pop_front();
                            }
                            if (!pending_frames_.empty()) {
                                resolved_frame = pending_frames_.front().second;
                            }
                        }
                    }
                }
                ring_.mark_filled(slot_idx, resolved_frame);
            });
    }

    return swapped;
#else
    (void)out_tex;
    (void)out_frame;
    return false;
#endif
}

void TizenVideoDecoder::shutdown() {
    initialized_ = false;
    ring_.reset();
    {
        std::lock_guard<std::mutex> lk(pending_mu_);
        pending_frames_.clear();
    }
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (impl_) {
        impl_->track_open.store(false, std::memory_order_release);
        impl_->has_track = false;
        impl_->source.reset();
        impl_->media_element.reset();
    }
#endif
}

} // namespace nightjar::tizen
