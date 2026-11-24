/**
 * Nightjar WebGL 2.0 Frame Warp Renderer for Samsung Tizen OS 10 (Chromium M130 / GLES 3.0)
 *
 * Supports:
 *  - Zero-copy Tizen WASM Player textures (RenderingMode::kVideoTexture)
 *  - WebCodecs VideoFrame / HTMLVideoElement / HTMLCanvasElement uploads (for TV preview & browser tests)
 *  - Dynamic GL_R8 HUD mask texture upload (generation-tracked via FrameWarp.maskSince)
 *  - Inter-frame redraws at native TV refresh rate (60/120/144 Hz) when shift moves >= 0.25 px
 */

import { FLAT, REPEAT_STEP_PX } from './frame-warp.js';

const VERTEX_SHADER_SRC = `#version 300 es
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
`;

const FRAGMENT_SHADER_SRC = `#version 300 es
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
    vec3 rgb = texture(uVideo, videoUv).rgb * fade;
    fragColor = vec4(rgb, 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

export class WarpRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error('WebGL 2.0 is required for Nightjar Frame Warp');
    }
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
    this.vao = gl.createVertexArray();

    this.uVideo = gl.getUniformLocation(program, 'uVideo');
    this.uHudMask = gl.getUniformLocation(program, 'uHudMask');
    this.uWarp = gl.getUniformLocation(program, 'uWarp');
    this.uLens = gl.getUniformLocation(program, 'uLens');
    this.uWarpRect = gl.getUniformLocation(program, 'uWarpRect');
    this.uVideoTopDown = gl.getUniformLocation(program, 'uVideoTopDown');

    // Video texture (unit 0)
    this.videoTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    // HUD mask texture (unit 1, GL_R8, nearest, clamp-to-edge)
    this.maskTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));

    this.knownMaskGeneration = null;
    this.hasMask = false;
    this.warpRect = [0.0, 0.0, 1.0, 1.0];
    this.videoTopDown = 1.0;

    // State for inter-frame redraw decisions (>= 0.25 px)
    this.lastDrawnPixels = [0.0, 0.0];
    this.lastDrawnFrame = null;
    this.lastInputSeq = 0;
    this.hasVideoFrame = false;
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  /** Crop encoder alignment padding (e.g. 1920x1080 inside 1920x1088 decoded buffer). */
  setPictureCrop(pictureW, pictureH, codedW, codedH) {
    if (codedW > pictureW || codedH > pictureH) {
      this.warpRect = [0.0, 0.0, pictureW / codedW, pictureH / codedH];
    } else {
      this.warpRect = [0.0, 0.0, 1.0, 1.0];
    }
  }

  /** Upload a WebCodecs VideoFrame, HTMLVideoElement, or HTMLCanvasElement to the GPU texture. */
  uploadVideoSource(source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.videoTopDown = 1.0;
    this.hasVideoFrame = true;
  }

  /** Sync HUD mask from FrameWarp controller if its generation changed. */
  syncHudMask(frameWarp) {
    const update = frameWarp.maskSince(this.knownMaskGeneration);
    if (update === undefined) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (update === null) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      this.knownMaskGeneration = null;
      this.hasMask = false;
    } else {
      const r8 = update.packR8();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, update.width, update.height, 0, gl.RED, gl.UNSIGNED_BYTE, r8);
      this.knownMaskGeneration = update.generation;
      this.hasMask = true;
    }
  }

  /** Draw the current video texture with the supplied Warp state. */
  draw(warp, frameNumber = null, inputSeq = 0) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.uniform1i(this.uVideo, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(this.uHudMask, 1);

    const active = warp && warp.active;
    const maskActive = active && this.hasMask && warp.maskGeneration !== null ? 1.0 : 0.0;
    const uvX = active ? warp.uv[0] : 0.0;
    const uvY = active ? warp.uv[1] : 0.0;
    const lens = active ? warp.lens : FLAT;

    gl.uniform3f(this.uWarp, uvX, uvY, maskActive);
    gl.uniform4f(this.uLens, lens[0], lens[1], lens[2], lens[3]);
    gl.uniform4f(this.uWarpRect, this.warpRect[0], this.warpRect[1], this.warpRect[2], this.warpRect[3]);
    gl.uniform1f(this.uVideoTopDown, this.videoTopDown);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.lastDrawnPixels = active ? [warp.pixels[0], warp.pixels[1]] : [0.0, 0.0];
    if (frameNumber !== null) {
      this.lastDrawnFrame = frameNumber;
    }
    this.lastInputSeq = inputSeq;
  }

  /**
   * Inter-frame redraw helper (matches Nightjar's vulkan_renderer.cpp / GlesUpscaler.java):
   * On TV refreshes between incoming video frames (e.g., 60 fps stream on 120 Hz Samsung TV),
   * re-warp the held video texture if camera input moved the shift by >= 0.25 px.
   */
  maybeRedrawBetweenFrames(frameWarp) {
    if (!this.hasVideoFrame || this.lastDrawnFrame === null) return false;
    const hasShift = this.lastDrawnPixels[0] !== 0.0 || this.lastDrawnPixels[1] !== 0.0;
    const inputChanged = frameWarp.inputSeq !== this.lastInputSeq;
    if (!hasShift && !inputChanged && !frameWarp.stickDeflected()) {
      return false;
    }
    const candidate = frameWarp.peek(this.lastDrawnFrame);
    const dx = candidate.pixels[0] - this.lastDrawnPixels[0];
    const dy = candidate.pixels[1] - this.lastDrawnPixels[1];
    if (Math.hypot(dx, dy) < REPEAT_STEP_PX) {
      return false;
    }
    const committed = frameWarp.warp(this.lastDrawnFrame);
    this.syncHudMask(frameWarp);
    this.draw(committed, this.lastDrawnFrame, frameWarp.inputSeq);
    return true;
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.videoTexture);
    gl.deleteTexture(this.maskTexture);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
