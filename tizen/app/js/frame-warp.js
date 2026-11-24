/**
 * Nightjar Frame Warp v1 — Protocol Wire Codecs & Client Predictor
 *
 * Bit-exact port of:
 *   - protocol/core/src/frame_warp.rs (control messages 0x5543..=0x5546, LEB128 RLE HUD mask, stick_curve)
 *   - protocol/client/src/frame_warp.rs (Predictor, FrameWarp, lens_terms, source, edge, extrapolation, rebasing)
 *   - protocol/android/src/frame_warp.rs (FrameRing pts -> frame_number, pack_r8)
 *
 * Spec: docs/protocol/frame-warp.md
 */

export const FRAME_WARP_REQUEST_MESSAGE_TYPE = 0x5543;
export const FRAME_WARP_MODEL_MESSAGE_TYPE = 0x5544;
export const FRAME_WARP_TAGS_MESSAGE_TYPE = 0x5545;
export const FRAME_WARP_MASK_MESSAGE_TYPE = 0x5546;
export const SERVERINFO_FIELD = 'FrameWarpVersion';
export const VERSION = 1;

export const REQUEST_BYTES = 8;
export const TAGS_HEADER_BYTES = 4;
export const TAG_BYTES = 20;
export const MAX_TAGS = 4;
export const MODEL_BYTES = 52;
export const MODEL_FLAT_BYTES = 48;
export const MASK_HEADER_BYTES = 8;
export const MAX_MASK_EDGE = 2048;
export const MAX_MASK_PAYLOAD = 48 * 1024;
export const MAX_CONTROLLERS = 16;
export const NO_CONTROLLER = 0xff;
export const HELD_NONE = 0xffffffff;
export const STICK_EXPONENTS = [1.0, 1.5, 2.0, 2.5, 3.0];
export const MAX_STICK_DEADZONE = 0.5;
export const MAX_GAIN = 100000.0;
export const MIN_FOCAL = 1.0;
export const MAX_FOCAL = 1000000.0;

const MASK_NONE = 0;
const MASK_RUNS = 1;

export const REBASE_IDLE_US = 600_000;
export const FADE_US = 150_000;
export const MAX_STICK_WINDOW_US = 400_000;
export const MAX_EXTRAPOLATION = 4;
export const TAG_SLOTS = 64;
export const STICK_HISTORY_US = MAX_STICK_WINDOW_US + 600_000;
export const STICK_SAMPLES = 4096;
export const MOUSE_SANITY = 200_000;
export const EDGE_RAMP = 0.08;
export const EDGE_DARKEN = 0.35;
export const FLAT = Object.freeze([0.0, 0.0, 1.0, 1.0]);
export const MIN_DEPTH = 0.25;
export const REPEAT_STEP_PX = 0.25;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function u32(v) {
  return v >>> 0;
}

function i32(v) {
  return v | 0;
}

/** `a` comes after `b` in wrapping u32 frame/seq order. */
export function afterU32(a, b) {
  const ua = u32(a);
  const ub = u32(b);
  return ua !== ub && u32(ua - ub) < 0x7fffffff;
}

/* -------------------------------------------------------------------------- */
/* Wire Codecs: 0x5543 Request                                                */
/* -------------------------------------------------------------------------- */

export function encodeFrameWarpRequest({ enabled, controller = null, maskMaxWidth = 1024, lens = true }) {
  const out = new Uint8Array(REQUEST_BYTES);
  const width = Math.min(Math.max(0, maskMaxWidth | 0), MAX_MASK_EDGE);
  const ctrl = controller !== null && controller !== undefined && controller >= 0 && controller < MAX_CONTROLLERS
    ? controller & 0xff
    : NO_CONTROLLER;
  out[0] = VERSION;
  out[1] = enabled ? 1 : 0;
  out[2] = ctrl;
  out[3] = lens ? 1 : 0;
  out[4] = width & 0xff;
  out[5] = (width >>> 8) & 0xff;
  out[6] = 0;
  out[7] = 0;
  return out;
}

