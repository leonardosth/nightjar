/**
 * Nightjar Tizen WASM Bridge + Rubylight Frame Warp Live Simulator
 *
 * When compiled with Samsung Emscripten SDK (tizen/wasm/), `window.NightjarWasm`
 * provides direct Tizen Sockets Extension (TCP/UDP/ENet/RTP) + Tizen WASM Player
 * (`ElementaryMediaStreamSource` with `LatencyMode::kUltraLow` and `RenderingMode::kVideoTexture`).
 *
 * When running without the compiled `.wasm` binary (e.g., UI testing or Frame Warp Lab),
 * `FrameWarpDemoSession` runs a realistic simulated Rubylight host with 45 ms end-to-end
 * lag emitting real binary 0x5544 Model, 0x5545 Tags, and 0x5546 LEB128 RLE HUD Mask packets
 * through the exact Frame Warp v1 predictor and WebGL 2.0 shader.
 */

import {
  FrameWarp,
  HudMask,
  encodeModel,
  encodeTags,
  fieldOfView,
} from './frame-warp.js';

const STORAGE_IDENTITY = 'nightjar.tizen.identity.v1';

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
    const mod = await window.NightjarWasmModule({
      canvas: document.getElementById('stream-canvas'),
    });

    // Initialize or restore persistent RSA-2048/X.509 client identity
    let stored = { uniqueId: '', certPem: '', keyPem: '' };
    try {
      const raw = localStorage.getItem(STORAGE_IDENTITY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      // ignore
    }
    const idJson = mod.initIdentity(stored.uniqueId || '', stored.certPem || '', stored.keyPem || '');
    try {
      localStorage.setItem(STORAGE_IDENTITY, idJson);
    } catch {
      // ignore
    }

    return { available: true, runtime: mod };
  } catch {
    return { available: false, runtime: null };
  }
}

export class WasmStreamSession {
  constructor(runtime, host, appId, settings) {
    this.runtime = runtime;
    this.host = host;
    this.appId = appId;
    this.settings = settings;
    this.enabled = Boolean(settings.fwEnabled);
    this._timer = null;
  }

  start(onStats) {
    const [w, h] = String(this.settings.resolution || '3840x2160').split('x').map(Number);
    const ok = this.runtime.startStream(
      this.host.address,
      this.appId || 0,
      false,
      w || 3840,
      h || 2160,
      Number(this.settings.fps) || 120,
      this.settings.codec || 'hevc',
      Number(this.settings.bitrate) || 100,
      this.enabled,
      Boolean(this.settings.fwLens),
      Number(this.settings.fwMaskWidth) || 1024
    );
    if (!ok) {
      throw new Error(this.runtime.lastError ? this.runtime.lastError() : 'Failed to start WASM stream');
    }

    this._timer = setInterval(() => {
      if (!onStats || !this.runtime.getFrameWarpStatus) return;
      try {
        const st = JSON.parse(this.runtime.getFrameWarpStatus());
        onStats({
          session: `${this.host.name} (${this.settings.resolution}@${this.settings.fps} ${this.settings.codec.toUpperCase()})`,
          enabled: this.enabled && Boolean(st.negotiated),
          locked: Boolean(st.locked),
          pixels: [st.pxX || 0, st.pxY || 0],
          peak: st.peak || 0,
          fov: st.fov > 0 ? st.fov : null,
          maskCells: st.maskCells || 0,
          warped: st.warped || 0,
          extrapolated: st.extrapolated || 0,
          untagged: st.untagged || 0,
        });
      } catch {
        // ignore
      }
    }, 100);
  }

  setFrameWarpEnabled(enabled) {
    this.enabled = enabled;
    if (this.runtime.setFrameWarpEnabled) this.runtime.setFrameWarpEnabled(enabled);
  }

  sendMouse(dx, dy) {
    if (this.runtime.sendMouse) this.runtime.sendMouse(dx, dy);
  }

