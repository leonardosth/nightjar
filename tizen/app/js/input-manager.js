/**
 * Samsung Tizen OS 10 Input Manager
 *
 * Handles:
 *  - Samsung TV Remote keys (tizen.tvinputdevice registration + Return/Back keyCode 10009)
 *  - W3C Gamepad API (up to 4–16 controllers, right-stick polled every refresh for Frame Warp)
 *  - USB/Bluetooth Mouse (Pointer Lock relative dx/dy for Frame Warp) & Keyboard
 */

const TIZEN_KEYS = [
  'MediaPlay',
  'MediaPause',
  'MediaStop',
  'MediaPlayPause',
  'ColorF0Red',
  'ColorF1Green',
  'ColorF2Yellow',
  'ColorF3Blue',
  'Info',
  'Menu',
];

export const TIZEN_KEY_BACK = 10009;

function floatToI16(v) {
  const clamped = Math.max(-1.0, Math.min(1.0, v));
  return Math.round(clamped * 32767) | 0;
}

export class InputManager {
  constructor({ onNavigate, onBack, onStreamMenu, onMouseMove, onControllerPacket, onGamepadStatus }) {
    this.onNavigate = onNavigate;
    this.onBack = onBack;
    this.onStreamMenu = onStreamMenu;
    this.onMouseMove = onMouseMove;
    this.onControllerPacket = onControllerPacket;
    this.onGamepadStatus = onGamepadStatus;
    this.streaming = false;
    this.lastNavAt = 0;
    this.lastMenuChord = false;
    this._raf = null;

    this._registerTizenKeys();
    this._bindDomEvents();
    this._startGamepadLoop();
  }

  _registerTizenKeys() {
    try {
      if (typeof window !== 'undefined' && window.tizen && window.tizen.tvinputdevice) {
        window.tizen.tvinputdevice.registerKeyBatch(TIZEN_KEYS);
      }
    } catch {
      // Running outside Tizen TV runtime (e.g., desktop browser preview)
    }
  }

  _bindDomEvents() {
    window.addEventListener('keydown', (ev) => {
      if (ev.keyCode === TIZEN_KEY_BACK || ev.key === 'Escape' || ev.key === 'Backspace') {
        if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') && ev.key === 'Backspace') {
          return;
        }
        ev.preventDefault();
        if (this.streaming) {
          this.onStreamMenu();
        } else {
          this.onBack();
        }
        return;
      }

      if (this.streaming) {
        // Allow keyboard arrow keys in Frame Warp Demo mode as simulated mouse camera turn
        const step = 14;
        if (ev.key === 'ArrowLeft') this.onMouseMove(-step, 0);
        else if (ev.key === 'ArrowRight') this.onMouseMove(step, 0);
        else if (ev.key === 'ArrowUp') this.onMouseMove(0, -step);
        else if (ev.key === 'ArrowDown') this.onMouseMove(0, step);
        else if (ev.key === 'm' || ev.key === 'M') this.onStreamMenu();
        return;
      }

      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.onNavigate('up'); }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); this.onNavigate('down'); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); this.onNavigate('left'); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); this.onNavigate('right'); }
      else if (ev.key === 'Enter') {
        if (ev.target && ev.target.tagName !== 'SELECT') {
          this.onNavigate('select');
        }
      }
    });

    window.addEventListener('mousemove', (ev) => {
      if (!this.streaming) return;
      if (document.pointerLockElement || (ev.buttons & 1) !== 0) {
        const dx = ev.movementX | 0;
        const dy = ev.movementY | 0;
        if (dx !== 0 || dy !== 0) {
          this.onMouseMove(dx, dy);
        }
      }
    });

    window.addEventListener('gamepadconnected', () => this._emitGamepadCount());
    window.addEventListener('gamepaddisconnected', () => this._emitGamepadCount());
  }

  _emitGamepadCount() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    this.onGamepadStatus(pads);
  }

  _startGamepadLoop() {
    const poll = (now) => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad) continue;

        if (this.streaming) {
          // Standard W3C mapping: axes[2] = right stick X, axes[3] = right stick Y (inverted vs Moonlight y-up)
          const rx = floatToI16(pad.axes[2] || 0);
          const ry = floatToI16(-(pad.axes[3] || 0));
          const lx = floatToI16(pad.axes[0] || 0);
          const ly = floatToI16(-(pad.axes[1] || 0));
          let buttons = 0;
          for (let b = 0; b < Math.min(pad.buttons.length, 16); b++) {
            if (pad.buttons[b]?.pressed) buttons |= 1 << b;
          }
          // Nightjar chord: LB(4) + RB(5) + Start(9) + Back(8) opens stream menu
          const chord = Boolean(
            pad.buttons[4]?.pressed &&
            pad.buttons[5]?.pressed &&
            pad.buttons[8]?.pressed &&
            pad.buttons[9]?.pressed
          );
          if (chord && !this.lastMenuChord) {
            this.onStreamMenu();
          }
          this.lastMenuChord = chord;

          this.onControllerPacket(i, {
            buttons,
            leftStickX: lx,
            leftStickY: ly,
            rightStickX: rx,
            rightStickY: ry,
            leftTrigger: Math.round((pad.buttons[6]?.value || 0) * 255),
            rightTrigger: Math.round((pad.buttons[7]?.value || 0) * 255),
          });
        } else if (now - this.lastNavAt > 170) {
          const ax = pad.axes[0] || 0;
          const ay = pad.axes[1] || 0;
          if (pad.buttons[12]?.pressed || ay < -0.6) { this.lastNavAt = now; this.onNavigate('up'); }
          else if (pad.buttons[13]?.pressed || ay > 0.6) { this.lastNavAt = now; this.onNavigate('down'); }
          else if (pad.buttons[14]?.pressed || ax < -0.6) { this.lastNavAt = now; this.onNavigate('left'); }
          else if (pad.buttons[15]?.pressed || ax > 0.6) { this.lastNavAt = now; this.onNavigate('right'); }
          else if (pad.buttons[0]?.pressed) { this.lastNavAt = now; this.onNavigate('select'); }
          else if (pad.buttons[1]?.pressed) { this.lastNavAt = now; this.onBack(); }
        }
      }
      this._raf = requestAnimationFrame(poll);
    };
    this._raf = requestAnimationFrame(poll);
  }

  setStreaming(active) {
    this.streaming = active;
    this.lastMenuChord = false;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
