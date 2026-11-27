/**
 * Samsung Tizen OS 10 Input Manager
 *
 * Handles:
 *  - Samsung TV Remote keys (tizen.tvinputdevice registration + Return/Back keyCode 10009)
 *  - W3C Gamepad API (up to 16 controllers, Moonlight wire flags, active mask & deduplication)
 *  - USB/Bluetooth Mouse (relative movement, buttons, wheel) & Physical Keyboard forwarding
 */

import {
  MOONLIGHT_BUTTONS,
  NavRepeat,
  assignControllerSlots,
  mapStandardGamepad,
  shouldSendGamepadState,
} from './gamepad-mapping.js';

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
export const KEY_LEFT = 37;
export const KEY_UP = 38;
export const KEY_RIGHT = 39;
export const KEY_DOWN = 40;
export const KEY_ENTER = 13;
export const TIZEN_KEY_RED = 403;
export const TIZEN_KEY_YELLOW = 405;
export const TIZEN_KEY_MENU = 10133;

const MOUSE_ACTION_PRESS = 0x07;
const MOUSE_ACTION_RELEASE = 0x08;
const KEY_ACTION_DOWN = 0x03;
const KEY_ACTION_UP = 0x04;

// Browser MouseEvent.button -> Moonlight BUTTON_*
const BROWSER_MOUSE_BUTTON = [1, 2, 3, 4, 5];

function keyModifiers(ev) {
  let mod = 0;
  if (ev.shiftKey) mod |= 0x01;
  if (ev.ctrlKey) mod |= 0x02;
  if (ev.altKey) mod |= 0x04;
  if (ev.metaKey) mod |= 0x08;
  return mod;
}

export class InputManager {
  constructor({
    onNavigate,
    onBack,
    onDelete,
    onStreamMenu,
    onMouseMove,
    onMouseButton,
    onMouseWheel,
    onKeyEvent,
    onControllerArrival,
    onControllerPacket,
    onGamepadStatus,
  }) {
    this.onNavigate = onNavigate;
    this.onBack = onBack;
    this.onDelete = onDelete;
    this.onStreamMenu = onStreamMenu;
    this.onMouseMove = onMouseMove;
    this.onMouseButton = onMouseButton;
    this.onMouseWheel = onMouseWheel;
    this.onKeyEvent = onKeyEvent;
    this.onControllerArrival = onControllerArrival;
    this.onControllerPacket = onControllerPacket;
    this.onGamepadStatus = onGamepadStatus;

    this.streaming = false;
    this.demoMode = false;
    this.menuOpen = false;
    this.lastMenuChord = false;
    this._lastPadCount = -1;
    this._slotByPad = new Map();
    this._lastSentState = new Array(16).fill(null);
    this._navRepeats = Array.from({ length: 16 }, () => new NavRepeat());
    this._prevButtons = Array.from({ length: 16 }, () => ({ a: false, b: false }));
    this._raf = null;

    this._registerTizenKeys();
    this._bindDomEvents();
    this._startGamepadLoop();
  }

  _registerTizenKeys() {
    try {
      if (typeof window !== 'undefined' && window.tizen && window.tizen.tvinputdevice) {
        for (const k of TIZEN_KEYS) {
          try {
            window.tizen.tvinputdevice.registerKey(k);
          } catch {
            // Ignore unsupported optional key on specific TV model
          }
        }
      }
    } catch {
      // Running outside Tizen TV runtime (e.g., desktop browser preview)
    }
  }

