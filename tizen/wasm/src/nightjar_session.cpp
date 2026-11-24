#include "nightjar_session.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

#ifdef NIGHTJAR_HAVE_MOONLIGHT
#include <Limelight.h>
#endif

namespace nightjar::tizen {

namespace {

uint64_t steady_now_us() {
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count());
}

NightjarSession* g_active_session = nullptr;

#ifdef NIGHTJAR_HAVE_MOONLIGHT
void cb_connection_started() {
    if (g_active_session) g_active_session->on_connection_started();
}

void cb_connection_terminated(int /*error_code*/) {
    // Handled via session status polling
}

void cb_frame_warp_packet(uint16_t msg_type, const uint8_t* data, size_t len) {
    if (g_active_session) g_active_session->on_control_packet(msg_type, data, len);
}

int cb_video_setup(int /*video_format*/, int /*width*/, int /*height*/, int /*redraw_rate*/, void* /*ctx*/, int /*dr_flags*/) {
    return 0;
}

int cb_submit_decode_unit(PDECODE_UNIT du) {
    if (!g_active_session || !du) return DR_OK;
    std::vector<uint8_t> frame_buf;
    frame_buf.reserve(static_cast<size_t>(du->fullLength));
    for (PLENTRY entry = du->bufferList; entry != nullptr; entry = entry->next) {
        if (entry->data && entry->length > 0) {
            frame_buf.insert(frame_buf.end(),
                             reinterpret_cast<const uint8_t*>(entry->data),
                             reinterpret_cast<const uint8_t*>(entry->data) + entry->length);
        }
    }
    return g_active_session->on_video_decode_unit(
        frame_buf.data(),
        frame_buf.size(),
        static_cast<uint32_t>(du->frameNumber),
        static_cast<int64_t>(du->presentationTimeUs),
        du->frameType == FRAME_TYPE_IDR
    );
}

int cb_audio_init(int /*audio_cfg*/, const POPUS_MULTISTREAM_CONFIGURATION /*opus_cfg*/, void* /*ctx*/, int /*ar_flags*/) {
    return 0;
}

void cb_audio_decode_and_play(char* data, int length) {
    if (g_active_session && data && length > 0) {
        g_active_session->on_audio_packet(reinterpret_cast<const uint8_t*>(data), static_cast<size_t>(length));
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

NightjarSession::NightjarSession(HostHttpClient& http) : http_(http) {}
NightjarSession::~NightjarSession() { stop(); }

uint64_t NightjarSession::now_us() const {
    uint64_t now = steady_now_us();
    return now >= epoch_us_ ? (now - epoch_us_) : 0;
}

bool NightjarSession::start(const StreamOptions& opts, std::string& out_error) {
    stop();
    opts_ = opts;
    epoch_us_ = steady_now_us();
    frame_warp_negotiated_.store(false, std::memory_order_release);

    // 1. Probe /serverinfo for <FrameWarpVersion> and host versions
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

    // 2. Generate remote input AES key + IV and launch/resume app over mTLS HTTPS
    uint8_t rikey[16]{};
    std::string rikey_hex = random_hex_16(rikey);
    uint32_t rikeyid = 1;
    bool should_resume = opts.resume || (sinfo.current_game != 0 && (opts.app_id == 0 || sinfo.current_game == opts.app_id));
    int app_id = opts.app_id != 0 ? opts.app_id : (sinfo.current_game != 0 ? sinfo.current_game : 1);

    LaunchResult launch = http_.launch_or_resume(
        opts.host_address, app_id, opts.width, opts.height, opts.fps, rikey_hex, rikeyid, should_resume);
    if (!launch.ok) {
        out_error = "Launch/resume failed: " + launch.error;
        return false;
    }

    // 3. Prepare Frame Warp predictor, WebGL2/GLES3 renderer, and Tizen kVideoTexture decoder
    warp_ = std::make_shared<frame_warp::FrameWarp>(
        std::optional<uint8_t>(0),
        opts.frame_warp_mask_width
    );

    if (!renderer_.init(static_cast<int>(opts.width), static_cast<int>(opts.height))) {
        out_error = "WebGL2/GLES3 WarpGlRenderer initialization failed";
        return false;
    }

    decoder_ = std::make_unique<TizenVideoDecoder>(warp_);
    VideoConfig vcfg;
    vcfg.codec = opts.codec;
    vcfg.width = opts.width;
    vcfg.height = opts.height;
    vcfg.fps = opts.fps;
    if (!decoder_->initialize(vcfg)) {
        out_error = "TizenVideoDecoder (kVideoTexture) initialization failed";
        return false;
    }
    decoder_->register_gl_context();

    g_active_session = this;

#ifdef NIGHTJAR_HAVE_MOONLIGHT
    SERVER_INFORMATION li_server{};
    li_server.address = opts.host_address.c_str();
    li_server.serverInfoAppVersion = sinfo.app_version.c_str();
    li_server.serverInfoGfeVersion = sinfo.gfe_version.c_str();
    li_server.rtspSessionUrl = launch.rtsp_session_url.c_str();

    STREAM_CONFIGURATION sc{};
    LiInitializeStreamConfiguration(&sc);
    sc.width = static_cast<int>(opts.width);
    sc.height = static_cast<int>(opts.height);
    sc.fps = static_cast<int>(opts.fps);
    sc.bitrate = static_cast<int>(opts.bitrate_mbps * 1000);
    sc.packetSize = 1392;
    sc.streamingRemotely = STREAM_CFG_LOCAL;
    sc.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    if (opts.codec == "av1") {
        sc.supportedVideoFormats = VIDEO_FORMAT_AV1_MAIN8 | VIDEO_FORMAT_H265 | VIDEO_FORMAT_H264;
    } else if (opts.codec == "h264") {
        sc.supportedVideoFormats = VIDEO_FORMAT_H264;
    } else {
        sc.supportedVideoFormats = VIDEO_FORMAT_H265 | VIDEO_FORMAT_H264;
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
    cl.connectionStarted = cb_connection_started;
    cl.connectionTerminated = cb_connection_terminated;

    DECODER_RENDERER_CALLBACKS dr{};
    LiInitializeVideoCallbacks(&dr);
    dr.setup = cb_video_setup;
    dr.submitDecodeUnit = cb_submit_decode_unit;
    dr.capabilities = CAPABILITY_DIRECT_SUBMIT;

    AUDIO_RENDERER_CALLBACKS ar{};
    LiInitializeAudioCallbacks(&ar);
    ar.init = cb_audio_init;
    ar.decodeAndPlaySample = cb_audio_decode_and_play;
    ar.capabilities = CAPABILITY_DIRECT_SUBMIT;

    LiSetFrameWarpCallback(cb_frame_warp_packet);
    int rc = LiStartConnection(&li_server, &sc, &cl, &dr, &ar, nullptr, 0, nullptr, 0);
    if (rc != 0) {
        g_active_session = nullptr;
        out_error = "LiStartConnection failed with code " + std::to_string(rc);
        return false;
    }
#endif

    running_.store(true, std::memory_order_release);
    return true;
}

void NightjarSession::stop() {
    running_.store(false, std::memory_order_release);
    frame_warp_negotiated_.store(false, std::memory_order_release);
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    if (g_active_session == this) {
        LiSetFrameWarpCallback(nullptr);
        LiStopConnection();
        g_active_session = nullptr;
    }
#endif
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

void NightjarSession::on_connection_started() {
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    // Strictly capability-gated: requires BOTH <FrameWarpVersion> >= 1 AND RTSP a=x-rl-control 0x5543
    if (opts_.frame_warp_enabled && host_frame_warp_version_ >= 1 && LiHasFrameWarpControl()) {
        send_frame_warp_request(true);
    }
#endif
}

void NightjarSession::set_frame_warp_enabled(bool enabled) {
    opts_.frame_warp_enabled = enabled;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    if (running_.load(std::memory_order_acquire) && host_frame_warp_version_ >= 1 && LiHasFrameWarpControl()) {
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
    decoder_->submit_access_unit(data, len, frame_number, pts_us, keyframe);
    return 0;
}

void NightjarSession::on_audio_packet(const uint8_t* /*data*/, size_t /*len*/) {
    // Audio Opus packets are routed to Tizen WASM Player's audio ElementaryMediaTrack
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

void NightjarSession::send_controller_packet(
    uint16_t controller_idx,
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
        static_cast<short>(1 << controller_idx),
        button_flags,
        left_trigger,
        right_trigger,
        lx,
        ly,
        rx,
        ry
    );
#else
    (void)button_flags; (void)left_trigger; (void)right_trigger; (void)lx; (void)ly;
#endif
}

void NightjarSession::send_key(int16_t key_code, uint8_t action, uint8_t modifiers) {
    if (!running_.load(std::memory_order_acquire)) return;
#ifdef NIGHTJAR_HAVE_MOONLIGHT
    LiSendKeyboardEvent(key_code, static_cast<char>(action), static_cast<char>(modifiers));
#else
    (void)key_code; (void)action; (void)modifiers;
#endif
}

void NightjarSession::on_display_refresh() {
    if (!running_.load(std::memory_order_acquire) || !warp_ || !decoder_) return;
    uint64_t t_us = now_us();
    uint32_t frame_number = 0;

    if (decoder_->fill_next_frame(renderer_.video_texture(), frame_number)) {
        auto w = opts_.frame_warp_enabled ? warp_->warp(frame_number, t_us) : frame_warp::Warp{};
        renderer_.sync_hud_mask(*warp_);
        renderer_.draw(w, frame_number, warp_->input_seq());
        decoder_->recycle_texture(renderer_.video_texture());
    } else if (opts_.frame_warp_enabled) {
        renderer_.maybe_redraw_between_frames(*warp_, t_us);
    }
}

frame_warp::Status NightjarSession::frame_warp_status() const {
    if (!warp_) return frame_warp::Status{};
    return warp_->status(now_us());
}

} // namespace nightjar::tizen
