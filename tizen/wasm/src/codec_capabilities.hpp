#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace nightjar::tizen {

struct VideoTrackCandidate {
    std::string mime;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t fps = 60;
};

// Builds an RFC-6381 codec MIME string sized for the requested resolution, fps, and bit depth
// (up to 4K@120 HEVC Level 5.2 / AV1 Level 5.1 / H.264 Level 5.2).
std::string build_video_mime(const std::string& codec, uint32_t width, uint32_t height, uint32_t fps, bool hdr10);

// Ordered list of EMSS AddTrack candidates preserving requested resolution without invalid Level 4.0 fallbacks on 4K.
std::vector<VideoTrackCandidate> build_video_track_candidates(
    const std::string& codec, uint32_t width, uint32_t height, uint32_t fps, bool hdr10);

// Strict token parser for RTSP DESCRIBE `a=x-rl-control:` lines (matches protocol/client/src/rtsp/describe.rs).
bool sdp_offers_frame_warp(const std::string& sdp);

} // namespace nightjar::tizen
