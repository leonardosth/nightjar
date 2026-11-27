import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWasmEngine,
  probeHostAsync,
  pairHostAsync,
  cancelPairingAsync,
  listAppsAsync,
  cancelHostAppAsync,
  generatePairingPin,
  WasmStreamSession,
} from '../app/js/wasm-bridge.js';
import { InputManager, TIZEN_KEY_BACK } from '../app/js/input-manager.js';
import {
  MOONLIGHT_BUTTONS,
  mapStandardGamepad,
  computeActiveGamepadMask,
  shouldSendGamepadState,
  pickSpatialFocus,
} from '../app/js/gamepad-mapping.js';
import {
  STRINGS,
  resolveLocale,
  tr,
  migrateSettings,
  RETIRED_SETTING_KEYS,
} from '../app/js/i18n.js';

test('detectWasmEngine does not enter infinite microtask loop with Samsung Emscripten 1.39.4.7 Module.then', async () => {
  let thenCalls = 0;

  // Minimal globals matching Tizen WRT browser environment
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origFetch = globalThis.fetch;
  const origLocalStorage = globalThis.localStorage;

  try {
    const fakeCanvas = { id: 'stream-canvas' };
    globalThis.fetch = async () => ({ ok: true });
    globalThis.localStorage = {
      getItem: () => JSON.stringify({ uniqueId: '0123456789ABCDEF', certPem: 'CERT', keyPem: 'KEY' }),
      setItem: () => {},
    };
    globalThis.document = {
      getElementById: (id) => (id === 'stream-canvas' ? fakeCanvas : null),
      createElement: () => ({}),
      head: { appendChild: (el) => { if (el.onload) el.onload(); } },
    };

    // Verbatim Emscripten 1.39.4.7 MODULARIZE=1 factory pattern from nightjar_tizen.js:9
    globalThis.window = {
      NightjarWasmModule(moduleArg = {}) {
        const Module = { ...moduleArg };
        let calledRun = false;

        Module.initIdentity = (uid, cert, key) =>
          JSON.stringify({ uniqueId: uid || 'GEN', certPem: cert || 'C', keyPem: key || 'K' });

        // Exact Samsung Emscripten 1.39.4.7 bug: Module["then"] is never deleted before func(Module)
        Module['then'] = function (func) {
          thenCalls++;
          if (thenCalls > 25) {
            throw new Error('Infinite Emscripten Module.then microtask loop reproduced!');
          }
          if (calledRun) {
            func(Module);
          } else {
            const old = Module['onRuntimeInitialized'];
            Module['onRuntimeInitialized'] = function () {
              if (old) old();
              func(Module);
            };
          }
          return Module;
        };

        setTimeout(() => {
          calledRun = true;
          Module['calledRun'] = true;
          if (Module['onRuntimeInitialized']) {
            Module['onRuntimeInitialized']();
          }
        }, 5);

        return Module;
      },
    };

    const res = await detectWasmEngine();
    assert.equal(res.available, true, 'detectWasmEngine should succeed instead of looping/failing');
    assert.ok(res.runtime, 'runtime module should be returned');
    assert.equal(thenCalls, 0, 'Module.then should never be recursively invoked');
  } finally {
    globalThis.window = origWindow;
    globalThis.document = origDocument;
    globalThis.fetch = origFetch;
    globalThis.localStorage = origLocalStorage;
  }
});

test('InputManager handles Samsung TV remote keyCode fallbacks and prevents Enter double-click', () => {
  const origWindow = globalThis.window;
  const origNavigator = globalThis.navigator;
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;

  const listeners = new Map();
  let rafCb = null;

  try {
    globalThis.window = {
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        getGamepads: () => [
          {
            id: 'Xbox Wireless Controller',
            connected: true,
            axes: [0, 0, 0, 0],
            buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
          },
        ],
      },
    });
    globalThis.requestAnimationFrame = (cb) => {
      rafCb = cb;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {};

    const navEvents = [];
    let backCalls = 0;
    let detectedPads = null;

    const mgr = new InputManager({
      onNavigate: (dir) => navEvents.push(dir),
      onBack: () => { backCalls++; },
      onStreamMenu: () => {},
      onMouseMove: () => {},
      onControllerPacket: () => {},
      onGamepadStatus: (pads) => { detectedPads = pads; },
    });

    const keydown = listeners.get('keydown');
    assert.ok(keydown, 'keydown listener registered');

    // Simulate Samsung One Remote sending keyCode without standard ev.key
    let enterPrevented = false;
    keydown({ key: 'Unidentified', keyCode: 40, preventDefault() {} });
    keydown({ key: 'Unidentified', keyCode: 39, preventDefault() {} });
    keydown({ key: 'Unidentified', keyCode: 38, preventDefault() {} });
    keydown({ key: 'Unidentified', keyCode: 37, preventDefault() {} });
    keydown({
      key: 'Unidentified',
      keyCode: 13,
      target: { tagName: 'BUTTON' },
      preventDefault() { enterPrevented = true; },
    });
    keydown({ key: 'XF86Back', keyCode: TIZEN_KEY_BACK, preventDefault() {} });

    assert.deepEqual(navEvents, ['down', 'right', 'up', 'left', 'select']);
    assert.equal(enterPrevented, true, 'Enter must call preventDefault() so focused <button> does not fire duplicate click');
    assert.equal(backCalls, 1);

    // Pre-connected Xbox controller should report status on first poll even if gamepadconnected fired before app load
    assert.ok(rafCb, 'Gamepad polling loop scheduled');
    rafCb(250);
    assert.ok(Array.isArray(detectedPads) && detectedPads.length === 1, 'Pre-connected Xbox controller detected by polling loop');

    mgr.destroy();
  } finally {
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNavigator });
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
  }
});

