#pragma once

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

    // Main-thread setup: attaches the PCM audio track to EMSS BEFORE source->Open().
    bool open_track_on_main_thread(int sample_rate, bool surround51, void* emss_source_ptr);
    // Worker/audio-thread setup: initializes/reconfigures OpusMSDecoder without touching EMSS tracks.
    bool reconfigure_opus(const AudioConfig& cfg);
    // Convenience wrapper (used by native unit tests when emss_source_ptr == nullptr).
    bool initialize(const AudioConfig& cfg, void* emss_source_ptr);
    void decode_and_play(const uint8_t* opus_data, size_t opus_len);
    void shutdown();

    double current_pts_sec() const {
        return cfg_.sample_rate > 0
            ? static_cast<double>(samples_submitted_.load(std::memory_order_acquire)) / static_cast<double>(cfg_.sample_rate)
            : 0.0;
    }

private:
    AudioConfig cfg_{};
    bool initialized_ = false;
    std::atomic<uint64_t> samples_submitted_{0};
    std::vector<int16_t> pcm_buf_;

    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace nightjar::tizen
