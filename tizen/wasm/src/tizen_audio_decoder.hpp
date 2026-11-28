#pragma once

#include "stream_telemetry.hpp"

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace nightjar::tizen {

struct AudioConfig {
    int sample_rate = 48000;
    int channel_count = 2;
    int streams = 1;
    int coupled_streams = 1;
    int samples_per_frame = 240;
    uint8_t mapping[8] = {0, 1, 0, 0, 0, 0, 0, 0};
};

/**
 * Opus multistream -> signed 16-bit PCM decoder feeding a Tizen WASM Player
 * audio ElementaryMediaTrack ("audio/webm; codecs=\"pcm\"").
 */
class TizenAudioDecoder {
public:
    TizenAudioDecoder();
    ~TizenAudioDecoder();

    void set_media_clock(std::shared_ptr<SharedMediaClock> clock);

    // Main-thread setup: attaches the PCM audio track to EMSS BEFORE source->Open().
    bool open_track_on_main_thread(int sample_rate, bool surround51, void* emss_source_ptr);
    // Worker/audio-thread setup: initializes/reconfigures OpusMSDecoder without touching EMSS tracks.
    bool reconfigure_opus(const AudioConfig& cfg);
    // Convenience wrapper (used by native unit tests when emss_source_ptr == nullptr).
    bool initialize(const AudioConfig& cfg, void* emss_source_ptr);
    void decode_and_play(const uint8_t* opus_data, size_t opus_len, uint64_t wall_now_us = 0);
    void shutdown();

    double current_pts_sec() const {
        return static_cast<double>(audio_pts_us_.load(std::memory_order_acquire)) / 1000000.0;
    }
    uint32_t audio_gaps() const { return audio_gaps_.load(std::memory_order_relaxed); }
    uint32_t audio_dropped() const { return audio_dropped_.load(std::memory_order_relaxed); }
    int audio_lead_ms() const { return audio_lead_ms_.load(std::memory_order_relaxed); }

private:
    AudioConfig cfg_{};
    bool initialized_ = false;
    std::shared_ptr<SharedMediaClock> clock_;
    std::atomic<uint64_t> samples_submitted_{0};
    bool has_audio_pts_ = false;
    int64_t next_audio_pts_us_ = 0;
    std::atomic<int64_t> audio_pts_us_{0};
    std::atomic<uint32_t> audio_gaps_{0};
    std::atomic<uint32_t> audio_dropped_{0};
    std::atomic<int> audio_lead_ms_{0};
    std::vector<int16_t> pcm_buf_;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace nightjar::tizen
