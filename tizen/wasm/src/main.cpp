#include "host_http_client.hpp"
#include "nightjar_session.hpp"
#include "worker_queue.hpp"

#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <sstream>
#include <unordered_map>

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/html5.h>

namespace {

nightjar::tizen::HostHttpClient g_http;
nightjar::tizen::WorkerQueue g_worker;
std::mutex g_session_mutex;
std::shared_ptr<nightjar::tizen::NightjarSession> g_session;
std::string g_last_error;

struct AsyncJobResult {
    bool done = false;
    std::string payload_json;
};

std::mutex g_jobs_mutex;
std::unordered_map<int, AsyncJobResult> g_jobs;
std::atomic<int> g_next_job_id{1};

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '"' || c == '\\') { out.push_back('\\'); out.push_back(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else out.push_back(c);
    }
    return out;
}

std::shared_ptr<nightjar::tizen::NightjarSession> get_session() {
    std::lock_guard<std::mutex> lk(g_session_mutex);
    return g_session;
}

EM_BOOL on_raf(double /*time*/, void* /*user_data*/) {
    auto s = get_session();
    if (s) {
        s->on_display_refresh();
        return EM_TRUE;
    }
    return EM_FALSE;
}

std::string init_identity_impl(const std::string& unique_id, const std::string& cert_pem, const std::string& key_pem) {
    g_http.init_identity(unique_id, cert_pem, key_pem);
    const auto& id = g_http.identity();
    std::ostringstream os;
    os << "{\"uniqueId\":\"" << json_escape(id.unique_id)
       << "\",\"certPem\":\"" << json_escape(id.cert_pem)
       << "\",\"keyPem\":\"" << json_escape(id.key_pem) << "\"}";
    return os.str();
}

std::string probe_host_impl(const std::string& address) {
    auto info = g_http.fetch_serverinfo(address);
    std::ostringstream os;
    os << "{\"hostname\":\"" << json_escape(info.hostname)
       << "\",\"paired\":" << (info.paired ? "true" : "false")
       << ",\"currentGame\":" << info.current_game
       << ",\"frameWarpVersion\":" << info.frame_warp_version
       << ",\"codecSupport\":" << info.server_codec_mode_support
       << ",\"error\":\"" << json_escape(info.raw_error) << "\"}";
    return os.str();
}

std::string pair_host_impl(const std::string& address, const std::string& pin) {
    std::string err;
    bool ok = g_http.pair_with_pin(address, pin, err);
    std::string pinned = ok ? g_http.pinned_server_cert(address) : std::string();
    std::ostringstream os;
    os << "{\"ok\":" << (ok ? "true" : "false")
       << ",\"serverCertPem\":\"" << json_escape(pinned)
       << "\",\"error\":\"" << json_escape(err) << "\"}";
    return os.str();
}

std::string list_apps_impl(const std::string& address) {
    std::string err;
    auto apps = g_http.fetch_applist(address, err);
    std::ostringstream os;
    os << "{\"error\":\"" << json_escape(err) << "\",\"apps\":[";
    for (size_t i = 0; i < apps.size(); ++i) {
        if (i > 0) os << ",";
        os << "{\"id\":" << apps[i].id
           << ",\"title\":\"" << json_escape(apps[i].title)
           << "\",\"hdr\":" << (apps[i].hdr_supported ? "true" : "false") << "}";
    }
    os << "]}";
    return os.str();
}

