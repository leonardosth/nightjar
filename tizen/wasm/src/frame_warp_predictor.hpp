#pragma once

#include "frame_warp_protocol.hpp"

#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

namespace nightjar::frame_warp {

constexpr uint64_t kRebaseIdleUs     = 600000;
constexpr uint64_t kFadeUs           = 150000;
constexpr uint64_t kMaxStickWindowUs = 400000;
constexpr uint32_t kMaxExtrapolation = 4;
constexpr size_t   kTagSlots         = 64;
constexpr uint64_t kStickHistoryUs   = kMaxStickWindowUs + 600000;
constexpr size_t   kStickSamples     = 4096;
constexpr int64_t  kMouseSanity      = 200000;
constexpr float    kRepeatStepPx     = 0.25f;
constexpr std::array<float, 4> kFlatLens = {0.0f, 0.0f, 1.0f, 1.0f};

struct Warp {
    std::array<float, 2> pixels = {0.0f, 0.0f};
    std::array<float, 2> uv     = {0.0f, 0.0f};
    std::array<float, 4> lens   = kFlatLens;
    bool active = false;
    std::optional<uint16_t> mask_generation;
};

struct Status {
    std::optional<Model> model;
    std::array<float, 2> pixels = {0.0f, 0.0f};
    float peak = 0.0f;
    uint64_t warped = 0;
    uint64_t extrapolated = 0;
    uint64_t untagged = 0;
    size_t mask_cells = 0;
};

std::pair<std::array<float, 2>, std::array<float, 4>> lens_terms(
    std::array<float, 2> pixels, float focal, uint16_t width, uint16_t height);

class FrameRing {
public:
    static constexpr size_t kCapacity = 128;

    void note(int64_t pts_us, uint32_t frame_number);
    std::optional<uint32_t> lookup(int64_t pts_us) const;
    std::optional<uint32_t> lookup_nearest(int64_t pts_us, int64_t tolerance_us) const;
    void clear();

private:
    struct Entry {
        int64_t pts_us = 0;
        uint32_t frame = 0;
        bool valid = false;
    };
    std::array<Entry, kCapacity> entries_{};
    size_t next_ = 0;
};

class Predictor {
public:
    explicit Predictor(std::optional<uint8_t> controller = 0);

    void reset();
    void note_mouse(int16_t dx, int16_t dy, uint64_t now_us);
    void note_controller(uint16_t number, int16_t rx, int16_t ry, uint64_t now_us);
    void on_model(const Model& model);
    void on_mask(std::optional<uint16_t> generation, size_t cells);
    void on_tags(const Tags& tags, uint64_t now_us);

    Warp warp(uint32_t frame, uint64_t now_us);
    Warp peek(uint32_t frame, uint64_t now_us);
    Status status(uint64_t now_us) const;

private:
    struct StickSample {
        uint64_t at_us;
        uint32_t seq;
        int16_t rx;
        int16_t ry;
    };

    std::optional<std::pair<Tag, bool>> lookup_tag(uint32_t frame) const;
    const StickSample* stick_sample(uint32_t seq) const;
    std::array<float, 2> stick_unreflected(const Tag& tag, const Model& model, uint64_t now_us) const;
    void update_weight(bool locked, uint64_t now_us);
    Warp compute_shift(uint32_t frame, uint64_t now_us, bool drawn);
    void record(std::array<float, 2> shift, uint64_t now_us);

    std::optional<uint8_t> controller_;
    std::optional<Model> model_;
    std::optional<Model> fading_;
    float weight_ = 0.0f;
    std::optional<uint64_t> weight_at_us_;
    std::array<std::optional<Tag>, kTagSlots> tags_{};
    std::optional<uint32_t> newest_;
    int32_t mouse_x_ = 0;
    int32_t mouse_y_ = 0;
    int32_t mouse_offset_x_ = 0;
    int32_t mouse_offset_y_ = 0;
    std::optional<uint64_t> last_mouse_us_;
    uint32_t controller_seq_ = 0;
    uint32_t seq_offset_ = 0;
    std::optional<uint64_t> last_controller_us_;
    std::deque<StickSample> stick_;
    std::optional<uint16_t> mask_generation_;
    size_t mask_cells_ = 0;
    std::array<float, 2> last_ = {0.0f, 0.0f};
    std::deque<std::pair<uint64_t, float>> peaks_;
    uint64_t warped_ = 0;
    uint64_t extrapolated_ = 0;
    uint64_t untagged_ = 0;
};

class FrameWarp {
public:
    FrameWarp(std::optional<uint8_t> controller, uint16_t mask_max_width);

    FrameWarpRequest request(bool enabled, bool lens = true);
    void note_mouse(int16_t dx, int16_t dy, uint64_t now_us);
    void note_controller(uint16_t number, int16_t rx, int16_t ry, uint64_t now_us);
    void on_model(const Model& model);
    void on_tags(const Tags& tags, uint64_t now_us);
    void on_mask(Mask mask);

    Warp warp(uint32_t frame, uint64_t now_us);
    Warp peek(uint32_t frame, uint64_t now_us);
    Status status(uint64_t now_us);

    // Returns true if mask changed compared to known_gen; writes nullptr when cleared.
    bool mask_since(std::optional<uint16_t> known_gen, std::shared_ptr<const Mask>& out);

    uint32_t input_seq() const { return input_seq_.load(std::memory_order_acquire); }
    bool stick_deflected() const;

    void note_frame_pts(int64_t pts_us, uint32_t frame_number);
    std::optional<uint32_t> lookup_frame_pts(int64_t pts_us);
    std::optional<uint32_t> lookup_frame_pts_nearest(int64_t pts_us, int64_t tolerance_us);

private:
    std::optional<uint8_t> controller_;
    uint16_t mask_max_width_;
    std::mutex mu_;
    Predictor predictor_;
    std::shared_ptr<const Mask> mask_;
    FrameRing frame_ring_;
    std::atomic<bool> started_{false};
    std::atomic<uint32_t> input_seq_{0};
    std::atomic<uint32_t> stick_packed_{0};
    std::atomic<uint32_t> deadzone_bits_{0};
};

} // namespace nightjar::frame_warp
