/**
 * Nightjar for Samsung Tizen OS 10 TV — Application Controller
 */

import { WarpRenderer } from './warp-renderer.js';
import { InputManager } from './input-manager.js';
import { pickSpatialFocus } from './gamepad-mapping.js';
import { resolveLocale, tr, migrateSettings } from './i18n.js';
import { buildOverlayRows } from './stream-stats.js';
import {
  initialFocusKey,
  launchDecision,
  loadHomeState,
  saveHomeState,
} from './home-model.js';
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
    this.homeState = loadHomeState(typeof localStorage !== 'undefined' ? localStorage : null);
    this.selectedHostId = this.hosts.some((h) => h.id === this.homeState.lastHostId)
      ? this.homeState.lastHostId
      : (this.hosts[0]?.id || '');
    this.wasm = { available: false, runtime: null };
    this.activeTab = 'hosts';
    this.renderer = null;
    this.session = null;
    this.streamMenuOpen = false;
    this.focusedEl = null;
    this._focusStack = [];
    this._busy = false;
    this._userNavigated = false;
    this._ovRowMap = new Map();

    this._bindElements();
    this._applyLocale();
    this._syncSettingsToDom();
    this._renderHome();
    this._initInput();
    this._bindLifecycle();
    this._focusInitial();
    this._detectWasm();
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
    this.elContinueSection = document.getElementById('continue-section');
    this.elBtnContinue = document.getElementById('btn-continue');
    this.elHostsRow = document.getElementById('hosts-row');
    this.elAppsSection = document.getElementById('apps-section');
    this.elAppsHeading = document.getElementById('apps-heading');
    this.elAppsRow = document.getElementById('apps-row');
    this.elWasmPill = document.getElementById('wasm-status-pill');
    this.elPadPill = document.getElementById('gamepad-status-pill');
    this.elAddModal = document.getElementById('add-host-modal');
    this.elDialogModal = document.getElementById('tv-dialog-modal');
    this.elStreamMenu = document.getElementById('stream-menu');
    this.elOverlay = document.getElementById('stream-overlay');
    this.elOvRows = document.getElementById('ov-rows');

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    this.elBtnContinue.addEventListener('click', () => this.continueLastPlayed());
    document.getElementById('btn-lab-start').addEventListener('click', () => this.startDemoStream());
    document.getElementById('btn-modal-cancel').addEventListener('click', () => this.closeAddHostModal());
    document.getElementById('btn-modal-save').addEventListener('click', () => this.saveNewHost());

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
      const clean = this.hosts.map((h) => ({
        id: h.id,
        name: h.name,
        address: h.address,
        frameWarpVersion: h.frameWarpVersion || 0,
        paired: Boolean(h.paired),
        serverCertPem: h.serverCertPem || '',
        currentGame: h.currentGame || 0,
        apps: Array.isArray(h.apps) ? h.apps : [],
      }));
      localStorage.setItem(STORAGE_HOSTS, JSON.stringify(clean));
    } catch {
      // ignore
    }
  }

  _saveHomeState() {
    saveHomeState(typeof localStorage !== 'undefined' ? localStorage : null, this.homeState);
  }

  async _detectWasm() {
    this.wasm = await detectWasmEngine();
    if (this.wasm.available) {
      this.elWasmPill.textContent = this.t('pill.wasmReady');
      this.elWasmPill.className = 'pill pill-ok';
      if (typeof this.wasm.runtime.setPinnedCert === 'function') {
        for (const h of this.hosts) {
          if (h.serverCertPem) {
            this.wasm.runtime.setPinnedCert(h.address, h.serverCertPem);
          }
        }
      }
      this._refreshHostsInBackground();
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

  _hasOpenModal() {
    return (
      (this.elDialogModal && !this.elDialogModal.classList.contains('hidden')) ||
      !this.elAddModal.classList.contains('hidden') ||
      !this.elStreamMenu.classList.contains('hidden')
    );
  }

  _visibleFocusables() {
    let root = this.elLauncher;
    if (this.elDialogModal && !this.elDialogModal.classList.contains('hidden')) root = this.elDialogModal;
    else if (!this.elAddModal.classList.contains('hidden')) root = this.elAddModal;
    else if (!this.elStreamMenu.classList.contains('hidden')) root = this.elStreamMenu;
    return Array.from(root.querySelectorAll('.focusable')).filter(
      (el) => el.offsetParent !== null && !el.classList.contains('hidden')
    );
  }

  _focusKeyOf(el) {
    return el && el.dataset ? (el.dataset.focusKey || '') : '';
  }

  _findFocusableByKey(key) {
    if (!key) return null;
    return this._visibleFocusables().find((el) => this._focusKeyOf(el) === key) || null;
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
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      el.focus();
    }
  }

  _pushFocus() {
    this._focusStack.push({
      el: this.focusedEl,
      key: this._focusKeyOf(this.focusedEl),
    });
  }

  _popFocus() {
    const saved = this._focusStack.pop();
    if (saved) {
      if (saved.el && saved.el.isConnected && saved.el.offsetParent !== null) {
        this._setFocus(saved.el);
        return;
      }
      if (saved.key) {
        const match = this._findFocusableByKey(saved.key);
        if (match) {
          this._setFocus(match);
          return;
        }
      }
    }
    this._focusInitial();
  }

  _focusFirst() {
    const items = this._visibleFocusables();
    if (items.length > 0) this._setFocus(items[0]);
  }

  _focusInitial() {
    if (this._hasOpenModal() || this.activeTab !== 'hosts') {
      const root = document.getElementById(`tab-${this.activeTab}`);
      const firstInTab = root
        ? Array.from(root.querySelectorAll('.focusable')).find((el) => el.offsetParent !== null)
        : null;
      if (firstInTab) this._setFocus(firstInTab);
      else this._focusFirst();
      return;
    }
    const lastPlayedVisible = !this.elContinueSection.classList.contains('hidden');
    const key = initialFocusKey({
      lastPlayedVisible,
      selectedHostId: this.selectedHostId,
      hosts: this.hosts,
    });
    const target = this._findFocusableByKey(key) || this._visibleFocusables().find((el) => !el.classList.contains('nav-tab'));
    if (target) this._setFocus(target);
  }

  _handleNavigation(dir) {
    this._userNavigated = true;
    const items = this._visibleFocusables();
    if (items.length === 0) return;
    let current = document.activeElement;
    if (!items.includes(current) && this.focusedEl && items.includes(this.focusedEl)) {
      current = this.focusedEl;
    }
    const idx = items.indexOf(current);

    if ((dir === 'left' || dir === 'right') && current && current.tagName === 'LABEL') {
      const sel = current.querySelector('select');
      if (sel && sel.options.length > 0) {
        const delta = dir === 'right' ? 1 : -1;
        const nextOpt = Math.max(0, Math.min(sel.options.length - 1, sel.selectedIndex + delta));
        if (nextOpt !== sel.selectedIndex) {
          sel.selectedIndex = nextOpt;
          sel.dispatchEvent(new Event('change'));
        }
        return;
      }
    }

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
      this._focusInitial();
      return;
    }
    const rects = items.map((el) => el.getBoundingClientRect());
    const nextIdx = pickSpatialFocus(rects, idx, dir);
    const nextEl = items[nextIdx >= 0 ? nextIdx : idx];
    this._setFocus(nextEl);
    if (nextEl && nextEl.classList.contains('nav-tab') && nextEl.dataset.tab !== this.activeTab) {
      this.switchTab(nextEl.dataset.tab, { keepFocus: true });
    }
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
    if (this.activeTab === 'hosts' && this.focusedEl && this.focusedEl.closest && this.focusedEl.closest('#apps-row')) {
      const hostBtn = this._findFocusableByKey(`host:${this.selectedHostId}`);
      if (hostBtn) {
        this._setFocus(hostBtn);
        return;
      }
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

  switchTab(tab, { keepFocus = false } = {}) {
    this.activeTab = tab;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tab}`);
    });
    if (!keepFocus) {
      this._focusInitial();
    }
  }

  _renderHome({ focusKey = null } = {}) {
    const prevKey = focusKey || this._focusKeyOf(this.focusedEl);
    this._renderContinue();
    this._renderHosts();
    this._renderApps();

    if (!this.session && !this._hasOpenModal() && this.activeTab === 'hosts') {
      const target = (prevKey && this._findFocusableByKey(prevKey)) || null;
      if (target) {
        this._setFocus(target);
      } else if (!this.focusedEl || !this.focusedEl.isConnected || this.focusedEl.offsetParent === null) {
        this._focusInitial();
      }
    }
  }

  _renderContinue() {
    const lp = this.homeState.lastPlayed;
    const host = lp ? this.hosts.find((h) => h.id === lp.hostId) : null;
    if (!lp || !host) {
      this.elContinueSection.classList.add('hidden');
      return;
    }
    this.elContinueSection.classList.remove('hidden');
    const isRunning = host.currentGame && host.currentGame === lp.appId;
    document.getElementById('continue-kicker').textContent = isRunning
      ? this.t('continue.resume')
      : this.t('continue.play');
    document.getElementById('continue-title').textContent = lp.appTitle || `#${lp.appId}`;
    document.getElementById('continue-sub').textContent = this.t('continue.on', { host: host.name });
  }

  _renderHosts() {
    this.elHostsRow.textContent = '';

    for (const host of this.hosts) {
      const card = document.createElement('button');
      card.className = host.busy ? 'host-card focusable busy' : 'host-card focusable';
      card.dataset.hostId = host.id;
      card.dataset.focusKey = `host:${host.id}`;

      const title = document.createElement('h4');
      title.textContent = host.name;

      const meta = document.createElement('div');
      meta.className = 'host-meta';
      meta.textContent = host.address;

      const tags = document.createElement('div');
      tags.className = 'host-tags';

      const statusTag = document.createElement('span');
      if (host.busy) {
        statusTag.className = 'tag tag-fw';
        statusTag.textContent = host.busyText || this.t('hosts.connecting');
      } else if (host.online === true) {
        statusTag.className = 'tag tag-ok';
        statusTag.textContent = this.t('hosts.online');
      } else if (host.online === false) {
        statusTag.className = 'tag tag-err';
        statusTag.textContent = this.t('hosts.offline');
      } else {
        statusTag.className = 'tag';
        statusTag.textContent = host.paired ? this.t('hosts.paired') : this.t('hosts.unpaired');
      }
      tags.appendChild(statusTag);

      if (host.frameWarpVersion) {
        const fwTag = document.createElement('span');
        fwTag.className = 'tag tag-fw';
        fwTag.textContent = this.t('hosts.fwSupported', { ver: host.frameWarpVersion });
        tags.appendChild(fwTag);
      }

      if (host.currentGame) {
        const runTag = document.createElement('span');
        runTag.className = 'tag tag-fw';
        runTag.textContent = this.t('hosts.running');
        tags.appendChild(runTag);
      }

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(tags);
      card.addEventListener('click', () => this.selectHost(host));
      this.elHostsRow.appendChild(card);
    }

    const addCard = document.createElement('button');
    addCard.className = 'host-card add-card focusable';
    addCard.dataset.focusKey = 'add-host';
    addCard.textContent = this.t('hosts.addCard');
    addCard.addEventListener('click', () => this.openAddHostModal());
    this.elHostsRow.appendChild(addCard);
  }

  _renderApps() {
    const host = this.hosts.find((h) => h.id === this.selectedHostId);
    const hasApps = host && Array.isArray(host.apps) && host.apps.length > 0;
    if (!host || (!host.paired && !hasApps && !host.appsLoading)) {
      this.elAppsSection.classList.add('hidden');
      this.elAppsRow.textContent = '';
      return;
    }

    this.elAppsSection.classList.remove('hidden');
    this.elAppsHeading.textContent = `${this.t('apps.heading')} — ${host.name}`;
    this.elAppsRow.textContent = '';

    if (host.appsLoading) {
      const loading = document.createElement('div');
      loading.className = 'empty-state';
      loading.textContent = this.t('apps.loading');
      this.elAppsRow.appendChild(loading);
      return;
    }

    if (!hasApps) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = this.t('apps.empty');
      this.elAppsRow.appendChild(empty);
      return;
    }

    for (const app of host.apps) {
      const card = document.createElement('button');
      card.className = 'host-card app-card focusable';
      card.dataset.focusKey = `app:${host.id}:${app.id}`;

      const h4 = document.createElement('h4');
      h4.textContent = app.title;
      card.appendChild(h4);

      const tags = document.createElement('div');
      tags.className = 'host-tags';
      if (host.currentGame && app.id === host.currentGame) {
        const runningTag = document.createElement('span');
        runningTag.className = 'tag tag-fw';
        runningTag.textContent = this.t('hosts.running');
        tags.appendChild(runningTag);
      }
      if (app.hdr) {
        const hdrTag = document.createElement('span');
        hdrTag.className = 'tag';
        hdrTag.textContent = 'HDR';
        tags.appendChild(hdrTag);
      }
      card.appendChild(tags);
      card.addEventListener('click', () => this.launchApp(host, app));
      this.elAppsRow.appendChild(card);
    }

    if (host.currentGame) {
      const quitBtn = document.createElement('button');
      quitBtn.className = 'host-card quit-card focusable';
      quitBtn.dataset.focusKey = 'quit-running';
      quitBtn.textContent = this.t('apps.quitRunning');
      quitBtn.addEventListener('click', () => this._quitRunningApp(host));
      this.elAppsRow.appendChild(quitBtn);
    }
  }

  _removeFocusedHost() {
    if (this.activeTab !== 'hosts' || !this.focusedEl || !this.focusedEl.dataset.hostId) return;
    const id = this.focusedEl.dataset.hostId;
    this.hosts = this.hosts.filter((h) => h.id !== id);
    if (this.selectedHostId === id) {
      this.selectedHostId = this.hosts[0]?.id || '';
    }
    if (this.homeState.lastPlayed && this.homeState.lastPlayed.hostId === id) {
      this.homeState.lastPlayed = null;
    }
    if (this.homeState.lastHostId === id) {
      this.homeState.lastHostId = this.selectedHostId;
    }
    this._saveHosts();
    this._saveHomeState();
    this._renderHome();
    this._focusInitial();
  }

  openAddHostModal() {
    this._pushFocus();
    this.elAddModal.classList.remove('hidden');
    document.getElementById('input-host-name').value = '';
    document.getElementById('input-host-ip').value = '';
    document.getElementById('input-host-ip').focus();
  }

  closeAddHostModal() {
    this.elAddModal.classList.add('hidden');
    this._popFocus();
  }

  async saveNewHost() {
    const ip = document.getElementById('input-host-ip').value.trim();
    const name = document.getElementById('input-host-name').value.trim() || ip;
    if (!ip) return;
    const newHost = {
      id: `host-${Date.now()}`,
      name,
      address: ip,
      frameWarpVersion: 0,
      paired: false,
      serverCertPem: '',
      currentGame: 0,
      apps: [],
    };
    this.hosts.push(newHost);
    this.selectedHostId = newHost.id;
    this._saveHosts();
    this.elAddModal.classList.add('hidden');
    this._renderHome({ focusKey: `host:${newHost.id}` });
    await this.selectHost(newHost);
  }

  showTvDialog(title, message, { confirm = false, okText = null, hideOk = false, onCancel = null } = {}) {
    return new Promise((resolve) => {
      this._pushFocus();
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
        this._popFocus();
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
    this._pushFocus();
    const pin = generatePairingPin();
    const ac = new AbortController();

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
      this._popFocus();
    }
  }

  async _refreshHostsInBackground() {
    if (!this.wasm.available || !this.wasm.runtime || this.hosts.length === 0) return;
    const order = [...this.hosts].sort((a, b) => {
      if (a.id === this.selectedHostId) return -1;
      if (b.id === this.selectedHostId) return 1;
      return 0;
    });

    for (const host of order) {
      if (this.session || this._busy) break;
      host.busy = true;
      host.busyText = this.t('hosts.checking');
      this._renderHome();
      try {
        const probe = await probeHostAsync(this.wasm.runtime, host.address);
        host.busy = false;
        if (!probe.error) {
          host.online = true;
          host.frameWarpVersion = probe.frameWarpVersion || 0;
          host.currentGame = probe.currentGame || 0;
          host.paired = Boolean(probe.paired) && Boolean(host.serverCertPem);
          if (probe.hostname) host.name = probe.hostname;
          if (host.id === this.selectedHostId && host.paired && !this.session && !this._busy) {
            const appRes = await listAppsAsync(this.wasm.runtime, host.address);
            if (!appRes.error && Array.isArray(appRes.apps)) {
              host.apps = appRes.apps;
            }
          }
        } else {
          host.online = false;
        }
      } catch {
        host.busy = false;
        host.online = false;
      }
      this._saveHosts();
      this._renderHome();
    }

    if (!this._userNavigated && this.activeTab === 'hosts' && !this.session && !this._hasOpenModal()) {
      this._focusInitial();
    }
  }

  async selectHost(host) {
    if (this._busy) return;
    if (!this.wasm.available || !this.wasm.runtime || typeof this.wasm.runtime.startAsyncJob !== 'function') {
      await this.showTvDialog(this.t('dialog.engineMissingTitle'), this.t('dialog.engineMissingBody'));
      return;
    }

    this._busy = true;
    host.busy = true;
    host.busyText = this.t('hosts.connecting');
    this._renderHome();

    try {
      const probe = await probeHostAsync(this.wasm.runtime, host.address);
      if (probe.error) {
        host.online = false;
        host.busy = false;
        this._saveHosts();
        this._renderHome();
        await this.showTvDialog(this.t('dialog.connFailed'), `${host.address}: ${probe.error}`);
        return;
      }

      host.online = true;
      host.frameWarpVersion = probe.frameWarpVersion || 0;
      host.currentGame = probe.currentGame || 0;
      host.paired = Boolean(probe.paired) && Boolean(host.serverCertPem);
      if (probe.hostname) host.name = probe.hostname;
      this._saveHosts();

      if (!host.paired) {
        host.busy = false;
        this._renderHome();
        const pairRes = await this._pairHostWithConcurrentModal(host);
        if (pairRes.cancelled) return;
        if (!pairRes.ok) {
          await this.showTvDialog(this.t('dialog.pairFailed'), pairRes.error || 'Rejected');
          return;
        }
        host.paired = true;
        if (pairRes.serverCertPem) host.serverCertPem = pairRes.serverCertPem;
        this._saveHosts();
      }

      this.selectedHostId = host.id;
      this.homeState.lastHostId = host.id;
      this._saveHomeState();
      host.busy = true;
      host.appsLoading = true;
      this._renderHome();

      const appRes = await listAppsAsync(this.wasm.runtime, host.address);
      host.appsLoading = false;
      host.busy = false;
      if (appRes.error) {
        this._saveHosts();
        this._renderHome();
        await this.showTvDialog(this.t('dialog.connFailed'), appRes.error);
        return;
      }

      host.apps = appRes.apps || [];
      this._saveHosts();
      let preferredFocus = `host:${host.id}`;
      if (host.apps.length > 0) {
        const running = host.currentGame && host.apps.find((a) => a.id === host.currentGame);
        const targetApp = running || host.apps[0];
        preferredFocus = `app:${host.id}:${targetApp.id}`;
      }
      this._renderHome({ focusKey: preferredFocus });
    } catch (err) {
      host.online = false;
      await this.showTvDialog(this.t('dialog.streamError'), err.message || String(err));
    } finally {
      host.busy = false;
      host.appsLoading = false;
      this._busy = false;
      this._renderHome();
    }
  }

  async launchApp(host, app) {
    if (this._busy) return;
    if (!this.wasm.available || !this.wasm.runtime || typeof this.wasm.runtime.startAsyncJob !== 'function') {
      await this.showTvDialog(this.t('dialog.engineMissingTitle'), this.t('dialog.engineMissingBody'));
      return;
    }

    const decision = launchDecision(host, app.id);
    if (decision === 'pair') {
      return this.selectHost(host);
    }

    let resume = decision === 'resume';
    if (decision === 'confirm-quit') {
      const runningApp = (host.apps || []).find((a) => a.id === host.currentGame);
      const runningTitle = runningApp ? runningApp.title : `#${host.currentGame}`;
      const ok = await this.showTvDialog(
        this.t('dialog.quitRunningTitle'),
        this.t('dialog.quitRunningBody', { running: runningTitle, host: host.name, app: app.title }),
        { confirm: true, okText: this.t('btn.quitAndStart') }
      );
      if (!ok) return;
      this._busy = true;
      try {
        await cancelHostAppAsync(this.wasm.runtime, host.address);
        host.currentGame = 0;
      } finally {
        this._busy = false;
      }
      resume = false;
    }

    this.selectedHostId = host.id;
    this.homeState.lastHostId = host.id;
    this.homeState.lastPlayed = {
      hostId: host.id,
      appId: app.id,
      appTitle: app.title,
    };
    this._saveHomeState();
    this._saveHosts();
    await this._launchStream(host, app.id, resume);
  }

  async continueLastPlayed() {
    if (this._busy) return;
    const lp = this.homeState.lastPlayed;
    if (!lp) return;
    const host = this.hosts.find((h) => h.id === lp.hostId);
    if (!host) return;
    if (!this.wasm.available || !this.wasm.runtime || typeof this.wasm.runtime.startAsyncJob !== 'function') {
      await this.showTvDialog(this.t('dialog.engineMissingTitle'), this.t('dialog.engineMissingBody'));
      return;
    }

    this._busy = true;
    host.busy = true;
    host.busyText = this.t('hosts.connecting');
    this._renderHome();

    let probe;
    try {
      probe = await probeHostAsync(this.wasm.runtime, host.address);
    } catch (err) {
      host.busy = false;
      host.online = false;
      this._busy = false;
      this._saveHosts();
      this._renderHome();
      await this.showTvDialog(this.t('dialog.connFailed'), err.message || String(err));
      return;
    } finally {
      host.busy = false;
      this._busy = false;
    }

    if (probe.error) {
      host.online = false;
      this._saveHosts();
      this._renderHome();
      await this.showTvDialog(this.t('dialog.connFailed'), `${host.address}: ${probe.error}`);
      return;
    }

    host.online = true;
    host.frameWarpVersion = probe.frameWarpVersion || 0;
    host.currentGame = probe.currentGame || 0;
    host.paired = Boolean(probe.paired) && Boolean(host.serverCertPem);
    if (probe.hostname) host.name = probe.hostname;
    this._saveHosts();
    this._renderHome();

    if (!host.paired) {
      return this.selectHost(host);
    }
    await this.launchApp(host, { id: lp.appId, title: lp.appTitle });
  }

  async _quitRunningApp(host) {
    if (this._busy || !this.wasm.available) return;
    this._busy = true;
    try {
      await cancelHostAppAsync(this.wasm.runtime, host.address);
      host.currentGame = 0;
      this._saveHosts();
      this._renderHome({ focusKey: `host:${host.id}` });
    } finally {
      this._busy = false;
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
    this._renderHome();
    this._focusInitial();
  }

  toggleStreamMenu(open) {
    this.streamMenuOpen = open;
    this.input.setMenuOpen(open);
    this.elStreamMenu.classList.toggle('hidden', !open);
    if (open) {
      if (document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
      this._pushFocus();
      this._updateStreamMenuLabels();
      this._setFocus(document.getElementById('btn-sm-resume'));
    } else if (this._focusStack.length > 0) {
      this._focusStack.pop();
    }
  }

  _updateStreamMenuLabels() {
    document.getElementById('btn-sm-toggle-fw').textContent =
      this.settings.fwEnabled ? this.t('menu.fwOn') : this.t('menu.fwOff');
    document.getElementById('btn-sm-toggle-overlay').textContent =
      this.settings.overlay ? this.t('menu.ovOn') : this.t('menu.ovOff');
  }

  _updateOverlay(s) {
    if (!this.elOverlay || this.elOverlay.classList.contains('hidden') || !this.elOvRows) {
      return;
    }
    const data = s.raw ? { ...s.raw, session: s.session, playbackQuality: s.playbackQuality } : s;
    const rows = buildOverlayRows(data, (k, vars) => this.t(k, vars));

    for (const row of rows) {
      let entry = this._ovRowMap.get(row.key);
      if (!entry) {
        const div = document.createElement('div');
        div.className = 'ov-row';
        const labelEl = document.createElement('span');
        labelEl.className = 'ov-label';
        const valEl = document.createElement('span');
        div.appendChild(labelEl);
        div.appendChild(valEl);
        this.elOvRows.appendChild(div);
        entry = { labelEl, valEl, lastLabel: null, lastVal: null };
        this._ovRowMap.set(row.key, entry);
      }
      if (entry.lastLabel !== row.label) {
        entry.labelEl.textContent = row.label;
        entry.lastLabel = row.label;
      }
      if (entry.lastVal !== row.value) {
        entry.valEl.textContent = row.value;
        entry.lastVal = row.value;
      }
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.nightjarApp = new NightjarTizenApp();
});
