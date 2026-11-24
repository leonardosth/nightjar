#include "tizen_video_decoder.hpp"

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
    }

    void OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) override {
        track_open.store(false, std::memory_order_release);
    }

    void OnSessionIdChanged(samsung::wasm::SessionId new_id) override {
        session_id.store(new_id, std::memory_order_release);
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
    config_ = config;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    using LatencyMode = samsung::wasm::ElementaryMediaStreamSource::LatencyMode;
    using RenderingMode = samsung::wasm::ElementaryMediaStreamSource::RenderingMode;

    impl_->media_element = std::make_unique<samsung::html::HTMLMediaElement>("tizen-video-sink");
    impl_->source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(
        LatencyMode::kUltraLow,
        RenderingMode::kVideoTexture
    );
    impl_->source->SetListener(impl_.get());
    impl_->media_element->SetSrc(impl_->source.get());

    const char* mime = "video/mp4; codecs=\"hev1.1.6.L93.B0\"";
    if (config.codec == "av1") {
        mime = "video/mp4; codecs=\"av01.0.13M.08\"";
    } else if (config.codec == "h264") {
        mime = "video/mp4; codecs=\"avc1.64002A\"";
    }

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

bool TizenVideoDecoder::register_gl_context() {
    if (!initialized_) return false;
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

    if (warp_) {
        warp_->note_frame_pts(pts_us, frame_number);
    }
    latest_submitted_frame_.store(frame_number, std::memory_order_release);

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) {
        return true;
    }
    samsung::wasm::Seconds pts(static_cast<double>(pts_us) / 1000000.0);
    samsung::wasm::Seconds dur(1.0 / static_cast<double>(config_.fps ? config_.fps : 60u));
    samsung::wasm::ElementaryMediaPacket pkt{
        pts,
        pts,
        dur,
        keyframe,
        size,
        data,
        config_.width,
        config_.height,
        config_.fps ? config_.fps : 60u,
        1u,
        impl_->session_id.load(std::memory_order_acquire),
    };
    return static_cast<bool>(impl_->video_track.AppendPacket(pkt));
#else
    (void)keyframe;
    return true;
#endif
}

bool TizenVideoDecoder::fill_next_frame(GLuint target_texture, uint32_t& out_frame) {
    if (!initialized_) return false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) return false;

    if (texture_ready_.exchange(false, std::memory_order_acq_rel)) {
        out_frame = latched_frame_.load(std::memory_order_acquire);
        return true;
    }

    bool expected = false;
    if (fill_in_flight_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        impl_->video_track.FillTextureWithNextFrame(
            target_texture,
            [this](samsung::wasm::OperationResult res) {
                if (res == samsung::wasm::OperationResult::kSuccess) {
                    latched_frame_.store(
                        latest_submitted_frame_.load(std::memory_order_acquire),
                        std::memory_order_release);
                    texture_ready_.store(true, std::memory_order_release);
                }
                fill_in_flight_.store(false, std::memory_order_release);
            });
    }
    return false;
#else
    (void)target_texture;
    out_frame = latest_submitted_frame_.load(std::memory_order_acquire);
    return false;
#endif
}

void TizenVideoDecoder::recycle_texture(GLuint target_texture) {
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (initialized_ && impl_->has_track) {
        impl_->video_track.RecycleTexture(target_texture);
    }
#else
    (void)target_texture;
#endif
}

void TizenVideoDecoder::shutdown() {
    initialized_ = false;
    texture_ready_.store(false, std::memory_order_release);
    fill_in_flight_.store(false, std::memory_order_release);
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    impl_->track_open.store(false, std::memory_order_release);
    impl_->has_track = false;
    impl_->source.reset();
    impl_->media_element.reset();
#endif
}

} // namespace nightjar::tizen
