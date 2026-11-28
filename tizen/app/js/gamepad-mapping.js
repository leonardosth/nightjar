/**
 * W3C Standard Gamepad -> Moonlight wire protocol mapping & 2D spatial focus helper.
 * Wire constants match protocol/policy/src/gamepad_constants.rs.
 */

export const MOONLIGHT_BUTTONS = Object.freeze({
  UP: 0x0001,
  DOWN: 0x0002,
  LEFT: 0x0004,
  RIGHT: 0x0008,
  PLAY: 0x0010,
  BACK: 0x0020,
  LS_CLK: 0x0040,
  RS_CLK: 0x0080,
  LB: 0x0100,
  RB: 0x0200,
  SPECIAL: 0x0400,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
  TOUCHPAD: 0x100000,
});

// W3C Standard Gamepad button index -> Moonlight button flag (null = analog trigger, not a button bit)
const W3C_TO_MOONLIGHT = [
  MOONLIGHT_BUTTONS.A,        // 0: Bottom face (A / Cross)
  MOONLIGHT_BUTTONS.B,        // 1: Right face (B / Circle)
  MOONLIGHT_BUTTONS.X,        // 2: Left face (X / Square)
  MOONLIGHT_BUTTONS.Y,        // 3: Top face (Y / Triangle)
  MOONLIGHT_BUTTONS.LB,       // 4: Left shoulder
  MOONLIGHT_BUTTONS.RB,       // 5: Right shoulder
  null,                       // 6: Left trigger (analog field only)
  null,                       // 7: Right trigger (analog field only)
  MOONLIGHT_BUTTONS.BACK,     // 8: Back / View / Select
  MOONLIGHT_BUTTONS.PLAY,     // 9: Start / Menu
  MOONLIGHT_BUTTONS.LS_CLK,   // 10: Left stick press
  MOONLIGHT_BUTTONS.RS_CLK,   // 11: Right stick press
  MOONLIGHT_BUTTONS.UP,       // 12: D-pad up
  MOONLIGHT_BUTTONS.DOWN,     // 13: D-pad down
  MOONLIGHT_BUTTONS.LEFT,     // 14: D-pad left
  MOONLIGHT_BUTTONS.RIGHT,    // 15: D-pad right
  MOONLIGHT_BUTTONS.SPECIAL,  // 16: Home / Guide / Xbox / PS
  MOONLIGHT_BUTTONS.TOUCHPAD, // 17: Touchpad click
];

function floatToI16(v) {
  const clamped = Math.max(-1.0, Math.min(1.0, Number.isFinite(v) ? v : 0));
  return Math.sign(clamped) * Math.round(Math.abs(clamped) * 32767) | 0;
}

function triggerToU8(btn) {
  if (!btn) return 0;
  const val = typeof btn.value === 'number' ? btn.value : btn.pressed ? 1 : 0;
  return Math.max(0, Math.min(255, Math.round(val * 255))) & 0xff;
}

export function mapStandardGamepad(pad) {
  const btns = pad && pad.buttons ? pad.buttons : [];
  const axes = pad && pad.axes ? pad.axes : [];

  let buttons = 0;
  const count = Math.min(btns.length, W3C_TO_MOONLIGHT.length);
  for (let i = 0; i < count; i++) {
    const flag = W3C_TO_MOONLIGHT[i];
    if (flag !== null && btns[i]?.pressed) {
      buttons |= flag;
    }
  }

  // Non-standard Linux hid-microsoft / xpad fallback where D-Pad maps to axes[6]/axes[7]
  if (pad && pad.mapping !== 'standard' && axes.length >= 8) {
    if ((axes[6] || 0) < -0.5) buttons |= MOONLIGHT_BUTTONS.LEFT;
    else if ((axes[6] || 0) > 0.5) buttons |= MOONLIGHT_BUTTONS.RIGHT;
    if ((axes[7] || 0) < -0.5) buttons |= MOONLIGHT_BUTTONS.UP;
    else if ((axes[7] || 0) > 0.5) buttons |= MOONLIGHT_BUTTONS.DOWN;
  }

  return {
    buttons,
    leftTrigger: triggerToU8(btns[6]),
    rightTrigger: triggerToU8(btns[7]),
    leftStickX: floatToI16(axes[0] || 0),
    leftStickY: floatToI16(-(axes[1] || 0)),
    rightStickX: floatToI16(axes[2] || 0),
    rightStickY: floatToI16(-(axes[3] || 0)),
  };
}

