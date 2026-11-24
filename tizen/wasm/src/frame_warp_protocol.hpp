#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <vector>

namespace nightjar::frame_warp {

// Control stream message IDs (SS_ENC_CONTROL_V2, little-endian)
constexpr uint16_t kMsgRequest = 0x5543;
constexpr uint16_t kMsgModel   = 0x5544;
constexpr uint16_t kMsgTags    = 0x5545;
constexpr uint16_t kMsgMask    = 0x5546;

constexpr uint8_t  kVersion         = 1;
constexpr size_t   kRequestBytes    = 8;
constexpr size_t   kTagsHeaderBytes = 4;
constexpr size_t   kTagBytes        = 20;
constexpr size_t   kMaxTags         = 4;
constexpr size_t   kModelBytes      = 52;
constexpr size_t   kModelFlatBytes  = 48;
constexpr size_t   kMaskHeaderBytes = 8;
constexpr uint16_t kMaxMaskEdge     = 2048;
constexpr size_t   kMaxMaskPayload  = 48 * 1024;
constexpr uint8_t  kMaxControllers  = 16;
constexpr uint8_t  kNoController    = 0xFF;
constexpr uint32_t kHeldNone        = 0xFFFFFFFFu;
constexpr float    kMaxStickDeadzone = 0.5f;
constexpr float    kMaxGain          = 100000.0f;
constexpr float    kMinFocal         = 1.0f;
constexpr float    kMaxFocal         = 1000000.0f;

struct FrameWarpRequest {
    bool enabled = false;
    std::optional<uint8_t> controller;
    uint16_t mask_max_width = 1024;
    bool lens = true;

    std::array<uint8_t, kRequestBytes> encode() const;
    static std::optional<FrameWarpRequest> decode(const uint8_t* data, size_t len);
};

struct Tag {
    uint32_t frame = 0;
    int32_t mouse_x = 0;
    int32_t mouse_y = 0;
    uint32_t controller_seq = 0;
    uint32_t controller_held_us = kHeldNone;
};

struct Tags {
    uint16_t model_generation = 0;
    std::vector<Tag> tags;

    std::optional<std::vector<uint8_t>> encode() const;
    static std::optional<Tags> decode(const uint8_t* data, size_t len);
};

struct Model {
    uint16_t generation = 0;
    bool mouse_locked = false;
    bool stick_locked = false;
    uint16_t picture_width = 1;
    uint16_t picture_height = 1;
    std::array<float, 2> mouse_gain = {0.0f, 0.0f};
    std::array<float, 2> stick_gain = {0.0f, 0.0f};
    float stick_deadzone = 0.0f;
    float stick_exponent = 1.0f;
    std::array<float, 2> max_offset = {0.0f, 0.0f};
    uint32_t lag_us = 0;
    float confidence = 0.0f;
    float focal = 0.0f;

    bool locked() const { return mouse_locked || stick_locked; }
    bool valid() const;
    std::optional<std::array<uint8_t, kModelBytes>> encode() const;
    static std::optional<Model> decode(const uint8_t* data, size_t len);
};

struct Mask {
    uint16_t generation = 0;
    uint16_t width = 0;
    uint16_t height = 0;
    std::vector<uint32_t> words;

    static size_t stride(uint16_t w) { return (static_cast<size_t>(w) + 31u) / 32u; }
    static Mask create(uint16_t gen, uint16_t w, uint16_t h);

    bool get(uint16_t x, uint16_t y) const;
    void set(uint16_t x, uint16_t y, bool on);
    bool is_clear() const;
    size_t count() const;
    std::vector<uint8_t> pack_r8() const;
    Mask halved() const;

    std::optional<std::vector<uint8_t>> encode() const;
    static std::optional<Mask> decode(const uint8_t* data, size_t len);
};

std::array<float, 2> stick_curve(int16_t x, int16_t y, float deadzone, float exponent);

} // namespace nightjar::frame_warp