  sendController(index, state) {
    if (this.runtime.sendController) {
      this.runtime.sendController(
        index,
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

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.runtime.stopStream) this.runtime.stopStream();
  }
}

/**
 * Interactive Rubylight Frame Warp v1 Simulator:
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

    // Offscreen 2D canvas acts as the "host-rendered video frame"
    this.hostCanvas = document.createElement('canvas');
    this.hostCanvas.width = this.width;
    this.hostCanvas.height = this.height;
    this.hostCtx = this.hostCanvas.getContext('2d');

    this.frameWarp = new FrameWarp(0, Number(settings.fwMaskWidth) || 1024);
    this.enabled = Boolean(settings.fwEnabled);
    this.lensEnabled = Boolean(settings.fwLens);

    // Simulated host state (45 ms round-trip + game lag)
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
    // 1. Client sends 0x5543 FrameWarpRequest
    this.frameWarp.request(this.enabled, this.lensEnabled);

    // 2. Host replies with 0x5544 Model (52 bytes with 90° horizontal FOV focal length)
    const focal = this.lensEnabled ? this.width / 2 : 0.0; // tan(45°) = 1.0 -> focal = width/2
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

    // 3. Host sends 0x5546 LEB128 RLE HUD Mask (240x135 grid covering crosshair, health bar, minimap)
    const mw = 240;
    const mh = 135;
    const mask = new HudMask(1, mw, mh);
    // Center crosshair
    mask.fillRect(114, 62, 12, 11, true);
    // Bottom-left health bar
    mask.fillRect(8, 112, 62, 15, true);
    // Top-right minimap
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
    // Wire-count immediately (just like nightjar-core InputQueue::emit)
    this.frameWarp.noteMouse(dx, dy);
    this.pendingMouse.push({
      deliverAt: performance.now() + this.simLagMs,
      dx,
      dy,
    });
  }

  sendController(index, state) {
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
    // Apply stick turn at host
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

    // Sky + ground gradient shifted by host camera yaw/pitch
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

    // World vertical pillars & grid lines (clearly reveal camera shift + lens warp)
    const spacing = 160;
    const offsetX = ((-this.hostYaw) % spacing + spacing) % spacing;
    ctx.strokeStyle = 'rgba(232, 163, 61, 0.35)';
    ctx.lineWidth = 2;
    for (let x = offsetX; x < w; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // Pillar marker on horizon
      ctx.fillStyle = 'rgba(232, 163, 61, 0.22)';
      ctx.fillRect(x - 18, horizon - 110, 36, 110);
    }

    // Horizontal reference lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    for (let y = horizon % 120; y < h; y += 120) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Horizon line
    ctx.strokeStyle = '#e8a33d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    ctx.lineTo(w, horizon);
    ctx.stroke();

    // --- Static HUD elements (protected by 0x5546 HUD Mask!) ---
    // 1. Center crosshair
    ctx.strokeStyle = '#4cd98b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 22, h / 2); ctx.lineTo(w / 2 - 6, h / 2);
    ctx.moveTo(w / 2 + 6, h / 2);  ctx.lineTo(w / 2 + 22, h / 2);
    ctx.moveTo(w / 2, h / 2 - 22); ctx.lineTo(w / 2, h / 2 - 6);
    ctx.moveTo(w / 2, h / 2 + 6);  ctx.lineTo(w / 2, h / 2 + 22);
    ctx.stroke();

    // 2. Bottom-left health bar
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

    // 3. Top-right minimap
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

      // Host produces 60 fps frames (every 16.67 ms); TV displays at 60/120 Hz with inter-frame redraws!
      if (dtMs >= 16.6) {
        this._stepHost(now, dtMs / 1000);
        this.lastHostFrameMs = now;
        this.frameNumber++;

        // Emit real binary 0x5545 Tags (carrying newest + up to 3 previous frames)
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
        // Inter-frame redraw between host frames!
        this.renderer.maybeRedrawBetweenFrames(this.frameWarp);
      }

      if (onStats) {
        const st = this.frameWarp.status();
        onStats({
          session: `Frame Warp Lab (60 fps host · ${this.simLagMs} ms lag)`,
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

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}
