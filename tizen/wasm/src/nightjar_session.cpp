#include "nightjar_session.hpp"

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <random>

#ifdef NIGHTJAR_HAVE_MOONLIGHT
#include <Limelight.h>
#endif

namespace nightjar::tizen {

namespace {

uint64_t steady_now_us() {
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
}

std::mutex g_active_mu;
NightjarSession* g_active_session = nullptr;

NightjarSession* active_session() {
    std::lock_guard<std::mutex> lk(g_active_mu);
    return g_active_session;
}

#ifdef NIGHTJAR_HAVE_MOONLIGHT
void cb_stage_starting(int stage) {
    if (auto* s = active_session()) s->on_stage_starting(LiGetStageName(stage));
}

void cb_stage_complete(int stage) {
    if (auto* s = active_session()) s->on_stage_complete(LiGetStageName(stage));
}

void cb_stage_failed(int stage, int error_code) {
    if (auto* s = active_session()) s->on_stage_failed(LiGetStageName(stage), error_code);
}

void cb_log_message(const char* format, ...) {
    if (!format) return;
    auto* s = active_session();
    if (!s) return;
    char buf[512];
    va_list va;
    va_start(va, format);
    std::vsnprintf(buf, sizeof(buf), format, va);
    va_end(va);
    s->on_log_message(buf);
}

void cb_connection_started() {
    if (auto* s = active_session()) s->on_connection_started();
}

void cb_connection_terminated(int error_code) {
    if (auto* s = active_session()) s->on_connection_terminated(error_code);
}

void cb_connection_status_update(int status) {
    if (auto* s = active_session()) s->on_connection_status_update(status);
}

void cb_frame_warp_packet(uint16_t msg_type, const uint8_t* data, size_t len) {
    if (auto* s = active_session()) s->on_control_packet(msg_type, data, len);
}

int cb_video_setup(int /*video_format*/, int /*width*/, int /*height*/, int /*redraw_rate*/, void* /*ctx*/, int /*dr_flags*/) {
    return 0;
}

int cb_submit_decode_unit(PDECODE_UNIT du) {
    auto* s = active_session();
    if (!s || !du) return DR_OK;
    // Fast single-buffer path when only one LENTRY exists
    if (du->bufferList && du->bufferList->next == nullptr && du->bufferList->data && du->bufferList->length > 0) {
        return s->on_video_decode_unit(
            reinterpret_cast<const uint8_t*>(du->bufferList->data),
            static_cast<size_t>(du->bufferList->length),
            static_cast<uint32_t>(du->frameNumber),
            static_cast<int64_t>(du->presentationTimeUs),
            du->frameType == FRAME_TYPE_IDR);
    }
    // Multi-LENTRY path reuses session's pre-allocated buffer via null-data sentinel
    static thread_local std::vector<uint8_t> scratch;
    scratch.clear();
    if (scratch.capacity() < static_cast<size_t>(du->fullLength)) {
        scratch.reserve(static_cast<size_t>(du->fullLength) + 65536u);
    }
    for (PLENTRY entry = du->bufferList; entry != nullptr; entry = entry->next) {
        if (entry->data && entry->length > 0) {
            scratch.insert(
                scratch.end(),
                reinterpret_cast<const uint8_t*>(entry->data),
                reinterpret_cast<const uint8_t*>(entry->data) + entry->length);
        }
    }
    return s->on_video_decode_unit(
        scratch.data(),
        scratch.size(),
        static_cast<uint32_t>(du->frameNumber),
        static_cast<int64_t>(du->presentationTimeUs),
        du->frameType == FRAME_TYPE_IDR);
}

int cb_audio_init(int /*audio_cfg*/, const POPUS_MULTISTREAM_CONFIGURATION opus_cfg, void* /*ctx*/, int /*ar_flags*/) {
    auto* s = active_session();
    if (!s || !opus_cfg) return 0;
    AudioConfig cfg;
    cfg.sample_rate = opus_cfg->sampleRate;
    cfg.channel_count = opus_cfg->channelCount;
    cfg.streams = opus_cfg->streams;
    cfg.coupled_streams = opus_cfg->coupledStreams;
    cfg.samples_per_frame = opus_cfg->samplesPerFrame;
    std::memcpy(cfg.mapping, opus_cfg->mapping, sizeof(cfg.mapping));
    return s->on_audio_init(cfg);
}

void cb_audio_decode_and_play(char* data, int length) {
    if (auto* s = active_session(); s && data && length > 0) {
        s->on_audio_packet(reinterpret_cast<const uint8_t*>(data), static_cast<size_t>(length));
    }
}
#endif

std::string random_hex_16(uint8_t out_bytes[16]) {
    std::random_device rd;
    static const char kHex[] = "0123456789abcdef";
    std::string hex;
    hex.reserve(32);
    for (int i = 0; i < 16; ++i) {
        out_bytes[i] = static_cast<uint8_t>(rd() & 0xFFu);
        hex.push_back(kHex[(out_bytes[i] >> 4) & 0xF]);
        hex.push_back(kHex[out_bytes[i] & 0xF]);
    }
    return hex;
}

} // namespace

NightjarSession::NightjarSession(HostHttpClient& http) : http_(http) {
    decode_buf_.reserve(2u * 1024u * 1024u);
}

NightjarSession::~NightjarSession() {
    stop_network_on_worker();
    shutdown_media_on_main_thread();
}

uint64_t NightjarSession::now_us() const {
    uint64_t now = steady_now_us();
    return now >= epoch_us_ ? (now - epoch_us_) : 0;
}

void NightjarSession::push_event(const char* type, int code) {
    std::lock_guard<std::mutex> lk(events_mu_);
    events_.push_back(SessionEvent{type, code});
    while (events_.size() > 32) events_.pop_front();
}

std::vector<SessionEvent> NightjarSession::drain_events() {
    std::lock_guard<std::mutex> lk(events_mu_);
    std::vector<SessionEvent> out(events_.begin(), events_.end());
    events_.clear();
    return out;
}

bool NightjarSession::init_media_on_main_thread(const StreamOptions& opts, std::string& out_error) {
    opts_ = opts;
    epoch_us_ = steady_now_us();
    last_fps_tick_us_ = 0;
    rx_count_.store(0, std::memory_order_relaxed);
    dec_count_.store(0, std::memory_order_relaxed);
    ren_count_.store(0, std::memory_order_relaxed);
    rx_fps_.store(0, std::memory_order_relaxed);
    dec_fps_.store(0, std::memory_order_relaxed);
    ren_fps_.store(0, std::memory_order_relaxed);
    frame_warp_negotiated_.store(false, std::memory_order_release);
    hdr_active_.store(opts.hdr, std::memory_order_release);

    warp_ = std::make_shared<frame_warp::FrameWarp>(
        std::optional<uint8_t>(0),
        opts.frame_warp_mask_width);

    if (opts.use_video_texture) {
        if (!renderer_.init(static_cast<int>(opts.width), static_cast<int>(opts.height))) {
            out_error = "WebGL/OES WarpGlRenderer initialization failed";
            return false;
        }
    }

    audio_decoder_ = std::make_unique<TizenAudioDecoder>();
    decoder_ = std::make_unique<TizenVideoDecoder>(warp_);
    VideoConfig vcfg;
    vcfg.codec = opts.codec;
    vcfg.width = opts.width;
    vcfg.height = opts.height;
    vcfg.fps = opts.fps;
    vcfg.hdr10 = opts.hdr;
    vcfg.use_video_texture = opts.use_video_texture;
    vcfg.on_need_idr = []() {
#ifdef NIGHTJAR_HAVE_MOONLIGHT
        LiRequestIdrFrame();
#endif
    };
    const bool surround51 = opts.surround51;
    vcfg.on_source_ready_for_tracks = [this, surround51](void* emss_source_ptr) {
        if (audio_decoder_) {
            audio_decoder_->open_track_on_main_thread(48000, surround51, emss_source_ptr);
        }
    };

    std::string dec_err;
    if (!decoder_->initialize(vcfg, &dec_err)) {
        out_error = dec_err.empty() ? "TizenVideoDecoder initialization failed" : ("TizenVideoDecoder: " + dec_err);
        return false;
    }

    if (opts.use_video_texture) {
        decoder_->attach_texture_ring(renderer_.video_textures());
    }

    return true;
}

bool NightjarSession::connect_on_worker_thread(std::string& out_error) {
    const StreamOptions& opts = opts_;

    ServerInfo sinfo = http_.fetch_serverinfo(opts.host_address);
    if (!sinfo.raw_error.empty()) {
        out_error = "Failed to reach host /serverinfo: " + sinfo.raw_error;
        return false;
    }
    if (!sinfo.paired) {
        out_error = "Host is not paired yet. Pair with a PIN first.";
        return false;
    }
    host_frame_warp_version_ = sinfo.frame_warp_version;

    uint8_t rikey[16]{};
    std::string rikey_hex = random_hex_16(rikey);
    uint32_t rikeyid = 1;
    bool should_resume = opts.resume || (sinfo.current_game != 0 && (opts.app_id == 0 || sinfo.current_game == opts.app_id));
    int app_id = opts.app_id != 0 ? opts.app_id : (sinfo.current_game != 0 ? sinfo.current_game : 1);

    LaunchResult launch = http_.launch_or_resume(
        opts.host_address,
        app_id,
        opts.width,
        opts.height,
        opts.fps,
        rikey_hex,
        rikeyid,
        should_resume,
        opts.active_gamepad_mask,
        opts.hdr,
        opts.surround51);
    if (!launch.ok) {
        out_error = "Launch/resume failed: " + launch.error;
        return false;
    }

    {
        std::lock_guard<std::mutex> lk(g_active_mu);
        g_active_session = this;
    }

#ifdef NIGHTJAR_HAVE_MOONLIGHT
    SERVER_INFORMATION li_server{};
    li_server.address = opts.host_address.c_str();
    li_server.serverInfoAppVersion = sinfo.app_version.c_str();
    li_server.serverInfoGfeVersion = sinfo.gfe_version.c_str();
    li_server.rtspSessionUrl = launch.rtsp_session_url.c_str();
    li_server.serverCodecModeSupport = static_cast<int>(sinfo.server_codec_mode_support);

    STREAM_CONFIGURATION sc{};
    LiInitializeStreamConfiguration(&sc);
    sc.width = static_cast<int>(opts.width);
    sc.height = static_cast<int>(opts.height);
    sc.fps = static_cast<int>(opts.fps);
    sc.bitrate = static_cast<int>(opts.bitrate_mbps * 1000);
    sc.packetSize = 1392;
    sc.streamingRemotely = STREAM_CFG_LOCAL;
    sc.audioConfiguration = opts.surround51 ? AUDIO_CONFIGURATION_51_SURROUND : AUDIO_CONFIGURATION_STEREO;

    // Restrict advertised codec to the configured EMSS track codec so the host cannot
    // negotiate a mismatched codec after ElementaryMediaTrack was already created.
    if (opts.codec == "av1") {
        sc.supportedVideoFormats = opts.hdr ? VIDEO_FORMAT_AV1_MAIN10 : VIDEO_FORMAT_AV1_MAIN8;
    } else if (opts.codec == "h264") {
        sc.supportedVideoFormats = VIDEO_FORMAT_H264;
    } else {
        sc.supportedVideoFormats = opts.hdr ? VIDEO_FORMAT_H265_MAIN10 : VIDEO_FORMAT_H265;
    }
    if (opts.hdr) {
        sc.colorSpace = COLORSPACE_REC_2020;
        sc.colorRange = COLOR_RANGE_LIMITED;
    } else {
        sc.colorSpace = COLORSPACE_REC_709;
        sc.colorRange = COLOR_RANGE_LIMITED;
    }

    sc.encryptionFlags = ENCFLG_ALL;
    std::memcpy(sc.remoteInputAesKey, rikey, 16);
    std::memset(sc.remoteInputAesIv, 0, 16);
    sc.remoteInputAesIv[0] = static_cast<char>((rikeyid >> 24) & 0xFF);
    sc.remoteInputAesIv[1] = static_cast<char>((rikeyid >> 16) & 0xFF);
    sc.remoteInputAesIv[2] = static_cast<char>((rikeyid >> 8) & 0xFF);
    sc.remoteInputAesIv[3] = static_cast<char>(rikeyid & 0xFF);

    CONNECTION_LISTENER_CALLBACKS cl{};
    LiInitializeConnectionCallbacks(&cl);
    cl.stageStarting = cb_stage_starting;
    cl.stageComplete = cb_stage_complete;
    cl.stageFailed = cb_stage_failed;
    cl.logMessage = cb_log_message;
    cl.connectionStarted = cb_connection_started;
    cl.connectionTerminated = cb_connection_terminated;
    cl.connectionStatusUpdate = cb_connection_status_update;

    DECODER_RENDERER_CALLBACKS dr{};
    LiInitializeVideoCallbacks(&dr);
    dr.setup = cb_video_setup;
    dr.submitDecodeUnit = cb_submit_decode_unit;
    dr.capabilities = CAPABILITY_DIRECT_SUBMIT |
                      CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC |
                      CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1;

    AUDIO_RENDERER_CALLBACKS ar{};
    LiInitializeAudioCallbacks(&ar);
    ar.init = cb_audio_init;
    ar.decodeAndPlaySample = cb_audio_decode_and_play;
    ar.capabilities = CAPABILITY_DIRECT_SUBMIT;

    LiSetFrameWarpCallback(cb_frame_warp_packet);
    int rc = LiStartConnection(&li_server, &sc, &cl, &dr, &ar, nullptr, 0, nullptr, 0);
    if (rc != 0) {
        {
            std::lock_guard<std::mutex> lk(g_active_mu);
            if (g_active_session == this) g_active_session = nullptr;
        }
        std::string detail = stage_summary();
        out_error = "LiStartConnection failed (" + std::to_string(rc) + "): " + detail;
        return false;
    }
#endif

    running_.store(true, std::memory_order_release);
    return true;
}

void NightjarSession::stop_network_on_worker() {
    running_.store(false, std::memory_order_release);
    frame_warp_negotiated_.store(false, std::memory_order_release);
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    bool was_active = false;
    {
        std::lock_guard<std::mutex> lk(g_active_mu);
        if (g_active_session == this) {
            was_active = true;
            g_active_session = nullptr;
        }
    }
    if (was_active) {
        LiSetFrameWarpCallback(nullptr);
        LiStopConnection();
    }
#endif
}

void NightjarSession::shutdown_media_on_main_thread() {
    running_.store(false, std::memory_order_release);
    if (audio_decoder_) {
        audio_decoder_->shutdown();
        audio_decoder_.reset();
    }
    if (decoder_) {
        decoder_->shutdown();
        decoder_.reset();
    }
    renderer_.destroy();
    warp_.reset();
}

void NightjarSession::send_frame_warp_request(bool enabled) {
    if (!warp_) return;
    auto req = warp_->request(enabled, opts_.frame_warp_lens);
    auto bytes = req.encode();
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    if (LiSendFrameWarpRequest(bytes.data(), bytes.size()) == 0) {
        frame_warp_negotiated_.store(enabled, std::memory_order_release);
    }
#else
    (void)bytes;
#endif
}

void NightjarSession::on_stage_starting(const char* name) {
    std::lock_guard<std::mutex> lk(events_mu_);
    stage_text_ = std::string("Starting ") + (name ? name : "?");
}

void NightjarSession::on_stage_complete(const char* name) {
    std::lock_guard<std::mutex> lk(events_mu_);
    stage_text_ = std::string("Done ") + (name ? name : "?");
}

void NightjarSession::on_stage_failed(const char* name, int error_code) {
    std::lock_guard<std::mutex> lk(events_mu_);
    stage_text_ = std::string("FAILED ") + (name ? name : "?") + " (" + std::to_string(error_code) + ")";
}

void NightjarSession::on_log_message(const char* msg) {
    if (!msg) return;
    std::string trimmed(msg);
    while (!trimmed.empty() && (trimmed.back() == '\n' || trimmed.back() == '\r' || trimmed.back() == ' ')) {
        trimmed.pop_back();
    }
    if (trimmed.empty()) return;
    if (trimmed.size() > 120) trimmed.resize(120);
    std::lock_guard<std::mutex> lk(events_mu_);
    last_log_ = std::move(trimmed);
}

void NightjarSession::on_connection_started() {
    {
        std::lock_guard<std::mutex> lk(events_mu_);
        stage_text_ = "Connected";
    }
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    // Strictly capability-gated: requires BOTH <FrameWarpVersion> >= 1 AND RTSP a=x-rl-control 0x5543
    if (opts_.frame_warp_enabled && opts_.use_video_texture && host_frame_warp_version_ >= 1 && LiHasFrameWarpControl()) {
        send_frame_warp_request(true);
    }
#endif
}

void NightjarSession::on_connection_terminated(int error_code) {
    running_.store(false, std::memory_order_release);
    push_event("terminated", error_code);
}

void NightjarSession::on_connection_status_update(int status) {
    push_event("conn_status", status);
}

void NightjarSession::set_frame_warp_enabled(bool enabled) {
    opts_.frame_warp_enabled = enabled;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    if (running_.load(std::memory_order_acquire) && opts_.use_video_texture &&
        host_frame_warp_version_ >= 1 && LiHasFrameWarpControl()) {
        send_frame_warp_request(enabled);
    }
#endif
}

void NightjarSession::on_control_packet(uint16_t msg_type, const uint8_t* payload, size_t len) {
    if (!warp_ || !payload) return;
    switch (msg_type) {
        case frame_warp::kMsgModel:
            if (auto m = frame_warp::Model::decode(payload, len)) {
                warp_->on_model(*m);
            }
            break;
        case frame_warp::kMsgTags:
            if (auto t = frame_warp::Tags::decode(payload, len)) {
                warp_->on_tags(*t, now_us());
            }
            break;
        case frame_warp::kMsgMask:
            if (auto mask = frame_warp::Mask::decode(payload, len)) {
                warp_->on_mask(std::move(*mask));
            }
            break;
        default:
            break;
    }
}

int NightjarSession::on_video_decode_unit(
    const uint8_t* data, size_t len, uint32_t frame_number, int64_t pts_us, bool keyframe) {
    if (!decoder_) return 0;
    rx_count_.fetch_add(1u, std::memory_order_relaxed);
    bool ok = decoder_->submit_access_unit(data, len, frame_number, pts_us, keyframe);
    if (ok && decoder_->is_direct_scanout()) {
        dec_count_.fetch_add(1u, std::memory_order_relaxed);
    }
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    return ok ? DR_OK : DR_NEED_IDR;
#else
    return ok ? 0 : -1;
#endif
}

int NightjarSession::on_audio_init(const AudioConfig& cfg) {
    if (!audio_decoder_) return 0;
    return audio_decoder_->reconfigure_opus(cfg) ? 0 : -1;
}

void NightjarSession::on_audio_packet(const uint8_t* data, size_t len) {
    if (audio_decoder_) {
        audio_decoder_->decode_and_play(data, len);
    }
}

void NightjarSession::send_mouse_move(int16_t dx, int16_t dy) {
    if (!running_.load(std::memory_order_acquire)) return;
    if (warp_) warp_->note_mouse(dx, dy, now_us());
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    LiSendMouseMoveEvent(dx, dy);
#endif
}

void NightjarSession::send_mouse_button(uint8_t action, int button) {
    if (!running_.load(std::memory_order_acquire)) return;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    LiSendMouseButtonEvent(static_cast<char>(action), button);
#else
    (void)action; (void)button;
#endif
}

void NightjarSession::send_mouse_wheel(int8_t clicks) {
    if (!running_.load(std::memory_order_acquire)) return;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    LiSendScrollEvent(clicks);
#else
    (void)clicks;
#endif
}

void NightjarSession::send_controller_arrival(uint8_t controller_idx, uint16_t active_mask) {
    if (!running_.load(std::memory_order_acquire)) return;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    (void)active_mask;
    LiSendControllerArrivalEvent(
        controller_idx,
        active_mask,
        LI_CTYPE_XBOX,
        0xFFFFu,
        LI_CCAP_ANALOG_TRIGGERS);
#else
    (void)controller_idx; (void)active_mask;
#endif
}

void NightjarSession::send_controller_packet(
    uint16_t controller_idx,
    uint16_t active_mask,
    int button_flags,
    uint8_t left_trigger,
    uint8_t right_trigger,
    int16_t lx,
    int16_t ly,
    int16_t rx,
    int16_t ry) {
    if (!running_.load(std::memory_order_acquire)) return;
    if (warp_) warp_->note_controller(controller_idx, rx, ry, now_us());
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    LiSendMultiControllerEvent(
        static_cast<short>(controller_idx),
        static_cast<short>(active_mask),
        button_flags,
        left_trigger,
        right_trigger,
        lx,
        ly,
        rx,
        ry);
#else
    (void)active_mask; (void)button_flags; (void)left_trigger; (void)right_trigger; (void)lx; (void)ly;
#endif
}

void NightjarSession::send_key(uint16_t key_code, uint8_t action, uint8_t modifiers) {
    if (!running_.load(std::memory_order_acquire)) return;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    LiSendKeyboardEvent(static_cast<short>(key_code), static_cast<char>(action), static_cast<char>(modifiers));
#else
    (void)key_code; (void)action; (void)modifiers;
#endif
}

void NightjarSession::tick_fps_window(uint64_t t_us) {
    if (last_fps_tick_us_ == 0) {
        last_fps_tick_us_ = t_us;
        return;
    }
    uint64_t dt = t_us - last_fps_tick_us_;
    if (dt >= 1000000ull) {
        rx_fps_.store(rx_count_.exchange(0, std::memory_order_relaxed), std::memory_order_relaxed);
        dec_fps_.store(dec_count_.exchange(0, std::memory_order_relaxed), std::memory_order_relaxed);
        ren_fps_.store(ren_count_.exchange(0, std::memory_order_relaxed), std::memory_order_relaxed);
        last_fps_tick_us_ = t_us;
    }
}

void NightjarSession::on_display_refresh() {
    if (!running_.load(std::memory_order_acquire) || !warp_ || !decoder_) return;
    uint64_t t_us = now_us();
    tick_fps_window(t_us);

    if (decoder_->is_direct_scanout()) {
        return;
    }

    GLuint display_tex = 0;
    uint32_t frame_number = 0;
    bool is_tagged = false;
    if (decoder_->poll_next_frame(display_tex, frame_number, is_tagged)) {
        dec_count_.fetch_add(1u, std::memory_order_relaxed);
        auto w = (opts_.frame_warp_enabled && is_tagged) ? warp_->warp(frame_number, t_us) : frame_warp::Warp{};
        renderer_.sync_hud_mask(*warp_);
        renderer_.draw(display_tex, w, frame_number, warp_->input_seq());
        ren_count_.fetch_add(1u, std::memory_order_relaxed);
    } else if (opts_.frame_warp_enabled) {
        GLuint held = decoder_->current_display_texture();
        if (renderer_.maybe_redraw_between_frames(held, *warp_, t_us)) {
            ren_count_.fetch_add(1u, std::memory_order_relaxed);
        }
    }
}

SessionStats NightjarSession::session_stats() const {
    SessionStats s;
    s.rx_fps = rx_fps_.load(std::memory_order_relaxed);
    s.decoded_fps = dec_fps_.load(std::memory_order_relaxed);
    s.rendered_fps = ren_fps_.load(std::memory_order_relaxed);
    s.hdr_active = hdr_active_.load(std::memory_order_relaxed);
    s.direct_scanout = decoder_ ? decoder_->is_direct_scanout() : !opts_.use_video_texture;
    return s;
}

std::string NightjarSession::stage_summary() const {
    std::lock_guard<std::mutex> lk(events_mu_);
    if (last_log_.empty()) return stage_text_;
    return stage_text_ + " · " + last_log_;
}

std::string NightjarSession::decoder_summary() const {
    return decoder_ ? decoder_->diagnostic_summary() : "no-decoder";
}

frame_warp::Status NightjarSession::frame_warp_status() const {
    if (!warp_) return frame_warp::Status{};
    return warp_->status(now_us());
}

} // namespace nightjar::tizen
