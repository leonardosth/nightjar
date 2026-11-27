#include "host_http_client.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <sstream>

#ifdef NIGHTJAR_HAVE_CURL_OPENSSL
#include <curl/curl.h>
#include <openssl/aes.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/rsa.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#endif

namespace nightjar::tizen {

namespace {

std::string generate_random_unique_id() {
    static const char kHex[] = "0123456789abcdef";
    uint8_t bytes[8]{};
#ifdef NIGHTJAR_HAVE_CURL_OPENSSL
    if (RAND_bytes(bytes, sizeof(bytes)) != 1) {
        std::random_device rd;
        for (uint8_t& b : bytes) b = static_cast<uint8_t>(rd() & 0xFFu);
    }
#else
    std::random_device rd;
    for (uint8_t& b : bytes) b = static_cast<uint8_t>(rd() & 0xFFu);
#endif
    std::string out;
    out.reserve(16);
    for (uint8_t b : bytes) {
        out.push_back(kHex[(b >> 4) & 0xF]);
        out.push_back(kHex[b & 0xF]);
    }
    return out;
}

#ifdef NIGHTJAR_HAVE_CURL_OPENSSL
size_t curl_write_cb(void* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* out = static_cast<std::string*>(userdata);
    out->append(static_cast<const char*>(ptr), size * nmemb);
    return size * nmemb;
}

int curl_xferinfo_cb(void* clientp, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* abort_flag = static_cast<const std::atomic<bool>*>(clientp);
    return (abort_flag && abort_flag->load(std::memory_order_acquire)) ? 1 : 0;
}

std::string to_hex(const uint8_t* data, size_t len) {
    static const char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out.push_back(kHex[(data[i] >> 4) & 0xF]);
        out.push_back(kHex[data[i] & 0xF]);
    }
    return out;
}

std::vector<uint8_t> from_hex(const std::string& hex) {
    std::vector<uint8_t> out;
    if (hex.size() % 2 != 0) return out;
    out.reserve(hex.size() / 2);
    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
        if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
        return -1;
    };
    for (size_t i = 0; i < hex.size(); i += 2) {
        int hi = nibble(hex[i]);
        int lo = nibble(hex[i + 1]);
        if (hi < 0 || lo < 0) return {};
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    return out;
}

std::vector<uint8_t> aes_ecb_crypt(const uint8_t key[16], const std::vector<uint8_t>& in, bool encrypt) {
    std::vector<uint8_t> out(in.size());
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    EVP_CipherInit_ex(ctx, EVP_aes_128_ecb(), nullptr, key, nullptr, encrypt ? 1 : 0);
    EVP_CIPHER_CTX_set_padding(ctx, 0);
    int outl = 0;
    EVP_CipherUpdate(ctx, out.data(), &outl, in.data(), static_cast<int>(in.size()));
    EVP_CIPHER_CTX_free(ctx);
    return out;
}

std::vector<uint8_t> sha256_bytes(const uint8_t* data, size_t len) {
    std::vector<uint8_t> digest(SHA256_DIGEST_LENGTH);
    SHA256(data, len, digest.data());
    return digest;
}

struct SslMemIdentity {
    const std::string* cert_pem;
    const std::string* key_pem;
    const std::string* pinned_server_cert_pem;
};

int verify_pinned_server_cert(X509_STORE_CTX* store_ctx, void* arg) {
    auto* pinned_pem = static_cast<const std::string*>(arg);
    if (!pinned_pem || pinned_pem->empty()) {
        return 0; // Fail closed: mTLS requires a pinned server cert
    }
    X509* peer = X509_STORE_CTX_get0_cert(store_ctx);
    if (!peer) return 0;

    BIO* pbio = BIO_new_mem_buf(pinned_pem->data(), static_cast<int>(pinned_pem->size()));
    X509* pinned = PEM_read_bio_X509(pbio, nullptr, nullptr, nullptr);
    BIO_free(pbio);
    if (!pinned) return 0;

    int eq = (X509_cmp(peer, pinned) == 0) ? 1 : 0;
    X509_free(pinned);
    return eq;
}

CURLcode ssl_ctx_cb(CURL* /*curl*/, void* ssl_ctx, void* userptr) {
    auto* id = static_cast<SslMemIdentity*>(userptr);
    auto* ctx = static_cast<SSL_CTX*>(ssl_ctx);
    if (id->cert_pem && !id->cert_pem->empty()) {
        BIO* cbio = BIO_new_mem_buf(id->cert_pem->data(), static_cast<int>(id->cert_pem->size()));
        X509* cert = PEM_read_bio_X509(cbio, nullptr, nullptr, nullptr);
        BIO_free(cbio);
        if (cert) {
            SSL_CTX_use_certificate(ctx, cert);
            X509_free(cert);
        }
    }
    if (id->key_pem && !id->key_pem->empty()) {
        BIO* kbio = BIO_new_mem_buf(id->key_pem->data(), static_cast<int>(id->key_pem->size()));
        EVP_PKEY* pkey = PEM_read_bio_PrivateKey(kbio, nullptr, nullptr, nullptr);
        BIO_free(kbio);
        if (pkey) {
            SSL_CTX_use_PrivateKey(ctx, pkey);
            EVP_PKEY_free(pkey);
        }
    }
    if (id->pinned_server_cert_pem && !id->pinned_server_cert_pem->empty()) {
        SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nullptr);
        SSL_CTX_set_cert_verify_callback(
            ctx,
            verify_pinned_server_cert,
            const_cast<std::string*>(id->pinned_server_cert_pem));
    }
    return CURLE_OK;
}
#endif

} // namespace

