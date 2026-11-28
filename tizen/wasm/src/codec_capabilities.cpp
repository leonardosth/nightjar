#include "codec_capabilities.hpp"

#include <cctype>
#include <cstdint>
#include <cstdlib>

namespace nightjar::tizen {

std::string build_video_mime(const std::string& codec, uint32_t width, uint32_t height, uint32_t fps, bool hdr10) {
    const uint64_t pixels = static_cast<uint64_t>(width) * static_cast<uint64_t>(height);
    const uint64_t pixel_rate = pixels * static_cast<uint64_t>(fps ? fps : 60u);

    if (codec == "av1") {
        // AV1 Main profile (0), Main tier (M), 8-bit or 10-bit
        // Level 4.0 (08M) <= 1080p60, 4.1 (09M) <= 1080p120, 5.0 (12M) <= 4K60, 5.1 (13M) <= 4K120
        const char* level = "12M";
        if (pixels <= 1920ull * 1080ull && fps <= 60u) {
            level = "08M";
        } else if (pixels <= 1920ull * 1080ull && fps <= 120u) {
            level = "09M";
        } else if (pixel_rate <= 3840ull * 2160ull * 60ull) {
            level = "12M";
        } else {
            level = "13M";
        }
        return std::string("video/mp4; codecs=\"av01.0.") + level + (hdr10 ? ".10\"" : ".08\"");
    }

    if (codec == "h264") {
        // High profile (6400): Level 4.2 (2A) <= 1080p60, 5.0 (32) <= 1080p120/1440p60, 5.2 (34) for 4K60+
        const char* level = "2A";
        if (pixels <= 1920ull * 1080ull && fps <= 60u) {
            level = "2A";
        } else if (pixel_rate <= 1920ull * 1080ull * 120ull) {
            level = "32";
        } else {
            level = "34";
        }
        return std::string("video/mp4; codecs=\"avc1.6400") + level + "\"";
    }

    // Default: HEVC (H.265)
    // Main (hev1.1.6) vs Main10 (hev1.2.4)
    // Level 4.1 (L123) <= 1080p60, 5.0 (L150) <= 1440p60/1080p120, 5.1 (L153) <= 4K60, 5.2 (L156) <= 4K120
    const char* profile = hdr10 ? "hev1.2.4" : "hev1.1.6";
    const char* level = "L153";
    if (pixels <= 1920ull * 1080ull && fps <= 60u) {
        level = "L123";
    } else if (pixel_rate <= 1920ull * 1080ull * 120ull) {
        level = "L150";
    } else if (pixel_rate <= 3840ull * 2160ull * 60ull) {
        level = "L153";
    } else {
        level = "L156";
    }
    return std::string("video/mp4; codecs=\"") + profile + "." + level + ".B0\"";
}

std::vector<VideoTrackCandidate> build_video_track_candidates(
    const std::string& codec, uint32_t width, uint32_t height, uint32_t fps, bool hdr10) {
    const uint32_t eff_fps = fps ? fps : 60u;
    std::vector<VideoTrackCandidate> out;
    auto push_unique = [&](const std::string& mime, uint32_t w, uint32_t h, uint32_t f) {
        for (const auto& existing : out) {
            if (existing.mime == mime && existing.width == w && existing.height == h && existing.fps == f) {
                return;
            }
        }
        out.push_back(VideoTrackCandidate{mime, w, h, f});
    };

    push_unique(build_video_mime(codec, width, height, eff_fps, hdr10), width, height, eff_fps);
    if (eff_fps > 60u) {
        push_unique(build_video_mime(codec, width, height, 60u, hdr10), width, height, 60u);
    }
    if (width <= 1920u && height <= 1080u) {
        const char* base1080 = nullptr;
        if (codec == "av1") {
            base1080 = hdr10 ? "video/mp4; codecs=\"av01.0.08M.10\"" : "video/mp4; codecs=\"av01.0.08M.08\"";
        } else if (codec == "h264") {
            base1080 = "video/mp4; codecs=\"avc1.64002A\"";
        } else {
            base1080 = hdr10 ? "video/mp4; codecs=\"hev1.2.4.L123.B0\"" : "video/mp4; codecs=\"hev1.1.6.L123.B0\"";
        }
        push_unique(base1080, width, height, 60u);
    }
    return out;
}

bool sdp_offers_frame_warp(const std::string& sdp) {
    constexpr const char* kPrefix = "a=x-rl-control:";
    constexpr size_t kPrefixLen = 15;
    size_t pos = 0;
    while (pos < sdp.size()) {
        size_t nl = sdp.find('\n', pos);
        size_t end = (nl == std::string::npos) ? sdp.size() : nl;
        size_t line_end = (end > pos && sdp[end - 1] == '\r') ? (end - 1) : end;

        if (line_end - pos >= kPrefixLen && sdp.compare(pos, kPrefixLen, kPrefix) == 0) {
            size_t cur = pos + kPrefixLen;
            while (cur < line_end) {
                size_t comma = sdp.find(',', cur);
                if (comma == std::string::npos || comma > line_end) comma = line_end;

                size_t a = cur;
                while (a < comma && (sdp[a] == ' ' || sdp[a] == '\t')) ++a;
                size_t b = comma;
                while (b > a && (sdp[b - 1] == ' ' || sdp[b - 1] == '\t')) --b;

                if (b > a) {
                    int base = 10;
                    size_t dstart = a;
                    if (b - a > 2 && sdp[a] == '0' && (sdp[a + 1] == 'x' || sdp[a + 1] == 'X')) {
                        base = 16;
                        dstart = a + 2;
                    }
                    bool valid = (dstart < b);
                    unsigned long val = 0;
                    for (size_t i = dstart; i < b && valid; ++i) {
                        char c = sdp[i];
                        int digit = -1;
                        if (c >= '0' && c <= '9') digit = c - '0';
                        else if (base == 16 && c >= 'a' && c <= 'f') digit = 10 + (c - 'a');
                        else if (base == 16 && c >= 'A' && c <= 'F') digit = 10 + (c - 'A');
                        if (digit < 0 || val > 0xFFFFul) {
                            valid = false;
                            break;
                        }
                        val = val * static_cast<unsigned long>(base) + static_cast<unsigned long>(digit);
                    }
                    if (valid && val == 0x5543ul) {
                        return true;
                    }
                }
                cur = (comma < line_end) ? (comma + 1) : line_end;
            }
        }
        pos = (nl == std::string::npos) ? sdp.size() : (nl + 1);
    }
    return false;
}

} // namespace nightjar::tizen