// Dispatches all network/socket/crypto operations onto the single persistent pthread WorkerQueue
int start_async_job(const std::string& op, const std::string& arg1, const std::string& arg2, const std::string& arg3) {
    if (op == "cancel_pair") {
        g_http.cancel_pending_pairing();
        int id = g_next_job_id.fetch_add(1, std::memory_order_relaxed);
        std::lock_guard<std::mutex> lk(g_jobs_mutex);
        g_jobs[id] = AsyncJobResult{true, "{\"ok\":true}"};
        return id;
    }

    int id = g_next_job_id.fetch_add(1, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lk(g_jobs_mutex);
        g_jobs[id] = AsyncJobResult{false, "{}"};
    }

    g_worker.enqueue([id, op, arg1, arg2, arg3]() {
        std::string payload = "{}";
        if (op == "init_identity") {
            payload = init_identity_impl(arg1, arg2, arg3);
        } else if (op == "probe") {
            payload = probe_host_impl(arg1);
        } else if (op == "pair") {
            payload = pair_host_impl(arg1, arg2);
        } else if (op == "applist") {
            payload = list_apps_impl(arg1);
        } else if (op == "cancel_app") {
            bool ok = g_http.cancel_app(arg1);
            payload = ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"Cancel app failed\"}";
        } else if (op == "connect_stream") {
            std::string err;
            bool ok = false;
            auto s = get_session();
            if (s) {
                ok = s->connect_on_worker_thread(err);
            } else {
                err = "Stream media session was not prepared";
            }
            std::ostringstream os;
            os << "{\"ok\":" << (ok ? "true" : "false")
               << ",\"error\":\"" << json_escape(err) << "\"}";
            payload = os.str();
        } else if (op == "stop_stream") {
            std::shared_ptr<nightjar::tizen::NightjarSession> old;
            {
                std::lock_guard<std::mutex> lk(g_session_mutex);
                old = std::move(g_session);
            }
            if (old) {
                old->stop_network_on_worker();
            }
            payload = "{\"ok\":true}";
        } else {
            payload = "{\"error\":\"Unknown async op\"}";
        }

        std::lock_guard<std::mutex> lk(g_jobs_mutex);
        auto it = g_jobs.find(id);
        if (it != g_jobs.end()) {
            it->second.done = true;
            it->second.payload_json = std::move(payload);
        }
    });

    return id;
}

std::string poll_async_job(int id) {
    std::lock_guard<std::mutex> lk(g_jobs_mutex);
    auto it = g_jobs.find(id);
    if (it == g_jobs.end()) {
        return "{\"done\":true,\"payload\":{\"error\":\"Invalid job id\"}}";
    }
    if (!it->second.done) {
        return "{\"done\":false}";
    }
    std::string out = "{\"done\":true,\"payload\":" + it->second.payload_json + "}";
    g_jobs.erase(it);
    return out;
}

void set_pinned_cert(const std::string& address, const std::string& cert_pem) {
    g_http.set_pinned_server_cert(address, cert_pem);
}

std::string get_pinned_cert(const std::string& address) {
    return g_http.pinned_server_cert(address);
}

bool prepare_stream_media(
    const std::string& address,
    int app_id,
    bool resume,
    uint32_t width,
    uint32_t height,
    uint32_t fps,
    const std::string& codec,
    uint32_t bitrate_mbps,
    bool hdr,
    bool surround51,
    bool fw_enabled,
    bool use_video_texture) {
    auto session = std::make_shared<nightjar::tizen::NightjarSession>(g_http);
    nightjar::tizen::StreamOptions opts;
    opts.host_address = address;
    opts.app_id = app_id;
    opts.resume = resume;
    opts.width = width;
    opts.height = height;
    opts.fps = fps;
    opts.codec = codec;
    opts.bitrate_mbps = bitrate_mbps;
    opts.hdr = hdr;
    opts.surround51 = surround51;
    opts.frame_warp_enabled = fw_enabled;
    opts.frame_warp_lens = true;
    opts.frame_warp_mask_width = 1024;
    opts.use_video_texture = use_video_texture;

    g_last_error.clear();
    if (!session->init_media_on_main_thread(opts, g_last_error)) {
        return false;
    }
    {
        std::lock_guard<std::mutex> lk(g_session_mutex);
        g_session = std::move(session);
    }
    return true;
}

void start_stream_loop() {
    if (get_session()) {
        emscripten_request_animation_frame_loop(on_raf, nullptr);
    }
}

void shutdown_media_on_main_thread() {
    auto s = get_session();
    if (s) s->shutdown_media_on_main_thread();
}

std::string last_error() { return g_last_error; }

void set_frame_warp_enabled(bool enabled) {
    if (auto s = get_session()) s->set_frame_warp_enabled(enabled);
}

void send_mouse(int16_t dx, int16_t dy) {
    if (auto s = get_session()) s->send_mouse_move(dx, dy);
}