HostHttpClient::HostHttpClient() = default;
HostHttpClient::~HostHttpClient() = default;

void HostHttpClient::set_pinned_server_cert(const std::string& host_ip, const std::string& cert_pem) {
    std::lock_guard<std::mutex> lk(pin_mutex_);
    if (cert_pem.empty()) {
        pinned_certs_.erase(host_ip);
    } else {
        pinned_certs_[host_ip] = cert_pem;
    }
}

std::string HostHttpClient::pinned_server_cert(const std::string& host_ip) const {
    std::lock_guard<std::mutex> lk(pin_mutex_);
    auto it = pinned_certs_.find(host_ip);
    return it == pinned_certs_.end() ? std::string() : it->second;
}

void HostHttpClient::cancel_pending_pairing() {
    cancel_pairing_.store(true, std::memory_order_release);
}

std::optional<std::string> HostHttpClient::extract_xml_tag(const std::string& xml, const std::string& tag) {
    std::string open = "<" + tag + ">";
    std::string close = "</" + tag + ">";
    auto start = xml.find(open);
    if (start == std::string::npos) return std::nullopt;
    start += open.size();
    auto end = xml.find(close, start);
    if (end == std::string::npos) return std::nullopt;
    return xml.substr(start, end - start);
}

int HostHttpClient::parse_frame_warp_version(const std::string& xml) {
    auto val = extract_xml_tag(xml, "FrameWarpVersion");
    if (!val.has_value() || val->empty()) return 0;
    for (char c : *val) {
        if (c < '0' || c > '9') return 0;
    }
    long parsed = std::strtol(val->c_str(), nullptr, 10);
    if (parsed < 1 || parsed > 65535) return 0;
    return static_cast<int>(parsed);
}

uint32_t HostHttpClient::parse_server_codec_mode_support(const std::string& xml) {
    auto val = extract_xml_tag(xml, "ServerCodecModeSupport");
    if (!val.has_value() || val->empty()) return 0;
    for (char c : *val) {
        if (c < '0' || c > '9') return 0;
    }
    return static_cast<uint32_t>(std::strtoul(val->c_str(), nullptr, 10));
}

std::vector<HostApp> HostHttpClient::parse_applist_xml(const std::string& xml) {
    std::vector<HostApp> apps;
    size_t pos = 0;
    while (true) {
        auto start = xml.find("<App>", pos);
        if (start == std::string::npos) break;
        auto end = xml.find("</App>", start);
        if (end == std::string::npos) break;
        std::string block = xml.substr(start, end - start + 6);
        pos = end + 6;

        auto id_str = extract_xml_tag(block, "ID");
        auto title = extract_xml_tag(block, "AppTitle");
        if (id_str && title) {
            HostApp app;
            app.id = std::atoi(id_str->c_str());
            app.title = *title;
            auto hdr = extract_xml_tag(block, "IsHdrSupported");
            app.hdr_supported = (hdr && *hdr == "1");
            apps.push_back(std::move(app));
        }
    }
    return apps;
}

