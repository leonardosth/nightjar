#include "frame_warp_predictor.hpp"
#include "frame_warp_protocol.hpp"

#include <cassert>
#include <cmath>
#include <iostream>

using namespace nightjar::frame_warp;

int main() {
    // 1. Request encode/decode
    FrameWarpRequest req{true, 3, 960, true};
    auto req_bytes = req.encode();
    assert(req_bytes[0] == 1 && req_bytes[1] == 1 && req_bytes[2] == 3 && req_bytes[3] == 1);
    auto req_dec = FrameWarpRequest::decode(req_bytes.data(), req_bytes.size());
    assert(req_dec.has_value() && req_dec->enabled && req_dec->controller == 3 && req_dec->mask_max_width == 960 && req_dec->lens);

    // 2. Model 52B & 48B decode
    Model m;
    m.generation = 7;
    m.mouse_locked = true;
    m.stick_locked = true;
    m.picture_width = 1920;
    m.picture_height = 1080;
    m.mouse_gain = {-2.0f, -2.0f};
    m.stick_gain = {-600.0f, 600.0f};
    m.stick_deadzone = 0.1f;
    m.stick_exponent = 2.0f;
    m.max_offset = {300.0f, 200.0f};
    m.lag_us = 25000;
    m.confidence = 0.95f;
    m.focal = 960.0f;
    auto m_bytes = m.encode();
    assert(m_bytes.has_value());
    auto m_dec = Model::decode(m_bytes->data(), m_bytes->size());
    assert(m_dec.has_value() && std::fabs(m_dec->focal - 960.0f) < 1e-4f);
    auto m_flat = Model::decode(m_bytes->data(), kModelFlatBytes);
    assert(m_flat.has_value() && m_flat->focal == 0.0f);

    // 3. HUD Mask LEB128 RLE + pack_r8 + halved
    Mask mask = Mask::create(2, 64, 32);
    mask.set(0, 0, true);
    mask.set(63, 31, true);
    mask.set(10, 5, true);
    auto mask_bytes = mask.encode();
    assert(mask_bytes.has_value());
    auto mask_dec = Mask::decode(mask_bytes->data(), mask_bytes->size());
    assert(mask_dec.has_value() && mask_dec->count() == 3 && mask_dec->get(0, 0) && mask_dec->get(63, 31));
    auto r8 = mask_dec->pack_r8();
    assert(r8.size() == 64 * 32 && r8[0] == 255 && r8[31 * 64 + 63] == 255 && r8[1] == 0);
    auto half = mask_dec->halved();
    assert(half.width == 32 && half.height == 16 && half.get(0, 0) && half.get(31, 15));

    // 4. Predictor shift + fade + lens
    Predictor pred(0);
    pred.on_model(m);
    pred.note_mouse(50, 0, 10000);
    Tags tags{7, {Tag{10, 20, 0, 0, kHeldNone}}};
    pred.on_tags(tags, 10000);
    // Ramp fade over 150ms
    (void)pred.warp(10, 10000);
    auto w = pred.warp(10, 160000);
    assert(w.active);
    // delta mouse = 30, gain = -2 => -60 px flat, with focal=960 => 960 * tan(-60/960) ~= -60.08 px
    assert(w.pixels[0] < -59.0f && w.pixels[0] > -61.5f);

    std::cout << "All C++ Frame Warp tests passed!\n";
    return 0;
}
