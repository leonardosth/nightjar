#include "frame_warp_protocol.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace nightjar::frame_warp {

namespace {

constexpr uint8_t kMaskNone = 0;
constexpr uint8_t kMaskRuns = 1;

uint16_t read_u16(const uint8_t* p) {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

uint32_t read_u32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

int32_t read_i32(const uint8_t* p) {
    uint32_t u = read_u32(p);
    int32_t s = 0;
    std::memcpy(&s, &u, sizeof(s));
    return s;
}

float read_f32(const uint8_t* p) {
    uint32_t u = read_u32(p);
    float f = 0.0f;
    std::memcpy(&f, &u, sizeof(f));
    return f;
}

void write_u16(uint8_t* p, uint16_t v) {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
}

void write_u32(uint8_t* p, uint32_t v) {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8) & 0xFFu);
    p[2] = static_cast<uint8_t>((v >> 16) & 0xFFu);
    p[3] = static_cast<uint8_t>((v >> 24) & 0xFFu);
}

void write_f32(uint8_t* p, float f) {
    uint32_t u = 0;
    std::memcpy(&u, &f, sizeof(u));
    write_u32(p, u);
}

void write_leb128(std::vector<uint8_t>& out, uint16_t value) {
    while (true) {
        uint8_t byte = static_cast<uint8_t>(value & 0x7Fu);
        value >>= 7;
        if (value == 0) {
            out.push_back(byte);
            return;
        }
        out.push_back(static_cast<uint8_t>(byte | 0x80u));
    }
}

std::optional<uint16_t> read_leb128(const uint8_t* data, size_t len, size_t& at) {
    uint32_t value = 0;
    for (uint32_t shift : {0u, 7u, 14u}) {
        if (at >= len) return std::nullopt;
        uint8_t byte = data[at++];
        value |= static_cast<uint32_t>(byte & 0x7Fu) << shift;
        if ((byte & 0x80u) == 0) {
            if (value <= kMaxMaskEdge) return static_cast<uint16_t>(value);
            return std::nullopt;
        }
    }
    return std::nullopt;
}

bool is_valid_exponent(float e) {
    return e == 1.0f || e == 1.5f || e == 2.0f || e == 2.5f || e == 3.0f;
}

} // namespace

std::array<uint8_t, kRequestBytes> FrameWarpRequest::encode() const {
    std::array<uint8_t, kRequestBytes> out{};
    uint16_t w = std::min(mask_max_width, kMaxMaskEdge);
    uint8_t ctrl = (controller.has_value() && *controller < kMaxControllers)
        ? *controller
        : kNoController;
    out[0] = kVersion;
    out[1] = enabled ? 1 : 0;
    out[2] = ctrl;
    out[3] = lens ? 1 : 0;
    write_u16(&out[4], w);
    out[6] = 0;
    out[7] = 0;
    return out;
}

std::optional<FrameWarpRequest> FrameWarpRequest::decode(const uint8_t* data, size_t len) {
    if (!data || len < kRequestBytes || data[0] == 0 || data[1] > 1) return std::nullopt;
    std::optional<uint8_t> ctrl;
    if (data[2] == kNoController) {
        ctrl = std::nullopt;
    } else if (data[2] < kMaxControllers) {
        ctrl = data[2];
    } else {
        return std::nullopt;
    }
    uint16_t w = read_u16(&data[4]);
    if (w > kMaxMaskEdge) return std::nullopt;
    return FrameWarpRequest{
        data[1] == 1,
        ctrl,
        w,
        (data[3] & 1u) != 0,
    };
}

std::optional<std::vector<uint8_t>> Tags::encode() const {
    if (tags.empty() || tags.size() > kMaxTags) return std::nullopt;
    std::vector<uint8_t> out(kTagsHeaderBytes + tags.size() * kTagBytes);
    out[0] = kVersion;
    out[1] = static_cast<uint8_t>(tags.size());
    write_u16(&out[2], model_generation);
    for (size_t i = 0; i < tags.size(); ++i) {
        uint8_t* base = &out[kTagsHeaderBytes + i * kTagBytes];
        write_u32(base + 0, tags[i].frame);
        write_u32(base + 4, static_cast<uint32_t>(tags[i].mouse_x));
        write_u32(base + 8, static_cast<uint32_t>(tags[i].mouse_y));
        write_u32(base + 12, tags[i].controller_seq);
        write_u32(base + 16, tags[i].controller_held_us);
    }
    return out;
}

