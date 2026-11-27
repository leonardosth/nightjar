/**
 * Nightjar for Samsung Tizen OS 10 TV — Application Controller
 */

import { WarpRenderer } from './warp-renderer.js';
import { InputManager } from './input-manager.js';
import { pickSpatialFocus } from './gamepad-mapping.js';
import { resolveLocale, tr, migrateSettings } from './i18n.js';
import {
  detectWasmEngine,
  probeHostAsync,
  pairHostAsync,
  cancelPairingAsync,
  listAppsAsync,
  cancelHostAppAsync,
  generatePairingPin,
  FrameWarpDemoSession,
  WasmStreamSession,
} from './wasm-bridge.js';

const STORAGE_HOSTS = 'nightjar.tizen.hosts.v1';
const STORAGE_SETTINGS = 'nightjar.tizen.settings.v1';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    const parsed = raw ? JSON.parse(raw) : {};
    const migrated = migrateSettings(parsed);
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(migrated));
    return migrated;
  } catch {
    return migrateSettings({});
  }
}

function loadHosts() {
  try {
    const raw = localStorage.getItem(STORAGE_HOSTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((h) => h && h.id !== 'demo-rubylight');
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function setScreenSaverEnabled(enabled) {
  try {
    if (typeof window !== 'undefined' && window.webapis && window.webapis.appcommon) {
      const state = enabled
        ? window.webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
        : window.webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF;
      window.webapis.appcommon.setScreenSaver(state, () => { }, () => { });
    }
  } catch {
    // Running outside Tizen TV runtime
  }
}

class NightjarTizenApp {
  constructor() {
    this.locale = resolveLocale(typeof navigator !== 'undefined' ? navigator.language : 'en');
    this.hosts = loadHosts();
    this.settings = loadSettings();
    this.wasm = { available: false, runtime: null };
    this.activeTab = 'hosts';
    this.renderer = null;
    this.session = null;
    this.streamMenuOpen = false;
    this.focusedEl = null;
    this._selectedHostForApps = null;
    this._runningAppId = 0;

    this._bindElements();
    this._applyLocale();
    this._syncSettingsToDom();
    this._renderHosts();
    this._initInput();
    this._bindLifecycle();
    this._detectWasm();
    this._focusFirst();
  }

  t(key, vars = {}) {
    return tr(this.locale, key, vars);
  }

  _applyLocale() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = this.t(el.dataset.i18n);
    });
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
    this.elAppsModal = document.getElementById('app-list-modal');
    this.elAppsGrid = document.getElementById('apps-grid');
    this.elDialogModal = document.getElementById('tv-dialog-modal');
    this.elStreamMenu = document.getElementById('stream-menu');
    this.elOverlay = document.getElementById('stream-overlay');

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.getElementById('btn-add-host').addEventListener('click', () => this.openAddHostModal());
    document.getElementById('btn-launch-demo').addEventListener('click', () => this.startDemoStream());
    document.getElementById('btn-lab-start').addEventListener('click', () => this.startDemoStream());
    document.getElementById('btn-modal-cancel').addEventListener('click', () => this.closeAddHostModal());
    document.getElementById('btn-modal-save').addEventListener('click', () => this.saveNewHost());
    document.getElementById('btn-apps-close').addEventListener('click', () => this.closeAppsModal());

    document.getElementById('btn-resume-running').addEventListener('click', () => {
      if (this._selectedHostForApps && this._runningAppId) {
        const host = this._selectedHostForApps;
        const appId = this._runningAppId;
        this.closeAppsModal();
        this._launchStream(host, appId, true);
      }
    });

    document.getElementById('btn-quit-running').addEventListener('click', async () => {
      if (!this._selectedHostForApps || !this.wasm.available) return;
      await cancelHostAppAsync(this.wasm.runtime, this._selectedHostForApps.address);
      this._runningAppId = 0;
      document.getElementById('btn-resume-running').classList.add('hidden');
      document.getElementById('btn-quit-running').classList.add('hidden');
    });

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

    this.elCanvas.addEventListener('click', () => {
      if (this.session && !this.streamMenuOpen && this.elCanvas.requestPointerLock) {
        this.elCanvas.requestPointerLock();
      }
    });

    const bindSetting = (id, key, isCheckbox = false) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        this.settings[key] = isCheckbox ? el.checked : el.value;
        this._saveSettings();
      });
    };
    bindSetting('set-resolution', 'resolution');
    bindSetting('set-fps', 'fps');
    bindSetting('set-codec', 'codec');
    bindSetting('set-bitrate', 'bitrate');
    bindSetting('set-hdr', 'hdr', true);
    bindSetting('set-surround51', 'surround51', true);
    bindSetting('set-fw-enabled', 'fwEnabled', true);
    bindSetting('set-overlay', 'overlay', true);
  }

  _bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.session) {
        this.stopStream();
      }
    });
  }

  _syncSettingsToDom() {
    document.getElementById('set-resolution').value = this.settings.resolution;
    document.getElementById('set-fps').value = this.settings.fps;
    document.getElementById('set-codec').value = this.settings.codec;
    document.getElementById('set-bitrate').value = this.settings.bitrate;
    document.getElementById('set-hdr').checked = Boolean(this.settings.hdr);
    document.getElementById('set-surround51').checked = Boolean(this.settings.surround51);
    document.getElementById('set-fw-enabled').checked = Boolean(this.settings.fwEnabled);
    document.getElementById('set-overlay').checked = Boolean(this.settings.overlay);
  }

  _saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(migrateSettings(this.settings)));
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
      this.elWasmPill.textContent = this.t('pill.wasmReady');
      this.elWasmPill.className = 'pill pill-ok';
      // Restore pinned server certificates into WASM client
      if (typeof this.wasm.runtime.setPinnedCert === 'function') {
        for (const h of this.hosts) {
          if (h.serverCertPem) {
            this.wasm.runtime.setPinnedCert(h.address, h.serverCertPem);
          }
        }
      }
    } else {
      this.elWasmPill.textContent = this.t('pill.wasmMissing');
      this.elWasmPill.className = 'pill pill-warn';
    }
  }

  _initInput() {
    this.input = new InputManager({
      onNavigate: (dir) => this._handleNavigation(dir),
      onBack: () => this._handleBack(),
      onDelete: () => this._removeFocusedHost(),
      onStreamMenu: () => this.toggleStreamMenu(!this.streamMenuOpen),
      onMouseMove: (dx, dy) => {
        if (this.session && !this.streamMenuOpen) this.session.sendMouse(dx, dy);
      },
      onMouseButton: (action, button) => {
        if (this.session && !this.streamMenuOpen && this.session.sendMouseButton) {
          this.session.sendMouseButton(action, button);
        }
      },
      onMouseWheel: (clicks) => {
        if (this.session && !this.streamMenuOpen && this.session.sendMouseWheel) {
          this.session.sendMouseWheel(clicks);
        }
      },
      onKeyEvent: (code, action, modifiers) => {
        if (this.session && !this.streamMenuOpen && this.session.sendKey) {
          this.session.sendKey(code, action, modifiers);
        }
      },
      onControllerArrival: (idx, activeMask) => {
        if (this.session && this.session.sendControllerArrival) {
          this.session.sendControllerArrival(idx, activeMask);
        }
      },
      onControllerPacket: (idx, activeMask, state) => {
        if (this.session && !this.streamMenuOpen) {
          this.session.sendController(idx, activeMask, state);
        }
      },
      onGamepadStatus: (pads) => {
        if (pads.length === 0) {
          this.elPadPill.textContent = this.t('pill.padNone');
          this.elPadPill.className = 'pill';
        } else {
          this.elPadPill.textContent = this.t('pill.padCount', { count: pads.length });
          this.elPadPill.className = 'pill pill-ok';
        }
      },
    });
  }

  _visibleFocusables() {
    let root = this.elLauncher;
    if (this.elDialogModal && !this.elDialogModal.classList.contains('hidden')) root = this.elDialogModal;
    else if (this.elAppsModal && !this.elAppsModal.classList.contains('hidden')) root = this.elAppsModal;
    else if (!this.elAddModal.classList.contains('hidden')) root = this.elAddModal;
    else if (!this.elStreamMenu.classList.contains('hidden')) root = this.elStreamMenu;
    return Array.from(root.querySelectorAll('.focusable')).filter(
      (el) => el.offsetParent !== null && !el.classList.contains('hidden')
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

    if (idx < 0) {
      this._setFocus(items[0]);
      return;
    }
    const rects = items.map((el) => el.getBoundingClientRect());
    const nextIdx = pickSpatialFocus(rects, idx, dir);
    this._setFocus(items[nextIdx >= 0 ? nextIdx : idx]);
  }

  _handleBack() {
    if (this.elDialogModal && !this.elDialogModal.classList.contains('hidden')) {
      const cancelBtn = document.getElementById('btn-dialog-cancel');
      if (cancelBtn && !cancelBtn.classList.contains('hidden')) cancelBtn.click();
      else document.getElementById('btn-dialog-ok').click();
      return;
    }
    if (this.elAppsModal && !this.elAppsModal.classList.contains('hidden')) {
      this.closeAppsModal();
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
    this.elHostsGrid.textContent = '';
    if (this.hosts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.t('hosts.empty');
      this.elHostsGrid.appendChild(empty);
      return;
    }

    for (const host of this.hosts) {
      const card = document.createElement('button');
      card.className = 'host-card focusable';
      card.dataset.hostId = host.id;

      const title = document.createElement('h4');
      title.textContent = host.name;

      const meta = document.createElement('div');
      meta.className = 'host-meta';
      meta.textContent = host.address;

      const tags = document.createElement('div');
      tags.className = 'host-tags';

      const fwTag = document.createElement('span');
      fwTag.className = host.frameWarpVersion ? 'tag tag-fw' : 'tag';
      fwTag.textContent = host.frameWarpVersion
        ? this.t('hosts.fwSupported', { ver: host.frameWarpVersion })
        : this.t('hosts.standard');

      const pairTag = document.createElement('span');
      pairTag.className = 'tag';
      pairTag.textContent = host.paired ? this.t('hosts.paired') : this.t('hosts.unpaired');

      tags.appendChild(fwTag);
      tags.appendChild(pairTag);
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(tags);

      card.addEventListener('click', () => this.connectHost(host));
      this.elHostsGrid.appendChild(card);
    }
  }

  _removeFocusedHost() {
    if (this.activeTab !== 'hosts' || !this.focusedEl || !this.focusedEl.dataset.hostId) return;
    const id = this.focusedEl.dataset.hostId;
    this.hosts = this.hosts.filter((h) => h.id !== id);
    this._saveHosts();
    this._renderHosts();
    this._focusFirst();
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
      frameWarpVersion: 0,
      paired: false,
      serverCertPem: '',
    });
    this._saveHosts();
    this._renderHosts();
    this.closeAddHostModal();
  }

  openAppsModal(host, apps, currentGame) {
    this._selectedHostForApps = host;
    this._runningAppId = currentGame || 0;
    document.getElementById('apps-modal-title').textContent = this.t('modal.appsTitle', { host: host.name });
    document.getElementById('btn-resume-running').classList.toggle('hidden', !this._runningAppId);
    document.getElementById('btn-quit-running').classList.toggle('hidden', !this._runningAppId);

    this.elAppsGrid.textContent = '';
    if (!apps || apps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.t('modal.appsEmpty');
      this.elAppsGrid.appendChild(empty);
    } else {
      for (const app of apps) {
        const card = document.createElement('button');
        card.className = 'host-card focusable';

        const h4 = document.createElement('h4');
        h4.textContent = app.title;
        card.appendChild(h4);

        const tags = document.createElement('div');
        tags.className = 'host-tags';
        if (app.id === this._runningAppId) {
          const runningTag = document.createElement('span');
          runningTag.className = 'tag tag-fw';
          runningTag.textContent = 'Running';
          tags.appendChild(runningTag);
        }
        if (app.hdr) {
          const hdrTag = document.createElement('span');
          hdrTag.className = 'tag';
          hdrTag.textContent = 'HDR';
          tags.appendChild(hdrTag);
        }
        card.appendChild(tags);

        card.addEventListener('click', () => {
          const resume = app.id === this._runningAppId;
          this.closeAppsModal();
          this._launchStream(host, app.id, resume);
        });
        this.elAppsGrid.appendChild(card);
      }
    }

    this.elAppsModal.classList.remove('hidden');
    this._focusFirst();
  }

  closeAppsModal() {
    this.elAppsModal.classList.add('hidden');
    this._focusFirst();
  }

  showTvDialog(title, message, { confirm = false, okText = null, hideOk = false, onCancel = null } = {}) {
    return new Promise((resolve) => {
      document.getElementById('tv-dialog-title').textContent = title;
      document.getElementById('tv-dialog-body').textContent = message;
      const okBtn = document.getElementById('btn-dialog-ok');
      const cancelBtn = document.getElementById('btn-dialog-cancel');
      okBtn.textContent = okText || this.t('btn.ok');
      okBtn.classList.toggle('hidden', hideOk);
      cancelBtn.classList.toggle('hidden', !confirm && !hideOk);
      this.elDialogModal.classList.remove('hidden');

      const cleanup = (result) => {
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        okBtn.classList.remove('hidden');
        this.elDialogModal.classList.add('hidden');
        this._focusFirst();
        resolve(result);
      };
      okBtn.onclick = () => cleanup(true);
      cancelBtn.onclick = () => {
        onCancel?.();
        cleanup(false);
      };
      this._setFocus(hideOk ? cancelBtn : okBtn);
    });
  }

  async _pairHostWithConcurrentModal(host) {
    const pin = generatePairingPin();
    const ac = new AbortController();

    // Start /pair immediately so the host displays the PIN prompt right away
    const pairPromise = pairHostAsync(this.wasm.runtime, host.address, pin, { signal: ac.signal });

    document.getElementById('tv-dialog-title').textContent = this.t('modal.pairTitle', { host: host.name });
    document.getElementById('tv-dialog-body').textContent = this.t('modal.pairBody', { pin });
    const okBtn = document.getElementById('btn-dialog-ok');
    const cancelBtn = document.getElementById('btn-dialog-cancel');
    okBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    this.elDialogModal.classList.remove('hidden');
    this._setFocus(cancelBtn);

    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      ac.abort();
      cancelPairingAsync(this.wasm.runtime);
    };

    try {
      const res = await pairPromise;
      return { ...res, cancelled };
    } catch (err) {
      return { ok: false, cancelled, error: err.message || String(err) };
    } finally {
      cancelBtn.onclick = null;
      okBtn.classList.remove('hidden');
      this.elDialogModal.classList.add('hidden');
      this._focusFirst();
    }
  }

  async connectHost(host) {
    if (!this.wasm.available || !this.wasm.runtime || typeof this.wasm.runtime.startAsyncJob !== 'function') {
      await this.showTvDialog(this.t('dialog.engineMissingTitle'), this.t('dialog.engineMissingBody'));
      return;
    }

    try {
      const probe = await probeHostAsync(this.wasm.runtime, host.address);
      if (probe.error) {
        await this.showTvDialog(this.t('dialog.connFailed'), `${host.address}: ${probe.error}`);
        return;
      }
      host.frameWarpVersion = probe.frameWarpVersion || 0;
      host.paired = Boolean(probe.paired) && Boolean(host.serverCertPem);
      if (probe.hostname) host.name = probe.hostname;
      this._saveHosts();
      this._renderHosts();

      if (!host.paired) {
        const pairRes = await this._pairHostWithConcurrentModal(host);
        if (pairRes.cancelled) return;
        if (!pairRes.ok) {
          await this.showTvDialog(this.t('dialog.pairFailed'), pairRes.error || 'Rejected');
          return;
        }
        host.paired = true;
        if (pairRes.serverCertPem) host.serverCertPem = pairRes.serverCertPem;
        this._saveHosts();
        this._renderHosts();
      }

      const appRes = await listAppsAsync(this.wasm.runtime, host.address);
      if (appRes.error) {
        await this.showTvDialog(this.t('dialog.connFailed'), appRes.error);
        return;
      }
      this.openAppsModal(host, appRes.apps || [], probe.currentGame || 0);
    } catch (err) {
      await this.showTvDialog(this.t('dialog.streamError'), err.message || String(err));
    }
  }

  async _launchStream(host, appId, resume) {
    try {
      this._enterStreamView(false);
      this.session = new WasmStreamSession(this.wasm.runtime, host, appId, this.settings, { resume });
      await this.session.start(
        (stats) => this._updateOverlay(stats),
        {
          onTerminated: async (code) => {
            await this.stopStream();
            if (code !== 0) {
              await this.showTvDialog(this.t('dialog.streamEnded'), `Code: ${code}`);
            }
          },
        }
      );
    } catch (err) {
      await this.stopStream();
      await this.showTvDialog(this.t('dialog.streamError'), err.message || String(err));
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
    this.input.setStreaming(true, { demo: isDemo });
    setScreenSaverEnabled(false);
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

  async stopStream() {
    const active = this.session;
    this.session = null;
    if (active) {
      await active.stop();
    }
    if (document.pointerLockElement && document.exitPointerLock) {
      document.exitPointerLock();
    }
    setScreenSaverEnabled(true);
    this.streamMenuOpen = false;
    this.elStreamMenu.classList.add('hidden');
    this.input.setStreaming(false);
    this.elStream.classList.remove('active');
    this.elLauncher.classList.add('active');
    this._focusFirst();
  }

  toggleStreamMenu(open) {
    this.streamMenuOpen = open;
    this.input.setMenuOpen(open);
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
      this.settings.fwEnabled ? this.t('menu.fwOn') : this.t('menu.fwOff');
    document.getElementById('btn-sm-toggle-overlay').textContent =
      this.settings.overlay ? this.t('menu.ovOn') : this.t('menu.ovOff');
  }

  _updateOverlay(s) {
    document.getElementById('ov-session').textContent = s.session;
    const fpsEl = document.getElementById('ov-fps');
    if (fpsEl) {
      fpsEl.textContent = `${s.rxFps ?? 0} / ${s.decodedFps ?? 0} / ${s.renderedFps ?? 0}${s.directScanout ? ' (Direct)' : ''}`;
    }
    document.getElementById('ov-fw-state').textContent = s.directScanout
      ? 'Direct Scanout'
      : !s.enabled
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