bool HostHttpClient::init_identity(
    const std::string& unique_id, const std::string& cert_pem, const std::string& key_pem) {
    identity_.unique_id = (unique_id.empty() || unique_id == "0123456789ABCDEF")
        ? generate_random_unique_id()
        : unique_id;
    if (!cert_pem.empty() && !key_pem.empty()) {
        identity_.cert_pem = cert_pem;
        identity_.key_pem = key_pem;
        initialized_ = true;
        return true;
    }
#ifdef NIGHTJAR_HAVE_CURL_OPENSSL
    EVP_PKEY* pkey = EVP_PKEY_new();
    BIGNUM* bn = BN_new();
    BN_set_word(bn, RSA_F4);
    RSA* rsa = RSA_new();
    RSA_generate_key_ex(rsa, 2048, bn, nullptr);
    EVP_PKEY_assign_RSA(pkey, rsa);
    BN_free(bn);

    X509* x509 = X509_new();
    X509_set_version(x509, 2);
    ASN1_INTEGER_set(X509_get_serialNumber(x509), 1);
    X509_gmtime_adj(X509_get_notBefore(x509), 0);
    X509_gmtime_adj(X509_get_notAfter(x509), 60L * 60L * 24L * 3650L);
    X509_set_pubkey(x509, pkey);
    X509_NAME* name = X509_get_subject_name(x509);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, reinterpret_cast<const unsigned char*>("Nightjar"), -1, -1, 0);
    X509_set_issuer_name(x509, name);
    X509_sign(x509, pkey, EVP_sha256());

    BIO* cbio = BIO_new(BIO_s_mem());
    PEM_write_bio_X509(cbio, x509);
    char* cdata = nullptr;
    long clen = BIO_get_mem_data(cbio, &cdata);
    identity_.cert_pem.assign(cdata, clen);
    BIO_free(cbio);

    BIO* kbio = BIO_new(BIO_s_mem());
    PEM_write_bio_PrivateKey(kbio, pkey, nullptr, nullptr, 0, nullptr, nullptr);
    char* kdata = nullptr;
    long klen = BIO_get_mem_data(kbio, &kdata);
    identity_.key_pem.assign(kdata, klen);
    BIO_free(kbio);

    X509_free(x509);
    EVP_PKEY_free(pkey);
    initialized_ = true;
    return true;
#else
    initialized_ = true;
    return true;
#endif
}

bool HostHttpClient::http_get(
    const std::string& url,
    const std::string& host_ip,
    bool use_mtls,
    std::string& out_body,
    std::string& out_err,
    long timeout_sec,
    const std::atomic<bool>* abort_flag) {
#ifdef NIGHTJAR_HAVE_CURL_OPENSSL
    CURL* curl = curl_easy_init();
    if (!curl) {
        out_err = "curl_easy_init failed";
        return false;
    }
    out_body.clear();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out_body);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout_sec);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

    std::string pinned = use_mtls ? pinned_server_cert(host_ip) : std::string();
    if (use_mtls && pinned.empty()) {
        out_err = "Missing pinned server certificate for mTLS";
        curl_easy_cleanup(curl);
        return false;
    }
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, use_mtls ? 1L : 0L);

    SslMemIdentity mem_id{&identity_.cert_pem, &identity_.key_pem, &pinned};
    if (use_mtls) {
        if (identity_.cert_pem.empty() || identity_.key_pem.empty()) {
            out_err = "Client mTLS identity not initialized";
            curl_easy_cleanup(curl);
            return false;
        }
        if (curl_easy_setopt(curl, CURLOPT_SSL_CTX_FUNCTION, ssl_ctx_cb) != CURLE_OK ||
            curl_easy_setopt(curl, CURLOPT_SSL_CTX_DATA, &mem_id) != CURLE_OK) {
            out_err = "libcurl SSL_CTX_FUNCTION unsupported";
            curl_easy_cleanup(curl);
            return false;
        }
    }

    if (abort_flag) {
        curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, curl_xferinfo_cb);
        curl_easy_setopt(curl, CURLOPT_XFERINFODATA, const_cast<std::atomic<bool>*>(abort_flag));
    }

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK) {
        out_err = (res == CURLE_ABORTED_BY_CALLBACK) ? "Cancelled" : curl_easy_strerror(res);
        curl_easy_cleanup(curl);
        return false;
    }
    long http_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    curl_easy_cleanup(curl);
    if (http_code >= 400) {
        out_err = "HTTP error " + std::to_string(http_code);
        return false;
    }
    return true;