std::optional<Tags> Tags::decode(const uint8_t* data, size_t len) {
    if (!data || len < kTagsHeaderBytes || data[0] == 0) return std::nullopt;
    size_t count = data[1];
    if (count == 0 || count > kMaxTags || len < kTagsHeaderBytes + count * kTagBytes) {
        return std::nullopt;
    }
    Tags out;
    out.model_generation = read_u16(&data[2]);
    out.tags.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        const uint8_t* base = &data[kTagsHeaderBytes + i * kTagBytes];
        out.tags.push_back(Tag{
            read_u32(base + 0),
            read_i32(base + 4),
            read_i32(base + 8),
            read_u32(base + 12),
            read_u32(base + 16),
        });
    }
    return out;
}

bool Model::valid() const {
    auto valid_gain = [](float g) { return std::isfinite(g) && std::fabs(g) <= kMaxGain; };
    auto valid_offset = [](float m) { return std::isfinite(m) && m >= 0.0f && m <= 65535.0f; };
    return picture_width > 0 &&
           picture_height > 0 &&
           valid_gain(mouse_gain[0]) && valid_gain(mouse_gain[1]) &&
           valid_gain(stick_gain[0]) && valid_gain(stick_gain[1]) &&
           std::isfinite(stick_deadzone) && stick_deadzone >= 0.0f && stick_deadzone <= kMaxStickDeadzone &&
           is_valid_exponent(stick_exponent) &&
           valid_offset(max_offset[0]) && valid_offset(max_offset[1]) &&
           std::isfinite(confidence) && confidence >= 0.0f && confidence <= 1.0f &&
           std::isfinite(focal) && (focal == 0.0f || (focal >= kMinFocal && focal <= kMaxFocal));
}

std::optional<std::array<uint8_t, kModelBytes>> Model::encode() const {
    if (!valid()) return std::nullopt;
    std::array<uint8_t, kModelBytes> out{};
    out[0] = kVersion;
    out[1] = static_cast<uint8_t>((mouse_locked ? 1u : 0u) | (stick_locked ? 2u : 0u));
    write_u16(&out[2], generation);
    write_u16(&out[4], picture_width);
    write_u16(&out[6], picture_height);
    write_f32(&out[8], mouse_gain[0]);
    write_f32(&out[12], mouse_gain[1]);
    write_f32(&out[16], stick_gain[0]);
    write_f32(&out[20], stick_gain[1]);
    write_f32(&out[24], stick_deadzone);
    write_f32(&out[28], stick_exponent);
    write_f32(&out[32], max_offset[0]);
    write_f32(&out[36], max_offset[1]);
    write_u32(&out[40], lag_us);
    write_f32(&out[44], confidence);
    write_f32(&out[48], focal);
    return out;
}

std::optional<Model> Model::decode(const uint8_t* data, size_t len) {
    if (!data || len < kModelFlatBytes || data[0] == 0 || (data[1] & ~0b11u) != 0) {
        return std::nullopt;
    }
    Model m;
    m.generation = read_u16(&data[2]);
    m.mouse_locked = (data[1] & 1u) != 0;
    m.stick_locked = (data[1] & 2u) != 0;
    m.picture_width = read_u16(&data[4]);
    m.picture_height = read_u16(&data[6]);
    m.mouse_gain = {read_f32(&data[8]), read_f32(&data[12])};
    m.stick_gain = {read_f32(&data[16]), read_f32(&data[20])};
    m.stick_deadzone = read_f32(&data[24]);
    m.stick_exponent = read_f32(&data[28]);
    m.max_offset = {read_f32(&data[32]), read_f32(&data[36])};
    m.lag_us = read_u32(&data[40]);
    m.confidence = read_f32(&data[44]);
    m.focal = len >= kModelBytes ? read_f32(&data[48]) : 0.0f;
    if (!m.valid()) return std::nullopt;
    return m;
}

Mask Mask::create(uint16_t gen, uint16_t w, uint16_t h) {
    Mask m;
    m.generation = gen;
    m.width = w;
    m.height = h;
    m.words.assign(stride(w) * static_cast<size_t>(h), 0u);
    return m;
}

bool Mask::get(uint16_t x, uint16_t y) const {
    if (x >= width || y >= height) return false;
    size_t at = static_cast<size_t>(y) * stride(width) + static_cast<size_t>(x) / 32u;
    if (at >= words.size()) return false;
    return ((words[at] >> (x % 32u)) & 1u) != 0;
}

void Mask::set(uint16_t x, uint16_t y, bool on) {
    if (x >= width || y >= height) return;
    size_t at = static_cast<size_t>(y) * stride(width) + static_cast<size_t>(x) / 32u;
    if (at >= words.size()) return;
    if (on) {
        words[at] |= (1u << (x % 32u));
    } else {
        words[at] &= ~(1u << (x % 32u));
    }
}

bool Mask::is_clear() const {
    if (width == 0 || height == 0) return true;
    for (uint32_t w : words) {
        if (w != 0) return false;
    }
    return true;
}

