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

    // emss_source_ptr is a `samsung::wasm::ElementaryMediaStreamSource*` under TIZEN_WASM_SDK
    // and may be nullptr in native unit tests.
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