test('WASM network helpers dispatch via non-blocking pthread job queue instead of blocking main thread', async () => {
  const jobs = new Map();
  let nextId = 1;
  let mainThreadBlocked = false;

  const runtime = {
    probeHost() { mainThreadBlocked = true; throw new Error('Must not call blocking probeHost on main thread'); },
    pairHost() { mainThreadBlocked = true; throw new Error('Must not call blocking pairHost on main thread'); },
    listApps() { mainThreadBlocked = true; throw new Error('Must not call blocking listApps on main thread'); },
    prepareStreamMedia() { return true; },
    startStreamLoop() {},
    startAsyncJob(op, arg1, arg2) {
      const id = nextId++;
      jobs.set(id, { polls: 0, op, arg1, arg2 });
      return id;
    },
    pollAsyncJob(id) {
      const j = jobs.get(id);
      j.polls++;
      if (j.polls < 2) return JSON.stringify({ done: false });
      jobs.delete(id);
      if (j.op === 'probe') {
        return JSON.stringify({ done: true, payload: { hostname: 'Rubylight-PC', paired: true, currentGame: 0, frameWarpVersion: 1, error: '' } });
      }
      if (j.op === 'pair') {
        return JSON.stringify({ done: true, payload: { ok: true, error: '' } });
      }
      if (j.op === 'applist') {
        return JSON.stringify({ done: true, payload: { error: '', apps: [{ id: 101, title: 'Desktop', hdr: true }] } });
      }
      if (j.op === 'connect_stream') {
        return JSON.stringify({ done: true, payload: { ok: true, error: '' } });
      }
      return JSON.stringify({ done: true, payload: { error: 'unknown' } });
    },
    stopStream() {},
  };

  const probe = await probeHostAsync(runtime, '192.168.0.10');
  assert.equal(probe.hostname, 'Rubylight-PC');
  assert.equal(probe.frameWarpVersion, 1);

  const pair = await pairHostAsync(runtime, '192.168.0.10', '1234');
  assert.equal(pair.ok, true);

  const apps = await listAppsAsync(runtime, '192.168.0.10');
  assert.equal(apps.apps.length, 1);
  assert.equal(apps.apps[0].id, 101);

  const session = new WasmStreamSession(runtime, { name: 'Rubylight-PC', address: '192.168.0.10' }, 101, {
    resolution: '3840x2160',
    fps: '120',
    codec: 'hevc',
    bitrate: '100',
    fwEnabled: true,
    fwLens: true,
    fwMaskWidth: '1024',
  });
  await session.start(() => {});
  session.stop();

  assert.equal(mainThreadBlocked, false);
});

test('mapStandardGamepad maps W3C standard buttons to Moonlight wire flags and excludes analog triggers from button bits', () => {
  const buttons = Array.from({ length: 18 }, () => ({ pressed: false, value: 0 }));
  buttons[0] = { pressed: true, value: 1 };   // A
  buttons[1] = { pressed: true, value: 1 };   // B
  buttons[6] = { pressed: true, value: 0.5 }; // LT (must NOT set 0x0040 LS_CLK)
  buttons[7] = { pressed: true, value: 1.0 }; // RT (must NOT set 0x0080 RS_CLK)
  buttons[12] = { pressed: true, value: 1 };  // D-Pad Up
  buttons[16] = { pressed: true, value: 1 };  // Guide

  const state = mapStandardGamepad({
    mapping: 'standard',
    axes: [0.5, -1.0, -0.5, 1.0],
    buttons,
  });

  assert.equal(
    state.buttons,
    MOONLIGHT_BUTTONS.A | MOONLIGHT_BUTTONS.B | MOONLIGHT_BUTTONS.UP | MOONLIGHT_BUTTONS.SPECIAL
  );
  assert.equal(state.leftTrigger, 128);
  assert.equal(state.rightTrigger, 255);
  assert.equal(state.leftStickX, 16384);
  assert.equal(state.leftStickY, 32767);
  assert.equal(state.rightStickX, -16384);
  assert.equal(state.rightStickY, -32767);
});

