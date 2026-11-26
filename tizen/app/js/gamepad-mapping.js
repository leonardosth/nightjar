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