size_t Mask::count() const {
    size_t total = 0;
    for (uint32_t w : words) {
        w = w - ((w >> 1) & 0x55555555u);
        w = (w & 0x33333333u) + ((w >> 2) & 0x33333333u);
        total += (((w + (w >> 4)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24;
    }
    return total;
}

std::vector<uint8_t> Mask::pack_r8() const {
    std::vector<uint8_t> out(static_cast<size_t>(width) * static_cast<size_t>(height), 0u);
    for (uint16_t y = 0; y < height; ++y) {
        size_t row = static_cast<size_t>(y) * static_cast<size_t>(width);
        for (uint16_t x = 0; x < width; ++x) {
            if (get(x, y)) out[row + x] = 255u;
        }
    }
    return out;
}

Mask Mask::halved() const {
    uint16_t nw = static_cast<uint16_t>((width + 1u) / 2u);
    uint16_t nh = static_cast<uint16_t>((height + 1u) / 2u);
    Mask out = Mask::create(generation, nw, nh);
    for (uint16_t y = 0; y < height; ++y) {
        for (uint16_t x = 0; x < width; ++x) {
            if (get(x, y)) out.set(x / 2u, y / 2u, true);
        }
    }
    return out;
}

std::optional<std::vector<uint8_t>> Mask::encode() const {
    bool empty = (width == 0 || height == 0);
    if ((width == 0) != (height == 0) ||
        width > kMaxMaskEdge || height > kMaxMaskEdge ||
        words.size() != stride(width) * static_cast<size_t>(height)) {
        return std::nullopt;
    }
    std::vector<uint8_t> out(kMaskHeaderBytes);
    out[0] = kVersion;
    out[1] = empty ? kMaskNone : kMaskRuns;
    write_u16(&out[2], generation);
    write_u16(&out[4], width);
    write_u16(&out[6], height);
    for (uint16_t y = 0; y < height; ++y) {
        uint16_t x = 0;
        bool on = false;
        while (x < width) {
            uint16_t run = 0;
            while (x + run < width && get(x + run, y) == on) ++run;
            write_leb128(out, run);
            x = static_cast<uint16_t>(x + run);
            on = !on;
        }
        if (out.size() > kMaxMaskPayload) return std::nullopt;
    }
    return out;
}

std::optional<Mask> Mask::decode(const uint8_t* data, size_t len) {
    if (!data || len < kMaskHeaderBytes || len > kMaxMaskPayload || data[0] == 0) {
        return std::nullopt;
    }
    uint16_t gen = read_u16(&data[2]);
    uint16_t w = read_u16(&data[4]);
    uint16_t h = read_u16(&data[6]);
    if (w > kMaxMaskEdge || h > kMaxMaskEdge || (w == 0) != (h == 0)) return std::nullopt;
    if (data[1] == kMaskNone && w == 0) {
        return Mask::create(gen, 0, 0);
    }
    if (data[1] != kMaskRuns || w == 0) return std::nullopt;

    Mask mask = Mask::create(gen, w, h);
    size_t at = kMaskHeaderBytes;
    for (uint16_t y = 0; y < h; ++y) {
        uint16_t x = 0;
        bool on = false;
        bool first = true;
        while (x < w) {
            auto run = read_leb128(data, len, at);
            if (!run.has_value()) return std::nullopt;
            if (*run == 0 && !first) return std::nullopt;
            first = false;
            if (static_cast<uint32_t>(x) + static_cast<uint32_t>(*run) > w) return std::nullopt;
            uint16_t end = static_cast<uint16_t>(x + *run);
            if (on) {
                for (uint16_t cell = x; cell < end; ++cell) mask.set(cell, y, true);
            }
            x = end;
            on = !on;
        }
    }
    return mask;
}

std::array<float, 2> stick_curve(int16_t x, int16_t y, float deadzone, float exponent) {
    float vx = std::clamp(static_cast<float>(x) / 32767.0f, -1.0f, 1.0f);
    float vy = std::clamp(static_cast<float>(y) / 32767.0f, -1.0f, 1.0f);
    float r2 = vx * vx + vy * vy;
    if (r2 <= 0.0f) return {0.0f, 0.0f};
    float r = std::sqrt(r2);
    float dz = std::clamp(deadzone, 0.0f, kMaxStickDeadzone);
    if (r <= dz) return {0.0f, 0.0f};
    float s = std::min((r - dz) / (1.0f - dz), 1.0f);
    uint32_t halves = static_cast<uint32_t>(std::clamp(exponent, 1.0f, 3.0f) * 2.0f);
    float scaled = 1.0f;
    for (uint32_t i = 0; i < halves / 2u; ++i) scaled *= s;
    if (halves % 2u == 1u) scaled *= std::sqrt(s);
    return {(vx / r) * scaled, (vy / r) * scaled};
}

} // namespace nightjar::frame_warp