  _bindDomEvents() {
    window.addEventListener('keydown', (ev) => {
      const code = ev.keyCode | 0;
      const key = ev.key || '';
      const tagName = ev.target && ev.target.tagName ? ev.target.tagName : '';

      const isTizenBack = code === TIZEN_KEY_BACK || key === 'XF86Back';
      const isMenu =
        key === 'Menu' ||
        key === 'Info' ||
        key === 'ColorF2Yellow' ||
        code === TIZEN_KEY_MENU ||
        code === TIZEN_KEY_YELLOW;

      if (this.streaming && !this.menuOpen) {
        if (isTizenBack || isMenu || (this.demoMode && (key === 'Escape' || key === 'm' || key === 'M'))) {
          ev.preventDefault();
          this.onStreamMenu();
          return;
        }
        if (this.demoMode) {
          const step = 18;
          const isUp = key === 'ArrowUp' || code === KEY_UP;
          const isDown = key === 'ArrowDown' || code === KEY_DOWN;
          const isLeft = key === 'ArrowLeft' || code === KEY_LEFT;
          const isRight = key === 'ArrowRight' || code === KEY_RIGHT;
          const isEnter = key === 'Enter' || code === KEY_ENTER;
          if (isLeft) { ev.preventDefault(); this.onMouseMove?.(-step, 0); return; }
          if (isRight) { ev.preventDefault(); this.onMouseMove?.(step, 0); return; }
          if (isUp) { ev.preventDefault(); this.onMouseMove?.(0, -step); return; }
          if (isDown) { ev.preventDefault(); this.onMouseMove?.(0, step); return; }
          if (isEnter) { ev.preventDefault(); this.onStreamMenu(); return; }
          return;
        }
        if (this.onKeyEvent && code > 0 && code < 256) {
          ev.preventDefault();
          this.onKeyEvent(0x8000 | (code & 0xff), KEY_ACTION_DOWN, keyModifiers(ev));
        }
        return;
      }

      if (isTizenBack || key === 'Escape' || key === 'Backspace') {
        if ((tagName === 'INPUT' || tagName === 'TEXTAREA') && key === 'Backspace') {
          return;
        }
        ev.preventDefault();
        if (ev.repeat) return;
        if (this.menuOpen) {
          this.onStreamMenu();
        } else {
          this.onBack();
        }
        return;
      }

      if (this.menuOpen && isMenu) {
        ev.preventDefault();
        if (!ev.repeat) this.onStreamMenu();
        return;
      }

      if (code === TIZEN_KEY_RED || key === 'ColorF0Red' || key === 'Delete') {
        if (tagName !== 'INPUT' && tagName !== 'TEXTAREA' && this.onDelete) {
          ev.preventDefault();
          if (!ev.repeat) this.onDelete();
          return;
        }
      }

      const isUp = key === 'ArrowUp' || code === KEY_UP;
      const isDown = key === 'ArrowDown' || code === KEY_DOWN;
      const isLeft = key === 'ArrowLeft' || code === KEY_LEFT;
      const isRight = key === 'ArrowRight' || code === KEY_RIGHT;
      const isEnter = key === 'Enter' || code === KEY_ENTER;

      if (isUp) { ev.preventDefault(); this.onNavigate('up'); }
      else if (isDown) { ev.preventDefault(); this.onNavigate('down'); }
      else if (isLeft) { ev.preventDefault(); this.onNavigate('left'); }
      else if (isRight) { ev.preventDefault(); this.onNavigate('right'); }
      else if (isEnter) {
        if (tagName !== 'SELECT' && tagName !== 'INPUT') {
          ev.preventDefault();
          if (!ev.repeat) this.onNavigate('select');
        }
      }
    });

    window.addEventListener('keyup', (ev) => {
      if (!this.streaming || this.menuOpen || this.demoMode || !this.onKeyEvent) return;
      const code = ev.keyCode | 0;
      if (code > 0 && code < 256) {
        ev.preventDefault();
        this.onKeyEvent(0x8000 | (code & 0xff), KEY_ACTION_UP, keyModifiers(ev));
      }
    });

    window.addEventListener('mousemove', (ev) => {
      if (!this.streaming || this.menuOpen) return;
      if (document.pointerLockElement || (ev.buttons & 1) !== 0 || !this.demoMode) {
        const dx = ev.movementX | 0;
        const dy = ev.movementY | 0;
        if (dx !== 0 || dy !== 0) {
          this.onMouseMove?.(dx, dy);
        }
      }
    });

    window.addEventListener('mousedown', (ev) => {
      if (!this.streaming || this.menuOpen || !this.onMouseButton) return;
      const btn = BROWSER_MOUSE_BUTTON[ev.button];
      if (btn) this.onMouseButton(MOUSE_ACTION_PRESS, btn);
    });

    window.addEventListener('mouseup', (ev) => {
      if (!this.streaming || this.menuOpen || !this.onMouseButton) return;
      const btn = BROWSER_MOUSE_BUTTON[ev.button];
      if (btn) this.onMouseButton(MOUSE_ACTION_RELEASE, btn);
    });

    window.addEventListener('wheel', (ev) => {
      if (!this.streaming || this.menuOpen || !this.onMouseWheel) return;
      if (ev.deltaY !== 0) {
        ev.preventDefault();
        // LiSendScrollEvent multiplies clicks by WHEEL_DELTA (120) internally
        this.onMouseWheel(-Math.sign(ev.deltaY));
      }
    }, { passive: false });

    window.addEventListener('gamepadconnected', () => this._emitGamepadCount());
    window.addEventListener('gamepaddisconnected', () => this._emitGamepadCount());
  }

  _emitGamepadCount() {
    const pads = navigator.getGamepads
      ? Array.from(navigator.getGamepads()).filter((p) => p && p.connected !== false)
      : [];
    this._lastPadCount = pads.length;
    this.onGamepadStatus(pads);
  }

  _seedButtonEdges() {
    const rawPads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const limit = Math.min(rawPads.length, 16);
    for (let i = 0; i < 16; i++) {
      const pad = i < limit ? rawPads[i] : null;
      const connected = Boolean(pad && pad.connected !== false);
      this._prevButtons[i] = {
        a: connected && Boolean(pad.buttons?.[0]?.pressed),
        b: connected && Boolean(pad.buttons?.[1]?.pressed),
      };
      this._navRepeats[i].update(null, 0);
    }
  }

