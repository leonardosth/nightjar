import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrameWarpRequest,
  decodeFrameWarpRequest,
  encodeModel,
  decodeModel,
  encodeTags,
  decodeTags,
  HudMask,
  stickCurve,
  edge,
  lensTerms,
  sourcePoint,
  destinationPoint,
  fieldOfView,
  FrameRing,
  Predictor,
  FrameWarp,
  HELD_NONE,
  MODEL_FLAT_BYTES,
  REBASE_IDLE_US,
  FADE_US,
} from '../app/js/frame-warp.js';

test('0x5543 FrameWarpRequest round-trips and validates bounds', () => {
  const bytes = encodeFrameWarpRequest({ enabled: true, controller: 3, maskMaxWidth: 960, lens: true });
  assert.deepEqual(Array.from(bytes), [1, 1, 3, 1, 0xc0, 0x03, 0, 0]);
  assert.deepEqual(decodeFrameWarpRequest(bytes), {
    enabled: true,
    controller: 3,
    maskMaxWidth: 960,
    lens: true,
  });

  // Unknown flag bits are ignored per spec
  assert.deepEqual(decodeFrameWarpRequest(new Uint8Array([1, 1, 3, 0xfe, 0xc0, 0x03, 0, 0])), {
    enabled: true,
    controller: 3,
    maskMaxWidth: 960,
    lens: false,
  });

  // Rejects version 0, enabled > 1, controller 16..254, maskMaxWidth > 2048, short payload
  assert.equal(decodeFrameWarpRequest(new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(decodeFrameWarpRequest(new Uint8Array([1, 2, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(decodeFrameWarpRequest(new Uint8Array([1, 1, 16, 0, 0, 0, 0, 0])), null);
  assert.equal(decodeFrameWarpRequest(new Uint8Array([1, 1, 0, 0, 0x01, 0x08, 0, 0])), null);
  assert.equal(decodeFrameWarpRequest(new Uint8Array([1, 1, 0, 0, 0, 0, 0])), null);

  // Forward-compatible with trailing bytes
  assert.ok(decodeFrameWarpRequest(new Uint8Array([2, 1, 0xff, 1, 0, 0, 0, 0, 99])));
});

test('0x5544 Model round-trips 52B (with focal) and 48B (legacy flat)', () => {
  const model = {
    generation: 42,
    mouseLocked: true,
    stickLocked: true,
    pictureWidth: 3840,
    pictureHeight: 2160,
    mouseGain: [-2.5, -2.5],
    stickGain: [-1200.0, 900.0],
    stickDeadzone: 0.1,
    stickExponent: 2.0,
    maxOffset: [400.0, 240.0],
    lagUs: 28000,
    confidence: 0.96,
    focal: 1920.0,
  };
  const encoded = encodeModel(model);
  assert.equal(encoded.length, 52);

  const decoded = decodeModel(encoded);
  assert.equal(decoded.generation, 42);
  assert.equal(decoded.mouseLocked, true);
  assert.equal(decoded.stickLocked, true);
  assert.equal(decoded.pictureWidth, 3840);
  assert.equal(decoded.pictureHeight, 2160);
  assert.ok(Math.abs(decoded.focal - 1920.0) < 1e-4);
  assert.ok(Math.abs(fieldOfView(decoded) - 90.0) < 1e-3);

  // Legacy 48-byte model decodes with focal = 0
  const flat = decodeModel(encoded.subarray(0, MODEL_FLAT_BYTES));
  assert.ok(flat);
  assert.equal(flat.focal, 0.0);

  // Invalid exponent rejected
  assert.equal(encodeModel({ ...model, stickExponent: 1.75 }), null);
});

test('0x5545 Tags round-trips oldest-first and rejects invalid counts', () => {
  const msg = {
    modelGeneration: 5,
    tags: [
      { frame: 100, mouseX: -12, mouseY: 7, controllerSeq: 10, controllerHeldUs: 3200 },
      { frame: 101, mouseX: -4, mouseY: 9, controllerSeq: 11, controllerHeldUs: HELD_NONE },
    ],
  };
  const bytes = encodeTags(msg);
  assert.equal(bytes.length, 4 + 2 * 20);
  assert.deepEqual(decodeTags(bytes), msg);
  assert.equal(encodeTags({ modelGeneration: 1, tags: [] }), null);
});

test('0x5546 HUD Mask LEB128 RLE round-trip, packR8, and halved()', () => {
  const mask = new HudMask(3, 128, 64);
  mask.set(0, 0, true); // Row starting with set cell -> emits leading 0 run
  mask.set(127, 63, true);
  mask.fillRect(60, 28, 8, 8, true);

  const encoded = mask.encode();
  assert.ok(encoded && encoded.length > 8);
  const decoded = HudMask.decode(encoded);
  assert.ok(decoded);
  assert.equal(decoded.generation, 3);
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 64);
  assert.equal(decoded.count(), mask.count());
  assert.equal(decoded.get(0, 0), true);
  assert.equal(decoded.get(127, 63), true);
  assert.equal(decoded.get(64, 30), true);
  assert.equal(decoded.get(1, 0), false);

  const r8 = decoded.packR8();
  assert.equal(r8.length, 128 * 64);
  assert.equal(r8[0], 255);
  assert.equal(r8[1], 0);
  assert.equal(r8[63 * 128 + 127], 255);

  const half = decoded.halved();
  assert.equal(half.width, 64);
  assert.equal(half.height, 32);
  assert.equal(half.get(0, 0), true);
  assert.equal(half.get(63, 31), true);

  // Empty clear mask round-trip
  const empty = new HudMask(9, 0, 0);
  const emptyDec = HudMask.decode(empty.encode());
  assert.ok(emptyDec && emptyDec.isClear() && emptyDec.generation === 9);
});

test('stickCurve deadzone and exponent response', () => {
  assert.deepEqual(stickCurve(0, 0, 0.1, 2.0), [0, 0]);
  assert.deepEqual(stickCurve(3000, 0, 0.1, 2.0), [0, 0]); // r ~ 0.0915 <= 0.1
  const full = stickCurve(32767, 0, 0.1, 2.0);
  assert.ok(Math.abs(full[0] - 1.0) < 1e-4 && Math.abs(full[1]) < 1e-4);
  const mid = stickCurve(Math.round(32767 * 0.55), 0, 0.1, 2.0);
  // s = (0.55 - 0.1) / 0.9 = 0.5 -> s^2 = 0.25
  assert.ok(Math.abs(mid[0] - 0.25) < 1e-3);
});

test('lensTerms, sourcePoint/destinationPoint inverse, and edge darkening', () => {
  const { pixels, lens } = lensTerms([60, -20], 960, 1920, 1080);
  const shiftUv = [pixels[0] / 1920, pixels[1] / 1080];
  const p = [0.72, 0.31];
  const src = sourcePoint(p, shiftUv, lens);
  const dst = destinationPoint(src, shiftUv, lens);
  assert.ok(dst);
  assert.ok(Math.abs(dst[0] - p[0]) < 1e-5);
  assert.ok(Math.abs(dst[1] - p[1]) < 1e-5);

  // Edge mirror & darkening past left edge
  const e = edge([-0.04, 0.5]);
  assert.ok(Math.abs(e.point[0] - 0.04) < 1e-5);
  assert.ok(Math.abs(e.fade - (1.0 - 0.35 * 0.5)) < 1e-5);
});

test('Predictor: fade, mouse shift, stick integration, extrapolation, and idle rebasing', () => {
  const pred = new Predictor(0);
  const model = {
    generation: 1,
    mouseLocked: true,
    stickLocked: true,
    pictureWidth: 1920,
    pictureHeight: 1080,
    mouseGain: [-2.0, -2.0],
    stickGain: [-1000.0, 0.0],
    stickDeadzone: 0.0,
    stickExponent: 1.0,
    maxOffset: [400.0, 400.0],
    lagUs: 20000,
    confidence: 1.0,
    focal: 0.0,
  };
  pred.onModel(model);

  // Mouse delta = 40 -> shift = -80 px once fully faded in (150ms)
  pred.noteMouse(40, 0, 10_000);
  pred.onTags({ modelGeneration: 1, tags: [{ frame: 10, mouseX: 0, mouseY: 0, controllerSeq: 0, controllerHeldUs: HELD_NONE }] }, 10_000);
  pred.warp(10, 10_000); // starts fade at weight=0
  const w = pred.warp(10, 10_000 + FADE_US);
  assert.equal(w.active, true);
  assert.ok(Math.abs(w.pixels[0] - (-80.0)) < 1e-3);

  // Extrapolation for missing frame 12 from tags 10 (mouseX=0) and 11 (mouseX=10) -> predicts mouseX=20 -> delta=20 -> -40 px
  pred.onTags({ modelGeneration: 1, tags: [{ frame: 11, mouseX: 10, mouseY: 0, controllerSeq: 0, controllerHeldUs: HELD_NONE }] }, 16_000);
  const wExtrap = pred.warp(12, 10_000 + FADE_US + 16_000);
  assert.ok(Math.abs(wExtrap.pixels[0] - (-40.0)) < 1e-3);
  assert.equal(pred.status(10_000 + FADE_US + 16_000).extrapolated, 1);

  // Idle rebase after 600ms without input resets unreflected mouse diff to 0
  const idleNow = 10_000 + REBASE_IDLE_US + 50_000;
  pred.onTags({ modelGeneration: 1, tags: [{ frame: 50, mouseX: 15, mouseY: 0, controllerSeq: 0, controllerHeldUs: HELD_NONE }] }, idleNow);
  const wRebased = pred.warp(50, idleNow);
  assert.equal(wRebased.active, false);
});

test('FrameRing maps decoder PTS to RTP frame number', () => {
  const ring = new FrameRing(128);
  ring.note(16667, 42);
  ring.note(33333, 43);
  assert.equal(ring.lookup(16667), 42);
  assert.equal(ring.lookup(33333), 43);
  assert.equal(ring.lookup(99999), null);
});

test('FrameWarp high-level wrapper tracks mask generations and input_seq', () => {
  let fakeClock = 0;
  const fw = new FrameWarp(0, 1024, () => fakeClock);
  fw.request(true, true);
  assert.equal(fw.maskSince(null), undefined);

  const mask = new HudMask(4, 32, 16);
  mask.set(5, 5, true);
  assert.equal(fw.onMaskBytes(mask.encode()), true);
  const got = fw.maskSince(null);
  assert.ok(got && got.generation === 4);
  assert.equal(fw.maskSince(4), undefined);

  fw.noteMouse(10, -5);
  assert.equal(fw.inputSeq, 1);
});

test('HudMask.decode safely rejects malformed 0x5546 RLE payloads', () => {
  assert.equal(HudMask.decode(new Uint8Array([1, 1, 1, 0, 8, 0, 1, 0, 0x80])), null);
  assert.equal(HudMask.decode(new Uint8Array([1, 1, 1, 0, 8, 0, 1, 0, 4, 0, 4])), null);
  assert.equal(HudMask.decode(new Uint8Array([1, 1, 1, 0, 8, 0, 1, 0, 9])), null);
  assert.equal(HudMask.decode(new Uint8Array([1, 1, 1, 0, 0x01, 0x08, 1, 0, 1])), null);
  const huge = new Uint8Array(49153);
  huge[0] = 1; huge[1] = 1; huge[4] = 8; huge[6] = 1;
  assert.equal(HudMask.decode(huge), null);
});
