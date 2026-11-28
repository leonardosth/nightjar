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
  ControllerMouseEmulation,
  MOONLIGHT_BUTTONS,
  NavRepeat,
  assignControllerSlots,
  mapStandardGamepad,
  computeActiveGamepadMask,
  shouldSendGamepadState,
  pickSpatialFocus,
} from '../app/js/gamepad-mapping.js';
import { formatLatency, fwStateKey, buildOverlayRows } from '../app/js/stream-stats.js';
import { initialFocusKey, launchDecision } from '../app/js/home-model.js';
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

test('patch_moonlight_frame_warp.py applies Frame Warp v1 and Samsung Tizen Sockets Extension patches idempotently', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nj-ml-patch-'));
  try {
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'enet'), { recursive: true });

    await fs.writeFile(
      path.join(tmp, 'src', 'Limelight.h'),
      '#ifdef __cplusplus\nextern "C" {\n#endif\nint LiStartConnection(void);\n#ifdef __cplusplus\n}\n#endif\n'
    );
    await fs.writeFile(
      path.join(tmp, 'src', 'RtspConnection.c'),
      '#include "Limelight-internal.h"\n' +
      'static bool transactRtspMessageTcp(void) {\n' +
      '    int err = 0; int* error = &err;\n' +
      '    if (*error == ECONNREFUSED) {\n' +
      '        return false;\n' +
      '    }\n' +
      '    return true;\n' +
      '}\n' +
      'int performRtspHandshake(PSERVER_INFORMATION serverInfo) {\n' +
      '    ReferenceFrameInvalidationSupported = strstr(response.payload, "x-nv-video[0].refPicInvalidation") != NULL;\n' +
      '    return 0;\n' +
      '}\n'
    );
    await fs.writeFile(
      path.join(tmp, 'src', 'ControlStream.c'),
      '#include "Limelight-internal.h"\n' +
      'void handle(void) {\n' +
      '    if (0) {}\n' +
      '    else if (ctlHdr->type == packetTypes[IDX_TERMINATION]) {\n' +
      '    }\n' +
      '}\n'
    );
    await fs.writeFile(
      path.join(tmp, 'src', 'PlatformSockets.c'),
      '#include "Limelight-internal.h"\n' +
      'int recvUdpSocket(void) {\n' +
      '    int err = -1;\n' +
      '    do {\n' +
      '        if (err < 0 && (LastSocketError() == EWOULDBLOCK || LastSocketError() == ETIMEDOUT)) {\n' +
      '            return 0;\n' +
      '        }\n' +
      '    } while (err < 0 && LastSocketError() == ECONNREFUSED);\n' +
      '    return err;\n' +
      '}\n' +
      'int setSocketNonBlocking(SOCKET s, bool enabled) {\n' +
      '#if defined(__vita__) || defined(__HAIKU__)\n' +
      '    return 0;\n' +
      '#endif\n' +
      '}\n' +
      'int connectTcpSocket(void) {\n' +
      '    int err = 0;\n' +
      '    if (err != EWOULDBLOCK && err != EAGAIN && err != EINPROGRESS) {\n' +
      '        return -1;\n' +
      '    }\n' +
      '    return 0;\n' +
      '}\n'
    );
    await fs.writeFile(
      path.join(tmp, 'enet', 'unix.c'),
      'ENetSocket\nenet_socket_create (int af, ENetSocketType type)\n{\n' +
      '    ENetSocket sock = socket (af, type == ENET_SOCKET_TYPE_DATAGRAM ? SOCK_DGRAM : SOCK_STREAM, 0);\n' +
      '    return sock;\n' +
      '}\n' +
      'int enet_socket_set_option(void) {\n' +
      '    switch (0) {\n' +
      '        case ENET_SOCKOPT_NONBLOCK:\n' +
      '#ifdef HAS_FCNTL\n' +
      '            result = fcntl (socket, F_SETFL, (value ? O_NONBLOCK : 0) | (fcntl (socket, F_GETFL, 0) & ~O_NONBLOCK));\n' +
      '#endif\n' +
      '            break;\n' +
      '    }\n' +
      '}\n' +
      'int enet_socket_connect(void) {\n' +
      '    if (result == -1 && errno == EINPROGRESS)\n' +
      '      return 0;\n' +
      '}\n' +
      'int enet_socket_send(void) {\n' +
      '        switch (errno)\n        {\n        case EWOULDBLOCK:\n            return 0;\n        }\n' +
      '}\n' +
      'int enet_socket_receive(void) {\n' +
      '    if (recvLength == -1)\n    {\n       if (errno == EWOULDBLOCK)\n         return 0;\n    }\n' +
      '    if (recvLength == -1)\n    {\n       if (errno == EWOULDBLOCK)\n         return 0;\n    }\n' +
      '}\n'
    );

    await fs.writeFile(
      path.join(tmp, 'src', 'InputStream.c'),
      '#include "Limelight-internal.h"\n' +
      'static void inputSendThreadProc(void* context) {\n' +
      '    if (1) {\n' +
      '        short controllerNumber = 0;\n' +
      '        if (1) {\n' +
      '            if (holder == currentQueuedControllerPacket[controllerNumber]) {\n' +
      '                currentQueuedControllerPacket[controllerNumber] = NULL;\n' +
      '            }\n\n' +
      '            PltUnlockMutex(&batchedInputMutex);\n' +
      '        }\n' +
      '    }\n' +
      '}\n'
    );

    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'wasm',
      'scripts',
      'patch_moonlight_frame_warp.py'
    );

    execFileSync('python', [scriptPath, tmp], { stdio: 'pipe' });
    // Second invocation must be a clean idempotent no-op
    execFileSync('python', [scriptPath, tmp], { stdio: 'pipe' });

    const psPatched = await fs.readFile(path.join(tmp, 'src', 'PlatformSockets.c'), 'utf8');
    const enetPatched = await fs.readFile(path.join(tmp, 'enet', 'unix.c'), 'utf8');
    const rtspPatched = await fs.readFile(path.join(tmp, 'src', 'RtspConnection.c'), 'utf8');
    const inpPatched = await fs.readFile(path.join(tmp, 'src', 'InputStream.c'), 'utf8');
    const hPatched = await fs.readFile(path.join(tmp, 'src', 'Limelight.h'), 'utf8');

    assert.match(psPatched, /#if defined\(__EMSCRIPTEN__\)[\s\S]*return SOCKET_ERROR;/);
    assert.match(psPatched, /__WASI_ERRNO_AGAIN/);
    assert.match(enetPatched, /sock_flags = SOCK_NONBLOCK;/);
    assert.match(enetPatched, /__WASI_ERRNO_INPROGRESS/);
    assert.match(rtspPatched, /__WASI_ERRNO_CONNREFUSED/);
    assert.match(rtspPatched, /rlHasFrameWarpControl/);
    assert.match(inpPatched, /NIGHTJAR_TIZEN_INPUT_WIRE_PATCH/);
    assert.match(inpPatched, /g_frameWarpControllerCallback/);
    assert.match(hPatched, /LiSetFrameWarpControllerCallback/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('assignControllerSlots compacts W3C indices into lowest free Moonlight slots and reuses freed slots', () => {
  const r1 = assignControllerSlots(new Map(), [null, { connected: true }]);
  assert.equal(r1.slots.get(1), 0);
  assert.equal(r1.mask, 0b1);
  assert.deepEqual(r1.arrived, [{ pad: 1, slot: 0 }]);

  const r2 = assignControllerSlots(r1.slots, [null, { connected: true }, { connected: true }]);
  assert.equal(r2.slots.get(1), 0);
  assert.equal(r2.slots.get(2), 1);
  assert.equal(r2.mask, 0b11);
  assert.deepEqual(r2.arrived, [{ pad: 2, slot: 1 }]);

  const r3 = assignControllerSlots(r2.slots, [null, null, { connected: true }]);
  assert.equal(r3.slots.has(1), false);
  assert.equal(r3.slots.get(2), 1);
  assert.equal(r3.mask, 0b10);
  assert.deepEqual(r3.removed, [{ pad: 1, slot: 0 }]);

  const r4 = assignControllerSlots(r3.slots, [{ connected: true }, null, { connected: true }]);
  assert.equal(r4.slots.get(0), 0);
  assert.equal(r4.slots.get(2), 1);
  assert.equal(r4.mask, 0b11);
  assert.deepEqual(r4.arrived, [{ pad: 0, slot: 0 }]);
});

test('NavRepeat fires on press edge, waits initialDelayMs, then repeats at repeatMs', () => {
  const nr = new NavRepeat({ initialDelayMs: 400, repeatMs: 140 });
  assert.equal(nr.update('down', 100), 'down');
  assert.equal(nr.update('down', 300), null);
  assert.equal(nr.update('down', 499), null);
  assert.equal(nr.update('down', 500), 'down');
  assert.equal(nr.update('down', 600), null);
  assert.equal(nr.update('down', 640), 'down');
  assert.equal(nr.update(null, 650), null);
  assert.equal(nr.update('up', 660), 'up');
});

test('InputManager edge-triggers A/B, ignores repeat Enter, and compacts streaming controller slot', () => {
  const origWindow = globalThis.window;
  const origNavigator = globalThis.navigator;
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;

  const listeners = new Map();
  let rafCb = null;
  const pad0 = {
    id: 'Pad',
    mapping: 'standard',
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  };
  let pads = [pad0];

  try {
    globalThis.window = {
      addEventListener(type, fn) { listeners.set(type, fn); },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { getGamepads: () => pads },
    });
    globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
    globalThis.cancelAnimationFrame = () => {};

    const navEvents = [];
    let backCount = 0;
    const packets = [];

    const mgr = new InputManager({
      onNavigate: (d) => navEvents.push(d),
      onBack: () => { backCount++; },
      onStreamMenu: () => {},
      onMouseMove: () => {},
      onControllerPacket: (idx, mask, st) => packets.push({ idx, mask, st }),
      onGamepadStatus: () => {},
    });

    // Holding A across 5 rAF ticks (~16 ms apart) yields exactly one 'select'
    pad0.buttons[0].pressed = true;
    for (let t = 100; t <= 164; t += 16) rafCb(t);
    assert.deepEqual(navEvents, ['select']);

    // Holding B across multiple ticks yields exactly one back
    pad0.buttons[0].pressed = false;
    pad0.buttons[1].pressed = true;
    for (let t = 180; t <= 244; t += 16) rafCb(t);
    assert.equal(backCount, 1);

    // keydown Enter with repeat: true is ignored
    listeners.get('keydown')({ key: 'Enter', keyCode: 13, repeat: true, target: { tagName: 'BUTTON' }, preventDefault() {} });
    assert.deepEqual(navEvents, ['select']);

    // While streaming, a pad only at W3C index 2 sends onControllerPacket with idx 0
    pad0.buttons[1].pressed = false;
    pads = [null, null, {
      id: 'Pad at 2',
      mapping: 'standard',
      connected: true,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    }];
    mgr.setStreaming(true);
    rafCb(300);
    assert.equal(packets.length > 0, true);
    assert.equal(packets[0].idx, 0);
    assert.equal(packets[0].mask, 1);

    mgr.destroy();
  } finally {
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNavigator });
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
  }
});

