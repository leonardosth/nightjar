#include "tizen_video_decoder.hpp"

#include <chrono>

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
#include <samsung/html/html_media_element.h>
#include <samsung/wasm/elementary_media_packet.h>
#include <samsung/wasm/elementary_media_stream_source.h>
#include <samsung/wasm/elementary_media_track.h>
#endif

namespace nightjar::tizen {

struct TizenVideoDecoder::Impl {
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    std::unique_ptr<samsung::html::HTMLMediaElement> media_element;
    std::unique_ptr<samsung::wasm::ElementaryMediaStreamSource> source;
    samsung::wasm::ElementaryMediaTrack video_track;
    bool track_ready = false;
#endif
};

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

    impl_->source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(
        LatencyMode::kUltraLow,
        RenderingMode::kVideoTexture
    );
    impl_->media_element = std::make_unique<samsung::html::HTMLMediaElement>("tizen-video-sink");
    impl_->media_element->SetSrc(impl_->source.get());

    samsung::wasm::ElementaryVideoTrackConfig track_cfg;
    if (config.codec == "av1") {
        track_cfg.mime_type = "video/av01";
    } else if (config.codec == "h264") {
        track_cfg.mime_type = "video/avc";
    } else {
        track_cfg.mime_type = "video/hevc";
    }
    track_cfg.width = config.width;
    track_cfg.height = config.height;
    track_cfg.framerate_num = config.fps;
    track_cfg.framerate_den = 1;

    auto res = impl_->source->AddTrack(track_cfg);
    if (!res) return false;
    impl_->video_track = std::move(*res);
    impl_->track_ready = true;
#endif
    initialized_ = true;
    return true;
}

bool TizenVideoDecoder::register_gl_context() {
    if (!initialized_) return false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->track_ready) return false;
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
    last_frame_number_ = frame_number;

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->track_ready) return false;
    samsung::wasm::ElementaryMediaPacket packet;
    packet.pts = samsung::wasm::Seconds(static_cast<double>(pts_us) / 1000000.0);
    packet.dts = packet.pts;
    packet.duration = samsung::wasm::Seconds(1.0 / static_cast<double>(config_.fps ? config_.fps : 60));
    packet.is_key_frame = keyframe;
    packet.data = data;
    packet.data_size = size;
    return static_cast<bool>(impl_->video_track.AppendPacket(packet));
#else
    (void)keyframe;
    return true;
#endif
}

bool TizenVideoDecoder::fill_next_frame(GLuint target_texture, uint32_t& out_frame) {
    if (!initialized_) return false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->track_ready) return false;
    auto frame_pts = impl_->video_track.FillTextureWithNextFrameSync(target_texture);
    if (!frame_pts) return false;
    int64_t pts_us = static_cast<int64_t>(frame_pts->count() * 1000000.0);
    if (warp_) {
        if (auto found = warp_->lookup_frame_pts(pts_us)) {
            out_frame = *found;
            return true;
        }
    }
    out_frame = last_frame_number_;
    return true;
#else
    (void)target_texture;
    out_frame = last_frame_number_;
    return false;
#endif
}

void TizenVideoDecoder::shutdown() {
    initialized_ = false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    impl_->track_ready = false;
    impl_->source.reset();
    impl_->media_element.reset();
#endif
}

} // namespace nightjar::tizen