export function decodeFrameWarpRequest(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < REQUEST_BYTES || bytes[0] === 0 || bytes[1] > 1) {
    return null;
  }
  let controller;
  if (bytes[2] === NO_CONTROLLER) {
    controller = null;
  } else if (bytes[2] < MAX_CONTROLLERS) {
    controller = bytes[2];
  } else {
    return null;
  }
  const maskMaxWidth = bytes[4] | (bytes[5] << 8);
  if (maskMaxWidth > MAX_MASK_EDGE) {
    return null;
  }
  return {
    enabled: bytes[1] === 1,
    controller,
    maskMaxWidth,
    lens: (bytes[3] & 1) !== 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Wire Codecs: 0x5544 Model                                                  */
/* -------------------------------------------------------------------------- */

export function isValidModel(m) {
  if (!m) return false;
  const validGain = (g) => Number.isFinite(g) && Math.abs(g) <= MAX_GAIN;
  return (
    m.pictureWidth > 0 &&
    m.pictureHeight > 0 &&
    validGain(m.mouseGain[0]) &&
    validGain(m.mouseGain[1]) &&
    validGain(m.stickGain[0]) &&
    validGain(m.stickGain[1]) &&
    Number.isFinite(m.stickDeadzone) &&
    m.stickDeadzone >= 0.0 &&
    m.stickDeadzone <= MAX_STICK_DEADZONE &&
    STICK_EXPONENTS.includes(m.stickExponent) &&
    Number.isFinite(m.maxOffset[0]) &&
    m.maxOffset[0] >= 0.0 &&
    m.maxOffset[0] <= 65535.0 &&
    Number.isFinite(m.maxOffset[1]) &&
    m.maxOffset[1] >= 0.0 &&
    m.maxOffset[1] <= 65535.0 &&
    Number.isFinite(m.confidence) &&
    m.confidence >= 0.0 &&
    m.confidence <= 1.0 &&
    Number.isFinite(m.focal) &&
    (m.focal === 0.0 || (m.focal >= MIN_FOCAL && m.focal <= MAX_FOCAL))
  );
}

export function encodeModel(m) {
  if (!isValidModel(m)) return null;
  const buf = new ArrayBuffer(MODEL_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, VERSION);
  view.setUint8(1, (m.mouseLocked ? 1 : 0) | (m.stickLocked ? 2 : 0));
  view.setUint16(2, m.generation & 0xffff, true);
  view.setUint16(4, m.pictureWidth & 0xffff, true);
  view.setUint16(6, m.pictureHeight & 0xffff, true);
  view.setFloat32(8, m.mouseGain[0], true);
  view.setFloat32(12, m.mouseGain[1], true);
  view.setFloat32(16, m.stickGain[0], true);
  view.setFloat32(20, m.stickGain[1], true);
  view.setFloat32(24, m.stickDeadzone, true);
  view.setFloat32(28, m.stickExponent, true);
  view.setFloat32(32, m.maxOffset[0], true);
  view.setFloat32(36, m.maxOffset[1], true);
  view.setUint32(40, u32(m.lagUs), true);
  view.setFloat32(44, m.confidence, true);
  view.setFloat32(48, m.focal ?? 0.0, true);
  return new Uint8Array(buf);
}

export function decodeModel(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < MODEL_FLAT_BYTES || bytes[0] === 0 || (bytes[1] & ~0b11) !== 0) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const model = {
    generation: view.getUint16(2, true),
    mouseLocked: (bytes[1] & 1) !== 0,
    stickLocked: (bytes[1] & 2) !== 0,
    pictureWidth: view.getUint16(4, true),
    pictureHeight: view.getUint16(6, true),
    mouseGain: [view.getFloat32(8, true), view.getFloat32(12, true)],
    stickGain: [view.getFloat32(16, true), view.getFloat32(20, true)],
    stickDeadzone: view.getFloat32(24, true),
    stickExponent: view.getFloat32(28, true),
    maxOffset: [view.getFloat32(32, true), view.getFloat32(36, true)],
    lagUs: view.getUint32(40, true),
    confidence: view.getFloat32(44, true),
    focal: bytes.length >= MODEL_BYTES ? view.getFloat32(48, true) : 0.0,
  };
  return isValidModel(model) ? model : null;
}

