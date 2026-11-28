#include "warp_gl_renderer.hpp"

#include <cmath>
#include <vector>

namespace nightjar::tizen {

#ifdef __EMSCRIPTEN__
namespace {

constexpr const char* kVertSrc =
    "attribute vec2 aPos;\n"
    "attribute vec2 aUv;\n"
    "varying vec2 vUv;\n"
    "void main() {\n"
    "    vUv = aUv;\n"
    "    gl_Position = vec4(aPos, 0.0, 1.0);\n"
    "}\n";

// Exact Nightjar Frame Warp v1 shader adapted for Samsung Tizen's GL_TEXTURE_EXTERNAL_OES
constexpr const char* kFragSrc =
    "#extension GL_OES_EGL_image_external : require\n"
    "precision highp float;\n"
    "uniform samplerExternalOES uVideo;\n"
    "uniform lowp sampler2D uHudMask;\n"
    "uniform vec3 uWarp;\n"
    "uniform vec4 uLens;\n"
    "uniform vec4 uWarpRect;\n"
    "varying vec2 vUv;\n"
    "void main() {\n"
    "    vec2 picture = vec2(vUv.x, 1.0 - vUv.y);\n"
    "    vec2 samplePic = picture;\n"
    "    float fade = 1.0;\n"
    "    if (uWarp.x != 0.0 || uWarp.y != 0.0) {\n"
    "        bool hud = (uWarp.z > 0.5) && (texture2D(uHudMask, picture).r > 0.5);\n"
    "        if (!hud) {\n"
    "            vec2 q = picture - 0.5;\n"
    "            vec2 p = 0.5 + (q * uLens.zw - uWarp.xy) / max(1.0 + dot(q, uLens.xy), 0.25);\n"
    "            vec2 outside = max(-p, p - 1.0);\n"
    "            float edgeFade = 1.0 - 0.35 * clamp(max(max(outside.x, outside.y), 0.0) / 0.08, 0.0, 1.0);\n"
    "            p = 1.0 - abs(1.0 - abs(p));\n"
    "            if (uWarp.z <= 0.5 || texture2D(uHudMask, p).r <= 0.5) {\n"
    "                fade = edgeFade;\n"
    "                samplePic = clamp(p, 0.0, 1.0);\n"
    "            }\n"
    "        }\n"
    "    }\n"
    "    vec2 cropped = uWarpRect.xy + clamp(samplePic, 0.0, 1.0) * uWarpRect.zw;\n"
    "    gl_FragColor = vec4(texture2D(uVideo, cropped).rgb * fade, 1.0);\n"
    "}\n";

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

void WarpGlRenderer::sync_viewport() {
#ifdef __EMSCRIPTEN__
    if (webgl_ctx_ <= 0) return;
    int db_w = 0;
    int db_h = 0;
    if (emscripten_webgl_get_drawing_buffer_size(webgl_ctx_, &db_w, &db_h) == EMSCRIPTEN_RESULT_SUCCESS &&
        db_w > 0 && db_h > 0 && (db_w != viewport_w_ || db_h != viewport_h_)) {
        viewport_w_ = db_w;
        viewport_h_ = db_h;
        glViewport(0, 0, db_w, db_h);
    }
#endif
}

bool WarpGlRenderer::init(int width, int height) {
#ifdef __EMSCRIPTEN__
    if (!webgl_ctx_) {
        EmscriptenWebGLContextAttributes attrs;
        emscripten_webgl_init_context_attributes(&attrs);
        attrs.alpha = EM_FALSE;
        attrs.depth = EM_FALSE;
        attrs.stencil = EM_FALSE;
        attrs.antialias = EM_FALSE;
        attrs.preserveDrawingBuffer = EM_FALSE;
        attrs.majorVersion = 1;
        attrs.minorVersion = 0;
        attrs.enableExtensionsByDefault = EM_TRUE;
        webgl_ctx_ = emscripten_webgl_create_context("#stream-canvas", &attrs);
        if (webgl_ctx_ <= 0) {
            webgl_ctx_ = 0;
            return false;
        }
    }
    if (emscripten_webgl_make_context_current(webgl_ctx_) != EMSCRIPTEN_RESULT_SUCCESS) {
        return false;
    }
    emscripten_webgl_enable_extension(webgl_ctx_, "OES_EGL_image_external");

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

    static const float kQuad[] = {
        -1.0f, -1.0f, 0.0f, 0.0f,
         1.0f, -1.0f, 1.0f, 0.0f,
        -1.0f,  1.0f, 0.0f, 1.0f,
         1.0f,  1.0f, 1.0f, 1.0f,
    };
    glGenBuffers(1, &vbo_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(kQuad), kQuad, GL_STATIC_DRAW);

    a_pos_ = glGetAttribLocation(program_, "aPos");
    a_uv_ = glGetAttribLocation(program_, "aUv");
    u_video_ = glGetUniformLocation(program_, "uVideo");
    u_hud_mask_ = glGetUniformLocation(program_, "uHudMask");
    u_warp_ = glGetUniformLocation(program_, "uWarp");
    u_lens_ = glGetUniformLocation(program_, "uLens");
    u_warp_rect_ = glGetUniformLocation(program_, "uWarpRect");

    glGenTextures(3, video_texs_.data());
    glActiveTexture(GL_TEXTURE0);
    for (GLuint tex : video_texs_) {
        glBindTexture(GL_TEXTURE_EXTERNAL_OES, tex);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    }

    glGenTextures(1, &mask_tex_);
    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, mask_tex_);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    uint8_t zero = 0;
    glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, 1, 1, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, &zero);

