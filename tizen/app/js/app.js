/**
 * Nightjar for Samsung Tizen OS 10 TV — Application Controller
 */

import { WarpRenderer } from './warp-renderer.js';
import { InputManager } from './input-manager.js';
import {
  detectWasmEngine,
  probeHostAsync,
  pairHostAsync,
  listAppsAsync,
  FrameWarpDemoSession,
  WasmStreamSession,
} from './wasm-bridge.js';

const STORAGE_HOSTS = 'nightjar.tizen.hosts.v1';
const STORAGE_SETTINGS = 'nightjar.tizen.settings.v1';

const DEFAULT_SETTINGS = {
  resolution: '3840x2160',
  fps: '120',
  codec: 'hevc',
  bitrate: '100',
  fwEnabled: true,
  fwLens: true,
  fwMaskWidth: '1024',
  overlay: true,
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadHosts() {
  try {
    const raw = localStorage.getItem(STORAGE_HOSTS);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [
    {
      id: 'demo-rubylight',
      name: 'Rubylight PC (Example)',
      address: '192.168.1.50',
      frameWarpVersion: 1,
      paired: false,
    },
  ];
}

class NightjarTizenApp {
  constructor() {
    this.hosts = loadHosts();
    this.settings = loadJson(STORAGE_SETTINGS, DEFAULT_SETTINGS);
    this.wasm = { available: false, runtime: null };
    this.activeTab = 'hosts';
    this.renderer = null;
    this.session = null;
    this.streamMenuOpen = false;
    this.focusedEl = null;

    this._bindElements();
    this._syncSettingsToDom();
    this._renderHosts();
    this._initInput();
    this._detectWasm();
    this._focusFirst();
  }

  _bindElements() {
    this.elLauncher = document.getElementById('launcher-view');
    this.elStream = document.getElementById('stream-view');
    this.elCanvas = document.getElementById('stream-canvas');
    this.elDemoCanvas = document.getElementById('demo-canvas');
    this.elHostsGrid = document.getElementById('hosts-grid');
    this.elWasmPill = document.getElementById('wasm-status-pill');
    this.elPadPill = document.getElementById('gamepad-status-pill');
    this.elAddModal = document.getElementById('add-host-modal');
    this.elDialogModal = document.getElementById('tv-dialog-modal');
    this.elStreamMenu = document.getElementById('stream-menu');
    this.elOverlay = document.getElementById('stream-overlay');

    // Tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // Buttons
    document.getElementById('btn-add-host').addEventListener('click', () => this.openAddHostModal());
    document.getElementById('btn-launch-demo').addEventListener('click', () => this.startDemoStream());
    document.getElementById('btn-lab-start').addEventListener('click', () => this.startDemoStream());
    document.getElementById('btn-modal-cancel').addEventListener('click', () => this.closeAddHostModal());
    document.getElementById('btn-modal-save').addEventListener('click', () => this.saveNewHost());

    // Stream menu buttons
    document.getElementById('btn-sm-toggle-fw').addEventListener('click', () => {
      this.settings.fwEnabled = !this.settings.fwEnabled;
      this._saveSettings();
      if (this.session) this.session.setFrameWarpEnabled(this.settings.fwEnabled);
      this._updateStreamMenuLabels();
    });
    document.getElementById('btn-sm-toggle-overlay').addEventListener('click', () => {
      this.settings.overlay = !this.settings.overlay;
      this._saveSettings();
      this.elOverlay.classList.toggle('hidden', !this.settings.overlay);
      this._updateStreamMenuLabels();
    });
    document.getElementById('btn-sm-resume').addEventListener('click', () => this.toggleStreamMenu(false));
    document.getElementById('btn-sm-disconnect').addEventListener('click', () => this.stopStream());

    // Pointer lock on canvas click for mouse testing
    this.elCanvas.addEventListener('click', () => {
      if (this.session && !this.streamMenuOpen && this.elCanvas.requestPointerLock) {
        this.elCanvas.requestPointerLock();
      }
    });

    // Settings inputs
    const bindSetting = (id, key, isCheckbox = false) => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => {
        this.settings[key] = isCheckbox ? el.checked : el.value;
        this._saveSettings();
      });
    };
    bindSetting('set-resolution', 'resolution');
    bindSetting('set-fps', 'fps');
    bindSetting('set-codec', 'codec');
    bindSetting('set-bitrate', 'bitrate');
    bindSetting('set-fw-enabled', 'fwEnabled', true);
    bindSetting('set-fw-lens', 'fwLens', true);
    bindSetting('set-fw-mask-width', 'fwMaskWidth');
    bindSetting('set-overlay', 'overlay', true);
  }

  _syncSettingsToDom() {
    document.getElementById('set-resolution').value = this.settings.resolution;
    document.getElementById('set-fps').value = this.settings.fps;
    document.getElementById('set-codec').value = this.settings.codec;
    document.getElementById('set-bitrate').value = this.settings.bitrate;
    document.getElementById('set-fw-enabled').checked = Boolean(this.settings.fwEnabled);
    document.getElementById('set-fw-lens').checked = Boolean(this.settings.fwLens);
    document.getElementById('set-fw-mask-width').value = String(this.settings.fwMaskWidth);
    document.getElementById('set-overlay').checked = Boolean(this.settings.overlay);
  }

  _saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(this.settings));
    } catch {
      // ignore
    }
  }

  _saveHosts() {
    try {
      localStorage.setItem(STORAGE_HOSTS, JSON.stringify(this.hosts));
    } catch {
      // ignore
    }
  }

  async _detectWasm() {
    this.wasm = await detectWasmEngine();
    if (this.wasm.available) {
      this.elWasmPill.textContent = 'WASM: Tizen Ready';
      this.elWasmPill.className = 'pill pill-ok';
    } else {
      this.elWasmPill.textContent = 'WASM: Demo Mode (Build tizen/wasm)';
      this.elWasmPill.className = 'pill pill-warn';
    }
  }

  _initInput() {
    this.input = new InputManager({
      onNavigate: (dir) => this._handleNavigation(dir),
      onBack: () => this._handleBack(),
      onStreamMenu: () => this.toggleStreamMenu(!this.streamMenuOpen),
      onMouseMove: (dx, dy) => {
        if (this.session && !this.streamMenuOpen) this.session.sendMouse(dx, dy);
      },
      onControllerPacket: (idx, state) => {
        if (this.session && !this.streamMenuOpen) this.session.sendController(idx, state);
      },
      onGamepadStatus: (pads) => {
        if (pads.length === 0) {
          this.elPadPill.textContent = 'Gamepad: None';
          this.elPadPill.className = 'pill';
        } else {
          this.elPadPill.textContent = `Gamepad: ${pads.length} connected`;
          this.elPadPill.className = 'pill pill-ok';
        }
      },
    });
  }

  _visibleFocusables() {
    let root = this.elLauncher;
    if (this.elDialogModal && !this.elDialogModal.classList.contains('hidden')) root = this.elDialogModal;
    else if (!this.elAddModal.classList.contains('hidden')) root = this.elAddModal;
    else if (!this.elStreamMenu.classList.contains('hidden')) root = this.elStreamMenu;
    return Array.from(root.querySelectorAll('.focusable')).filter(
      (el) => el.offsetParent !== null
    );
  }

  _setFocus(el) {
    if (!el) return;
    document.querySelectorAll('.focusable.focused').forEach((prev) => {
      if (prev !== el) prev.classList.remove('focused');
    });
    this.focusedEl = el;
    el.classList.add('focused');
    try {
      el.focus({ preventScroll: true });
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    } catch {
      el.focus();
    }
  }

  _focusFirst() {
    const items = this._visibleFocusables();
    if (items.length > 0) this._setFocus(items[0]);
  }

  _handleNavigation(dir) {
    const items = this._visibleFocusables();
    if (items.length === 0) return;
    let current = document.activeElement;
    if (!items.includes(current) && this.focusedEl && items.includes(this.focusedEl)) {
      current = this.focusedEl;
    }
    const idx = items.indexOf(current);

    if (dir === 'select') {
      const target = idx >= 0 ? items[idx] : items[0];
      this._setFocus(target);
      if (target.tagName === 'LABEL') {
        const inner = target.querySelector('input, select');
        if (inner && inner.type === 'checkbox') {
          inner.checked = !inner.checked;
          inner.dispatchEvent(new Event('change'));
        } else if (inner && inner.tagName === 'SELECT') {
          inner.selectedIndex = (inner.selectedIndex + 1) % inner.options.length;
          inner.dispatchEvent(new Event('change'));
        }
      } else {
        target.click();
      }
      return;
    }

    const delta = dir === 'right' || dir === 'down' ? 1 : -1;
    const next = idx < 0 ? 0 : (idx + delta + items.length) % items.length;
    this._setFocus(items[next]);
  }

  _handleBack() {
    if (this.elDialogModal && !this.elDialogModal.classList.contains('hidden')) {
      const cancelBtn = document.getElementById('btn-dialog-cancel');
      if (cancelBtn && !cancelBtn.classList.contains('hidden')) cancelBtn.click();
      else document.getElementById('btn-dialog-ok').click();
      return;
    }
    if (!this.elAddModal.classList.contains('hidden')) {
      this.closeAddHostModal();
      return;
    }
    if (this.activeTab !== 'hosts') {
      this.switchTab('hosts');
      return;
    }
    try {
      if (window.tizen && window.tizen.application) {
        window.tizen.application.getCurrentApplication().exit();
      }
    } catch {
      // ignore outside Tizen
    }
  }

  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tab}`);
    });
    this._focusFirst();
  }

  _renderHosts() {
    this.elHostsGrid.innerHTML = '';
    for (const host of this.hosts) {
      const card = document.createElement('button');
      card.className = 'host-card focusable';
      card.innerHTML = `
        <h4>${host.name}</h4>
        <div class="host-meta">${host.address}</div>
        <div class="host-tags">
          <span class="tag ${host.frameWarpVersion ? 'tag-fw' : ''}">
            ${host.frameWarpVersion ? `Frame Warp v${host.frameWarpVersion}` : 'Standard Moonlight'}
          </span>
          <span class="tag">${host.paired ? 'Paired' : 'Tap to connect / demo'}</span>
        </div>
      `;
      card.addEventListener('click', () => this.connectHost(host));
      this.elHostsGrid.appendChild(card);
    }
  }

  openAddHostModal() {
    this.elAddModal.classList.remove('hidden');
    document.getElementById('input-host-name').value = '';
    document.getElementById('input-host-ip').value = '';
    document.getElementById('input-host-ip').focus();
  }

  closeAddHostModal() {
    this.elAddModal.classList.add('hidden');
    this._focusFirst();
  }

  saveNewHost() {
    const ip = document.getElementById('input-host-ip').value.trim();
    const name = document.getElementById('input-host-name').value.trim() || ip;
    if (!ip) return;
    this.hosts.push({
      id: `host-${Date.now()}`,
      name,
      address: ip,
      frameWarpVersion: 1,
      paired: false,
    });
    this._saveHosts();
    this._renderHosts();
    this.closeAddHostModal();
  }

  showTvDialog(title, message, { confirm = false, okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      document.getElementById('tv-dialog-title').textContent = title;
      document.getElementById('tv-dialog-body').textContent = message;
      const okBtn = document.getElementById('btn-dialog-ok');
      const cancelBtn = document.getElementById('btn-dialog-cancel');
      okBtn.textContent = okText;
      cancelBtn.classList.toggle('hidden', !confirm);
      this.elDialogModal.classList.remove('hidden');

      const cleanup = (result) => {
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        this.elDialogModal.classList.add('hidden');
        this._focusFirst();
        resolve(result);
      };
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => cleanup(false);
      this._setFocus(okBtn);
    });
  }

  async connectHost(host) {
    // Built-in example card launches the interactive Frame Warp Live Test directly
    if (host.id === 'demo-rubylight') {
      this.startDemoStream();
      return;
    }

    if (this.wasm.available && this.wasm.runtime && typeof this.wasm.runtime.startAsyncJob === 'function') {
      try {
        const probe = await probeHostAsync(this.wasm.runtime, host.address);
        if (probe.error) {
          await this.showTvDialog('Connection Failed', `Could not reach ${host.address}: ${probe.error}`);
          return;
        }
        host.frameWarpVersion = probe.frameWarpVersion || 0;
        host.paired = Boolean(probe.paired);
        if (probe.hostname) host.name = probe.hostname;
        this._saveHosts();
        this._renderHosts();

        if (!host.paired) {
          const pin = String(Math.floor(1000 + Math.random() * 9000));
          const proceed = await this.showTvDialog(
            `Pair with ${host.name}`,
            `Enter PIN ${pin} in Rubylight / Sunshine on your PC, then select Pair.`,
            { confirm: true, okText: 'Pair' }
          );
          if (!proceed) return;

          const pairRes = await pairHostAsync(this.wasm.runtime, host.address, pin);
          if (!pairRes.ok) {
            await this.showTvDialog('Pairing Failed', pairRes.error || 'Host rejected pairing');
            return;
          }
          host.paired = true;
          this._saveHosts();
          this._renderHosts();
        }

        const appRes = await listAppsAsync(this.wasm.runtime, host.address);
        const appId = appRes.apps && appRes.apps.length > 0 ? appRes.apps[0].id : 0;

        this._enterStreamView(false);
        this.session = new WasmStreamSession(this.wasm.runtime, host, appId, this.settings);
        await this.session.start((stats) => this._updateOverlay(stats));
      } catch (err) {
        this.stopStream();
        await this.showTvDialog('Stream Error', err.message || String(err));
      }
    } else {
      await this.showTvDialog(
        'Updating Native Stream Engine',
        'Opening interactive Frame Warp Live Test while WASM pthread sockets module updates.'
      );
      this.startDemoStream();
    }
  }

  _enterStreamView(isDemo = false) {
    this.elLauncher.classList.remove('active');
    this.elStream.classList.add('active');
    this.elCanvas.style.display = isDemo ? 'none' : 'block';
    if (this.elDemoCanvas) this.elDemoCanvas.style.display = isDemo ? 'block' : 'none';
    this.elOverlay.classList.toggle('hidden', !this.settings.overlay);
    this.streamMenuOpen = false;
    this.elStreamMenu.classList.add('hidden');
    this.input.setStreaming(true);
    this._updateStreamMenuLabels();
  }

  startDemoStream() {
    this._enterStreamView(true);
    if (!this.renderer) {
      this.renderer = new WarpRenderer(this.elDemoCanvas || this.elCanvas);
    }
    this.session = new FrameWarpDemoSession(this.renderer, this.settings);
    this.session.start((stats) => this._updateOverlay(stats));
  }

  stopStream() {
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    if (document.pointerLockElement && document.exitPointerLock) {
      document.exitPointerLock();
    }
    this.streamMenuOpen = false;
    this.elStreamMenu.classList.add('hidden');
    this.input.setStreaming(false);
    this.elStream.classList.remove('active');
    this.elLauncher.classList.add('active');
    this._focusFirst();
  }

  toggleStreamMenu(open) {
    this.streamMenuOpen = open;
    this.elStreamMenu.classList.toggle('hidden', !open);
    if (open) {
      if (document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
      this._updateStreamMenuLabels();
      this._focusFirst();
    }
  }

  _updateStreamMenuLabels() {
    document.getElementById('btn-sm-toggle-fw').textContent =
      `Frame Warp: ${this.settings.fwEnabled ? 'ON' : 'OFF'}`;
    document.getElementById('btn-sm-toggle-overlay').textContent =
      `Overlay: ${this.settings.overlay ? 'ON' : 'OFF'}`;
  }

  _updateOverlay(s) {
    document.getElementById('ov-session').textContent = s.session;
    document.getElementById('ov-fw-state').textContent = !s.enabled
      ? 'Disabled'
      : s.locked
        ? 'LOCKED (Active)'
        : 'Learning…';
    document.getElementById('ov-fw-shift').textContent =
      `${s.pixels[0].toFixed(1)}, ${s.pixels[1].toFixed(1)} px (peak ${s.peak.toFixed(1)})`;
    const lensText = s.fov ? `FOV ${s.fov.toFixed(0)}°` : 'Flat';
    document.getElementById('ov-fw-lens').textContent = `${lensText} · ${s.maskCells} mask cells`;
    document.getElementById('ov-fw-frames').textContent =
      `${s.warped} warped · ${s.extrapolated} extrap · ${s.untagged} untagged`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.nightjarApp = new NightjarTizenApp();
});