void send_mouse_button(uint8_t action, int button) {
    if (auto s = get_session()) s->send_mouse_button(action, button);
}

void send_mouse_wheel(int8_t clicks) {
    if (auto s = get_session()) s->send_mouse_wheel(clicks);
}

void send_key(int16_t key_code, uint8_t action, uint8_t modifiers) {
    if (auto s = get_session()) s->send_key(key_code, action, modifiers);
}

void send_controller_arrival(uint8_t index, uint16_t active_mask) {
    if (auto s = get_session()) s->send_controller_arrival(index, active_mask);
}

void send_controller(
    uint16_t index, uint16_t active_mask, int buttons, uint8_t lt, uint8_t rt,
    int16_t lx, int16_t ly, int16_t rx, int16_t ry) {
    if (auto s = get_session()) {
        s->send_controller_packet(index, active_mask, buttons, lt, rt, lx, ly, rx, ry);
    }
}

std::string poll_session_events() {
    auto s = get_session();
    if (!s) return "[]";
    auto evs = s->drain_events();
    std::ostringstream os;
    os << "[";
    for (size_t i = 0; i < evs.size(); ++i) {
        if (i > 0) os << ",";
        os << "{\"type\":\"" << json_escape(evs[i].type)
           << "\",\"code\":" << evs[i].code << "}";
    }
    os << "]";
    return os.str();
}

std::string get_frame_warp_status() {
    auto s = get_session();
    if (!s) return "{}";
    auto st = s->frame_warp_status();
    auto stats = s->session_stats();
    bool locked = st.model.has_value() && st.model->locked();
    float fov = 0.0f;
    if (st.model.has_value() && st.model->focal > 0.0f) {
        fov = 2.0f * std::atan((static_cast<float>(st.model->picture_width) * 0.5f) / st.model->focal) * 180.0f / 3.14159265f;
    }
    std::ostringstream os;
    os << "{\"negotiated\":" << (s->frame_warp_negotiated() ? "true" : "false")
       << ",\"locked\":" << (locked ? "true" : "false")
       << ",\"pxX\":" << st.pixels[0]
       << ",\"pxY\":" << st.pixels[1]
       << ",\"peak\":" << st.peak
       << ",\"fov\":" << fov
       << ",\"maskCells\":" << st.mask_cells
       << ",\"warped\":" << st.warped
       << ",\"extrapolated\":" << st.extrapolated
       << ",\"untagged\":" << st.untagged
       << ",\"rxFps\":" << stats.rx_fps
       << ",\"decodedFps\":" << stats.decoded_fps
       << ",\"renderedFps\":" << stats.rendered_fps
       << ",\"hdrActive\":" << (stats.hdr_active ? "true" : "false")
       << ",\"directScanout\":" << (stats.direct_scanout ? "true" : "false") << "}";
    return os.str();
}

EMSCRIPTEN_BINDINGS(nightjar_tizen) {
    emscripten::function("startAsyncJob", &start_async_job);
    emscripten::function("pollAsyncJob", &poll_async_job);
    emscripten::function("setPinnedCert", &set_pinned_cert);
    emscripten::function("getPinnedCert", &get_pinned_cert);
    emscripten::function("prepareStreamMedia", &prepare_stream_media);
    emscripten::function("startStreamLoop", &start_stream_loop);
    emscripten::function("shutdownMedia", &shutdown_media_on_main_thread);
    emscripten::function("lastError", &last_error);
    emscripten::function("setFrameWarpEnabled", &set_frame_warp_enabled);
    emscripten::function("sendMouse", &send_mouse);
    emscripten::function("sendMouseButton", &send_mouse_button);
    emscripten::function("sendMouseWheel", &send_mouse_wheel);
    emscripten::function("sendKey", &send_key);
    emscripten::function("sendControllerArrival", &send_controller_arrival);
    emscripten::function("sendController", &send_controller);
    emscripten::function("pollSessionEvents", &poll_session_events);
    emscripten::function("getFrameWarpStatus", &get_frame_warp_status);
}

} // namespace
#endif

int main() {
    return 0;
}