export function computeActiveGamepadMask(rawPads) {
  if (!rawPads) return 0;
  let mask = 0;
  const limit = Math.min(rawPads.length, 16);
  for (let i = 0; i < limit; i++) {
    if (rawPads[i] && rawPads[i].connected !== false) {
      mask |= 1 << i;
    }
  }
  return mask;
}

export function assignControllerSlots(slotByPad, rawPads) {
  const slots = new Map();
  const used = new Set();
  const arrived = [];
  const removed = [];
  const limit = rawPads ? Math.min(rawPads.length, 16) : 0;

  if (slotByPad) {
    for (const [padIdx, slot] of slotByPad.entries()) {
      const pad = padIdx >= 0 && padIdx < limit ? rawPads[padIdx] : null;
      if (pad && pad.connected !== false && slot >= 0 && slot < 16 && !used.has(slot)) {
        slots.set(padIdx, slot);
        used.add(slot);
      } else {
        removed.push({ pad: padIdx, slot });
      }
    }
  }

  for (let i = 0; i < limit; i++) {
    const pad = rawPads[i];
    if (!pad || pad.connected === false || slots.has(i)) continue;
    for (let slot = 0; slot < 16; slot++) {
      if (!used.has(slot)) {
        slots.set(i, slot);
        used.add(slot);
        arrived.push({ pad: i, slot });
        break;
      }
    }
  }

  let mask = 0;
  for (const s of used) {
    mask |= 1 << s;
  }
  return { slots, mask, arrived, removed };
}

export class NavRepeat {
  constructor({ initialDelayMs = 400, repeatMs = 140 } = {}) {
    this.initialDelayMs = initialDelayMs;
    this.repeatMs = repeatMs;
    this._dir = null;
    this._pressedAt = 0;
    this._lastFiredAt = 0;
    this._repeated = false;
  }

  update(dir, nowMs) {
    if (!dir) {
      this._dir = null;
      this._pressedAt = 0;
      this._lastFiredAt = 0;
      this._repeated = false;
      return null;
    }
    if (dir !== this._dir) {
      this._dir = dir;
      this._pressedAt = nowMs;
      this._lastFiredAt = nowMs;
      this._repeated = false;
      return dir;
    }
    if (!this._repeated) {
      if ((nowMs - this._pressedAt) >= this.initialDelayMs) {
        this._repeated = true;
        this._lastFiredAt = nowMs;
        return dir;
      }
      return null;
    }
    if ((nowMs - this._lastFiredAt) >= this.repeatMs) {
      this._lastFiredAt = nowMs;
      return dir;
    }
    return null;
  }
}

export function shouldSendGamepadState(prev, next, nowMs, heartbeatMs = 250) {
  if (!prev) return true;
  if (
    prev.buttons !== next.buttons ||
    prev.leftTrigger !== next.leftTrigger ||
    prev.rightTrigger !== next.rightTrigger ||
    prev.leftStickX !== next.leftStickX ||
    prev.leftStickY !== next.leftStickY ||
    prev.rightStickX !== next.rightStickX ||
    prev.rightStickY !== next.rightStickY
  ) {
    return true;
  }
  return (nowMs - (prev.sentAt || 0)) >= heartbeatMs;
}