test('formatLatency and buildOverlayRows format latency stats, Frame Warp states, and missing fields cleanly', () => {
  assert.equal(formatLatency(null), '—');
  assert.equal(formatLatency({ n: 0, min: 1, avg: 2, max: 3 }), '—');
  assert.equal(formatLatency({ n: 5, min: 1.04, avg: 2.04, max: 3.04 }), '1.0 / 2.0 / 3.0 ms');

  const rows = buildOverlayRows(
    {
      session: 'PC (4K)',
      hostLat: { n: 10, min: 1, avg: 2, max: 3 },
      fwState: 'rtsp-no-fw',
    },
    (k) => k
  );
  const hostRow = rows.find((r) => r.key === 'hostLat');
  const fwRow = rows.find((r) => r.key === 'fw');
  const decRow = rows.find((r) => r.key === 'decLat');
  assert.equal(hostRow.value, '1.0 / 2.0 / 3.0 ms');
  assert.equal(fwRow.value, 'ov.fw.rtsp-no-fw');
  assert.equal(fwStateKey({ fwState: 'rtsp-no-fw' }), 'ov.fw.rtsp-no-fw');
  assert.equal(decRow.value, '—');

  const emptyRows = buildOverlayRows({}, (k) => k);
  assert.equal(emptyRows.find((r) => r.key === 'hostLat').value, '—');
  assert.equal(emptyRows.find((r) => r.key === 'presentLat').value, '—');
  assert.equal(emptyRows.find((r) => r.key === 'net').value, '—');
});

