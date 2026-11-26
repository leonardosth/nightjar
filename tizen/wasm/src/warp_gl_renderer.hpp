#pragma once

#include "frame_warp_predictor.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <optional>

#ifdef __EMSCRIPTEN__
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <emscripten/html5.h>
#else
using GLuint = unsigned int;
using GLint = int;
using EMSCRIPTEN_WEBGL_CONTEXT_HANDLE = int;
#endif

namespace nightjar::tizen {

/**
 * GLES 2.0 + `GL_OES_EGL_image_external` Frame Warp renderer for Samsung Tizen WASM Player.
 * Allocates a 3-texture ring (`GL_TEXTURE_EXTERNAL_OES`) so the currently displayed texture
 * remains valid for 120 Hz inter-frame redraws until replaced by a newer decoded frame.
 */
class WarpGlRenderer {
public:
    WarpGlRenderer();
    ~WarpGlRenderer();

    bool init(int width, int height);
    void resize(int width, int height);
    void set_picture_crop(uint32_t picture_w, uint32_t picture_h, uint32_t coded_w, uint32_t coded_h);
    void sync_hud_mask(frame_warp::FrameWarp& warp);
    void draw(GLuint video_tex, const frame_warp::Warp& w, uint32_t frame_number, uint32_t input_seq);
    bool maybe_redraw_between_frames(GLuint video_tex, frame_warp::FrameWarp& warp, uint64_t now_us);

    std::array<GLuint, 3> video_textures() const { return video_texs_; }
    void destroy();

private:
    void sync_viewport();

    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE webgl_ctx_ = 0;
    GLuint program_ = 0;
    GLuint vbo_ = 0;
    std::array<GLuint, 3> video_texs_{0, 0, 0};
    GLuint mask_tex_ = 0;
    GLint a_pos_ = -1;
    GLint a_uv_ = -1;
    GLint u_video_ = -1;
    GLint u_hud_mask_ = -1;
    GLint u_warp_ = -1;
    GLint u_lens_ = -1;
    GLint u_warp_rect_ = -1;
    int viewport_w_ = 0;
    int viewport_h_ = 0;

    std::optional<uint16_t> known_mask_gen_;
    bool has_mask_ = false;
    std::array<float, 4> warp_rect_ = {0.0f, 0.0f, 1.0f, 1.0f};
    std::array<float, 2> last_drawn_px_ = {0.0f, 0.0f};
    std::optional<uint32_t> last_drawn_frame_;
    uint32_t last_input_seq_ = 0;
};

} // namespace nightjar::tizen
