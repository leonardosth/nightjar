#pragma once

#include <cstdint>
#include <string>

namespace nightjar::tizen {

// Builds an RFC-6381 codec MIME string sized for the requested resolution, fps, and bit depth
// (up to 4K@120 HEVC Level 5.2 / AV1 Level 5.1 / H.264 Level 5.2).
std::string build_video_mime(const std::string& codec, uint32_t width, uint32_t height, uint32_t fps, bool hdr10);

// Strict token parser for RTSP DESCRIBE `a=x-rl-control:` lines (matches protocol/client/src/rtsp/describe.rs).
bool sdp_offers_frame_warp(const std::string& sdp);

} // namespace nightjar::tizen