export function pickSpatialFocus(rects, currentIndex, dir) {
  if (!rects || rects.length === 0) return -1;
  if (currentIndex < 0 || currentIndex >= rects.length) return 0;

  const cur = rects[currentIndex];
  const cx = cur.left + cur.width * 0.5;
  const cy = cur.top + cur.height * 0.5;

  let bestIdx = -1;
  let bestScore = Infinity;

  for (let i = 0; i < rects.length; i++) {
    if (i === currentIndex) continue;
    const r = rects[i];
    const rx = r.left + r.width * 0.5;
    const ry = r.top + r.height * 0.5;
    const dx = rx - cx;
    const dy = ry - cy;

    let primary = 0;
    let ortho = 0;
    if (dir === 'right') {
      if (dx <= 1) continue;
      primary = dx;
      ortho = Math.abs(dy);
    } else if (dir === 'left') {
      if (dx >= -1) continue;
      primary = -dx;
      ortho = Math.abs(dy);
    } else if (dir === 'down') {
      if (dy <= 1) continue;
      primary = dy;
      ortho = Math.abs(dx);
    } else if (dir === 'up') {
      if (dy >= -1) continue;
      primary = -dy;
      ortho = Math.abs(dx);
    } else {
      continue;
    }

    const score = primary + 2.5 * ortho;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx >= 0 ? bestIdx : currentIndex;
}

const MOUSE_BTN_LEFT = 1;
const MOUSE_BTN_MIDDLE = 2;
const MOUSE_BTN_RIGHT = 3;
const MOUSE_PRESS = 0x07;
const MOUSE_RELEASE = 0x08;

export class ControllerMouseEmulation {
  constructor({
    holdStartMs = 650,
    stickDeadzone = 0.12,
    baseSpeedPxPerSec = 140,
    maxSpeedPxPerSec = 1150,
    triggerPress = 90,
    triggerRelease = 65,
    scrollRepeatMs = 120,
  } = {}) {
    this.holdStartMs = holdStartMs;
    this.stickDeadzone = stickDeadzone;
    this.baseSpeedPxPerSec = baseSpeedPxPerSec;
    this.maxSpeedPxPerSec = maxSpeedPxPerSec;
    this.triggerPress = triggerPress;
    this.triggerRelease = triggerRelease;
    this.scrollRepeatMs = scrollRepeatMs;
    this._slots = new Map();
  }

  _slotState(slot) {
    let s = this._slots.get(slot);
    if (!s) {
      s = {
        active: false,
        prevStart: false,
        startDownAt: null,
        startConsumed: false,
        remX: 0,
        remY: 0,
        lastTickMs: 0,
        heldMouseMask: 0,
        suppressedButtons: 0,
        suppressLt: false,
        suppressRt: false,
        ltActive: false,
        rtActive: false,
        lastScrollDir: 0,
        lastScrollAt: 0,
      };
      this._slots.set(slot, s);
    }
    return s;
  }

  isActive(slot) {
    return Boolean(this._slots.get(slot)?.active);
  }

  anyActive() {
    for (const s of this._slots.values()) {
      if (s.active) return true;
    }
    return false;
  }

  setActive(slot, active) {
    const s = this._slotState(slot);
    const next = Boolean(active);
    if (s.active === next) {
      return { toggled: false, active: s.active, sendNeutralController: false, mouseButtons: [] };
    }
    const mouseButtons = [];
    if (!next) {
      for (const btn of [MOUSE_BTN_LEFT, MOUSE_BTN_MIDDLE, MOUSE_BTN_RIGHT]) {
        if ((s.heldMouseMask & (1 << btn)) !== 0) {
          mouseButtons.push({ action: MOUSE_RELEASE, button: btn });
        }
      }
      s.heldMouseMask = 0;
      s.ltActive = false;
      s.rtActive = false;
    }
    s.active = next;
    s.startDownAt = null;
    s.startConsumed = false;
    s.remX = 0;
    s.remY = 0;
    s.lastTickMs = 0;
    s.lastScrollDir = 0;
    return {
      toggled: true,
      active: s.active,
      sendNeutralController: s.active,
      mouseButtons,
    };
  }

  resetSlot(slot) {
    const s = this._slots.get(slot);
    const mouseButtons = [];
    if (s) {
      for (const btn of [MOUSE_BTN_LEFT, MOUSE_BTN_MIDDLE, MOUSE_BTN_RIGHT]) {
        if ((s.heldMouseMask & (1 << btn)) !== 0) {
          mouseButtons.push({ action: MOUSE_RELEASE, button: btn });
        }
      }
      this._slots.delete(slot);
    }
    return { mouseButtons };
  }

  resetAll() {
    const mouseButtons = [];
    for (const slot of Array.from(this._slots.keys())) {
      const res = this.resetSlot(slot);
      mouseButtons.push(...res.mouseButtons);
    }
    return { mouseButtons };
  }

  releaseHeldButtons() {
    const mouseButtons = [];
    for (const s of this._slots.values()) {
      for (const btn of [MOUSE_BTN_LEFT, MOUSE_BTN_MIDDLE, MOUSE_BTN_RIGHT]) {
        if ((s.heldMouseMask & (1 << btn)) !== 0) {
          mouseButtons.push({ action: MOUSE_RELEASE, button: btn });
        }
      }
      s.heldMouseMask = 0;
      s.ltActive = false;
      s.rtActive = false;
      s.remX = 0;
      s.remY = 0;
      s.lastTickMs = 0;
      s.lastScrollDir = 0;
    }
    return { mouseButtons };
  }

  update(slot, mapped, nowMs) {
    const s = this._slotState(slot);
    const buttons = mapped.buttons | 0;
    const lt = mapped.leftTrigger | 0;
    const rt = mapped.rightTrigger | 0;
    const startPressed = (buttons & MOONLIGHT_BUTTONS.PLAY) !== 0;
    const chordBlocking =
      (buttons & (MOONLIGHT_BUTTONS.LB | MOONLIGHT_BUTTONS.RB | MOONLIGHT_BUTTONS.BACK)) !== 0;
    const otherButtons =
      (buttons & ~MOONLIGHT_BUTTONS.PLAY) !== 0 || lt > this.triggerPress || rt > this.triggerPress;

    let toggled = false;
    let sendNeutralController = false;
    const mouseButtons = [];

    if (startPressed && !s.prevStart && !chordBlocking && !otherButtons) {
      s.startDownAt = nowMs;
      s.startConsumed = false;
    } else if (!startPressed) {
      s.startDownAt = null;
      s.startConsumed = false;
    } else if (startPressed && s.startDownAt !== null) {
      if (chordBlocking || otherButtons) {
        s.startDownAt = null;
      } else if (!s.startConsumed && (nowMs - s.startDownAt) >= this.holdStartMs) {
        s.startConsumed = true;
        s.active = !s.active;
        toggled = true;
        if (s.active) {
          sendNeutralController = true;
          s.suppressedButtons =
            buttons & (MOONLIGHT_BUTTONS.A | MOONLIGHT_BUTTONS.B | MOONLIGHT_BUTTONS.X);
          s.suppressLt = lt >= this.triggerPress;
          s.suppressRt = rt >= this.triggerPress;
          s.ltActive = false;
          s.rtActive = false;
          s.remX = 0;
          s.remY = 0;
          s.lastTickMs = nowMs;
          s.lastScrollDir = 0;
          s.lastScrollAt = 0;
        } else {
          for (const btn of [MOUSE_BTN_LEFT, MOUSE_BTN_MIDDLE, MOUSE_BTN_RIGHT]) {
            if ((s.heldMouseMask & (1 << btn)) !== 0) {
              mouseButtons.push({ action: MOUSE_RELEASE, button: btn });
            }
          }
          s.heldMouseMask = 0;
          s.ltActive = false;
          s.rtActive = false;
          s.remX = 0;
          s.remY = 0;
        }
      }
    }
    s.prevStart = startPressed;

    if (!s.active) {
      return {
        active: false,
        toggled,
        sendNeutralController,
        dx: 0,
        dy: 0,
        mouseButtons,
        scrollClicks: 0,
      };
    }

    s.suppressedButtons &= buttons;
    if (lt < this.triggerRelease) s.suppressLt = false;
    if (rt < this.triggerRelease) s.suppressRt = false;

    s.rtActive =
      !s.suppressRt && (s.rtActive ? rt >= this.triggerRelease : rt >= this.triggerPress);
    s.ltActive =
      !s.suppressLt && (s.ltActive ? lt >= this.triggerRelease : lt >= this.triggerPress);

    const effButtons = buttons & ~s.suppressedButtons;
    const leftWanted = (effButtons & MOONLIGHT_BUTTONS.A) !== 0 || s.rtActive;
    const rightWanted = (effButtons & MOONLIGHT_BUTTONS.B) !== 0 || s.ltActive;
    const middleWanted = (effButtons & MOONLIGHT_BUTTONS.X) !== 0;

    const syncBtn = (btn, wanted) => {
      const bit = 1 << btn;
      const was = (s.heldMouseMask & bit) !== 0;
      if (wanted !== was) {
        if (wanted) s.heldMouseMask |= bit;
        else s.heldMouseMask &= ~bit;
        mouseButtons.push({ action: wanted ? MOUSE_PRESS : MOUSE_RELEASE, button: btn });
      }
    };
    syncBtn(MOUSE_BTN_LEFT, leftWanted);
    syncBtn(MOUSE_BTN_RIGHT, rightWanted);
    syncBtn(MOUSE_BTN_MIDDLE, middleWanted);

    const nx = (mapped.leftStickX || 0) / 32767;
    const ny = -(mapped.leftStickY || 0) / 32767;
    const r = Math.hypot(nx, ny);
    const dtSec =
      s.lastTickMs > 0 ? Math.max(0.001, Math.min(0.05, (nowMs - s.lastTickMs) / 1000)) : 1 / 60;
    s.lastTickMs = nowMs;

    let dx = 0;
    let dy = 0;
    if (r > this.stickDeadzone) {
      const u = Math.min(1, (r - this.stickDeadzone) / (1 - this.stickDeadzone));
      const speed = this.baseSpeedPxPerSec * u + this.maxSpeedPxPerSec * u * u * u;
      s.remX += (nx / r) * speed * dtSec;
      s.remY += (ny / r) * speed * dtSec;
      dx = Math.trunc(s.remX);
      dy = Math.trunc(s.remY);
      s.remX -= dx;
      s.remY -= dy;
    } else {
      s.remX = 0;
      s.remY = 0;
    }

    let scrollDir = 0;
    if ((buttons & MOONLIGHT_BUTTONS.UP) !== 0) scrollDir = 1;
    else if ((buttons & MOONLIGHT_BUTTONS.DOWN) !== 0) scrollDir = -1;
    else {
      const ryNorm = (mapped.rightStickY || 0) / 32767;
      if (ryNorm > 0.45) scrollDir = 1;
      else if (ryNorm < -0.45) scrollDir = -1;
    }

    let scrollClicks = 0;
    if (
      scrollDir !== 0 &&
      (scrollDir !== s.lastScrollDir || (nowMs - s.lastScrollAt) >= this.scrollRepeatMs)
    ) {
      scrollClicks = scrollDir;
      s.lastScrollDir = scrollDir;
      s.lastScrollAt = nowMs;
    } else if (scrollDir === 0) {
      s.lastScrollDir = 0;
    }

    return {
      active: true,
      toggled,
      sendNeutralController,
      dx,
      dy,
      mouseButtons,
      scrollClicks,
    };
  }
}