test('computeActiveGamepadMask and shouldSendGamepadState track multiple pads and suppress idle duplicates', () => {
  const mask = computeActiveGamepadMask([{ connected: true }, null, { connected: true }, { connected: false }]);
  assert.equal(mask, 0b0101);

  const s1 = { buttons: 0, leftTrigger: 0, rightTrigger: 0, leftStickX: 0, leftStickY: 0, rightStickX: 0, rightStickY: 0 };
  assert.equal(shouldSendGamepadState(null, s1, 100), true);
  assert.equal(shouldSendGamepadState({ ...s1, sentAt: 100 }, s1, 150), false);
  assert.equal(shouldSendGamepadState({ ...s1, sentAt: 100 }, s1, 360), true); // >= 250ms heartbeat
  assert.equal(shouldSendGamepadState({ ...s1, sentAt: 100 }, { ...s1, rightStickX: 400 }, 108), true);
});

test('pickSpatialFocus moves across 2D grid rows and columns instead of linear wrap', () => {
  const rects = [
    { left: 0, top: 0, width: 300, height: 150 },   // 0: row 0 col 0
    { left: 340, top: 0, width: 300, height: 150 }, // 1: row 0 col 1
    { left: 0, top: 180, width: 300, height: 150 }, // 2: row 1 col 0
    { left: 340, top: 180, width: 300, height: 150 }, // 3: row 1 col 1
  ];
  assert.equal(pickSpatialFocus(rects, 0, 'down'), 2);
  assert.equal(pickSpatialFocus(rects, 0, 'right'), 1);
  assert.equal(pickSpatialFocus(rects, 3, 'up'), 1);
  assert.equal(pickSpatialFocus(rects, 3, 'left'), 2);
});

test('i18n tables have identical keys in en and pt-BR, no host brand names, and two-sentence help texts', () => {
  const enKeys = Object.keys(STRINGS.en).sort();
  const ptKeys = Object.keys(STRINGS['pt-BR']).sort();
  assert.deepEqual(enKeys, ptKeys);

  for (const lang of ['en', 'pt-BR']) {
    for (const [k, v] of Object.entries(STRINGS[lang])) {
      assert.equal(/rubylight|sunshine|apollo|gamestream/i.test(v), false, `Brand found in ${lang}.${k}: ${v}`);
      if (k.startsWith('help.')) {
        const sentences = v.trim().split(/[.!?]+/).filter((s) => s.trim().length > 0);
        assert.equal(sentences.length, 2, `${lang}.${k} must have exactly 2 short sentences: "${v}"`);
      }
    }
  }
  assert.equal(resolveLocale('pt-BR'), 'pt-BR');
  assert.equal(resolveLocale('pt-PT'), 'pt-BR');
  assert.equal(resolveLocale('en-US'), 'en');
  assert.equal(tr('en', 'app.title'), 'Nightjar');
});

test('migrateSettings clears retired fwLens and fwMaskWidth keys and applies safe measured defaults', () => {
  const migrated = migrateSettings({ fps: '120', fwLens: false, fwMaskWidth: '512', bitrate: '150' });
  for (const retired of RETIRED_SETTING_KEYS) {
    assert.equal(retired in migrated, false, `Retired key ${retired} must be cleared`);
  }
  assert.equal(migrated.fps, '120');
  assert.equal(migrated.bitrate, '150');
  assert.equal(migrated.hdr, false);
  assert.equal(migrated.surround51, false);
});

test('generatePairingPin produces 4 digits and cancelPairingAsync aborts pending pair job', async () => {
  const pin = generatePairingPin();
  assert.match(pin, /^\d{4}$/);

  let cancelledOp = false;
  const runtime = {
    startAsyncJob(op) {
      if (op === 'cancel_pair') cancelledOp = true;
      return 1;
    },
    pollAsyncJob() {
      return JSON.stringify({ done: true, payload: { ok: true } });
    },
  };
  await cancelPairingAsync(runtime);
  assert.equal(cancelledOp, true);
});