test('initialFocusKey and launchDecision cover all launcher focus and launch states', () => {
  assert.equal(initialFocusKey({ lastPlayedVisible: true, selectedHostId: 'h1', hosts: [{ id: 'h1' }] }), 'continue');
  assert.equal(initialFocusKey({ lastPlayedVisible: false, selectedHostId: 'h2', hosts: [{ id: 'h1' }, { id: 'h2' }] }), 'host:h2');
  assert.equal(initialFocusKey({ lastPlayedVisible: false, selectedHostId: '', hosts: [{ id: 'h1' }] }), 'host:h1');
  assert.equal(initialFocusKey({ lastPlayedVisible: false, selectedHostId: '', hosts: [] }), 'add-host');

  assert.equal(launchDecision({ paired: false, currentGame: 0 }, 101), 'pair');
  assert.equal(launchDecision({ paired: true, currentGame: 101 }, 101), 'resume');
  assert.equal(launchDecision({ paired: true, currentGame: 202 }, 101), 'confirm-quit');
  assert.equal(launchDecision({ paired: true, currentGame: 0 }, 101), 'launch');
});

test('ControllerMouseEmulation toggles on Start hold >= 650ms, ignores short tap, and maps stick/A/B/triggers/D-pad', () => {
  const emu = new ControllerMouseEmulation();
  const base = {
    buttons: 0,
    leftTrigger: 0,
    rightTrigger: 0,
    leftStickX: 0,
    leftStickY: 0,
    rightStickX: 0,
    rightStickY: 0,
  };

  // Short tap on Start (< 650ms) does not toggle
  let r = emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY }, 100);
  assert.equal(r.active, false);
  r = emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY }, 500);
  assert.equal(r.active, false);
  r = emu.update(0, base, 550);
  assert.equal(r.active, false);

  // Hold Start >= 650ms toggles ON and requests neutral controller packet
  emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY }, 1000);
  r = emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY }, 1660);
  assert.equal(r.toggled, true);
  assert.equal(r.active, true);
  assert.equal(r.sendNeutralController, true);
  emu.update(0, base, 1680);

  // Left stick right + up (leftStickY > 0 in Moonlight means UP -> negative screen dy)
  r = emu.update(0, { ...base, leftStickX: 32767, leftStickY: 32767 }, 1720);
  assert.ok(r.dx > 0 && r.dy < 0, `Expected dx>0, dy<0; got dx=${r.dx}, dy=${r.dy}`);

  // A presses left mouse button (1), RT also presses left (no duplicate), B presses right (3)
  r = emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.A | MOONLIGHT_BUTTONS.B }, 1740);
  assert.deepEqual(r.mouseButtons, [
    { action: 0x07, button: 1 },
    { action: 0x07, button: 3 },
  ]);

  // Holding RT keeps left pressed when A is released; releasing RT releases left
  r = emu.update(0, { ...base, rightTrigger: 200 }, 1760);
  assert.deepEqual(r.mouseButtons, [{ action: 0x08, button: 3 }]);
  r = emu.update(0, base, 1780);
  assert.deepEqual(r.mouseButtons, [{ action: 0x08, button: 1 }]);

  // LT presses right mouse button (3), D-pad up/down emits scroll clicks
  r = emu.update(0, { ...base, leftTrigger: 200, buttons: MOONLIGHT_BUTTONS.UP }, 1800);
  assert.deepEqual(r.mouseButtons, [{ action: 0x07, button: 3 }]);
  assert.equal(r.scrollClicks, 1);

  // Hold Start >= 650ms toggles OFF and releases held mouse buttons
  emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY, leftTrigger: 200 }, 2000);
  // Start hold requires no other buttons pressed; release LT first, then hold Start
  emu.update(0, base, 2020);
  emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY }, 2100);
  r = emu.update(0, { ...base, buttons: MOONLIGHT_BUTTONS.PLAY, leftTrigger: 0 }, 2760);
  assert.equal(r.toggled, true);
  assert.equal(r.active, false);
});