/* -------------------------------------------------------------------------- */
/* Wire Codecs: 0x5545 Tags                                                   */
/* -------------------------------------------------------------------------- */

export function encodeTags({ modelGeneration, tags }) {
  if (!tags || tags.length === 0 || tags.length > MAX_TAGS) return null;
  const buf = new ArrayBuffer(TAGS_HEADER_BYTES + tags.length * TAG_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, VERSION);
  view.setUint8(1, tags.length);
  view.setUint16(2, modelGeneration & 0xffff, true);
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const base = TAGS_HEADER_BYTES + i * TAG_BYTES;
    view.setUint32(base + 0, u32(t.frame), true);
    view.setInt32(base + 4, i32(t.mouseX), true);
    view.setInt32(base + 8, i32(t.mouseY), true);
    view.setUint32(base + 12, u32(t.controllerSeq), true);
    view.setUint32(base + 16, u32(t.controllerHeldUs), true);
  }
  return new Uint8Array(buf);
}

export function decodeTags(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < TAGS_HEADER_BYTES || bytes[0] === 0) return null;
  const count = bytes[1];
  if (count === 0 || count > MAX_TAGS || bytes.length < TAGS_HEADER_BYTES + count * TAG_BYTES) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const modelGeneration = view.getUint16(2, true);
  const tags = [];
  for (let i = 0; i < count; i++) {
    const base = TAGS_HEADER_BYTES + i * TAG_BYTES;
    tags.push({
      frame: view.getUint32(base + 0, true),
      mouseX: view.getInt32(base + 4, true),
      mouseY: view.getInt32(base + 8, true),
      controllerSeq: view.getUint32(base + 12, true),
      controllerHeldUs: view.getUint32(base + 16, true),
    });
  }
  return { modelGeneration, tags };
}

/* -------------------------------------------------------------------------- */
/* Wire Codecs: 0x5546 HUD Mask (LEB128 RLE)                                  */
/* -------------------------------------------------------------------------- */

