import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWasmEngine,
  probeHostAsync,
  pairHostAsync,
  listAppsAsync,
  WasmStreamSession,
} from '../app/js/wasm-bridge.js';
import { InputManager, TIZEN_KEY_BACK } from '../app/js/input-manager.js';

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

