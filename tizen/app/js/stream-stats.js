/**
 * Formatting helpers for Nightjar TV performance & Frame Warp diagnostics overlay.
 */

export function formatLatency(win) {
  if (!win || !win.n) return '—';
  const min = Number.isFinite(win.min) ? win.min : 0;
  const avg = Number.isFinite(win.avg) ? win.avg : 0;
  const max = Number.isFinite(win.max) ? win.max : 0;
  return `${min.toFixed(1)} / ${avg.toFixed(1)} / ${max.toFixed(1)} ms`;
}

export function fwStateKey(st) {
  if (st && st.fwState) {
    return `ov.fw.${st.fwState}`;
  }
  if (st && st.directScanout) return 'ov.fw.direct';
  if (st && st.enabled === false) return 'ov.fw.off';
  if (st && st.locked) return 'ov.fw.active';
  return 'ov.fw.learning';
}

export function buildOverlayRows(st, t) {
  const s = st || {};
  const translate = typeof t === 'function' ? t : (k) => k;

  const hasFps = s.rxFps != null || s.decodedFps != null || s.renderedFps != null;
  const fpsVal = hasFps
    ? `${translate('ov.rx')} ${s.rxFps ?? 0} · ${translate('ov.dec')} ${s.decodedFps ?? 0} · ${translate('ov.screen')} ${s.renderedFps ?? 0} · ${translate('ov.drawn')} ${s.drawFps ?? (s.renderedFps ?? 0)} · ${s.displayHz ?? 0} Hz`
    : '—';

  const hasTotals = s.rxTotal != null || s.shownTotal != null;
  const totalsVal = hasTotals
    ? `${translate('ov.rx')} ${s.rxTotal ?? 0} · ${translate('ov.screen')} ${s.shownTotal ?? 0} · ${translate('ov.netLost')} ${s.netDropped ?? 0} · ${translate('ov.tvSkipped')} ${s.skipped ?? 0} · ${translate('ov.noId')} ${s.unresolved ?? 0}`
    : '—';

  const hasNet = s.rttMs != null || s.netLat != null || s.mbps != null;
  const netVal = hasNet
    ? `RTT ${s.rttMs ?? 0}±${s.rttVarMs ?? 0} ms · ${translate('ov.asm')} ${formatLatency(s.netLat)} · ${(Number.isFinite(s.mbps) ? s.mbps : 0).toFixed(1)} Mbps`
    : '—';

  let decLatVal;
  if (s.directScanout) {
    if (s.playbackQuality && typeof s.playbackQuality.totalVideoFrames === 'number') {
      decLatVal = `${s.playbackQuality.totalVideoFrames} ${translate('ov.framesWord')} · ${s.playbackQuality.droppedVideoFrames ?? 0} ${translate('ov.droppedWord')}`;
    } else {
      decLatVal = translate('ov.decDirectNa');
    }
  } else {
    decLatVal = formatLatency(s.decLat);
  }

  const pxX = Array.isArray(s.pixels) ? s.pixels[0] : s.pxX;
  const pxY = Array.isArray(s.pixels) ? s.pixels[1] : s.pxY;
  const shiftVal =
    typeof pxX === 'number' && typeof pxY === 'number'
      ? `${pxX.toFixed(1)}, ${pxY.toFixed(1)} px (${translate('ov.peak')} ${(Number.isFinite(s.peak) ? s.peak : 0).toFixed(1)})`
      : '—';

  const fwFramesVal =
    s.warped != null
      ? `${s.warped} ${translate('ov.warped')} · ${s.extrapolated ?? 0} ${translate('ov.extrap')} · ${s.untagged ?? 0} ${translate('ov.untagged')} · ${s.warpRedrawFps ?? 0} ${translate('ov.redraws')}`
      : '—';

  const fwTagsVal =
    s.tagsFps != null || s.tagsTotal != null
      ? `${s.tagsFps ?? 0}/s · ${translate('ov.lead')} ${s.tagLead ?? 0} · ${translate('ov.model')} ${s.modelGen ?? 0} ${s.mouseLocked ? 'M' : '-'}/${s.stickLocked ? 'S' : '-'} · ${translate('ov.mask')} ${s.masksTotal ?? 0} (${s.maskCells ?? 0}) · lag ${(Number.isFinite(s.lagMs) ? s.lagMs : 0).toFixed(1)} ms`
      : '—';

  return [
    { key: 'session', label: translate('ov.session'), value: s.session || '—' },
    {
      key: 'path',
      label: translate('ov.path'),
      value: s.directScanout ? translate('ov.pathDirect') : translate('ov.pathGpu'),
    },
    { key: 'fps', label: translate('ov.fps'), value: fpsVal },
    { key: 'totals', label: translate('ov.totals'), value: totalsVal },
    { key: 'hostLat', label: translate('ov.hostLat'), value: formatLatency(s.hostLat) },
    { key: 'net', label: translate('ov.net'), value: netVal },
    { key: 'decLat', label: translate('ov.decLat'), value: decLatVal },
    { key: 'presentLat', label: translate('ov.presentLat'), value: formatLatency(s.presentLat) },
    { key: 'fw', label: translate('ov.fw'), value: translate(fwStateKey(s)) },
    { key: 'fwShift', label: translate('ov.fwShift'), value: shiftVal },
    { key: 'fwFrames', label: translate('ov.fwFrames'), value: fwFramesVal },
    { key: 'fwTags', label: translate('ov.fwTags'), value: fwTagsVal },
    { key: 'stage', label: translate('ov.stage'), value: s.stage || '—' },
    { key: 'diag', label: translate('ov.diag'), value: s.diag || '—' },
  ];
}