#else
    (void)url;
    (void)host_ip;
    (void)use_mtls;
    (void)out_body;
    (void)timeout_sec;
    (void)abort_flag;
    out_err = "Compiled without OpenSSL/libcurl";
    return false;
#endif
}

bool HostHttpClient::unpair(const std::string& host_ip, uint16_t http_port) {
    std::string body, err;
    std::string url = "http://" + host_ip + ":" + std::to_string(http_port) +
                      "/unpair?uniqueid=" + identity_.unique_id;
    return http_get(url, host_ip, false, body, err, 5L);
}

ServerInfo HostHttpClient::fetch_serverinfo(const std::string& host_ip, uint16_t http_port, uint16_t https_port) {
    ServerInfo info;
    std::string body, err;
    bool ok = false;
    if (!pinned_server_cert(host_ip).empty()) {
        std::string https_url = "https://" + host_ip + ":" + std::to_string(https_port) +
                                "/serverinfo?uniqueid=" + identity_.unique_id;
        ok = http_get(https_url, host_ip, true, body, err);
        if (!ok) {
            // Do not silently downgrade to unauthenticated HTTP when a pinned server cert fails TLS verification
            info.raw_error = err;
            return info;
        }
    } else {
        std::string http_url = "http://" + host_ip + ":" + std::to_string(http_port) +
                               "/serverinfo?uniqueid=" + identity_.unique_id;
        ok = http_get(http_url, host_ip, false, body, err);
    }
    if (!ok) {
        info.raw_error = err;
        return info;
    }
    if (auto v = extract_xml_tag(body, "hostname")) info.hostname = *v;
    if (auto v = extract_xml_tag(body, "uniqueid")) info.unique_id = *v;
    if (auto v = extract_xml_tag(body, "appversion")) info.app_version = *v;
    if (auto v = extract_xml_tag(body, "GfeVersion")) info.gfe_version = *v;
    if (auto v = extract_xml_tag(body, "PairStatus")) info.paired = (*v == "1");
    if (auto v = extract_xml_tag(body, "currentgame")) info.current_game = std::atoi(v->c_str());
    info.frame_warp_version = parse_frame_warp_version(body);
    info.server_codec_mode_support = parse_server_codec_mode_support(body);
    return info;
}