  _startGamepadLoop() {
    const poll = (now) => {
      const rawPads = navigator.getGamepads ? navigator.getGamepads() : [];
      const limit = Math.min(rawPads.length, 16);
      const connectedPads = [];
      for (let i = 0; i < limit; i++) {
        if (rawPads[i] && rawPads[i].connected !== false) {
          connectedPads.push(rawPads[i]);
        } else {
          this._prevButtons[i] = { a: false, b: false };
          this._navRepeats[i].update(null, now);
        }
      }
      if (connectedPads.length !== this._lastPadCount) {
        this._lastPadCount = connectedPads.length;
        this.onGamepadStatus(connectedPads);
      }

      if (this.streaming) {
        const { slots, mask, arrived, removed } = assignControllerSlots(this._slotByPad, rawPads);
        this._slotByPad = slots;

        for (const { slot } of removed) {
          this._lastSentState[slot] = null;
          this.onControllerPacket?.(slot, mask, {
            buttons: 0,
            leftTrigger: 0,
            rightTrigger: 0,
            leftStickX: 0,
            leftStickY: 0,
            rightStickX: 0,
            rightStickY: 0,
          });
        }
        for (const { slot } of arrived) {
          this._lastSentState[slot] = null;
          this.onControllerArrival?.(slot, mask);
        }

        if (!this.menuOpen) {
          for (const [padIdx, slot] of slots.entries()) {
            const pad = rawPads[padIdx];
            if (!pad || pad.connected === false) continue;
            const mapped = mapStandardGamepad(pad);
            // Nightjar chord: LB + RB + Start + Back opens stream menu
            const chordMask =
              MOONLIGHT_BUTTONS.LB |
              MOONLIGHT_BUTTONS.RB |
              MOONLIGHT_BUTTONS.PLAY |
              MOONLIGHT_BUTTONS.BACK;
            const chord = (mapped.buttons & chordMask) === chordMask;
            if (chord && !this.lastMenuChord) {
              this.onStreamMenu();
            }
            this.lastMenuChord = chord;

            // Keep sending fresh right-stick samples while deflected for Frame Warp integration
            const stickDeflected =
              Math.abs(mapped.rightStickX) > 2600 || Math.abs(mapped.rightStickY) > 2600;
            if (stickDeflected || shouldSendGamepadState(this._lastSentState[slot], mapped, now)) {
              this._lastSentState[slot] = { ...mapped, sentAt: now };
              this.onControllerPacket(slot, mask, mapped);
            }
          }
        }
      }

      if (!this.streaming || this.menuOpen) {
        for (let i = 0; i < limit; i++) {
          const pad = rawPads[i];
          if (!pad || pad.connected === false) continue;

          const ax = pad.axes[0] || 0;
          const ay = pad.axes[1] || 0;
          const hatX = pad.mapping !== 'standard' && pad.axes.length >= 8 ? (pad.axes[6] || 0) : 0;
          const hatY = pad.mapping !== 'standard' && pad.axes.length >= 8 ? (pad.axes[7] || 0) : 0;

          let dir = null;
          if (pad.buttons[12]?.pressed || ay < -0.55 || hatY < -0.5) dir = 'up';
          else if (pad.buttons[13]?.pressed || ay > 0.55 || hatY > 0.5) dir = 'down';
          else if (pad.buttons[14]?.pressed || ax < -0.55 || hatX < -0.5) dir = 'left';
          else if (pad.buttons[15]?.pressed || ax > 0.55 || hatX > 0.5) dir = 'right';

          const fireDir = this._navRepeats[i].update(dir, now);
          if (fireDir) this.onNavigate(fireDir);

          const aPressed = Boolean(pad.buttons[0]?.pressed);
          const bPressed = Boolean(pad.buttons[1]?.pressed);
          if (aPressed && !this._prevButtons[i].a) {
            this.onNavigate('select');
          }
          if (bPressed && !this._prevButtons[i].b) {
            if (this.menuOpen) this.onStreamMenu();
            else this.onBack();
          }
          this._prevButtons[i].a = aPressed;
          this._prevButtons[i].b = bPressed;
        }
      }
      this._raf = requestAnimationFrame(poll);
    };
    this._raf = requestAnimationFrame(poll);
  }

  setStreaming(active, { demo = false } = {}) {
    this.streaming = active;
    this.demoMode = active && demo;
    this.menuOpen = false;
    this.lastMenuChord = false;
    this._slotByPad = new Map();
    this._lastSentState.fill(null);
    this._seedButtonEdges();
  }

  setMenuOpen(open) {
    this.menuOpen = Boolean(open);
    this.lastMenuChord = false;
    this._seedButtonEdges();
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