test('InputManager integrates Xbox Start-hold mouse mode and separates menu chord from Start hold', () => {
  const origWindow = globalThis.window;
  const origNavigator = globalThis.navigator;
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;

  const listeners = new Map();
  let rafCb = null;
  const pad = {
    id: 'Xbox Wireless Controller',
    mapping: 'standard',
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };

  try {
    globalThis.window = { addEventListener(type, fn) { listeners.set(type, fn); } };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { getGamepads: () => [pad] },
    });
    globalThis.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
    globalThis.cancelAnimationFrame = () => {};

    const moves = [];
    const mouseBtns = [];
    const packets = [];
    const modeChanges = [];
    let menuToggles = 0;

    const mgr = new InputManager({
      onNavigate: () => {},
      onBack: () => {},
      onStreamMenu: () => { menuToggles++; },
      onMouseMove: (dx, dy) => moves.push([dx, dy]),
      onMouseButton: (action, button) => mouseBtns.push({ action, button }),
      onControllerPacket: (idx, mask, st) => packets.push({ idx, mask, st }),
      onGamepadStatus: () => {},
      onMouseModeChange: (slot, active) => modeChanges.push({ slot, active }),
    });

    mgr.setStreaming(true);

    // Hold Start for 700ms -> activates Mouse Mode and sends neutral controller
    pad.buttons[9].pressed = true;
    rafCb(100);
    rafCb(800);
    assert.deepEqual(modeChanges, [{ slot: 0, active: true }]);
    assert.equal(packets[packets.length - 1].st.buttons, 0);

    // Deflect left stick right and press A -> emits mouseMove and mouseButton(0x07, 1), NOT controller packets
    const pktCountBefore = packets.length;
    pad.buttons[9].pressed = false;
    pad.axes[0] = 1.0;
    pad.buttons[0].pressed = true;
    rafCb(830);
    assert.equal(packets.length, pktCountBefore);
    assert.ok(moves.some(([dx]) => dx > 0));
    assert.deepEqual(mouseBtns, [{ action: 0x07, button: 1 }]);

    // LB+RB+Start+Back chord opens stream menu and releases held mouse button
    pad.buttons[4].pressed = true;
    pad.buttons[5].pressed = true;
    pad.buttons[8].pressed = true;
    pad.buttons[9].pressed = true;
    rafCb(850);
    assert.equal(menuToggles, 1);

    mgr.setMenuOpen(true);
    assert.deepEqual(mouseBtns[mouseBtns.length - 1], { action: 0x08, button: 1 });
    mgr.destroy();
  } finally {
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNavigator });
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
  }
});

test('migrateSettings enforces HDR10 vs Frame Warp mutual exclusion and hdr-direct status formats cleanly', () => {
  const bothOn = migrateSettings({ hdr: true, fwEnabled: true });
  assert.equal(bothOn.fwEnabled, true);
  assert.equal(bothOn.hdr, false);

  const hdrOnly = migrateSettings({ hdr: true });
  assert.equal(hdrOnly.hdr, true);
  assert.equal(hdrOnly.fwEnabled, false);

  const rows = buildOverlayRows({ fwState: 'hdr-direct', masksTotal: 2, maskCells: 512, tagsFps: 60 }, (k) => k);
  assert.equal(rows.find((r) => r.key === 'fw').value, 'ov.fw.hdr-direct');
  assert.match(rows.find((r) => r.key === 'fwTags').value, /ov\.mask 2 \(512\)/);
});



