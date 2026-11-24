#pragma once

#include <cstdint>
#include <optional>
#include <string>
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
 * Moonlight / Rubylight HTTP & mTLS HTTPS control-plane client.
 * Uses OpenSSL + libcurl over Samsung Tizen Sockets Extension (runs on pthread worker).
 *
 * Implements:
 *  - Client RSA-2048 + X.509 identity generation/import
 *  - /serverinfo XML probe including <FrameWarpVersion> capability detection
 *  - 5-step Moonlight PIN pairing (/pair + AES-128-ECB + RSA signature + HTTPS pairchallenge)
 *  - mTLS HTTPS /applist, /launch, /resume, /cancel
 */
class HostHttpClient {
public:
    HostHttpClient();
    ~HostHttpClient();

    // Generates a new RSA-2048 + X.509 client identity if cert/key are empty, otherwise loads them.
    bool init_identity(const std::string& unique_id, const std::string& cert_pem, const std::string& key_pem);
    const ClientIdentity& identity() const { return identity_; }

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
        uint16_t https_port = 47984);
    bool cancel_app(const std::string& host_ip, uint16_t https_port = 47984);

    // Pure XML helpers (also unit-tested natively)
    static std::optional<std::string> extract_xml_tag(const std::string& xml, const std::string& tag);
    static int parse_frame_warp_version(const std::string& xml);
    static std::vector<HostApp> parse_applist_xml(const std::string& xml);

private:
    bool http_get(const std::string& url, bool use_mtls, std::string& out_body, std::string& out_err);

    ClientIdentity identity_;
    bool initialized_ = false;
};

} // namespace nightjar::tizen