bool HostHttpClient::pair_with_pin(
    const std::string& host_ip, const std::string& pin, std::string& out_error, uint16_t http_port, uint16_t https_port) {
#ifdef NIGHTJAR_HAVE_CURL_OPENSSL
    cancel_pairing_.store(false, std::memory_order_release);

    auto fail_and_unpair = [&](const std::string& msg) {
        out_error = msg;
        unpair(host_ip, http_port);
        return false;
    };

    // Step 1: Generate 16-byte salt & derive AES-128 key = SHA-256(salt || pin)[0..16]
    uint8_t salt[16];
    RAND_bytes(salt, sizeof(salt));
    std::vector<uint8_t> salted(salt, salt + 16);
    salted.insert(salted.end(), pin.begin(), pin.end());
    auto key_hash = sha256_bytes(salted.data(), salted.size());
    uint8_t aes_key[16];
    std::memcpy(aes_key, key_hash.data(), 16);

    std::string base_http = "http://" + host_ip + ":" + std::to_string(http_port) +
                            "/pair?uniqueid=" + identity_.unique_id + "&devicename=Nightjar&updateState=1";
    std::string cert_hex = to_hex(reinterpret_cast<const uint8_t*>(identity_.cert_pem.data()), identity_.cert_pem.size());

    // Step 2: getservercert (long 120s timeout while user enters PIN on host)
    std::string body;
    if (!http_get(
            base_http + "&phrase=getservercert&salt=" + to_hex(salt, 16) + "&clientcert=" + cert_hex,
            host_ip,
            false,
            body,
            out_error,
            120L,
            &cancel_pairing_)) {
        return fail_and_unpair(out_error);
    }
    auto paired_step = extract_xml_tag(body, "paired");
    if (!paired_step || *paired_step != "1") {
        return fail_and_unpair("Host rejected PIN or is already pairing");
    }
    auto plaincert_hex = extract_xml_tag(body, "plaincert");
    if (!plaincert_hex) {
        return fail_and_unpair("Host did not return plaincert");
    }
    auto server_cert_bytes = from_hex(*plaincert_hex);
    std::string server_cert_pem(reinterpret_cast<const char*>(server_cert_bytes.data()), server_cert_bytes.size());

    BIO* sbio = BIO_new_mem_buf(server_cert_bytes.data(), static_cast<int>(server_cert_bytes.size()));
    X509* server_x509 = PEM_read_bio_X509(sbio, nullptr, nullptr, nullptr);
    BIO_free(sbio);
    if (!server_x509) {
        return fail_and_unpair("Failed to parse server X509 cert");
    }

    // Step 3: clientchallenge
    std::vector<uint8_t> client_challenge(16);
    RAND_bytes(client_challenge.data(), 16);
    auto enc_challenge = aes_ecb_crypt(aes_key, client_challenge, true);
    if (!http_get(
            base_http + "&clientchallenge=" + to_hex(enc_challenge.data(), enc_challenge.size()),
            host_ip,
            false,
            body,
            out_error,
            15L,
            &cancel_pairing_)) {
        X509_free(server_x509);
        return fail_and_unpair(out_error);
    }
    paired_step = extract_xml_tag(body, "paired");
    if (!paired_step || *paired_step != "1") {
        X509_free(server_x509);
        return fail_and_unpair("Host rejected clientchallenge");
    }
    auto chall_resp_hex = extract_xml_tag(body, "challengeresponse");
    if (!chall_resp_hex) {
        X509_free(server_x509);
        return fail_and_unpair("Missing challengeresponse from host");
    }
    auto dec_resp = aes_ecb_crypt(aes_key, from_hex(*chall_resp_hex), false);
    if (dec_resp.size() < 48) {
        X509_free(server_x509);
        return fail_and_unpair("Short decrypted challengeresponse");
    }
    std::vector<uint8_t> server_response_hash(dec_resp.begin(), dec_resp.begin() + 32);

    std::vector<uint8_t> client_secret(16);
    RAND_bytes(client_secret.data(), 16);

    BIO* cbio = BIO_new_mem_buf(identity_.cert_pem.data(), static_cast<int>(identity_.cert_pem.size()));
    X509* client_x509 = cbio ? PEM_read_bio_X509(cbio, nullptr, nullptr, nullptr) : nullptr;
    if (cbio) BIO_free(cbio);
    const ASN1_BIT_STRING* client_sig = nullptr;
    if (client_x509) {
        X509_get0_signature(&client_sig, nullptr, client_x509);
    }
    if (!client_x509 || !client_sig || !client_sig->data || client_sig->length <= 0) {
        if (client_x509) X509_free(client_x509);
        X509_free(server_x509);
        return fail_and_unpair("Client X509 identity is missing or invalid");
    }

    std::vector<uint8_t> hash_input;
    hash_input.insert(hash_input.end(), dec_resp.begin() + 32, dec_resp.begin() + 48);
    hash_input.insert(hash_input.end(), client_sig->data, client_sig->data + client_sig->length);
    hash_input.insert(hash_input.end(), client_secret.begin(), client_secret.end());
    auto client_resp_hash = sha256_bytes(hash_input.data(), hash_input.size());
    auto enc_client_resp = aes_ecb_crypt(aes_key, client_resp_hash, true);
    X509_free(client_x509);

    // Step 4: serverchallengeresp -> verify server's pairingsecret & RSA signature
    if (!http_get(
            base_http + "&serverchallengeresp=" + to_hex(enc_client_resp.data(), enc_client_resp.size()),
            host_ip,
            false,
            body,
            out_error,
            15L,
            &cancel_pairing_)) {
        X509_free(server_x509);
        return fail_and_unpair(out_error);
    }
    paired_step = extract_xml_tag(body, "paired");
    auto pairing_secret_hex = extract_xml_tag(body, "pairingsecret");
    if (!paired_step || *paired_step != "1" || !pairing_secret_hex) {
        X509_free(server_x509);
        return fail_and_unpair("Host rejected serverchallengeresp");
    }
    auto srv_pairing_secret = from_hex(*pairing_secret_hex);
    if (srv_pairing_secret.size() <= 16) {
        X509_free(server_x509);
        return fail_and_unpair("Invalid server pairingsecret length");
    }

    // Verify server_response_hash == SHA256(client_challenge || server_cert_sig || server_secret)
    const ASN1_BIT_STRING* server_sig = nullptr;
    X509_get0_signature(&server_sig, nullptr, server_x509);
    if (!server_sig || !server_sig->data || server_sig->length <= 0) {
        X509_free(server_x509);
        return fail_and_unpair("Server X509 certificate signature missing");
    }
    std::vector<uint8_t> srv_hash_in;
    srv_hash_in.insert(srv_hash_in.end(), client_challenge.begin(), client_challenge.end());
    srv_hash_in.insert(srv_hash_in.end(), server_sig->data, server_sig->data + server_sig->length);
    srv_hash_in.insert(srv_hash_in.end(), srv_pairing_secret.begin(), srv_pairing_secret.begin() + 16);
    auto expected_srv_hash = sha256_bytes(srv_hash_in.data(), srv_hash_in.size());
    if (expected_srv_hash != server_response_hash) {
        X509_free(server_x509);
        return fail_and_unpair("Server challenge hash mismatch (wrong PIN or MITM)");
    }

    // Verify server RSA signature over server_secret[0..16]
    EVP_PKEY* srv_pub = X509_get0_pubkey(server_x509);
    EVP_MD_CTX* vctx = EVP_MD_CTX_new();
    bool sig_ok = false;
    if (srv_pub && vctx &&
        EVP_DigestVerifyInit(vctx, nullptr, EVP_sha256(), nullptr, srv_pub) == 1 &&
        EVP_DigestVerifyUpdate(vctx, srv_pairing_secret.data(), 16) == 1 &&
        EVP_DigestVerifyFinal(vctx, srv_pairing_secret.data() + 16, srv_pairing_secret.size() - 16) == 1) {
        sig_ok = true;
    }
    if (vctx) EVP_MD_CTX_free(vctx);
    X509_free(server_x509);
    if (!sig_ok) {
        return fail_and_unpair("Server pairing signature verification failed");
    }

    // Step 5: sign client_secret with client private key and send clientpairingsecret
    BIO* kbio = BIO_new_mem_buf(identity_.key_pem.data(), static_cast<int>(identity_.key_pem.size()));
    EVP_PKEY* pkey = kbio ? PEM_read_bio_PrivateKey(kbio, nullptr, nullptr, nullptr) : nullptr;
    if (kbio) BIO_free(kbio);
    EVP_MD_CTX* mdctx = EVP_MD_CTX_new();
    size_t sig_len = 0;
    std::vector<uint8_t> secret_sig;
    bool signed_ok = false;
    if (pkey && mdctx &&
        EVP_DigestSignInit(mdctx, nullptr, EVP_sha256(), nullptr, pkey) == 1 &&
        EVP_DigestSignUpdate(mdctx, client_secret.data(), client_secret.size()) == 1 &&
        EVP_DigestSignFinal(mdctx, nullptr, &sig_len) == 1) {
        secret_sig.resize(sig_len);
        signed_ok = (EVP_DigestSignFinal(mdctx, secret_sig.data(), &sig_len) == 1);
    }
    if (mdctx) EVP_MD_CTX_free(mdctx);
    if (pkey) EVP_PKEY_free(pkey);
    if (!signed_ok) {
        return fail_and_unpair("Failed to sign client pairing secret");
    }

    std::vector<uint8_t> pairing_secret = client_secret;
    pairing_secret.insert(pairing_secret.end(), secret_sig.begin(), secret_sig.begin() + sig_len);
    if (!http_get(
            base_http + "&clientpairingsecret=" + to_hex(pairing_secret.data(), pairing_secret.size()),
            host_ip,
            false,
            body,
            out_error,
            15L,
            &cancel_pairing_)) {
        return fail_and_unpair(out_error);
    }

    // Pin verified server certificate before HTTPS pairchallenge
    set_pinned_server_cert(host_ip, server_cert_pem);

    // Step 6: HTTPS pairchallenge
    std::string https_pair = "https://" + host_ip + ":" + std::to_string(https_port) +
                             "/pair?uniqueid=" + identity_.unique_id + "&devicename=Nightjar&updateState=1&phrase=pairchallenge";
    if (!http_get(https_pair, host_ip, true, body, out_error, 15L, &cancel_pairing_)) {
        set_pinned_server_cert(host_ip, "");
        return fail_and_unpair(out_error);
    }
    auto paired = extract_xml_tag(body, "paired");
    if (!paired || *paired != "1") {
        set_pinned_server_cert(host_ip, "");
        return fail_and_unpair("HTTPS pairchallenge did not confirm paired=1");
    }
    return true;
#else
    (void)host_ip; (void)pin; (void)http_port; (void)https_port;
    out_error = "Compiled without OpenSSL/libcurl";
    return false;
#endif
}

