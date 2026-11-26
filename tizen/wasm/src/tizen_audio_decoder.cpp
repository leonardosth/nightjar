#include "tizen_audio_decoder.hpp"

#include <algorithm>
#include <cstring>

#ifdef NIGHTJAR_HAVE_OPUS
#include <opus/opus_multistream.h>
#endif

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
#include <samsung/wasm/elementary_audio_track_config.h>
#include <samsung/wasm/elementary_media_packet.h>
#include <samsung/wasm/elementary_media_stream_source.h>
#include <samsung/wasm/elementary_media_track.h>
#include <samsung/wasm/elementary_media_track_listener.h>
#endif

namespace nightjar::tizen {

struct TizenAudioDecoder::Impl
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    : public samsung::wasm::ElementaryMediaTrackListener
#endif
{
#ifdef NIGHTJAR_HAVE_OPUS
    OpusMSDecoder* decoder = nullptr;
#endif
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    samsung::wasm::ElementaryMediaTrack audio_track;
    std::atomic<samsung::wasm::SessionId> session_id{0};
    std::atomic<bool> track_open{false};
    bool has_track = false;

    void OnTrackOpen() override {
        track_open.store(true, std::memory_order_release);
    }

    void OnTrackClosed(samsung::wasm::ElementaryMediaTrack::CloseReason) override {
        track_open.store(false, std::memory_order_release);
    }

    void OnSessionIdChanged(samsung::wasm::SessionId new_id) override {
        session_id.store(new_id, std::memory_order_release);
    }
#endif
};

TizenAudioDecoder::TizenAudioDecoder() : impl_(std::make_unique<Impl>()) {}
TizenAudioDecoder::~TizenAudioDecoder() { shutdown(); }

bool TizenAudioDecoder::initialize(const AudioConfig& cfg, void* emss_source_ptr) {
    shutdown();
    cfg_ = cfg;
    samples_submitted_.store(0, std::memory_order_release);
    if (cfg_.sample_rate <= 0 || cfg_.channel_count <= 0 || cfg_.samples_per_frame <= 0) {
        return false;
    }

    pcm_buf_.assign(static_cast<size_t>(cfg_.samples_per_frame) * static_cast<size_t>(cfg_.channel_count), 0);

#ifdef NIGHTJAR_HAVE_OPUS
    int opus_err = OPUS_OK;
    impl_->decoder = opus_multistream_decoder_create(
        cfg_.sample_rate,
        cfg_.channel_count,
        cfg_.streams,
        cfg_.coupled_streams,
        cfg_.mapping,
        &opus_err);
    if (opus_err != OPUS_OK || !impl_->decoder) {
        impl_->decoder = nullptr;
        return false;
    }
#endif

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (emss_source_ptr != nullptr) {
        auto* source = static_cast<samsung::wasm::ElementaryMediaStreamSource*>(emss_source_ptr);
        samsung::wasm::ElementaryAudioTrackConfig track_cfg;
        track_cfg.mime_type = "audio/webm; codecs=\"pcm\"";
        track_cfg.extradata = {};
        track_cfg.sample_format = samsung::wasm::SampleFormat::kS16;
        track_cfg.channel_layout = (cfg_.channel_count >= 6)
            ? samsung::wasm::ChannelLayout::k5_1
            : samsung::wasm::ChannelLayout::kStereo;
        track_cfg.samples_per_second = static_cast<uint32_t>(cfg_.sample_rate);

        auto add_res = source->AddTrack(track_cfg);
        if (add_res) {
            impl_->audio_track = std::move(add_res.value);
            impl_->audio_track.SetListener(impl_.get());
            impl_->has_track = true;
        }
    }
#else
    (void)emss_source_ptr;
#endif

    initialized_ = true;
    return true;
}

void TizenAudioDecoder::decode_and_play(const uint8_t* opus_data, size_t opus_len) {
    if (!initialized_ || !opus_data || opus_len == 0) return;

    int decoded_samples = cfg_.samples_per_frame;
#ifdef NIGHTJAR_HAVE_OPUS
    if (!impl_->decoder) return;
    decoded_samples = opus_multistream_decode(
        impl_->decoder,
        opus_data,
        static_cast<opus_int32>(opus_len),
        pcm_buf_.data(),
        cfg_.samples_per_frame,
        0);
    if (decoded_samples <= 0) return;
#endif

    const uint64_t prev_samples = samples_submitted_.fetch_add(
        static_cast<uint64_t>(decoded_samples),
        std::memory_order_acq_rel);

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) {
        return;
    }
    const double sr = static_cast<double>(cfg_.sample_rate);
    samsung::wasm::Seconds pts(static_cast<double>(prev_samples) / sr);
    samsung::wasm::Seconds dur(static_cast<double>(decoded_samples) / sr);
    const size_t byte_len =
        static_cast<size_t>(decoded_samples) * static_cast<size_t>(cfg_.channel_count) * sizeof(int16_t);

    samsung::wasm::ElementaryMediaPacket pkt{
        pts,
        pts,
        dur,
        true,
        byte_len,
        pcm_buf_.data(),
        0u,
        0u,
        0u,
        0u,
        impl_->session_id.load(std::memory_order_acquire),
    };
    (void)impl_->audio_track.AppendPacket(pkt);
#else
    (void)prev_samples;
#endif
}

void TizenAudioDecoder::shutdown() {
    initialized_ = false;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (impl_) {
        impl_->track_open.store(false, std::memory_order_release);
        impl_->has_track = false;
    }
#endif
#ifdef NIGHTJAR_HAVE_OPUS
    if (impl_ && impl_->decoder) {
        opus_multistream_decoder_destroy(impl_->decoder);
        impl_->decoder = nullptr;
    }
#endif
}

} // namespace nightjar::tizen
