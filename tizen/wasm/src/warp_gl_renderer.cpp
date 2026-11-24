#include "warp_gl_renderer.hpp"

#include <cmath>
#include <vector>

namespace nightjar::tizen {

#ifdef __EMSCRIPTEN__
namespace {

constexpr const char* kVertSrc = R"(#version 300 es
precision highp float;
const vec2 POSITIONS[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
);
const vec2 TEXCOORDS[4] = vec2[4](
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(1.0, 1.0)
);
out vec2 vUv;
void main() {
    gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
    vUv = TEXCOORDS[gl_VertexID];
}
)";

constexpr const char* kFragSrc = R"(#version 300 es
precision highp float;
uniform highp sampler2D uVideo;
uniform lowp sampler2D uHudMask;
uniform vec3 uWarp;
uniform vec4 uLens;
uniform vec4 uWarpRect;
uniform float uVideoTopDown;
in vec2 vUv;
out vec4 fragColor;

vec2 pictureToVideoUv(vec2 picture) {
    vec2 cropped = uWarpRect.xy + clamp(picture, 0.0, 1.0) * uWarpRect.zw;
    return uVideoTopDown > 0.5 ? cropped : vec2(cropped.x, 1.0 - cropped.y);
}

void main() {
    vec2 picture = vec2(vUv.x, 1.0 - vUv.y);
    vec2 samplePic = picture;
    float fade = 1.0;

    if (uWarp.x != 0.0 || uWarp.y != 0.0) {
        bool hud = (uWarp.z > 0.5) && (texture(uHudMask, picture).r > 0.5);
        if (!hud) {
            vec2 q = picture - 0.5;
            vec2 p = 0.5 + (q * uLens.zw - uWarp.xy) / max(1.0 + dot(q, uLens.xy), 0.25);
            vec2 outside = max(-p, p - 1.0);
            float edgeFade = 1.0 - 0.35 * clamp(max(max(outside.x, outside.y), 0.0) / 0.08, 0.0, 1.0);
            p = 1.0 - abs(1.0 - abs(p));
            if (uWarp.z <= 0.5 || texture(uHudMask, p).r <= 0.5) {
                fade = edgeFade;
                samplePic = clamp(p, 0.0, 1.0);
            }
        }
    }

    vec2 videoUv = pictureToVideoUv(samplePic);
    fragColor = vec4(texture(uVideo, videoUv).rgb * fade, 1.0);
}
)";

GLuint compile_shader(GLenum type, const char* src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        glDeleteShader(s);
        return 0;
    }
    return s;
}

} // namespace
#endif

WarpGlRenderer::WarpGlRenderer() = default;
WarpGlRenderer::~WarpGlRenderer() { destroy(); }

bool WarpGlRenderer::init(int width, int height) {
#ifdef __EMSCRIPTEN__
    GLuint vs = compile_shader(GL_VERTEX_SHADER, kVertSrc);
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER, kFragSrc);
    if (!vs || !fs) return false;

    program_ = glCreateProgram();
    glAttachShader(program_, vs);
    glAttachShader(program_, fs);
    glLinkProgram(program_);
    glDeleteShader(vs);
    glDeleteShader(fs);

    GLint linked = 0;
    glGetProgramiv(program_, GL_LINK_STATUS, &linked);
    if (!linked) return false;

    glGenVertexArrays(1, &vao_);

    u_video_ = glGetUniformLocation(program_, "uVideo");
    u_hud_mask_ = glGetUniformLocation(program_, "uHudMask");
    u_warp_ = glGetUniformLocation(program_, "uWarp");
    u_lens_ = glGetUniformLocation(program_, "uLens");
    u_warp_rect_ = glGetUniformLocation(program_, "uWarpRect");
    u_video_top_down_ = glGetUniformLocation(program_, "uVideoTopDown");

    glGenTextures(1, &video_tex_);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, video_tex_);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    glGenTextures(1, &mask_tex_);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, mask_tex_);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    uint8_t zero = 0;
    glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, 1, 1, 0, GL_RED, GL_UNSIGNED_BYTE, &zero);

    resize(width, height);
    return true;
#else
    (void)width;
    (void)height;
    return true;
#endif
}