std::vector<HostApp> HostHttpClient::fetch_applist(const std::string& host_ip, std::string& out_error, uint16_t https_port) {
    std::string body;
    std::string url = "https://" + host_ip + ":" + std::to_string(https_port) +
                      "/applist?uniqueid=" + identity_.unique_id;
    if (!http_get(url, host_ip, true, body, out_error)) {
        return {};
    }
    return parse_applist_xml(body);
}

LaunchResult HostHttpClient::launch_or_resume(
    const std::string& host_ip,
    int app_id,
    uint32_t width,
    uint32_t height,
    uint32_t fps,
    const std::string& rikey_hex,
    uint32_t rikeyid,
    bool resume,
    uint32_t active_gamepad_mask,
    bool hdr,
    bool surround51,
    uint16_t https_port) {
    LaunchResult res;
    uint32_t pad_mask = active_gamepad_mask ? active_gamepad_mask : 1u;
    uint32_t surround_info = surround51 ? 458758u : 196610u; // 0x70006 (5.1) vs 0x30002 (stereo)

    std::ostringstream url;
    url << "https://" << host_ip << ":" << https_port
        << (resume ? "/resume" : "/launch")
        << "?uniqueid=" << identity_.unique_id
        << "&appid=" << app_id
        << "&mode=" << width << "x" << height << "x" << fps
        << "&additionalStates=1&sops=0"
        << "&rikey=" << rikey_hex
        << "&rikeyid=" << rikeyid
        << "&hdrMode=" << (hdr ? 1 : 0)
        << "&localAudioPlayMode=0"
        << "&surroundAudioInfo=" << surround_info
        << "&remoteControllersBitmap=" << pad_mask
        << "&gcmap=" << pad_mask;

    std::string body, err;
    if (!http_get(url.str(), host_ip, true, body, err, 20L)) {
        res.error = err;
        return res;
    }
    auto rtsp = extract_xml_tag(body, "sessionUrl0");
    if (!rtsp || rtsp->empty()) {
        res.error = "Host did not return sessionUrl0";
        return res;
    }
    res.ok = true;
    res.rtsp_session_url = *rtsp;
    return res;
}

bool HostHttpClient::cancel_app(const std::string& host_ip, uint16_t https_port) {
    std::string body, err;
    std::string url = "https://" + host_ip + ":" + std::to_string(https_port) +
                      "/cancel?uniqueid=" + identity_.unique_id;
    return http_get(url, host_ip, true, body, err);
}

} // namespace nightjar::tizen
