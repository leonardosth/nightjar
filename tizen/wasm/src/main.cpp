#include "nightjar_session.hpp"

#include <memory>

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/html5.h>

namespace {

std::unique_ptr<nightjar::tizen::NightjarSession> g_session;

EM_BOOL on_raf(double /*time*/, void* /*user_data*/) {
    if (g_session) {
        g_session->on_display_refresh();
        return EM_TRUE;
    }
    return EM_FALSE;
}

bool start_stream(
    const std::string& address,
    uint32_t width,
    uint32_t height,
    uint32_t fps,
    const std::string& codec,
    uint32_t bitrate_mbps,
    bool fw_enabled,
    bool fw_lens,
    uint16_t fw_mask_width) {
    g_session = std::make_unique<nightjar::tizen::NightjarSession>();
    nightjar::tizen::StreamOptions opts;
    opts.host_address = address;
    opts.width = width;
    opts.height = height;
    opts.fps = fps;
    opts.codec = codec;
    opts.bitrate_mbps = bitrate_mbps;
    opts.frame_warp_enabled = fw_enabled;
    opts.frame_warp_lens = fw_lens;
    opts.frame_warp_mask_width = fw_mask_width;

    if (!g_session->start(opts)) {
        g_session.reset();
        return false;
    }
    emscripten_request_animation_frame_loop(on_raf, nullptr);
    return true;
}

void stop_stream() {
    if (g_session) {
        g_session->stop();
        g_session.reset();
    }
}

void send_mouse(int16_t dx, int16_t dy) {
    if (g_session) g_session->send_mouse_move(dx, dy);
}

void send_controller(uint16_t index, int16_t rx, int16_t ry) {
    if (g_session) g_session->send_controller_packet(index, rx, ry);
}

EMSCRIPTEN_BINDINGS(nightjar_tizen) {
    emscripten::function("startStream", &start_stream);
    emscripten::function("stopStream", &stop_stream);
    emscripten::function("sendMouse", &send_mouse);
    emscripten::function("sendController", &send_controller);
}

} // namespace
#endif

int main() {
    return 0;
}
