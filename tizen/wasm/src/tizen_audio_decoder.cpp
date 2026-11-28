#include "tizen_audio_decoder.hpp"

#include <algorithm>
#include <cstring>
#include <mutex>

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
    std::mutex opus_mu;
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

void TizenAudioDecoder::set_media_clock(std::shared_ptr<SharedMediaClock> clock) {
    clock_ = std::move(clock);
}

bool TizenAudioDecoder::open_track_on_main_thread(int sample_rate, bool surround51, void* emss_source_ptr) {
    if (sample_rate <= 0) return false;
    cfg_.sample_rate = sample_rate;
    cfg_.channel_count = surround51 ? 6 : 2;
    samples_submitted_.store(0, std::memory_order_release);
    has_audio_pts_ = false;
    next_audio_pts_us_ = 0;
    audio_pts_us_.store(0, std::memory_order_release);
    audio_gaps_.store(0, std::memory_order_relaxed);
    audio_dropped_.store(0, std::memory_order_relaxed);
    audio_lead_ms_.store(0, std::memory_order_relaxed);

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (emss_source_ptr != nullptr) {
        auto* source = static_cast<samsung::wasm::ElementaryMediaStreamSource*>(emss_source_ptr);
        samsung::wasm::ElementaryAudioTrackConfig track_cfg;
        track_cfg.mime_type = "audio/webm; codecs=\"pcm\"";
        track_cfg.extradata = {};
        track_cfg.sample_format = samsung::wasm::SampleFormat::kS16;
        track_cfg.channel_layout = surround51
            ? samsung::wasm::ChannelLayout::k5_1
            : samsung::wasm::ChannelLayout::kStereo;
        track_cfg.samples_per_second = static_cast<uint32_t>(sample_rate);

        auto add_res = source->AddTrack(track_cfg);
        if (!add_res) {
            return false;
        }
        impl_->audio_track = std::move(add_res.value);
        impl_->audio_track.SetListener(impl_.get());
        impl_->has_track = true;
    }
#else
    (void)emss_source_ptr;
#endif
    return true;
}

bool TizenAudioDecoder::reconfigure_opus(const AudioConfig& cfg) {
    if (cfg.sample_rate <= 0 || cfg.channel_count <= 0 || cfg.samples_per_frame <= 0) {
        return false;
    }
    std::lock_guard<std::mutex> lk(impl_->opus_mu);
    cfg_ = cfg;
    samples_submitted_.store(0, std::memory_order_release);
    has_audio_pts_ = false;
    next_audio_pts_us_ = 0;
    audio_pts_us_.store(0, std::memory_order_release);
    audio_gaps_.store(0, std::memory_order_relaxed);
    audio_dropped_.store(0, std::memory_order_relaxed);
    audio_lead_ms_.store(0, std::memory_order_relaxed);
    pcm_buf_.assign(static_cast<size_t>(cfg_.samples_per_frame) * static_cast<size_t>(cfg_.channel_count), 0);

#ifdef NIGHTJAR_HAVE_OPUS
    if (impl_->decoder) {
        opus_multistream_decoder_destroy(impl_->decoder);
        impl_->decoder = nullptr;
    }
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
    initialized_ = true;
    return true;
}

bool TizenAudioDecoder::initialize(const AudioConfig& cfg, void* emss_source_ptr) {
    shutdown();
    if (!open_track_on_main_thread(cfg.sample_rate, cfg.channel_count >= 6, emss_source_ptr)) {
        return false;
    }
    return reconfigure_opus(cfg);
}

void TizenAudioDecoder::decode_and_play(const uint8_t* opus_data, size_t opus_len, uint64_t wall_now_us) {
    if (!initialized_ || !opus_data || opus_len == 0) return;

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (!impl_->has_track || !impl_->track_open.load(std::memory_order_acquire)) {
        return;
    }
#endif

    std::lock_guard<std::mutex> lk(impl_->opus_mu);
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

    constexpr int64_t kMaxBehindUs = 40000LL;
    constexpr int64_t kMaxAheadUs = 40000LL;
    const int64_t dur_us =
        (static_cast<int64_t>(decoded_samples) * 1000000LL) / static_cast<int64_t>(cfg_.sample_rate);
    int64_t packet_pts_us = 0;

    if (clock_) {
        const uint64_t w_now = wall_now_us ? wall_now_us : steady_now_us();
        const int64_t now_us = clock_->elapsed_us(w_now);
        if (!has_audio_pts_) {
            next_audio_pts_us_ = now_us;
            has_audio_pts_ = true;
        } else if (next_audio_pts_us_ < now_us - kMaxBehindUs) {
            next_audio_pts_us_ = now_us;
            audio_gaps_.fetch_add(1u, std::memory_order_relaxed);
        }
        const int64_t lead_us = next_audio_pts_us_ - now_us;
        audio_lead_ms_.store(static_cast<int>(lead_us / 1000LL), std::memory_order_relaxed);
        if (lead_us > kMaxAheadUs) {
            audio_dropped_.fetch_add(1u, std::memory_order_relaxed);
            return;
        }
        packet_pts_us = next_audio_pts_us_;
        next_audio_pts_us_ += dur_us;
        audio_pts_us_.store(next_audio_pts_us_, std::memory_order_release);
        samples_submitted_.fetch_add(static_cast<uint64_t>(decoded_samples), std::memory_order_acq_rel);
    } else {
        const uint64_t prev_samples = samples_submitted_.fetch_add(
            static_cast<uint64_t>(decoded_samples),
            std::memory_order_acq_rel);
        packet_pts_us = (static_cast<int64_t>(prev_samples) * 1000000LL) / static_cast<int64_t>(cfg_.sample_rate);
        audio_pts_us_.store(packet_pts_us + dur_us, std::memory_order_release);
    }

#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    samsung::wasm::Seconds pts(static_cast<double>(packet_pts_us) / 1000000.0);
    samsung::wasm::Seconds dur(static_cast<double>(dur_us) / 1000000.0);
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
#endif
}

void TizenAudioDecoder::shutdown() {
    initialized_ = false;
    has_audio_pts_ = false;
    next_audio_pts_us_ = 0;
    audio_pts_us_.store(0, std::memory_order_release);
    audio_gaps_.store(0, std::memory_order_relaxed);
    audio_dropped_.store(0, std::memory_order_relaxed);
    audio_lead_ms_.store(0, std::memory_order_relaxed);
    if (!impl_) return;
#if defined(__EMSCRIPTEN__) && defined(TIZEN_WASM_SDK)
    if (impl_->has_track) {
        impl_->audio_track.SetListener(nullptr);
    }
    impl_->track_open.store(false, std::memory_order_release);
    impl_->has_track = false;
#endif
    std::lock_guard<std::mutex> lk(impl_->opus_mu);
#ifdef NIGHTJAR_HAVE_OPUS
    if (impl_->decoder) {
        opus_multistream_decoder_destroy(impl_->decoder);
        impl_->decoder = nullptr;
    }
#endif
}

} // namespace nightjar::tizen
