/**
 * Pure state & launch-decision helpers for the Nightjar Tizen TV home screen.
 */

export const STORAGE_HOME = 'nightjar.tizen.home.v1';

export function initialFocusKey({ lastPlayedVisible = false, selectedHostId = '', hosts = [] } = {}) {
  if (lastPlayedVisible) {
    return 'continue';
  }
  if (selectedHostId && Array.isArray(hosts) && hosts.some((h) => h && h.id === selectedHostId)) {
    return `host:${selectedHostId}`;
  }
  if (Array.isArray(hosts) && hosts.length > 0 && hosts[0]) {
    return `host:${hosts[0].id}`;
  }
  return 'add-host';
}

export function launchDecision(host, appId) {
  if (!host || !host.paired) {
    return 'pair';
  }
  const running = host.currentGame || 0;
  if (running && appId && running === appId) {
    return 'resume';
  }
  if (running && running !== appId) {
    return 'confirm-quit';
  }
  return 'launch';
}

export function loadHomeState(storage) {
  const empty = { lastHostId: '', lastPlayed: null };
  if (!storage || typeof storage.getItem !== 'function') {
    return empty;
  }
  try {
    const raw = storage.getItem(STORAGE_HOME);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const lp = parsed.lastPlayed;
    const validLp =
      lp && typeof lp === 'object' && lp.hostId && lp.appId
        ? {
            hostId: String(lp.hostId),
            appId: Number(lp.appId),
            appTitle: String(lp.appTitle || ''),
          }
        : null;
    return {
      lastHostId: typeof parsed.lastHostId === 'string' ? parsed.lastHostId : '',
      lastPlayed: validLp,
    };
  } catch {
    return empty;
  }
}

export function saveHomeState(storage, state) {
  if (!storage || typeof storage.setItem !== 'function') {
    return;
  }
  try {
    const payload = {
      lastHostId: state && typeof state.lastHostId === 'string' ? state.lastHostId : '',
      lastPlayed: state && state.lastPlayed ? state.lastPlayed : null,
    };
    storage.setItem(STORAGE_HOME, JSON.stringify(payload));
  } catch {
    // ignore storage quota errors
  }
}