test('WasmStreamSession polls termination events and invokes onTerminated with error code', async () => {
  const origDocument = globalThis.document;
  try {
    const fakeCanvas = { width: 1920, height: 1080, style: {} };
    const fakeVideo = { className: '' };
    globalThis.document = {
      getElementById: (id) => (id === 'stream-canvas' ? fakeCanvas : id === 'tizen-video-sink' ? fakeVideo : null),
    };

    let pollCount = 0;
    let shutdownCalled = false;
    let stopJobStarted = false;
    const runtime = {
      prepareStreamMedia: () => true,
      startStreamLoop: () => {},
      shutdownMedia: () => { shutdownCalled = true; },
      startAsyncJob(op) {
        if (op === 'stop_stream') stopJobStarted = true;
        return 1;
      },
      pollAsyncJob() {
        return JSON.stringify({ done: true, payload: { ok: true } });
      },
      getFrameWarpStatus() {
        return JSON.stringify({ negotiated: true, locked: false, rxFps: 120, decodedFps: 120, renderedFps: 120 });
      },
      pollSessionEvents() {
        pollCount++;
        if (pollCount === 1) return JSON.stringify([{ type: 'terminated', code: -100 }]);
        return '[]';
      },
    };

    const session = new WasmStreamSession(
      runtime,
      { name: 'Host', address: '192.168.1.50', frameWarpVersion: 1 },
      101,
      { resolution: '3840x2160', fps: '120', codec: 'hevc', bitrate: '150', hdr: false, surround51: false, fwEnabled: true }
    );

    let terminatedCode = null;
    await session.start(() => {}, { onTerminated: (code) => { terminatedCode = code; } });
    assert.equal(fakeCanvas.width, 3840, '4K Frame Warp stream must resize canvas drawing buffer to 3840x2160');
    assert.equal(fakeCanvas.height, 2160);

    await new Promise((r) => setTimeout(r, 140));
    assert.equal(terminatedCode, -100);
    await session.stop();
    assert.equal(shutdownCalled, true);
    assert.equal(stopJobStarted, true);
  } finally {
    globalThis.document = origDocument;
  }
});

test('WasmStreamSession.stop awaits stop_stream BEFORE calling shutdownMedia to prevent teardown UAF', async () => {
  const order = [];
  const runtime = {
    startAsyncJob(op) {
      if (op === 'stop_stream') order.push('stop_stream_start');
      return 1;
    },
    pollAsyncJob() {
      order.push('stop_stream_done');
      return JSON.stringify({ done: true, payload: { ok: true } });
    },
    shutdownMedia() {
      order.push('shutdownMedia');
    },
  };
  const session = new WasmStreamSession(
    runtime,
    { name: 'Host', address: '192.168.1.50', frameWarpVersion: 1 },
    101,
    { resolution: '3840x2160', fps: '60', codec: 'hevc', bitrate: '100', fwEnabled: true }
  );
  await session.stop();
  assert.deepEqual(order, ['stop_stream_start', 'stop_stream_done', 'shutdownMedia']);
});

test('InputManager routes D-Pad and Enter to navigation when stream menu is open, sends +-1 wheel clicks, and zeroes pad on disconnect', () => {
  const origWindow = globalThis.window;
  const origNavigator = globalThis.navigator;
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;

  const listeners = new Map();
  let rafCb = null;
  let connected = true;

  try {
    globalThis.window = {
      addEventListener(type, fn) { listeners.set(type, fn); },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        getGamepads: () => (connected ? [{
          id: 'Pad 0',
          mapping: 'standard',
          connected: true,
          axes: [0, 0, 0, 0],
          buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
        }] : [null]),
      },
    });
    globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
    globalThis.cancelAnimationFrame = () => {};

    const navEvents = [];
    const wheelClicks = [];
    const padPackets = [];
    const mgr = new InputManager({
      onNavigate: (d) => navEvents.push(d),
      onBack: () => {},
      onStreamMenu: () => {},
      onMouseMove: () => {},
      onMouseWheel: (c) => wheelClicks.push(c),
      onControllerPacket: (idx, mask, st) => padPackets.push({ idx, mask, st }),
      onGamepadStatus: () => {},
    });

    mgr.setStreaming(true);
    // Wheel must send +-1 click (LiSendScrollEvent multiplies by 120 internally)
    listeners.get('wheel')({ deltaY: -100, preventDefault() {} });
    assert.deepEqual(wheelClicks, [1]);

    // Connect then disconnect gamepad: disconnect must emit zeroed neutral packet with mask=0
    rafCb(100);
    connected = false;
    rafCb(120);
    const lastPkt = padPackets[padPackets.length - 1];
    assert.equal(lastPkt.mask, 0);
    assert.equal(lastPkt.st.buttons, 0);

    // Opening stream menu must restore TV remote D-pad/Enter navigation
    mgr.setMenuOpen(true);
    listeners.get('keydown')({ key: 'ArrowDown', keyCode: 40, preventDefault() {} });
    listeners.get('keydown')({ key: 'Enter', keyCode: 13, target: { tagName: 'BUTTON' }, preventDefault() {} });
    assert.deepEqual(navEvents, ['down', 'select']);

    mgr.destroy();
  } finally {
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNavigator });
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
  }
});


