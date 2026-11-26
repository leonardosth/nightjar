#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace nightjar::tizen {

struct ClientIdentity {
    std::string unique_id;
    std::string cert_pem;
    std::string key_pem;
};

struct ServerInfo {
    std::string hostname;
    std::string unique_id;
    std::string app_version;
    std::string gfe_version;
    bool paired = false;
    int current_game = 0;
    int frame_warp_version = 0; // <FrameWarpVersion>1</FrameWarpVersion>
    uint32_t server_codec_mode_support = 0; // <ServerCodecModeSupport>
    std::string raw_error;
};

struct HostApp {
    int id = 0;
    std::string title;
    bool hdr_supported = false;
};

struct LaunchResult {
    bool ok = false;
    std::string rtsp_session_url;
    std::string error;
};

/**
 * Moonlight-protocol HTTP & mTLS HTTPS control-plane client.
 * Uses OpenSSL + libcurl over Samsung Tizen Sockets Extension (runs on worker pthread).
 */
class HostHttpClient {
public:
    HostHttpClient();
    ~HostHttpClient();

    // Generates a new RSA-2048 + X.509 client identity if cert/key are empty, otherwise loads them.
    bool init_identity(const std::string& unique_id, const std::string& cert_pem, const std::string& key_pem);
    const ClientIdentity& identity() const { return identity_; }

    void set_pinned_server_cert(const std::string& host_ip, const std::string& cert_pem);
    std::string pinned_server_cert(const std::string& host_ip) const;

    void cancel_pending_pairing();
    bool unpair(const std::string& host_ip, uint16_t http_port = 47989);

    ServerInfo fetch_serverinfo(const std::string& host_ip, uint16_t http_port = 47989, uint16_t https_port = 47984);
    bool pair_with_pin(const std::string& host_ip, const std::string& pin, std::string& out_error, uint16_t http_port = 47989, uint16_t https_port = 47984);
    std::vector<HostApp> fetch_applist(const std::string& host_ip, std::string& out_error, uint16_t https_port = 47984);
    LaunchResult launch_or_resume(
        const std::string& host_ip,
        int app_id,
        uint32_t width,
        uint32_t height,
        uint32_t fps,
        const std::string& rikey_hex,
        uint32_t rikeyid,
        bool resume,
        uint32_t active_gamepad_mask = 1,
        bool hdr = false,
        bool surround51 = false,
        uint16_t https_port = 47984);
    bool cancel_app(const std::string& host_ip, uint16_t https_port = 47984);

    // Pure XML helpers (also unit-tested natively)
    static std::optional<std::string> extract_xml_tag(const std::string& xml, const std::string& tag);
    static int parse_frame_warp_version(const std::string& xml);
    static uint32_t parse_server_codec_mode_support(const std::string& xml);
    static std::vector<HostApp> parse_applist_xml(const std::string& xml);

private:
    bool http_get(
        const std::string& url,
        const std::string& host_ip,
        bool use_mtls,
        std::string& out_body,
        std::string& out_err,
        long timeout_sec = 8L,
        const std::atomic<bool>* abort_flag = nullptr);

    ClientIdentity identity_;
    bool initialized_ = false;
    mutable std::mutex pin_mutex_;
    std::unordered_map<std::string, std::string> pinned_certs_;
    std::atomic<bool> cancel_pairing_{false};
};

} // namespace nightjar::tizen
