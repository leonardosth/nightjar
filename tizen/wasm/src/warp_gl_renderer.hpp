#pragma once

#include "frame_warp_predictor.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <optional>

#ifdef __EMSCRIPTEN__
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#else
using GLuint = unsigned int;
using GLint = int;
#endif

namespace nightjar::tizen {

/**
 * GLES 2.0 + `GL_OES_EGL_image_external` Frame Warp renderer for Samsung Tizen WASM Player.
 * Uses `GL_TEXTURE_EXTERNAL_OES` (populated directly by `ElementaryMediaTrack::FillTextureWithNextFrame`)
 * and a `GL_LUMINANCE` 1-byte-per-cell HUD mask texture (`uHudMask`).
 */
class WarpGlRenderer {
public:
    WarpGlRenderer();
    ~WarpGlRenderer();

    bool init(int width, int height);
    void resize(int width, int height);
    void set_picture_crop(uint32_t picture_w, uint32_t picture_h, uint32_t coded_w, uint32_t coded_h);
    void sync_hud_mask(frame_warp::FrameWarp& warp);
    void draw(const frame_warp::Warp& w, uint32_t frame_number, uint32_t input_seq);
    bool maybe_redraw_between_frames(frame_warp::FrameWarp& warp, uint64_t now_us);

    GLuint video_texture() const { return video_tex_; }
    void destroy();

private:
    GLuint program_ = 0;
    GLuint vbo_ = 0;
    GLuint video_tex_ = 0;
    GLuint mask_tex_ = 0;
    GLint a_pos_ = -1;
    GLint a_uv_ = -1;
    GLint u_video_ = -1;
    GLint u_hud_mask_ = -1;
    GLint u_warp_ = -1;
    GLint u_lens_ = -1;
    GLint u_warp_rect_ = -1;

    std::optional<uint16_t> known_mask_gen_;
    bool has_mask_ = false;
    std::array<float, 4> warp_rect_ = {0.0f, 0.0f, 1.0f, 1.0f};
    std::array<float, 2> last_drawn_px_ = {0.0f, 0.0f};
    std::optional<uint32_t> last_drawn_frame_;
    uint32_t last_input_seq_ = 0;
};

} // namespace nightjar::tizen
