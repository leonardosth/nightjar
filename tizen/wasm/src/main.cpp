#include "host_http_client.hpp"
#include "nightjar_session.hpp"

#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/html5.h>

namespace {

nightjar::tizen::HostHttpClient g_http;
std::unique_ptr<nightjar::tizen::NightjarSession> g_session;
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

EM_BOOL on_raf(double /*time*/, void* /*user_data*/) {
    if (g_session) {
        g_session->on_display_refresh();
        return EM_TRUE;
    }
    return EM_FALSE;
}

std::string init_identity(const std::string& unique_id, const std::string& cert_pem, const std::string& key_pem) {
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
       << ",\"error\":\"" << json_escape(info.raw_error) << "\"}";
    return os.str();
}

std::string pair_host_impl(const std::string& address, const std::string& pin) {
    std::string err;
    bool ok = g_http.pair_with_pin(address, pin, err);
    std::ostringstream os;
    os << "{\"ok\":" << (ok ? "true" : "false")
       << ",\"error\":\"" << json_escape(err) << "\"}";
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

// Spawns network/socket operations on a pthread Web Worker where Samsung's Tizen Sockets Extension lives
int start_async_job(const std::string& op, const std::string& arg1, const std::string& arg2) {
    int id = g_next_job_id.fetch_add(1, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lk(g_jobs_mutex);
        g_jobs[id] = AsyncJobResult{false, "{}"};
    }

    std::thread([id, op, arg1, arg2]() {
        std::string payload = "{}";
        if (op == "probe") {
            payload = probe_host_impl(arg1);
        } else if (op == "pair") {
            payload = pair_host_impl(arg1, arg2);
        } else if (op == "applist") {
            payload = list_apps_impl(arg1);
        } else if (op == "connect_stream") {
            std::string err;
            bool ok = false;
            if (g_session) {
                ok = g_session->connect_on_worker_thread(err);
            } else {
                err = "Stream media session was not prepared";
            }
            std::ostringstream os;
            os << "{\"ok\":" << (ok ? "true" : "false")
               << ",\"error\":\"" << json_escape(err) << "\"}";
            payload = os.str();
        } else {
            payload = "{\"error\":\"Unknown async op\"}";
        }

        std::lock_guard<std::mutex> lk(g_jobs_mutex);
        auto it = g_jobs.find(id);
        if (it != g_jobs.end()) {
            it->second.done = true;
            it->second.payload_json = std::move(payload);
        }
    }).detach();

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

bool prepare_stream_media(
    const std::string& address,
    int app_id,
    bool resume,
    uint32_t width,
    uint32_t height,
    uint32_t fps,
    const std::string& codec,
    uint32_t bitrate_mbps,
    bool fw_enabled,
    bool fw_lens,
    uint16_t fw_mask_width) {
    g_session = std::make_unique<nightjar::tizen::NightjarSession>(g_http);
    nightjar::tizen::StreamOptions opts;
    opts.host_address = address;
    opts.app_id = app_id;
    opts.resume = resume;
    opts.width = width;
    opts.height = height;
    opts.fps = fps;
    opts.codec = codec;
    opts.bitrate_mbps = bitrate_mbps;
    opts.frame_warp_enabled = fw_enabled;
    opts.frame_warp_lens = fw_lens;
    opts.frame_warp_mask_width = fw_mask_width;

    g_last_error.clear();
    if (!g_session->init_media_on_main_thread(opts, g_last_error)) {
        g_session.reset();
        return false;
    }
    return true;
}

void start_stream_loop() {
    if (g_session) {
        emscripten_request_animation_frame_loop(on_raf, nullptr);
    }
}

std::string last_error() { return g_last_error; }

void stop_stream() {
    if (g_session) {
        g_session->stop();
        g_session.reset();
    }
}

void set_frame_warp_enabled(bool enabled) {
    if (g_session) g_session->set_frame_warp_enabled(enabled);
}

void send_mouse(int16_t dx, int16_t dy) {
    if (g_session) g_session->send_mouse_move(dx, dy);
}

void send_controller(
    uint16_t index, int buttons, uint8_t lt, uint8_t rt,
    int16_t lx, int16_t ly, int16_t rx, int16_t ry) {
    if (g_session) g_session->send_controller_packet(index, buttons, lt, rt, lx, ly, rx, ry);
}

std::string get_frame_warp_status() {
    if (!g_session) return "{}";
    auto st = g_session->frame_warp_status();
    bool locked = st.model.has_value() && st.model->locked();
    float fov = 0.0f;
    if (st.model.has_value() && st.model->focal > 0.0f) {
        fov = 2.0f * std::atan((static_cast<float>(st.model->picture_width) * 0.5f) / st.model->focal) * 180.0f / 3.14159265f;
    }
    std::ostringstream os;
    os << "{\"negotiated\":" << (g_session->frame_warp_negotiated() ? "true" : "false")
       << ",\"locked\":" << (locked ? "true" : "false")
       << ",\"pxX\":" << st.pixels[0]
       << ",\"pxY\":" << st.pixels[1]
       << ",\"peak\":" << st.peak
       << ",\"fov\":" << fov
       << ",\"maskCells\":" << st.mask_cells
       << ",\"warped\":" << st.warped
       << ",\"extrapolated\":" << st.extrapolated
       << ",\"untagged\":" << st.untagged << "}";
    return os.str();
}

EMSCRIPTEN_BINDINGS(nightjar_tizen) {
    emscripten::function("initIdentity", &init_identity);
    emscripten::function("startAsyncJob", &start_async_job);
    emscripten::function("pollAsyncJob", &poll_async_job);
    emscripten::function("prepareStreamMedia", &prepare_stream_media);
    emscripten::function("startStreamLoop", &start_stream_loop);
    emscripten::function("probeHost", &probe_host_impl);
    emscripten::function("pairHost", &pair_host_impl);
    emscripten::function("listApps", &list_apps_impl);
    emscripten::function("lastError", &last_error);
    emscripten::function("stopStream", &stop_stream);
    emscripten::function("setFrameWarpEnabled", &set_frame_warp_enabled);
    emscripten::function("sendMouse", &send_mouse);
    emscripten::function("sendController", &send_controller);
    emscripten::function("getFrameWarpStatus", &get_frame_warp_status);
}

} // namespace
#endif

int main() {
    return 0;
}