function writeLeb128(out, value) {
  let v = value & 0xffff;
  while (true) {
    const byte = v & 0x7f;
    v >>>= 7;
    if (v === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

function readLeb128(data, state) {
  let value = 0;
  for (const shift of [0, 7, 14]) {
    if (state.at >= data.length) return null;
    const byte = data[state.at++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return value <= MAX_MASK_EDGE ? value : null;
    }
  }
  return null;
}

export class HudMask {
  constructor(generation = 0, width = 0, height = 0) {
    this.generation = generation & 0xffff;
    this.width = width & 0xffff;
    this.height = height & 0xffff;
    this.stride = HudMask.stride(this.width);
    this.words = new Uint32Array(this.stride * this.height);
  }

  static stride(width) {
    return (width + 31) >>> 5;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const at = y * this.stride + (x >>> 5);
    return ((this.words[at] >>> (x & 31)) & 1) !== 0;
  }

  set(x, y, on) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = y * this.stride + (x >>> 5);
    if (on) {
      this.words[at] |= 1 << (x & 31);
    } else {
      this.words[at] &= ~(1 << (x & 31));
    }
  }

  fillRect(x0, y0, w, h, on = true) {
    const xEnd = Math.min(this.width, x0 + w);
    const yEnd = Math.min(this.height, y0 + h);
    for (let y = Math.max(0, y0); y < yEnd; y++) {
      for (let x = Math.max(0, x0); x < xEnd; x++) {
        this.set(x, y, on);
      }
    }
  }

  isClear() {
    if (this.width === 0 || this.height === 0) return true;
    for (let i = 0; i < this.words.length; i++) {
      if (this.words[i] !== 0) return false;
    }
    return true;
  }

  count() {
    let total = 0;
    for (let i = 0; i < this.words.length; i++) {
      let w = this.words[i];
      w = w - ((w >>> 1) & 0x55555555);
      w = (w & 0x33333333) + ((w >>> 2) & 0x33333333);
      total += (((w + (w >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return total;
  }

  /** Pack to 1 byte per cell (0 or 255) for WebGL2 GL_R8 texture upload. */
  packR8() {
    const out = new Uint8Array(this.width * this.height);
    for (let y = 0; y < this.height; y++) {
      const rowOffset = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (this.get(x, y)) {
          out[rowOffset + x] = 255;
        }
      }
    }
    return out;
  }

  halved() {
    const w = (this.width + 1) >>> 1;
    const h = (this.height + 1) >>> 1;
    const out = new HudMask(this.generation, w, h);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.get(x, y)) {
          out.set(x >>> 1, y >>> 1, true);
        }
      }
    }
    return out;
  }

  encode() {
    const empty = this.width === 0 || this.height === 0;
    if (
      (this.width === 0) !== (this.height === 0) ||
      this.width > MAX_MASK_EDGE ||
      this.height > MAX_MASK_EDGE ||
      this.words.length !== HudMask.stride(this.width) * this.height
    ) {
      return null;
    }
    const out = [
      VERSION,
      empty ? MASK_NONE : MASK_RUNS,
      this.generation & 0xff,
      (this.generation >>> 8) & 0xff,
      this.width & 0xff,
      (this.width >>> 8) & 0xff,
      this.height & 0xff,
      (this.height >>> 8) & 0xff,
    ];
    for (let y = 0; y < this.height; y++) {
      let x = 0;
      let on = false;
      while (x < this.width) {
        let run = 0;
        while (x + run < this.width && this.get(x + run, y) === on) {
          run++;
        }
        writeLeb128(out, run);
        x += run;
        on = !on;
      }
      if (out.length > MAX_MASK_PAYLOAD) return null;
    }
    return new Uint8Array(out);
  }

  static decode(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < MASK_HEADER_BYTES || bytes.length > MAX_MASK_PAYLOAD || bytes[0] === 0) {
      return null;
    }
    const generation = bytes[2] | (bytes[3] << 8);
    const width = bytes[4] | (bytes[5] << 8);
    const height = bytes[6] | (bytes[7] << 8);
    if (width > MAX_MASK_EDGE || height > MAX_MASK_EDGE || (width === 0) !== (height === 0)) {
      return null;
    }
    const kind = bytes[1];
    if (kind === MASK_NONE && width === 0) {
      return new HudMask(generation, 0, 0);
    }
    if (kind !== MASK_RUNS || width === 0) {
      return null;
    }
    const mask = new HudMask(generation, width, height);
    const state = { at: MASK_HEADER_BYTES };
    for (let y = 0; y < height; y++) {
      let x = 0;
      let on = false;
      let first = true;
      while (x < width) {
        const run = readLeb128(bytes, state);
        if (run === null) return null;
        if (run === 0 && !first) return null;
        first = false;
        const end = x + run;
        if (end > width) return null;
        if (on) {
          for (let cell = x; cell < end; cell++) {
            mask.set(cell, y, true);
          }
        }
        x = end;
        on = !on;
      }
    }
    return mask;
  }
}

/* -------------------------------------------------------------------------- */
/* Math: Stick Curve, Edge Fill, Perspective Lens                             */
/* -------------------------------------------------------------------------- */

export function stickCurve(x, y, deadzone, exponent) {
  const vx = clamp(x / 32767.0, -1.0, 1.0);
  const vy = clamp(y / 32767.0, -1.0, 1.0);
  const r2 = vx * vx + vy * vy;
  if (r2 <= 0.0) return [0.0, 0.0];
  const r = Math.sqrt(r2);
  const dz = clamp(deadzone, 0.0, MAX_STICK_DEADZONE);
  if (r <= dz) return [0.0, 0.0];
  const s = Math.min((r - dz) / (1.0 - dz), 1.0);
  const halves = Math.floor(clamp(exponent, 1.0, 3.0) * 2.0);
  let scaled = 1.0;
  for (let i = 0; i < (halves >>> 1); i++) {
    scaled *= s;
  }
  if (halves & 1) {
    scaled *= Math.sqrt(s);
  }
  return [(vx / r) * scaled, (vy / r) * scaled];
}

export function edgeAxis(v) {
  const outside = Math.max(-v, v - 1.0);
  const fade = 1.0 - EDGE_DARKEN * clamp(outside / EDGE_RAMP, 0.0, 1.0);
  return [clamp(Math.min(Math.abs(v), 2.0 - v), 0.0, 1.0), fade];
}

export function edge(p) {
  const [x, fx] = edgeAxis(p[0]);
  const [y, fy] = edgeAxis(p[1]);
  return { point: [x, y], fade: Math.min(fx, fy) };
}

export function lensTerms(pixels, focal, width, height) {
  if (!(Number.isFinite(focal) && focal > 0.0)) {
    return { pixels: [pixels[0], pixels[1]], lens: [...FLAT] };
  }
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const tx = Math.tan(clamp(pixels[0] / focal, -1.4, 1.4));
  const ty = Math.tan(clamp(pixels[1] / focal, -1.4, 1.4));
  return {
    pixels: [tx * focal, ty * focal],
    lens: [
      (tx * w) / focal,
      (ty * h) / focal,
      Math.sqrt(1.0 + ty * ty),
      Math.sqrt(1.0 + tx * tx),
    ],
  };
}

export function fieldOfView(model) {
  if (!model || !(model.focal > 0.0)) return null;
  return (2.0 * Math.atan((model.pictureWidth * 0.5) / model.focal) * 180.0) / Math.PI;
}

export function sourcePoint(p, shift, lens) {
  const qx = p[0] - 0.5;
  const qy = p[1] - 0.5;
  const depth = Math.max(1.0 + qx * lens[0] + qy * lens[1], MIN_DEPTH);
  return [0.5 + (qx * lens[2] - shift[0]) / depth, 0.5 + (qy * lens[3] - shift[1]) / depth];
}

export function destinationPoint(at, shift, lens) {
  const sx = at[0] - 0.5;
  const sy = at[1] - 0.5;
  const a = lens[2] - sx * lens[0];
  const b = -sx * lens[1];
  const c = sx + shift[0];
  const d = -sy * lens[0];
  const e = lens[3] - sy * lens[1];
  const f = sy + shift[1];
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-9) return null;
  const qx = (c * e - b * f) / det;
  const qy = (a * f - c * d) / det;
  if (1.0 + qx * lens[0] + qy * lens[1] < MIN_DEPTH) return null;
  return [qx + 0.5, qy + 0.5];
}

/* -------------------------------------------------------------------------- */
/* FrameRing: maps decoder PTS (us) -> RTP video frame number                 */
/* -------------------------------------------------------------------------- */

export class FrameRing {
  constructor(capacity = 128) {
    this.capacity = capacity;
    this.entries = new Array(capacity).fill(null);
    this.next = 0;
  }

  note(ptsUs, frameNumber) {
    this.entries[this.next] = { ptsUs, frameNumber: u32(frameNumber) };
    this.next = (this.next + 1) % this.capacity;
  }

  lookup(ptsUs) {
    for (let i = 0; i < this.capacity; i++) {
      const idx = (this.next - 1 - i + this.capacity) % this.capacity;
      const entry = this.entries[idx];
      if (entry && entry.ptsUs === ptsUs) {
        return entry.frameNumber;
      }
    }
    return null;
  }

  clear() {
    this.entries.fill(null);
    this.next = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Predictor & FrameWarp                                                      */
/* -------------------------------------------------------------------------- */

export function identityWarp() {
  return {
    pixels: [0.0, 0.0],
    uv: [0.0, 0.0],
    lens: [...FLAT],
    active: false,
    maskGeneration: null,
  };
}

export class Predictor {
  constructor(controller = 0) {
    this.controller = controller;
    this.reset();
  }

  reset() {
    this.model = null;
    this.fading = null;
    this.weight = 0.0;
    this.weightAtUs = null;
    this.tags = new Array(TAG_SLOTS).fill(null);
    this.newest = null;
    this.mouseX = 0;
    this.mouseY = 0;
    this.mouseOffsetX = 0;
    this.mouseOffsetY = 0;
    this.lastMouseUs = null;
    this.controllerSeq = 0;
    this.seqOffset = 0;
    this.lastControllerUs = null;
    this.stick = [];
    this.maskGeneration = null;
    this.maskCells = 0;
    this.last = [0.0, 0.0];
    this.peaks = [];
    this.warped = 0;
    this.extrapolated = 0;
    this.untagged = 0;
  }

  noteMouse(dx, dy, nowUs) {
    const idx = i32(dx);
    const idy = i32(dy);
    if (idx === 0 && idy === 0) return;
    this.mouseX = i32(this.mouseX + idx);
    this.mouseY = i32(this.mouseY + idy);
    this.lastMouseUs = nowUs;
  }

  noteController(number, rightStickX, rightStickY, nowUs) {
    if (this.controller === null || this.controller !== number) return;
    this.controllerSeq = u32(this.controllerSeq + 1);
    this.lastControllerUs = nowUs;
    const prev = this.stick.length > 0 ? this.stick[this.stick.length - 1] : null;
    const atUs = prev ? Math.max(nowUs, prev.atUs) : nowUs;
    this.stick.push({
      atUs,
      seq: this.controllerSeq,
      stickX: rightStickX | 0,
      stickY: rightStickY | 0,
    });
    while (
      this.stick.length > STICK_SAMPLES ||
      (this.stick.length > 1 && atUs - this.stick[1].atUs > STICK_HISTORY_US)
    ) {
      this.stick.shift();
    }
  }

  onModel(model) {
    if (model.mouseLocked || model.stickLocked) {
      this.fading = model;
    }
    this.model = model;
  }

  onMask(generation, cells) {
    this.maskGeneration = generation;
    this.maskCells = cells;
  }

  onTags(tagsMsg, nowUs) {
    let newest = null;
    for (const tag of tagsMsg.tags) {
      this.tags[u32(tag.frame) % TAG_SLOTS] = tag;
      if (newest === null || afterU32(tag.frame, newest.frame)) {
        newest = tag;
      }
    }
    if (newest === null) return;
    if (this.newest !== null && !afterU32(newest.frame, this.newest)) {
      return;
    }
    this.newest = newest.frame;
    const isIdle = (last) => last === null || nowUs - last >= REBASE_IDLE_US;
    if (isIdle(this.lastMouseUs)) {
      this.mouseOffsetX = i32(this.mouseX - newest.mouseX);
      this.mouseOffsetY = i32(this.mouseY - newest.mouseY);
    }
    if (isIdle(this.lastControllerUs)) {
      this.seqOffset = u32(this.controllerSeq - newest.controllerSeq);
    }
  }

  _slot(f) {
    const uf = u32(f);
    const t = this.tags[uf % TAG_SLOTS];
    return t && t.frame === uf ? t : null;
  }

  _previous(before, within) {
    for (let back = 1; back <= within; back++) {
      const t = this._slot(u32(before - back));
      if (t) return t;
    }
    return null;
  }

  _lookupTag(frame) {
    const uf = u32(frame);
    const exact = this._slot(uf);
    if (exact) return { tag: exact, extrapolated: false };

    const a = this._previous(uf, MAX_EXTRAPOLATION);
    if (!a) return null;
    const b = this._previous(a.frame, MAX_EXTRAPOLATION);
    if (!b) {
      return { tag: { ...a, frame: uf }, extrapolated: true };
    }
    const ahead = u32(uf - a.frame);
    const span = u32(a.frame - b.frame);
    const step = (av, bv) => {
      const rate = i32(av - bv);
      return i32(av + Math.trunc((rate * ahead) / span));
    };
    return {
      tag: {
        ...a,
        frame: uf,
        mouseX: step(a.mouseX, b.mouseX),
        mouseY: step(a.mouseY, b.mouseY),
      },
      extrapolated: true,
    };
  }

  _stickSample(seq) {
    if (this.stick.length === 0) return null;
    const newest = this.stick[this.stick.length - 1];
    const back = u32(newest.seq - seq);
    if (back >= this.stick.length) return null;
    const sample = this.stick[this.stick.length - 1 - back];
    return sample && sample.seq === u32(seq) ? sample : null;
  }

  _stickUnreflected(tag, model, nowUs) {
    const earliest = Math.max(0, nowUs - MAX_STICK_WINDOW_US);
    const hostSeq = u32(tag.controllerSeq + this.seqOffset);
    if (this.stick.length === 0) return [0.0, 0.0];
    const newest = this.stick[this.stick.length - 1];
    if (hostSeq !== newest.seq && afterU32(hostSeq, newest.seq)) {
      return [0.0, 0.0];
    }
    let start;
    if (tag.controllerHeldUs === HELD_NONE || tag.controllerSeq === 0) {
      start = earliest;
    } else {
      const sample = this._stickSample(hostSeq);
      start = sample ? sample.atUs + tag.controllerHeldUs : earliest;
    }
    start = clamp(start, earliest, nowUs);

    let first = 0;
    for (let i = this.stick.length - 1; i >= 0; i--) {
      if (this.stick[i].atUs <= start) {
        first = i;
        break;
      }
    }
    let sumX = 0.0;
    let sumY = 0.0;
    for (let i = first; i < this.stick.length; i++) {
      const sample = this.stick[i];
      const nextAt = i + 1 < this.stick.length ? this.stick[i + 1].atUs : nowUs;
      const end = Math.min(nextAt, nowUs);
      const from = Math.max(sample.atUs, start);
      if (end <= from) continue;
      const held = (end - from) / 1_000_000.0;
      const [cx, cy] = stickCurve(
        sample.stickX,
        sample.stickY,
        model.stickDeadzone,
        model.stickExponent
      );
      sumX += cx * held;
      sumY += cy * held;
    }
    return [sumX, sumY];
  }

  _updateWeight(locked, nowUs) {
    const target = locked ? 1.0 : 0.0;
    const elapsed = this.weightAtUs === null ? 0 : Math.max(0, nowUs - this.weightAtUs);
    this.weightAtUs = nowUs;
    const step = elapsed / FADE_US;
    if (this.weight < target) {
      this.weight = Math.min(this.weight + step, target);
    } else {
      this.weight = Math.max(this.weight - step, target);
    }
  }

  warp(frame, nowUs) {
    return this._shift(frame, nowUs, true);
  }

  peek(frame, nowUs) {
    return this._shift(frame, nowUs, false);
  }

  _shift(frame, nowUs, drawn) {
    const locked = Boolean(this.model && (this.model.mouseLocked || this.model.stickLocked));
    this._updateWeight(locked, nowUs);
    const model = locked ? this.model : this.fading;
    if (!model || this.weight <= 0.0) {
      if (drawn) this._record([0.0, 0.0], nowUs);
      return identityWarp();
    }
    const found = this._lookupTag(frame);
    if (!found) {
      if (drawn) {
        this.untagged++;
        this._record([0.0, 0.0], nowUs);
      }
      return identityWarp();
    }
    if (found.extrapolated && drawn) {
      this.extrapolated++;
    }
    const { tag } = found;
    let sx = 0.0;
    let sy = 0.0;
    if (model.mouseLocked) {
      const dx = i32(i32(this.mouseX - tag.mouseX) - this.mouseOffsetX);
      const dy = i32(i32(this.mouseY - tag.mouseY) - this.mouseOffsetY);
      if (Math.abs(dx) < MOUSE_SANITY && Math.abs(dy) < MOUSE_SANITY) {
        sx += model.mouseGain[0] * dx;
        sy += model.mouseGain[1] * dy;
      }
    }
    if (model.stickLocked && this.controller !== null) {
      const [secX, secY] = this._stickUnreflected(tag, model, nowUs);
      sx += model.stickGain[0] * secX;
      sy += model.stickGain[1] * secY;
    }
    sx = clamp(sx, -model.maxOffset[0], model.maxOffset[0]) * this.weight;
    sy = clamp(sy, -model.maxOffset[1], model.maxOffset[1]) * this.weight;

    const { pixels, lens } = model.focal > 0.0
      ? lensTerms([sx, sy], model.focal, model.pictureWidth, model.pictureHeight)
      : { pixels: [sx, sy], lens: [...FLAT] };

    if (drawn) {
      this.warped++;
      this._record(pixels, nowUs);
    }
    const active = Math.abs(pixels[0]) >= 0.01 || Math.abs(pixels[1]) >= 0.01;
    return {
      pixels,
      uv: [pixels[0] / model.pictureWidth, pixels[1] / model.pictureHeight],
      lens: active ? lens : [...FLAT],
      active,
      maskGeneration: active ? this.maskGeneration : null,
    };
  }

  _record(shift, nowUs) {
    this.last = [shift[0], shift[1]];
    const length = Math.hypot(shift[0], shift[1]);
    while (this.peaks.length > 0 && nowUs - this.peaks[0][0] > 1_000_000) {
      this.peaks.shift();
    }
    if (length > 0.0) {
      this.peaks.push([nowUs, length]);
      if (this.peaks.length > 2048) {
        this.peaks.shift();
      }
    }
  }

  status(nowUs) {
    let peak = 0.0;
    for (const [at, len] of this.peaks) {
      if (nowUs - at <= 1_000_000 && len > peak) {
        peak = len;
      }
    }
    return {
      model: this.model,
      pixels: [this.last[0], this.last[1]],
      peak,
      warped: this.warped,
      extrapolated: this.extrapolated,
      untagged: this.untagged,
      maskCells: this.maskCells,
    };
  }
}

export class FrameWarp {
  constructor(controller = 0, maskMaxWidth = 1024, clockUs = () => Math.round(performance.now() * 1000)) {
    this.controller = controller;
    this.maskMaxWidth = maskMaxWidth;
    this.clockUs = clockUs;
    this.epochUs = clockUs();
    this.predictor = new Predictor(controller);
    this.mask = null;
    this.started = false;
    this.inputSeq = 0;
    this.lastStick = [0, 0];
    this.stickDeadzone = 0.0;
    this.frameRing = new FrameRing(128);
  }

  nowUs() {
    return Math.max(0, this.clockUs() - this.epochUs);
  }

  request(enabled, lens = true) {
    if (this.started !== enabled) {
      this.started = enabled;
      if (enabled) {
        this.predictor.reset();
        this.mask = null;
        this.stickDeadzone = 0.0;
      }
    }
    return encodeFrameWarpRequest({
      enabled,
      controller: this.controller,
      maskMaxWidth: this.maskMaxWidth,
      lens,
    });
  }

  noteMouse(dx, dy) {
    this.predictor.noteMouse(dx, dy, this.nowUs());
    if (dx !== 0 || dy !== 0) {
      this.inputSeq = u32(this.inputSeq + 1);
    }
  }

  noteController(number, rightStickX, rightStickY) {
    this.predictor.noteController(number, rightStickX, rightStickY, this.nowUs());
    if (this.controller !== null && this.controller === number) {
      this.lastStick = [rightStickX | 0, rightStickY | 0];
      this.inputSeq = u32(this.inputSeq + 1);
    }
  }

  stickDeflected() {
    if (this.controller === null) return false;
    const [cx, cy] = stickCurve(this.lastStick[0], this.lastStick[1], this.stickDeadzone, 1.0);
    return cx !== 0.0 || cy !== 0.0;
  }

  onModelBytes(bytes) {
    const model = decodeModel(bytes);
    if (!model) return false;
    this.onModel(model);
    return true;
  }

  onModel(model) {
    this.predictor.onModel(model);
    this.stickDeadzone = model.stickDeadzone;
  }

  onTagsBytes(bytes) {
    const tags = decodeTags(bytes);
    if (!tags) return false;
    this.onTags(tags);
    return true;
  }

  onTags(tags) {
    this.predictor.onTags(tags, this.nowUs());
  }

  onMaskBytes(bytes) {
    const mask = HudMask.decode(bytes);
    if (!mask) return false;
    this.onMask(mask);
    return true;
  }

  onMask(mask) {
    const cells = mask.count();
    if (mask.isClear()) {
      this.mask = null;
      this.predictor.onMask(null, 0);
    } else {
      this.mask = mask;
      this.predictor.onMask(mask.generation, cells);
    }
  }

  maskSince(knownGeneration) {
    const currentGen = this.mask ? this.mask.generation : null;
    if (currentGen === knownGeneration) return undefined;
    return this.mask;
  }

  warp(frame) {
    return this.predictor.warp(frame, this.nowUs());
  }

  peek(frame) {
    return this.predictor.peek(frame, this.nowUs());
  }

  status() {
    return this.predictor.status(this.nowUs());
  }
}