void WarpGlRenderer::resize(int width, int height) {
#ifdef __EMSCRIPTEN__
    glViewport(0, 0, width, height);
#else
    (void)width;
    (void)height;
#endif
}

void WarpGlRenderer::set_picture_crop(uint32_t picture_w, uint32_t picture_h, uint32_t coded_w, uint32_t coded_h) {
    if (coded_w > picture_w || coded_h > picture_h) {
        warp_rect_ = {
            0.0f,
            0.0f,
            static_cast<float>(picture_w) / static_cast<float>(coded_w),
            static_cast<float>(picture_h) / static_cast<float>(coded_h),
        };
    } else {
        warp_rect_ = {0.0f, 0.0f, 1.0f, 1.0f};
    }
}

void WarpGlRenderer::sync_hud_mask(frame_warp::FrameWarp& warp) {
    std::shared_ptr<const frame_warp::Mask> updated;
    if (!warp.mask_since(known_mask_gen_, updated)) return;
#ifdef __EMSCRIPTEN__
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, mask_tex_);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    if (!updated) {
        uint8_t zero = 0;
        glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, 1, 1, 0, GL_RED, GL_UNSIGNED_BYTE, &zero);
        known_mask_gen_.reset();
        has_mask_ = false;
    } else {
        auto r8 = updated->pack_r8();
        glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, updated->width, updated->height, 0, GL_RED, GL_UNSIGNED_BYTE, r8.data());
        known_mask_gen_ = updated->generation;
        has_mask_ = true;
    }
#endif
}

void WarpGlRenderer::draw(const frame_warp::Warp& w, uint32_t frame_number, uint32_t input_seq) {
#ifdef __EMSCRIPTEN__
    glUseProgram(program_);
    glBindVertexArray(vao_);

    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, video_tex_);
    glUniform1i(u_video_, 0);

    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, mask_tex_);
    glUniform1i(u_hud_mask_, 1);

    float mask_active = (w.active && has_mask_ && w.mask_generation.has_value()) ? 1.0f : 0.0f;
    glUniform3f(u_warp_, w.active ? w.uv[0] : 0.0f, w.active ? w.uv[1] : 0.0f, mask_active);
    const auto& l = w.active ? w.lens : frame_warp::kFlatLens;
    glUniform4f(u_lens_, l[0], l[1], l[2], l[3]);
    glUniform4f(u_warp_rect_, warp_rect_[0], warp_rect_[1], warp_rect_[2], warp_rect_[3]);
    glUniform1f(u_video_top_down_, 0.0f);

    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
#endif
    last_drawn_px_ = w.active ? w.pixels : std::array<float, 2>{0.0f, 0.0f};
    last_drawn_frame_ = frame_number;
    last_input_seq_ = input_seq;
}

bool WarpGlRenderer::maybe_redraw_between_frames(frame_warp::FrameWarp& warp, uint64_t now_us) {
    if (!last_drawn_frame_.has_value()) return false;
    bool has_shift = (last_drawn_px_[0] != 0.0f || last_drawn_px_[1] != 0.0f);
    bool input_changed = warp.input_seq() != last_input_seq_;
    if (!has_shift && !input_changed && !warp.stick_deflected()) return false;

    auto candidate = warp.peek(*last_drawn_frame_, now_us);
    float dx = candidate.pixels[0] - last_drawn_px_[0];
    float dy = candidate.pixels[1] - last_drawn_px_[1];
    if (std::hypot(dx, dy) < frame_warp::kRepeatStepPx) return false;

    auto committed = warp.warp(*last_drawn_frame_, now_us);
    sync_hud_mask(warp);
    draw(committed, *last_drawn_frame_, warp.input_seq());
    return true;
}

void WarpGlRenderer::destroy() {
#ifdef __EMSCRIPTEN__
    if (video_tex_) { glDeleteTextures(1, &video_tex_); video_tex_ = 0; }
    if (mask_tex_) { glDeleteTextures(1, &mask_tex_); mask_tex_ = 0; }
    if (vao_) { glDeleteVertexArrays(1, &vao_); vao_ = 0; }
    if (program_) { glDeleteProgram(program_); program_ = 0; }
#endif
}

} // namespace nightjar::tizen