    viewport_w_ = 0;
    viewport_h_ = 0;
    sync_viewport();
    if (viewport_w_ == 0 || viewport_h_ == 0) {
        resize(width, height);
    }
    return true;
#else
    (void)width;
    (void)height;
    return true;
#endif
}

bool WarpGlRenderer::make_current() {
#ifdef __EMSCRIPTEN__
    return webgl_ctx_ > 0 && emscripten_webgl_make_context_current(webgl_ctx_) == EMSCRIPTEN_RESULT_SUCCESS;
#else
    return true;
#endif
}

void WarpGlRenderer::resize(int width, int height) {
#ifdef __EMSCRIPTEN__
    viewport_w_ = width;
    viewport_h_ = height;
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
        glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, 1, 1, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, &zero);
        known_mask_gen_.reset();
        has_mask_ = false;
    } else {
        auto r8 = updated->pack_r8();
        glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, updated->width, updated->height, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, r8.data());
        known_mask_gen_ = updated->generation;
        has_mask_ = true;
    }
#endif
}

void WarpGlRenderer::draw(GLuint video_tex, const frame_warp::Warp& w, uint32_t frame_number, uint32_t input_seq) {
#ifdef __EMSCRIPTEN__
    if (video_tex == 0) return;
    sync_viewport();
    glUseProgram(program_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glEnableVertexAttribArray(static_cast<GLuint>(a_pos_));
    glVertexAttribPointer(static_cast<GLuint>(a_pos_), 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<const void*>(0));
    glEnableVertexAttribArray(static_cast<GLuint>(a_uv_));
    glVertexAttribPointer(static_cast<GLuint>(a_uv_), 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<const void*>(2 * sizeof(float)));

    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_EXTERNAL_OES, video_tex);
    glUniform1i(u_video_, 0);

    glActiveTexture(GL_TEXTURE1);
    glBindTexture(GL_TEXTURE_2D, mask_tex_);
    glUniform1i(u_hud_mask_, 1);

    float mask_active = (w.active && has_mask_ && w.mask_generation.has_value()) ? 1.0f : 0.0f;
    glUniform3f(u_warp_, w.active ? w.uv[0] : 0.0f, w.active ? w.uv[1] : 0.0f, mask_active);
    const auto& l = w.active ? w.lens : frame_warp::kFlatLens;
    glUniform4f(u_lens_, l[0], l[1], l[2], l[3]);
    glUniform4f(u_warp_rect_, warp_rect_[0], warp_rect_[1], warp_rect_[2], warp_rect_[3]);

    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
#else
    (void)video_tex;
#endif
    last_drawn_px_ = w.active ? w.pixels : std::array<float, 2>{0.0f, 0.0f};
    last_drawn_frame_ = frame_number;
    last_input_seq_ = input_seq;
}

bool WarpGlRenderer::maybe_redraw_between_frames(GLuint video_tex, frame_warp::FrameWarp& warp, uint64_t now_us) {
    if (video_tex == 0 || !last_drawn_frame_.has_value()) return false;
    bool has_shift = (last_drawn_px_[0] != 0.0f || last_drawn_px_[1] != 0.0f);
    bool input_changed = warp.input_seq() != last_input_seq_;
    if (!has_shift && !input_changed && !warp.stick_deflected()) return false;

    auto candidate = warp.peek(*last_drawn_frame_, now_us);
    float dx = candidate.pixels[0] - last_drawn_px_[0];
    float dy = candidate.pixels[1] - last_drawn_px_[1];
    if (std::hypot(dx, dy) < frame_warp::kRepeatStepPx) return false;

    auto committed = warp.warp(*last_drawn_frame_, now_us);
    sync_hud_mask(warp);
    draw(video_tex, committed, *last_drawn_frame_, warp.input_seq());
    return true;
}

void WarpGlRenderer::destroy() {
#ifdef __EMSCRIPTEN__
    if (webgl_ctx_ > 0) {
        emscripten_webgl_make_context_current(webgl_ctx_);
    }
    if (video_texs_[0] || video_texs_[1] || video_texs_[2]) {
        glDeleteTextures(3, video_texs_.data());
        video_texs_ = {0, 0, 0};
    }
    if (mask_tex_) { glDeleteTextures(1, &mask_tex_); mask_tex_ = 0; }
    if (vbo_) { glDeleteBuffers(1, &vbo_); vbo_ = 0; }
    if (program_) { glDeleteProgram(program_); program_ = 0; }
    if (webgl_ctx_ > 0) {
        emscripten_webgl_destroy_context(webgl_ctx_);
        webgl_ctx_ = 0;
    }
    viewport_w_ = 0;
    viewport_h_ = 0;
#endif
}

} // namespace nightjar::tizen
