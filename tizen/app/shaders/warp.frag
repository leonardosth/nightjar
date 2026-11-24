#version 300 es
// Nightjar Frame Warp v1 fragment shader for Samsung Tizen OS 10 (WebGL 2.0 / GLES 3.00 es)
// Exact port of app/src/main/assets/shaders/warp.frag & protocol/desktop-media/src/frame_warp.hlsl
//
// Features:
//  - Perspective camera lens warping: source = 0.5 + (q * lens.zw - warp.xy) / max(1 + dot(q, lens.xy), 0.25)
//  - Dual HUD mask check (both destination & shifted source) to prevent HUD shift AND HUD ghosting
//  - Mirrored edge reflection with 35% progressive darkening over 8% past edge (no clamp streaking)
//  - Encoder alignment padding crop (uWarpRect) so padded decoder edges never bleed into view
precision highp float;

uniform highp sampler2D uVideo;
// One byte per cell (GL_R8, 0 or 255), rows top-to-bottom: set where HUD stays put. Nearest, clamped.
uniform lowp sampler2D uHudMask;
// xy: centre shift as fraction of picture width/height (y down); z: 1.0 when HUD mask is active.
uniform vec3 uWarp;
// Perspective lens terms: xy = k, zw = n (0, 0, 1, 1 for flat translation).
uniform vec4 uLens;
// Stream picture rect inside potentially padded decoder texture: xy = offset, zw = scale (default 0,0,1,1).
uniform vec4 uWarpRect;
// 1.0 when video texture has origin at top-left (WebGL texImage2D with UNPACK_FLIP_Y=false),
// 0.0 when origin is bottom-left (GLES/Tizen kVideoTexture bottom-left orientation).
uniform float uVideoTopDown;

in vec2 vUv;
out vec4 fragColor;

vec2 pictureToVideoUv(vec2 picture) {
    // picture has y-down (0 = top, 1 = bottom)
    vec2 cropped = uWarpRect.xy + clamp(picture, 0.0, 1.0) * uWarpRect.zw;
    return uVideoTopDown > 0.5 ? cropped : vec2(cropped.x, 1.0 - cropped.y);
}

void main() {
    // vUv has y-up (0 = bottom, 1 = top); convert to picture space (y-down)
    vec2 picture = vec2(vUv.x, 1.0 - vUv.y);
    vec2 samplePic = picture;
    float fade = 1.0;

    // Uniform branch: zero overhead when shift is zero
    if (uWarp.x != 0.0 || uWarp.y != 0.0) {
        bool hud = (uWarp.z > 0.5) && (texture(uHudMask, picture).r > 0.5);
        if (!hud) {
            vec2 q = picture - 0.5;
            vec2 p = 0.5 + (q * uLens.zw - uWarp.xy) / max(1.0 + dot(q, uLens.xy), 0.25);
            vec2 outside = max(-p, p - 1.0);
            float edgeFade = 1.0 - 0.35 * clamp(max(max(outside.x, outside.y), 0.0) / 0.08, 0.0, 1.0);
            // Mirror past edges: -p below 0, 2 - p above 1
            p = 1.0 - abs(1.0 - abs(p));
            // Dual HUD mask check: if shifted source lands on HUD, keep unshifted pixel to avoid ghosting
            if (uWarp.z <= 0.5 || texture(uHudMask, p).r <= 0.5) {
                fade = edgeFade;
                samplePic = clamp(p, 0.0, 1.0);
            }
        }
    }

    vec2 videoUv = pictureToVideoUv(samplePic);
    vec3 rgb = texture(uVideo, videoUv).rgb * fade;
    fragColor = vec4(rgb, 1.0);
}
