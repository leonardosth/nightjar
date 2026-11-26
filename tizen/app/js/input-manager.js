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
  mapStandardGamepad,
  computeActiveGamepadMask,
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
    this.lastNavAt = 0;
    this.lastMenuChord = false;
    this._lastPadCount = -1;
    this._arrivedMask = 0;
    this._lastSentState = new Array(16).fill(null);
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

      if (this.streaming) {
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
        this.onBack();
        return;
      }

      if (code === TIZEN_KEY_RED || key === 'ColorF0Red' || key === 'Delete') {
        if (tagName !== 'INPUT' && tagName !== 'TEXTAREA' && this.onDelete) {
          ev.preventDefault();
          this.onDelete();
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
          this.onNavigate('select');
        }
      }
    });

    window.addEventListener('keyup', (ev) => {
      if (!this.streaming || this.demoMode || !this.onKeyEvent) return;
      const code = ev.keyCode | 0;
      if (code > 0 && code < 256) {
        ev.preventDefault();
        this.onKeyEvent(0x8000 | (code & 0xff), KEY_ACTION_UP, keyModifiers(ev));
      }
    });

    window.addEventListener('mousemove', (ev) => {
      if (!this.streaming) return;
      if (document.pointerLockElement || (ev.buttons & 1) !== 0 || !this.demoMode) {
        const dx = ev.movementX | 0;
        const dy = ev.movementY | 0;
        if (dx !== 0 || dy !== 0) {
          this.onMouseMove?.(dx, dy);
        }
      }
    });

    window.addEventListener('mousedown', (ev) => {
      if (!this.streaming || !this.onMouseButton) return;
      const btn = BROWSER_MOUSE_BUTTON[ev.button];
      if (btn) this.onMouseButton(MOUSE_ACTION_PRESS, btn);
    });

    window.addEventListener('mouseup', (ev) => {
      if (!this.streaming || !this.onMouseButton) return;
      const btn = BROWSER_MOUSE_BUTTON[ev.button];
      if (btn) this.onMouseButton(MOUSE_ACTION_RELEASE, btn);
    });

    window.addEventListener('wheel', (ev) => {
      if (!this.streaming || !this.onMouseWheel) return;
      if (ev.deltaY !== 0) {
        ev.preventDefault();
        this.onMouseWheel(-Math.sign(ev.deltaY) * 120);
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

  _startGamepadLoop() {
    const poll = (now) => {
      const rawPads = navigator.getGamepads ? navigator.getGamepads() : [];
      const activeMask = computeActiveGamepadMask(rawPads);
      const connectedPads = [];
      for (let i = 0; i < Math.min(rawPads.length, 16); i++) {
        if (rawPads[i] && rawPads[i].connected !== false) {
          connectedPads.push(rawPads[i]);
        }
      }
      if (connectedPads.length !== this._lastPadCount) {
        this._lastPadCount = connectedPads.length;
        this.onGamepadStatus(connectedPads);
      }

      if (this.streaming) {
        for (let i = 0; i < 16; i++) {
          const bit = 1 << i;
          const isConnected = (activeMask & bit) !== 0;
          if (isConnected && (this._arrivedMask & bit) === 0) {
            this._arrivedMask |= bit;
            this._lastSentState[i] = null;
            this.onControllerArrival?.(i, activeMask);
          } else if (!isConnected && (this._arrivedMask & bit) !== 0) {
            this._arrivedMask &= ~bit;
            this._lastSentState[i] = null;
          }
        }
      }

      for (let i = 0; i < Math.min(rawPads.length, 16); i++) {
        const pad = rawPads[i];
        if (!pad || pad.connected === false) continue;

        if (this.streaming) {
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
          if (stickDeflected || shouldSendGamepadState(this._lastSentState[i], mapped, now)) {
            this._lastSentState[i] = { ...mapped, sentAt: now };
            this.onControllerPacket(i, activeMask, mapped);
          }
        } else if (now - this.lastNavAt > 170) {
          const ax = pad.axes[0] || 0;
          const ay = pad.axes[1] || 0;
          const hatX = pad.mapping !== 'standard' && pad.axes.length >= 8 ? (pad.axes[6] || 0) : 0;
          const hatY = pad.mapping !== 'standard' && pad.axes.length >= 8 ? (pad.axes[7] || 0) : 0;

          if (pad.buttons[12]?.pressed || ay < -0.55 || hatY < -0.5) { this.lastNavAt = now; this.onNavigate('up'); }
          else if (pad.buttons[13]?.pressed || ay > 0.55 || hatY > 0.5) { this.lastNavAt = now; this.onNavigate('down'); }
          else if (pad.buttons[14]?.pressed || ax < -0.55 || hatX < -0.5) { this.lastNavAt = now; this.onNavigate('left'); }
          else if (pad.buttons[15]?.pressed || ax > 0.55 || hatX > 0.5) { this.lastNavAt = now; this.onNavigate('right'); }
          else if (pad.buttons[0]?.pressed) { this.lastNavAt = now; this.onNavigate('select'); }
          else if (pad.buttons[1]?.pressed) { this.lastNavAt = now; this.onBack(); }
        }
      }
      this._raf = requestAnimationFrame(poll);
    };
    this._raf = requestAnimationFrame(poll);
  }

  setStreaming(active, { demo = false } = {}) {
    this.streaming = active;
    this.demoMode = active && demo;
    this.lastMenuChord = false;
    this._arrivedMask = 0;
    this._lastSentState.fill(null);
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
