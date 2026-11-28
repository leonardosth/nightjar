/**
 * Nightjar Tizen WASM Bridge + Offline Frame Warp Simulator
 *
 * When compiled with Samsung Emscripten SDK (tizen/wasm/), `window.NightjarWasmModule`
 * provides direct Tizen Sockets Extension (TCP/UDP/ENet/RTP) + Tizen WASM Player
 * (`ElementaryMediaStreamSource` with `LatencyMode::kUltraLow`, dual `kVideoTexture`/`kMediaElement`).
 */

import {
  FrameWarp,
  HudMask,
  encodeModel,
  encodeTags,
  fieldOfView,
} from './frame-warp.js';

const STORAGE_IDENTITY = 'nightjar.tizen.identity.v1';

export function generatePairingPin() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(arr[0] % 10000).padStart(4, '0');
  }
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

export async function runWasmJobAsync(
  runtime,
  op,
  arg1 = '',
  arg2 = '',
  arg3 = '',
  { timeoutMs = 15000, signal = null } = {}
) {
  if (!runtime || typeof runtime.startAsyncJob !== 'function' || typeof runtime.pollAsyncJob !== 'function') {
    throw new Error('WASM runtime requires pthread async job support (rebuild tizen/wasm)');
  }
  const jobId = runtime.startAsyncJob(op, String(arg1), String(arg2), String(arg3));
  const startedAt = Date.now();
  while (true) {
    if (signal && signal.aborted) {
      throw new Error('Cancelled');
    }
    const raw = runtime.pollAsyncJob(jobId);
    const parsed = JSON.parse(raw);
    if (parsed.done) {
      return parsed.payload;
    }
    if (timeoutMs > 0 && (Date.now() - startedAt) > timeoutMs) {
      throw new Error(`Operation "${op}" timed out`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function detectWasmEngine() {
  try {
    const resp = await fetch('wasm/nightjar_tizen.js', { method: 'HEAD' });
    if (!resp.ok) return { available: false, runtime: null };

    await new Promise((resolve, reject) => {
      if (window.NightjarWasmModule) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'wasm/nightjar_tizen.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

    if (typeof window.NightjarWasmModule !== 'function') {
      return { available: false, runtime: null };
    }

    // Samsung Emscripten 1.39.4.7 attaches a persistent Module["then"] that returns Module
    // without deleting Module["then"] first. Directly `await`-ing NightjarWasmModule(...)
    // triggers an infinite ECMAScript Thenable microtask loop that freezes Tizen's main thread.
    const mod = await new Promise((resolve, reject) => {
      let settled = false;
      let instance = null;
      const finish = (m) => {
        if (settled) return;
        settled = true;
        if (m && typeof m === 'object' && 'then' in m) {
          delete m.then;
        }
        resolve(m);
      };
      try {
        instance = window.NightjarWasmModule({
          canvas: document.getElementById('stream-canvas'),
          locateFile: (path) => `wasm/${path}`,
          onRuntimeInitialized() {
            Promise.resolve().then(() => finish(instance));
          },
          onAbort(reason) {
            if (!settled) {
              settled = true;
              reject(new Error(`WASM aborted: ${reason}`));
            }
          },
        });
        if (instance && typeof instance === 'object') {
          if ('then' in instance) {
            delete instance.then;
          }
          if (instance.calledRun) {
            finish(instance);
          }
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });

    // Initialize or restore persistent RSA-2048/X.509 client identity off the main thread
    let stored = { uniqueId: '', certPem: '', keyPem: '' };
    try {
      const raw = localStorage.getItem(STORAGE_IDENTITY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      // ignore
    }

    let idPayload = null;
    if (typeof mod.startAsyncJob === 'function' && typeof mod.pollAsyncJob === 'function') {
      idPayload = await runWasmJobAsync(
        mod,
        'init_identity',
        stored.uniqueId || '',
        stored.certPem || '',
        stored.keyPem || '',
        { timeoutMs: 30000 }
      );
    } else if (typeof mod.initIdentity === 'function') {
      idPayload = JSON.parse(mod.initIdentity(stored.uniqueId || '', stored.certPem || '', stored.keyPem || ''));
    }

    if (idPayload && idPayload.uniqueId) {
      try {
        localStorage.setItem(STORAGE_IDENTITY, JSON.stringify(idPayload));
      } catch {
        // ignore
      }
    }

    return { available: true, runtime: mod };
  } catch (err) {
    console.warn('[Nightjar] detectWasmEngine fallback:', err);
    return { available: false, runtime: null };
  }
}

export async function probeHostAsync(runtime, address) {
  return runWasmJobAsync(runtime, 'probe', address, '', '', { timeoutMs: 12000 });
}

export async function pairHostAsync(runtime, address, pin, { signal = null } = {}) {
  return runWasmJobAsync(runtime, 'pair', address, pin, '', { timeoutMs: 185000, signal });
}

export async function cancelPairingAsync(runtime) {
  if (!runtime || typeof runtime.startAsyncJob !== 'function') return;
  await runWasmJobAsync(runtime, 'cancel_pair', '', '', '', { timeoutMs: 5000 });
}

export async function listAppsAsync(runtime, address) {
  return runWasmJobAsync(runtime, 'applist', address, '', '', { timeoutMs: 15000 });
}

export async function cancelHostAppAsync(runtime, address) {
  return runWasmJobAsync(runtime, 'cancel_app', address, '', '', { timeoutMs: 10000 });
}

export class WasmStreamSession {
  constructor(runtime, host, appId, settings, { resume = false } = {}) {
    this.runtime = runtime;
    this.host = host;
    this.appId = appId;
    this.resume = resume;
    this.settings = settings;
    this.enabled = settings.fwEnabled !== false;
    this.useVideoTexture = Boolean(
      this.enabled && (host.frameWarpVersion || 0) >= 1 && !settings.hdr
    );
    this._timer = null;
    this._stopped = false;
  }

  async start(onStats, { onTerminated = null, onConnStatus = null } = {}) {
    const [w, h] = String(this.settings.resolution || '3840x2160').split('x').map(Number);
    const width = w || 3840;
    const height = h || 2160;

    // Resize WebGL drawing buffer to match stream resolution in Frame Warp mode,
    // or show the hardware <video> sink for direct scanout / HDR10.
    const canvas = typeof document !== 'undefined' ? document.getElementById('stream-canvas') : null;
    const video = typeof document !== 'undefined' ? document.getElementById('tizen-video-sink') : null;
    if (canvas) {
      if (this.useVideoTexture) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.display = 'block';
      } else {
        canvas.style.display = 'none';
      }
    }
    if (video) {
      video.className = this.useVideoTexture ? 'video-sink-hidden' : 'video-sink-direct';
    }

    let pollTick = 0;
    let prevPbq = null;
    const pollOverlay = () => {
      if (this._stopped) return;
      if (typeof this.runtime.pollSessionEvents === 'function') {
        try {
          const events = JSON.parse(this.runtime.pollSessionEvents());
          for (const ev of events) {
            if (ev.type === 'terminated') {
              clearInterval(this._timer);
              this._timer = null;
              onTerminated?.(ev.code);
              return;
            }
            if (ev.type === 'conn_status') {
              onConnStatus?.(ev.code);
            }
          }
        } catch {
          // ignore
        }
      }

      const shouldPollStats = (pollTick % 5) === 0;
      pollTick++;
      if (!shouldPollStats || !onStats || !this.runtime.getFrameWarpStatus) return;
      try {
        const st = JSON.parse(this.runtime.getFrameWarpStatus());
        let playbackQuality = null;
        let renderedFps = st.renderedFps || 0;
        if (st.directScanout && video && typeof video.getVideoPlaybackQuality === 'function') {
          try {
            const q = video.getVideoPlaybackQuality();
            if (q && typeof q.totalVideoFrames === 'number') {
              playbackQuality = {
                totalVideoFrames: q.totalVideoFrames,
                droppedVideoFrames: q.droppedVideoFrames || 0,
              };
              const nowMs = Date.now();
              if (
                prevPbq &&
                nowMs > prevPbq.atMs &&
                playbackQuality.totalVideoFrames >= prevPbq.total
              ) {
                const dtSec = (nowMs - prevPbq.atMs) / 1000;
                const totDelta = playbackQuality.totalVideoFrames - prevPbq.total;
                const dropDelta = Math.max(
                  0,
                  playbackQuality.droppedVideoFrames - prevPbq.dropped
                );
                renderedFps = Math.max(0, Math.round((totDelta - dropDelta) / dtSec));
              }
              prevPbq = {
                atMs: nowMs,
                total: playbackQuality.totalVideoFrames,
                dropped: playbackQuality.droppedVideoFrames,
              };
            }
          } catch {
            // ignore
          }
        }
        onStats({
          session: `${this.host.name} (${this.settings.resolution}@${this.settings.fps} ${this.settings.codec.toUpperCase()}${st.hdrActive ? ' HDR' : ''})`,
          rxFps: st.rxFps || 0,
          decodedFps: st.decodedFps || 0,
          renderedFps,
          directScanout: Boolean(st.directScanout),
          enabled: this.enabled && Boolean(st.negotiated),
          locked: Boolean(st.locked),
          pixels: [st.pxX || 0, st.pxY || 0],
          peak: st.peak || 0,
          fov: st.fov > 0 ? st.fov : null,
          maskCells: st.maskCells || 0,
          warped: st.warped || 0,
          extrapolated: st.extrapolated || 0,
          untagged: st.untagged || 0,
          stage: st.stage || '—',
          diag: st.diag || '—',
          playbackQuality,
          raw: { ...st, renderedFps },
        });
      } catch {
        // ignore
      }
    };

    if (typeof this.runtime.prepareStreamMedia === 'function' && typeof this.runtime.startAsyncJob === 'function') {
      const prepOk = this.runtime.prepareStreamMedia(
        this.host.address,
        this.appId || 0,
        Boolean(this.resume),
        width,
        height,
        Number(this.settings.fps) || 60,
        this.settings.codec || 'hevc',
        Number(this.settings.bitrate) || 100,
        Boolean(this.settings.hdr),
        Boolean(this.settings.surround51),
        this.enabled,
        this.useVideoTexture
      );
      if (!prepOk) {
        throw new Error(this.runtime.lastError ? this.runtime.lastError() : 'Failed to initialize TV WebGL / video decoder');
      }
      // Start overlay polling BEFORE connect_stream so live RTSP/EMSS stages show immediately
      this._timer = setInterval(pollOverlay, 100);
      pollOverlay();

      const conn = await runWasmJobAsync(
        this.runtime,
        'connect_stream',
        this.host.address,
        String(this.appId || 0),
        '',
        { timeoutMs: 30000 }
      );
      if (!conn || !conn.ok) {
        throw new Error((conn && conn.error) || 'Failed to connect stream');
      }
      if (this._stopped) {
        return;
      }
      if (typeof this.runtime.startStreamLoop === 'function') {
        this.runtime.startStreamLoop();
      }
    } else {
      throw new Error('WASM pthread streaming bridge needs updated WASM build');
    }
  }

  setFrameWarpEnabled(enabled) {
    this.enabled = enabled;
    if (this.runtime.setFrameWarpEnabled) this.runtime.setFrameWarpEnabled(enabled);
  }

  sendMouse(dx, dy) {
    if (this.runtime.sendMouse) this.runtime.sendMouse(dx, dy);
  }

  sendMouseButton(action, button) {
    if (this.runtime.sendMouseButton) this.runtime.sendMouseButton(action, button);
  }

  sendMouseWheel(clicks) {
    if (this.runtime.sendMouseWheel) this.runtime.sendMouseWheel(clicks);
  }

  sendKey(keyCode, action, modifiers) {
    if (this.runtime.sendKey) this.runtime.sendKey(keyCode, action, modifiers);
  }

  sendControllerArrival(index, activeMask) {
    if (this.runtime.sendControllerArrival) {
      this.runtime.sendControllerArrival(index & 0xff, activeMask & 0xffff);
    }
  }

  sendController(index, activeMask, state) {
    if (this.runtime.sendController) {
      this.runtime.sendController(
        index & 0xffff,
        activeMask & 0xffff,
        state.buttons | 0,
        state.leftTrigger & 0xff,
        state.rightTrigger & 0xff,
        state.leftStickX | 0,
        state.leftStickY | 0,
        state.rightStickX | 0,
        state.rightStickY | 0
      );
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;

    // Await LiStopConnection() on the worker thread BEFORE tearing down EMSS/WebGL on the main thread
    if (typeof this.runtime.startAsyncJob === 'function' && typeof this.runtime.pollAsyncJob === 'function') {
      try {
        await runWasmJobAsync(this.runtime, 'stop_stream', '', '', '', { timeoutMs: 8000 });
      } catch {
        // ignore
      }
    } else if (typeof this.runtime.stopStream === 'function') {
      this.runtime.stopStream();
    }

    if (typeof this.runtime.shutdownMedia === 'function') {
      this.runtime.shutdownMedia();
    }

    const video = typeof document !== 'undefined' ? document.getElementById('tizen-video-sink') : null;
    if (video) video.className = 'video-sink-hidden';
  }
}

/**
 * Interactive Offline Frame Warp v1 Simulator:
 * Renders a 3D-like horizon + grid world at 60 fps with 45 ms simulated round-trip+game lag,
 * draws a static FPS HUD (crosshair, health bar, minimap), emits real binary 0x5544/0x5545/0x5546
 * packets, and feeds frames into `WarpRenderer` so Frame Warp can be visually verified on TV or desktop.
 */
export class FrameWarpDemoSession {
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.width = 1920;
    this.height = 1080;

    this.hostCanvas = document.createElement('canvas');
    this.hostCanvas.width = this.width;
    this.hostCanvas.height = this.height;
    this.hostCtx = this.hostCanvas.getContext('2d');

    this.frameWarp = new FrameWarp(0, 1024);
    this.enabled = Boolean(settings.fwEnabled);
    this.lensEnabled = true;

    this.simLagMs = 45;
    this.frameNumber = 0;
    this.hostYaw = 0;
    this.hostPitch = 0;
    this.hostMouseX = 0;
    this.hostMouseY = 0;
    this.hostCtrlSeq = 0;
    this.pendingMouse = [];
    this.pendingStick = [];
    this.currentHostStick = [0, 0];
    this.lastHostFrameMs = 0;
    this.recentTags = [];
    this.running = false;
    this._raf = null;

    this._initProtocol();
  }

  _initProtocol() {
    this.frameWarp.request(this.enabled, this.lensEnabled);
    const focal = this.width / 2;
    const modelBytes = encodeModel({
      generation: 1,
      mouseLocked: true,
      stickLocked: true,
      pictureWidth: this.width,
      pictureHeight: this.height,
      mouseGain: [-1.8, -1.8],
      stickGain: [-920.0, 680.0],
      stickDeadzone: 0.08,
      stickExponent: 2.0,
      maxOffset: [320.0, 200.0],
      lagUs: this.simLagMs * 1000,
      confidence: 0.98,
      focal,
    });
    this.frameWarp.onModelBytes(modelBytes);

    const mw = 240;
    const mh = 135;
    const mask = new HudMask(1, mw, mh);
    mask.fillRect(114, 62, 12, 11, true);
    mask.fillRect(8, 112, 62, 15, true);
    mask.fillRect(194, 8, 38, 34, true);
    const maskBytes = mask.encode();
    if (maskBytes) {
      this.frameWarp.onMaskBytes(maskBytes);
    }
  }

  setFrameWarpEnabled(enabled) {
    this.enabled = enabled;
    this.frameWarp.request(enabled, this.lensEnabled);
    if (enabled) {
      this._initProtocol();
    }
  }

  sendMouse(dx, dy) {
    this.frameWarp.noteMouse(dx, dy);
    this.pendingMouse.push({
      deliverAt: performance.now() + this.simLagMs,
      dx,
      dy,
    });
  }

  sendController(index, _activeMask, state) {
    this.frameWarp.noteController(index, state.rightStickX, state.rightStickY);
    if (index === 0) {
      this.pendingStick.push({
        deliverAt: performance.now() + this.simLagMs,
        seq: this.frameWarp.predictor.controllerSeq,
        rx: state.rightStickX,
        ry: state.rightStickY,
      });
    }
  }

  _stepHost(now, dtSec) {
    while (this.pendingMouse.length > 0 && this.pendingMouse[0].deliverAt <= now) {
      const ev = this.pendingMouse.shift();
      this.hostMouseX = (this.hostMouseX + ev.dx) | 0;
      this.hostMouseY = (this.hostMouseY + ev.dy) | 0;
      this.hostYaw += ev.dx * 1.8;
      this.hostPitch = Math.max(-400, Math.min(400, this.hostPitch + ev.dy * 1.8));
    }
    while (this.pendingStick.length > 0 && this.pendingStick[0].deliverAt <= now) {
      const ev = this.pendingStick.shift();
      this.hostCtrlSeq = ev.seq;
      this.currentHostStick = [ev.rx, ev.ry];
    }
    const vx = this.currentHostStick[0] / 32767;
    const vy = this.currentHostStick[1] / 32767;
    const r = Math.hypot(vx, vy);
    if (r > 0.08) {
      const s = Math.min((r - 0.08) / 0.92, 1.0);
      const scale = s * s;
      this.hostYaw += (vx / r) * scale * 920 * dtSec;
      this.hostPitch = Math.max(-400, Math.min(400, this.hostPitch - (vy / r) * scale * 680 * dtSec));
    }
  }

  _renderHostFrame() {
    const ctx = this.hostCtx;
    const w = this.width;
    const h = this.height;

    const horizon = h * 0.5 - this.hostPitch;
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
    sky.addColorStop(0, '#0b1628');
    sky.addColorStop(1, '#26466d');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, Math.max(0, horizon));

    const ground = ctx.createLinearGradient(0, horizon, 0, h);
    ground.addColorStop(0, '#1c2430');
    ground.addColorStop(1, '#0b0e14');
    ctx.fillStyle = ground;
    ctx.fillRect(0, Math.max(0, horizon), w, h - Math.max(0, horizon));

    const spacing = 160;
    const offsetX = ((-this.hostYaw) % spacing + spacing) % spacing;
    ctx.strokeStyle = 'rgba(232, 163, 61, 0.35)';
    ctx.lineWidth = 2;
    for (let x = offsetX; x < w; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      ctx.fillStyle = 'rgba(232, 163, 61, 0.22)';
      ctx.fillRect(x - 18, horizon - 110, 36, 110);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    for (let y = horizon % 120; y < h; y += 120) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();

    ctx.strokeStyle = '#4cd98b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 22, h / 2); ctx.lineTo(w / 2 - 6, h / 2);
    ctx.moveTo(w / 2 + 6, h / 2); ctx.lineTo(w / 2 + 22, h / 2);
    ctx.moveTo(w / 2, h / 2 - 22); ctx.lineTo(w / 2, h / 2 - 6);
    ctx.moveTo(w / 2, h / 2 + 6); ctx.lineTo(w / 2, h / 2 + 22);
    ctx.stroke();

    ctx.fillStyle = 'rgba(12, 14, 20, 0.85)';
    ctx.fillRect(72, 905, 480, 108);
    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 2;
    ctx.strokeRect(72, 905, 480, 108);
    ctx.fillStyle = '#4cd98b';
    ctx.fillRect(96, 958, 360, 26);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('HUD LOCKED — HP 84 / 100', 96, 942);

    ctx.fillStyle = 'rgba(12, 14, 20, 0.85)';
    ctx.fillRect(1560, 72, 288, 256);
    ctx.strokeStyle = '#e8a33d';
    ctx.strokeRect(1560, 72, 288, 256);
    ctx.fillStyle = '#e8a33d';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('MINIMAP (MASKED)', 1582, 106);
    ctx.fillStyle = '#4cd98b';
    ctx.beginPath();
    ctx.arc(1704, 208, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  start(onStats) {
    this.running = true;
    this.lastHostFrameMs = performance.now();
    this.renderer.resize(this.width, this.height);

    const tick = (now) => {
      if (!this.running) return;
      const dtMs = now - this.lastHostFrameMs;

      if (dtMs >= 16.6) {
        this._stepHost(now, dtMs / 1000);
        this.lastHostFrameMs = now;
        this.frameNumber++;

        const tag = {
          frame: this.frameNumber,
          mouseX: this.hostMouseX,
          mouseY: this.hostMouseY,
          controllerSeq: this.hostCtrlSeq,
          controllerHeldUs: this.hostCtrlSeq > 0 ? 4000 : 0xffffffff,
        };
        this.recentTags.push(tag);
        if (this.recentTags.length > 4) this.recentTags.shift();
        const tagBytes = encodeTags({ modelGeneration: 1, tags: this.recentTags });
        if (tagBytes) {
          this.frameWarp.onTagsBytes(tagBytes);
        }

        this._renderHostFrame();
        this.renderer.uploadVideoSource(this.hostCanvas);
        this.renderer.syncHudMask(this.frameWarp);
        const warp = this.enabled ? this.frameWarp.warp(this.frameNumber) : null;
        this.renderer.draw(warp, this.frameNumber, this.frameWarp.inputSeq);
      } else if (this.enabled) {
        this.renderer.maybeRedrawBetweenFrames(this.frameWarp);
      }

      if (onStats) {
        const st = this.frameWarp.status();
        onStats({
          session: `Frame Warp Lab (60 fps · ${this.simLagMs} ms lag)`,
          rxFps: 60,
          decodedFps: 60,
          renderedFps: 120,
          directScanout: false,
          enabled: this.enabled,
          locked: Boolean(st.model && (st.model.mouseLocked || st.model.stickLocked)),
          pixels: st.pixels,
          peak: st.peak,
          fov: fieldOfView(st.model),
          maskCells: st.maskCells,
          warped: st.warped,
          extrapolated: st.extrapolated,
          untagged: st.untagged,
        });
      }

      this._raf = requestAnimationFrame(tick);
    };

    this._raf = requestAnimationFrame(tick);
  }

  async stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
