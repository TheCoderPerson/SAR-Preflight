// ============================================================
// SAR Preflight — Application Logic
// Depends on: sar-preflight-core.js (loaded first in browser)
// ============================================================

// ============================================================
// STATE
// ============================================================
const S = {
  map: null, drawnItems: null, currentArea: null,
  areaCenter: null, areaBounds: null, areaType: null, areaCoords: [],
  drawHandler: null, panelOpen: true, activeTab: 'wx',
  mapLayers: {}, wireHazardCounts: {}, faaCharts: {},
  utilityWireCounts: {}, utilityWireInfo: {}, // CA utility circuits (PG&E GRIP / CEC), keyed by category / source id
  // Cached live data
  wx: {}, wind: {}, elev: {}, astro: {}, notams: [],
  metar: null,              // observed aviation weather (ceiling / vis / flight category)
  hmsSmoke: [], avalanche: [], // NOAA HMS smoke plumes + avalanche.org danger zones
  // Selected timeline hour for the data panel (0 = NOW). Set by _updateTimeBar.
  timeIdx: 0,
  nwsAlerts: [],
  faaAirspace: null,
  faaObstacles: null,
  // Aggregated multi-feature popup (cycle through all features under a click)
  _aggPopup: { items: [], index: 0, popup: null },
  // Imported FAA TFR/NOTAM data (no-server file import)
  tfrs: [], importedNotams: [], tfrImportMeta: null,
  // Track data source errors for retry/display
  dataSourceErrors: {},
  // Track active fetches for header status
  _activeFetches: {},
  // Last known real device GPS fix, captured opportunistically from the
  // getCurrentPosition calls the app ALREADY makes (initMap centering,
  // locateMe). Read via searchAnchor() so features that want a device position
  // can use one WITHOUT triggering a permission prompt of their own.
  deviceFix: null,          // { lat, lng, accM, at }
  // Place/address search ("Go To" modal)
  _geocodeResults: [], _geocodeAnchor: null, _geocodeQuery: '',
  _geocodeAbort: null, _geocodeGen: 0, _geocodeLastAt: 0,
  _geocodeSel: -1,
  _geocodeMemo: null,       // Map<cacheKey, rawJson> — session-scoped, bounded
  // SOP Risk Profile
  activeProfile: null,
  // ADS-B live traffic
  adsbAircraft: [],
  adsbTrails: {},
  adsbSearchRadiusNm: null,
  _adsbPollTimer: null,
  _adsbLastFetch: 0,
  _adsbApiIndex: 0,
  _adsbEnabled: true,
  // Terrain DEM covering the ADS-B search area, for per-aircraft (terrain-relative) AGL
  adsbDem: null,        // { grid, demFlat } — elevations in metres
  _adsbDemKey: null,    // identity guard so the DEM is fetched once per center+radius
  _adsbDemFetching: false,
  // High-res 3DEP point-sampled ground elevation (metres) for the low+close
  // deconfliction-relevant subset of traffic, keyed by rounded lat,lng
  _adsbHiresCache: null,
  _adsbHiresFetching: false,
  // Vegetation overlay + viewshed
  canopy: {},
  viewsheds: [],            // saved observer viewshed records (see makeViewshedRecord)
  activeViewshedId: null,   // last-selected observer (status line / export default); display = every record with visible !== false
  _viewshedRunningId: null, // id currently computing (serializes the kernel)
  _viewshedPicking: false,
  _vlosGhost: null,         // dashed VLOS ring following the cursor while picking an observer
  _vlosMove: null,          // its map mousemove handler (attached only while picking)
  // Layer-control UI: collapsed section keys + PLANS declutter mode. Both survive
  // the ~50 buildLayerControl() rebuilds and persist via _persistLayerUiState().
  layerSections: new Set(),
  plansMode: false,
  _plansUserOverride: null, // Set of PLANS layer ids the user has deliberately re-checked
  // Canopy edit mode (user corrections to the canopy raster)
  _canopyEditing: false,
  canopyEdit: null,         // session state — see startCanopyEdit()
  // Automatic FAA TFR/NOTAM check status (for the NOTAMs-tab indicator)
  autoCheck: { state: 'idle', ms: 0, tfrCount: 0, notamCount: 0 },
  // Per-section data freshness, keyed by SECTION_DEFS key:
  // { status:'never'|'live'|'cached'|'error', updatedAt, cachedAt, error, errorAt, loading, sources? }
  sectionMeta: {},
};

// ============================================================
// DIAGNOSTICS — on-device crash tracing
// ------------------------------------------------------------
// iOS Safari/WKWebView silently relaunches the app fresh when it
// kills the page for memory pressure (or an unresponsive-main-thread
// "watchdog" kill) — exactly the "crash → reboot with no data"
// symptom. Safari exposes NO JS memory API (no performance.memory),
// so we cannot read heap directly. Instead we:
//   1) keep a breadcrumb ring buffer in localStorage (which is
//      written synchronously and therefore SURVIVES a tab kill,
//      unlike in-memory state or in-flight IndexedDB writes),
//   2) mark a clean-exit flag only on a genuine teardown so the
//      next launch can tell it was killed ungracefully,
//   3) self-tally our own big allocations (typed arrays, RGBA
//      buffers, dataURL strings, tile blobs) + DOM/img counts as a
//      memory proxy, stamped into every breadcrumb, and
//   4) surface the last-session trail in an on-device panel
//      (tap the version label 5x, or it auto-opens after a crash).
// Everything here is best-effort and must NEVER throw — all storage
// and DOM access is wrapped, so it is a no-op under Node/Vitest and
// in private-mode Safari.
// ============================================================
const Diag = {
  CRUMB_KEY: 'sar_diag_crumbs',
  SESSION_KEY: 'sar_diag_session',
  LAST_CRASH_KEY: 'sar_diag_last_crash',
  MAX_CRUMBS: 240,
  enabled: true,
  sessionId: null,
  startedAt: 0,
  mem: { liveKb: 0, leakedKb: 0, peakKb: 0, byKind: {} },
  _crumbs: [],
  _lastCrash: null,
  _throttle: {},
  _tapCount: 0,
  _tapTimer: null,
  _panelTimer: null,

  _ls() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (_) { return null; } },
  _now() { try { return Date.now(); } catch (_) { return 0; } },
  totalKb() { return this.mem.liveKb + this.mem.leakedKb; },

  init() {
    if (!this.enabled) return;
    const ls = this._ls();
    if (!ls) { this.enabled = false; return; }
    try {
      // 1) Was the PREVIOUS session ended cleanly? If not, snapshot its trail.
      let prev = null;
      try { prev = JSON.parse(ls.getItem(this.SESSION_KEY) || 'null'); } catch (_) { prev = null; }
      if (prev && prev.cleanExit !== true) {
        let crumbs = [];
        try { crumbs = JSON.parse(ls.getItem(this.CRUMB_KEY) || '[]'); } catch (_) { crumbs = []; }
        this._lastCrash = {
          session: prev,
          detectedAt: this._now(),
          lastOp: crumbs.length ? crumbs[crumbs.length - 1].op : null,
          crumbs: crumbs.slice(-80),
        };
        try { ls.setItem(this.LAST_CRASH_KEY, JSON.stringify(this._lastCrash)); } catch (_) {}
      } else {
        try { const lc = ls.getItem(this.LAST_CRASH_KEY); if (lc) this._lastCrash = JSON.parse(lc); } catch (_) {}
      }
      // 2) Start a fresh session.
      this.startedAt = this._now();
      this.sessionId = 's' + this.startedAt.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
      this._crumbs = [];
      try { ls.setItem(this.CRUMB_KEY, '[]'); } catch (_) {}
      this._persistSession(false);
      // 3) Lifecycle: mark clean exit only on a real teardown (navigation/close).
      //    A backgrounded/frozen page (pagehide persisted=true) may still be killed,
      //    so we leave it un-clean and let the trail show whether it died mid-op.
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pagehide', (e) => {
          if (e && e.persisted) { this.note('app.frozen', this._domSnapshot()); }
          else { this._persistSession(true); this.note('app.pagehide'); }
        });
        window.addEventListener('freeze', () => { this.note('app.freeze', this._domSnapshot()); });
        window.addEventListener('error', (e) => {
          this.note('js.error', { msg: (e && e.message) ? String(e.message).slice(0, 140) : '?' });
        });
        window.addEventListener('unhandledrejection', (e) => {
          let m = '?'; try { m = String((e.reason && (e.reason.message || e.reason)) || '?').slice(0, 140); } catch (_) {}
          this.note('js.reject', { msg: m });
        });
      }
      // 4) Heartbeat so idle/panning sessions still get timestamped heap + DOM samples.
      if (typeof setInterval !== 'undefined') setInterval(() => this.note('heartbeat', this._domSnapshot()), 20000);
      const ver = (typeof SAR_VERSION !== 'undefined') ? SAR_VERSION : ((typeof APP_VERSION !== 'undefined') ? APP_VERSION : '?');
      this.note('app.start', { v: ver, mode: this._uaTag() });
    } catch (_) { /* never throw */ }
  },

  _uaTag() {
    try {
      const ua = navigator.userAgent || '';
      const m = ua.match(/(iPhone|iPad) OS [\d_]+|CPU OS [\d_]+|Version\/[\d.]+/);
      let standalone = 'tab';
      try { if (navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)) standalone = 'pwa'; } catch (_) {}
      let mem = ''; try { if (navigator.deviceMemory) mem = ' ram~' + navigator.deviceMemory + 'GB'; } catch (_) {}
      return (m ? m[0].replace(/_/g, '.') : 'ua?') + ' ' + standalone + mem;
    } catch (_) { return '?'; }
  },

  _domSnapshot() {
    try {
      const snap = {
        dom: document.querySelectorAll('*').length,
        img: document.querySelectorAll('img').length,
        cnv: document.querySelectorAll('canvas').length,
        vs: (typeof S !== 'undefined' && S.viewsheds) ? S.viewsheds.length : 0,
      };
      try { if (typeof window !== 'undefined' && window.devicePixelRatio) snap.dpr = window.devicePixelRatio; } catch (_) {}
      // Renderer-side signals (the part our byte counter can't see). At extreme
      // zoom, tile memory and a stretched image overlay dominate the page total.
      if (typeof S !== 'undefined' && S.map && S.mapLayers && S.map.hasLayer) {
        const on = []; let tiles = 0;
        Object.keys(S.mapLayers).forEach(k => {
          const ly = S.mapLayers[k];
          if (!ly || !S.map.hasLayer(ly)) return;
          on.push(k);
          if (ly._tiles) tiles += Object.keys(ly._tiles).length;
        });
        snap.lay = on.join(',');
        snap.tiles = tiles;
        try { snap.z = S.map.getZoom(); } catch (_) {}
        // On-screen pixel size of each raster image overlay (stretched-overlay test).
        ['viewshed', 'canopy'].forEach(id => {
          const ov = S.mapLayers[id];
          if (ov && ov._bounds && S.map.hasLayer(ov)) {
            try {
              const ne = S.map.latLngToContainerPoint(ov._bounds.getNorthEast());
              const sw = S.map.latLngToContainerPoint(ov._bounds.getSouthWest());
              snap[id + 'px'] = Math.round(Math.abs(ne.x - sw.x)) + 'x' + Math.round(Math.abs(ne.y - sw.y));
            } catch (_) {}
          }
        });
      }
      return snap;
    } catch (_) { return null; }
  },

  _persistSession(cleanExit) {
    const ls = this._ls(); if (!ls) return;
    try {
      ls.setItem(this.SESSION_KEY, JSON.stringify({
        id: this.sessionId, startedAt: this.startedAt, cleanExit: !!cleanExit,
        peakKb: Math.round(this.mem.peakKb), lastTotalKb: Math.round(this.totalKb()), tag: this._sessTag,
      }));
    } catch (_) {}
  },

  // --- self-tallied memory estimate (no localStorage write — cheap) ---
  alloc(kind, bytes) {
    if (!this.enabled || !bytes) return;
    const kb = bytes / 1024;
    this.mem.liveKb += kb;
    this.mem.byKind[kind] = (this.mem.byKind[kind] || 0) + kb;
    if (this.totalKb() > this.mem.peakKb) this.mem.peakKb = this.totalKb();
  },
  free(kind, bytes) {
    if (!this.enabled || !bytes) return;
    const kb = bytes / 1024;
    this.mem.liveKb = Math.max(0, this.mem.liveKb - kb);
    this.mem.byKind[kind] = Math.max(0, (this.mem.byKind[kind] || 0) - kb);
  },
  // Allocation we cannot reliably release (un-revoked blob URLs, dataURL strings
  // handed to Leaflet): tracked monotonically as "leaked" so the trail shows the
  // cumulative un-released memory climbing toward the kill.
  leak(kind, bytes) {
    if (!this.enabled || !bytes) return;
    const kb = bytes / 1024;
    this.mem.leakedKb += kb;
    this.mem.byKind[kind] = (this.mem.byKind[kind] || 0) + kb;
    if (this.totalKb() > this.mem.peakKb) this.mem.peakKb = this.totalKb();
  },

  // --- breadcrumbs ---
  note(op, detail) {
    if (!this.enabled) return;
    try {
      const c = { t: this._now(), op: op, heap: Math.round(this.totalKb()) };
      if (this.mem.leakedKb > 1) c.leak = Math.round(this.mem.leakedKb);
      if (detail) c.d = detail;
      this._crumbs.push(c);
      if (this._crumbs.length > this.MAX_CRUMBS) this._crumbs.splice(0, this._crumbs.length - this.MAX_CRUMBS);
      const ls = this._ls();
      if (ls) ls.setItem(this.CRUMB_KEY, JSON.stringify(this._crumbs));
      this._persistSession(false);
    } catch (_) {}
  },
  noteThrottled(op, ms, detail) {
    if (!this.enabled) return;
    const now = this._now();
    if ((now - (this._throttle[op] || 0)) < (ms || 2000)) return;
    this._throttle[op] = now;
    this.note(op, detail);
  },

  // --- on-device panel ---
  bindTrigger() {
    try {
      if (typeof document === 'undefined') return;
      const el = document.getElementById('appVersionLabel');
      if (!el) return;
      el.style.cursor = 'pointer';
      el.title = 'tap 5× for diagnostics';
      el.addEventListener('click', () => {
        this._tapCount++;
        if (this._tapTimer) clearTimeout(this._tapTimer);
        this._tapTimer = setTimeout(() => { this._tapCount = 0; }, 1500);
        if (this._tapCount >= 5) { this._tapCount = 0; this.showPanel(); }
      });
    } catch (_) {}
  },
  maybeAutoShow() { if (this._lastCrash) { try { this.showPanel(); } catch (_) {} } },

  showPanel() {
    try {
      if (typeof document === 'undefined') return;
      if (document.getElementById('sarDiagOverlay')) { this._refreshPanel(); return; }
      const ov = document.createElement('div');
      ov.id = 'sarDiagOverlay';
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;' +
        'align-items:stretch;justify-content:center;padding:max(8px,env(safe-area-inset-top)) 8px max(8px,env(safe-area-inset-bottom));font-family:monospace;';
      const panel = document.createElement('div');
      panel.style.cssText = 'background:#0a0e14;border:1px solid #1f6feb;border-radius:8px;width:100%;max-width:680px;display:flex;flex-direction:column;overflow:hidden;color:#cfe;';
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:10px 12px;border-bottom:1px solid #223;display:flex;justify-content:space-between;align-items:center;gap:8px;';
      hdr.innerHTML = '<b style="color:#58a6ff;font-size:13px;">SAR DIAGNOSTICS</b>';
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕ Close';
      closeBtn.style.cssText = 'background:#21262d;color:#cfe;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-size:12px;';
      closeBtn.onclick = () => this.hidePanel();
      hdr.appendChild(closeBtn);
      const stats = document.createElement('div');
      stats.id = 'sarDiagStats';
      stats.style.cssText = 'padding:8px 12px;font-size:11px;color:#9fb;border-bottom:1px solid #223;white-space:pre-wrap;';
      const ta = document.createElement('textarea');
      ta.id = 'sarDiagReport'; ta.readOnly = true;
      ta.style.cssText = 'flex:1;width:100%;box-sizing:border-box;background:#06090f;color:#bcd;border:0;padding:10px 12px;font-family:monospace;font-size:11px;line-height:1.45;resize:none;';
      const bar = document.createElement('div');
      bar.style.cssText = 'padding:8px 12px;border-top:1px solid #223;display:flex;gap:8px;flex-wrap:wrap;';
      const mkBtn = (label, fn, color) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'flex:1;min-width:90px;background:' + (color || '#21262d') + ';color:#fff;border:1px solid #30363d;border-radius:6px;padding:10px;font-size:12px;';
        b.onclick = fn; return b;
      };
      bar.appendChild(mkBtn('Copy report', () => this._copyReport(), '#1f6feb'));
      bar.appendChild(mkBtn('Refresh', () => this._refreshPanel()));
      bar.appendChild(mkBtn('Clear logs', () => { this.clear(); this._refreshPanel(); }, '#8b2c2c'));
      panel.appendChild(hdr); panel.appendChild(stats); panel.appendChild(ta); panel.appendChild(bar);
      ov.appendChild(panel);
      ov.addEventListener('click', (e) => { if (e.target === ov) this.hidePanel(); });
      document.body.appendChild(ov);
      this._refreshPanel();
      this._panelTimer = setInterval(() => this._refreshStats(), 1000);
      this.note('diag.panel.open');
    } catch (_) {}
  },
  hidePanel() {
    try {
      if (this._panelTimer) { clearInterval(this._panelTimer); this._panelTimer = null; }
      const ov = document.getElementById('sarDiagOverlay'); if (ov) ov.remove();
    } catch (_) {}
  },
  _refreshPanel() { try { const ta = document.getElementById('sarDiagReport'); if (ta) ta.value = this.report(); this._refreshStats(); } catch (_) {} },
  _refreshStats() {
    try {
      const el = document.getElementById('sarDiagStats'); if (!el) return;
      const mb = (kb) => (kb / 1024).toFixed(1) + 'MB';
      el.textContent = 'heap≈' + mb(this.totalKb()) + '   live ' + mb(this.mem.liveKb) + '   leaked ' + mb(this.mem.leakedKb) + '   peak ' + mb(this.mem.peakKb) +
        (this._lastCrash ? '\n⚠ previous session ended ungracefully — see report below' : '');
      el.style.color = this._lastCrash ? '#f7b' : '#9fb';
    } catch (_) {}
  },
  _copyReport() {
    const txt = this.report();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(() => this._flash('Copied ✓')).catch(() => this._fallbackCopy());
        return;
      }
    } catch (_) {}
    this._fallbackCopy();
  },
  _fallbackCopy() {
    try {
      const ta = document.getElementById('sarDiagReport');
      if (ta) { ta.focus(); ta.select(); try { ta.setSelectionRange(0, ta.value.length); } catch (_) {} try { document.execCommand('copy'); } catch (_) {} this._flash('Selected — long-press → Copy'); }
    } catch (_) {}
  },
  _flash(msg) { try { const el = document.getElementById('sarDiagStats'); if (el) { el.textContent = msg; setTimeout(() => this._refreshStats(), 1300); } } catch (_) {} },
  clear() {
    try {
      this._crumbs = []; this._lastCrash = null;
      const ls = this._ls();
      if (ls) { ls.setItem(this.CRUMB_KEY, '[]'); ls.removeItem(this.LAST_CRASH_KEY); }
    } catch (_) {}
  },

  report() {
    const out = [];
    const mb = (kb) => (kb / 1024).toFixed(1) + 'MB';
    out.push('SAR DIAGNOSTICS  ' + this._uaTag());
    out.push('generated ' + this._fmtTime(this._now()));
    const up = this.startedAt ? Math.round((this._now() - this.startedAt) / 60000) : 0;
    out.push('session ' + this.sessionId + '  uptime ' + up + 'm');
    out.push('heap est ' + mb(this.totalKb()) + '  (live ' + mb(this.mem.liveKb) + ', leaked ' + mb(this.mem.leakedKb) + ')  peak ' + mb(this.mem.peakKb));
    const kinds = Object.keys(this.mem.byKind).filter(k => this.mem.byKind[k] > 1).sort((a, b) => this.mem.byKind[b] - this.mem.byKind[a]);
    if (kinds.length) out.push('by kind: ' + kinds.map(k => k + ' ' + mb(this.mem.byKind[k])).join(', '));
    if (this._lastCrash) {
      const c = this._lastCrash;
      out.push('');
      out.push('===== PREVIOUS SESSION ENDED UNGRACEFULLY (likely crash/kill) =====');
      out.push('detected ' + this._fmtTime(c.detectedAt));
      if (c.session) out.push('that session: started ' + this._fmtTime(c.session.startedAt) + ', peak ' + mb(c.session.peakKb || 0) + ', last total ' + mb(c.session.lastTotalKb || 0) + (c.session.tag ? ', ' + c.session.tag : ''));
      out.push('LAST OP BEFORE IT DIED: ' + (c.lastOp || '?'));
      out.push('--- last ' + ((c.crumbs && c.crumbs.length) || 0) + ' breadcrumbs before the crash (oldest→newest) ---');
      (c.crumbs || []).forEach(cr => out.push('  ' + this._fmtCrumb(cr)));
    }
    out.push('');
    out.push('===== CURRENT SESSION breadcrumbs (oldest→newest, ' + this._crumbs.length + ') =====');
    this._crumbs.forEach(cr => out.push('  ' + this._fmtCrumb(cr)));
    return out.join('\n');
  },
  _fmtCrumb(cr) {
    let s = this._fmtTime(cr.t) + '  ' + String(cr.op || '?').padEnd(18) + ' heap=' + ((cr.heap || 0) / 1024).toFixed(1) + 'MB';
    if (cr.leak) s += ' leak=' + (cr.leak / 1024).toFixed(1) + 'MB';
    if (cr.d) { try { s += '  ' + JSON.stringify(cr.d); } catch (_) {} }
    return s;
  },
  _fmtTime(t) { try { return new Date(t).toLocaleTimeString(); } catch (_) { return String(t); } },
};
try { if (typeof window !== 'undefined') window.SARDiag = Diag; } catch (_) {}

// Open the diagnostics panel on demand (wired to the Config → App Version button).
function showDiagnostics() { try { Diag.showPanel(); } catch (_) {} }

const ADSB_APIS = [
  { name: 'adsb.fi',        url: (lat, lon, dist) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}` },
  { name: 'airplanes.live', url: (lat, lon, dist) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${dist}` },
  { name: 'adsb.lol',       url: (lat, lon, dist) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}` },
];

// Local timezone helper (avoids hardcoding America/Los_Angeles)
function _localTZ() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return 'America/New_York'; }
}

function trackFetchStart(source) {
  S._activeFetches[source] = true;
  _updateFetchActivity();
}

function trackFetchEnd(source) {
  delete S._activeFetches[source];
  _updateFetchActivity();
}

function _updateFetchActivity() {
  const el = document.getElementById('fetchActivity');
  if (!el) return;
  const active = Object.keys(S._activeFetches);
  if (active.length === 0) {
    el.style.display = 'none';
    el.textContent = '';
    // Pulse the status dot green briefly to indicate completion
    const dot = document.getElementById('statusDot');
    if (dot) { dot.style.background = 'var(--accent-green)'; dot.style.animation = ''; }
  } else {
    el.style.display = '';
    el.textContent = `\u21BB ${active.join(', ')}...`;
    // Pulse the status dot cyan while fetching
    const dot = document.getElementById('statusDot');
    if (dot) { dot.style.background = 'var(--accent-cyan)'; dot.style.animation = 'pulse 0.8s infinite'; }
  }
}

// ---- Data-proxy rate-limit surfacing ----
// The shared Cloudflare Worker proxy rate-limits per IP (429 + Retry-After).
// Surface that in the header status bar instead of failing silently.
function notifyProxyRateLimited(retryAfterSec) {
  const sec = (isFinite(retryAfterSec) && retryAfterSec > 0) ? Math.min(retryAfterSec, 600) : 60;
  const el = document.getElementById('proxyWarn');
  if (el) {
    el.style.display = '';
    el.textContent = '\u26A0 PROXY LIMIT';
    el.title = 'Data proxy rate limit reached \u2014 some fetches were throttled. They will work again in ~' + sec + ' s (REFRESH to retry).';
  }
  const dot = document.getElementById('statusDot');
  if (dot) { dot.style.background = 'var(--accent-amber)'; dot.style.animation = ''; }
  if (S._proxyWarnTimer) clearTimeout(S._proxyWarnTimer);
  S._proxyWarnTimer = setTimeout(() => {
    S._proxyWarnTimer = null;
    const el2 = document.getElementById('proxyWarn');
    if (el2) { el2.style.display = 'none'; el2.textContent = ''; }
    _updateFetchActivity(); // restore the dot from the current fetch state
  }, sec * 1000);
}

// fetch() wrapper for calls that may hit the data proxy: on a 429 from the
// proxy base URL it flags the status bar, then returns the response unchanged
// so each caller's existing error handling proceeds. Safe for non-proxy URLs
// (a 429 from a direct provider is NOT reported as a proxy limit).
async function _proxyFetch(url, opts) {
  const res = await fetch(url, opts);
  try {
    const base = (typeof getCanopyProxyBase === 'function') ? getCanopyProxyBase() : null;
    if (res && res.status === 429 && base && String(url).indexOf(base) === 0) {
      notifyProxyRateLimited(parseInt(res.headers.get('Retry-After') || '', 10));
    }
  } catch (_) { /* surfacing must never break the fetch */ }
  return res;
}

// ============================================================
// DOM HELPERS
// ============================================================
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setColor(id, level) {
  const el = document.getElementById(id); if (!el) return;
  el.classList.remove('green','amber','red','cyan'); el.classList.add(level);
}
function setStatus(id, type, text) {
  const el = document.getElementById(id); if (!el) return;
  el.className = 'fetch-status ' + type; el.textContent = text;
}

// ============================================================
// FAA VFR SECTIONAL — current chart source + edition/offline handling
// ============================================================
// Official FAA-hosted cached tile service (same ArcGIS org used for FAA
// airspace data). Native zoom 8-12, refreshed every 56 days. The edition is
// appended as a `?ed=` query param so a newer online edition naturally
// invalidates the Service Worker cache while offline falls back to the last
// cached edition.
const VFR_SECTIONAL_BASE = 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer';

function sectionalTileUrl(edition) {
  return VFR_SECTIONAL_BASE + '/tile/{z}/{y}/{x}?ed=' + encodeURIComponent(edition);
}

// Last-known edition, persisted so the first paint works offline. Falls back to
// the deterministic 56-day cycle if the device has never been online.
function getStoredSectionalEdition() {
  let ed = null;
  try { ed = localStorage.getItem('sar_sectional_edition'); } catch (e) { /* private mode */ }
  if (!ed && typeof currentSectionalCycle === 'function') {
    ed = currentSectionalCycle(new Date().toISOString().slice(0, 10));
  }
  return ed || '2026-05-13';
}

// When online, ask the service for its current edition and, if newer, repoint
// the tile layer (fresh tiles fetch via the SW; the prior edition stays cached
// as an offline fallback). When offline or on any failure, keep the cached
// edition. Safe to call repeatedly (init + on reconnect).
async function resolveSectionalEdition() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    updateSectionalEditionUI(getStoredSectionalEdition(), { online: false });
    return;
  }
  try {
    const res = await fetch(VFR_SECTIONAL_BASE + '?f=json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const meta = await res.json();
    // The edition stamp lives in documentInfo.subject for this service
    // (e.g. "Updated with the latest charts on 2026-05-13 ..."); fall back
    // across the other text fields in case the service layout changes.
    const di = (meta && meta.documentInfo) || {};
    const candidate = [di.subject, di.comments, meta && meta.serviceDescription, meta && meta.description]
      .filter(Boolean).join(' ');
    const ed = (typeof parseSectionalEdition === 'function') ? parseSectionalEdition(candidate) : null;
    if (!ed) throw new Error('no edition in service metadata');
    const prev = getStoredSectionalEdition();
    try { localStorage.setItem('sar_sectional_edition', ed); } catch (e) { /* private mode */ }
    if (ed !== prev && S.mapLayers && S.mapLayers.sectional) {
      S.mapLayers.sectional.setUrl(sectionalTileUrl(ed));
    }
    updateSectionalEditionUI(ed, { online: true });
  } catch (e) {
    updateSectionalEditionUI(getStoredSectionalEdition(), { online: false });
  }
}

function updateSectionalEditionUI(edition, opts) {
  const el = document.getElementById('sectionalEditionStatus');
  if (!el) return;
  if (opts && opts.online) {
    el.textContent = 'FAA Sectional — current (' + edition + ')';
    el.style.color = 'var(--accent-green)';
  } else {
    el.textContent = 'FAA Sectional — cached edition ' + edition + ' (offline)';
    el.style.color = 'var(--accent-amber)';
  }
}

// --- Map theme (dark / light-map / full-light) ---
// Three modes, cycled by a manual button and persisted to localStorage:
//   dark      — CARTO dark basemap + dark HUD palette (default)
//   light-map — CARTO light basemap, dark HUD palette (bright-day map, HUD intact)
//   light     — CARTO light basemap + full light UI palette
// The data-theme attribute drives the CSS palette ([data-theme="light"] only);
// the basemap swap is done here in JS.
const THEME_MODES = ['dark', 'light-map', 'light'];
const THEME_LABELS = { dark: '☾ DARK', 'light-map': '◐ LIGHT MAP', light: '☀ LIGHT' };

function getStoredTheme() {
  let t = null;
  try { t = localStorage.getItem('sar_theme'); } catch (e) { /* private mode */ }
  return THEME_MODES.indexOf(t) !== -1 ? t : 'dark';
}

function applyTheme(theme) {
  if (THEME_MODES.indexOf(theme) === -1) theme = 'dark';
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.setAttribute('data-theme', theme);
  }
  // Swap the basemap (light for light-map/light, dark otherwise).
  if (S.map && S.mapLayers && S.mapLayers.basemap_dark && S.mapLayers.basemap_light) {
    const wantLight = (theme === 'light' || theme === 'light-map');
    const want = wantLight ? S.mapLayers.basemap_light : S.mapLayers.basemap_dark;
    const other = wantLight ? S.mapLayers.basemap_dark : S.mapLayers.basemap_light;
    if (S.map.hasLayer(other)) S.map.removeLayer(other);
    if (!S.map.hasLayer(want)) S.map.addLayer(want);
    // Pin the basemap beneath every other tile layer (satellite/topo/sectional,
    // radar). bringToBack() relies on Leaflet's auto z-index, which drifts across
    // repeated theme switches and can leave the basemap ABOVE the base overlays —
    // hiding them when toggled on. A fixed negative z-index is deterministic.
    if (typeof want.setZIndex === 'function') want.setZIndex(-1);
  }
  try { localStorage.setItem('sar_theme', theme); } catch (e) { /* private mode */ }
  const btn = (typeof document !== 'undefined') ? document.getElementById('themeToggle') : null;
  if (btn) btn.textContent = THEME_LABELS[theme];
  S.theme = theme;
  if (S.is3D && typeof sync3d === 'function') sync3d();
}

function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(getStoredTheme()) + 1) % THEME_MODES.length];
  applyTheme(next);
}

// Background-cache the FAA sectional covering a drawn operating area (z8-12) so
// it is fully available offline. No-op when offline or the SW isn't controlling.
function cacheSectionalForArea(bounds) {
  if (typeof navigator === 'undefined' || !navigator.onLine) return;
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  if (!bounds) return;
  navigator.serviceWorker.controller.postMessage({
    type: 'DOWNLOAD_TILES',
    bounds: {
      south: bounds.getSouth(), west: bounds.getWest(),
      north: bounds.getNorth(), east: bounds.getEast(),
    },
    zooms: [8, 9, 10, 11, 12],
    providers: ['sectional'],
    sectionalEdition: getStoredSectionalEdition(),
  });
  const text = document.getElementById('tileProgressText');
  if (text && !text.textContent) text.textContent = 'Caching sectional for area…';
}

// ============================================================
// MAP INIT
// ============================================================
// Memory-constrained device (iOS Safari/WKWebView, mobile) vs a desktop PC.
// The iOS PWA has a tight per-tab memory ceiling that desktop browsers don't,
// so the three memory mitigations — the zoom cap, the canopy-AOI fetch guard,
// and the overlay display-size cap — apply ONLY here. On PC everything is
// unrestricted (canopy loads at any zoom and overlays never auto-hide).
function _isConstrained() {
  try {
    if (typeof L !== 'undefined' && L.Browser && L.Browser.mobile) return true;
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/iP(hone|ad|od)/.test(ua)) return true;
    // iPadOS in desktop-mode reports as MacIntel with touch support.
    if (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return false;
  } catch (_) { return false; }
}
// Max interactive zoom: 18 on constrained mobile (z19 satellite tiles + a
// stretched overlay crashed the iOS PWA), full 19 on desktop.
const MAX_MAP_ZOOM = _isConstrained() ? 18 : 19;
function initMap() {
  // Collapsed layer-control sections + PLANS mode, before the first buildLayerControl.
  restoreLayerUiState();
  // preferCanvas: render vector layers (wires, obstacles, towers, airspace,
  // ADS-B, etc.) on one GPU canvas instead of per-feature SVG — much smoother
  // panning at close zoom on high-DPR mobile (the choppiness reported on iPhone).
  S.map = L.map('map', { center: [38.685, -120.99], zoom: 11, maxZoom: MAX_MAP_ZOOM, bounceAtZoomLimits: false, preferCanvas: true, zoomControl: false, attributionControl: false });
  // Pan/zoom heartbeat — samples heap estimate + DOM/img counts while the user
  // moves the map with overlays on (a primary reported pre-crash activity).
  try { S.map.on('moveend zoomend', () => Diag.noteThrottled('map.move', 2500, Object.assign({ z: S.map.getZoom() }, Diag._domSnapshot()))); } catch (_) {}
  // Detach stretched canopy/viewshed image overlays during + after zoom so they
  // never get sized to a huge on-screen pixel area (iOS compositing-memory kill).
  try { S.map.on('zoomstart', _hideOverlaysForZoom); S.map.on('zoomend', _applyOverlayZoomCap); } catch (_) {}
  // Parcels are view-driven: refetch (debounced) after every pan/zoom while on.
  try { S.map.on('moveend', _parcelsOnMoveEnd); } catch (_) {}
  // Tracked basemaps so the theme toggle can swap between them (dark default).
  S.mapLayers.basemap_dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; CARTO' });
  S.mapLayers.basemap_light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; CARTO' });
  applyTheme(getStoredTheme());
  S.mapLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
  S.mapLayers.topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 });
  S.mapLayers.sectional = L.tileLayer(sectionalTileUrl(getStoredSectionalEdition()), { maxNativeZoom: 12, maxZoom: 18, opacity: 1.0, attribution: 'FAA Aeronautical Information Services' });
  // Terrain hillshade (steepness) — Esri World Hillshade XYZ tiles (free, CORS-OK).
  S.mapLayers.slope = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, opacity: 0.6, attribution: 'USGS 3DEP / Esri' });
  // Assessor parcels — live vector layer (El Dorado County GIS where available,
  // CA statewide DWR/LightBox fallback). View-driven, zoom-gated; filled by
  // loadParcelsForView(). Replaced the ReGrid boundary-only tile layer.
  S.mapLayers.parcels = L.layerGroup();
  // Streets/labels reference overlay — Esri transparent hybrid tiles (roads with
  // street names + town/place labels), meant for draping over World Imagery.
  // zIndex 250: above base tiles (which re-stack by DOM order on every base
  // toggle, so an explicit zIndex is required), below radar frames (zIndex 500).
  // maxNativeZoom 15: past z15 the service stops drawing road LINES and renders
  // labels only (it assumes the imagery shows the road), so upscale the z15
  // tiles instead — road geometry stays visible at close zoom.
  S.mapLayers.streets = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 15, maxZoom: 19, zIndex: 250, attribution: 'Esri' }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 15, maxZoom: 19, zIndex: 250 }),
  ]);
  S.drawnItems = new L.FeatureGroup();
  S.map.addLayer(S.drawnItems);
  // Cursor coordinate + elevation display
  const _elevCache = new Map();
  let _elevTimer = null;
  let _elevAbort = null;
  S.map.on('mousemove', e => {
    document.getElementById('cursorCoord').textContent = `${e.latlng.lat.toFixed(5)}°, ${e.latlng.lng.toFixed(5)}°`;

    // Debounced cursor elevation lookup via Open-Meteo
    if (_elevTimer) clearTimeout(_elevTimer);
    if (_elevAbort) { _elevAbort.abort(); _elevAbort = null; }

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const cacheKey = lat.toFixed(3) + '_' + lng.toFixed(3);

    const elevEl = document.getElementById('cursorElev');
    if (_elevCache.has(cacheKey)) {
      if (elevEl) elevEl.textContent = _elevCache.get(cacheKey) + ' ft';
      return;
    }

    _elevTimer = setTimeout(async () => {
      try {
        _elevAbort = new AbortController();
        const res = await fetch(
          `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}`,
          { signal: _elevAbort.signal }
        );
        _elevAbort = null;
        if (!res.ok) return;
        const data = await res.json();
        if (data.elevation && data.elevation.length > 0) {
          const elevFt = Math.round(data.elevation[0] * 3.28084);
          _elevCache.set(cacheKey, elevFt);
          if (_elevCache.size > 5000) _elevCache.delete(_elevCache.keys().next().value);
          if (elevEl) elevEl.textContent = elevFt + ' ft';
        }
      } catch (_) { /* abort or network error — non-critical */ }
    }, 300);
  });
  S.map.on(L.Draw.Event.CREATED, e => {
    if (S._canopyEditing) { onCanopyEditPolygon(e.layer); return; } // edit-mode polygon, not an ops area
    S.drawnItems.clearLayers();
    e.layer.setStyle({ color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4' });
    S.drawnItems.addLayer(e.layer);
    processArea(e.layer, e.layerType);
    clearDrawBtns();
  });
  L.control.zoom({ position: 'bottomright' }).addTo(S.map);

  // Aggregated popup: a click on the map gathers ALL overlapping features (across
  // every visible overlay) and shows them in one paginated popup. Feature clicks
  // are routed here too (see wirePopupAggregation), so this catches clicks that
  // land between features but still inside a polygon.
  S.map.on('click', e => {
    if (S._canopyEditing) return; // no aggregate popups while editing canopy
    if (S._viewshedPicking) { onViewshedMapClick(e.latlng); return; }
    openAggregatePopup(e.latlng, e);
  });

  // Center map on device location if available
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { _noteDeviceFix(pos); S.map.setView([pos.coords.latitude, pos.coords.longitude], 11); },
      () => { /* denied or unavailable — keep default center */ },
      { timeout: 5000, maximumAge: 300000 }
    );
  }

  // Start with panel collapsed on mobile
  if (window.innerWidth <= 900) {
    S.panelOpen = false;
    document.getElementById('sidePanel')?.classList.add('collapsed');
  }

  // Middle-mouse button panning (allows map drag while drawing tools are active)
  // Use capture phase to intercept before Leaflet.Draw sees the events
  let _mmDragging = false, _mmStart = null;
  S.map.getContainer().addEventListener('mousedown', e => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      _mmDragging = true;
      _mmStart = { x: e.clientX, y: e.clientY };
    }
  }, true);
  S.map.getContainer().addEventListener('mousemove', e => {
    if (!_mmDragging) return;
    e.stopPropagation();
    const dx = e.clientX - _mmStart.x;
    const dy = e.clientY - _mmStart.y;
    _mmStart = { x: e.clientX, y: e.clientY };
    S.map.panBy([-dx, -dy], { animate: false });
  }, true);
  S.map.getContainer().addEventListener('mouseup', e => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      _mmDragging = false;
    }
  }, true);
  buildLayerControl();
}

// ============================================================
// DRAW
// ============================================================
function startDraw(type) {
  if (S._canopyEditing) return; // ops-area drawing is disabled in canopy edit mode
  if (S.is3D && typeof _exit3D === 'function') _exit3D(); // drawing happens on the 2D map
  if (typeof cancelViewshedPick === 'function') cancelViewshedPick(); // draw + viewshed-pick are mutually exclusive
  if (S.drawHandler) { S.drawHandler.disable(); S.drawHandler = null; }
  clearDrawBtns();
  const opts = { shapeOptions: { color: '#3d8bfd', weight: 2, fillOpacity: 0.08, dashArray: '6,4' } };
  if (type === 'rectangle') { S.drawHandler = new L.Draw.Rectangle(S.map, opts); document.getElementById('drawRect').classList.add('active'); }
  else if (type === 'circle') { S.drawHandler = new L.Draw.Circle(S.map, opts); document.getElementById('drawCircle').classList.add('active'); }
  else if (type === 'polygon') { S.drawHandler = new L.Draw.Polygon(S.map, { shapeOptions: opts.shapeOptions, allowIntersection: false }); document.getElementById('drawPolygon').classList.add('active'); }
  if (S.drawHandler) S.drawHandler.enable();
}
function clearDrawBtns() { document.querySelectorAll('.draw-btn').forEach(b => b.classList.remove('active')); }
function clearArea() {
  stopAdsbPolling();
  S.drawnItems.clearLayers(); S.currentArea = null; S.areaCenter = null;
  Object.keys(WIRE_CATEGORIES).forEach(k => { if (S.mapLayers['wire_' + k]) S.mapLayers['wire_' + k].clearLayers(); });
  if (S.mapLayers.airports) S.mapLayers.airports.clearLayers();
  if (S.mapLayers.nws_alerts) S.mapLayers.nws_alerts.clearLayers();
  if (S.mapLayers.cell_towers) S.mapLayers.cell_towers.clearLayers();
  if (S.mapLayers.fire_perimeters) S.mapLayers.fire_perimeters.clearLayers();
  // Clear radar layers and stop animation
  if (S.radarAnim) {
    if (S.radarAnim.interval) clearInterval(S.radarAnim.interval);
    if (S.radarAnim.layers) S.radarAnim.layers.forEach(l => { if (S.map && S.map.hasLayer(l)) S.map.removeLayer(l); });
    S.radarAnim = null;
  }
  const radarControls = document.getElementById('radarControls');
  if (radarControls) radarControls.style.display = 'none';
  hideTimeBar();
  if (S.mapLayers.emergency_lz) S.mapLayers.emergency_lz.clearLayers();
  if (S.mapLayers.swap_radius) S.mapLayers.swap_radius.clearLayers();
  if (S.mapLayers.faa_class_airspace) S.mapLayers.faa_class_airspace.clearLayers();
  if (S.mapLayers.faa_sua) S.mapLayers.faa_sua.clearLayers();
  if (S.mapLayers.faa_tfr) S.mapLayers.faa_tfr.clearLayers();
  if (S.mapLayers.faa_laanc) S.mapLayers.faa_laanc.clearLayers();
  if (S.mapLayers.faa_ns_restrictions) S.mapLayers.faa_ns_restrictions.clearLayers();
  if (S.mapLayers.faa_prohibited) S.mapLayers.faa_prohibited.clearLayers();
  if (S.mapLayers.faa_obstacles) S.mapLayers.faa_obstacles.clearLayers();
  if (S.mapLayers.dams) S.mapLayers.dams.clearLayers();
  if (S.mapLayers.wilderness) S.mapLayers.wilderness.clearLayers();
  if (S.mapLayers.national_parks) S.mapLayers.national_parks.clearLayers();
  // Vegetation overlay + viewsheds (analysis overlays) — teardown without rebuilding
  // the layer control (clearArea intentionally leaves that to the next processArea).
  // Saved viewsheds stay in IndexedDB; restoreViewsheds re-hydrates them per area.
  if (S.mapLayers.observers) S.mapLayers.observers.clearLayers();
  if (S.mapLayers.observer_rings) S.mapLayers.observer_rings.clearLayers();
  try {
    let freed = 0;
    (S.viewsheds || []).forEach(r => { if (r && r.mask && r.mask.length) { Diag.free('viewshedMask', r.mask.length); freed += r.mask.length; } });
    Diag.note('area.clear', { vsFreedKb: Math.round(freed / 1024) });
  } catch (_) {}
  S.viewsheds = []; S.activeViewshedId = null;
  if (S.mapLayers.viewshed && S.map && S.map.hasLayer(S.mapLayers.viewshed)) S.map.removeLayer(S.mapLayers.viewshed);
  if (S.mapLayers.canopy && S.map && S.map.hasLayer(S.mapLayers.canopy)) S.map.removeLayer(S.mapLayers.canopy);
  // Shadow too: leaving it draped while clearing _overlayWanted.shadow stranded
  // the raster on the map with time-bar scrubbing and the zoom cap both dead.
  if (S.mapLayers.shadow && S.map && S.map.hasLayer(S.mapLayers.shadow)) S.map.removeLayer(S.mapLayers.shadow);
  S._overlayWanted = { canopy: false, viewshed: false, shadow: false };
  const _vsRes = document.getElementById('vsResult'); if (_vsRes) _vsRes.textContent = '';
  S.faaAirspace = null;
  S.faaObstacles = null;
  S.protectedAreas = null;
  S.lzs = [];
  S.wireHazardCounts = {};
  S.utilityWireCounts = {}; S.utilityWireInfo = {};
  S.towerCount = 0;
  S.nwsAlerts = [];
  S.dataSourceErrors = {};
  const dsWarn = document.getElementById('dataSourceWarning');
  if (dsWarn) dsWarn.remove();
  document.getElementById('noAreaOverlay').style.display = '';
  document.getElementById('assessmentBanner').style.display = 'none';
  document.getElementById('areaInfoBar').style.display = 'none';
  document.getElementById('noAreaState').style.display = '';
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  const alertSection = document.getElementById('alertSection');
  if (alertSection) alertSection.style.display = 'none';
  const forecastSection = document.getElementById('forecastSection');
  if (forecastSection) forecastSection.style.display = 'none';
}
// ============================================================
// GO TO — coordinates, place name, or address
//
// The input box takes all three. Coordinates are resolved SYNCHRONOUSLY and
// never touch the network; only text that parseCoordinateInput rejects is sent
// to the geocoder. That ordering is the contract — it keeps coordinate entry
// fully offline-capable and keeps rate-limit budget for the searches that
// actually need it.
// ============================================================

const DEVICE_FIX_MAX_AGE_MS = 30 * 60 * 1000; // beyond this a fix is not "where I am"

// Opportunistic capture. Called from every getCurrentPosition SUCCESS callback
// the app already has — it never adds a geolocation call of its own.
function _noteDeviceFix(pos) {
  if (!pos || !pos.coords) return;
  const lat = pos.coords.latitude, lng = pos.coords.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  S.deviceFix = {
    lat, lng,
    accM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
    at: Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now(),
  };
}

// Ranking anchor for place search. Prefers a RECENT real GPS fix if one is
// already known, otherwise the map center. This function NEVER calls
// navigator.geolocation: a search must not stall behind a permission dialog,
// and a search must never be the thing that provokes one.
function searchAnchor() {
  const f = S.deviceFix;
  if (f && Number.isFinite(f.lat) && Number.isFinite(f.lng)
      && (Date.now() - f.at) < DEVICE_FIX_MAX_AGE_MS) {
    return { lat: f.lat, lng: f.lng, source: 'gps', at: f.at };
  }
  if (S.map && typeof S.map.getCenter === 'function') {
    const c = S.map.getCenter();
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      return { lat: c.lat, lng: c.lng, source: 'map', at: null };
    }
  }
  return null;
}

// --- Modal open / close / input plumbing ---

function enterCoords() {
  const modal = document.getElementById('coordSearchModal');
  if (!modal) return;
  S._geocodeResults = []; S._geocodeAnchor = null; S._geocodeQuery = ''; S._geocodeSel = -1;
  const input = document.getElementById('coordSearchInput');
  if (input) input.value = '';
  const list = document.getElementById('coordSearchResults');
  if (list) list.innerHTML = '';
  _setGeocodeBusy(false);
  const anchor = searchAnchor();
  setStatus('coordSearchStatus', '', geocodeAnchorLabel(anchor, Date.now()));
  _syncCoordRadiusRow();
  modal.classList.add('active');
  if (input) { try { input.focus(); } catch (_) {} }
}

function closeCoordSearch() {
  const modal = document.getElementById('coordSearchModal');
  if (modal) modal.classList.remove('active');
  // Bump the generation so an in-flight search can never repaint a closed modal.
  S._geocodeGen = (S._geocodeGen || 0) + 1;
  if (S._geocodeAbort) { try { S._geocodeAbort.abort(); } catch (_) {} S._geocodeAbort = null; }
  _setGeocodeBusy(false);
}

// The radius box is only meaningful when "create op area" is checked.
function _syncCoordRadiusRow() {
  const chk = document.getElementById('coordSearchAreaChk');
  const rad = document.getElementById('coordSearchRadius');
  if (rad) rad.disabled = !(chk && chk.checked);
}

// Radius in meters, or null when the operator hasn't opted into an op area.
function _coordSearchRadiusM() {
  const chk = document.getElementById('coordSearchAreaChk');
  if (!chk || !chk.checked) return null;
  const rad = document.getElementById('coordSearchRadius');
  const v = rad ? Number(rad.value) : NaN;
  return (Number.isFinite(v) && v > 0) ? v : null;
}

// Enter searches (or picks the highlighted row), Escape closes, arrows move.
// NOTE: this handler must NEVER fire a search on a plain character keystroke —
// Nominatim's usage policy forbids per-keystroke/autocomplete querying.
function onCoordSearchKey(e) {
  if (!e) return;
  if (e.key === 'Escape') { closeCoordSearch(); return; }
  const n = (S._geocodeResults || []).length;
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault();
    S._geocodeSel = (S._geocodeSel + 1) % n;
    _highlightGeocodeRow();
    return;
  }
  if (e.key === 'ArrowUp' && n) {
    e.preventDefault();
    S._geocodeSel = (S._geocodeSel <= 0 ? n : S._geocodeSel) - 1;
    _highlightGeocodeRow();
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  // A highlighted row means "go there"; otherwise Enter runs the search.
  if (S._geocodeSel >= 0 && S._geocodeSel < n) { pickGeocodeResult(S._geocodeSel); return; }
  submitCoordSearch();
}

// --- Submit: coordinate-first, then geocode ---

// Coordinates are resolved SYNCHRONOUSLY and never touch the network. If
// parseCoordinateInput returns non-null, no fetch is issued and no await
// happens, so the pre-existing behavior is preserved exactly (radius in the
// string -> op area; no radius -> pan only).
async function submitCoordSearch() {
  const input = document.getElementById('coordSearchInput');
  const raw = String((input && input.value) || '').trim();
  if (!raw) {
    setStatus('coordSearchStatus', 'error', 'Enter coordinates, a place name, or an address.');
    return;
  }
  const p = parseCoordinateInput(raw);
  if (p) {
    _applyCoordTarget({
      lat: p.lat, lng: p.lng, bbox: null,
      radiusM: p.radiusM != null ? p.radiusM : _coordSearchRadiusM(),
    });
    closeCoordSearch();
    return;
  }
  await runGeocodeSearch(raw);
}

// --- Fetch + cache ---

function _memoGeocode(key, data) {
  if (!key) return;
  if (!S._geocodeMemo) S._geocodeMemo = new Map();
  S._geocodeMemo.set(key, data);
  if (S._geocodeMemo.size > 20) S._geocodeMemo.delete(S._geocodeMemo.keys().next().value);
}

async function _cachedGeocode(key) {
  if (typeof getCachedApiResponse !== 'function' || !key) return null;
  try {
    const c = await getCachedApiResponse('geocode', key);
    if (c && Array.isArray(c.data)) return { data: c.data, fromCache: true, cachedAt: c.timestamp };
    // Exact miss: the key embeds the map anchor, so the SAME search run from a
    // different map position lands on a different key. Offline that would read
    // as "no such place" when we actually have the answer cached. Fall back to
    // the newest entry for this query under ANY anchor — results are re-ranked
    // against the current anchor on every read anyway, and the status line
    // already labels the whole set as cached.
    const bar = key.lastIndexOf('|');
    if (bar > 0 && typeof getCachedApiResponsesByPrefix === 'function') {
      const rows = await getCachedApiResponsesByPrefix('geocode', key.slice(0, bar + 1));
      const hit = (rows || []).find(r => r && Array.isArray(r.data));
      if (hit) return { data: hit.data, fromCache: true, cachedAt: hit.timestamp };
    }
  } catch (_) { /* cache is best-effort */ }
  return null;
}

// Fetch + cache, mirroring _fetchGeoJsonLayer. Returns
// { data, fromCache, cachedAt, error }.
async function _fetchGeocode(query, anchor, ctl) {
  const key = geocodeCacheKey(query, anchor);
  if (key && S._geocodeMemo && S._geocodeMemo.has(key)) {
    return { data: S._geocodeMemo.get(key), fromCache: false, cachedAt: null };
  }
  const url = geocodeQueryUrl(query, {
    limit: GEOCODE_LIMIT,
    viewbox: geocodeViewbox(anchor, GEOCODE_VIEWBOX_DEG),
  });
  const online = (typeof isOnline !== 'function') || isOnline();
  if (url && online) {
    try {
      // 1 req/s, enforced app-side. Do NOT set a User-Agent header here: it is
      // a forbidden header name in browsers and is silently dropped, so adding
      // one would only create false confidence in compliance. The Referer the
      // browser sends is what identifies this app to Nominatim.
      const wait = geocodeRateLimitDelay(S._geocodeLastAt || 0, Date.now(), GEOCODE_MIN_INTERVAL_MS);
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      S._geocodeLastAt = Date.now();
      const res = await _proxyFetch(url, ctl ? { signal: ctl.signal } : undefined);
      // Treat a throttle as its own state — never auto-retry into a harder block.
      if (res.status === 429 || res.status === 403) throw new Error('rate-limited');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('unexpected response');
      if (typeof cacheApiResponse === 'function') cacheApiResponse('geocode', key, data);
      _memoGeocode(key, data);
      return { data, fromCache: false, cachedAt: null };
    } catch (err) {
      if (err && err.name === 'AbortError') return { data: null, error: 'aborted' };
      const c = await _cachedGeocode(key);
      if (c) return c;
      return { data: null, error: (err && err.message) || String(err) };
    }
  }
  const c = await _cachedGeocode(key);
  if (c) return c;
  return { data: null, error: 'offline' };
}

// AbortController + generation counter, the same shape as loadParcelsForView:
// a superseded search must never repaint over a newer one.
async function runGeocodeSearch(query) {
  const anchor = searchAnchor();
  const gen = S._geocodeGen = (S._geocodeGen || 0) + 1;
  if (S._geocodeAbort) { try { S._geocodeAbort.abort(); } catch (_) {} }
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  S._geocodeAbort = ctl;
  S._geocodeQuery = query;
  S._geocodeSel = -1;

  _setGeocodeBusy(true);
  _setGeocodeStatus({ loading: true });
  const r = await _fetchGeocode(query, anchor, ctl);
  if (gen !== S._geocodeGen) return;          // superseded, or the modal closed
  S._geocodeAbort = null;
  _setGeocodeBusy(false);
  if (r.error === 'aborted') return;

  const recs = rankGeocodeResults(normalizeGeocodeResults(r.data), anchor);
  S._geocodeResults = recs;
  S._geocodeAnchor = anchor;
  _setGeocodeStatus({
    count: recs.length, error: r.error, fromCache: r.fromCache,
    cachedAt: r.cachedAt, nowMs: Date.now(),
  });
  _renderGeocodeResults(recs, { anchor, query, error: r.error });
}

function _setGeocodeBusy(on) {
  const btn = document.getElementById('coordSearchBtn');
  if (!btn) return;
  btn.disabled = !!on;
  btn.textContent = on ? '…' : 'GO';
}

// Pure tone -> the app's existing .fetch-status class vocabulary.
const GEOCODE_TONE_CLASS = { loading: 'loading', ok: 'live', warn: 'cached', error: 'error' };

function _setGeocodeStatus(st) {
  const s = geocodeStatusText(st);
  setStatus('coordSearchStatus', GEOCODE_TONE_CLASS[s.tone] || '', s.text);
}

// --- Render ---

function _highlightGeocodeRow() {
  const list = document.getElementById('coordSearchResults');
  if (!list) return;
  const rows = list.querySelectorAll('.geo-result');
  rows.forEach((el, i) => el.classList.toggle('sel', i === S._geocodeSel));
  const active = rows[S._geocodeSel];
  if (active && typeof active.scrollIntoView === 'function') {
    try { active.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  }
}

function _renderGeocodeResults(recs, opts) {
  const list = document.getElementById('coordSearchResults');
  if (!list) return;
  opts = opts || {};
  list.innerHTML = '';

  if (!recs || !recs.length) {
    // An empty result must NEVER render as a silent blank — name the query back
    // and point at the path that always works.
    const q = _esc(String(opts.query || ''));
    const div = document.createElement('div');
    div.className = 'geo-empty';
    div.innerHTML = opts.error
      ? `Could not search for <strong>${q}</strong>. Coordinates (DD / DDM / DMS / UTM) still work here and need no connection.`
      : `No match for <strong>${q}</strong>. Try a nearby landmark, add the county or state, or enter coordinates directly.`;
    list.appendChild(div);
    return;
  }

  const warn = geocodeMatchWarning(opts.query, recs);
  if (warn) {
    const w = document.createElement('div');
    w.className = 'geo-warn';
    w.textContent = '⚠ ' + warn;
    list.appendChild(w);
  }

  recs.forEach((rec, i) => {
    const f = formatGeocodeResult(rec);
    const row = document.createElement('div');
    row.className = 'geo-result';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    // The full matched string is shown verbatim and never truncated: the
    // operator has to be able to see exactly what the search matched.
    row.innerHTML =
      `<div class="geo-row-top"><span class="geo-title">${_esc(f.title)}</span>`
      + `<span class="geo-dist">${_esc(f.distance)}</span></div>`
      + (f.meta ? `<div class="geo-meta">${_esc(f.meta)}</div>` : '')
      + `<div class="geo-sub">${_esc(f.subtitle)}</div>`;
    row.onclick = () => pickGeocodeResult(i);
    list.appendChild(row);
  });
}

// --- Selection -> pan / fit / create area ---

function pickGeocodeResult(idx) {
  const rec = (S._geocodeResults || [])[idx];
  if (!rec) return;
  _applyCoordTarget({
    lat: rec.lat, lng: rec.lng,
    bbox: geocodeFitBounds(rec),
    radiusM: _coordSearchRadiusM(),
  });
  closeCoordSearch();
}

// The single apply path shared by coordinates and search hits.
//   radius -> op area + full preflight (the pre-existing coordinate behavior)
//   bbox   -> fit the feature's extent
//   else   -> pan, zoom at least 13
function _applyCoordTarget(t) {
  if (!t || !Number.isFinite(t.lat) || !Number.isFinite(t.lng)) return;
  if (t.radiusM) {
    S.drawnItems.clearLayers();
    const c = L.circle([t.lat, t.lng], { radius: t.radiusM, color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4' });
    S.drawnItems.addLayer(c);
    S.map.fitBounds(c.getBounds(), { padding: [40, 40] });
    // processArea is async and fire-and-forget; without this a throw inside it
    // surfaces only as an unhandled rejection with no trace of where it came from.
    const p = processArea(c, 'circle');
    if (p && typeof p.catch === 'function') p.catch(err => console.warn('processArea failed:', err));
    return;
  }
  if (t.bbox) {
    S.map.fitBounds([[t.bbox.south, t.bbox.west], [t.bbox.north, t.bbox.east]], { padding: [40, 40] });
    return;
  }
  S.map.setView([t.lat, t.lng], Math.max(S.map.getZoom(), 13));
}

function locateMe() {
  if (!navigator.geolocation) {
    alert('Location is not available on this device/browser.');
    return;
  }
  const btn = document.getElementById('drawLocate');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }
  const restore = () => { if (btn) { btn.disabled = false; btn.style.opacity = ''; } };
  navigator.geolocation.getCurrentPosition(
    pos => {
      restore();
      _noteDeviceFix(pos);
      S.map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(S.map.getZoom(), 13));
    },
    err => {
      restore();
      alert(err && err.code === 1
        ? 'Location permission denied. Allow location access for this site to use this button.'
        : 'Could not get device location (unavailable or timed out).');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

// ============================================================
// PROCESS AREA — Triggers all API fetches
// ============================================================
async function processArea(layer, type) {
  try { Diag.note('area.process', { type: type, dom: Diag._domSnapshot() }); } catch (_) {}
  document.getElementById('noAreaOverlay').style.display = 'none';
  document.getElementById('assessmentBanner').style.display = 'flex';
  document.getElementById('areaInfoBar').style.display = 'flex';
  document.getElementById('noAreaState').style.display = 'none';

  let center, bounds, perimKm = 0, maxDimKm = 0;
  if (type === 'circle') {
    center = layer.getLatLng(); bounds = layer.getBounds(); S.areaType = 'CIRCLE';
    const radiusKm = layer.getRadius() / 1000;
    const areaKm2 = Math.PI * radiusKm * radiusKm;
    const acres = areaKm2 * 247.105;
    document.getElementById('areaSize').textContent = `R=${radiusKm.toFixed(2)} km (${Math.round(acres)} ac)`;
    perimKm = 2 * Math.PI * radiusKm;
    maxDimKm = 2 * radiusKm;
  } else {
    bounds = layer.getBounds(); center = bounds.getCenter();
    S.areaType = type === 'rectangle' ? 'RECTANGLE' : 'POLYGON';
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
    const area = Math.abs((ne.lat-sw.lat)*111.32*(ne.lng-sw.lng)*111.32*Math.cos((ne.lat+sw.lat)/2*Math.PI/180));
    const acres = area * 247.105;
    document.getElementById('areaSize').textContent = `${area.toFixed(2)} km² (${Math.round(acres)} ac)`;

    if (type === 'rectangle') {
      // Rectangle: perimeter from haversine of edges, max dim = diagonal
      const nw = { lat: ne.lat, lng: sw.lng };
      const se = { lat: sw.lat, lng: ne.lng };
      const widthKm = haversine(ne.lat, ne.lng, nw.lat, nw.lng);
      const heightKm = haversine(ne.lat, ne.lng, se.lat, se.lng);
      perimKm = 2 * (widthKm + heightKm);
      maxDimKm = haversine(ne.lat, ne.lng, sw.lat, sw.lng);
    } else {
      // Polygon: perimeter = sum of edges, max dim = max vertex-to-vertex distance
      const verts = layer.getLatLngs()[0];
      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length;
        perimKm += haversine(verts[i].lat, verts[i].lng, verts[j].lat, verts[j].lng);
      }
      for (let i = 0; i < verts.length; i++) {
        for (let j = i + 1; j < verts.length; j++) {
          const d = haversine(verts[i].lat, verts[i].lng, verts[j].lat, verts[j].lng);
          if (d > maxDimKm) maxDimKm = d;
        }
      }
    }
  }
  S.areaCenter = center; S.areaBounds = bounds; S.currentArea = layer;
  document.getElementById('areaCenter').textContent = `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
  document.getElementById('areaType').textContent = S.areaType;
  // Re-hydrate this area's saved observer viewsheds (markers + active overlay) from IndexedDB.
  if (typeof restoreViewsheds === 'function') restoreViewsheds();

  document.getElementById('areaPerimeter').textContent = `${perimKm.toFixed(2)} km`;
  document.getElementById('areaMaxDim').textContent = `${maxDimKm.toFixed(2)} km`;

  // Show active tab
  switchTab(S.activeTab);

  // Fetch all data in parallel (airports are now dynamic via Overpass)
  await Promise.allSettled([
    fetchWeather(center.lat, center.lng),
    fetchAviationWeather(center, bounds),
    fetchElevation(center, bounds),
    fetchSunMoon(center.lat, center.lng),
    renderNotamsTab(center.lat, center.lng),
    fetchLiveRestrictions(center, bounds),
    fetchWireHazards(bounds),
    fetchUtilityWires(bounds),
    fetchNWSAlerts(center.lat, center.lng),
    fetchRadar(),
    fetchFAAairspace(bounds),
    fetchFaaObstacles(bounds),
    fetchNearbyAirports(center, bounds),
    fetchProtectedAreas(bounds),
    fetchFireDanger(center.lat, center.lng, bounds),
    fetchHMSSmoke(bounds),
    fetchAvalanche(bounds),
    fetchGroundAccess(bounds),
    fetchPublicLands(bounds),
    fetchWaterFeatures(bounds),
    fetchHospitals(bounds),
    fetchTrails(bounds),
  ]);

  // Start ADS-B polling (needs elevation data for AGL)
  stopAdsbPolling();
  startAdsbPolling();

  // Compute derived data after fetches complete
  computeOpsData();
  computeAssessment();
  showDataSourceStatus();
  renderAllSectionMeta();

  // Background-cache the current FAA sectional for this area so it's available offline
  cacheSectionalForArea(bounds);
}

function recordDataSourceError(source, error) {
  S.dataSourceErrors[source] = {
    message: error?.message || String(error),
    timestamp: Date.now(),
    status: error?.status || null,
  };
}

function clearDataSourceError(source) {
  delete S.dataSourceErrors[source];
}

async function retryFailedSource(source) {
  if (!S.areaCenter) return;
  const lat = S.areaCenter.lat, lng = S.areaCenter.lng;
  const bounds = S.areaBounds;
  const retryMap = {
    'Weather': () => fetchWeather(lat, lng),
    'Aviation Wx': () => fetchAviationWeather(S.areaCenter, bounds),
    'Elevation': () => fetchElevation(S.areaCenter, bounds),
    'Sun/Moon': () => fetchSunMoon(lat, lng),
    'Wire Hazards': () => fetchWireHazards(bounds),
    'Utility Circuits': () => fetchUtilityWires(bounds),
    'NWS Alerts': () => fetchNWSAlerts(lat, lng),
    'Radar': () => fetchRadar(),
    'FAA Airspace': () => fetchFAAairspace(bounds),
    'FAA Obstacles': () => fetchFaaObstacles(bounds),
    'Protected Areas': () => fetchProtectedAreas(bounds),
    'Fire Danger': () => fetchFireDanger(lat, lng, bounds),
    'Smoke': () => fetchHMSSmoke(bounds),
    'Avalanche': () => fetchAvalanche(bounds),
    'Airports': () => fetchNearbyAirports(S.areaCenter, bounds),
    'ADS-B': () => fetchAdsb(),
  };
  const fn = retryMap[source];
  if (fn) {
    await fn();
    computeOpsData();
    computeAssessment();
    showDataSourceStatus();
  }
}

async function retryAllFailed() {
  const sources = Object.keys(S.dataSourceErrors);
  for (const src of sources) {
    await retryFailedSource(src);
  }
}

function showDataSourceStatus() {
  const banner = document.getElementById('assessmentBanner');
  if (!banner) return;
  const existing = document.getElementById('dataSourceWarning');
  if (existing) existing.remove();

  const errors = Object.entries(S.dataSourceErrors);
  if (errors.length === 0) return;

  const div = document.createElement('div');
  div.id = 'dataSourceWarning';
  div.style.cssText = 'padding:8px 16px;background:rgba(239,68,68,0.1);border-bottom:1px solid var(--border);font-family:var(--font-mono);font-size:10px;color:var(--accent-red);';

  const summary = document.createElement('div');
  summary.style.cssText = 'display:flex;align-items:center;gap:8px;';
  summary.innerHTML = `<span>\u26A0 DATA SOURCE ERRORS: ${errors.map(e => e[0]).join(', ')}</span>`
    + `<button class="btn btn-ghost" style="padding:2px 8px;font-size:9px;color:var(--accent-red);border-color:var(--accent-red);" onclick="retryAllFailed()">RETRY ALL</button>`
    + `<span style="color:var(--text-muted);cursor:pointer;font-size:9px;" onclick="this.parentElement.nextElementSibling.style.display=this.parentElement.nextElementSibling.style.display==='none'?'block':'none'">[details]</span>`;
  div.appendChild(summary);

  const details = document.createElement('div');
  details.style.cssText = 'display:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--border);';
  errors.forEach(([name, err]) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;';
    const age = err.timestamp ? formatAge(Date.now() - err.timestamp) : '';
    row.innerHTML = `<span style="min-width:90px;"><b>${name}</b></span>`
      + `<span style="color:var(--text-muted);flex:1;">${err.message}${err.status ? ' (HTTP ' + err.status + ')' : ''}${age ? ' \u2014 ' + age + ' ago' : ''}</span>`
      + `<button class="btn btn-ghost" style="padding:1px 6px;font-size:9px;color:var(--accent-cyan);" onclick="retryFailedSource('${name}')">RETRY</button>`;
    details.appendChild(row);
  });
  div.appendChild(details);

  banner.parentElement.insertBefore(div, banner.nextSibling);
}

function refreshData() {
  if (S.areaCenter) processArea(S.currentArea, S.areaType.toLowerCase());
}

// ============================================================
// PER-SECTION DATA FRESHNESS — "last updated / cached / error"
// line + UPDATE button under each data-retrieving header.
// State lives in S.sectionMeta[key]; the visible copy + button
// state come from the pure builders in sar-preflight-core.js
// (buildSectionMetaLine / rollupSources / metaToneClass).
// ------------------------------------------------------------
// `lines` lists the DOM containers (#meta_*) that show this
// section's freshness. `button:true` adds an UPDATE button there
// (once per fetch; a fetch shown in two tabs gets a button in
// each). Siblings sharing a fetch read the same S.sectionMeta key
// so their timestamps always agree.
// ============================================================
const SECTION_DEFS = {
  weather: {
    label: 'Weather', computes: 'both',
    fetch: (c, b) => fetchWeather(c.lat, c.lng),
    lines: [{ id: 'meta_wx', button: true }, { id: 'meta_vis' }, { id: 'meta_precip' },
            { id: 'meta_forecast' }, { id: 'meta_wind', button: true }],
  },
  airQuality: {
    label: 'Air Quality', computes: 'both',
    fetch: (c, b) => fetchWeather(c.lat, c.lng), // AQI is bundled in the weather fetch
    lines: [{ id: 'meta_aqi', button: true }],
  },
  spaceWx: {
    label: 'Space Weather', computes: 'assessment',
    fetch: () => fetchKpIndex(),
    lines: [{ id: 'meta_spacewx', button: true }],
  },
  alerts: {
    label: 'Weather Alerts', computes: 'assessment',
    fetch: (c, b) => fetchNWSAlerts(c.lat, c.lng),
    lines: [{ id: 'meta_alerts', button: true }],
  },
  airspace: {
    label: 'Airspace', computes: 'assessment',
    fetch: (c, b) => Promise.allSettled([fetchFAAairspace(b), fetchNearbyAirports(c, b)]),
    lines: [{ id: 'meta_airspace', button: true }, { id: 'meta_sua' }],
  },
  elevation: {
    label: 'Elevation', computes: 'both',
    fetch: (c, b) => fetchElevation(c, b),
    lines: [{ id: 'meta_elev', button: true }],
  },
  obstacles: {
    label: 'Obstacles & Hazards', computes: 'ops',
    fetch: (c, b) => Promise.allSettled([fetchWireHazards(b), fetchUtilityWires(b), fetchFaaObstacles(b), fetchProtectedAreas(b)]),
    lines: [{ id: 'meta_obstacles', button: true }],
  },
  canopy: {
    label: 'Canopy', computes: null, viewBased: true,
    fetch: () => loadCanopyForView(),
    lines: [{ id: 'meta_canopy', button: true }],
  },
  solar: {
    label: 'Solar', computes: null,
    fetch: (c, b) => fetchSunMoon(c.lat, c.lng),
    lines: [{ id: 'meta_solar', button: true }],
  },
  adsb: {
    label: 'ADS-B Traffic', computes: null, autoPoll: true,
    fetch: () => fetchAdsb(),
    lines: [{ id: 'meta_adsb', button: true }],
  },
  fireDanger: {
    label: 'Fire Danger', computes: 'assessment',
    fetch: (c, b) => fetchFireDanger(c.lat, c.lng, b),
    lines: [{ id: 'meta_fire', button: true }],
  },
  groundAccess: {
    label: 'Ground Access', computes: null,
    fetch: (c, b) => fetchGroundAccess(b),
    lines: [{ id: 'meta_ground', button: true }],
  },
  publicLands: {
    label: 'Land Ownership', computes: 'assessment',
    fetch: (c, b) => fetchPublicLands(b),
    lines: [{ id: 'meta_land', button: true }],
  },
  water: {
    label: 'Water', computes: null,
    fetch: (c, b) => fetchWaterFeatures(b),
    lines: [{ id: 'meta_water', button: true }],
  },
  hospitals: {
    label: 'Hospitals & LZs', computes: null,
    fetch: (c, b) => fetchHospitals(b),
    lines: [{ id: 'meta_hospitals', button: true }],
  },
  trails: {
    label: 'Named Trails', computes: null,
    fetch: (c, b) => fetchTrails(b),
    lines: [{ id: 'meta_trails', button: true }],
  },
};

// Can this section be refreshed right now? View-based layers (canopy) need a
// map view; everything else needs an operational area drawn.
function _sectionUpdatable(def) {
  if (!def) return false;
  if (def.viewBased) return !!S.map;
  return !!S.areaCenter;
}

// Record a section's outcome. Fetches call this in each branch:
//   success:  markSection(key, { status:'live', updatedAt: Date.now(), error: null })
//   cached:   markSection(key, { status:'cached', cachedAt: rec.timestamp, error: msg })
//   error:    markSection(key, { status:'error', error: msg })
// Pass { source:'wire'|'dof'|... } to record one sub-source of a rollup header.
function markSection(key, patch) {
  patch = patch || {};
  if (patch.status === 'error' && patch.errorAt == null) patch.errorAt = Date.now();
  const cur = S.sectionMeta[key] || { status: 'never', updatedAt: null, cachedAt: null, error: null, errorAt: null };
  if (patch.source) {
    const src = patch.source;
    const sub = Object.assign({}, patch); delete sub.source;
    cur.sources = cur.sources || {};
    cur.sources[src] = Object.assign(cur.sources[src] || {}, sub);
  } else {
    Object.assign(cur, patch);
  }
  S.sectionMeta[key] = cur;
  if (typeof document !== 'undefined') renderSectionMeta(key);
}

// Paint the freshness line(s) + UPDATE button for one section.
function renderSectionMeta(key) {
  if (typeof document === 'undefined') return;
  const def = SECTION_DEFS[key]; if (!def) return;
  const meta = S.sectionMeta[key] || { status: 'never' };
  const now = Date.now();
  const tz = (typeof _localTZ === 'function') ? _localTZ() : undefined;
  const source = meta.sources ? rollupSources(meta.sources, now) : meta;
  if (meta.loading) source.loading = true;
  const parts = buildSectionMetaLine(source, now, tz);
  const enable = parts.canUpdate && _sectionUpdatable(def) && !meta.loading;
  (def.lines || []).forEach(line => {
    const el = document.getElementById(line.id);
    if (!el) return;
    el.className = 'section-meta ' + metaToneClass(parts.tone);
    el.textContent = '';
    const span = document.createElement('span');
    span.className = 'section-updated';
    span.textContent = parts.text;
    if (parts.title) span.title = parts.title;
    el.appendChild(span);
    if (line.button) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'section-update';
      btn.textContent = meta.loading ? '…' : 'UPDATE';
      btn.disabled = !enable;
      btn.addEventListener('click', () => updateSection(key));
      el.appendChild(btn);
    }
  });
}

function renderAllSectionMeta() {
  if (typeof document === 'undefined') return;
  Object.keys(SECTION_DEFS).forEach(renderSectionMeta);
}

// UPDATE-button handler: re-fetch just this section's data.
async function updateSection(key) {
  const def = SECTION_DEFS[key]; if (!def) return;
  if (!_sectionUpdatable(def)) return;
  const meta = S.sectionMeta[key] || (S.sectionMeta[key] = { status: 'never' });
  if (meta.loading) return; // re-entrancy guard
  meta.loading = true;
  renderSectionMeta(key);
  try {
    await def.fetch(S.areaCenter, S.areaBounds); // fetch's own branches mark live/cached/error
    if (def.computes === 'ops' || def.computes === 'both') { if (typeof computeOpsData === 'function') computeOpsData(); }
    if (def.computes === 'assessment' || def.computes === 'both') { if (typeof computeAssessment === 'function') computeAssessment(); }
  } catch (e) {
    markSection(key, { status: 'error', error: e && e.message ? e.message : String(e) });
  } finally {
    if (S.sectionMeta[key]) S.sectionMeta[key].loading = false;
    renderSectionMeta(key);
    if (typeof showDataSourceStatus === 'function') showDataSourceStatus();
  }
}

// ============================================================
// TIME-AWARE DATA PANEL
// The 24 h timeline scrollbar selects an hour (S.timeIdx, 0 = NOW). The weather,
// wind, ops and assessment readouts all render from a per-hour SNAPSHOT shaped like
// the Open-Meteo `current` object (wxAtHour in core.js), so scrubbing the timeline
// re-renders the whole panel for the selected forecast hour.
// ============================================================

// Per-hour weather snapshot from the stored hourly arrays (falls back to S.wx when
// no hourly data is loaded — keeps no-arg/test callers working).
function snapshotAtIdx(idx) {
  return wxAtHour(S.wx && S.wx.hourly, idx, S.wx || {});
}

// Render the Weather tab from a snapshot (defaults to the selected hour).
function renderWeather(snap) {
  snap = snap || snapshotAtIdx(S.timeIdx || 0);
  if (snap.temperature_2m != null) setText('wxTemp', `${Math.round(snap.temperature_2m)}°F`);
  if (snap.apparent_temperature != null) setText('wxFeels', `${Math.round(snap.apparent_temperature)}°F`);
  if (snap.dew_point_2m != null) setText('wxDew', `${Math.round(snap.dew_point_2m)}°F`);
  if (snap.relative_humidity_2m != null) setText('wxHumidity', `${Math.round(snap.relative_humidity_2m)}%`);

  if (snap.surface_pressure != null) setText('wxPressure', `${(snap.surface_pressure * 0.02953).toFixed(2)} inHg`);

  // Density altitude — calcDensityAltitude is 2-arg (station pressure already
  // encodes elevation); the elevFt below is intentionally ignored by core.
  const elevFt = S.elev.center || 1500;
  if (snap.temperature_2m != null && snap.surface_pressure != null) {
    const densAlt = calcDensityAltitude(snap.temperature_2m, snap.surface_pressure, elevFt);
    setText('wxDensity', `${densAlt.toLocaleString()} ft`);
    setColor('wxDensity', densAlt < 5000 ? 'green' : densAlt < 7500 ? 'amber' : 'red');
  }

  if (snap.visibility != null) {
    const visMi = (snap.visibility / 1609.34).toFixed(1);
    setText('wxVis', `${visMi} mi`);
    setColor('wxVis', visMi > 5 ? 'green' : visMi > 3 ? 'amber' : 'red');
  }

  if (snap.cloud_cover != null) setText('wxCloud', `${snap.cloud_cover}%`);
  // Cloud ceiling — the observed METAR at NOW (authoritative), else a coarse estimate
  // from cloud cover for forecast hours. Flight category (VFR/MVFR/IFR/LIFR) is shown
  // only from the observed METAR; it is not inferred from modeled cloud cover.
  {
    const haveMetar = snap._isNow && S.metar && S.metar.ok;
    if (haveMetar) {
      const cf = S.metar.ceilingFt;
      setText('wxCeiling', (cf == null ? 'Unlimited' : `${cf.toLocaleString()} ft`) + ` (${S.metar.station})`);
      setColor('wxCeiling', (cf == null || cf >= 3000) ? 'green' : cf >= 1000 ? 'amber' : 'red');
      const fc = S.metar.fltCat || flightCategory(cf, S.metar.visSm);
      setText('wxFlightCat', fc);
      setColor('wxFlightCat', fc === 'VFR' ? 'green' : fc === 'MVFR' ? 'amber' : 'red');
    } else {
      if (snap.cloud_cover != null) {
        const cc = snap.cloud_cover;
        setText('wxCeiling', cc < 10 ? 'CLR (est)' : cc < 30 ? '15,000+ ft (est)' : cc < 70 ? '5,000-15,000 ft (est)' : '< 5,000 ft (est)');
        setColor('wxCeiling', cc < 70 ? 'green' : 'amber');
      }
      setText('wxFlightCat', snap._isNow ? '--' : '— (obs)');
      const fcEl = document.getElementById('wxFlightCat');
      if (fcEl) fcEl.classList.remove('green', 'amber', 'red', 'cyan');
    }
  }
  if (snap.weather_code != null) setText('wxConditions', wmoCodeToText(snap.weather_code));

  const precip = snap.precipitation_probability ?? 0;
  setText('wxPrecip', `${precip}%`);
  setColor('wxPrecip', precip < 20 ? 'green' : precip < 50 ? 'amber' : 'red');
  setText('wxLightning', snap.weather_code >= 95 ? 'Active' : precip > 40 ? 'Possible' : 'None');
  setColor('wxLightning', snap.weather_code >= 95 ? 'red' : precip > 40 ? 'amber' : 'green');
  setText('wxUV', snap.uv_index?.toFixed(1) ?? '--');

  const icing = assessPropIcing(snap.temperature_2m, snap.dew_point_2m);
  setText('wxIcing', icing.reason ? `${icing.risk} — ${icing.reason}` : icing.risk);
  setColor('wxIcing', icing.level);

  // Freezing level (0°C isotherm, MSL). Amber when it sits within the flight
  // envelope (launch elevation up to launch + max AGL) — icing risk aloft.
  if (snap.freezing_level_height != null) {
    const fzFt = Math.round(snap.freezing_level_height * 3.28084);
    setText('wxFreezing', `${fzFt.toLocaleString()} ft MSL`);
    const topFt = (S.elev.center ?? 0) + 400;
    setColor('wxFreezing', fzFt > topFt ? 'green' : 'amber');
  }

  if (snap.relative_humidity_2m != null) {
    const rh = snap.relative_humidity_2m;
    const fireDanger = rh < 20 ? 'Very High' : rh < 30 ? 'High' : rh < 45 ? 'Moderate' : 'Low';
    setText('wxFire', fireDanger);
    setColor('wxFire', rh < 20 ? 'red' : rh < 30 ? 'red' : rh < 45 ? 'amber' : 'green');
  }
}

// Render the Wind tab from a snapshot (defaults to the selected hour). Rebuilds
// S.wind so downstream computeOpsData/computeAssessment see the same hour.
function renderWind(snap) {
  snap = snap || snapshotAtIdx(S.timeIdx || 0);
  const groundWind = Math.round(snap.wind_speed_10m);
  const groundGust = Math.round(snap.wind_gusts_10m);
  const groundDir = Math.round(snap.wind_direction_10m);

  const w80 = Math.round(snap.wind_speed_80m ?? groundWind * 1.3);
  const w120 = Math.round(snap.wind_speed_120m ?? groundWind * 1.5);
  const w180 = Math.round(snap.wind_speed_180m ?? groundWind * 1.7);
  const d80 = Math.round(snap.wind_direction_80m ?? groundDir);
  const d120 = Math.round(snap.wind_direction_120m ?? groundDir);
  const d180 = Math.round(snap.wind_direction_180m ?? groundDir);

  const windProfile = [
    { alt: 'Ground (10m)', speed: groundWind, gust: groundGust, dir: groundDir },
    { alt: '100 ft AGL', speed: Math.round(lerp(groundWind, w80, 0.37)), gust: Math.round(groundGust * 1.1), dir: Math.round(lerp(groundDir, d80, 0.37)) },
    { alt: '200 ft AGL', speed: Math.round(lerp(groundWind, w80, 0.74)), gust: Math.round(groundGust * 1.2), dir: Math.round(lerp(groundDir, d80, 0.74)) },
    { alt: '300 ft AGL', speed: Math.round(lerp(w80, w120, 0.5)), gust: Math.round(groundGust * 1.3), dir: Math.round(lerp(d80, d120, 0.5)) },
    { alt: '400 ft AGL', speed: w120, gust: Math.round(groundGust * 1.4), dir: d120 },
  ];
  S.wind = { profile: windProfile, maxWind: Math.max(...windProfile.map(w => w.speed)), maxGust: Math.max(...windProfile.map(w => w.gust)) };

  document.getElementById('windTableBody').innerHTML = windProfile.map(w =>
    `<tr><td>${w.alt}</td><td>${w.speed} mph</td><td>${w.gust} mph</td><td>${w.dir}° (${degToCompass(w.dir)})</td></tr>`
  ).join('');

  setText('windMax', `${S.wind.maxWind} mph`);
  setColor('windMax', S.wind.maxWind < 15 ? 'green' : S.wind.maxWind < 25 ? 'amber' : 'red');
  setText('windGustMax', `${S.wind.maxGust} mph`);
  setColor('windGustMax', S.wind.maxGust < 20 ? 'green' : S.wind.maxGust < 30 ? 'amber' : 'red');
  setText('windDir', `${groundDir}° (${degToCompass(groundDir)})`);
  setText('windImpact', S.wind.maxWind < 10 ? 'Minimal — full flight time' : S.wind.maxWind < 20 ? 'Moderate — ~15% battery penalty' : 'Significant — ~30% battery penalty');

  const gustFactor = calcGustFactor(S.wind.maxGust, S.wind.maxWind);
  setText('windGustFactor', gustFactor > 0 ? `${gustFactor.toFixed(1)}x` : '--');
  setColor('windGustFactor', gustFactor < 1.5 ? 'green' : gustFactor <= 2.0 ? 'amber' : 'red');

  const shear = calcWindShear(windProfile);
  setText('windShear', `${shear.maxSpeedChange}mph / ${shear.maxDirChange}°`);
  setColor('windShear', shear.level);

  if (S.elev.points && typeof assessTerrainTurbulence === 'function') {
    const elevFtArray = S.elev.points.map(p => p.elevFt);
    const turbulence = assessTerrainTurbulence(elevFtArray, S.elev.gridSize, S.elev.range, groundDir, groundWind);
    const factorText = turbulence.factors.join('; ');
    setText('windTurbulence', `${turbulence.risk.toUpperCase()} — ${factorText}`);
    setColor('windTurbulence', turbulence.level);
  }
}

// Re-render the whole data panel for the currently-selected timeline hour.
function refreshPanelForHour() {
  if (!S.wx || !S.wx.hourly) return;
  const snap = snapshotAtIdx(S.timeIdx || 0);
  renderWeather(snap);
  renderWind(snap);
  // Kp / GNSS for the selected hour (SWPC 3-hourly forecast). Update S.kp BEFORE
  // the assessment so the Kp caution gate reflects the selected hour too.
  if (S.kpForecast && S.kpForecast.length && snap._time && typeof kpAtTime === 'function') {
    const kp = kpAtTime(S.kpForecast, new Date(snap._time).getTime());
    if (kp != null) { S.kp = kp; renderKp(kp); }
  }
  if (S.currentArea) { computeOpsData(snap); computeAssessment(snap); }
  updateTimeContextBanner();
}

// Show/hide the "viewing a forecast hour, not NOW" banner above the data panel.
function updateTimeContextBanner() {
  const el = document.getElementById('panelTimeContext');
  if (!el) return;
  const idx = S.timeIdx || 0;
  const hourly = S.wx && S.wx.hourly;
  if (!idx || !hourly || !hourly.time || !hourly.time[idx]) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const tstr = new Date(hourly.time[idx]).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: _localTZ() });
  el.style.display = 'block';
  el.innerHTML = `<strong>FORECAST +${idx}h — ${tstr}</strong> (not current). ` +
    `Airspace, TFRs, fire &amp; live traffic shown are current-time and may change.`;
}

// ============================================================
// API: OPEN-METEO — Weather + Wind + AQI (FREE, no key)
// ============================================================
async function fetchWeather(lat, lng) {
  trackFetchStart('Weather');
  setStatus('wxStatus', 'loading', 'Fetching...');
  setStatus('windStatus', 'loading', 'Fetching...');
  try {
    const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,surface_pressure,` +
      `cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,` +
      `weather_code,uv_index,is_day` +
      `&hourly=wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_80m,wind_direction_120m,wind_direction_180m` +
      `,temperature_2m,dew_point_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,weather_code,freezing_level_height` +
      `,relative_humidity_2m,apparent_temperature,surface_pressure,visibility,uv_index,is_day` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto` +
      `&forecast_hours=24`;

    const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
      `&current=us_aqi,pm2_5,pm10,ozone&timezone=auto`;

    const [wxRes, aqiRes] = await Promise.all([fetch(wxUrl), fetch(aqiUrl)]);
    const wx = await wxRes.json();
    const aqi = await aqiRes.json();

    if (wx.current) {
      S.wx = wx.current;
    }

    // Store hourly forecast arrays BEFORE rendering so the panel can render any
    // selected timeline hour via snapshotAtIdx(). Includes upper winds (80/120/180m
    // — previously fetched then discarded) and the fields needed for a fully
    // time-aware panel (humidity, apparent temp, pressure, visibility, UV).
    if (wx.hourly && wx.hourly.time) {
      S.wx.hourly = {
        time: wx.hourly.time,
        temperature_2m: wx.hourly.temperature_2m,
        dew_point_2m: wx.hourly.dew_point_2m,
        apparent_temperature: wx.hourly.apparent_temperature,
        relative_humidity_2m: wx.hourly.relative_humidity_2m,
        surface_pressure: wx.hourly.surface_pressure,
        visibility: wx.hourly.visibility,
        uv_index: wx.hourly.uv_index,
        precipitation_probability: wx.hourly.precipitation_probability,
        wind_speed_10m: wx.hourly.wind_speed_10m,
        wind_direction_10m: wx.hourly.wind_direction_10m,
        wind_gusts_10m: wx.hourly.wind_gusts_10m,
        wind_speed_80m: wx.hourly.wind_speed_80m,
        wind_speed_120m: wx.hourly.wind_speed_120m,
        wind_speed_180m: wx.hourly.wind_speed_180m,
        wind_direction_80m: wx.hourly.wind_direction_80m,
        wind_direction_120m: wx.hourly.wind_direction_120m,
        wind_direction_180m: wx.hourly.wind_direction_180m,
        cloud_cover: wx.hourly.cloud_cover,
        weather_code: wx.hourly.weather_code,
        freezing_level_height: wx.hourly.freezing_level_height,
        is_day: wx.hourly.is_day,
      };
    }

    if (wx.current) {
      // New data → reset the timeline to NOW and render hour 0 into the panel.
      S.timeIdx = 0;
      const snap = snapshotAtIdx(0);
      renderWeather(snap);
      renderWind(snap);

      setStatus('wxStatus', 'live', 'LIVE');
      setStatus('windStatus', 'live', 'LIVE');
      clearDataSourceError('Weather');
      markSection('weather', { status: 'live', updatedAt: Date.now(), error: null });
    }

    if (wx.hourly && wx.hourly.time) {
      renderForecastChart(S.wx.hourly);
      initTimeBar();
      updateTimeContextBanner();
    }

    // AQI
    if (aqi.current) {
      S.aqi = aqi.current.us_aqi;  // expose for the risk assessment (AQI gate)
      setText('wxAQI', `${aqi.current.us_aqi}`);
      setColor('wxAQI', aqi.current.us_aqi < 50 ? 'green' : aqi.current.us_aqi < 100 ? 'amber' : 'red');
      setText('wxPM25', `${aqi.current.pm2_5?.toFixed(1)} µg/m³`);
      setText('wxPM10', `${aqi.current.pm10?.toFixed(1) ?? '--'} µg/m³`);
      setText('wxOzone', `${aqi.current.ozone?.toFixed(1) ?? '--'} µg/m³`);
      markSection('airQuality', { status: 'live', updatedAt: Date.now(), error: null });
    }

    // Cache weather and AQI data to IndexedDB
    if (typeof cacheApiResponse === 'function') {
      const k = areaKey(lat, lng);
      cacheApiResponse('weather', k, wx);
      cacheApiResponse('aqi', k, aqi);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    await fetchKpIndex();

  } catch (err) {
    console.error('Weather fetch error:', err);
    recordDataSourceError('Weather', err);
    const _wxErrMsg = err && err.message ? err.message : String(err);
    markSection('weather', { status: 'error', error: _wxErrMsg });
    markSection('airQuality', { status: 'error', error: _wxErrMsg });
    // Try cached weather data before showing ERROR
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(lat, lng) : `${lat.toFixed(3)}_${lng.toFixed(3)}`;
        const cachedWx = await getCachedApiResponse('weather', k);
        if (cachedWx && cachedWx.data) {
          const c = cachedWx.data.current || cachedWx.data;
          S.wx = c;
          setText('wxTemp', `${Math.round(c.temperature_2m)}°F`);
          const visMi = (c.visibility / 1609.34).toFixed(1);
          setText('wxVis', `${visMi} mi`);
          setColor('wxVis', visMi > 5 ? 'green' : visMi > 3 ? 'amber' : 'red');
          setText('wxPrecip', `${c.precipitation_probability ?? 0}%`);
          const groundWind = Math.round(c.wind_speed_10m);
          const groundGust = Math.round(c.wind_gusts_10m);
          setText('windMax', `${groundWind} mph`);
          setColor('windMax', groundWind < 15 ? 'green' : groundWind < 25 ? 'amber' : 'red');
          setText('windGustMax', `${groundGust} mph`);
          setColor('windGustMax', groundGust < 20 ? 'green' : groundGust < 30 ? 'amber' : 'red');
          const age = Date.now() - cachedWx.timestamp;
          const badge = cachedWx.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('wxStatus', badge, label);
          setStatus('windStatus', badge, label);
          markSection('weather', { status: 'cached', cachedAt: cachedWx.timestamp, error: _wxErrMsg });
        } else {
          setStatus('wxStatus', 'error', 'ERROR');
          setStatus('windStatus', 'error', 'ERROR');
        }
        const cachedAqi = await getCachedApiResponse('aqi', k);
        if (cachedAqi && cachedAqi.data && cachedAqi.data.current) {
          S.aqi = cachedAqi.data.current.us_aqi;  // expose for the risk assessment (AQI gate)
          setText('wxAQI', `${cachedAqi.data.current.us_aqi}`);
          setColor('wxAQI', cachedAqi.data.current.us_aqi < 50 ? 'green' : cachedAqi.data.current.us_aqi < 100 ? 'amber' : 'red');
          markSection('airQuality', { status: 'cached', cachedAt: cachedAqi.timestamp, error: _wxErrMsg });
        }
      } catch (cacheErr) {
        console.warn('Weather cache fallback failed:', cacheErr);
        setStatus('wxStatus', 'error', 'ERROR');
        setStatus('windStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('wxStatus', 'error', 'ERROR');
      setStatus('windStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Weather');
  }
}

// ============================================================
// API: AVIATION WEATHER — observed METAR (ceiling / visibility / flight category)
// Feeds the Part 107 \u00a7107.51(c) cloud-clearance gate and the Flight Category readout.
// Source: NWS api.weather.gov station observations (CORS-enabled). aviationweather.gov's
// API does NOT send CORS headers, so a browser fetch to it always fails with a
// NetworkError — verified 2026-07-12. The NWS observation includes the raw METAR text.
// The feature stays dormant (no hard error, just no observed ceiling) on any failure.
// ============================================================
async function fetchAviationWeather(center, bounds) {
  const c = center || S.areaCenter;
  if (!c) return;
  try {
    const pr = await fetch(`https://api.weather.gov/points/${c.lat.toFixed(4)},${c.lng.toFixed(4)}`);
    if (!pr.ok) throw new Error('NWS points HTTP ' + pr.status);
    const pj = await pr.json();
    const stationsUrl = pj.properties && pj.properties.observationStations;
    if (!stationsUrl) throw new Error('NWS points: no observationStations');
    const sr = await fetch(stationsUrl);
    if (!sr.ok) throw new Error('NWS stations HTTP ' + sr.status);
    const sj = await sr.json();
    // Stations arrive nearest-first, but the closest are often AUTO sites reporting
    // no ceiling/visibility (e.g. 'KBQP ... PWINO') — walk the list until one is usable.
    let metar = null;
    for (const st of (sj.features || []).slice(0, 4)) {
      metar = await _fetchStationObservation(st, c.lat, c.lng);
      if (metar) break;
    }
    S.metar = metar;
    if (metar) { renderAviationWx(); clearDataSourceError('Aviation Wx'); }
  } catch (e) {
    S.metar = null;
    recordDataSourceError('Aviation Wx', e);
  }
}

// Fetch one station's latest observation and normalize it to the S.metar shape.
// Returns null when the station has nothing usable (offline, or no cloud/visibility
// data at all), so the caller can try the next-nearest station.
async function _fetchStationObservation(st, lat, lng) {
  try {
    const id = st && st.properties && st.properties.stationIdentifier;
    if (!id) return null;
    const r = await fetch(`https://api.weather.gov/stations/${id}/observations/latest`);
    if (!r.ok) return null;
    const p = (await r.json()).properties || {};
    const clouds = (p.cloudLayers || [])
      .filter(cl => cl && cl.base && cl.base.value != null)
      .map(cl => ({ cover: cl.amount, base: Math.round(cl.base.value * 3.28084) })); // m \u2192 ft
    const visSm = (p.visibility && p.visibility.value != null)
      ? p.visibility.value / 1609.344 : null; // m \u2192 statute miles
    if (!clouds.length && visSm == null) return null; // nothing usable \u2014 try next station
    const ceilingFt = metarCeilingFt(clouds);
    const co = st.geometry && st.geometry.coordinates; // [lon, lat]
    const dKm = co ? haversine(lat, lng, co[1], co[0]) : null;
    return {
      ok: true,
      station: id,
      name: (st.properties && st.properties.name) || '',
      distNm: dKm != null ? dKm * 0.539957 : null,
      ceilingFt,
      visSm,
      fltCat: flightCategory(ceilingFt, visSm),
      obsTime: p.timestamp ? Date.parse(p.timestamp) : null,
      raw: p.rawMessage || '',
      lat: co ? co[1] : null, lon: co ? co[0] : null,
    };
  } catch (e) { return null; }
}

// Refresh the panel + assessment after a new observation lands (the Flight Category
// and observed ceiling render inside renderWeather when NOW is the selected hour).
function renderAviationWx() {
  const snap = snapshotAtIdx(S.timeIdx || 0);
  renderWeather(snap);
  if (S.currentArea) computeAssessment(snap);
}

// Render the Kp / GNSS readouts (wxKp, satKp, accuracy, assessment, sat table) for
// a given Kp value. Called for NOW by fetchKpIndex and for the selected timeline
// hour by refreshPanelForHour (the SWPC forecast is genuinely time-varying).
function renderKp(kp) {
  setText('wxKp', kp.toFixed(1));
  setColor('wxKp', kp <= 3 ? 'green' : kp <= 5 ? 'amber' : 'red');
  setText('satKp', kp.toFixed(1));
  setColor('satKp', kp <= 3 ? 'green' : kp <= 5 ? 'amber' : 'red');
  setText('satAccuracy', kp <= 3 ? '< 2m horizontal' : '2-5m horizontal');
  setText('satAssessment', kp <= 3 ? 'Nominal — good GNSS conditions' : kp <= 5 ? 'Marginal — monitor positioning' : 'Degraded — expect position errors');

  const baseSats = kp <= 3 ? 20 : kp <= 5 ? 16 : 12;

  // GPS Terrain Masking — adjust sat count if terrain data available
  let skyVisPct = 100;
  if (S.elev.points && typeof analyzeGPSMasking === 'function') {
    const masking = analyzeGPSMasking(S.elev.center, S.elev.points, S.elev.gridSize, 400);
    skyVisPct = masking.skyVisibilityPct;
    setText('satSkyVis', `${skyVisPct}%`);
    setColor('satSkyVis', skyVisPct > 80 ? 'green' : skyVisPct > 60 ? 'amber' : 'red');
    setText('satMasked', masking.maskedDirections.length > 0 ? masking.maskedDirections.join(', ') : 'None');
    setColor('satMasked', masking.maskedDirections.length === 0 ? 'green' : masking.maskedDirections.length <= 2 ? 'amber' : 'red');
  }

  const tbody = document.getElementById('satTableBody');
  if (tbody) tbody.innerHTML = [100,200,300,400].map(alt => {
    const rawSats = baseSats + Math.round(alt/200);
    const sats = Math.round(rawSats * skyVisPct / 100);
    const pdop = (1.0 + kp * 0.3 - alt/1000).toFixed(1);
    const q = sats > 16 ? 'Excellent' : sats > 12 ? 'Good' : 'Fair';
    const qColor = sats > 16 ? 'var(--accent-green)' : sats > 12 ? 'var(--accent-amber)' : 'var(--accent-red)';
    return `<tr><td>Below ${alt} ft</td><td>${sats} sats</td><td>${pdop}</td><td style="color:${qColor}">${q}</td></tr>`;
  }).join('');
}

// Parse the SWPC forecast JSON (row 0 is headers) into [{t, kp}] (t in ms).
function _parseKpForecast(data) {
  const rows = [];
  if (!Array.isArray(data)) return rows;
  for (let i = 1; i < data.length; i++) {
    const t = new Date(data[i][0] + ' UTC').getTime();
    const kpv = parseFloat(data[i][1]);
    if (!isNaN(t) && !isNaN(kpv)) rows.push({ t, kp: kpv });
  }
  return rows;
}

async function fetchKpIndex() {
  trackFetchStart('Kp Index');
  try {
    const res = await fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
    const data = await res.json();
    // Keep the whole 3-hourly forecast so the timeline can show Kp per selected hour.
    S.kpForecast = _parseKpForecast(data);
    const kp = kpAtTime(S.kpForecast, Date.now()) ?? 2;
    S.kp = kp;  // expose for the risk assessment (Kp caution gate)
    renderKp(kp);

    // Cache Kp data
    if (typeof cacheApiResponse === 'function') cacheApiResponse('kp', 'global', data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());
    markSection('spaceWx', { status: 'live', updatedAt: Date.now(), error: null });
  } catch(e) {
    console.warn('Kp fetch failed', e);
    const _kpErrMsg = e && e.message ? e.message : String(e);
    markSection('spaceWx', { status: 'error', error: _kpErrMsg });
    // Try cached Kp data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('kp', 'global');
        if (cached && cached.data) {
          S.kpForecast = _parseKpForecast(cached.data);
          const kp = kpAtTime(S.kpForecast, Date.now()) ?? (parseFloat(cached.data[1]?.[1]) || 2);
          S.kp = kp;  // expose for the risk assessment (Kp caution gate)
          renderKp(kp);
          markSection('spaceWx', { status: 'cached', cachedAt: cached.timestamp, error: _kpErrMsg });
        }
      } catch (cacheErr) { console.warn('Kp cache fallback failed:', cacheErr); }
    }
  } finally {
    trackFetchEnd('Kp Index');
  }
}

// ============================================================
// FORECAST CHART (24h SVG)
// ============================================================
function renderForecastChart(hourlyData) {
  const container = document.getElementById('forecastChart');
  const section = document.getElementById('forecastSection');
  if (!container || !section) return;
  if (!hourlyData || !hourlyData.time || hourlyData.time.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  const times = hourlyData.time;
  const temps = hourlyData.temperature_2m || [];
  const dews = hourlyData.dew_point_2m || [];
  const winds = hourlyData.wind_speed_10m || [];
  const precips = hourlyData.precipitation_probability || [];
  const n = Math.min(times.length, 24);
  if (n === 0) { section.style.display = 'none'; return; }

  const W = 440, H = 180, padL = 36, padR = 10, padT = 18, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Auto-scale temp & wind
  const tSlice = temps.slice(0, n), wSlice = winds.slice(0, n), pSlice = precips.slice(0, n);
  const dSlice = dews.slice(0, n);
  const tMin = Math.min(...tSlice.filter(v => v != null)), tMax = Math.max(...tSlice.filter(v => v != null));
  const wMin = 0, wMax = Math.max(Math.max(...wSlice.filter(v => v != null)), 5);
  const tRange = Math.max(tMax - tMin, 1), wRange = Math.max(wMax - wMin, 1);

  const icingByHour = tSlice.map((t, i) => assessPropIcing(t, dSlice[i]));

  function xPos(i) { return padL + (i / (n - 1)) * plotW; }
  function yTemp(v) { return padT + plotH - ((v - tMin) / tRange) * plotH; }
  function yWind(v) { return padT + plotH - ((v - wMin) / wRange) * plotH; }

  // Build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">`;
  // Background grid lines
  for (let i = 0; i < n; i += 3) {
    const x = xPos(i);
    svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="0.5"/>`;
  }

  // Icing risk bands (drawn under precip/temp/wind so they appear in background)
  for (let i = 0; i < n; i++) {
    const sev = icingByHour[i].severity;
    if (sev === 'none') continue;
    const bandColor = sev === 'nogo' ? '#ff4d4d' : '#4db8ff';
    const bandOpacity = sev === 'nogo' ? 0.22 : 0.15;
    const x0 = i === 0 ? padL : (xPos(i - 1) + xPos(i)) / 2;
    const x1 = i === n - 1 ? padL + plotW : (xPos(i) + xPos(i + 1)) / 2;
    svg += `<rect x="${x0.toFixed(1)}" y="${padT}" width="${(x1 - x0).toFixed(1)}" height="${plotH}" fill="${bandColor}" opacity="${bandOpacity}" pointer-events="none"/>`;
  }

  // Precip bars (bottom, blue fill)
  const barW = Math.max(plotW / n * 0.6, 2);
  for (let i = 0; i < n; i++) {
    const p = pSlice[i] ?? 0;
    if (p <= 0) continue;
    const barH = (p / 100) * plotH * 0.4;
    const x = xPos(i) - barW / 2;
    const y = padT + plotH - barH;
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="var(--accent-blue)" opacity="0.35" rx="1"/>`;
  }

  // Temp polyline (cyan)
  let tempPts = [];
  for (let i = 0; i < n; i++) { if (tSlice[i] != null) tempPts.push(`${xPos(i).toFixed(1)},${yTemp(tSlice[i]).toFixed(1)}`); }
  if (tempPts.length > 1) svg += `<polyline points="${tempPts.join(' ')}" fill="none" stroke="var(--accent-cyan)" stroke-width="1.8" stroke-linejoin="round"/>`;

  // Wind polyline (amber)
  let windPts = [];
  for (let i = 0; i < n; i++) { if (wSlice[i] != null) windPts.push(`${xPos(i).toFixed(1)},${yWind(wSlice[i]).toFixed(1)}`); }
  if (windPts.length > 1) svg += `<polyline points="${windPts.join(' ')}" fill="none" stroke="var(--accent-amber)" stroke-width="1.8" stroke-linejoin="round"/>`;

  // X-axis labels every 3 hours
  for (let i = 0; i < n; i += 3) {
    const x = xPos(i);
    const dt = new Date(times[i]);
    const label = dt.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: _localTZ() }).replace(' ', '');
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-muted)" font-family="var(--font-mono)" font-size="8">${label}</text>`;
  }

  // Y-axis labels (temp left)
  svg += `<text x="${padL - 4}" y="${padT + 4}" text-anchor="end" fill="var(--accent-cyan)" font-family="var(--font-mono)" font-size="8">${Math.round(tMax)}\u00b0</text>`;
  svg += `<text x="${padL - 4}" y="${padT + plotH}" text-anchor="end" fill="var(--accent-cyan)" font-family="var(--font-mono)" font-size="8">${Math.round(tMin)}\u00b0</text>`;
  // Y-axis labels (wind right)
  svg += `<text x="${W - padR + 2}" y="${padT + 4}" text-anchor="start" fill="var(--accent-amber)" font-family="var(--font-mono)" font-size="8">${Math.round(wMax)}mph</text>`;

  // "now" marker
  const nowMs = Date.now();
  const t0 = new Date(times[0]).getTime();
  const tN = new Date(times[n - 1]).getTime();
  if (nowMs >= t0 && nowMs <= tN) {
    const frac = (nowMs - t0) / (tN - t0);
    const nx = padL + frac * plotW;
    svg += `<line x1="${nx}" y1="${padT}" x2="${nx}" y2="${padT + plotH}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,3"/>`;
    svg += `<text x="${nx}" y="${padT - 4}" text-anchor="middle" fill="var(--text-muted)" font-family="var(--font-mono)" font-size="7">NOW</text>`;
  }

  // Legend
  svg += `<circle cx="${padL}" cy="${H - 16}" r="3" fill="var(--accent-cyan)"/><text x="${padL + 6}" y="${H - 13}" fill="var(--accent-cyan)" font-family="var(--font-mono)" font-size="7">Temp</text>`;
  svg += `<circle cx="${padL + 40}" cy="${H - 16}" r="3" fill="var(--accent-amber)"/><text x="${padL + 46}" y="${H - 13}" fill="var(--accent-amber)" font-family="var(--font-mono)" font-size="7">Wind</text>`;
  svg += `<rect x="${padL + 80}" y="${H - 19}" width="6" height="6" fill="var(--accent-blue)" opacity="0.5" rx="1"/><text x="${padL + 90}" y="${H - 13}" fill="var(--accent-blue)" font-family="var(--font-mono)" font-size="7">Precip%</text>`;
  svg += `<rect x="${padL + 130}" y="${H - 19}" width="6" height="6" fill="#4db8ff" opacity="0.4" rx="1"/><text x="${padL + 140}" y="${H - 13}" fill="#4db8ff" font-family="var(--font-mono)" font-size="7">Icing</text>`;

  // Interactive crosshair + tooltip (hidden until hover)
  svg += `<line id="fc-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--text-secondary)" stroke-width="1" stroke-dasharray="2,2" style="display:none"/>`;
  svg += `<circle id="fc-dot-t" r="3" fill="var(--accent-cyan)" style="display:none"/>`;
  svg += `<circle id="fc-dot-w" r="3" fill="var(--accent-amber)" style="display:none"/>`;
  svg += `<g id="fc-tip" style="display:none">`;
  svg += `<rect id="fc-tip-bg" rx="6" fill="var(--bg-elevated)" stroke="var(--border)" stroke-width="0.5" opacity="0.95" x="0" y="0" width="192" height="128"/>`;
  svg += `<text id="fc-tip-time" font-family="var(--font-mono)" font-size="16" fill="var(--text-secondary)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-temp" font-family="var(--font-mono)" font-size="16" fill="var(--accent-cyan)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-wind" font-family="var(--font-mono)" font-size="16" fill="var(--accent-amber)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-prec" font-family="var(--font-mono)" font-size="16" fill="var(--accent-blue)" x="0" y="0"></text>`;
  svg += `<text id="fc-tip-ice" font-family="var(--font-mono)" font-size="16" fill="#4db8ff" x="0" y="0"></text>`;
  svg += `</g>`;
  svg += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" id="fc-overlay"/>`;

  svg += `</svg>`;
  container.innerHTML = svg;

  // Attach tooltip interaction
  const svgEl = container.querySelector('svg');
  if (svgEl) {
    const cd = { times: times.slice(0, n), temps: tSlice, winds: wSlice, precips: pSlice, icing: icingByHour, n, W, padL, plotW, plotH, padT, xPos, yTemp, yWind };
    const overlay = svgEl.querySelector('#fc-overlay');
    if (overlay) {
      overlay.addEventListener('mousemove', function(ev) { _fcTooltipMove(ev.clientX, svgEl, cd); });
      overlay.addEventListener('mouseleave', function() { _fcTooltipHide(svgEl); });
      // Touch: tap/drag to scrub. preventDefault stops the panel scrolling while scrubbing.
      // Box stays visible after lift (no hover on touch to fall back to).
      const onTouch = function(ev) {
        if (!ev.touches || ev.touches.length === 0) return;
        ev.preventDefault();
        _fcTooltipMove(ev.touches[0].clientX, svgEl, cd);
      };
      overlay.addEventListener('touchstart', onTouch, { passive: false });
      overlay.addEventListener('touchmove', onTouch, { passive: false });
    }
  }
}

function _fcTooltipMove(clientX, svg, d) {
  const rect = svg.getBoundingClientRect();
  const mx = (clientX - rect.left) / rect.width * d.W;
  const frac = (mx - d.padL) / d.plotW;
  if (frac < 0 || frac > 1) { _fcTooltipHide(svg); return; }

  const idx = Math.max(0, Math.min(d.n - 1, Math.round(frac * (d.n - 1))));
  const cx = d.xPos(idx);

  // Crosshair line
  const cross = svg.querySelector('#fc-cross');
  cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
  cross.style.display = '';

  // Data point dots
  const dotT = svg.querySelector('#fc-dot-t');
  const dotW = svg.querySelector('#fc-dot-w');
  if (d.temps[idx] != null) { dotT.setAttribute('cx', cx); dotT.setAttribute('cy', d.yTemp(d.temps[idx])); dotT.style.display = ''; }
  else dotT.style.display = 'none';
  if (d.winds[idx] != null) { dotW.setAttribute('cx', cx); dotW.setAttribute('cy', d.yWind(d.winds[idx])); dotW.style.display = ''; }
  else dotW.style.display = 'none';

  // Values
  const dt = new Date(d.times[idx]);
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: _localTZ() });
  const temp = d.temps[idx] != null ? Math.round(d.temps[idx]) + '\u00b0F' : '--';
  const wind = d.winds[idx] != null ? Math.round(d.winds[idx]) + ' mph' : '--';
  const prec = d.precips[idx] != null ? d.precips[idx] + '%' : '--';
  const ice = d.icing?.[idx]?.risk ?? '--';

  // Position tooltip (192x128 box; flip + clamp to stay inside the 440-wide viewBox)
  const BOX_W = 192, GAP = 8;
  let tipX = (cx + GAP + BOX_W <= d.W) ? cx + GAP : cx - GAP - BOX_W;
  tipX = Math.max(0, Math.min(tipX, d.W - BOX_W));
  const tipY = d.padT + 4;

  svg.querySelector('#fc-tip-bg').setAttribute('x', tipX);
  svg.querySelector('#fc-tip-bg').setAttribute('y', tipY);
  const tx = tipX + 10;
  const el = (id, text, y) => { const t = svg.querySelector(id); t.textContent = text; t.setAttribute('x', tx); t.setAttribute('y', y); };
  el('#fc-tip-time', timeStr, tipY + 22);
  el('#fc-tip-temp', temp, tipY + 44);
  el('#fc-tip-wind', wind, tipY + 66);
  el('#fc-tip-prec', prec, tipY + 88);
  el('#fc-tip-ice', `Ice: ${ice}`, tipY + 110);
  svg.querySelector('#fc-tip').style.display = '';
}

function _fcTooltipHide(svg) {
  ['#fc-cross', '#fc-dot-t', '#fc-dot-w', '#fc-tip'].forEach(id => {
    const el = svg.querySelector(id);
    if (el) el.style.display = 'none';
  });
}

// ============================================================
// API: OPEN-ELEVATION (FREE)
// ============================================================
async function fetchElevation(center, bounds) {
  trackFetchStart('Elevation');
  setStatus('elevStatus', 'loading', 'Fetching...');
  try {
    const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();

    // Use 25-point grid if core function is available, else fall back to 9-point
    let points;
    let gridSize = 0;
    if (typeof generateElevationGrid === 'function') {
      points = generateElevationGrid(center.lat, center.lng, ne, sw, 5);
      gridSize = 5;
    } else {
      const mid = center;
      points = [
        { latitude: center.lat, longitude: center.lng },
        { latitude: ne.lat, longitude: ne.lng },
        { latitude: ne.lat, longitude: sw.lng },
        { latitude: sw.lat, longitude: ne.lng },
        { latitude: sw.lat, longitude: sw.lng },
        { latitude: mid.lat, longitude: ne.lng },
        { latitude: mid.lat, longitude: sw.lng },
        { latitude: ne.lat, longitude: mid.lng },
        { latitude: sw.lat, longitude: mid.lng },
      ];
      gridSize = 3;
    }

    const res = await fetch('https://api.open-elevation.com/api/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: points }),
    });
    const data = await res.json();

    // Store full point array with elevation data
    const elevPoints = data.results.map((r, i) => ({
      lat: points[i].latitude,
      lng: points[i].longitude,
      elevFt: Math.round(r.elevation * 3.28084),
    }));
    const elevations = elevPoints.map(p => p.elevFt);
    const centerElev = elevations[0];
    const minElev = Math.min(...elevations);
    const maxElev = Math.max(...elevations);
    const range = maxElev - minElev;

    // Calculate cell size using haversine between adjacent grid points
    let cellSizeKm = 0;
    if (gridSize >= 2 && elevPoints.length >= 2) {
      cellSizeKm = haversine(elevPoints[0].lat, elevPoints[0].lng, elevPoints[1].lat, elevPoints[1].lng);
    }

    S.elev = { center: centerElev, min: minElev, max: maxElev, range, points: elevPoints, gridSize, cellSizeKm };

    setText('terrMin', `${minElev.toLocaleString()} ft AMSL`);
    setText('terrMax', `${maxElev.toLocaleString()} ft AMSL`);
    setText('terrRange', `${range.toLocaleString()} ft`);
    setColor('terrRange', range < 200 ? 'green' : range < 800 ? 'amber' : 'red');
    setText('terrLaunch', `${centerElev.toLocaleString()} ft AMSL`);

    // Uses extracted core functions
    setText('terrClass', classifyTerrain(centerElev));

    // Compute slope using grid if available, else fallback to diagonal
    if (gridSize >= 3 && cellSizeKm > 0 && typeof calcSlopeFromGrid === 'function') {
      const slopes = calcSlopeFromGrid(elevations, gridSize, cellSizeKm);
      const maxSlope = slopes.length > 0 ? Math.max(...slopes) : 0;
      const avgSlope = slopes.length > 0 ? slopes.reduce((a, b) => a + b, 0) / slopes.length : 0;
      const slopePerKm = cellSizeKm > 0 ? Math.round(range / (cellSizeKm * (gridSize - 1))) : 0;
      setText('terrSlope', `~${slopePerKm} ft/km`);
    } else {
      const ne2sw = Math.abs(elevations[1] - elevations[Math.min(4, elevations.length - 1)]);
      const diagDistKm = center.distanceTo(ne) / 1000;
      const slopePerKm = diagDistKm > 0 ? Math.round(ne2sw / diagDistKm) : 0;
      setText('terrSlope', `~${slopePerKm} ft/km`);
    }

    setText('terrVeg', estimateVegetation(centerElev));

    const cell = cellCoverageReadout(center.lat, center.lng, centerElev);
    S.cellStatus = cell;
    setText('terrCell', cell.label);
    setColor('terrCell', cell.level);

    // Terrain feature detection
    if (typeof detectTerrainFeatures === 'function' && gridSize >= 3) {
      const features = detectTerrainFeatures(elevations, gridSize, range);
      renderTerrainFeatures(features);
    }

    // Find emergency LZs
    if (typeof findEmergencyLZs === 'function' && cellSizeKm > 0) {
      S.lzs = findEmergencyLZs(elevPoints, gridSize, cellSizeKm);
      renderLZMarkers(S.lzs);
      buildLayerControl();
    }
    setText('terrRID', centerElev > 5000 ? 'Internet unlikely — use RID module' : 'Internet likely available');

    // Cache elevation data
    if (typeof cacheApiResponse === 'function') cacheApiResponse('elevation', areaKey(center.lat, center.lng), data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    setStatus('elevStatus', 'live', 'LIVE');
    clearDataSourceError('Elevation');
    markSection('elevation', { status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.error('Elevation fetch error:', err);
    recordDataSourceError('Elevation', err);
    const _elevErrMsg = err && err.message ? err.message : String(err);
    markSection('elevation', { status: 'error', error: _elevErrMsg });
    // Try cached elevation data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(center.lat, center.lng) : `${center.lat.toFixed(3)}_${center.lng.toFixed(3)}`;
        const cached = await getCachedApiResponse('elevation', k);
        if (cached && cached.data && cached.data.results) {
          const elevations = cached.data.results.map(r => Math.round(r.elevation * 3.28084));
          const centerElev = elevations[0];
          const minElev = Math.min(...elevations);
          const maxElev = Math.max(...elevations);
          const range = maxElev - minElev;
          S.elev = { center: centerElev, min: minElev, max: maxElev, range };
          setText('terrMin', `${minElev.toLocaleString()} ft AMSL`);
          setText('terrMax', `${maxElev.toLocaleString()} ft AMSL`);
          setText('terrRange', `${range.toLocaleString()} ft`);
          setColor('terrRange', range < 200 ? 'green' : range < 800 ? 'amber' : 'red');
          setText('terrLaunch', `${centerElev.toLocaleString()} ft AMSL`);
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('elevStatus', badge, label);
          markSection('elevation', { status: 'cached', cachedAt: cached.timestamp, error: _elevErrMsg });
        } else {
          setStatus('elevStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Elevation cache fallback failed:', cacheErr);
        setStatus('elevStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('elevStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Elevation');
  }
}

// ============================================================
// API: SUNRISE-SUNSET.ORG (FREE)
// ============================================================
async function fetchSunMoon(lat, lng) {
  trackFetchStart('Sun/Moon');
  setStatus('astroStatus', 'loading', 'Fetching...');
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(`https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lng}&date=${today}&formatted=0`);
    const data = await res.json();

    if (data.status === 'OK') {
      const r = data.results;
      const fmt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: _localTZ() });

      setText('astSunrise', fmt(r.sunrise));
      setText('astSunset', fmt(r.sunset));
      setText('astTwilightAM', fmt(r.civil_twilight_begin));
      setText('astTwilightPM', fmt(r.civil_twilight_end));
      setText('astNauticalAM', fmt(r.nautical_twilight_begin));
      setText('astNauticalPM', fmt(r.nautical_twilight_end));
      setText('astSolarNoon', fmt(r.solar_noon));

      const twAM = fmt(r.civil_twilight_begin);
      const twPM = fmt(r.civil_twilight_end);
      setText('astDayWindow', `${twAM} — ${twPM} ${new Date().toLocaleTimeString('en-US',{timeZoneName:'short'}).split(' ').pop()}`);

      const sunPos = calcSunPosition(lat, lng);
      setText('astSunAz', `${sunPos.azimuth.toFixed(1)}°`);
      setText('astSunEl', `${sunPos.elevation.toFixed(1)}°`);

      if (sunPos.elevation > 5) {
        const shadowMult = (1 / Math.tan(sunPos.elevation * Math.PI / 180)).toFixed(1);
        setText('astShadow', `${shadowMult}x object height`);
      } else {
        setText('astShadow', 'Sun low — long shadows');
      }

      const moonPhase = calcMoonPhase();
      setText('astMoonPhase', moonPhase.name);
      setText('astMoonIllum', `${moonPhase.illumination}%`);

      const nightAssess = moonPhase.illumination > 50 ? 'Good lunar illumination for night ops' :
                          moonPhase.illumination > 20 ? 'Moderate lunar light — supplement with anti-collision' :
                          'Low illumination — ensure adequate anti-collision lighting';
      setText('astNightOps', nightAssess);

      // Simplified WMM 2025 magnetic declination approximation for CONUS
      const magDec = -5.24 + 0.12 * (lat - 39) + 0.19 * (lng + 98);
      setText('astMagDec', `${Math.abs(magDec).toFixed(1)}° ${magDec >= 0 ? 'E' : 'W'} (approx)`);

      S.astro = { sunrise: r.sunrise, sunset: r.sunset, twAM: r.civil_twilight_begin, twPM: r.civil_twilight_end, moonPhase };

      // Cache sunrise data
      if (typeof cacheApiResponse === 'function') cacheApiResponse('sunrise', areaKey(lat, lng), data);
      if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

      setStatus('astroStatus', 'live', 'LIVE');
      clearDataSourceError('Sun/Moon');
      markSection('solar', { status: 'live', updatedAt: Date.now(), error: null });
    }
  } catch (err) {
    console.error('Sun/Moon fetch error:', err);
    recordDataSourceError('Sun/Moon', err);
    const _astroErrMsg = err && err.message ? err.message : String(err);
    markSection('solar', { status: 'error', error: _astroErrMsg });
    // Try cached sunrise data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(lat, lng) : `${lat.toFixed(3)}_${lng.toFixed(3)}`;
        const cached = await getCachedApiResponse('sunrise', k);
        if (cached && cached.data && cached.data.status === 'OK') {
          const r = cached.data.results;
          const fmt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: _localTZ() });
          setText('astSunrise', fmt(r.sunrise));
          setText('astSunset', fmt(r.sunset));
          setText('astTwilightAM', fmt(r.civil_twilight_begin));
          setText('astTwilightPM', fmt(r.civil_twilight_end));
          setText('astDayWindow', `${fmt(r.civil_twilight_begin)} — ${fmt(r.civil_twilight_end)} ${new Date().toLocaleTimeString('en-US',{timeZoneName:'short'}).split(' ').pop()}`);
          S.astro = { sunrise: r.sunrise, sunset: r.sunset, twAM: r.civil_twilight_begin, twPM: r.civil_twilight_end };
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('astroStatus', badge, label);
          markSection('solar', { status: 'cached', cachedAt: cached.timestamp, error: _astroErrMsg });
        } else {
          setStatus('astroStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Sunrise cache fallback failed:', cacheErr);
        setStatus('astroStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('astroStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Sun/Moon');
  }
}

// ============================================================
// FAA TFR / NOTAM — in-app import + smart deep-links (NO SERVER)
// ============================================================
// The browser cannot fetch FAA endpoints directly (they send no CORS headers),
// so the user downloads files from FAA via the pre-filled links below and
// imports them here; the app parses + plots them. Works offline once loaded.

const TFR_GEOSERVER_BASE = 'https://tfr.faa.gov/geoserver/TFR/ows';

// Build the GeoServer WFS URL returning active TFR polygons (GeoJSON) for the
// drawn area's bbox. Verified order: minLng,minLat,maxLng,maxLat,EPSG:4326.
function _tfrWfsQuery(bounds) {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const bbox = `${sw.lng.toFixed(4)},${sw.lat.toFixed(4)},${ne.lng.toFixed(4)},${ne.lat.toFixed(4)},EPSG:4326`;
  return `?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC` +
         `&outputFormat=application/json&srsname=EPSG:4326&bbox=${encodeURIComponent(bbox)}`;
}

function tfrGeoJsonUrlForBounds(bounds) {
  if (!bounds) return TFR_GEOSERVER_BASE;
  return TFR_GEOSERVER_BASE + _tfrWfsQuery(bounds);
}

// Live TFR retrieval through the data proxy (Cloudflare Worker, /tfr/ route).
// No-op when no proxy is configured — the manual download/import flow in the
// NOTAMs tab still applies. Reuses the same parse/merge/render pipeline as import.
async function fetchLiveTFRs(bounds) {
  const base = (typeof getCanopyProxyBase === 'function') ? getCanopyProxyBase() : null;
  if (!base || !bounds) return;
  if (typeof isOnline === 'function' && !isOnline()) return;
  trackFetchStart('TFR');
  setStatus('notamStatus', 'loading', 'TFR…');
  try {
    const res = await _proxyFetch(base + '/tfr/geoserver/TFR/ows' + _tfrWfsQuery(bounds));
    if (!res.ok) throw new Error('TFR HTTP ' + res.status);
    const gj = await res.json();
    const parsed = (typeof parseTfrGeoJson === 'function') ? parseTfrGeoJson(gj) : { tfrs: [] };
    const tfrs = (parsed.tfrs || []).map(t => Object.assign({}, t, { _live: true }));
    // Replace the previously live-fetched set; keep any manually-imported TFRs.
    S.tfrs = (S.tfrs || []).filter(t => !t._live);
    if (tfrs.length) mergeTfrs(tfrs);
    S.tfrImportMeta = { fileName: 'live', importedAtMs: Date.now(), source: 'FAA GeoServer (live via proxy)' };
    // Enrich each live TFR with altitude band + effective/expire times from its
    // detail XML (the GeoServer WFS feed carries geometry + id + title only).
    await enrichLiveTfrDetails(base, tfrs);
    afterFaaImport();
    setStatus('notamStatus', 'live', tfrs.length ? `${tfrs.length} TFR${tfrs.length > 1 ? 'S' : ''} LIVE` : 'NO TFR (LIVE)');
    clearDataSourceError('TFR');
  } catch (e) {
    console.warn('Live TFR fetch failed:', e);
    recordDataSourceError('TFR', e);
    // leave the manual import flow / any cached TFRs in place
  } finally {
    trackFetchEnd('TFR');
  }
}

// Fetch each live TFR's detail XML (altitude + effective/expire times) through the
// proxy and merge it in by id. The WFS feed only carries geometry+id+title, so
// without this every listed TFR is treated as active (conservative). Best-effort:
// a failed/absent detail file just leaves that TFR geometry-only.
async function enrichLiveTfrDetails(base, tfrs) {
  if (!base || !Array.isArray(tfrs) || !tfrs.length || typeof parseTfrDetailXml !== 'function') return;
  const targets = tfrs.slice(0, 20); // the bbox already limits results; cap as a backstop
  const results = await Promise.allSettled(targets.map(t => _fetchTfrDetail(base, t.id)));
  const enriched = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (enriched.length) mergeTfrs(enriched);
}

async function _fetchTfrDetail(base, id) {
  const fileId = String(id).replace(/\//g, '_'); // '4/3635' -> 'detail_4_3635.xml'
  const res = await _proxyFetch(base + '/tfr/download/detail_' + fileId + '.xml');
  if (!res.ok) return null;
  const xml = await res.text();
  const d = (parseTfrDetailXml(xml).tfrs || [])[0];
  if (!d) return null;
  // Force the id to the live TFR's id (so mergeTfrs folds it into the geometry
  // record) and drop any detail polygons (keep the WFS geometry as authoritative).
  return Object.assign({}, d, { id, polygons: [], _live: true });
}

// Live NOTAM retrieval through the data proxy (Cloudflare Worker, /notam route →
// the FAA NOTAM Search backend). No-op without a proxy. The source is unofficial,
// so results are advisory; the manual file/paste import remains available.
// Build the AOI descriptor used to judge NOTAM relevance (proximity to the area).
function _buildNotamAoi(lat, lng, searchRadiusNm) {
  let radiusNm = 0;
  try {
    if (S.areaBounds && typeof haversine === 'function') {
      const ne = S.areaBounds.getNorthEast();
      radiusNm = haversine(lat, lng, ne.lat, ne.lng) / 1.852;
    }
  } catch (_) { /* point AOI */ }
  return {
    center: { lat, lng },
    radiusNm,
    searchRadiusNm: searchRadiusNm || 0,
    polygon: (typeof currentAreaPolygon === 'function') ? currentAreaPolygon() : null,
  };
}

async function fetchNotams(lat, lng, radiusNm) {
  const base = (typeof getCanopyProxyBase === 'function') ? getCanopyProxyBase() : null;
  if (!base || lat == null || lng == null) return;
  if (typeof isOnline === 'function' && !isOnline()) return;
  trackFetchStart('NOTAM');
  try {
    const r = Math.max(5, Math.min(100, Math.round(radiusNm || 20)));
    const res = await _proxyFetch(base + '/notam?lat=' + lat.toFixed(5) + '&lng=' + lng.toFixed(5) + '&radius=' + r);
    if (!res.ok) throw new Error('NOTAM HTTP ' + res.status);
    const data = await res.json();
    const parsed = (typeof parseNotamSearchResponse === 'function') ? parseNotamSearchResponse(data) : [];
    const aoi = _buildNotamAoi(lat, lng, r);
    const notams = parsed.map(n => {
      const o = Object.assign({}, n, { _live: true });
      if (typeof classifyNotamForUAS === 'function') o._relevance = classifyNotamForUAS(o, aoi);
      return o;
    });
    S.importedNotams = (S.importedNotams || []).filter(n => !n._live); // drop previous live set; keep manual imports
    if (notams.length) mergeNotams(notams);
    renderImportedNotamLayer();
    renderNotamCards();
    if (S.currentArea) computeAssessment();
    clearDataSourceError('NOTAM');
  } catch (e) {
    console.warn('Live NOTAM fetch failed:', e);
    recordDataSourceError('NOTAM', e);
  } finally {
    trackFetchEnd('NOTAM');
  }
}

// Orchestrate live TFR + NOTAM for an area and set a single combined status.
async function fetchLiveRestrictions(center, bounds) {
  if (!center) return;
  const proxySet = typeof getCanopyProxyBase === 'function' && !!getCanopyProxyBase();
  if (!proxySet) { S.autoCheck = { state: 'idle', ms: 0, tfrCount: 0, notamCount: 0 }; renderAutoCheckStatus(); return; }
  if (typeof isOnline === 'function' && !isOnline()) { S.autoCheck = { state: 'error', ms: Date.now(), tfrCount: 0, notamCount: 0 }; renderAutoCheckStatus(); return; }

  clearDataSourceError('TFR'); clearDataSourceError('NOTAM');
  S.autoCheck = { state: 'checking', ms: 0, tfrCount: 0, notamCount: 0 };
  renderAutoCheckStatus();

  await fetchLiveTFRs(bounds);
  let radiusNm = 20;
  try {
    if (bounds && typeof haversine === 'function') {
      const ne = bounds.getNorthEast();
      const km = haversine(center.lat, center.lng, ne.lat, ne.lng);
      radiusNm = Math.max(10, Math.min(50, Math.round(km / 1.852) + 10));
    }
  } catch (_) { /* default radius */ }
  await fetchNotams(center.lat, center.lng, radiusNm);

  const nt = (S.tfrs || []).filter(t => t._live).length;
  const nn = (S.importedNotams || []).filter(n => n._live).length;
  const bothFailed = S.dataSourceErrors && S.dataSourceErrors.TFR && S.dataSourceErrors.NOTAM;
  const state = (bothFailed && nt === 0 && nn === 0) ? 'error' : 'ok';
  S.autoCheck = { state, ms: Date.now(), tfrCount: nt, notamCount: nn };
  renderAutoCheckStatus();

  // Combined compact badge on the import section (kept for continuity).
  const parts = [];
  if (nt) parts.push(`${nt} TFR${nt > 1 ? 'S' : ''}`);
  if (nn) parts.push(`${nn} NTM`);
  setStatus('notamStatus', state === 'error' ? 'error' : 'live',
    state === 'error' ? 'CHECK FAILED' : (parts.length ? parts.join(' · ') + ' LIVE' : 'NONE (LIVE)'));
}

function reCheckRestrictionsNow() {
  if (!S.areaCenter || !S.areaBounds) return;
  fetchLiveRestrictions(S.areaCenter, S.areaBounds);
}

// Context-aware empty-state for the TFR/NOTAM card lists, so "auto-checked, none
// found" reads differently from "nothing loaded yet". kind = 'TFRs' | 'NOTAMs'.
function _restrictionEmptyMsg(kind) {
  const proxySet = typeof getCanopyProxyBase === 'function' && getCanopyProxyBase();
  if (proxySet && S.currentArea && S.autoCheck) {
    if (S.autoCheck.state === 'checking') return `Checking for ${kind}…`;
    if (S.autoCheck.state === 'ok') return `Auto-checked — no active ${kind} in this area.`;
    if (S.autoCheck.state === 'error') return `Auto-check failed — import ${kind} manually below, or Re-check.`;
  }
  return kind === 'TFRs'
    ? 'No TFR file imported. Download via the links above, then import.'
    : 'No NOTAMs parsed yet.';
}

// Prominent "was this auto-checked?" panel at the top of the NOTAMs tab.
// Reads S.autoCheck + whether a proxy is configured + whether an area is drawn.
function renderAutoCheckStatus() {
  const sec = document.getElementById('autoCheckStatusSection');
  if (!sec) return;
  const ind = document.getElementById('autoCheckIndicator');
  const sta = document.getElementById('autoCheckStatus');
  const det = document.getElementById('autoCheckDetail');
  const btn = document.getElementById('autoCheckReBtn');
  const proxySet = typeof getCanopyProxyBase === 'function' && !!getCanopyProxyBase();
  const hasArea = !!S.currentArea;
  const ac = S.autoCheck || {};
  let color = 'var(--text-muted)', badge = '', badgeCls = 'fetch-status', detail = '', showBtn = false;

  if (!proxySet) {
    badge = 'OFF';
    detail = 'Automatic FAA check is off. Add a Data proxy URL in Config to auto-fetch live TFRs & NOTAMs per area. Until then, use the manual import below.';
  } else if (!hasArea) {
    color = 'var(--accent-cyan)'; badge = 'READY';
    detail = 'Draw an operational area — TFRs and NOTAMs are then checked automatically for it.';
  } else if (ac.state === 'checking') {
    color = 'var(--accent-amber)'; badge = 'CHECKING…'; badgeCls = 'fetch-status loading';
    detail = 'Fetching live TFRs and NOTAMs for this area…';
  } else if (ac.state === 'ok') {
    color = 'var(--accent-green)'; badge = 'CHECKED'; badgeCls = 'fetch-status live';
    const age = ac.ms && typeof formatAge === 'function' ? formatAge(Date.now() - ac.ms) : '';
    const parts = [];
    if (ac.tfrCount) parts.push(`${ac.tfrCount} TFR${ac.tfrCount > 1 ? 's' : ''}`);
    if (ac.notamCount) parts.push(`${ac.notamCount} NOTAM${ac.notamCount > 1 ? 's' : ''}`);
    detail = (parts.length ? `Auto-checked ${age} ago • ${parts.join(' • ')} in/near this area.`
                           : `Auto-checked ${age} ago • no active TFRs or NOTAMs in this area.`)
           + ' Advisory — verify against an official briefing before flight.';
    showBtn = true;
  } else if (ac.state === 'error') {
    color = 'var(--accent-red)'; badge = 'FAILED'; badgeCls = 'fetch-status error';
    detail = (typeof isOnline === 'function' && !isOnline())
      ? 'Offline — could not auto-check; using any cached/manual data. Re-check when back online.'
      : 'Auto-check failed to reach the FAA sources. Use the manual import below, or Re-check now.';
    showBtn = true;
  } else {
    color = 'var(--accent-cyan)'; badge = 'READY';
    detail = 'Ready — redraw or re-check to fetch live TFRs and NOTAMs for this area.';
    showBtn = true;
  }

  if (ind) ind.style.background = color;
  if (sta) { sta.className = badgeCls; sta.textContent = badge; }
  if (det) det.textContent = detail;
  if (btn) btn.style.display = (proxySet && hasArea) ? '' : 'none';
  sec.style.borderLeftColor = color;
  sec.style.display = '';
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Decimal degrees -> DMS string for the FAA NOTAM Search Lat/Long query.
function toDMS(lat, lng) {
  function fmt(v, posC, negC) {
    const hemi = v >= 0 ? posC : negC;
    v = Math.abs(v);
    const d = Math.floor(v);
    const mf = (v - d) * 60;
    const m = Math.floor(mf);
    const s = Math.round((mf - m) * 60);
    return `${d}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"${hemi}`;
  }
  return `${fmt(lat, 'N', 'S')} ${fmt(lng, 'E', 'W')}`;
}

function fmtTfrTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: _localTZ() });
  } catch (_) { return iso; }
}

// Drawn area as a [lat,lng] ring (circle approximated to a polygon).
function currentAreaPolygon() {
  if (!S.currentArea) return null;
  try {
    if (S.areaType === 'CIRCLE') {
      const c = S.currentArea.getLatLng ? S.currentArea.getLatLng() : S.areaCenter;
      const r = S.currentArea.getRadius ? S.currentArea.getRadius() : 0;
      if (c && r) return circleToPolygon(c.lat, c.lng, r, 32);
    } else if (S.currentArea.getLatLngs) {
      const ll = S.currentArea.getLatLngs()[0];
      if (ll && ll.length) return ll.map(p => [p.lat, p.lng]);
    }
  } catch (_) { /* fall through to bounds */ }
  if (S.areaBounds) {
    const sw = S.areaBounds.getSouthWest(), ne = S.areaBounds.getNorthEast();
    return [[sw.lat, sw.lng], [sw.lat, ne.lng], [ne.lat, ne.lng], [ne.lat, sw.lng], [sw.lat, sw.lng]];
  }
  return null;
}

// Called from processArea (no network). Hydrates cached data + renders tab.
async function renderNotamsTab(lat, lng) {
  if ((!S.tfrs || !S.tfrs.length) && (!S.importedNotams || !S.importedNotams.length) &&
      typeof getCachedApiResponse === 'function' && S.areaCenter) {
    try {
      const rec = await getCachedApiResponse('tfr_import', areaKey(S.areaCenter.lat, S.areaCenter.lng));
      if (rec && rec.data) {
        S.tfrs = rec.data.tfrs || [];
        S.importedNotams = rec.data.notams || [];
        S.tfrImportMeta = rec.data.meta || null;
        if (S.tfrImportMeta) S.tfrImportMeta.cached = true;
        renderImportedTfrLayer();
        renderImportedNotamLayer();
      }
    } catch (_) { /* ignore cache errors */ }
  }
  renderDeepLinks(lat, lng);
  renderTfrCards();
  renderNotamCards();
  renderImportStatus();
  // When the proxy is set, fetchLiveRestrictions owns #notamStatus (don't let this
  // async fn race-overwrite the combined "… LIVE" badge with a stale TFR-only one).
  if (!(typeof getCanopyProxyBase === 'function' && getCanopyProxyBase())) {
    setStatus('notamStatus', (S.tfrs && S.tfrs.length) ? 'live' : 'manual',
      (S.tfrs && S.tfrs.length) ? `${S.tfrs.length} TFR${S.tfrs.length > 1 ? 'S' : ''}` : 'IMPORT');
  }
  renderAutoCheckStatus();
  computeAirspace(lat, lng);
}

function renderDeepLinks(lat, lng) {
  const el = document.getElementById('notamDeepLinks');
  if (!el) return;
  const areaPoly = currentAreaPolygon();
  let artccs = areaPoly ? artccsForArea(areaPoly) : [];
  if (!artccs.length) { const a = artccForPoint(lat, lng); if (a) artccs = [a]; }
  const dms = toDMS(lat, lng);
  const tfrDownload = S.areaBounds
    ? `<a href="${tfrGeoJsonUrlForBounds(S.areaBounds)}" target="_blank" rel="noopener" class="deeplink-btn primary">⬇ Download active TFRs for this area (GeoJSON)</a>`
    : '';
  const artccNote = artccs.length
    ? `<div class="notam-meta">Area ARTCC: ${_esc(artccs.map(a => `${a.name} (${a.id})`).join(', '))}${artccs.length > 1 ? ' — spans multiple centers, check each' : ''}</div>`
    : '';
  el.innerHTML = `
    ${tfrDownload}
    <a href="https://tfr.faa.gov/tfr3/?page=map" target="_blank" rel="noopener" class="deeplink-btn">FAA TFR Map (visual)</a>
    <a href="https://skyvector.com/?ll=${lat},${lng}&chart=301&zoom=10" target="_blank" rel="noopener" class="deeplink-btn">SkyVector Sectional</a>
    <a href="https://notams.aim.faa.gov/notamSearch/" target="_blank" rel="noopener" class="deeplink-btn">FAA NOTAM Search</a>
    ${artccNote}
    <div class="notam-meta">NOTAM Search → Lat/Long query <b>${_esc(dms)}</b>, radius 20 NM → select the results and copy, then paste into the NOTAMs box below.</div>
    <div class="notam-meta" style="color:var(--accent-amber)">Download a file, then "Import file" to plot it. Re-verify ≤ 1 hr before launch.</div>
  `;
}

function renderTfrCards() {
  const el = document.getElementById('tfrList');
  const countEl = document.getElementById('tfrCount');
  if (!el) return;
  if (!S.tfrs || !S.tfrs.length) {
    el.innerHTML = `<div class="notam-body" style="color:var(--text-muted);font-style:italic;">${_restrictionEmptyMsg('TFRs')}</div>`;
    if (countEl) countEl.textContent = '';
    return;
  }
  const areaPoly = currentAreaPolygon();
  const now = Date.now();
  const hitIds = new Set((areaPoly ? filterTfrsIntersectingArea(S.tfrs, areaPoly) : []).map(t => t.id));
  if (countEl) countEl.textContent = `${S.tfrs.length} loaded${hitIds.size ? ` • ${hitIds.size} over area` : ''}`;
  const sorted = S.tfrs.slice().sort((a, b) => (hitIds.has(b.id) ? 1 : 0) - (hitIds.has(a.id) ? 1 : 0));
  el.innerHTML = sorted.map(t => {
    const intersects = hitIds.has(t.id);
    const active = isTfrActiveNow(t, now);
    const danger = intersects && active;
    const tag = danger ? 'OVER AREA' : (intersects ? 'OVER AREA (inactive)' : (t.polygons && t.polygons.length ? 'elsewhere' : 'no map geom'));
    const alt = (t.lowerAlt != null || t.upperAlt != null)
      ? `${t.lowerAlt != null ? t.lowerAlt : 'SFC'}–${t.upperAlt != null ? t.upperAlt : '?'} ${t.altUom || ''}` : '';
    const times = (t.effectiveStart || t.effectiveEnd)
      ? `${fmtTfrTime(t.effectiveStart)} → ${fmtTfrTime(t.effectiveEnd)}` : 'Schedule: see NOTAM text';
    return `<div class="notam-card clickable ${danger ? 'tfr' : 'notam-style'}" onclick="focusTfr('${(t.id || '').replace(/['"\\]/g, '')}')" title="Click to center the map on this TFR">
      <div class="notam-header">
        <span class="notam-id">TFR ${_esc(t.id)}${t.type ? ` • ${_esc(t.type)}` : ''}</span>
        <span class="notam-type ${danger ? 'tfr-type' : 'notam-type-tag'}">${tag}</span>
      </div>
      <div class="notam-body">${_esc(t.name || '')}${t.state ? ` (${_esc(t.state)})` : ''}</div>
      <div class="notam-meta">${alt ? `Alt: ${_esc(alt)} • ` : ''}${_esc(times)}${t.artcc ? ` • ${_esc(t.artcc)}` : ''}${t.source === 'list' ? ' • list-only (no map geometry)' : ''}</div>
    </div>`;
  }).join('');
}

function renderNotamCards() {
  const el = document.getElementById('notamList');
  if (!el) return;
  if (!S.importedNotams || !S.importedNotams.length) {
    el.innerHTML = `<div class="notam-body" style="color:var(--text-muted);font-style:italic;">${_restrictionEmptyMsg('NOTAMs')}</div>`;
    return;
  }
  const areaPoly = currentAreaPolygon();
  const now = Date.now();
  const all = S.importedNotams;
  const isRel = n => !n._relevance || n._relevance.relevant;
  const hiddenCount = all.filter(n => !isRel(n)).length;
  const showAll = !!S.notamShowAll;
  const shown = showAll ? all : all.filter(isRel);

  let html = '';
  if (hiddenCount > 0) {
    html += `<div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;">`
      + `<span>${shown.length} relevant · ${hiddenCount} filtered (far / high-altitude / not UAS)</span>`
      + `<a href="#" onclick="toggleNotamShowAll();return false;" style="color:var(--accent-cyan);white-space:nowrap;">${showAll ? 'Hide filtered' : 'Show all'}</a>`
      + `</div>`;
  }
  if (!shown.length) {
    html += `<div class="notam-body" style="color:var(--text-muted);font-style:italic;">No UAS-relevant NOTAMs in this area. <a href="#" onclick="toggleNotamShowAll();return false;" style="color:var(--accent-cyan);">Show all ${hiddenCount}</a></div>`;
  }
  html += shown.map(n => {
    const hasPoly = n.polygons && n.polygons.length;
    const overArea = hasPoly && areaPoly && n.polygons.some(r => polygonsIntersect(r, areaPoly));
    const danger = overArea && isTfrActiveNow(n, now);
    const filtered = !isRel(n);
    const summary = (typeof notamPlainSummary === 'function') ? notamPlainSummary(n) : '';
    const cat = (n._relevance && n._relevance.category) ? n._relevance.category.replace('_', '/') : '';
    const distTxt = (n._relevance && n._relevance.distanceNm != null) ? `${Math.round(n._relevance.distanceNm)} NM` : '';
    const raw = (typeof expandNotamText === 'function') ? expandNotamText(n.body || '') : (n.body || '');
    const idSafe = (n.id || '').replace(/['"\\]/g, '');
    return `<div class="notam-card clickable ${danger ? 'tfr' : 'notam-style'}"${filtered ? ' style="opacity:0.6;"' : ''} onclick="focusNotam('${idSafe}')" title="Click to center the map on this NOTAM">
      <div class="notam-header">
        <span class="notam-id">${_esc(n.id || 'NOTAM')}${cat ? ` • ${_esc(cat)}` : ''}</span>
        <span class="notam-type ${danger ? 'tfr-type' : 'notam-type-tag'}">${overArea ? 'OVER AREA' : _esc(n.location || distTxt)}</span>
      </div>
      ${summary ? `<div class="notam-body" style="font-size:12px;line-height:1.4;">${_esc(summary)}</div>` : ''}
      <details style="margin-top:4px;" onclick="event.stopPropagation()"><summary style="font-size:10px;color:var(--text-muted);cursor:pointer;">Raw NOTAM text</summary>
        <div class="notam-body" style="font-family:var(--font-mono);font-size:10px;white-space:pre-wrap;color:var(--text-secondary);margin-top:4px;">${_esc(raw.slice(0, 600))}</div>
      </details>
      <div class="notam-meta">${danger ? 'ACTIVE over your area • ' : ''}${distTxt ? distTxt + ' from area' : ''}${filtered ? ' • filtered' : ''}</div>
    </div>`;
  }).join('');
  el.innerHTML = html;
}

function toggleNotamShowAll() {
  S.notamShowAll = !S.notamShowAll;
  renderNotamCards();
  renderImportedNotamLayer();
}

function renderImportStatus() {
  const el = document.getElementById('tfrStaleBanner');
  if (!el) return;
  const meta = S.tfrImportMeta;
  if (!meta) { el.style.display = 'none'; el.textContent = ''; return; }
  const age = Date.now() - (meta.importedAtMs || Date.now());
  const ageStr = typeof formatAge === 'function' ? formatAge(age) : Math.round(age / 60000) + 'm';
  const stale = age > 60 * 60 * 1000;
  el.style.display = '';
  el.style.color = stale ? 'var(--accent-red)' : 'var(--text-muted)';
  el.style.borderColor = stale ? 'var(--accent-red)' : 'var(--border)';
  el.textContent = `Imported ${meta.fileName || 'data'} • ${ageStr} ago${meta.cached ? ' (cached)' : ''}` +
    (stale ? ' — re-verify ≤ 1 hr before launch' : '');
}

function renderImportedTfrLayer() {
  if (typeof L === 'undefined' || !S.map) return;
  if (S.mapLayers.tfr_imported) S.mapLayers.tfr_imported.clearLayers();
  else S.mapLayers.tfr_imported = L.layerGroup();
  const now = Date.now();
  const areaPoly = currentAreaPolygon();
  const hitIds = new Set((areaPoly ? filterTfrsIntersectingArea(S.tfrs || [], areaPoly) : []).map(t => t.id));
  (S.tfrs || []).forEach(t => {
    const active = isTfrActiveNow(t, now);
    const color = active ? '#ef4444' : '#f59e0b';
    (t.polygons || []).forEach(ring => {
      if (!ring || ring.length < 3) return;
      const poly = L.polygon(ring, { color, weight: 3, fillColor: color, fillOpacity: hitIds.has(t.id) ? 0.25 : 0.12, dashArray: '4,4' });
      const alt = (t.lowerAlt != null || t.upperAlt != null)
        ? `${t.lowerAlt != null ? t.lowerAlt : 'SFC'}-${t.upperAlt != null ? t.upperAlt : '?'} ${t.altUom || ''}` : '';
      poly.bindPopup(`<b>TFR ${_esc(t.id)}</b><br>${_esc(t.name || '')}${alt ? '<br>' + _esc(alt) : ''}<br>${active ? '<span style="color:#ef4444">ACTIVE</span>' : 'inactive / scheduled'}`);
      S.mapLayers.tfr_imported.addLayer(poly);
    });
  });
  if (S.mapLayers.tfr_imported.getLayers().length) S.map.addLayer(S.mapLayers.tfr_imported); // default ON -- never hide a NO-GO
  buildLayerControl();
}

function renderImportedNotamLayer() {
  if (typeof L === 'undefined' || !S.map) return;
  if (S.mapLayers.notam_imported) S.mapLayers.notam_imported.clearLayers();
  else S.mapLayers.notam_imported = L.layerGroup();
  const areaPoly = currentAreaPolygon();
  const showAll = !!S.notamShowAll;
  (S.importedNotams || []).forEach(n => {
    if (n._relevance && !n._relevance.relevant && !showAll) return; // hide filtered NOTAMs from the map too
    if (n.polygons && n.polygons.length) {
      const overArea = areaPoly ? n.polygons.some(r => polygonsIntersect(r, areaPoly)) : false;
      const color = overArea ? '#ef4444' : '#f59e0b';
      n.polygons.forEach(ring => {
        if (!ring || ring.length < 3) return;
        const poly = L.polygon(ring, { color, weight: 2, fillColor: color, fillOpacity: overArea ? 0.20 : 0.10, dashArray: '2,4' });
        poly.bindPopup(`<b>${_esc(n.id || 'NOTAM')}</b> ${_esc(n.location || '')}<br>${_esc((n.body || '').slice(0, 240))}`);
        S.mapLayers.notam_imported.addLayer(poly);
      });
    } else if (n.lat != null && n.lng != null && !isNaN(n.lat) && !isNaN(n.lng)) {
      const m = L.circleMarker([n.lat, n.lng], { radius: 6, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.7, weight: 2 });
      m.bindPopup(`<b>${_esc(n.id || 'NOTAM')}</b> ${_esc(n.location || '')}<br>${_esc((n.body || '').slice(0, 200))}`);
      S.mapLayers.notam_imported.addLayer(m);
    }
  });
  if (S.mapLayers.notam_imported.getLayers().length) S.map.addLayer(S.mapLayers.notam_imported);
  buildLayerControl();
}

// Center/zoom the map on a clicked TFR/NOTAM card.
function focusTfr(id) { _focusFeature((S.tfrs || []).find(x => String(x.id) === String(id))); }
function focusNotam(id) { _focusFeature((S.importedNotams || []).find(x => String(x.id) === String(id))); }
function _focusFeature(f) {
  if (!f || !S.map) return;
  if (f.polygons && f.polygons.length) {
    let pts = [];
    f.polygons.forEach(r => { pts = pts.concat(r); });
    if (pts.length) { try { S.map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 }); } catch (_) {} return; }
  }
  if (f.lat != null && f.lng != null && !isNaN(f.lat) && !isNaN(f.lng)) {
    try { S.map.setView([f.lat, f.lng], 11); } catch (_) {}
  }
}

// --- Import handling ---

function importFaaFile() {
  const input = document.getElementById('faaFileInput');
  if (input) { input.value = ''; input.click(); }
}

function handleFaaFiles(input) {
  const files = input.files;
  if (!files || !files.length) return;
  let pending = files.length;
  const done = () => { if (--pending === 0) afterFaaImport(); };
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const reader = new FileReader();
    reader.onload = function () {
      try { ingestFaaFileText(reader.result, file.name); }
      catch (e) { console.error('FAA import error:', e); }
      done();
    };
    reader.onerror = done;
    reader.readAsText(file);
  }
}

function ingestFaaFileText(text, fileName) {
  const name = (fileName || '').toLowerCase();
  if (/\.(xlsx|xls|zip|shp|kmz)$/.test(name)) {
    alert('Binary files (Excel / Shapefile / KMZ) are not supported. From FAA NOTAM Search export as Text/ICAO; from tfr.faa.gov download GeoJSON or the XML detail.');
    return;
  }
  const trimmed = (text || '').trim();
  if (!trimmed) { alert('Empty file.'); return; }

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    const r = parseTfrGeoJson(trimmed);
    if (r.errors.length && !r.tfrs.length) { alert('Could not parse JSON: ' + r.errors[0]); return; }
    applyTfrImport(r.tfrs, fileName, r.tfrs[0] ? r.tfrs[0].source : 'geojson');
    return;
  }
  if (/<XNOTAM|<geoLat|<abdMergedArea|<Not[\s>]/.test(trimmed)) {
    const r = parseTfrDetailXml(trimmed);
    if (r.errors.length && !r.tfrs.length) { alert('Could not parse XML: ' + r.errors[0]); return; }
    applyTfrImport(r.tfrs, fileName, 'detail-xml');
    return;
  }
  if (/aixm:|gml:posList/.test(trimmed)) {
    alert('AIXM/GML files are not supported. From tfr.faa.gov download the GeoJSON (the per-TFR XML detail also works).');
    return;
  }
  const r = parseNotamText(trimmed);
  if (r.notams.length) {
    r.notams.forEach(n => geolocateNotam(n, S.nearbyAirports || []));
    mergeNotams(r.notams);
    S.tfrImportMeta = { fileName, importedAtMs: Date.now(), source: 'notam-text' };
    return;
  }
  alert('Unrecognized file. Expected FAA TFR GeoJSON/XML or a NOTAM text export.');
}

function applyTfrImport(tfrs, fileName, source) {
  if (!tfrs || !tfrs.length) { alert('No TFRs found in this file.'); return; }
  mergeTfrs(tfrs);
  S.tfrImportMeta = { fileName, importedAtMs: Date.now(), source };
}

// Merge incoming TFRs by id; prefer the geometry-bearing record and enrich it
// with altitude/time fields from a matching list/detail import.
function mergeTfrs(incoming) {
  const byId = {};
  (S.tfrs || []).forEach(t => { byId[t.id] = t; });
  incoming.forEach(t => {
    const ex = byId[t.id];
    if (!ex) { byId[t.id] = t; return; }
    const exGeo = ex.polygons && ex.polygons.length;
    const tGeo = t.polygons && t.polygons.length;
    const base = (tGeo || !exGeo) ? t : ex;
    const other = base === t ? ex : t;
    ['lowerAlt', 'upperAlt', 'altUom', 'effectiveStart', 'effectiveEnd', 'reason', 'artcc', 'state', 'type', 'name'].forEach(k => {
      if ((base[k] == null || base[k] === '') && other[k] != null && other[k] !== '') base[k] = other[k];
    });
    if ((!base.polygons || !base.polygons.length) && other.polygons && other.polygons.length) base.polygons = other.polygons;
    byId[t.id] = base;
  });
  S.tfrs = Object.values(byId);
}

function mergeNotams(incoming) {
  const byId = {};
  (S.importedNotams || []).forEach(n => { byId[n.id + '|' + (n.location || '')] = n; });
  incoming.forEach(n => { byId[n.id + '|' + (n.location || '')] = n; });
  S.importedNotams = Object.values(byId);
}

function afterFaaImport() {
  renderImportedTfrLayer();
  renderImportedNotamLayer();
  renderTfrCards();
  renderNotamCards();
  renderImportStatus();
  setStatus('notamStatus', (S.tfrs && S.tfrs.length) ? 'live' : 'manual',
    (S.tfrs && S.tfrs.length) ? `${S.tfrs.length} TFR${S.tfrs.length > 1 ? 'S' : ''}` : 'IMPORT');
  if (typeof cacheApiResponse === 'function' && S.areaCenter) {
    cacheApiResponse('tfr_import', areaKey(S.areaCenter.lat, S.areaCenter.lng), {
      tfrs: S.tfrs, notams: S.importedNotams, meta: S.tfrImportMeta,
    });
  }
  if (S.currentArea) computeAssessment();
}

function setupTfrDropzone() {
  const dz = document.getElementById('tfrDropzone');
  if (!dz) return;
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', e => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFaaFiles({ files });
  });
  dz.addEventListener('click', () => importFaaFile());
}

// FAA NOTAM Search only downloads PDF/Excel (no text file), but its results are
// copyable — paste them here and parse. Also works for text copied from a PDF/Excel.
function parsePastedNotams() {
  const ta = document.getElementById('notamPasteBox');
  if (!ta) return;
  const text = ta.value || '';
  if (!text.trim()) { alert('Paste NOTAM text first (copy it from the FAA NOTAM Search results, or from the opened PDF/Excel).'); return; }
  const r = parseNotamText(text);
  const msgEl = document.getElementById('notamParseMsg');
  if (!r.notams.length) {
    if (msgEl) { msgEl.style.display = ''; msgEl.style.color = 'var(--accent-amber)'; msgEl.textContent = 'No NOTAMs recognized in the pasted text. Paste the domestic or ICAO NOTAM text from the FAA results.'; }
    else alert('No NOTAMs recognized in the pasted text.');
    return;
  }
  r.notams.forEach(n => geolocateNotam(n, S.nearbyAirports || []));
  mergeNotams(r.notams);
  S.tfrImportMeta = { fileName: r.notams.length + ' pasted NOTAM(s)', importedAtMs: Date.now(), source: 'notam-paste' };
  afterFaaImport();
  // Clear feedback so the user can see it worked
  const withArea = r.notams.filter(n => n.polygons && n.polygons.length).length;
  const areaPoly = currentAreaPolygon();
  const overArea = areaPoly ? r.notams.filter(n => n.polygons && n.polygons.some(rg => polygonsIntersect(rg, areaPoly))).length : 0;
  if (msgEl) {
    msgEl.style.display = '';
    msgEl.style.color = overArea ? 'var(--accent-red)' : 'var(--accent-green)';
    msgEl.textContent = `✓ Parsed ${r.notams.length} NOTAM(s)` +
      (withArea ? `, ${withArea} with an area drawn on the map` : '') +
      (overArea ? ` — ${overArea} OVER your search area (see red on map + CAUTION banner)` : '') + '.';
  }
  ta.value = '';
}

function clearImportedNotams() {
  S.importedNotams = [];
  const ta = document.getElementById('notamPasteBox');
  if (ta) ta.value = '';
  renderImportedNotamLayer();
  renderNotamCards();
}

// Fire danger renders into #fireDangerCards (a static element in the NOTAMs tab).

// National NFDRS via the nearest RAWS station: NIFC's station layer (ArcGIS, CORS OK)
// supplies WIMS station ids; FEMS (fems.fs2c.usda.gov GraphQL, CORS OK - verified
// 2026-07-13) supplies current ERC/BI/fuel-moisture observations plus station-specific
// climatological percentile thresholds, so the card's percentile colors and adjective
// mean the same thing here as in the CA_NFDRS path. Returns a fireDanger object or null.
async function _fetchNationalNFDRS(lat, lng) {
  try {
    // 1) nearest RAWS stations from NIFC (bbox, widen once if empty)
    let stations = [];
    for (const pad of [0.7, 1.5]) {
      const u = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/NFDRS_ERC_and_BI_Percentiles_and_Trends/FeatureServer/0/query'
        + `?where=1=1&geometry=${lng - pad},${lat - pad},${lng + pad},${lat + pad}&geometryType=esriGeometryEnvelope&inSR=4326`
        + '&outFields=Station_ID,Station_Name,Latitude,Longitude,PSA,Display&returnGeometry=false&f=json';
      const res = await fetch(u);
      if (!res.ok) return null;
      stations = ((await res.json()).features || []).map(f => f.attributes);
      if (stations.length) break;
    }
    if (!stations.length) return null;
    const displayed = stations.filter(st => st.Display === 1);
    const pick = (displayed.length ? displayed : stations)
      .map(st => Object.assign({}, st, { distKm: haversine(lat, lng, st.Latitude, st.Longitude) }))
      .sort((a, b) => a.distKm - b.distKm)[0];

    // 2) current observation + percentile thresholds from FEMS (parallel)
    const gql = q => fetch('https://fems.fs2c.usda.gov/api/climatology/graphql/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
    }).then(r => r.json());
    const d0 = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
    const d1 = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    const obsQ = '{ nfdrsObs(stationIds: "' + pick.Station_ID + '", fuelModels: "Y", startDateRange: "' + d0 + '", endDateRange: "' + d1 + '") { data { nfdr_date nfdr_time nfdr_type energy_release_component burning_index hun_hr_tl_fuel_moisture thou_hr_tl_fuel_moisture } } }';
    const pctQ = '{ percentileLevels(stationIds: "' + pick.Station_ID + '", fuelModel: Y, percentileLevels: "50,70,90,97") { data { energy_release_component burning_index } } }';
    const [obsRes, pctRes] = await Promise.allSettled([gql(obsQ), gql(pctQ)]);
    const rows = (obsRes.status === 'fulfilled' && obsRes.value && obsRes.value.data && obsRes.value.data.nfdrsObs && obsRes.value.data.nfdrsObs.data) || [];
    if (!rows.length) return null;
    // latest observed row; fall back to the newest row of any type (e.g. forecast)
    const obs = rows.slice().reverse().find(r => r.nfdr_type === 'O') || rows[rows.length - 1];
    const levels = (pctRes.status === 'fulfilled' && pctRes.value && pctRes.value.data && pctRes.value.data.percentileLevels && pctRes.value.data.percentileLevels.data && pctRes.value.data.percentileLevels.data[0]) || null;

    return {
      psa: pick.Station_Name + ' RAWS · ' + (pick.distKm * 0.539957).toFixed(0) + ' nm' + (pick.PSA ? ' · ' + pick.PSA : ''),
      bi: obs.burning_index, biPct: _nfdrsPercentile(obs.burning_index, levels && levels.burning_index),
      erc: obs.energy_release_component, ercPct: _nfdrsPercentile(obs.energy_release_component, levels && levels.energy_release_component),
      fm100: obs.hun_hr_tl_fuel_moisture, fm1000: obs.thou_hr_tl_fuel_moisture,
    };
  } catch (e) { return null; }
}

// Approximate a value's climatological percentile from FEMS threshold values at the
// 50/70/90/97th levels (piecewise-linear, clamped to 1-99). Null when unavailable.
function _nfdrsPercentile(value, thresholds) {
  if (value == null || !thresholds) return null;
  const pts = [[Number(thresholds['50th']), 50], [Number(thresholds['70th']), 70],
               [Number(thresholds['90th']), 90], [Number(thresholds['97th']), 97]]
    .filter(p => Number.isFinite(p[0]));
  if (!pts.length) return null;
  if (value <= pts[0][0]) return Math.max(1, Math.round(50 * value / (pts[0][0] || 1)));
  for (let i = 1; i < pts.length; i++) {
    if (value <= pts[i][0]) {
      const v0 = pts[i - 1][0], p0 = pts[i - 1][1], v1 = pts[i][0], p1 = pts[i][1];
      return Math.round(p0 + (p1 - p0) * (value - v0) / ((v1 - v0) || 1));
    }
  }
  return 99;
}

// ============================================================
// API: NIFC ACTIVE FIRES + CA NFDRS FIRE DANGER
// ============================================================
async function fetchFireDanger(lat, lng, bounds) {
  trackFetchStart('Fire Danger');
  try {
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const pad = 0.5; // ~30nm buffer
    const geom = `${sw.lng - pad},${sw.lat - pad},${ne.lng + pad},${ne.lat + pad}`;

    // Fetch active fire perimeters (US-wide) and NFDRS fire danger (CA only) in parallel
    const isCA = lat >= 32.5 && lat <= 42.0 && lng >= -124.5 && lng <= -114.0;
    const fetches = [
      fetch(`https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/Current_WildlandFire_Perimeters/FeatureServer/0/query`
        + `?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326`
        + `&outFields=poly_IncidentName,poly_GISAcres,poly_PercentContained,poly_CreateDate`
        + `&outSR=4326&f=geojson&resultRecordCount=50`),
    ];
    if (isCA) {
      fetches.push(fetch(`https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/CA_NFDRS/FeatureServer/1/query`
        + `?where=1=1&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326`
        + `&outFields=PSAName,Avg_BI,Avg_BI_Pct,Avg_ERC,Avg_ERC_Pct,Avg_FM100Hr,Avg_FM1000Hr`
        + `&outSR=4326&f=geojson&resultRecordCount=1`));
    }
    // Outside California, resolve NFDRS from the nearest RAWS station via FEMS (national).
    const nationalNfdrs = isCA ? null : _fetchNationalNFDRS(lat, lng).catch(() => null);
    const [firesRes, nfdrsRes] = await Promise.allSettled(fetches);

    // Process active fires
    let fires = [];
    if (firesRes.status === 'fulfilled' && firesRes.value.ok) {
      const data = await firesRes.value.json();
      fires = (data.features || []).map(f => {
        const p = f.properties;
        const coords = f.geometry?.coordinates;
        let fireLat = lat, fireLng = lng;
        if (coords) {
          // Get centroid from first coordinate of polygon
          const ring = Array.isArray(coords[0]?.[0]?.[0]) ? coords[0][0] : (Array.isArray(coords[0]?.[0]) ? coords[0] : coords);
          if (ring.length > 0) { fireLng = ring[0][0]; fireLat = ring[0][1]; }
        }
        const distKm = typeof haversine === 'function' ? haversine(lat, lng, fireLat, fireLng) : 0;
        return {
          name: p.poly_IncidentName || 'Unknown Fire',
          acres: Math.round(p.poly_GISAcres || 0),
          contained: p.poly_PercentContained,
          date: p.poly_CreateDate,
          distNm: (distKm * 0.539957).toFixed(1),
          geometry: f.geometry,
        };
      });
      fires.sort((a, b) => parseFloat(a.distNm) - parseFloat(b.distNm));
    }

    // Process NFDRS fire danger
    let fireDanger = null;
    if (nfdrsRes.status === 'fulfilled' && nfdrsRes.value.ok) {
      const data = await nfdrsRes.value.json();
      const f = data.features?.[0]?.properties;
      if (f) {
        fireDanger = {
          psa: f.PSAName || 'Unknown',
          bi: f.Avg_BI, biPct: f.Avg_BI_Pct,
          erc: f.Avg_ERC, ercPct: f.Avg_ERC_Pct,
          fm100: f.Avg_FM100Hr, fm1000: f.Avg_FM1000Hr,
        };
      }
    }

    if (!fireDanger && nationalNfdrs) fireDanger = await nationalNfdrs;

    S.fireDanger = fireDanger;
    S.activeFires = fires;

    // Render fire perimeters on map
    renderFirePerimeters(fires);

    // Render fire info in NOTAMs tab
    renderFireDangerCard(fires, fireDanger, lat, lng);

    clearDataSourceError('Fire Danger');
    markSection('fireDanger', { status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.warn('Fire danger fetch failed:', err);
    recordDataSourceError('Fire Danger', err);
    markSection('fireDanger', { status: 'error', error: err && err.message ? err.message : String(err) });
  } finally {
    trackFetchEnd('Fire Danger');
  }
}

function renderFirePerimeters(fires) {
  if (!S.mapLayers.fire_perimeters) S.mapLayers.fire_perimeters = L.layerGroup().addTo(S.map);
  else S.mapLayers.fire_perimeters.clearLayers();

  fires.forEach(fire => {
    if (!fire.geometry) return;
    try {
      const layer = L.geoJSON(fire.geometry, {
        style: { color: '#ef4444', fillColor: '#f97316', fillOpacity: 0.25, weight: 2 },
      });
      layer.bindPopup(
        `<b style="color:#ef4444">${fire.name}</b><br>` +
        `${fire.acres.toLocaleString()} acres<br>` +
        (fire.contained != null ? `${fire.contained}% contained<br>` : '') +
        `${fire.distNm} nm from area`
      );
      S.mapLayers.fire_perimeters.addLayer(layer);
    } catch (_) { /* invalid geometry */ }
  });
  buildLayerControl();
}

function renderFireDangerCard(fires, danger, lat, lng) {
  const notamDiv = document.getElementById('notamList');
  if (!notamDiv) return;

  // Find the existing wildfire card or append after the TFR card
  let html = '';

  // Fire danger rating card
  if (danger) {
    const biLevel = danger.biPct >= 90 ? 'red' : danger.biPct >= 70 ? 'amber' : 'green';
    const ercLevel = danger.ercPct >= 90 ? 'red' : danger.ercPct >= 70 ? 'amber' : 'green';
    const biColor = biLevel === 'red' ? '#ef4444' : biLevel === 'amber' ? '#f59e0b' : '#22c55e';
    const ercColor = ercLevel === 'red' ? '#ef4444' : ercLevel === 'amber' ? '#f59e0b' : '#22c55e';
    const adjective = danger.ercPct >= 97 ? 'EXTREME' : danger.ercPct >= 90 ? 'VERY HIGH' : danger.ercPct >= 70 ? 'HIGH' : danger.ercPct >= 50 ? 'MODERATE' : 'LOW';
    const cardClass = danger.ercPct >= 90 ? 'tfr' : danger.ercPct >= 70 ? 'notam-style' : '';

    html += `<div class="notam-card ${cardClass}">
      <div class="notam-header">
        <span class="notam-id">FIRE DANGER: ${adjective}</span>
        <span class="notam-type ${danger.ercPct >= 90 ? 'tfr-type' : 'notam-type-tag'}">${danger.psa}</span>
      </div>
      <div class="notam-body" style="font-family:var(--font-mono);font-size:11px;">
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          <div>Burning Index: <b style="color:${biColor}">${danger.bi != null ? Math.round(danger.bi) : '--'}</b> (${danger.biPct != null ? Math.round(danger.biPct) : '--'}th %ile)</div>
          <div>Energy Release: <b style="color:${ercColor}">${danger.erc != null ? Math.round(danger.erc) : '--'}</b> (${danger.ercPct != null ? Math.round(danger.ercPct) : '--'}th %ile)</div>
        </div>
        <div style="margin-top:4px;">100hr Fuel Moisture: ${danger.fm100 != null ? Math.round(danger.fm100) + '%' : '--'} &bull; 1000hr: ${danger.fm1000 != null ? Math.round(danger.fm1000) + '%' : '--'}</div>
      </div>
      <div class="notam-meta">NFDRS data via NIFC &bull; Percentiles relative to historical range</div>
    </div>`;
  }

  // Active fires card
  if (fires.length > 0) {
    html += `<div class="notam-card tfr">
      <div class="notam-header">
        <span class="notam-id">ACTIVE FIRES: ${fires.length}</span>
        <span class="notam-type tfr-type">Live</span>
      </div>
      <div class="notam-body" style="font-family:var(--font-mono);font-size:11px;">
        ${fires.slice(0, 10).map(f =>
          `<div style="padding:2px 0;">${f.name} &mdash; ${f.acres.toLocaleString()} ac, ${f.distNm} nm` +
          (f.contained != null ? ` (${f.contained}% cont.)` : '') + `</div>`
        ).join('')}
        ${fires.length > 10 ? `<div style="color:var(--text-muted);">+ ${fires.length - 10} more</div>` : ''}
      </div>
      <div class="notam-meta">Wildfire TFRs activate with &lt;30 min notice &bull; NIFC perimeter data</div>
    </div>`;
  } else {
    html += `<div class="notam-card" style="border-color:var(--accent-green);">
      <div class="notam-header">
        <span class="notam-id" style="color:var(--accent-green);">NO ACTIVE FIRES NEARBY</span>
      </div>
      <div class="notam-body">No wildland fire perimeters detected within ~30 nm of search area.</div>
    </div>`;
  }

  // Append to notamList after existing TFR content
  const fireDiv = document.getElementById('fireDangerCards');
  if (fireDiv) {
    fireDiv.innerHTML = html;
  } else {
    const container = document.createElement('div');
    container.id = 'fireDangerCards';
    container.innerHTML = html;
    notamDiv.appendChild(container);
  }
}

function computeAirspace(lat, lng) {
  // Compute nearest airport from dynamically fetched data
  const nearby = filterAirportsByDistance(S.nearbyAirports || [], lat, lng, 100);
  const nearest = nearby.length > 0 ? nearby[0] : null;
  const nearDist = nearest ? nearest.distKm : Infinity;
  const nearNm = (nearDist * 0.539957).toFixed(1);

  setText('airNearAirport', nearest ? `${nearest.icao} \u2014 ${nearest.name}` : 'None found');
  setText('airNearDist', nearest ? `${nearNm} nm` : '--');
  setColor('airNearDist', nearDist < 9.26 ? 'red' : nearDist < 18.52 ? 'amber' : 'green');

  // Count nearby heliports
  const heliports = nearby.filter(a => a.type === 'heliport');
  if (heliports.length > 0) {
    const hList = heliports.slice(0, 3).map(h => `${h.icao} (${h.distKm.toFixed(1)} km)`).join(', ');
    setText('airHeliports', `${heliports.length} nearby: ${hList}`);
    setColor('airHeliports', 'amber');
  } else {
    setText('airHeliports', 'None within range');
    setColor('airHeliports', 'green');
  }

  // Use live FAA data if available, otherwise fall back to hardcoded logic
  if (S.faaAirspace && S.faaAirspace.classAirspace && S.faaAirspace.classAirspace.features && S.faaAirspace.classAirspace.features.length > 0) {
    // Find the most restrictive class airspace intersecting the area
    const classPriority = { B: 1, C: 2, D: 3, E: 4 };
    let mostRestrictive = null;
    S.faaAirspace.classAirspace.features.forEach(f => {
      const cls = (f.properties.CLASS || '').charAt(0);
      const pri = classPriority[cls] || 99;
      if (!mostRestrictive || pri < (classPriority[mostRestrictive.cls] || 99)) {
        const upper = f.properties.UPPER_VAL ? `${f.properties.UPPER_VAL} ${f.properties.UPPER_UOM || 'MSL'}` : '';
        const lower = f.properties.LOWER_VAL != null ? `${f.properties.LOWER_VAL} ${f.properties.LOWER_UOM || ''}` : 'Surface';
        mostRestrictive = {
          cls: cls,
          name: f.properties.IDENT || f.properties.NAME || '',
          label: `Class ${cls} \u2014 ${f.properties.IDENT || f.properties.NAME || ''} ${lower} to ${upper}`.trim(),
          controlled: cls === 'B' || cls === 'C' || cls === 'D',
        };
      }
    });

    if (mostRestrictive) {
      setText('airClass', mostRestrictive.label);
      setColor('airClass', mostRestrictive.controlled ? 'amber' : 'green');
      setText('airLAANC', mostRestrictive.controlled ? 'Yes \u2014 required' : 'N/A (Class G)');
      setColor('airLAANC', mostRestrictive.controlled ? 'amber' : 'green');
    } else {
      setText('airClass', 'Class G \u2014 Uncontrolled');
      setColor('airClass', 'green');
      setText('airLAANC', 'N/A (Class G)');
      setColor('airLAANC', 'green');
    }

    // LAANC ceiling from facility map
    if (S.faaAirspace.laanc && S.faaAirspace.laanc.features && S.faaAirspace.laanc.features.length > 0) {
      // Find the minimum ceiling (most restrictive) in the operational area
      let minCeiling = Infinity;
      S.faaAirspace.laanc.features.forEach(f => {
        const ceil = f.properties.CEILING;
        if (ceil != null && ceil < minCeiling) minCeiling = ceil;
      });
      if (minCeiling < Infinity) {
        setText('airLAANCAlt', minCeiling === 0 ? 'No UAS operations (0 ft)' : `${minCeiling} ft AGL`);
        setColor('airLAANCAlt', minCeiling === 0 ? 'red' : minCeiling <= 100 ? 'amber' : 'green');
      } else {
        setText('airLAANCAlt', '400 ft AGL');
      }
    } else {
      setText('airLAANCAlt', (mostRestrictive && mostRestrictive.controlled) ? 'No LAANC grid data' : '400 ft AGL');
    }
  } else {
    // Fallback: use hardcoded classification
    const airspace = classifyAirspace(nearest, nearDist);
    setText('airClass', airspace.label);
    setColor('airClass', airspace.controlled ? 'amber' : 'green');
    setText('airLAANC', airspace.controlled ? 'Yes \u2014 required' : 'N/A (Class G)');
    setColor('airLAANC', airspace.controlled ? 'amber' : 'green');
    setText('airLAANCAlt', airspace.controlled ? 'Check grid cell' : '400 ft AGL');
  }

  // Special Use Airspace from FAA data
  if (S.faaAirspace && S.faaAirspace.sua && S.faaAirspace.sua.features) {
    const moas = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('M'));
    const restricted = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('R'));
    const prohibited = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('P'));

    if (moas.length > 0) {
      setText('airMOA', moas.map(f => f.properties.NAME || 'MOA').join(', '));
      setColor('airMOA', 'amber');
    } else {
      setText('airMOA', 'None');
      setColor('airMOA', 'green');
    }
    if (restricted.length > 0) {
      setText('airRestricted', restricted.map(f => f.properties.NAME || 'Restricted').join(', '));
      setColor('airRestricted', 'red');
    } else {
      setText('airRestricted', 'None');
      setColor('airRestricted', 'green');
    }
    if (prohibited.length > 0) {
      setText('airProhibited', prohibited.map(f => f.properties.NAME || 'Prohibited').join(', '));
      setColor('airProhibited', 'red');
    } else {
      setText('airProhibited', 'None');
      setColor('airProhibited', 'green');
    }
  }

  // TFRs from FAA data
  if (S.faaAirspace && S.faaAirspace.tfrs && S.faaAirspace.tfrs.features) {
    if (S.faaAirspace.tfrs.features.length > 0) {
      setText('airTFR', S.faaAirspace.tfrs.features.map(f => f.properties.NAME || 'TFR').join(', '));
      setColor('airTFR', 'red');
    } else {
      setText('airTFR', 'None');
      setColor('airTFR', 'green');
    }
  }

  // National Security UAS Restrictions
  if (S.faaAirspace && S.faaAirspace.nsRestrictions && S.faaAirspace.nsRestrictions.features) {
    if (S.faaAirspace.nsRestrictions.features.length > 0) {
      setText('airNSRestrict', S.faaAirspace.nsRestrictions.features.map(f => f.properties.NAME || 'NS Restriction').join(', '));
      setColor('airNSRestrict', 'red');
    } else {
      setText('airNSRestrict', 'None');
      setColor('airNSRestrict', 'green');
    }
  }
}

// ============================================================
// DYNAMIC AIRPORT QUERY VIA OVERPASS
// ============================================================
async function fetchNearbyAirports(center, bounds) {
  trackFetchStart('Airports');
  try {
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const pad = 0.8; // ~55nm buffer for airport search
    const bbox = `${sw.lat - pad},${sw.lng - pad},${ne.lat + pad},${ne.lng + pad}`;
    const cacheKey = typeof areaKey === 'function' ? areaKey(center.lat, center.lng) : `${center.lat.toFixed(3)}_${center.lng.toFixed(3)}`;

    // Try cached first
    if (typeof getCachedApiResponse === 'function') {
      const cached = await getCachedApiResponse('airports', cacheKey);
      if (cached && cached.data && cached.status !== 'expired') {
        S.nearbyAirports = _parseOverpassAirports(cached.data);
        renderAirportMarkers(center.lat, center.lng);
        computeAirspace(center.lat, center.lng);
        clearDataSourceError('Airports');
        const _aptFresh = cached.status === 'fresh';
        markSection('airspace', _aptFresh
          ? { source: 'airports', status: 'live', updatedAt: cached.timestamp, error: null }
          : { source: 'airports', status: 'cached', cachedAt: cached.timestamp, error: null });
        trackFetchEnd('Airports');
        return;
      }
    }

    const query = `[out:json][timeout:30];(`
      + `nwr["aeroway"="aerodrome"](${bbox});`
      + `nwr["aeroway"="helipad"](${bbox});`
      + `);out body center;`;

    const overpassServers = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
    let data = null;
    for (const server of overpassServers) {
      try {
        const res = await fetch(server, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
        break;
      } catch (e) {
        console.warn(`Overpass airport mirror ${server} failed:`, e.message);
        if (server === overpassServers[overpassServers.length - 1]) throw e;
      }
    }

    S.nearbyAirports = _parseOverpassAirports(data);

    // Cache results
    if (typeof cacheApiResponse === 'function') cacheApiResponse('airports', cacheKey, data);

    renderAirportMarkers(center.lat, center.lng);
    computeAirspace(center.lat, center.lng);
    clearDataSourceError('Airports');
    markSection('airspace', { source: 'airports', status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.warn('Airport fetch failed:', err);
    recordDataSourceError('Airports', err);
    markSection('airspace', { source: 'airports', status: 'error', error: err && err.message ? err.message : String(err) });
    S.nearbyAirports = [];
  } finally {
    trackFetchEnd('Airports');
  }
}

function _parseOverpassAirports(data) {
  if (!data || !data.elements) return [];
  const airports = [];
  const seen = new Set();

  data.elements.forEach(el => {
    const tags = el.tags || {};
    const isHelipad = tags.aeroway === 'helipad';
    const isAerodrome = tags.aeroway === 'aerodrome';
    if (!isHelipad && !isAerodrome) return;

    // Get coordinates (node has lat/lon directly, way/relation uses center)
    const lat = el.lat || el.center?.lat;
    const lng = el.lon || el.center?.lon;
    if (!lat || !lng) return;

    // Deduplicate by coordinate proximity
    const coordKey = `${lat.toFixed(4)}_${lng.toFixed(4)}`;
    if (seen.has(coordKey)) return;
    seen.add(coordKey);

    // Determine identifier
    const icao = tags.icao || tags.ref || tags.faa || tags['ref:ICAO'] || '';
    const name = tags.name || tags['name:en'] || (isHelipad ? 'Helipad' : 'Airfield');

    // Determine type
    let type;
    if (isHelipad) {
      type = 'heliport';
    } else if (tags.iata) {
      type = 'large_airport';
    } else if (icao.match(/^K[A-Z]{3}$/) || tags['aerodrome:type'] === 'regional' || tags['aerodrome:type'] === 'international') {
      type = 'medium_airport';
    } else {
      type = 'small_airport';
    }

    // Elevation
    let elevation_ft = 0;
    if (tags.ele) {
      const m = parseFloat(tags.ele);
      if (!isNaN(m)) elevation_ft = Math.round(m * 3.28084);
    }

    airports.push({
      icao: icao || `OSM${el.id}`,
      name,
      type,
      lat,
      lng,
      elevation_ft,
      municipality: tags['addr:city'] || tags['addr:municipality'] || '',
    });
  });

  return airports;
}

// ============================================================
// AIRPORT MARKERS ON MAP
// ============================================================
function renderAirportMarkers(lat, lng) {
  if (!S.mapLayers.airports) {
    S.mapLayers.airports = L.layerGroup().addTo(S.map);
  } else {
    S.mapLayers.airports.clearLayers();
  }

  const nearby = filterAirportsByDistance(S.nearbyAirports || [], lat, lng, 55);

  nearby.forEach(a => {
    const distNm = (a.distKm * 0.539957).toFixed(1);
    const typeLabel = a.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const isHeli = a.type === 'heliport';
    const sz = isHeli ? 22 : (a.type === 'large_airport' ? 26 : a.type === 'medium_airport' ? 22 : 18);
    const color = isHeli ? '#a78bfa' : '#f59e0b';

    // Airports use the plane silhouette inside a black-outlined circular badge so
    // they read distinctly from bare ADS-B traffic planes (which share the same
    // silhouette). Heliports keep their lettered disc.
    const svgIcon = isHeli
      ? `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${color}" fill-opacity="0.85" stroke="#fff" stroke-width="1.5"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold" font-family="sans-serif">H</text></svg>`
      : `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#fff" fill-opacity="0.85" stroke="#000" stroke-width="1.5"/><g transform="translate(12 12) scale(0.6) translate(-12 -12)"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="${color}" stroke="#000" stroke-width="1"/></g></svg>`;

    const icon = L.divIcon({
      html: svgIcon,
      className: '',
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2],
    });

    const marker = L.marker([a.lat, a.lng], { icon });

    marker.bindTooltip(a.icao, {
      permanent: false,
      direction: 'top',
      className: 'airport-tooltip',
      offset: [0, -sz/2],
    });

    marker.bindPopup(
      `<div style="font-family:var(--font-mono,monospace);font-size:12px;">` +
      `<b style="color:${color}">${a.icao}</b> — ${a.name}<br>` +
      `<span style="opacity:0.7">${typeLabel}</span><br>` +
      (a.elevation_ft ? `Elev: ${a.elevation_ft.toLocaleString()} ft<br>` : '') +
      (a.municipality ? `${a.municipality}<br>` : '') +
      `<b>${distNm} nm</b> from area center</div>`
    );

    S.mapLayers.airports.addLayer(marker);
  });
}

// ============================================================
// API: NWS SEVERE WEATHER ALERTS (FREE, no key, CORS-friendly)
// ============================================================
async function fetchNWSAlerts(lat, lng) {
  trackFetchStart('NWS Alerts');
  setStatus('alertStatus', 'loading', 'Checking...');
  try {
    const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lng}`, {
      headers: { 'User-Agent': '(SAR-Preflight-Tool, github.com/TheCoderPerson/SAR-Preflight)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];

    S.nwsAlerts = features.map(f => ({
      id: f.properties.id || f.id,
      event: f.properties.event,
      severity: f.properties.severity,
      urgency: f.properties.urgency,
      headline: f.properties.headline,
      description: f.properties.description,
      instruction: f.properties.instruction,
      onset: f.properties.onset,
      expires: f.properties.expires,
      senderName: f.properties.senderName,
      geometry: f.geometry,
    }));

    renderNWSAlertCards();
    renderNWSAlertPolygons();
    buildLayerControl();

    // Cache NWS alerts data
    if (typeof cacheApiResponse === 'function') cacheApiResponse('nws', areaKey(lat, lng), data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('NWS Alerts');
    if (S.nwsAlerts.length > 0) {
      setStatus('alertStatus', 'live', `${S.nwsAlerts.length} ALERT${S.nwsAlerts.length > 1 ? 'S' : ''}`);
    } else {
      setStatus('alertStatus', 'live', 'CLEAR');
    }
    markSection('alerts', { status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.error('NWS Alerts fetch error:', err);
    recordDataSourceError('NWS Alerts', err);
    const _alertErrMsg = err && err.message ? err.message : String(err);
    markSection('alerts', { status: 'error', error: _alertErrMsg });
    // Try cached NWS alerts data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const k = typeof areaKey === 'function' ? areaKey(lat, lng) : `${lat.toFixed(3)}_${lng.toFixed(3)}`;
        const cached = await getCachedApiResponse('nws', k);
        if (cached && cached.data && cached.data.features) {
          S.nwsAlerts = cached.data.features.map(f => ({
            id: f.properties.id || f.id,
            event: f.properties.event,
            severity: f.properties.severity,
            urgency: f.properties.urgency,
            headline: f.properties.headline,
            description: f.properties.description,
            instruction: f.properties.instruction,
            onset: f.properties.onset,
            expires: f.properties.expires,
            senderName: f.properties.senderName,
            geometry: f.geometry,
          }));
          renderNWSAlertCards();
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('alertStatus', badge, label);
          markSection('alerts', { status: 'cached', cachedAt: cached.timestamp, error: _alertErrMsg });
        } else {
          S.nwsAlerts = [];
          renderNWSAlertCards();
          setStatus('alertStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('NWS alerts cache fallback failed:', cacheErr);
        S.nwsAlerts = [];
        renderNWSAlertCards();
        setStatus('alertStatus', 'error', 'ERROR');
      }
    } else {
      S.nwsAlerts = [];
      renderNWSAlertCards();
      setStatus('alertStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('NWS Alerts');
  }
}

function renderNWSAlertCards() {
  const section = document.getElementById('alertSection');
  const list = document.getElementById('alertList');
  if (!section || !list) return;

  if (S.nwsAlerts.length === 0) {
    section.style.display = '';
    list.innerHTML = `<div class="notam-card" style="border-left:3px solid var(--accent-green);">
      <div class="notam-header"><span class="notam-id" style="color:var(--accent-green);">NO ACTIVE ALERTS</span>
      <span class="notam-type" style="background:rgba(34,197,94,0.15);color:var(--accent-green);">Clear</span></div>
      <div class="notam-body">No NWS weather alerts active for this area.</div></div>`;
    return;
  }

  section.style.display = '';
  list.innerHTML = S.nwsAlerts.map(a => {
    const sevColor = a.severity === 'Extreme' || a.severity === 'Severe'
      ? 'var(--accent-red)' : a.severity === 'Moderate'
      ? 'var(--accent-amber)' : 'var(--accent-cyan)';
    const sevBg = a.severity === 'Extreme' || a.severity === 'Severe'
      ? 'rgba(239,68,68,0.15)' : a.severity === 'Moderate'
      ? 'rgba(245,158,11,0.15)' : 'rgba(6,182,212,0.15)';
    const onset = a.onset ? new Date(a.onset).toLocaleString('en-US', { timeZone: _localTZ(), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const expires = a.expires ? new Date(a.expires).toLocaleString('en-US', { timeZone: _localTZ(), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    // Show the full hazard detail (HAZARD/SOURCE/IMPACT block), not just the headline —
    // for e.g. a Special Weather Statement the headline alone says nothing about wind/hail/flood.
    const desc = ((a.description || '').substring(0, 600) + ((a.description || '').length > 600 ? '...' : '')).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, ' ');
    const instr = ((a.instruction || '').substring(0, 300) + ((a.instruction || '').length > 300 ? '...' : '')).replace(/\n+/g, ' ');

    return `<div class="notam-card" style="border-left:3px solid ${sevColor};">
      <div class="notam-header">
        <span class="notam-id" style="color:${sevColor};">${a.event}</span>
        <span class="notam-type" style="background:${sevBg};color:${sevColor};">${a.severity}</span>
      </div>
      <div class="notam-body">${a.headline ? `<b>${a.headline}</b>` : ''}${a.headline && desc ? '<br>' : ''}${desc}${instr ? `<div style="margin-top:4px;font-style:italic;opacity:0.85;">\u26a0 ${instr}</div>` : ''}</div>
      <div class="notam-meta">${onset ? `Onset: ${onset}` : ''}${expires ? ` \u2022 Expires: ${expires}` : ''}${a.senderName ? ` \u2022 ${a.senderName}` : ''}</div>
    </div>`;
  }).join('');
}

function renderNWSAlertPolygons() {
  if (!S.mapLayers.nws_alerts) {
    S.mapLayers.nws_alerts = L.layerGroup().addTo(S.map);
  } else {
    S.mapLayers.nws_alerts.clearLayers();
  }

  S.nwsAlerts.forEach(a => {
    if (!a.geometry) return;
    const fillColor = (a.severity === 'Extreme' || a.severity === 'Severe') ? '#ef4444' : '#f59e0b';
    const layer = L.geoJSON(a.geometry, {
      style: { color: fillColor, weight: 2, fillColor: fillColor, fillOpacity: 0.15, dashArray: '4,4' },
    });
    layer.bindPopup(`<b>${a.event}</b><br>${a.severity} \u2014 ${a.urgency}<br><span style="font-size:11px;">${(a.headline || '').substring(0, 200)}</span>${a.description ? `<br><span style="font-size:11px;">${a.description.substring(0, 400).replace(/\n+/g, ' ')}${a.description.length > 400 ? '...' : ''}</span>` : ''}`, { maxWidth: 320 });
    S.mapLayers.nws_alerts.addLayer(layer);
  });
}

// ============================================================
// API: FAA UDDS — Airspace, SUA, TFR, LAANC, NS Restrictions
// ============================================================
async function fetchFAAairspace(bounds) {
  trackFetchStart('FAA Airspace');
  setStatus('faaAirspaceStatus', 'loading', 'Fetching...');
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const geom = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
  const base = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
  const cacheKey = `${sw.lat.toFixed(3)}_${sw.lng.toFixed(3)}_${ne.lat.toFixed(3)}_${ne.lng.toFixed(3)}`;

  const urls = {
    classAirspace: `${base}/Class_Airspace/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=IDENT,NAME,CLASS,UPPER_VAL,UPPER_UOM,LOWER_VAL,LOWER_UOM,LOCAL_TYPE&outSR=4326&f=geojson&resultRecordCount=500`,
    sua: `${base}/Special_Use_Airspace/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME,TYPE_CODE,LOCAL_TYPE,UPPER_VAL,LOWER_VAL&outSR=4326&f=geojson&resultRecordCount=500`,
    tfrs: `${base}/National_Defense_Airspace_TFR_Areas/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=NAME,TYPE_CODE,LOCAL_TYPE,CITY,STATE&outSR=4326&f=geojson&resultRecordCount=200`,
    laanc: `${base}/FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=CEILING,APT1_FAAID,APT1_NAME&outSR=4326&f=geojson&resultRecordCount=2000`,
    nsRestrictions: `${base}/Part_Time_National_Security_UAS_Flight_Restrictions/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&outSR=4326&f=geojson&resultRecordCount=200`,
    prohibited: `${base}/Prohibited_Areas/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=*&outSR=4326&f=geojson&resultRecordCount=200`,
  };

  try {
    const keys = Object.keys(urls);
    const results = await Promise.allSettled(keys.map(k => fetch(urls[k]).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })));

    const data = {};
    keys.forEach((k, i) => {
      if (results[i].status === 'fulfilled') {
        data[k] = results[i].value;
      } else {
        data[k] = { type: 'FeatureCollection', features: [] };
      }
    });

    S.faaAirspace = data;

    // Render map layers
    renderFAAairspaceLayers();
    // Update airspace tab with live FAA data
    computeAirspace(S.areaCenter.lat, S.areaCenter.lng);

    // Cache
    if (typeof cacheApiResponse === 'function') {
      cacheApiResponse('faa_airspace', cacheKey, data);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('FAA Airspace');
    setStatus('faaAirspaceStatus', 'live', 'LIVE');
    buildLayerControl();
    markSection('airspace', { source: 'faa', status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.error('FAA Airspace fetch error:', err);
    recordDataSourceError('FAA Airspace', err);
    const _airErrMsg = err && err.message ? err.message : String(err);
    markSection('airspace', { source: 'faa', status: 'error', error: _airErrMsg });
    // Try cached data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('faa_airspace', cacheKey);
        if (cached && cached.data) {
          S.faaAirspace = cached.data;
          renderFAAairspaceLayers();
          computeAirspace(S.areaCenter.lat, S.areaCenter.lng);
          buildLayerControl();
          const age = Date.now() - cached.timestamp;
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('faaAirspaceStatus', 'cached', label);
          markSection('airspace', { source: 'faa', status: 'cached', cachedAt: cached.timestamp, error: _airErrMsg });
        } else {
          setStatus('faaAirspaceStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('FAA airspace cache fallback failed:', cacheErr);
        setStatus('faaAirspaceStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('faaAirspaceStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('FAA Airspace');
  }
}

function renderFAAairspaceLayers() {
  if (typeof L === 'undefined') return;
  if (!S.faaAirspace) return;

  const classColors = AIRSPACE_CLASS_COLORS;
  const suaColors = SUA_COLORS;

  // Class Airspace layer
  if (S.mapLayers.faa_class_airspace) S.mapLayers.faa_class_airspace.clearLayers();
  else S.mapLayers.faa_class_airspace = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_class_airspace && S.faaAirspace.classAirspace && S.faaAirspace.classAirspace.features) {
    S.faaAirspace.classAirspace.features.forEach(f => {
      const cls = (f.properties.CLASS || '').charAt(0);
      const color = classColors[cls] || '#888888';
      const layer = L.geoJSON(f, {
        style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.10 },
      });
      const name = f.properties.NAME || f.properties.IDENT || '';
      const upper = f.properties.UPPER_VAL ? `${f.properties.UPPER_VAL} ${f.properties.UPPER_UOM || ''}` : '';
      const lower = f.properties.LOWER_VAL != null ? `${f.properties.LOWER_VAL} ${f.properties.LOWER_UOM || ''}` : 'SFC';
      layer.bindPopup(`<b>Class ${cls}</b> — ${name}<br>${lower} to ${upper}`);
      S.mapLayers.faa_class_airspace.addLayer(layer);
    });
  }

  // SUA layer
  if (S.mapLayers.faa_sua) S.mapLayers.faa_sua.clearLayers();
  else S.mapLayers.faa_sua = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_sua && S.faaAirspace.sua && S.faaAirspace.sua.features) {
    S.faaAirspace.sua.features.forEach(f => {
      const tc = (f.properties.TYPE_CODE || '').charAt(0);
      const color = suaColors[tc] || '#f59e0b';
      const layer = L.geoJSON(f, {
        style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.12, dashArray: '5,5' },
      });
      layer.bindPopup(`<b>${f.properties.NAME || 'SUA'}</b><br>Type: ${f.properties.LOCAL_TYPE || f.properties.TYPE_CODE || '--'}`);
      S.mapLayers.faa_sua.addLayer(layer);
    });
  }

  // TFR layer
  if (S.mapLayers.faa_tfr) S.mapLayers.faa_tfr.clearLayers();
  else S.mapLayers.faa_tfr = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_tfr && S.faaAirspace.tfrs && S.faaAirspace.tfrs.features) {
    S.faaAirspace.tfrs.features.forEach(f => {
      const layer = L.geoJSON(f, {
        style: { color: '#ef4444', weight: 3, fillColor: '#ef4444', fillOpacity: 0.20, dashArray: '3,3' },
      });
      layer.bindPopup(`<b>TFR</b> — ${f.properties.NAME || ''}<br>${f.properties.CITY || ''} ${f.properties.STATE || ''}`);
      S.mapLayers.faa_tfr.addLayer(layer);
    });
  }

  // LAANC grid layer
  if (S.mapLayers.faa_laanc) S.mapLayers.faa_laanc.clearLayers();
  else S.mapLayers.faa_laanc = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_laanc && S.faaAirspace.laanc && S.faaAirspace.laanc.features) {
    S.faaAirspace.laanc.features.forEach(f => {
      const ceil = f.properties.CEILING != null ? f.properties.CEILING : -1;
      const color = laancCeilingColor(f.properties.CEILING);
      const layer = L.geoJSON(f, {
        style: { color: color, weight: 1, fillColor: color, fillOpacity: 0.15 },
      });
      const aptName = f.properties.APT1_NAME || f.properties.APT1_FAAID || '';
      layer.bindPopup(`<b>LAANC Grid</b><br>Ceiling: ${ceil} ft AGL<br>${aptName}`);
      S.mapLayers.faa_laanc.addLayer(layer);
    });
  }

  // National Security UAS Flight Restrictions layer. Already fetched into
  // S.faaAirspace.nsRestrictions and drives NO-GO in computeAssessment(); this
  // makes it visible on the map. Fields per the FAA Part-Time NSFR schema
  // (Facility/Base/Reason/POC) — there is no NAME field.
  if (S.mapLayers.faa_ns_restrictions) S.mapLayers.faa_ns_restrictions.clearLayers();
  else S.mapLayers.faa_ns_restrictions = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_ns_restrictions && S.faaAirspace.nsRestrictions && S.faaAirspace.nsRestrictions.features) {
    S.faaAirspace.nsRestrictions.features.forEach(f => {
      const p = f.properties || {};
      const layer = L.geoJSON(f, {
        style: { color: '#dd1133', weight: 2, fillColor: '#dd1133', fillOpacity: 0.18, dashArray: '6,3' },
      });
      const title = p.Facility || p.Base || p.NAME || 'National Security UAS Restriction';
      const lines = [`<b>${title}</b>`];
      if (p.Reason) lines.push(p.Reason);
      const alt = [p.Floor, p.Ceiling].filter(Boolean).join(' to ');
      if (alt) lines.push(alt);
      if (p.POC) lines.push(`POC: ${p.POC}`);
      layer.bindPopup(lines.join('<br>'));
      S.mapLayers.faa_ns_restrictions.addLayer(layer);
    });
  }

  // Prohibited Areas (dedicated FAA Prohibited_Areas service). May overlap the
  // SUA "P" type areas above; rendered separately for completeness.
  if (S.mapLayers.faa_prohibited) S.mapLayers.faa_prohibited.clearLayers();
  else S.mapLayers.faa_prohibited = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.faa_prohibited && S.faaAirspace.prohibited && S.faaAirspace.prohibited.features) {
    S.faaAirspace.prohibited.features.forEach(f => {
      const p = f.properties || {};
      const layer = L.geoJSON(f, {
        style: { color: '#991b1b', weight: 2, fillColor: '#991b1b', fillOpacity: 0.20 },
      });
      const nm = p.NAME || p.LOCAL_TYPE || p.TYPE_CODE || 'Prohibited Area';
      layer.bindPopup(`<b>Prohibited Area</b><br>${nm}`);
      S.mapLayers.faa_prohibited.addLayer(layer);
    });
  }
}

// ============================================================
// API: FAA DIGITAL OBSTACLE FILE (DOF) — verified man-made obstacles (FREE)
// Authoritative FAA AIS obstacle data (verified AGL/AMSL heights, lighting &
// marking status, type code) on the SAME ArcGIS org as the airspace layers, so
// it is CORS-enabled and always reflects the current 56-day cycle. CAUTION: the
// DOF is NOT a complete low-altitude inventory — below ~200' AGL away from
// airports it is intentionally sparse, so absence is not proof of clear air.
// ============================================================
const UAS_CEILING_FT = 400; // Part 107 max AGL — the drone's operating band ceiling

async function fetchFaaObstacles(bounds) {
  trackFetchStart('FAA Obstacles');
  setStatus('obstacleStatus', 'loading', 'Fetching...');
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  // Pad ~0.01 deg (~1km) so obstacles just outside the drawn box are caught.
  const pad = 0.01;
  const geom = `${sw.lng - pad},${sw.lat - pad},${ne.lng + pad},${ne.lat + pad}`;
  const base = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
  const url = `${base}/Digital_Obstacle_File/FeatureServer/0/query`
    + `?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326`
    + `&spatialRel=esriSpatialRelIntersects`
    + `&outFields=OAS_Number,Type_Code,AGL,AMSL,Lighting,Marking,Verified`
    + `&outSR=4326&f=geojson&resultRecordCount=2000`;
  const cacheKey = `${sw.lat.toFixed(3)}_${sw.lng.toFixed(3)}_${ne.lat.toFixed(3)}_${ne.lng.toFixed(3)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    S.faaObstacles = data;
    renderObstacleLayer();
    updateObstacleDisplay(summarizeObstacles(data.features, UAS_CEILING_FT));
    computeAssessment();

    if (typeof cacheApiResponse === 'function') cacheApiResponse('faa_obstacles', cacheKey, data);
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('FAA Obstacles');
    const n = (data.features || []).length;
    // maxRecordCount on the service is 2000; flag if a large AO was clipped.
    setStatus('obstacleStatus', 'live', n >= 2000 ? '2000+ (clipped)' : `${n}`);
    buildLayerControl();
    markSection('obstacles', { source: 'dof', status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.error('FAA Obstacles fetch error:', err);
    recordDataSourceError('FAA Obstacles', err);
    const _dofErrMsg = err && err.message ? err.message : String(err);
    markSection('obstacles', { source: 'dof', status: 'error', error: _dofErrMsg });
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('faa_obstacles', cacheKey);
        if (cached && cached.data) {
          S.faaObstacles = cached.data;
          renderObstacleLayer();
          updateObstacleDisplay(summarizeObstacles(cached.data.features, UAS_CEILING_FT));
          computeAssessment();
          buildLayerControl();
          const age = Date.now() - cached.timestamp;
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('obstacleStatus', 'cached', label);
          markSection('obstacles', { source: 'dof', status: 'cached', cachedAt: cached.timestamp, error: _dofErrMsg });
        } else {
          setStatus('obstacleStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('FAA obstacles cache fallback failed:', cacheErr);
        setStatus('obstacleStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('obstacleStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('FAA Obstacles');
  }
}

function renderObstacleLayer() {
  if (typeof L === 'undefined') return;
  if (S.mapLayers.faa_obstacles) S.mapLayers.faa_obstacles.clearLayers();
  else S.mapLayers.faa_obstacles = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (!S.mapLayers.faa_obstacles || !S.faaObstacles || !S.faaObstacles.features) return;

  S.faaObstacles.features.forEach(f => {
    const g = f.geometry;
    if (!g || !g.coordinates) return;
    const lng = g.coordinates[0], lat = g.coordinates[1];
    if (lat == null || lng == null) return;
    const p = f.properties || {};
    const agl = Number(p.AGL);
    const color = obstacleMarkerColor(agl);
    const marker = L.circleMarker([lat, lng], {
      radius: 5, color: '#000', weight: 1, fillColor: color, fillOpacity: 0.9,
      aglFt: isFinite(agl) && agl > 0 ? agl : null, // 3D view extrudes this as a cylinder
    });
    const lines = [`<b style="color:${color}">${obstacleLabel(p)}</b>`];
    const h = [];
    if (isFinite(agl)) h.push(`${agl} ft AGL`);
    if (isFinite(Number(p.AMSL))) h.push(`${Number(p.AMSL)} ft MSL`);
    if (h.length) lines.push(h.join(' / '));
    lines.push(`Lighting: ${obstacleLighting(p.Lighting)}`);
    if ((p.Verified || '').toString().trim().toUpperCase() === 'U') {
      lines.push('<span style="color:#f59e0b">UNVERIFIED position/height</span>');
    }
    lines.push(`<span style="font-size:10px;opacity:0.6">FAA DOF ${p.OAS_Number || ''}</span>`);
    marker.bindPopup(lines.join('<br>'));
    S.mapLayers.faa_obstacles.addLayer(marker);
  });
}

function updateObstacleDisplay(summary) {
  const s = summary || { total: 0 };
  if (!s.total) {
    setText('terrObstacles', 'None in DOF (not a complete low-alt inventory)');
    setColor('terrObstacles', 'green');
    return;
  }
  const tallest = s.maxAgl > 0 ? `, tallest ${s.maxAgl} ft AGL` : '';
  const unv = s.unverified > 0 ? `, ${s.unverified} unverified` : '';
  setText('terrObstacles', `${s.total} obstacle${s.total === 1 ? '' : 's'}${tallest}${unv} — see map`);
  setColor('terrObstacles', obstacleHazardLevel(s));
}

// ============================================================
// API: CRITICAL INFRASTRUCTURE & PROTECTED AREAS (FREE, no key)
// Dams (49 USC § 46307), Wilderness (USFS), National Parks (NPS)
// ============================================================
async function fetchProtectedAreas(bounds) {
  trackFetchStart('Protected Areas');
  setStatus('protectedAreasStatus', 'loading', 'Fetching...');
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  // Extend bounding box by ~0.02 degrees (~2km) to catch nearby features
  const pad = 0.02;
  const geom = `${sw.lng - pad},${sw.lat - pad},${ne.lng + pad},${ne.lat + pad}`;
  const cacheKey = `${sw.lat.toFixed(3)}_${sw.lng.toFixed(3)}_${ne.lat.toFixed(3)}_${ne.lng.toFixed(3)}`;

  const urls = {
    dams: `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Dams_in_America_Trace3/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=DAM_NAME,LATITUDE,LONGITUDE,HAZARD,OWN_NAME,STATE,NID_HEIGHT,PURPOSES&outSR=4326&f=geojson&resultRecordCount=200`,
    wilderness: `https://services1.arcgis.com/ERdCHt0sNM6dENSD/arcgis/rest/services/S_USA_Wilderness/FeatureServer/0/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=WILDERNE_1,GIS_ACRES,WID&outSR=4326&f=geojson&resultRecordCount=50`,
    nationalParks: `https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2/query?where=1=1&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outFields=PARKNAME,UNIT_TYPE&outSR=4326&f=geojson&resultRecordCount=50`,
  };

  try {
    const keys = Object.keys(urls);
    const results = await Promise.allSettled(keys.map(k => fetch(urls[k]).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })));

    const data = { dams: [], wilderness: [], nationalParks: [] };
    keys.forEach((k, i) => {
      if (results[i].status === 'fulfilled') {
        const gj = results[i].value;
        data[k] = (gj && gj.features) ? gj.features : [];
      }
    });

    S.protectedAreas = data;
    renderProtectedAreaLayers();

    // Update terrain tab dam info
    if (data.dams.length > 0) {
      setText('terrHwy', `${data.dams.length} dam${data.dams.length > 1 ? 's' : ''} within area \u2014 see map`);
    }

    // Cache
    if (typeof cacheApiResponse === 'function') {
      cacheApiResponse('protected_areas', cacheKey, data);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    clearDataSourceError('Protected Areas');
    const total = data.dams.length + data.wilderness.length + data.nationalParks.length;
    setStatus('protectedAreasStatus', 'live', total > 0 ? `${total} FOUND` : 'CLEAR');
    buildLayerControl();
    markSection('obstacles', { source: 'protected', status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.error('Protected Areas fetch error:', err);
    recordDataSourceError('Protected Areas', err);
    const _protErrMsg = err && err.message ? err.message : String(err);
    markSection('obstacles', { source: 'protected', status: 'error', error: _protErrMsg });
    // Try cached data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('protected_areas', cacheKey);
        if (cached && cached.data) {
          S.protectedAreas = cached.data;
          renderProtectedAreaLayers();
          if (cached.data.dams && cached.data.dams.length > 0) {
            setText('terrHwy', `${cached.data.dams.length} dam${cached.data.dams.length > 1 ? 's' : ''} within area \u2014 see map`);
          }
          buildLayerControl();
          const age = Date.now() - cached.timestamp;
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('protectedAreasStatus', 'cached', label);
          markSection('obstacles', { source: 'protected', status: 'cached', cachedAt: cached.timestamp, error: _protErrMsg });
        } else {
          setStatus('protectedAreasStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Protected areas cache fallback failed:', cacheErr);
        setStatus('protectedAreasStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('protectedAreasStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Protected Areas');
  }
}

function renderProtectedAreaLayers() {
  if (typeof L === 'undefined') return;
  if (!S.protectedAreas) return;

  // Dams layer — "D" marker at each dam location (geometry is river trace, not dam structure)
  if (S.mapLayers.dams) S.mapLayers.dams.clearLayers();
  else S.mapLayers.dams = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.dams && S.protectedAreas.dams) {
    S.protectedAreas.dams.forEach(f => {
      const p = f.properties || {};
      const popup = [
        `<b style="color:#ef4444">${p.DAM_NAME || 'Dam'}</b>`,
        p.NID_HEIGHT ? `Height: ${p.NID_HEIGHT} ft` : '',
        p.HAZARD ? `Hazard: ${p.HAZARD === 'H' ? 'HIGH' : p.HAZARD === 'S' ? 'SIGNIFICANT' : p.HAZARD}` : '',
        p.OWN_NAME ? `Owner: ${p.OWN_NAME}` : '',
        `<span style="color:#ef4444;font-size:10px;font-weight:bold;">UAS prohibited within 400ft \u2014 49 USC \u00A7 46307</span>`,
      ].filter(Boolean).join('<br>');
      // Place marker at the dam's reported coordinates (not the river trace geometry)
      if (p.LATITUDE && p.LONGITUDE && typeof L.divIcon === 'function') {
        const sz = 22;
        const icon = L.divIcon({
          html: `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#ef4444" fill-opacity="0.9" stroke="#fff" stroke-width="1.5"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="12" font-weight="bold" font-family="sans-serif">D</text></svg>`,
          className: '', iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
        });
        const damH = Number(p.NID_HEIGHT);
        L.marker([p.LATITUDE, p.LONGITUDE], { icon, aglFt: isFinite(damH) && damH > 0 ? damH : null, cylColor: '#ef4444' }).bindPopup(popup).addTo(S.mapLayers.dams);
      }
    });
  }

  // Wilderness layer — dark green polygons
  if (S.mapLayers.wilderness) S.mapLayers.wilderness.clearLayers();
  else S.mapLayers.wilderness = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.wilderness && S.protectedAreas.wilderness) {
    S.protectedAreas.wilderness.forEach(f => {
      const p = f.properties || {};
      const layer = L.geoJSON(f, {
        style: { color: '#166534', weight: 2, fillColor: '#166534', fillOpacity: 0.15 },
      });
      const acres = p.GIS_ACRES ? `${Math.round(p.GIS_ACRES).toLocaleString()} acres` : '';
      layer.bindPopup(
        `<b style="color:#166534">${p.WILDERNE_1 || 'Wilderness Area'}</b>`
        + (acres ? `<br>${acres}` : '')
        + `<br><span style="color:#f59e0b;font-size:10px;font-weight:bold;">UAS requires USFS permit</span>`
      );
      S.mapLayers.wilderness.addLayer(layer);
    });
  }

  // National Parks layer — dark brown/olive polygons
  if (S.mapLayers.national_parks) S.mapLayers.national_parks.clearLayers();
  else S.mapLayers.national_parks = typeof L.layerGroup === 'function' ? L.layerGroup() : null;
  if (S.mapLayers.national_parks && S.protectedAreas.nationalParks) {
    S.protectedAreas.nationalParks.forEach(f => {
      const p = f.properties || {};
      const layer = L.geoJSON(f, {
        style: { color: '#78350f', weight: 2, fillColor: '#78350f', fillOpacity: 0.15 },
      });
      layer.bindPopup(
        `<b style="color:#78350f">${p.PARKNAME || 'National Park'}</b>`
        + (p.UNIT_TYPE ? `<br>Type: ${p.UNIT_TYPE}` : '')
        + `<br><span style="color:#f59e0b;font-size:10px;font-weight:bold;">UAS requires NPS authorization per 36 CFR 1.5</span>`
      );
      S.mapLayers.national_parks.addLayer(layer);
    });
  }
}

// ============================================================
// GROUND ACCESS, PUBLIC LANDS, WATER & HOSPITALS (free SAR-context overlays)
// USFS/BLM ArcGIS servers block browser CORS → routed through the data proxy
// (/usfs/, /blm/); USGS NHD + Overpass are CORS-clean and fetched directly. All
// new layer groups are created OFF the map (opt-in via the layer control) so they
// don't clutter the default view; each self-caches to IndexedDB for offline reuse.
// ============================================================

function _bboxCacheKey(bounds) {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  return `${sw.lat.toFixed(3)}_${sw.lng.toFixed(3)}_${ne.lat.toFixed(3)}_${ne.lng.toFixed(3)}`;
}
function _envelopeGeom(bounds, pad) {
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  pad = (pad == null) ? 0.01 : pad;
  return `${sw.lng - pad},${sw.lat - pad},${ne.lng + pad},${ne.lat + pad}`;
}
// Build an ArcGIS FeatureServer/MapServer GeoJSON query path for a bbox.
function _arcgisGeoJsonUrl(base, layerId, bounds, outFields, opts) {
  opts = opts || {};
  const geom = _envelopeGeom(bounds, opts.pad);
  const where = encodeURIComponent(opts.where || '1=1');
  const count = opts.resultRecordCount || 2000;
  let url = `${base}/${layerId}/query?where=${where}&geometry=${geom}`
    + `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`
    + `&outFields=${encodeURIComponent(outFields)}&outSR=4326&f=geojson&resultRecordCount=${count}`;
  // Server-side generalization (degrees at outSR=4326). Some layers with huge
  // multipart polygons (BLM SMA) 500 on full-resolution geometry without it.
  if (opts.maxAllowableOffset != null) url += `&maxAllowableOffset=${opts.maxAllowableOffset}`;
  if (opts.geometryPrecision != null) url += `&geometryPrecision=${opts.geometryPrecision}`;
  return url;
}
// Same, but routed through the data proxy for a self-hosted gov ArcGIS server
// (returns null when no proxy is configured → callers degrade gracefully).
function _govArcgisUrl(routePrefix, serviceBase, layerId, bounds, outFields, opts) {
  return proxiedArcgis(routePrefix, _arcgisGeoJsonUrl(serviceBase, layerId, bounds, outFields, opts));
}
// Case-insensitive property lookup with fallbacks (ArcGIS field casing varies).
function _prop(props, ...names) {
  if (!props) return undefined;
  for (const n of names) if (props[n] != null && props[n] !== '') return props[n];
  const lower = {};
  for (const k in props) lower[k.toLowerCase()] = props[k];
  for (const n of names) { const v = lower[String(n).toLowerCase()]; if (v != null && v !== '') return v; }
  return undefined;
}
async function _cachedFeatures(endpoint, cacheKey) {
  if (typeof getCachedApiResponse !== 'function') return null;
  try {
    const c = await getCachedApiResponse(endpoint, cacheKey);
    // Skip cached ArcGIS in-body error responses (cached before that guard existed).
    if (c && c.data && !c.data.error) { const gj = c.data; return { features: (gj && gj.features) ? gj.features : [], fromCache: true, cachedAt: c.timestamp }; }
  } catch (_) { /* ignore */ }
  return null;
}
// Fetch an ArcGIS GeoJSON query (direct or proxied URL), caching on success and
// falling back to IndexedDB on error/offline. Returns {features, fromCache, error}.
// opts.signal: AbortController signal — an aborted fetch returns error:'aborted'
// WITHOUT consulting the cache (a superseded pan-fetch must not repaint stale data).
async function _fetchGeoJsonLayer(endpoint, cacheKey, url, opts) {
  opts = opts || {};
  const online = (typeof isOnline !== 'function') || isOnline();
  if (url && online) {
    try {
      const res = await _proxyFetch(url, opts.signal ? { signal: opts.signal } : undefined);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const gj = await res.json();
      // ArcGIS servers report many failures as HTTP 200 + {"error":{...}} — that is
      // an ERROR, not an empty layer, and must never be cached or rendered as data.
      if (gj && gj.error) throw new Error('ArcGIS ' + (gj.error.code || 'error') + ': ' + (gj.error.message || 'query failed'));
      const features = (gj && gj.features) ? gj.features : [];
      if (typeof cacheApiResponse === 'function') cacheApiResponse(endpoint, cacheKey, gj);
      return { features, fromCache: false, cachedAt: null, exceededTransferLimit: !!(gj && gj.exceededTransferLimit) };
    } catch (err) {
      if (err && err.name === 'AbortError') return { features: null, error: 'aborted' };
      const cached = await _cachedFeatures(endpoint, cacheKey);
      if (cached) return cached;
      return { features: null, error: (err && err.message) || String(err) };
    }
  }
  const cached = await _cachedFeatures(endpoint, cacheKey);
  if (cached) return cached;
  return { features: null, error: url ? 'offline' : 'no-proxy' };
}
// Render polyline/polygon GeoJSON features into an off-map layer group.
function _renderVectorLayer(mapId, features, styleFor, popupFor) {
  if (typeof L === 'undefined') return 0;
  if (S.mapLayers[mapId]) S.mapLayers[mapId].clearLayers();
  else S.mapLayers[mapId] = L.layerGroup();
  let n = 0;
  (features || []).forEach(f => {
    if (!f || !f.geometry) return;
    const props = f.properties || {};
    const style = (typeof styleFor === 'function') ? styleFor(props) : styleFor;
    const layer = L.geoJSON(f, { style });
    const html = popupFor ? popupFor(props, f) : '';
    if (html) layer.bindPopup(html);
    S.mapLayers[mapId].addLayer(layer);
    n++;
  });
  return n;
}

// Derive a section-meta status from a set of _fetchGeoJsonLayer results + record it.
function _markSectionFromResults(key, results, noProxyMsg) {
  let live = false, cached = false, cachedAt = null, err = null, noProxy = false;
  (results || []).forEach(r => {
    if (!r) return;
    if (r.features && !r.fromCache) live = true;
    else if (r.features && r.fromCache) { cached = true; if (r.cachedAt) cachedAt = cachedAt ? Math.min(cachedAt, r.cachedAt) : r.cachedAt; }
    if (r.error === 'no-proxy') noProxy = true;
    else if (r.error) err = r.error;
  });
  if (typeof markSection !== 'function') return;
  if (live) markSection(key, { status: 'live', updatedAt: Date.now(), error: null });
  else if (cached) markSection(key, { status: 'cached', cachedAt: cachedAt || Date.now(), error: null });
  else if (noProxy) markSection(key, { status: 'error', error: noProxyMsg || 'Needs data proxy (Config)' });
  else markSection(key, { status: 'error', error: err || 'No data' });
}
// Mirror a section's recorded status onto its title fetch-status pill.
function _syncStatusFromMeta(statusId, key) {
  const m = S.sectionMeta && S.sectionMeta[key];
  if (!m) return;
  const map = { live: ['live', 'LIVE'], cached: ['cached', 'CACHED'], error: ['error', 'ERROR'], never: ['', ''] };
  const [cls, txt] = map[m.status] || map.never;
  setStatus(statusId, cls, txt);
}

// --- Popup/style builders for ground-access layers ---
function _usfsRoadPopup(p) {
  const num = _prop(p, 'ID', 'id'), name = _prop(p, 'NAME', 'name');
  const surf = _prop(p, 'SURFACE_TYPE', 'surface_type');
  const oml = _prop(p, 'OPER_MAINT_LEVEL', 'operationalmaintlevel', 'oper_maint_level');
  return `<b style="color:#c98a3a">NFS Road ${[num, name].filter(Boolean).join(' — ') || ''}</b>`
    + (surf ? `<br>Surface: ${surf}` : '')
    + (oml ? `<br>Maint level: ${oml}` : '')
    + `<br><span style="font-size:10px;opacity:0.6">USFS National Forest System road</span>`;
}
function _usfsTrailPopup(p) {
  const name = _prop(p, 'TRAIL_NAME', 'name') || 'NFS Trail';
  const num = _prop(p, 'TRAIL_NO', 'trailnumber', 'id');
  return `<b style="color:#8b5a2b">${name}</b>` + (num ? `<br>#${num}` : '')
    + `<br><span style="font-size:10px;opacity:0.6">USFS National Forest System trail</span>`;
}
const MVUM_VEHICLE_FIELDS = [
  ['passengervehicle', 'Passenger vehicle'], ['highclearancevehicle', 'High-clearance'],
  ['fourwd_gt50inches', '4WD >50"'], ['twowd_gt50inches', '2WD >50"'],
  ['atv', 'ATV'], ['motorcycle', 'Motorcycle'],
  ['other_ohv_lt50inches', 'OHV <50"'], ['other_ohv_gt50inches', 'OHV >50"'],
  ['tracked_ohv_lt50inches', 'Tracked OHV <50"'], ['tracked_ohv_gt50inches', 'Tracked OHV >50"'],
];
function _mvumPopup(p) {
  const name = _prop(p, 'NAME', 'name', 'ID', 'id') || 'MVUM route';
  const sym = _prop(p, 'MVUM_SYMBOL_NAME', 'mvum_symbol_name', 'SBS_SYMBOL_NAME');
  const allowed = [];
  MVUM_VEHICLE_FIELDS.forEach(([f, label]) => { if (_prop(p, f) != null) allowed.push(label); });
  const season = _prop(p, 'SEASONAL', 'seasonal');
  return `<b style="color:#e0a458">${name}</b>`
    + (sym ? `<br>${sym}` : '')
    + (allowed.length ? `<br>Open to: ${allowed.join(', ')}` : '')
    + (season ? `<br>Seasonal: ${season}` : '')
    + `<br><span style="font-size:10px;opacity:0.6">USFS MVUM — verify current designation on the official map</span>`;
}
function _blmGtlfStyle(p) {
  const d = String(_prop(p, 'PLAN_OHV_ROUTE_DSGNTN', 'dsgntn') || '').toLowerCase();
  const color = d.includes('closed') ? '#ef4444' : d.includes('limit') ? '#f59e0b' : '#a3e635';
  return { color, weight: 2, opacity: 0.85 };
}
function _blmGtlfPopup(p) {
  const name = _prop(p, 'RTE_PRMRY_NM', 'PLAN_PRMRY_NM', 'NAME', 'name') || 'BLM route';
  const dsgn = _prop(p, 'PLAN_OHV_ROUTE_DSGNTN', 'dsgntn');
  const surf = _prop(p, 'SURF_ACST_TYPE', 'surface');
  return `<b style="color:#84cc16">${name}</b>`
    + (dsgn ? `<br>OHV: ${dsgn}` : '')
    + (surf ? `<br>Surface: ${surf}` : '')
    + `<br><span style="font-size:10px;opacity:0.6">BLM ground transportation route</span>`;
}

// Forest roads/trails + MVUM (USFS) and BLM motorized routes — all via the proxy.
async function fetchGroundAccess(bounds) {
  trackFetchStart('Ground Access');
  setStatus('groundAccessStatus', 'loading', 'Fetching...');
  const cacheKey = _bboxCacheKey(bounds);
  const allResults = [];
  try {
    const specs = [
      { mapId: 'usfs_roads', url: _govArcgisUrl('/usfs/', 'arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer', '0', bounds, '*'),
        style: { color: '#c98a3a', weight: 2, opacity: 0.85 }, popup: _usfsRoadPopup },
      { mapId: 'usfs_trails', url: _govArcgisUrl('/usfs/', 'arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer', '0', bounds, '*'),
        style: { color: '#8b5a2b', weight: 2, dashArray: '5,4', opacity: 0.85 }, popup: _usfsTrailPopup },
      { mapId: 'mvum_roads', url: _govArcgisUrl('/usfs/', 'arcx/rest/services/EDW/EDW_MVUM_01/MapServer', '1', bounds, '*'),
        style: { color: '#e0a458', weight: 2, opacity: 0.9 }, popup: _mvumPopup },
      { mapId: 'mvum_trails', url: _govArcgisUrl('/usfs/', 'arcx/rest/services/EDW/EDW_MVUM_01/MapServer', '2', bounds, '*'),
        style: { color: '#c97f3a', weight: 2, dashArray: '5,4', opacity: 0.9 }, popup: _mvumPopup },
    ];
    const results = await Promise.allSettled(specs.map(s => _fetchGeoJsonLayer(s.mapId, cacheKey, s.url)));
    specs.forEach((s, i) => {
      const r = results[i].status === 'fulfilled' ? results[i].value : null;
      allResults.push(r);
      if (r && r.features) _renderVectorLayer(s.mapId, r.features, s.style, s.popup);
    });
    // BLM GTLF — motorized roads (layer 0) + trails (layer 2) merged into one layer.
    const gtlfBase = 'arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer';
    const [gr, gt] = await Promise.all([
      _fetchGeoJsonLayer('blm_gtlf', 'roads_' + cacheKey, _govArcgisUrl('/blm/', gtlfBase, '0', bounds, '*')),
      _fetchGeoJsonLayer('blm_gtlf', 'trails_' + cacheKey, _govArcgisUrl('/blm/', gtlfBase, '2', bounds, '*')),
    ]);
    allResults.push(gr, gt);
    if ((gr && gr.features) || (gt && gt.features)) {
      const merged = [].concat((gr && gr.features) || [], (gt && gt.features) || []);
      _renderVectorLayer('blm_gtlf', merged, _blmGtlfStyle, _blmGtlfPopup);
    }
    // Readout + freshness
    const cnt = id => (S.mapLayers[id] && S.mapLayers[id].getLayers) ? S.mapLayers[id].getLayers().length : 0;
    const roads = cnt('usfs_roads'), trails = cnt('usfs_trails'), mvum = cnt('mvum_roads') + cnt('mvum_trails'), blm = cnt('blm_gtlf');
    const total = roads + trails + mvum + blm;
    setText('terrGroundAccess', total
      ? `Roads ${roads} · Trails ${trails} · MVUM ${mvum} · BLM ${blm}`
      : (getCanopyProxyBase() ? 'None found in area' : 'Needs data proxy (set in Config)'));
    _markSectionFromResults('groundAccess', allResults);
    _syncStatusFromMeta('groundAccessStatus', 'groundAccess');
    buildLayerControl();
  } finally {
    trackFetchEnd('Ground Access');
  }
}

// ============================================================
// NOAA HMS SMOKE + WINTER OPS (avalanche danger, SNODAS snow depth)
// All opt-in overlays created OFF the map. NOAA HMS smoke is a hosted Esri
// FeatureServer, avalanche.org and the NOHRSC WMS are public services — all
// CORS-clean, no proxy needed. Each degrades gracefully (dormant, no hard error)
// when its source is unreachable, mirroring the other overlay fetches.
// ============================================================

// --- NOAA HMS smoke plumes (daily satellite analysis; Light/Medium/Heavy) ---
const HMS_SMOKE_BASE = 'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer';

function _smokeStyleFor(props) {
  const d = String((props && props.Density) || '').toLowerCase();
  const color = d.includes('heavy') ? '#7f1d1d' : d.includes('medium') ? '#ea580c' : '#f59e0b';
  const fillOpacity = d.includes('heavy') ? 0.35 : d.includes('medium') ? 0.25 : 0.15;
  return { color, weight: 1, fillColor: color, fillOpacity };
}
function _smokePopup(props) {
  const p = props || {};
  return `<b style="color:#b45309">Wildfire smoke — ${p.Density || 'Smoke'}</b>`
    + (p.Satellite ? `<br>Satellite: ${p.Satellite}` : '')
    + (p.Start ? `<br>Start: ${p.Start} UTC` : '')
    + (p.End_ ? `<br>End: ${p.End_} UTC` : '')
    + `<br><span style="color:#f59e0b;font-size:10px;font-weight:bold;">Reduces visibility / VLOS — advisory, current-day satellite analysis</span>`;
}

async function fetchHMSSmoke(bounds) {
  const b = bounds || S.areaBounds;
  if (!b) return;
  const cacheKey = _bboxCacheKey(b);
  try {
    const url = _arcgisGeoJsonUrl(HMS_SMOKE_BASE, '0', b, 'Density,Satellite,Start,End_', { pad: 0.5 });
    const r = await _fetchGeoJsonLayer('hms_smoke', cacheKey, url);
    if (r && r.features) {
      S.hmsSmoke = r.features;
      _renderVectorLayer('hms_smoke', r.features, _smokeStyleFor, _smokePopup);
      clearDataSourceError('Smoke');
    } else if (r && r.error && r.error !== 'offline') {
      recordDataSourceError('Smoke', new Error(r.error));
    }
    buildLayerControl();
    if (S.currentArea) computeAssessment();
  } catch (e) {
    recordDataSourceError('Smoke', e);
  }
}

// --- Avalanche danger zones (avalanche.org public map-layer GeoJSON, danger 1-5) ---
const AVALANCHE_MAPLAYER_URL = 'https://api.avalanche.org/v2/public/products/map-layer';
const AVALANCHE_DANGER_NAMES = ['No Rating', 'Low (1)', 'Moderate (2)', 'Considerable (3)', 'High (4)', 'Extreme (5)'];

function _avalancheStyle(props) {
  const p = props || {};
  const lvl = Number(p.danger_level) || 0;
  return { color: '#374151', weight: 1, fillColor: p.color || '#9ca3af', fillOpacity: lvl >= 1 ? 0.35 : 0.12 };
}
function _avalanchePopup(props) {
  const p = props || {};
  const lvl = (p.danger_level != null && p.danger_level >= 1) ? p.danger_level : null;
  const label = lvl != null ? (AVALANCHE_DANGER_NAMES[lvl] || `Level ${lvl}`) : 'No rating / off-season';
  return `<b>${p.name || 'Avalanche zone'}</b>`
    + (p.center ? `<br>${p.center}` : '')
    + `<br>Danger: <b style="color:${p.color || '#999'}">${label}</b>`
    + (p.warning ? `<br><span style="color:#ef4444;font-weight:bold;">⚠ Avalanche warning in effect</span>` : '')
    + (p.travel_advice ? `<br><span style="font-size:10px;opacity:0.7">${String(p.travel_advice).slice(0, 160)}</span>` : '')
    + `<br><span style="font-size:10px;opacity:0.6">avalanche.org — verify at the source before travel</span>`;
}
// True when a [lat,lng] ring's bbox overlaps the padded area bbox.
function _ringNearArea(ring, south, west, north, east) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const pt of ring) {
    const la = pt[0], ln = pt[1];
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
  }
  return !(maxLat < south || minLat > north || maxLng < west || minLng > east);
}

async function fetchAvalanche(bounds) {
  const b = bounds || S.areaBounds;
  if (!b) return;
  const pad = 0.75;
  const south = b.getSouth() - pad, north = b.getNorth() + pad, west = b.getWest() - pad, east = b.getEast() + pad;
  const online = (typeof isOnline !== 'function') || isOnline();
  try {
    let fc = null;
    if (online) {
      const res = await fetch(AVALANCHE_MAPLAYER_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      fc = await res.json();
      if (typeof cacheApiResponse === 'function') cacheApiResponse('avalanche', 'us', fc);
    } else {
      const c = await _cachedFeatures('avalanche', 'us');
      if (c) fc = { features: c.features };
    }
    const all = (fc && fc.features) ? fc.features : [];
    const near = all.filter(f => (typeof geoJsonOuterRings === 'function' ? geoJsonOuterRings(f.geometry) : [])
      .some(r => _ringNearArea(r, south, west, north, east)));
    S.avalanche = near;
    _renderVectorLayer('avalanche', near, _avalancheStyle, _avalanchePopup);
    clearDataSourceError('Avalanche');
    buildLayerControl();
    if (S.currentArea) computeAssessment();
  } catch (e) {
    recordDataSourceError('Avalanche', e);
  }
}

// --- SNODAS snow depth (NOHRSC WMS raster overlay; global, built lazily) ---
const SNODAS_WMS_URL = 'https://mapservices.weather.noaa.gov/raster/services/snow/NOHRSC_Snow_Analysis/MapServer/WMSServer';

// Create (off-map) the SNODAS snow-depth WMS layer once. Sublayer 5 is the snow-depth
// image (1 = SWE image; 3/7 are boundary outlines — requesting 3 was a bug that drew
// nothing). The service only supports EPSG:4326-family CRS, not Leaflet's default
// EPSG:3857, so the layer pins crs explicitly. Returns the layer or null if Leaflet
// WMS is unavailable (e.g. under jsdom in tests).
function ensureSnowLayer() {
  if (typeof L === 'undefined' || !L.tileLayer || typeof L.tileLayer.wms !== 'function') return null;
  if (!S.mapLayers.snow_depth) {
    S.mapLayers.snow_depth = L.tileLayer.wms(SNODAS_WMS_URL, {
      layers: '5', format: 'image/png', transparent: true, opacity: 0.55,
      crs: L.CRS.EPSG4326,
      attribution: 'NOAA NOHRSC SNODAS',
    });
  }
  return S.mapLayers.snow_depth;
}

// --- GOES-East GeoColor clouds (NASA GIBS WMS) + lightning strike density (NOAA nowCOAST) ---
// Global near-real-time raster overlays, built lazily and off by default. Both use the
// WMS path (not WMTS) so Leaflet handles the bbox and we don't hard-code a tile-matrix
// set. A wrong layer/time just yields blank tiles — never a crash.

const GIBS_WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
function ensureGoesLayer() {
  if (typeof L === 'undefined' || !L.tileLayer || typeof L.tileLayer.wms !== 'function') return null;
  if (!S.mapLayers.goes_clouds) {
    S.mapLayers.goes_clouds = L.tileLayer.wms(GIBS_WMS_URL, {
      layers: 'GOES-East_ABI_GeoColor', format: 'image/png', transparent: true,
      // TIME is deliberately omitted: GIBS then serves its latest available frame. Computing
      // 'now minus a latency buffer' breaks whenever GIBS ingest lag exceeds the buffer
      // (observed >2 h), which returns blank transparent tiles for the not-yet-existing frame.
      opacity: 0.7, attribution: 'NASA GIBS / NOAA GOES-East',
    });
  }
  return S.mapLayers.goes_clouds;
}

// Fetch the newest available GeoColor frame time from GIBS WMTS DescribeDomains (a few KB
// with a bounded TIME window, vs the multi-MB full GetCapabilities). GIBS ingest lag varies
// from minutes to hours, so we show users how old the imagery actually is rather than
// pretending it is live. Stored on S.goesFrameTime and surfaced in the layer-control label.
async function refreshGoesFrameTime() {
  try {
    const now = Date.now();
    const d0 = new Date(now - 3 * 86400e3).toISOString().slice(0, 10);
    const d1 = new Date(now + 86400e3).toISOString().slice(0, 10);
    const u = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&VERSION=1.0.0'
      + '&REQUEST=DescribeDomains&LAYER=GOES-East_ABI_GeoColor&TILEMATRIXSET=GoogleMapsCompatible_Level8'
      + `&TIME=${d0}/${d1}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    // <Domain> holds comma-separated 'start/end/PT10M' ranges, oldest first — take the last end.
    const m = txt.match(/<Domain>([^<]*)<\/Domain>/);
    if (!m || !m[1]) return null;
    const ranges = m[1].split(',');
    const newest = ranges[ranges.length - 1].split('/')[1];
    if (newest) { S.goesFrameTime = newest; buildLayerControl(); }
    return newest || null;
  } catch (e) { return null; } // cosmetic only — never block the layer on this
}

// NOAA nowCOAST GeoServer lightning strike density (ground-network LDN, 15-min, ~8 km grid;
// not GOES GLM satellite data, despite the internal glm_* identifiers kept for compatibility). Endpoint per
// the 2023 nowCOAST GeoServer migration (the old /arcgis/ MapServer was retired). Time is
// omitted so the service returns its latest frame. If tiles are blank, confirm the layer
// name against nowcoast.noaa.gov/geoserver/lightning_detection/ows?request=GetCapabilities.
const GLM_WMS_URL = 'https://nowcoast.noaa.gov/geoserver/lightning_detection/ows';
function ensureGlmLayer() {
  if (typeof L === 'undefined' || !L.tileLayer || typeof L.tileLayer.wms !== 'function') return null;
  if (!S.mapLayers.glm_lightning) {
    S.mapLayers.glm_lightning = L.tileLayer.wms(GLM_WMS_URL, {
      layers: 'lightning_detection:ldn_lightning_strike_density', format: 'image/png', transparent: true,
      opacity: 0.75, attribution: 'NOAA nowCOAST lightning strike density',
    });
  }
  return S.mapLayers.glm_lightning;
}

// BLM Surface Management Agency — public/private land + the non-public CAUTION.
function _renderPublicLands(features) {
  if (typeof L === 'undefined') return 0;
  if (S.mapLayers.public_lands) S.mapLayers.public_lands.clearLayers();
  else S.mapLayers.public_lands = L.layerGroup();
  let n = 0;
  (features || []).forEach(f => {
    if (!f || !f.geometry) return;
    const info = smaAgencyInfo(_prop(f.properties, 'ADMIN_AGENCY_CODE'));
    const layer = L.geoJSON(f, { style: { color: info.color, weight: 1, fillColor: info.color, fillOpacity: info.isPublic ? 0.12 : 0.22 } });
    const unit = _prop(f.properties, 'ADMIN_UNIT_NAME');
    layer.bindPopup(`<b style="color:${info.color}">${info.label}</b>` + (unit ? `<br>${unit}` : '')
      + (info.isPublic ? '' : `<br><span style="color:#f59e0b;font-size:10px;font-weight:bold;">Non-public surface — verify landowner permission</span>`));
    S.mapLayers.public_lands.addLayer(layer);
    n++;
  });
  return n;
}
function computeLandStatus(features) {
  if (!Array.isArray(features) || !features.length) return null;
  if (typeof currentAreaPolygon !== 'function') return null;
  const aoi = currentAreaPolygon();
  if (!aoi || aoi.length < 3) return null;
  const publicRings = [];
  features.forEach(f => {
    if (smaIsPublic(_prop(f.properties, 'ADMIN_AGENCY_CODE'))) {
      geoJsonOuterRings(f.geometry).forEach(r => publicRings.push(r));
    }
  });
  return classifyAreaPublicPrivate(aoi, publicRings, 11);
}
async function fetchPublicLands(bounds) {
  trackFetchStart('Public Lands');
  setStatus('publicLandsStatus', 'loading', 'Fetching...');
  const cacheKey = _bboxCacheKey(bounds);
  // maxAllowableOffset is REQUIRED: BLM's server (ArcGIS 11.5) 500s on any
  // full-resolution geometry query against this layer. ~110 m generalization +
  // 5-decimal coords keeps the huge statewide SMA polygons phone-sized; fine
  // for the advisory land-status % and map shading.
  const url = _govArcgisUrl('/blm/', 'arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer', '1', bounds,
    'ADMIN_AGENCY_CODE,ADMIN_DEPT_CODE,ADMIN_UNIT_NAME',
    { resultRecordCount: 4000, maxAllowableOffset: 0.001, geometryPrecision: 5 });
  try {
    const r = await _fetchGeoJsonLayer('public_lands', cacheKey, url);
    if (r && r.features) {
      S.publicLands = r.features;
      _renderPublicLands(r.features);
      S.landStatus = computeLandStatus(r.features);
    } else {
      S.publicLands = null; S.landStatus = null;
    }
    if (S.landStatus && S.landStatus.sampled > 0) {
      const pub = Math.round((1 - S.landStatus.privateFrac) * 100);
      setText('terrLandOwnership', `Public ~${pub}% · Private ~${100 - pub}%`);
    } else {
      setText('terrLandOwnership', (r && r.features) ? 'No private land detected'
        : (getCanopyProxyBase() ? 'No surface-mgmt data in area' : 'Needs data proxy (set in Config)'));
    }
    _markSectionFromResults('publicLands', [r]);
    _syncStatusFromMeta('publicLandsStatus', 'publicLands');
    if (S.currentArea && typeof computeAssessment === 'function') computeAssessment();
    buildLayerControl();
  } finally {
    trackFetchEnd('Public Lands');
  }
}

// USGS NHD hydrography — streams/rivers (flowline) + lakes/reservoirs (waterbody).
async function fetchWaterFeatures(bounds) {
  trackFetchStart('Water (NHD)');
  setStatus('waterStatus', 'loading', 'Fetching...');
  const cacheKey = _bboxCacheKey(bounds);
  const base = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer';
  try {
    const [flow, wb] = await Promise.all([
      _fetchGeoJsonLayer('nhd_water', 'flow_' + cacheKey, _arcgisGeoJsonUrl(base, '6', bounds, '*', { resultRecordCount: 2000 })),
      _fetchGeoJsonLayer('nhd_water', 'wb_' + cacheKey, _arcgisGeoJsonUrl(base, '12', bounds, '*', { resultRecordCount: 1000 })),
    ]);
    if (typeof L !== 'undefined') {
      if (S.mapLayers.nhd_water) S.mapLayers.nhd_water.clearLayers();
      else S.mapLayers.nhd_water = L.layerGroup();
      const popup = (p) => {
        const nm = _prop(p, 'gnis_name', 'GNIS_NAME', 'name');
        const t = _prop(p, 'fcode_description', 'FCODE_DESCRIPTION', 'ftype');
        return `<b style="color:#3b82f6">${nm || 'Water feature'}</b>` + (t ? `<br>${t}` : '');
      };
      ((flow && flow.features) || []).forEach(f => {
        if (!f.geometry) return;
        const layer = L.geoJSON(f, { style: { color: '#3b82f6', weight: 1.5, opacity: 0.85 } });
        const h = popup(f.properties || {}); if (h) layer.bindPopup(h);
        S.mapLayers.nhd_water.addLayer(layer);
      });
      ((wb && wb.features) || []).forEach(f => {
        if (!f.geometry) return;
        const layer = L.geoJSON(f, { style: { color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.25 } });
        const h = popup(f.properties || {}); if (h) layer.bindPopup(h);
        S.mapLayers.nhd_water.addLayer(layer);
      });
    }
    const n = (S.mapLayers.nhd_water && S.mapLayers.nhd_water.getLayers) ? S.mapLayers.nhd_water.getLayers().length : 0;
    setText('terrWater', n ? `${n} water features` : 'None found in area');
    _markSectionFromResults('water', [flow, wb]);
    _syncStatusFromMeta('waterStatus', 'water');
    buildLayerControl();
  } finally {
    trackFetchEnd('Water (NHD)');
  }
}

// Hospitals + helicopter landing sites via Overpass (CORS-clean, no key/token).
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
function _renderHospitals(elements) {
  if (typeof L === 'undefined') return { total: 0, hospitals: 0, helipads: 0 };
  if (S.mapLayers.hospitals) S.mapLayers.hospitals.clearLayers();
  else S.mapLayers.hospitals = L.layerGroup();
  let nH = 0, nL = 0;
  (elements || []).forEach(el => {
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (lat == null || lng == null) return;
    const t = el.tags || {};
    const isHeli = t.aeroway === 'helipad' || t.emergency === 'landing_site';
    const name = t.name || (isHeli ? 'Helipad' : 'Hospital');
    const color = isHeli ? '#22c55e' : '#ef4444';
    const glyph = isHeli ? 'H' : '+';
    const sz = 22;
    if (typeof L.divIcon !== 'function') return;
    const icon = L.divIcon({
      html: `<svg width="${sz}" height="${sz}" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="4" fill="${color}" fill-opacity="0.92" stroke="#fff" stroke-width="1.5"/><text x="12" y="17" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold" font-family="sans-serif">${glyph}</text></svg>`,
      className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
    });
    const popup = `<b style="color:${color}">${name}</b>`
      + (isHeli ? '<br>Helicopter landing site' : (t.emergency === 'yes' ? '<br>Emergency department' : ''))
      + (t['addr:city'] ? `<br>${t['addr:city']}` : '');
    L.marker([lat, lng], { icon }).bindPopup(popup).addTo(S.mapLayers.hospitals);
    if (isHeli) nL++; else nH++;
  });
  return { total: nH + nL, hospitals: nH, helipads: nL };
}
async function fetchHospitals(bounds) {
  trackFetchStart('Hospitals');
  setStatus('hospitalsStatus', 'loading', 'Fetching...');
  const cacheKey = _bboxCacheKey(bounds);
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const pad = 0.05; // widen so nearby trauma centers/helipads are included
  const bbox = `${sw.lat - pad},${sw.lng - pad},${ne.lat + pad},${ne.lng + pad}`;
  const query = `[out:json][timeout:30];(`
    + `nwr["amenity"="hospital"](${bbox});`
    + `nwr["aeroway"="helipad"](${bbox});`
    + `nwr["emergency"="landing_site"](${bbox});`
    + `);out center tags;`;
  let data = null, fromCache = false, cachedAt = null;
  try {
    if ((typeof isOnline !== 'function') || isOnline()) {
      for (const server of OVERPASS_MIRRORS) {
        try {
          const res = await fetch(server, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json(); break;
        } catch (_) { /* try next mirror */ }
      }
    }
    if (data) { if (typeof cacheApiResponse === 'function') cacheApiResponse('hospitals', cacheKey, data); }
    else if (typeof getCachedApiResponse === 'function') {
      try { const c = await getCachedApiResponse('hospitals', cacheKey); if (c && c.data) { data = c.data; fromCache = true; cachedAt = c.timestamp; } } catch (_) { /* ignore */ }
    }
    let counts = { total: 0, hospitals: 0, helipads: 0 };
    if (data) counts = _renderHospitals(data.elements || []);
    setText('terrHospitals', data
      ? (counts.total ? `${counts.hospitals} hospitals · ${counts.helipads} helipads` : 'None found in area')
      : 'Unavailable (offline, no cache)');
    if (typeof markSection === 'function') {
      if (data && !fromCache) markSection('hospitals', { status: 'live', updatedAt: Date.now(), error: null });
      else if (data && fromCache) markSection('hospitals', { status: 'cached', cachedAt: cachedAt || Date.now(), error: null });
      else markSection('hospitals', { status: 'error', error: 'No data' });
    }
    _syncStatusFromMeta('hospitalsStatus', 'hospitals');
    buildLayerControl();
  } finally {
    trackFetchEnd('Hospitals');
  }
}

// ============================================================
// NAMED TRAILS (OSM via Overpass) — named paths/tracks/footways in the ops
// area, rendered as clickable polylines. Complements the USFS/MVUM layers
// (NFS-land only, export-excluded): OSM covers all land and exports.
// ============================================================
const TRAILS_COLOR = '#f472b6';
function _renderTrails(records) {
  if (typeof L === 'undefined') return 0;
  if (S.mapLayers.trails) S.mapLayers.trails.clearLayers();
  else S.mapLayers.trails = L.layerGroup().addTo(S.map);
  (records || []).forEach(rec => {
    const popup = `<b style="color:${TRAILS_COLOR}">${rec.name}</b>`
      + `<br>${trailTypeLabel(rec.type)}`
      + (rec.surface ? `<br>Surface: ${rec.surface}` : '')
      + (rec.sacScale ? `<br>SAC scale: ${rec.sacScale.replace(/_/g, ' ')}` : '')
      + `<br><span style="font-size:10px;opacity:0.6">OSM Way ${rec.id}</span>`;
    L.polyline(rec.coords, { color: TRAILS_COLOR, weight: 2, dashArray: '5,4', opacity: 0.85 })
      .bindPopup(popup).addTo(S.mapLayers.trails);
  });
  return (records || []).length;
}
async function fetchTrails(bounds) {
  trackFetchStart('Trails');
  setStatus('trailsStatus', 'loading', 'Fetching...');
  const cacheKey = _bboxCacheKey(bounds);
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const pad = 0.015; // hug the ops area — trails are dense data
  const bbox = `${sw.lat - pad},${sw.lng - pad},${ne.lat + pad},${ne.lng + pad}`;
  const query = buildTrailsOverpassQuery(bbox);
  let data = null, fromCache = false, cachedAt = null;
  try {
    if ((typeof isOnline !== 'function') || isOnline()) {
      for (const server of OVERPASS_MIRRORS) {
        try {
          const res = await fetch(server, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          data = await res.json(); break;
        } catch (_) { /* try next mirror */ }
      }
    }
    if (data) { if (typeof cacheApiResponse === 'function') cacheApiResponse('trails', cacheKey, data); }
    else if (typeof getCachedApiResponse === 'function') {
      try { const c = await getCachedApiResponse('trails', cacheKey); if (c && c.data) { data = c.data; fromCache = true; cachedAt = c.timestamp; } } catch (_) { /* ignore */ }
    }
    let count = 0;
    if (data) count = _renderTrails(parseOverpassTrails(data));
    setText('terrTrails', data
      ? (count ? `${count} named trail${count === 1 ? '' : 's'} / paths` : 'None found in area')
      : 'Unavailable (offline, no cache)');
    if (typeof markSection === 'function') {
      if (data && !fromCache) markSection('trails', { status: 'live', updatedAt: Date.now(), error: null });
      else if (data && fromCache) markSection('trails', { status: 'cached', cachedAt: cachedAt || Date.now(), error: null });
      else markSection('trails', { status: 'error', error: 'No data' });
    }
    _syncStatusFromMeta('trailsStatus', 'trails');
    buildLayerControl();
  } finally {
    trackFetchEnd('Trails');
  }
}

// ============================================================
// CELL COVERAGE (per-carrier FCC LTE) — bundled regional overlay
// FCC mobile LTE coverage has no free live API/tile service, so a one-time build
// step (tools/cell-coverage) downloads + simplifies the FCC BDC mobile data for the
// operating region into data/cell/{att,tmobile,verizon}.geojson. Those files load
// here, render as 3 toggleable layers, and sharpen the cell-service readout. Absent
// files (build not run) ⇒ layers simply don't appear and the elevation estimate stands.
// ============================================================
const CELL_CARRIERS = [
  { key: 'att', mapId: 'cell_att', label: 'AT&T', color: '#2563eb' },
  { key: 'tmobile', mapId: 'cell_tmobile', label: 'T-Mobile', color: '#e6007e' },
  { key: 'verizon', mapId: 'cell_verizon', label: 'Verizon', color: '#cd040b' },
];
function _ringsBBox(ringsByCarrier) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity, any = false;
  ['att', 'tmobile', 'verizon'].forEach(k => {
    const rings = ringsByCarrier[k];
    if (!Array.isArray(rings)) return;
    rings.forEach(ring => ring.forEach(pt => {
      any = true;
      if (pt[0] < minLat) minLat = pt[0]; if (pt[0] > maxLat) maxLat = pt[0];
      if (pt[1] < minLng) minLng = pt[1]; if (pt[1] > maxLng) maxLng = pt[1];
    }));
  });
  return any ? { minLat, minLng, maxLat, maxLng } : null;
}
function _pointInRegion(lat, lng, region) {
  return !!region && lat >= region.minLat && lat <= region.maxLat && lng >= region.minLng && lng <= region.maxLng;
}
function _renderCellLayer(mapId, features, color, label) {
  if (typeof L === 'undefined') return;
  if (S.mapLayers[mapId]) S.mapLayers[mapId].clearLayers();
  else S.mapLayers[mapId] = L.layerGroup();
  (features || []).forEach(f => {
    if (!f || !f.geometry) return;
    const layer = L.geoJSON(f, { style: { color, weight: 1, fillColor: color, fillOpacity: 0.18 } });
    layer.bindPopup(`<b style="color:${color}">${label} LTE coverage</b><br><span style="font-size:10px;opacity:0.6">FCC Broadband Data Collection — modeled coverage, verify on-site</span>`);
    S.mapLayers[mapId].addLayer(layer);
  });
}
// Load the bundled per-carrier coverage (data/cell/*.geojson), render layers, and
// cache for offline. No-op per carrier whose file is missing (build not yet run).
async function loadCellCoverage() {
  const coverage = { att: [], tmobile: [], verizon: [] };
  let loadedAny = false;
  for (const c of CELL_CARRIERS) {
    let gj = null;
    try {
      if ((typeof isOnline !== 'function') || isOnline()) {
        const res = await fetch(`data/cell/${c.key}.geojson`, { cache: 'force-cache' });
        if (res.ok) { gj = await res.json(); if (typeof cacheApiResponse === 'function') cacheApiResponse('cell_coverage', c.key, gj); }
      }
    } catch (_) { /* offline / missing */ }
    if (!gj && typeof getCachedApiResponse === 'function') {
      try { const cc = await getCachedApiResponse('cell_coverage', c.key); if (cc && cc.data) gj = cc.data; } catch (_) { /* ignore */ }
    }
    if (gj && gj.features && gj.features.length) {
      loadedAny = true;
      _renderCellLayer(c.mapId, gj.features, c.color, c.label);
      gj.features.forEach(f => geoJsonOuterRings(f.geometry).forEach(r => coverage[c.key].push(r)));
    }
  }
  if (loadedAny) {
    coverage.region = _ringsBBox(coverage);
    S.cellCoverage = coverage;
    if (typeof buildLayerControl === 'function') buildLayerControl();
    if (S.areaCenter && typeof computeOpsData === 'function') computeOpsData(); // refresh cell readout
  }
  return loadedAny;
}
// Cell-service readout: prefer the FCC overlay where it exists; else the elevation
// estimate. Stored in S.cellStatus so computeAssessment can flag a no-coverage area.
function cellCoverageReadout(lat, lng, centerElevFt) {
  const cc = S.cellCoverage;
  if (cc && cc.region && _pointInRegion(lat, lng, cc.region) && typeof cellCoverageAt === 'function') {
    const r = cellCoverageAt(lat, lng, cc);
    const names = [r.att && 'AT&T', r.tmobile && 'T-Mobile', r.verizon && 'Verizon'].filter(Boolean);
    if (r.count >= 2) return { label: `LTE: ${names.join(', ')} (FCC)`, level: 'green', count: r.count, inRegion: true };
    if (r.count === 1) return { label: `LTE: ${names[0]} only (FCC)`, level: 'amber', count: 1, inRegion: true };
    return { label: 'No mapped LTE coverage (FCC) — plan for no connectivity', level: 'red', count: 0, inRegion: true };
  }
  const est = estimateCellCoverage(centerElevFt);
  return { label: est.label, level: est.level, count: null, inRegion: false };
}

// ============================================================
// API: OVERPASS (OSM) — Wire & Cable Hazards (FREE, no key)
// ============================================================
// POST an Overpass QL query, trying each public mirror in turn (the primary
// is frequently overloaded). Resolves the parsed JSON; rejects only when
// every mirror fails.
async function _overpassFetch(query) {
  const overpassServers = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  for (const server of overpassServers) {
    try {
      const res = await fetch(server, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`Overpass mirror ${server} failed:`, e.message);
      if (server === overpassServers[overpassServers.length - 1]) throw e;
    }
  }
}

async function fetchWireHazards(bounds) {
  trackFetchStart('Wire Hazards');
  setStatus('wireStatus', 'loading', 'Fetching...');
  // Only the OSM-sourced categories — the utility_* layers belong to
  // fetchUtilityWires and must survive an independent OSM refresh.
  Object.keys(WIRE_CATEGORIES).filter(k => WIRE_CATEGORIES[k].src === 'osm').forEach(k => {
    const lid = 'wire_' + k;
    if (S.mapLayers[lid]) { S.mapLayers[lid].clearLayers(); }
    else { S.mapLayers[lid] = L.layerGroup().addTo(S.map); }
  });

  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const pad = 0.015;
  const bbox = `${sw.lat - pad},${sw.lng - pad},${ne.lat + pad},${ne.lng + pad}`;

  const query = `[out:json][timeout:60];(`
    + `way["power"="line"](${bbox});`
    + `way["power"="minor_line"](${bbox});`
    + `way["power"="cable"](${bbox});`
    + `way["communication"="line"](${bbox});`
    + `way["telecom"="line"](${bbox});`
    + `way["telephone"="line"](${bbox});`
    + `way["aerialway"](${bbox});`
    + `node["man_made"="mast"](${bbox});`
    + `node["man_made"="communications_tower"](${bbox});`
    + `node["man_made"="tower"](${bbox});`
    + `node["tower:type"="communication"](${bbox});`
    + `node["man_made"="chimney"](${bbox});`
    + `node["man_made"="lighthouse"](${bbox});`
    + `node["man_made"="water_tower"](${bbox});`
    + `node["man_made"="wind_turbine"](${bbox});`
    + `node["man_made"="antenna"](${bbox});`
    + `);out body;>;out skel qt;`;

  try {
    const data = await _overpassFetch(query);
    const elements = data.elements || [];

    const nodes = {};
    elements.forEach(el => {
      if (el.type === 'node') nodes[el.id] = [el.lat, el.lon];
    });

    const counts = {};
    elements.forEach(el => {
      if (el.type !== 'way') return;
      const tags = el.tags || {};
      let cat = null;
      if (tags.power === 'line') cat = 'power_line';
      else if (tags.power === 'minor_line') cat = 'power_minor_line';
      else if (tags.power === 'cable') cat = 'power_cable';
      else if (tags.communication === 'line' || tags.telecom === 'line' || tags.telephone === 'line') cat = 'telecom_line';
      else if (tags.aerialway) cat = 'aerialway';
      if (!cat) return;

      const coords = (el.nodes || []).map(nid => nodes[nid]).filter(Boolean);
      if (coords.length < 2) return;

      counts[cat] = (counts[cat] || 0) + 1;
      const info = WIRE_CATEGORIES[cat];
      const name = wireHazardName(tags, cat);

      const polyline = L.polyline(coords, { color: info.color, weight: info.weight, opacity: 0.8 })
        .bindPopup(`<b style="color:${info.color}">${info.label}</b><br>${name}<br><span style="font-size:10px;opacity:0.6">OSM Way ${el.id}</span>`);
      S.mapLayers['wire_' + cat].addLayer(polyline);
    });

    // Tower/structure node processing (comm towers, masts, chimneys, wind turbines, etc.)
    if (!S.mapLayers.cell_towers) S.mapLayers.cell_towers = L.layerGroup().addTo(S.map);
    else S.mapLayers.cell_towers.clearLayers();
    let towerCount = 0;
    const TOWER_TYPES = {
      'communications_tower': 'Comm Tower',
      'mast': 'Mast',
      'tower': 'Tower',
      'chimney': 'Chimney',
      'lighthouse': 'Lighthouse',
      'water_tower': 'Water Tower',
      'wind_turbine': 'Wind Turbine',
      'antenna': 'Antenna',
    };
    elements.forEach(el => {
      if (el.type !== 'node') return;
      const tags = el.tags || {};
      const mm = tags['man_made'];
      const isTower = TOWER_TYPES[mm] || tags['tower:type'] === 'communication';
      if (!isTower) return;
      towerCount++;

      const label = TOWER_TYPES[mm] || 'Comm Tower';
      const parsedH = osmTowerHeightFt(tags);
      const heightFt = parsedH ? parsedH.heightFt : null;
      const heightLabel = heightFt ? heightFt + "'" : '';

      // FAA sectional-style tower icon: solid inverted triangle with dot on top
      const color = '#00CCFF';
      const sz = 28;
      const svgIcon = `<svg width="${sz}" height="${sz}" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000);">`
        + `<line x1="14" y1="4" x2="14" y2="22" stroke="${color}" stroke-width="1.5"/>`
        + `<circle cx="14" cy="4" r="2.5" fill="${color}"/>`
        + `<line x1="8" y1="12" x2="14" y2="8" stroke="${color}" stroke-width="1"/>`
        + `<line x1="20" y1="12" x2="14" y2="8" stroke="${color}" stroke-width="1"/>`
        + `<line x1="6" y1="18" x2="14" y2="13" stroke="${color}" stroke-width="1"/>`
        + `<line x1="22" y1="18" x2="14" y2="13" stroke="${color}" stroke-width="1"/>`
        + (heightLabel ? `<text x="14" y="27" text-anchor="middle" fill="${color}" font-family="sans-serif" font-size="7" font-weight="bold">${heightLabel}</text>` : '')
        + `</svg>`;

      const icon = L.divIcon({ html: svgIcon, className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
      const popupParts = [`<b style="color:${color}">${label}</b>`];
      if (tags.name) popupParts.push(tags.name);
      if (heightFt) popupParts.push(`Height: ${heightFt} ft (${parsedH.raw})`);
      else popupParts.push(`<span style="opacity:0.6">Height not in OSM</span>`);
      if (tags.operator) popupParts.push(`Operator: ${tags.operator}`);
      popupParts.push(`<span style="font-size:10px;opacity:0.6">OSM Node ${el.id}</span>`);

      L.marker([el.lat, el.lon], { icon, aglFt: heightFt || null, cylColor: color })
        .bindPopup(popupParts.join('<br>'))
        .addTo(S.mapLayers.cell_towers);
    });
    S.towerCount = towerCount;

    S.wireHazardCounts = counts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    updateWireDisplay(counts, towerCount);
    buildLayerControl();

    // Cache overpass data
    if (typeof cacheApiResponse === 'function') {
      const cLat = (sw.lat + ne.lat) / 2;
      const cLng = (sw.lng + ne.lng) / 2;
      cacheApiResponse('overpass', areaKey(cLat, cLng), data);
    }
    if (typeof setLastDataTimestamp === 'function') setLastDataTimestamp(Date.now());

    setStatus('wireStatus', 'live', `${total + towerCount} FEATURES`);
    clearDataSourceError('Wire Hazards');
    markSection('obstacles', { source: 'wire', status: 'live', updatedAt: Date.now(), error: null });
  } catch (err) {
    console.error('Wire hazard fetch error:', err);
    recordDataSourceError('Wire Hazards', err);
    const _wireErrMsg = err && err.message ? err.message : String(err);
    markSection('obstacles', { source: 'wire', status: 'error', error: _wireErrMsg });
    // Try cached overpass data
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cLat = (sw.lat + ne.lat) / 2;
        const cLng = (sw.lng + ne.lng) / 2;
        const k = typeof areaKey === 'function' ? areaKey(cLat, cLng) : `${cLat.toFixed(3)}_${cLng.toFixed(3)}`;
        const cached = await getCachedApiResponse('overpass', k);
        if (cached && cached.data && cached.data.elements) {
          const elements = cached.data.elements;
          const nodes = {};
          elements.forEach(el => { if (el.type === 'node') nodes[el.id] = [el.lat, el.lon]; });
          const counts = {};
          elements.forEach(el => {
            if (el.type !== 'way') return;
            const tags = el.tags || {};
            let cat = null;
            if (tags.power === 'line') cat = 'power_line';
            else if (tags.power === 'minor_line') cat = 'power_minor_line';
            else if (tags.power === 'cable') cat = 'power_cable';
            else if (tags.communication === 'line' || tags.telecom === 'line' || tags.telephone === 'line') cat = 'telecom_line';
            else if (tags.aerialway) cat = 'aerialway';
            if (cat) counts[cat] = (counts[cat] || 0) + 1;
          });
          S.wireHazardCounts = counts;
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          updateWireDisplay(counts, 0);
          const age = Date.now() - cached.timestamp;
          const badge = cached.status === 'stale' ? 'cached' : 'expired';
          const label = typeof formatAge === 'function' ? 'CACHED ' + formatAge(age) : 'CACHED';
          setStatus('wireStatus', badge, `${total} FEAT ${label}`);
          markSection('obstacles', { source: 'wire', status: 'cached', cachedAt: cached.timestamp, error: _wireErrMsg });
        } else {
          setStatus('wireStatus', 'error', 'ERROR');
        }
      } catch (cacheErr) {
        console.warn('Wire hazards cache fallback failed:', cacheErr);
        setStatus('wireStatus', 'error', 'ERROR');
      }
    } else {
      setStatus('wireStatus', 'error', 'ERROR');
    }
  } finally {
    trackFetchEnd('Wire Hazards');
  }
}

// ============================================================
// API: CA UTILITY CIRCUITS — PG&E GRIP feeders + CEC transmission (FREE, no key)
// ============================================================
// California-only supplement to the OSM wire layers (see UTILITY_WIRE_SOURCES
// in core.js). Ops outside every source's coverage bbox are a silent no-op —
// the OSM Overpass fetch runs everywhere regardless, so non-PG&E territory
// (Tahoe basin, Roseville, out of state) keeps exactly the old behavior.
async function fetchUtilityWires(bounds) {
  // Clear/create only the utility categories; the OSM ones belong to fetchWireHazards.
  Object.keys(WIRE_CATEGORIES).filter(k => WIRE_CATEGORIES[k].src === 'utility').forEach(k => {
    const lid = 'wire_' + k;
    if (S.mapLayers[lid]) { S.mapLayers[lid].clearLayers(); }
    else { S.mapLayers[lid] = L.layerGroup().addTo(S.map); }
  });
  S.utilityWireCounts = {};
  S.utilityWireInfo = {};

  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const pad = 0.015; // same op-area padding as the OSM wire fetch
  const bbox = { west: sw.lng - pad, south: sw.lat - pad, east: ne.lng + pad, north: ne.lat + pad };
  const sources = utilityWireSourcesForBounds(UTILITY_WIRE_SOURCES, bbox);
  if (sources.length === 0) return; // out of coverage — not an error, OSM is the wire source here

  trackFetchStart('Utility Circuits');
  const cLat = (sw.lat + ne.lat) / 2, cLng = (sw.lng + ne.lng) / 2;
  const k = typeof areaKey === 'function' ? areaKey(cLat, cLng) : `${cLat.toFixed(3)}_${cLng.toFixed(3)}`;
  let anyLive = false, anyFailed = false, lastErr = null, oldestCache = null;

  await Promise.all(sources.map(async cfg => {
    try {
      const res = await fetch(utilityWireQueryUrl(cfg, bbox));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gj = await res.json();
      // ArcGIS can report failure inside an HTTP-200 body (same lesson as parcels).
      if (gj && gj.error) throw new Error(gj.error.message || 'ArcGIS query error');
      const recs = normalizeUtilityWires(gj.features, cfg, Date.now(), bbox);
      const truncated = !!(gj.properties && gj.properties.exceededTransferLimit) || !!gj.exceededTransferLimit;
      _renderUtilityWires(recs);
      S.utilityWireCounts[cfg.category] = (S.utilityWireCounts[cfg.category] || 0) + recs.length;
      S.utilityWireInfo[cfg.id] = { label: cfg.label, count: recs.length, truncated };
      anyLive = true;
      if (typeof cacheApiResponse === 'function') cacheApiResponse('utility_wires', `${k}:${cfg.id}`, { recs, truncated });
    } catch (err) {
      console.warn(`Utility circuits (${cfg.label}) fetch failed:`, err);
      lastErr = err;
      let served = false;
      if (typeof getCachedApiResponse === 'function') {
        try {
          const cached = await getCachedApiResponse('utility_wires', `${k}:${cfg.id}`);
          if (cached && cached.data && Array.isArray(cached.data.recs)) {
            _renderUtilityWires(cached.data.recs);
            S.utilityWireCounts[cfg.category] = (S.utilityWireCounts[cfg.category] || 0) + cached.data.recs.length;
            S.utilityWireInfo[cfg.id] = {
              label: cfg.label, count: cached.data.recs.length, truncated: !!cached.data.truncated,
              fromCache: true, cachedAt: cached.timestamp,
            };
            if (oldestCache == null || cached.timestamp < oldestCache) oldestCache = cached.timestamp;
            served = true;
          }
        } catch (cacheErr) { console.warn('Utility circuits cache fallback failed:', cacheErr); }
      }
      if (!served) { anyFailed = true; S.utilityWireInfo[cfg.id] = { label: cfg.label, failed: true }; }
    }
  }));

  updateWireDisplay(S.wireHazardCounts, S.towerCount);
  buildLayerControl();
  if (anyFailed) {
    recordDataSourceError('Utility Circuits', lastErr || new Error('fetch failed'));
    markSection('obstacles', { source: 'utility', status: 'error', error: lastErr && lastErr.message ? lastErr.message : 'fetch failed' });
  } else {
    clearDataSourceError('Utility Circuits');
    if (anyLive) markSection('obstacles', { source: 'utility', status: 'live', updatedAt: Date.now(), error: null });
    else markSection('obstacles', { source: 'utility', status: 'cached', cachedAt: oldestCache });
  }
  trackFetchEnd('Utility Circuits');
}

// Draw normalized utility wire records into their category layers.
function _renderUtilityWires(recs) {
  (recs || []).forEach(rec => {
    const latlngs = geojsonLineLatLngs(rec.geometry);
    if (!latlngs || latlngs.length === 0) return;
    const info = WIRE_CATEGORIES[rec.category];
    const lid = 'wire_' + rec.category;
    if (!info || !S.mapLayers[lid]) return;
    L.polyline(latlngs, { color: info.color, weight: info.weight, opacity: 0.8 })
      .bindPopup(_utilityWirePopup(rec, info))
      .addTo(S.mapLayers[lid]);
  });
}

function _utilityWirePopup(rec, info) {
  const OHUG = { OH: 'Overhead', UG: 'Underground', UW: 'Underwater' };
  const parts = [`<b style="color:${info.color}">${info.label}</b>`];
  const name = rec.lineName || rec.name;
  if (name) parts.push(name);
  if (rec.voltageKv != null) {
    parts.push(`${rec.voltageKv} kV` + (rec.ohUg ? ` · ${OHUG[rec.ohUg] || rec.ohUg}` : ''));
  }
  if (rec.substation) parts.push(`Substation: ${rec.substation}`);
  if (rec.owner) parts.push(`Owner: ${rec.owner}`);
  if (rec.circuit) parts.push(`Circuit: ${rec.circuit}`);
  if (rec.status && rec.status !== 'Operational') parts.push(`Status: ${rec.status}`);
  if (rec.caveat) parts.push(`<span style="font-size:10px;opacity:0.6">⚠ ${rec.caveat}</span>`);
  if (rec.attribution) parts.push(`<span style="font-size:10px;opacity:0.6">${rec.attribution}</span>`);
  return parts.join('<br>');
}

// ============================================================
// API: OSM BUILDINGS (Overpass) — footprints for the 3D view (FREE)
// Fetched lazily on first 3D entry: buildings only earn their keep as 3D
// prisms, and fetching them with every area load would double Overpass
// traffic. Heights come from OSM height/building:levels tags where mapped,
// else a one-story default — treat as approximate, not surveyed.
// ============================================================
function _buildingsCap() { return (typeof _isConstrained === 'function' && _isConstrained()) ? 1500 : 4000; }

// Buildings-in-3D mode ('auto' | 'prisms' | 'flat'), persisted in
// localStorage. 'flat' skips the extruded prisms and relies on the shaded
// footprint drape — resolveBuildings3dMode auto-picks it on constrained
// devices.
function getBuildings3dSetting() {
  try { return localStorage.getItem('sar_buildings_3d') || 'auto'; } catch (e) { return 'auto'; }
}

function setBuildings3dMode(v) {
  try { localStorage.setItem('sar_buildings_3d', v); } catch (e) { /* private mode */ }
  if (S.is3D && typeof sync3d === 'function') sync3d();
}

function _buildings3dMode() {
  return resolveBuildings3dMode(getBuildings3dSetting(),
    typeof _isConstrained === 'function' && _isConstrained());
}

async function fetchBuildings(bounds) {
  if (S._buildingsFetching) return;
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const bb = clampBBoxSpan(sw.lat, sw.lng, ne.lat, ne.lng);
  const bboxKey = `${bb.south.toFixed(3)}_${bb.west.toFixed(3)}_${bb.north.toFixed(3)}_${bb.east.toFixed(3)}`;
  if (S.buildings && S.buildings.bboxKey === bboxKey) return;
  S._buildingsFetching = true;
  const bbox = `${bb.south},${bb.west},${bb.north},${bb.east}`;
  // `out body N` caps the way count server-side; `>;` still recurses the
  // member nodes of the returned ways.
  const query = `[out:json][timeout:60];way["building"](${bbox});out body ${_buildingsCap()};>;out skel qt;`;
  try {
    const data = await _overpassFetch(query);
    S.buildings = { list: parseOverpassBuildings(data, _buildingsCap()), bboxKey, fetchedAt: Date.now() };
    renderBuildingsLayer();
    if (typeof cacheApiResponse === 'function') cacheApiResponse('osm_buildings', bboxKey, data);
    buildLayerControl();
    sync3d();
  } catch (err) {
    console.warn('Buildings fetch error:', err);
    if (typeof getCachedApiResponse === 'function') {
      try {
        const cached = await getCachedApiResponse('osm_buildings', bboxKey);
        if (cached && cached.data) {
          S.buildings = { list: parseOverpassBuildings(cached.data, _buildingsCap()), bboxKey, fetchedAt: cached.timestamp };
          renderBuildingsLayer();
          buildLayerControl();
          sync3d();
        }
      } catch (cacheErr) { /* buildings are an enhancement — stay silent */ }
    }
  } finally {
    S._buildingsFetching = false;
  }
}

// Shaded 2D footprint layer: readable filled footprints in 2D, the
// visibility gate for the 3D prisms, and — because collect3dVectorGroups
// harvests it into draped polygons — the flat-mode representation and the
// click/popup target in 3D (custom-layer prisms aren't clickable).
function renderBuildingsLayer() {
  if (typeof L === 'undefined') return;
  if (S.mapLayers.buildings) S.mapLayers.buildings.clearLayers();
  else S.mapLayers.buildings = L.layerGroup().addTo(S.map);
  const list = (S.buildings && S.buildings.list) || [];
  list.forEach(b => {
    const latlngs = b.footprint.map(p => [p[1], p[0]]);
    const hFt = Math.round(b.heightM * 3.28084);
    const parts = [`<b style="color:${BUILDING_3D_COLOR}">Building</b>`];
    if (b.name) parts.push(b.name);
    if (b.type) parts.push(b.type.replace(/_/g, ' '));
    parts.push(`Height: ${b.est ? '~' : ''}${hFt} ft${b.est ? ' (est.)' : ' (OSM)'}`);
    parts.push(`<span style="font-size:10px;opacity:0.6">OSM Way ${b.id}</span>`);
    L.polygon(latlngs, { color: BUILDING_3D_COLOR, weight: 1, opacity: 0.85, fillColor: BUILDING_3D_COLOR, fillOpacity: 0.35 })
      .bindPopup(parts.join('<br>'))
      .addTo(S.mapLayers.buildings);
  });
}

function updateWireDisplay(counts, towerCount) {
  // OSM counts + CA utility-circuit counts (PG&E GRIP feeders / CEC transmission)
  const utilityCount = Object.values(S.utilityWireCounts || {}).reduce((a, b) => a + b, 0);
  const powerCount = (counts.power_line || 0) + (counts.power_minor_line || 0) + (counts.power_cable || 0) + utilityCount;
  const telecomCount = counts.telecom_line || 0;
  const aerialCount = counts.aerialway || 0;
  const towers = towerCount || 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) + utilityCount;

  if (total > 0 || towers > 0) {
    setText('terrPower', `${powerCount} lines mapped \u2014 see map`);
    setColor('terrPower', powerCount > 0 ? 'amber' : 'green');
    setText('terrTowers', `${towers} towers, ${telecomCount} telecom, ${aerialCount} aerialway`);
    setColor('terrTowers', (towers + telecomCount + aerialCount) > 0 ? 'amber' : 'green');
  } else {
    setText('terrPower', 'None mapped (verify imagery)');
    setColor('terrPower', 'amber');
    setText('terrTowers', 'None mapped');
  }
}

// ============================================================
// API: RAINVIEWER Weather Radar Animation
// ============================================================
async function fetchRadar() {
  trackFetchStart('Radar');
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Clean up old radar layers
    if (S.radarAnim && S.radarAnim.layers) {
      S.radarAnim.layers.forEach(l => { if (S.map.hasLayer(l)) S.map.removeLayer(l); });
    }
    if (S.radarAnim && S.radarAnim.interval) clearInterval(S.radarAnim.interval);

    const frames = (data.radar && data.radar.past) ? data.radar.past : [];
    if (frames.length === 0) return;

    // Color scheme 6 = NEXRAD Level III (traditional NWS look: green->yellow->
    // orange->red->magenta, blue reserved for snow). Trailing 1_1 = smoothing on,
    // snow on (appropriate for mountain SAR).
    const layers = frames.map(frame =>
      L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/6/1_1.png`, {
        opacity: 0, maxNativeZoom: 7, maxZoom: 18, zIndex: 500,
      })
    );

    S.radarAnim = { playing: false, index: layers.length - 1, layers: layers, interval: null, frames: frames };

    // Show most recent frame at 0.5 opacity
    const last = layers[layers.length - 1];
    last.setOpacity(0.5);
    last.addTo(S.map);

    // Show radar controls
    const controls = document.getElementById('radarControls');
    if (controls) controls.style.display = 'flex';
    updateRadarTime();
    clearDataSourceError('Radar');

    buildLayerControl();
  } catch (err) {
    console.error('Radar fetch error:', err);
    recordDataSourceError('Radar', err);
  } finally {
    trackFetchEnd('Radar');
  }
}

function radarToggle() {
  if (!S.radarAnim || !S.radarAnim.layers || S.radarAnim.layers.length === 0) return;
  if (S.radarAnim.playing) {
    clearInterval(S.radarAnim.interval);
    S.radarAnim.interval = null;
    S.radarAnim.playing = false;
    const btn = document.getElementById('radarPlayBtn');
    if (btn) btn.innerHTML = '&#9654;';
  } else {
    S.radarAnim.playing = true;
    const btn = document.getElementById('radarPlayBtn');
    if (btn) btn.innerHTML = '&#9646;&#9646;';
    S.radarAnim.interval = setInterval(() => radarStep(1), 800);
  }
}

function radarStep(dir) {
  if (!S.radarAnim || !S.radarAnim.layers || S.radarAnim.layers.length === 0) return;
  const layers = S.radarAnim.layers;
  const oldIdx = S.radarAnim.index;

  // Hide current frame
  if (S.map.hasLayer(layers[oldIdx])) layers[oldIdx].setOpacity(0);

  // Calculate new index
  let newIdx = oldIdx + dir;
  if (newIdx >= layers.length) newIdx = 0;
  if (newIdx < 0) newIdx = layers.length - 1;
  S.radarAnim.index = newIdx;

  // Show new frame
  if (!S.map.hasLayer(layers[newIdx])) layers[newIdx].addTo(S.map);
  layers[newIdx].setOpacity(0.5);
  updateRadarTime();
  if (S.is3D && typeof sync3d === 'function') sync3d(); // 3D shows the current frame
}

function updateRadarTime() {
  const el = document.getElementById('radarTime');
  if (!el || !S.radarAnim || !S.radarAnim.frames) { if (el) el.textContent = '--'; return; }
  const frame = S.radarAnim.frames[S.radarAnim.index];
  if (frame && frame.time) {
    const d = new Date(frame.time * 1000);
    el.textContent = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: _localTZ() });
  } else {
    el.textContent = '--';
  }
}

// ============================================================
// ADS-B LIVE TRAFFIC
// ============================================================

// Ordered ADS-B fetch attempts: the data proxy first (direct providers are
// increasingly CORS-blocked from a browser), then the direct providers as
// fallback. Pure/testable.
function _adsbAttemptUrls(lat, lon, dist) {
  const list = [];
  const proxyBase = (typeof getCanopyProxyBase === 'function') ? getCanopyProxyBase() : null;
  if (proxyBase) list.push({ name: 'proxy', url: `${proxyBase}/adsb?lat=${lat}&lon=${lon}&dist=${dist}`, proxy: true });
  for (let i = 0; i < ADSB_APIS.length; i++) {
    const idx = (S._adsbApiIndex + i) % ADSB_APIS.length;
    list.push({ name: ADSB_APIS[idx].name, url: ADSB_APIS[idx].url(lat, lon, dist), idx });
  }
  return list;
}

// Lazily fetch (once per area) a terrain DEM covering the whole ADS-B search
// area so each aircraft's AGL can be computed against the ground directly
// beneath it rather than the single operating-site elevation. 3DEP is
// CORS-enabled and cached in IndexedDB, so no proxy is needed and revisits are
// offline-capable. Self-guarded and non-blocking: the first poll may use the
// fallback elevation until the DEM arrives, then subsequent polls use terrain.
async function ensureAdsbDem() {
  if (!S.areaCenter || !S.adsbSearchRadiusNm) return;
  if (typeof makeGrid !== 'function' || typeof fetch3DEPDEM !== 'function') return;
  const c = S.areaCenter;
  const key = c.lat.toFixed(3) + ',' + c.lng.toFixed(3) + '@' + S.adsbSearchRadiusNm;
  if (S._adsbDemKey === key && S.adsbDem) return;   // already loaded for this area
  if (S._adsbDemFetching) return;                   // a fetch is already in flight
  S._adsbDemFetching = true;
  try {
    const halfWidthM = S.adsbSearchRadiusNm * 1852;
    // ~300 m/cell target, capped to MAX_GRID (512) by makeGrid. Coarse vs the
    // viewshed, but ample for traffic AGL across a 15–50 NM radius.
    const grid = makeGrid(c.lat, c.lng, halfWidthM, 300);
    const dem = await fetch3DEPDEM(grid);
    if (dem && dem.demFlat) {
      S.adsbDem = { grid: grid, demFlat: dem.demFlat };
      S._adsbDemKey = key;
      // Re-render with terrain-relative AGL now that the DEM is available.
      if (S.adsbAircraft && S.adsbAircraft.length) {
        const groundFn = adsbGroundElevFnFt();
        S.adsbAircraft = parseAdsbAircraft(
          S.adsbAircraft.map(_adsbToRaw), S.areaCenter.lat, S.areaCenter.lng, groundFn);
        renderAdsbMap();
        renderAdsbTab();
      }
    }
  } catch (e) {
    console.warn('ADS-B terrain DEM fetch failed:', e && e.message);
  } finally {
    S._adsbDemFetching = false;
  }
}

// Re-shape a parsed aircraft back to the raw API field names so it can be
// re-run through parseAdsbAircraft when the DEM finishes loading mid-cycle.
function _adsbToRaw(ac) {
  return {
    hex: ac.hex, flight: ac.flight, r: ac.reg, t: ac.type,
    lat: ac.lat, lon: ac.lon, alt_baro: ac.alt_baro, alt_geom: ac.alt_geom,
    gs: ac.gs, track: ac.track, baro_rate: ac.baro_rate,
    squawk: ac.squawk, emergency: ac.emergency, seen: ac.seen, seen_pos: ac.seen_pos,
  };
}

// Returns (lat, lng) => terrain elevation in FEET under that point, read from
// the cached ADS-B DEM (stored in metres). Falls back to the AOI-centre
// elevation where the DEM has no usable value, so AGL is never worse than the
// legacy single-point behaviour.
// Resolution order: (1) high-res 3DEP point sample (cached, for low+close
// traffic) → (2) coarse area raster → (3) AOI-centre elevation. Each tier is
// strictly better than the next, so AGL is never worse than the legacy behaviour.
function adsbGroundElevFnFt() {
  const dem = S.adsbDem;
  const cache = S._adsbHiresCache;
  const fallbackFt = (S.elev && typeof S.elev.center === 'number') ? S.elev.center : 0;
  const haveRaster = !!(dem && dem.demFlat && dem.grid && typeof sampleGridBilinear === 'function');
  return (lat, lng) => {
    // 1. High-res point sample for this rounded position, if we have one.
    if (cache && cache.size) {
      const v = cache.get(_adsbHiresKey(lat, lng));
      if (v != null && isFinite(v)) return v * 3.28084;
    }
    // 2. Coarse area raster.
    if (haveRaster) {
      const m = sampleGridBilinear(dem.grid, dem.demFlat, lat, lng);
      if (m != null && isFinite(m)) return m * 3.28084;
    }
    // 3. AOI-centre fallback.
    return fallbackFt;
  };
}

// --- High-res AGL for the deconfliction-relevant subset -------------------
// Only aircraft that are both LOW and CLOSE get a full-resolution 3DEP point
// sample (the ground directly beneath them), since precise AGL only matters for
// nearby low traffic. Distant cruisers keep the cheap coarse-raster AGL.
const ADSB_HIRES_AGL_FT = 1500;   // refine only aircraft below this AGL
const ADSB_HIRES_DIST_NM = 5;     // ...and within this distance of the AOI
const ADSB_HIRES_CACHE_MAX = 2000;

function _adsbHiresKey(lat, lng) {
  // ~11 m granularity: a hovering helicopter reuses its cached sample instead of
  // re-querying every poll; a moving aircraft re-samples as it crosses cells.
  return lat.toFixed(4) + ',' + lng.toFixed(4);
}

function _isAdsbLowClose(ac) {
  return ac.agl > 0 && ac.agl < ADSB_HIRES_AGL_FT && ac.distNm != null && ac.distNm < ADSB_HIRES_DIST_NM;
}

// Parse a 3DEP getSamples JSON response into { key: metres }. The samples array
// is NOT in input order and NoData points are silently dropped, so we join by
// locationId; any input index missing from the response stays uncached (→ falls
// back to the coarse raster).
function _parseGetSamples(json, points) {
  const out = {};
  const samples = (json && json.samples) || [];
  for (const s of samples) {
    const id = s && s.locationId;
    if (id == null || id < 0 || id >= points.length) continue;
    const v = parseFloat(s.value);
    if (isFinite(v)) out[points[id].key] = v;
  }
  return out;
}

// 3DEP getSamples: native-resolution ground elevation (metres) at each point in
// ONE request. CORS-open; single retry for the occasional transient 5xx.
async function fetch3DEPPointElevations(points) {
  if (!points.length) return {};
  const geometry = { points: points.map(p => [p.lng, p.lat]), spatialReference: { wkid: 4326 } };
  const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';
  const body = new URLSearchParams({
    geometry: JSON.stringify(geometry),
    geometryType: 'esriGeometryMultipoint',
    returnFirstValueOnly: 'true',
    f: 'json',
  }).toString();
  const doFetch = async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('3DEP getSamples HTTP ' + res.status);
    return res.json();
  };
  let json;
  try {
    json = await doFetch();
  } catch (e) {
    json = await doFetch();   // one retry on transient (endpoint occasionally 502s)
  }
  return _parseGetSamples(json, points);
}

// Find low+close aircraft whose ground elevation isn't cached, sample them at
// full resolution in one request, cache the result, then re-derive AGL + render.
// Async/non-blocking — the coarse AGL shows instantly and is sharpened in place.
async function refineLowCloseAdsbAgl() {
  const list = S.adsbAircraft || [];
  if (!list.length || !S.areaCenter) return;
  if (typeof isOnline === 'function' && !isOnline()) return;   // offline → keep raster AGL
  if (S._adsbHiresFetching) return;                            // no overlapping requests
  if (!S._adsbHiresCache) S._adsbHiresCache = new Map();
  const cache = S._adsbHiresCache;
  const need = [];
  const seen = new Set();
  for (const ac of list) {
    if (!_isAdsbLowClose(ac)) continue;
    const key = _adsbHiresKey(ac.lat, ac.lon);
    if (cache.has(key) || seen.has(key)) continue;
    seen.add(key);
    need.push({ lat: ac.lat, lng: ac.lon, key });
  }
  if (!need.length) return;
  S._adsbHiresFetching = true;
  try {
    const elevByKey = await fetch3DEPPointElevations(need);
    let changed = false;
    for (const k in elevByKey) { cache.set(k, elevByKey[k]); changed = true; }
    if (cache.size > ADSB_HIRES_CACHE_MAX) cache.clear();   // bound memory; terrain is static so re-fetch is cheap
    if (changed && S.adsbAircraft && S.adsbAircraft.length) {
      const groundFn = adsbGroundElevFnFt();
      S.adsbAircraft = parseAdsbAircraft(
        S.adsbAircraft.map(_adsbToRaw), S.areaCenter.lat, S.areaCenter.lng, groundFn);
      renderAdsbMap();
      renderAdsbTab();
    }
  } catch (e) {
    console.warn('ADS-B hi-res elevation sample failed:', e && e.message);
  } finally {
    S._adsbHiresFetching = false;
  }
}

async function fetchAdsb() {
  if (!S.areaCenter || !S.adsbSearchRadiusNm) return;
  trackFetchStart('ADS-B');
  setStatus('adsbStatus', 'loading', 'Polling...');
  try {
    const lat = S.areaCenter.lat.toFixed(4);
    const lon = S.areaCenter.lng.toFixed(4);
    const dist = S.adsbSearchRadiusNm;
    let json = null;
    let lastErr = null;
    let usedApi = null;
    for (const a of _adsbAttemptUrls(lat, lon, dist)) {
      try {
        const res = await _proxyFetch(a.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
        if (a.idx != null) S._adsbApiIndex = a.idx;
        usedApi = a.proxy ? ('proxy (' + (res.headers && res.headers.get && res.headers.get('X-Adsb-Source') || '?') + ')') : a.name;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`ADS-B ${a.name} failed:`, e.message);
      }
    }
    if (!json) throw lastErr || new Error('All ADS-B APIs failed');
    ensureAdsbDem(); // load/refresh terrain DEM for per-aircraft AGL (non-blocking, self-guarded)
    const groundFn = adsbGroundElevFnFt();
    const aircraft = parseAdsbAircraft(json.ac || [], S.areaCenter.lat, S.areaCenter.lng, groundFn);
    S.adsbAircraft = aircraft;
    S._adsbLastFetch = Date.now();
    updateAdsbTrails(aircraft);
    renderAdsbMap();
    renderAdsbTab(usedApi);
    refineLowCloseAdsbAgl(); // sharpen AGL for low+close traffic via 3DEP point sampling (non-blocking)
    clearDataSourceError('ADS-B');
    markSection('adsb', { status: 'live', updatedAt: S._adsbLastFetch, error: null });
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: _localTZ() });
    setStatus('adsbStatus', 'live', aircraft.length + ' AIRCRAFT \u2022 ' + timeStr);
    const pollEl = document.getElementById('adsbPollStatus');
    if (pollEl) pollEl.textContent = 'Updated ' + timeStr;
  } catch (err) {
    recordDataSourceError('ADS-B', err);
    markSection('adsb', { status: 'error', error: err && err.message ? err.message : String(err) });
    // Both the proxy /adsb route and the direct providers are unreachable
    // (CORS / upstream 5xx). Polling continues, so it will retry automatically.
    setStatus('adsbStatus', 'error', 'UNAVAILABLE — RETRYING');
  } finally {
    trackFetchEnd('ADS-B');
  }
}

function updateAdsbTrails(aircraft) {
  const now = Date.now();
  const cutoff = now - 15 * 60 * 1000;
  const activeHexes = new Set();
  for (const ac of aircraft) {
    if (!ac.hex) continue;
    activeHexes.add(ac.hex);
    if (!S.adsbTrails[ac.hex]) S.adsbTrails[ac.hex] = [];
    const trail = S.adsbTrails[ac.hex];
    // Only append if position changed from last entry
    const last = trail[trail.length - 1];
    if (!last || last.lat !== ac.lat || last.lon !== ac.lon) {
      trail.push({ lat: ac.lat, lon: ac.lon, alt: ac.alt_baro, time: now });
    }
    // Prune entries older than 15 min
    while (trail.length > 0 && trail[0].time < cutoff) trail.shift();
  }
  // Clean up trails for aircraft no longer present
  for (const hex of Object.keys(S.adsbTrails)) {
    if (!activeHexes.has(hex)) {
      const trail = S.adsbTrails[hex];
      while (trail.length > 0 && trail[0].time < cutoff) trail.shift();
      if (trail.length === 0) delete S.adsbTrails[hex];
    }
  }
}

function adsbAglColor(agl) {
  if (agl <= 0) return '#556677';
  if (agl < 500) return '#ef4444';
  if (agl < 1500) return '#f59e0b';
  return '#22c55e';
}

function renderAdsbMap() {
  if (!S.map) return;
  // Ensure layer groups exist — track if first creation for layer control rebuild
  let needsLayerControlRebuild = false;
  if (!S.mapLayers.adsb_aircraft) {
    S.mapLayers.adsb_aircraft = L.layerGroup().addTo(S.map);
    needsLayerControlRebuild = true;
  } else {
    S.mapLayers.adsb_aircraft.clearLayers();
  }
  if (!S.mapLayers.adsb_trails) {
    S.mapLayers.adsb_trails = L.layerGroup().addTo(S.map);
    needsLayerControlRebuild = true;
  } else {
    S.mapLayers.adsb_trails.clearLayers();
  }

  const activeHexes = new Set(S.adsbAircraft.map(ac => ac.hex));

  // Render trails
  for (const [hex, trail] of Object.entries(S.adsbTrails)) {
    if (trail.length < 2) continue;
    const coords = trail.map(p => [p.lat, p.lon]);
    const isActive = activeHexes.has(hex);
    const polyline = L.polyline(coords, {
      color: isActive ? '#3d8bfd' : '#3d8bfd',
      weight: 2,
      opacity: isActive ? 0.5 : 0.2,
      dashArray: '4,4',
      interactive: false,
    });
    S.mapLayers.adsb_trails.addLayer(polyline);
  }

  // Render aircraft markers
  for (const ac of S.adsbAircraft) {
    const color = adsbAglColor(ac.agl);
    const aglLabel = formatAltitudeAgl(ac.agl);
    const rotation = ac.track != null ? ac.track : 0;
    const callsign = ac.flight || ac.hex.toUpperCase();

    const html = `<div style="position:relative;width:80px;height:56px;text-align:center;">` +
      `<div style="display:inline-block;transform:rotate(${rotation}deg);width:28px;height:28px;">` +
        `<svg width="28" height="28" viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5A1.5 1.5 0 0 0 11.5 2 1.5 1.5 0 0 0 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" fill="${color}" stroke="#000" stroke-width="0.6"/></svg>` +
      `</div>` +
      `<div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${color};text-shadow:0 0 3px #000,0 0 6px #000;line-height:1.2;margin-top:1px;">${aglLabel}</div>` +
      `<div style="font-family:'JetBrains Mono',monospace;font-size:8px;color:#8899aa;text-shadow:0 0 3px #000,0 0 6px #000;line-height:1.1;">${ac.distNm} nm</div>` +
    `</div>`;

    const icon = L.divIcon({ html, className: '', iconSize: [80, 56], iconAnchor: [40, 14] });
    const marker = L.marker([ac.lat, ac.lon], { icon, zIndexOffset: 800 });

    marker.bindPopup(_adsbPopupHtml(ac));

    S.mapLayers.adsb_aircraft.addLayer(marker);
  }

  if (needsLayerControlRebuild) buildLayerControl();
  // Mirror the fresh positions into the 3D view (fast setData path).
  if (S.is3D && typeof _refresh3dAircraft === 'function') _refresh3dAircraft();
}

// Shared 2D-marker / 3D-cylinder popup for one ADS-B aircraft.
function _adsbPopupHtml(ac) {
  const callsign = ac.flight || ac.hex.toUpperCase();
  const altMsl = ac.alt_baro != null ? ac.alt_baro.toLocaleString() + ' ft MSL' : 'N/A';
  const altAgl = ac.agl.toLocaleString() + ' ft AGL';
  const hiRes = !!(S._adsbHiresCache && S._adsbHiresCache.has(_adsbHiresKey(ac.lat, ac.lon)));
  const terrainBelow = (ac.groundElevFt != null && isFinite(ac.groundElevFt))
    ? `<span style="opacity:0.6;">Terrain below: ${ac.groundElevFt.toLocaleString()} ft MSL${hiRes ? ' (3DEP point)' : ''}</span><br>` : '';
  const speed = ac.gs != null ? Math.round(ac.gs) + ' kts' : 'N/A';
  const track = ac.track != null ? Math.round(ac.track) + '\u00B0' : 'N/A';
  const vrate = ac.baro_rate != null ? (ac.baro_rate > 0 ? '+' : '') + ac.baro_rate + ' ft/min' : 'N/A';
  const sqk = ac.squawk || 'N/A';
  const isEmergency = ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700' || (ac.emergency && ac.emergency !== 'none');
  const sqkStyle = isEmergency ? 'color:#ef4444;font-weight:bold;' : '';
  return `<div style="font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.6;">` +
    `<b style="color:#06b6d4;font-size:13px;">${callsign}</b><br>` +
    (ac.reg ? `Reg: ${ac.reg}<br>` : '') +
    (ac.type ? `Type: ${ac.type}<br>` : '') +
    `Alt: ${altMsl} / ${altAgl}<br>` +
    terrainBelow +
    `GS: ${speed} | Trk: ${track}<br>` +
    `VS: ${vrate}<br>` +
    `<span style="${sqkStyle}">Squawk: ${sqk}</span>` +
    (isEmergency ? ' <b style="color:#ef4444;">EMERGENCY</b>' : '') + `<br>` +
    `Dist: ${ac.distNm} nm<br>` +
    `<span style="opacity:0.5;">ICAO: ${ac.hex.toUpperCase()}</span>` +
  `</div>`;
}

function renderAdsbTab(usedApi) {
  const aircraft = S.adsbAircraft;
  setText('adsbCount', aircraft.length > 0 ? String(aircraft.length) : '--');
  setText('adsbRadius', S.adsbSearchRadiusNm ? S.adsbSearchRadiusNm + ' nm' : '-- nm');
  if (usedApi) setText('adsbSource', usedApi);

  // Nearest aircraft
  if (aircraft.length > 0) {
    const nearest = aircraft[0];
    const label = nearest.flight || nearest.hex.toUpperCase();
    setText('adsbNearest', label + ' (' + nearest.distNm + ' nm)');
    setText('adsbNearestAlt', nearest.agl + ' ft AGL');
    setColor('adsbNearestAlt', nearest.agl < 500 ? 'red' : nearest.agl < 1500 ? 'amber' : 'green');
  } else {
    setText('adsbNearest', 'None');
    setText('adsbNearestAlt', '--');
  }

  // Low altitude count
  const lowAlt = aircraft.filter(ac => ac.agl > 0 && ac.agl < 500);
  setText('adsbLowCount', String(lowAlt.length));
  setColor('adsbLowCount', lowAlt.length > 0 ? 'red' : 'green');

  // Emergency alerts
  const emergencyEl = document.getElementById('adsbEmergencyList');
  if (emergencyEl) {
    const emergencies = aircraft.filter(ac =>
      ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700' ||
      (ac.emergency && ac.emergency !== 'none')
    );
    if (emergencies.length === 0) {
      emergencyEl.innerHTML = '<span style="color:var(--text-muted);">No emergency squawks detected</span>';
    } else {
      emergencyEl.innerHTML = emergencies.map(ac => {
        const label = ac.flight || ac.hex.toUpperCase();
        const sqkLabel = ac.squawk === '7500' ? '7500 HIJACK' : ac.squawk === '7600' ? '7600 COMMS' : ac.squawk === '7700' ? '7700 EMERG' : ac.emergency.toUpperCase();
        return `<div class="adsb-emergency-card"><b style="color:var(--accent-red);">${sqkLabel}</b> &mdash; ${label} @ ${ac.agl} ft AGL, ${ac.distNm} nm</div>`;
      }).join('');
    }
  }

  // Aircraft list
  const listEl = document.getElementById('adsbAircraftList');
  if (listEl) {
    if (aircraft.length === 0) {
      listEl.innerHTML = '<span style="color:var(--text-muted);">No aircraft detected in search area</span>';
    } else {
      let html = '<table class="adsb-list-table"><thead><tr>' +
        '<th>Callsign</th><th>Alt AGL</th><th>Dist</th><th>GS</th><th>Squawk</th>' +
        '</tr></thead><tbody>';
      for (const ac of aircraft) {
        const label = ac.flight || ac.hex.toUpperCase();
        const color = adsbAglColor(ac.agl);
        const aglStr = formatAltitudeAgl(ac.agl);
        const gs = ac.gs != null ? Math.round(ac.gs) + 'kt' : '--';
        const sqk = ac.squawk || '--';
        const isEmergency = ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700';
        const sqkStyle = isEmergency ? 'color:#ef4444;font-weight:bold;' : '';
        html += `<tr class="adsb-row" onclick="if(S.map)S.map.panTo([${ac.lat},${ac.lon}])">` +
          `<td style="color:var(--accent-cyan);">${label}</td>` +
          `<td style="color:${color};font-weight:600;">${aglStr}</td>` +
          `<td>${ac.distNm} nm</td>` +
          `<td>${gs}</td>` +
          `<td style="${sqkStyle}">${sqk}</td>` +
          `</tr>`;
      }
      html += '</tbody></table>';
      listEl.innerHTML = html;
    }
  }
}

function startAdsbPolling() {
  if (S._adsbPollTimer || !S._adsbEnabled || !S.areaCenter || !S.areaBounds) return;
  const ne = S.areaBounds.getNorthEast();
  const sw = S.areaBounds.getSouthWest();
  S.adsbSearchRadiusNm = computeAdsbSearchRadius(S.areaCenter.lat, S.areaCenter.lng, ne, sw);
  setText('adsbRadius', S.adsbSearchRadiusNm + ' nm');
  const statusEl = document.getElementById('adsbPollStatus');
  if (statusEl) statusEl.textContent = 'Polling';
  fetchAdsb();
  S._adsbPollTimer = setInterval(fetchAdsb, 5000);
}

function stopAdsbPolling() {
  if (S._adsbPollTimer) { clearInterval(S._adsbPollTimer); S._adsbPollTimer = null; }
  S.adsbAircraft = [];
  S.adsbTrails = {};
  S.adsbSearchRadiusNm = null;
  S.adsbDem = null;
  S._adsbDemKey = null;
  S._adsbHiresCache = null;
  if (S.mapLayers.adsb_aircraft) S.mapLayers.adsb_aircraft.clearLayers();
  if (S.mapLayers.adsb_trails) S.mapLayers.adsb_trails.clearLayers();
  const statusEl = document.getElementById('adsbPollStatus');
  if (statusEl) statusEl.textContent = S._adsbEnabled ? 'Idle' : 'Disabled';
}

function toggleAdsbPolling() {
  const sel = document.getElementById('cfgAdsbEnabled');
  S._adsbEnabled = sel && sel.value === '1';
  if (typeof saveAppState === 'function') saveAppState('cfgAdsbEnabled', S._adsbEnabled ? '1' : '0');
  if (S._adsbEnabled && S.areaCenter) {
    startAdsbPolling();
  } else {
    stopAdsbPolling();
  }
}

// ============================================================
// FORECAST TIMEBAR + WIND/SUN ARROWS
// ============================================================

// Show the timebar when hourly data is available
function initTimeBar() {
  const bar = document.getElementById('timeBar');
  if (!bar || !S.wx?.hourly?.time?.length || !S.areaCenter) return;
  bar.style.display = 'flex';

  const times = S.wx.hourly.time;
  const n = Math.min(times.length, 24);

  // Build hour labels
  const labelsEl = document.getElementById('tbLabels');
  if (labelsEl) {
    let lhtml = '';
    for (let i = 0; i < n; i += 3) {
      const dt = new Date(times[i]);
      lhtml += `<span>${dt.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: _localTZ() }).replace(' ', '')}</span>`;
    }
    labelsEl.innerHTML = lhtml;
  }

  // Attach drag interaction
  const track = document.getElementById('tbTrack');
  if (track && !track._tbInit) {
    track._tbInit = true;
    const onMove = (ex) => {
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ex - rect.left) / rect.width));
      _updateTimeBar(frac);
    };
    track.addEventListener('mousedown', e => {
      e.preventDefault();
      onMove(e.clientX);
      const mm = ev => onMove(ev.clientX);
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
    track.addEventListener('touchstart', e => {
      e.preventDefault();
      onMove(e.touches[0].clientX);
      const tm = ev => onMove(ev.touches[0].clientX);
      const te = () => { document.removeEventListener('touchmove', tm); document.removeEventListener('touchend', te); };
      document.addEventListener('touchmove', tm);
      document.addEventListener('touchend', te);
    });
  }

  // Set to "now" position
  _updateTimeBar(0);
}

function _updateTimeBar(frac) {
  const hourly = S.wx?.hourly;
  if (!hourly || !hourly.time?.length || !S.areaCenter) return;
  const n = Math.min(hourly.time.length, 24);
  const idx = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
  S.timeIdx = idx;

  // Update scrubber position
  const pct = (idx / (n - 1)) * 100;
  const fill = document.getElementById('tbFill');
  const thumb = document.getElementById('tbThumb');
  if (fill) fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';

  // Time readout
  const dt = new Date(hourly.time[idx]);
  const timeEl = document.getElementById('tbTime');
  if (timeEl) timeEl.textContent = idx === 0 ? 'NOW' : dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: _localTZ() });

  // Wind values
  const windSpd = hourly.wind_speed_10m?.[idx];
  const windDir = hourly.wind_direction_10m?.[idx];
  const windEl = document.getElementById('tbWind');
  if (windEl) windEl.textContent = windSpd != null ? `${Math.round(windSpd)}mph ${Math.round(windDir || 0)}°` : '--';

  // Sun position at this time
  const lat = S.areaCenter.lat, lng = S.areaCenter.lng;
  const sunPos = typeof calcSunPosition === 'function' ? calcSunPosition(lat, lng, dt) : null;
  const sunEl = document.getElementById('tbSun');
  const isDay = sunPos && sunPos.elevation > 0;
  if (sunEl) sunEl.textContent = isDay ? `Sun ${Math.round(sunPos.azimuth)}° ↑${sunPos.elevation.toFixed(0)}°` : 'Night';

  // Update map arrows + 3D scene lighting for the scrubbed hour
  _updateWindArrow(windDir, windSpd);
  _updateSunArrow(sunPos);
  if (typeof _update3dLight === 'function') _update3dLight();
  if (typeof _updateShadowForTime === 'function') _updateShadowForTime();

  // Re-render the data panel (weather / wind / ops / assessment) for this hour.
  refreshPanelForHour();
}

// --- Wind direction arrow (blue) on map ---
function _updateWindArrow(dir, speed) {
  if (!S.map || !S.areaCenter) return;

  if (dir == null || speed == null) {
    if (S._windArrow) { S.map.removeLayer(S._windArrow); S._windArrow = null; }
    return;
  }

  const len = Math.min(30, 14 + speed * 0.6); // arrow length scales with speed
  const svgHtml = `<svg width="60" height="60" viewBox="0 0 60 60" style="overflow:visible;filter:drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000);">
    <defs><marker id="wah" markerWidth="6" markerHeight="5" refX="3" refY="2.5" orient="auto"><polygon points="0 0,6 2.5,0 5" fill="#3d8bfd"/></marker></defs>
    <line x1="30" y1="30" x2="30" y2="${30 - len}" stroke="#3d8bfd" stroke-width="2.5" marker-end="url(#wah)"
          transform="rotate(${dir}, 30, 30)"/>
    <circle cx="30" cy="30" r="3" fill="#3d8bfd" opacity="0.6"/>
  </svg>`;

  if (S._windArrow) {
    S._windArrow.setIcon(L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }));
    S._windArrow.setLatLng(S.areaCenter);
  } else {
    S._windArrow = L.marker(S.areaCenter, {
      icon: L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }),
      interactive: false, zIndexOffset: 900,
    }).addTo(S.map);
  }
}

// --- Sun direction arrow (yellow) on map ---
function _updateSunArrow(sunPos) {
  if (!S.map || !S.areaCenter) return;

  if (!sunPos || sunPos.elevation <= 0) {
    if (S._sunArrow) { S.map.removeLayer(S._sunArrow); S._sunArrow = null; }
    return;
  }

  const az = sunPos.azimuth;
  const len = 24;
  const svgHtml = `<svg width="60" height="60" viewBox="0 0 60 60" style="overflow:visible;filter:drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000);">
    <defs><marker id="sah" markerWidth="6" markerHeight="5" refX="3" refY="2.5" orient="auto"><polygon points="0 0,6 2.5,0 5" fill="#f59e0b"/></marker></defs>
    <line x1="30" y1="30" x2="30" y2="${30 - len}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4,2" marker-end="url(#sah)"
          transform="rotate(${az}, 30, 30)"/>
    <circle cx="30" cy="30" r="5" fill="none" stroke="#f59e0b" stroke-width="1.5" opacity="0.5"/>
  </svg>`;

  if (S._sunArrow) {
    S._sunArrow.setIcon(L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }));
    S._sunArrow.setLatLng(S.areaCenter);
  } else {
    S._sunArrow = L.marker(S.areaCenter, {
      icon: L.divIcon({ html: svgHtml, className: '', iconSize: [60, 60], iconAnchor: [30, 30] }),
      interactive: false, zIndexOffset: 899,
    }).addTo(S.map);
  }
}

function hideTimeBar() {
  const bar = document.getElementById('timeBar');
  if (bar) bar.style.display = 'none';
  if (S._windArrow) { S.map.removeLayer(S._windArrow); S._windArrow = null; }
  if (S._sunArrow) { S.map.removeLayer(S._sunArrow); S._sunArrow = null; }
  // Return the panel to NOW when the area / timeline is cleared.
  S.timeIdx = 0;
  updateTimeContextBanner();
}

// ============================================================
// TERRAIN FEATURES & EMERGENCY LZs
// ============================================================
function renderTerrainFeatures(features) {
  if (!features) return;
  const parts = [];
  if (features.hasRidges) parts.push('Ridges');
  if (features.hasCanyons) parts.push('Canyons');
  if (features.hasFunneling) parts.push('Wind funneling');
  if (features.features && features.features.length > 0) {
    features.features.forEach(f => { if (!parts.includes(f)) parts.push(f); });
  }
  // Update terrain tab if there are notable features
  if (parts.length > 0) {
    setText('terrClass', classifyTerrain(S.elev.center) + ' — ' + parts.join(', '));
  }
}

function renderLZMarkers(lzs) {
  // LZ analysis is based on coarse elevation grid (25 points) and cannot
  // reliably identify actual landing zones. Show a terrain suitability
  // assessment instead of precise map markers.

  // Clear any existing LZ markers
  if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
    if (S.mapLayers.emergency_lz) S.mapLayers.emergency_lz.clearLayers();
  }

  if (!lzs || lzs.length === 0) {
    setText('terrLZ', 'Terrain unsuitable \u2014 steep slopes throughout. Identify LZ on satellite imagery.');
    setColor('terrLZ', 'red');
    return;
  }

  S.lzs = lzs;
  const avgScore = lzs.reduce((sum, lz) => sum + lz.score, 0) / lzs.length;
  const bestScore = lzs[0]?.score || 0;
  const avgSlope = lzs.reduce((sum, lz) => sum + lz.slopeDeg, 0) / lzs.length;

  let assessment, level;
  if (bestScore > 0.8 && avgSlope < 5) {
    assessment = `Generally flat terrain (avg slope ${avgSlope.toFixed(1)}\u00b0) \u2014 multiple LZ options likely. Verify on satellite.`;
    level = 'green';
  } else if (bestScore > 0.6) {
    assessment = `Mixed terrain (avg slope ${avgSlope.toFixed(1)}\u00b0) \u2014 LZ possible in flatter areas. Check satellite imagery for clearings.`;
    level = 'amber';
  } else {
    assessment = `Steep/forested terrain (avg slope ${avgSlope.toFixed(1)}\u00b0) \u2014 LZ options limited. Use satellite to find clearings/roads.`;
    level = 'red';
  }

  setText('terrLZ', assessment);
  setColor('terrLZ', level);

  // No map markers — elevation grid is too coarse to pinpoint actual LZs.
  // User should toggle satellite layer and visually identify clearings.
  if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
    if (!S.mapLayers.emergency_lz) S.mapLayers.emergency_lz = L.layerGroup();
  }

  const count = lzs.length;
  let nearestDist = '--';
  if (S.areaCenter && count > 0) {
    const distances = lzs.map(lz => haversine(S.areaCenter.lat, S.areaCenter.lng, lz.lat, lz.lng));
    nearestDist = (Math.min(...distances) * 1000).toFixed(0);
    // Don't overwrite the assessment text above
    // setText('terrLZ', ...);
  } else {
    setText('terrLZ', `${count} LZ${count > 1 ? 's' : ''} found`);
  }
}

// ============================================================
// DERIVED COMPUTATIONS
// ============================================================
// Maps each threshold input id (in the Config "Aircraft & SOP Profile" grid) to its
// key in the threshold object. Single source of truth for read/populate/save.
const THRESHOLD_FIELDS = [
  ['cfgMaxWind', 'maxWindTol'],
  ['sopWindCaution', 'windCaution'],
  ['sopGustMargin', 'gustMargin'],
  ['cfgFlightTime', 'flightTime'],
  ['sopServiceCeiling', 'serviceCeiling'],
  ['sopMaxSpeed', 'maxSpeed'],
  ['sopVisCaution', 'visCaution'],
  ['sopVisNoGo', 'visNoGo'],
  ['sopPrecipCaution', 'precipCaution'],
  ['sopPrecipNoGo', 'precipNoGo'],
  ['sopTempCaution', 'tempCaution'],
  ['sopTempColdNoGo', 'tempColdNoGo'],
  ['sopTempHotCaution', 'tempHotCaution'],
  ['sopTempHotNoGo', 'tempHotNoGo'],
  ['sopWxCodeNoGo', 'weatherCodeNoGo'],
  ['sopCloudClearance', 'cloudClearanceFt'],
  ['sopElevCaution', 'elevCaution'],
  ['sopDensAltCaution', 'densAltCaution'],
  ['sopDensAltNoGo', 'densAltNoGo'],
  ['cfgMaxAlt', 'maxAltAGL'],
  ['sopCeilingMargin', 'ceilingMarginFt'],
  ['sopKpCaution', 'kpCaution'],
  ['sopAqiCaution', 'aqiCaution'],
  ['sopAqiNoGo', 'aqiNoGo'],
  ['sopFireCautionNm', 'fireCautionNm'],
  ['sopFireNoGoNm', 'fireNoGoNm'],
];

// The live, effective thresholds: DEFAULT_THRESHOLDS < active profile < any value
// currently in the inputs. Null-safe so missing inputs (e.g. minimal test DOM or
// before the UI exists) simply fall back to defaults.
function readActiveThresholds() {
  const base = (typeof DEFAULT_THRESHOLDS !== 'undefined') ? DEFAULT_THRESHOLDS : {};
  const out = Object.assign({}, base, S.activeProfile || {});
  if (typeof document !== 'undefined') {
    THRESHOLD_FIELDS.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el && el.value !== '' && el.value != null) {
        const n = parseFloat(el.value);
        if (!Number.isNaN(n)) out[key] = n;
      }
    });
  }
  return out;
}

// Live recompute when the operator edits any threshold field directly.
function onThresholdEdit() {
  if (S.currentArea) { computeOpsData(); computeAssessment(); }
}

function computeOpsData(snap) {
  snap = snap || snapshotAtIdx(S.timeIdx || 0);
  const _t = readActiveThresholds();
  const temp = snap.temperature_2m ?? 65;
  const elev = S.elev.center ?? 1500;
  const maxWind = S.wind.maxWind ?? 5;
  const nomTime = _t.flightTime || 38;

  // Uses extracted core function
  const d = calcBatteryDerating(temp, elev, maxWind);
  const estTime = Math.round(nomTime * d.combined);
  const capacity = Math.round(d.combined * 100);

  setText('opsTempFactor', `${(d.tempFactor*100).toFixed(0)}%`);
  setColor('opsTempFactor', d.tempFactor > 0.9 ? 'green' : d.tempFactor > 0.8 ? 'amber' : 'red');
  setText('opsAltFactor', `${(d.altFactor*100).toFixed(0)}%`);
  setColor('opsAltFactor', d.altFactor > 0.9 ? 'green' : d.altFactor > 0.8 ? 'amber' : 'red');
  setText('opsWindFactor', `${(d.windFactor*100).toFixed(0)}%`);
  setColor('opsWindFactor', d.windFactor > 0.85 ? 'green' : d.windFactor > 0.7 ? 'amber' : 'red');
  setText('opsFlightTime', `~${estTime} min`);
  setColor('opsFlightTime', estTime > 28 ? 'green' : estTime > 20 ? 'amber' : 'red');
  setText('opsCapacity', `${capacity}% of nominal`);
  const bar = document.getElementById('opsCapBar');
  bar.style.width = `${capacity}%`;
  bar.style.background = capacity > 85 ? 'var(--accent-green)' : capacity > 70 ? 'var(--accent-amber)' : 'var(--accent-red)';

  // Multi-factor bird strike risk assessment (follows the selected timeline hour
  // when one is set; falls back to the real clock for no-arg/test callers).
  const when = snap._time ? new Date(snap._time) : new Date();
  const month = when.getMonth();
  const hour = when.getHours();
  let birdScore = 0;
  const factors = [];

  // Season factor (0-3 points)
  let seasonText, seasonLevel;
  if (month >= 2 && month <= 6) {
    birdScore += 3; seasonText = 'Nesting season (Mar-Jul)'; seasonLevel = 'red';
  } else if (month >= 8 && month <= 10) {
    birdScore += 2; seasonText = 'Fall migration (Sep-Nov)'; seasonLevel = 'amber';
  } else if (month === 7) {
    birdScore += 1; seasonText = 'Late summer — fledglings active'; seasonLevel = 'amber';
  } else {
    birdScore += 0; seasonText = 'Winter — low activity'; seasonLevel = 'green';
  }
  setText('opsBirdSeason', seasonText);
  setColor('opsBirdSeason', seasonLevel);
  if (birdScore >= 2) factors.push(seasonText.split(' \u2014')[0].split(' —')[0]);

  // Time of day factor (0-2 points)
  let timeText, timeLevel;
  if ((hour >= 5 && hour <= 8) || (hour >= 16 && hour <= 19)) {
    birdScore += 2; timeText = 'Dawn/dusk — peak activity'; timeLevel = 'red';
    factors.push('Peak bird hours');
  } else if (hour >= 9 && hour <= 15) {
    birdScore += 1; timeText = 'Midday — moderate soaring'; timeLevel = 'amber';
  } else {
    birdScore += 0; timeText = 'Night — minimal risk'; timeLevel = 'green';
  }
  setText('opsBirdTime', timeText);
  setColor('opsBirdTime', timeLevel);

  // Water proximity factor (0-2 points) — check elevation data for low-lying flat areas
  // Also check if terrain features indicate valleys/water corridors
  let waterText = 'Unknown', waterLevel = 'amber';
  const hasLowTerrain = S.elev && S.elev.min != null && S.elev.min < 500;
  const hasWetlandTerrain = S.elev && S.elev.range != null && S.elev.range < 100 && S.elev.center < 1000;
  const nearWater = S.protectedAreas && S.protectedAreas.dams && S.protectedAreas.dams.length > 0;
  if (nearWater || hasWetlandTerrain) {
    birdScore += 2; waterText = 'Water/wetland nearby — waterfowl likely'; waterLevel = 'red';
    factors.push('Near water');
  } else if (hasLowTerrain) {
    birdScore += 1; waterText = 'Low terrain — possible watercourses'; waterLevel = 'amber';
  } else {
    birdScore += 0; waterText = 'No water features detected'; waterLevel = 'green';
  }
  setText('opsBirdWater', waterText);
  setColor('opsBirdWater', waterLevel);

  // Altitude factor (0-2 points) — most bird strikes below 500 ft AGL
  let altText, altLevel;
  const opAlt = _t.maxAltAGL || 400;
  if (opAlt <= 200) {
    birdScore += 2; altText = '\u2264200 ft AGL — high strike zone'; altLevel = 'red';
    factors.push('Low altitude ops');
  } else if (opAlt <= 400) {
    birdScore += 1; altText = '200-400 ft AGL — moderate zone'; altLevel = 'amber';
  } else {
    birdScore += 0; altText = '>400 ft AGL — above most birds'; altLevel = 'green';
  }
  setText('opsBirdAlt', altText);
  setColor('opsBirdAlt', altLevel);

  // Overall risk rating
  let riskLabel, riskLevel;
  if (birdScore >= 7) { riskLabel = 'HIGH — aggressive bird encounters likely'; riskLevel = 'red'; }
  else if (birdScore >= 4) { riskLabel = 'MODERATE — maintain visual watch'; riskLevel = 'amber'; }
  else { riskLabel = 'LOW — standard awareness'; riskLevel = 'green'; }
  setText('opsBirdRisk', riskLabel);
  setColor('opsBirdRisk', riskLevel);
  setText('opsBirds', factors.length > 0 ? factors.join(' \u2022 ') : 'No elevated risk factors');
  setColor('opsBirds', birdScore >= 4 ? 'amber' : 'green');

  // Battery swap recommendation
  if (typeof calcSwapRecommendation === 'function') {
    const cruiseSpeed = 20; // mph default for SAR ops
    const swap = calcSwapRecommendation(estTime, cruiseSpeed, S.lzs || []);
    setText('opsSwapTime', `~${Math.round(swap.swapTimeMin)} min`);
    setText('opsSwapRadius', `${swap.swapRadiusKm.toFixed(1)} km`);
    if (swap.nearestLZ) {
      setText('opsSwapLZ', `Score ${Math.round(swap.nearestLZ.score * 100)}% at (${swap.nearestLZ.lat.toFixed(4)}, ${swap.nearestLZ.lng.toFixed(4)})`);
    } else {
      setText('opsSwapLZ', 'No suitable LZ \u2014 plan manual recovery');
    }

    // Draw swap radius circle on map (guard for test env without full Leaflet)
    if (typeof L !== 'undefined' && typeof L.layerGroup === 'function') {
      if (S.mapLayers.swap_radius) {
        S.mapLayers.swap_radius.clearLayers();
      } else {
        S.mapLayers.swap_radius = L.layerGroup();
      }
      if (S.areaCenter && swap.swapRadiusKm > 0 && typeof L.circle === 'function') {
        const circle = L.circle([S.areaCenter.lat, S.areaCenter.lng], {
          radius: swap.swapRadiusKm * 1000,
          color: '#a78bfa',
          weight: 1.5,
          fillOpacity: 0,
          dashArray: '4,8',
          opacity: 0.6,
        });
        circle.bindTooltip(`Swap radius: ${swap.swapRadiusKm.toFixed(1)} km`, { permanent: false, direction: 'top' });
        S.mapLayers.swap_radius.addLayer(circle);
        // Not while PLANS owns it — computeOpsData also runs on time-bar scrubs,
        // which do not rebuild the layer control, so the re-attach would stick.
        if (S.map && !S.map.hasLayer(S.mapLayers.swap_radius) && !_plansSuppressed('swap_radius')) {
          S.mapLayers.swap_radius.addTo(S.map);
        }
      }
    }
  }
}

function computeAssessment(snap) {
  snap = snap || snapshotAtIdx(S.timeIdx || 0);
  // Live, effective thresholds (defaults < active profile < edited inputs).
  const thresholds = readActiveThresholds();
  // Weather-driven gates use the selected-hour snapshot; the overlays below
  // (NWS/TFR/NOTAM/airspace/fire/ADS-B/Kp/AQI) remain current-time — the
  // timeline banner notes this when a forecast hour is selected.
  const result = assessRisk(snap, S.wind, S.elev, thresholds.maxWindTol, thresholds);

  // Observed-METAR cloud-clearance + minimum-visibility gate (Part 107 §107.51(c)).
  // Current-time observation from the nearest reporting station; applied to every
  // timeline hour (the banner notes overlays are current-time when scrubbing).
  if (S.metar && S.metar.ok) {
    const cc = assessCloudClearance(S.metar.ceilingFt, S.metar.visSm, thresholds.maxAltAGL, thresholds);
    if (cc.issues.length) {
      result.level = 'NO-GO';
      result.issues = (result.issues || []).concat(cc.issues.map(s => `${s} (${S.metar.station})`));
      result.text = result.issues.join(' • ');
    }
    if (cc.cautions.length) {
      result.cautions = (result.cautions || []).concat(cc.cautions.map(s => `${s} (${S.metar.station})`));
      if (result.level === 'GO') { result.level = 'CAUTION'; result.text = result.cautions.join(' • '); }
    }
  }

  // Wildfire smoke plume (NOAA HMS) over the area — reduced visibility / VLOS (CAUTION).
  if (S.hmsSmoke && S.hmsSmoke.length && S.currentArea) {
    const areaPoly = currentAreaPolygon();
    if (areaPoly) {
      const hit = S.hmsSmoke.some(f => {
        const dens = String((f.properties || {}).Density || '').toLowerCase();
        if (!(dens.includes('medium') || dens.includes('heavy'))) return false;
        return geoJsonOuterRings(f.geometry).some(r => polygonsIntersect(r, areaPoly));
      });
      if (hit && result.level !== 'NO-GO') {
        if (result.level === 'GO') result.level = 'CAUTION';
        result.cautions = result.cautions || [];
        result.cautions.push('Wildfire smoke plume over area — reduced visibility/VLOS');
        if (!result.issues || !result.issues.length) result.text = result.cautions.join(' • ');
      }
    }
  }

  // Avalanche danger (avalanche.org) at the launch point — ground-team hazard (CAUTION).
  // Considerable (3) or higher, or an active warning, over the launch coordinates.
  if (S.avalanche && S.avalanche.length && S.areaCenter) {
    const c = S.areaCenter;
    const danger = S.avalanche.find(f => {
      const p = f.properties || {};
      if (!((p.danger_level != null && p.danger_level >= 3) || p.warning)) return false;
      return geoJsonOuterRings(f.geometry).some(r => pointInPolygon(c.lat, c.lng, r));
    });
    if (danger && result.level !== 'NO-GO') {
      const p = danger.properties || {};
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(p.warning ? 'Avalanche warning in effect for area' : `Avalanche danger level ${p.danger_level} — ground-team hazard`);
      if (!result.issues || !result.issues.length) result.text = result.cautions.join(' • ');
    }
  }

  // Integrate NWS severe weather alerts into assessment
  if (S.nwsAlerts && S.nwsAlerts.length > 0) {
    const severeAlerts = S.nwsAlerts.filter(a => a.severity === 'Extreme' || a.severity === 'Severe');
    const moderateAlerts = S.nwsAlerts.filter(a => a.severity === 'Moderate');
    if (severeAlerts.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push(`NWS: ${severeAlerts.map(a => a.event).join(', ')}`);
      result.text = result.issues.join(' \u2022 ');
    } else if (moderateAlerts.length > 0 && result.level === 'GO') {
      result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(`NWS: ${moderateAlerts.map(a => a.event).join(', ')}`);
      result.text = result.cautions.join(' \u2022 ');
    }
  }

  // Imported FAA TFRs (manual file import) — authoritative, take precedence.
  // An active TFR whose geometry overlaps the drawn area is a hard NO-GO.
  if (S.tfrs && S.tfrs.length && S.currentArea) {
    const areaPoly = currentAreaPolygon();
    if (areaPoly) {
      const intersecting = filterTfrsIntersectingArea(S.tfrs, areaPoly);
      const activeHits = intersecting.filter(t => isTfrActiveNow(t, Date.now()));
      if (activeHits.length) {
        result.level = 'NO-GO';
        result.issues = result.issues || [];
        result.issues.push('Active TFR over area: ' + activeHits.map(t => t.id).join(', '));
        result.text = result.issues.join(' • ');
      } else if (intersecting.length && result.level !== 'NO-GO') {
        if (result.level === 'GO') result.level = 'CAUTION';
        result.cautions = result.cautions || [];
        result.cautions.push('TFR over area not currently active — verify times: ' + intersecting.map(t => t.id).join(', '));
        if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' • ');
      }
    }
  }

  // Imported NOTAMs with an area (polygon) overlapping the drawn area -> CAUTION.
  // NOTAM semantics vary too much to auto-NO-GO; flag for pilot review instead.
  if (S.importedNotams && S.importedNotams.length && S.currentArea) {
    const areaPoly = currentAreaPolygon();
    if (areaPoly) {
      const hits = S.importedNotams.filter(n => n.polygons && n.polygons.length &&
        n.polygons.some(r => polygonsIntersect(r, areaPoly)) && isTfrActiveNow(n, Date.now()));
      if (hits.length && result.level !== 'NO-GO') {
        if (result.level === 'GO') result.level = 'CAUTION';
        result.cautions = result.cautions || [];
        result.cautions.push('NOTAM over area — review: ' + hits.map(n => n.id).join(', '));
        if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' • ');
      }
    }
  }

  // Integrate FAA airspace data into assessment
  if (S.faaAirspace) {
    // NO-GO: active TFR
    if (S.faaAirspace.tfrs && S.faaAirspace.tfrs.features && S.faaAirspace.tfrs.features.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push('Active TFR: ' + S.faaAirspace.tfrs.features.map(f => f.properties.NAME || 'TFR').join(', '));
      result.text = result.issues.join(' \u2022 ');
    }
    // NO-GO: prohibited airspace
    if (S.faaAirspace.sua && S.faaAirspace.sua.features) {
      const prohibited = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('P'));
      if (prohibited.length > 0) {
        result.level = 'NO-GO';
        result.issues = result.issues || [];
        result.issues.push('Prohibited airspace: ' + prohibited.map(f => f.properties.NAME || 'P-area').join(', '));
        result.text = result.issues.join(' \u2022 ');
      }
    }
    // NO-GO: national security UAS restrictions
    if (S.faaAirspace.nsRestrictions && S.faaAirspace.nsRestrictions.features && S.faaAirspace.nsRestrictions.features.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push('NS UAS restriction: ' + S.faaAirspace.nsRestrictions.features.map(f => f.properties.NAME || 'NS area').join(', '));
      result.text = result.issues.join(' \u2022 ');
    }
    // CAUTION: Class B/C/D without LAANC
    if (S.faaAirspace.classAirspace && S.faaAirspace.classAirspace.features) {
      const controlled = S.faaAirspace.classAirspace.features.filter(f => {
        const cls = (f.properties.CLASS || '').charAt(0);
        return cls === 'B' || cls === 'C' || cls === 'D';
      });
      if (controlled.length > 0) {
        const hasLaanc = S.faaAirspace.laanc && S.faaAirspace.laanc.features && S.faaAirspace.laanc.features.length > 0;
        if (!hasLaanc && result.level !== 'NO-GO') {
          if (result.level === 'GO') result.level = 'CAUTION';
          result.cautions = result.cautions || [];
          result.cautions.push('Controlled airspace without LAANC data');
          if (result.level === 'CAUTION' && result.issues.length === 0) {
            result.text = result.cautions.join(' \u2022 ');
          }
        }
      }
    }
    // CAUTION: MOA present
    if (S.faaAirspace.sua && S.faaAirspace.sua.features) {
      const moas = S.faaAirspace.sua.features.filter(f => (f.properties.TYPE_CODE || '').startsWith('M'));
      if (moas.length > 0 && result.level !== 'NO-GO') {
        if (result.level === 'GO') result.level = 'CAUTION';
        result.cautions = result.cautions || [];
        result.cautions.push('MOA active \u2014 check with ATC');
        if (result.level === 'CAUTION' && result.issues.length === 0) {
          result.text = result.cautions.join(' \u2022 ');
        }
      }
    }
  }

  // Integrate Protected Areas into assessment
  if (S.protectedAreas) {
    if (S.protectedAreas.dams && S.protectedAreas.dams.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('Dam nearby \u2014 UAS prohibited within 400ft per 49 USC \u00A7 46307');
      if (result.level === 'CAUTION' && (!result.issues || result.issues.length === 0)) {
        result.text = result.cautions.join(' \u2022 ');
      }
    }
    if (S.protectedAreas.wilderness && S.protectedAreas.wilderness.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('Wilderness Area \u2014 UAS requires USFS permit');
      if (result.level === 'CAUTION' && (!result.issues || result.issues.length === 0)) {
        result.text = result.cautions.join(' \u2022 ');
      }
    }
    if (S.protectedAreas.nationalParks && S.protectedAreas.nationalParks.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('National Park \u2014 UAS requires NPS authorization per 36 CFR 1.5');
      if (result.level === 'CAUTION' && (!result.issues || result.issues.length === 0)) {
        result.text = result.cautions.join(' \u2022 ');
      }
    }
  }

  // Non-public-land CAUTION (BLM Surface Management Agency). Advisory only \u2014 surface
  // management data is parcel-coarse and "Undetermined" lumps with true-private, so
  // this prompts verification and is never an auto NO-GO. Suppressed entirely when
  // SMA returned no features for the area (no coverage \u2260 private).
  if (S.landStatus && S.landStatus.sampled > 0 && S.landStatus.privateFrac > 0.03 && result.level !== 'NO-GO') {
    if (result.level === 'GO') result.level = 'CAUTION';
    result.cautions = result.cautions || [];
    const pct = Math.round(S.landStatus.privateFrac * 100);
    const msg = (pct >= 97)
      ? 'Operating area appears to be entirely on private / non-public land \u2014 verify landowner permission before flight'
      : `Part of operating area (~${pct}%) is on private / non-public land \u2014 verify landowner permission before flight`;
    result.cautions.push(msg);
    if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' \u2022 ');
  }

  // Cell-coverage CAUTION \u2014 only when the FCC overlay is loaded AND the area center
  // falls inside the bundled region but no carrier covers it (no data \u2260 no coverage).
  if (S.cellStatus && S.cellStatus.inRegion && S.cellStatus.count === 0 && result.level !== 'NO-GO') {
    if (result.level === 'GO') result.level = 'CAUTION';
    result.cautions = result.cautions || [];
    result.cautions.push('Area outside all mapped carrier LTE coverage (FCC) \u2014 plan for no cell connectivity');
    if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' \u2022 ');
  }

  // Integrate FAA DOF obstacles into assessment. CAUTION-only and never an auto
  // NO-GO: this is advisory hazard data and the DOF is not a complete
  // low-altitude inventory, so it must not give false confidence either way.
  if (S.faaObstacles && S.faaObstacles.features && S.faaObstacles.features.length > 0) {
    const obs = summarizeObstacles(S.faaObstacles.features, UAS_CEILING_FT);
    if (obs.tallCount > 0 && result.level !== 'NO-GO') {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(`${obs.tallCount} tall obstacle${obs.tallCount === 1 ? '' : 's'} in area (tallest ${obs.maxAgl} ft AGL) — verify clearance`);
      if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' • ');
    }
  }

  // Integrate fire danger into assessment (NO-GO / CAUTION distances configurable)
  if (S.activeFires && S.activeFires.length > 0) {
    const fireNoGoNm = thresholds.fireNoGoNm ?? 10;
    const fireCautionNm = thresholds.fireCautionNm ?? 30;
    const nearFires = S.activeFires.filter(f => parseFloat(f.distNm) < fireNoGoNm);
    if (nearFires.length > 0) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push(`Active fire within ${fireNoGoNm}nm: ` + nearFires.map(f => f.name).join(', '));
      result.text = result.issues.join(' \u2022 ');
    } else if (result.level !== 'NO-GO') {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(`Active fire within ${fireCautionNm}nm \u2014 monitor for TFRs`);
      if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' \u2022 ');
    }
  }
  if (S.fireDanger && S.fireDanger.ercPct >= 90 && result.level !== 'NO-GO') {
    if (result.level === 'GO') result.level = 'CAUTION';
    result.cautions = result.cautions || [];
    result.cautions.push('Very high/extreme fire danger \u2014 wildfire TFR risk');
    if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' \u2022 ');
  }

  // Integrate ADS-B traffic into assessment (CAUTION only, never NO-GO)
  if (S.adsbAircraft && S.adsbAircraft.length > 0 && result.level !== 'NO-GO') {
    const emergencyAc = S.adsbAircraft.filter(ac =>
      ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700' ||
      (ac.emergency && ac.emergency !== 'none')
    );
    if (emergencyAc.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push('Emergency aircraft nearby (squawk ' + emergencyAc.map(a => a.squawk).join(', ') + ')');
      if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' \u2022 ');
    }
    const lowClose = S.adsbAircraft.filter(ac => ac.agl > 0 && ac.agl < 500 && ac.distNm < 3);
    if (lowClose.length > 0) {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(lowClose.length + ' aircraft below 500ft AGL within 3nm');
      if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' \u2022 ');
    }
  }

  // Geomagnetic (Kp) CAUTION — elevated Kp degrades GNSS positioning
  if (S.kp != null && thresholds.kpCaution != null && S.kp >= thresholds.kpCaution && result.level !== 'NO-GO') {
    if (result.level === 'GO') result.level = 'CAUTION';
    result.cautions = result.cautions || [];
    result.cautions.push(`Geomagnetic Kp ${S.kp} — GNSS accuracy may degrade`);
    if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' • ');
  }

  // Air quality — hazardous AQI (often wildfire smoke) is NO-GO; unhealthy is CAUTION
  if (S.aqi != null) {
    if (thresholds.aqiNoGo != null && S.aqi >= thresholds.aqiNoGo) {
      result.level = 'NO-GO';
      result.issues = result.issues || [];
      result.issues.push(`Hazardous air quality (AQI ${S.aqi})`);
      result.text = result.issues.join(' • ');
    } else if (thresholds.aqiCaution != null && S.aqi >= thresholds.aqiCaution && result.level !== 'NO-GO') {
      if (result.level === 'GO') result.level = 'CAUTION';
      result.cautions = result.cautions || [];
      result.cautions.push(`Unhealthy air quality / smoke (AQI ${S.aqi})`);
      if (!result.issues || result.issues.length === 0) result.text = result.cautions.join(' • ');
    }
  }

  // Append staleness warning if data is older than 30 minutes
  if (typeof _lastDataTimestamp !== 'undefined' && _lastDataTimestamp) {
    const dataAge = Date.now() - _lastDataTimestamp;
    if (dataAge > 30 * 60 * 1000) {
      const ageStr = typeof formatAge === 'function' ? formatAge(dataAge) : Math.round(dataAge / 60000) + 'm';
      result.text = (result.text ? result.text + ' | ' : '') + 'DATA STALE (' + ageStr + ' old) — refresh recommended';
    }
  }

  const badge = document.getElementById('assessBadge');
  badge.textContent = result.level;
  badge.className = 'assessment-badge ' + (result.level === 'GO' ? 'go' : result.level === 'CAUTION' ? 'caution' : 'nogo');
  document.getElementById('assessText').textContent = result.text;

}

// ============================================================
// KML EXPORT
// ============================================================
// Advisory note attached to wire/obstacle/NOTAM/TFR folders and the document root.
const EXPORT_DISCLAIMER = 'Advisory only \u2014 NOT a complete inventory. Wires, obstacles, TFRs and ' +
  'NOTAMs from these public datasets are frequently incomplete. Verify against official FAA sources ' +
  '(B4UFLY / LAANC, current sectional, FAA TFR & NOTAM search) and a visual scan of the area before flight.';
// Keys whose folder carries the disclaimer (wire_* handled by prefix).
const EXPORT_DISCLAIMER_KEYS = new Set(['faa_tfr', 'tfr_imported', 'notam_imported', 'faa_obstacles', 'emergency_lz']);

function _exportNeedsDisclaimer(key) {
  return key.indexOf('wire_') === 0 || EXPORT_DISCLAIMER_KEYS.has(key);
}

// Data-summary sections shown at the area centre (shared by KML + GeoJSON export).
const EXPORT_SUMMARY_SECTIONS = [
  { id: 'expWxData', name: 'Weather', fields: ['wxTemp','wxFeels','wxDew','wxHumidity','wxPressure','wxDensity','wxVis','wxCloud','wxCeiling','wxConditions','wxPrecip','wxLightning','wxUV','wxKp','wxIcing','wxFire','wxAQI'] },
  { id: 'expWindData', name: 'Wind Profile', fields: ['windMax','windGustMax','windDir','windImpact'] },
  { id: 'expAirspace', name: 'Airspace', fields: ['airClass','airLAANC','airLAANCAlt','airNearAirport','airNearDist'] },
  { id: 'expTerrain', name: 'Terrain', fields: ['terrMin','terrMax','terrRange','terrLaunch','terrClass','terrSlope','terrVeg','terrCell'] },
  { id: 'expAstro', name: 'Sun Moon Twilight', fields: ['astSunrise','astSunset','astTwilightAM','astTwilightPM','astSunAz','astSunEl','astMoonPhase','astMoonIllum','astDayWindow','astMagDec'] },
  { id: 'expOps', name: 'Operations', fields: ['opsTempFactor','opsAltFactor','opsWindFactor','opsFlightTime','opsCapacity'] },
];

// Plain-text description for a summary section, scraped from the live data cells.
function _exportSummaryDesc(s) {
  return s.fields.map(f => {
    const el = document.getElementById(f);
    const label = el?.closest('.data-cell')?.querySelector('.data-label')?.textContent || f;
    return `${label}: ${el?.textContent || '--'}`;
  }).join('\n');
}

// Map a map-layer key to one of the shared KML <Style> ids (see KML_STYLE_DEFS).
function _exportStyleForLayer(key) {
  if (key.indexOf('wire_') === 0) return 'wire';
  const m = {
    faa_tfr: 'restrict', tfr_imported: 'restrict', faa_prohibited: 'restrict',
    faa_ns_restrictions: 'restrict', notam_imported: 'restrict', nws_alerts: 'restrict',
    fire_perimeters: 'fire', faa_sua: 'sua', faa_class_airspace: 'airspace', faa_laanc: 'airspace',
    faa_obstacles: 'obstacle', airports: 'airport', cell_towers: 'tower', dams: 'dam',
    adsb_aircraft: 'aircraft', wilderness: 'protected', national_parks: 'protected',
    emergency_lz: 'protected', swap_radius: 'opsArea', observers: 'observer',
    trails: 'trail', hms_smoke: 'fire', avalanche: 'protected',
  };
  return m[key] || 'generic';
}

// Strip HTML to a short plain-text title for the placemark <name>.
function _exportPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>(?=.)/gi, ' \u00b7 ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Normalize Leaflet getLatLngs() into an array of polygons; each polygon is an
// array of rings; each ring an array of [lat,lng]. Handles simple / holed / multi.
function _polyRingsGroups(latlngs) {
  if (!Array.isArray(latlngs) || !latlngs.length) return [];
  const isLL = (x) => x && typeof x.lat === 'number';
  if (isLL(latlngs[0])) return [[latlngs.map(p => [p.lat, p.lng])]];
  if (Array.isArray(latlngs[0]) && isLL(latlngs[0][0])) return [latlngs.map(ring => ring.map(p => [p.lat, p.lng]))];
  return latlngs.map(poly => (poly || []).map(ring => ring.map(p => [p.lat, p.lng])));
}

// ----- Neutral export records -----
// The harvesters below produce format-agnostic feature records so the same
// geometry/description/style can be serialized to either KML or CalTopo GeoJSON.
// A record is: { kind:'point'|'line'|'polygon', name, description, styleId,
//   lat,lng | coords:[[lat,lng],...] | rings:[[[lat,lng],...], ...] }.

// Convert every popup-bearing feature in a layer group into export records.
function _exportLayerRecords(key, group) {
  const styleId = _exportStyleForLayer(key);
  const fallback = _aggMeta(key).label || 'Feature';
  const recs = [];
  eachPopupLayer(group, pl => {
    let html = '';
    try { html = _aggContentToHtml(pl.getPopup().getContent()); } catch (e) { html = ''; }
    const name = _exportPlainText(html).slice(0, 48) || fallback;
    // Descriptions are plain text (no HTML markup) so they read cleanly in CalTopo notes.
    const description = (typeof htmlToPlainText === 'function') ? htmlToPlainText(html) : html;
    try {
      if (typeof L !== 'undefined' && L.Polygon && pl instanceof L.Polygon) {
        _polyRingsGroups(pl.getLatLngs()).forEach(rings => {
          recs.push({ kind: 'polygon', name, styleId, description, rings });
        });
      } else if (typeof L !== 'undefined' && L.Polyline && pl instanceof L.Polyline) {
        const segs = [];
        const collect = a => { if (!Array.isArray(a)) return; if (a.length && a[0] && typeof a[0].lat === 'number') segs.push(a); else a.forEach(collect); };
        collect(pl.getLatLngs());
        segs.forEach(seg => { recs.push({ kind: 'line', name, styleId, description, coords: seg.map(p => [p.lat, p.lng]) }); });
      } else if (pl.getLatLng) {
        const ll = pl.getLatLng();
        recs.push({ kind: 'point', name, styleId, description, lat: ll.lat, lng: ll.lng });
      }
    } catch (e) { /* skip malformed feature */ }
  });
  return recs;
}

// Imported NOTAMs — plain-English summary first, then the full text. Built from
// state (S.importedNotams) so the description is richer than the map popup.
function _exportNotamRecords() {
  const recs = [];
  const showAll = !!S.notamShowAll;
  (S.importedNotams || []).forEach(n => {
    if (n._relevance && !n._relevance.relevant && !showAll) return; // match what's on the map
    const summary = (typeof notamPlainSummary === 'function') ? notamPlainSummary(n) : '';
    const body = String(n.body || '').trim();
    const expanded = (typeof expandNotamText === 'function') ? expandNotamText(body) : body;
    const description = [
      summary,
      body ? '\n— Full NOTAM —\n' + body : '',
      (expanded && expanded !== body) ? '\n— Decoded —\n' + expanded : '',
    ].filter(Boolean).join('\n').trim();
    const name = `NOTAM ${n.id || ''}${n.location ? ' ' + n.location : ''}`.trim();
    if (n.polygons && n.polygons.length) {
      n.polygons.forEach(ring => {
        if (!ring || ring.length < 3) return;
        recs.push({ kind: 'polygon', name, styleId: 'restrict', description, rings: [ring] });
      });
    } else if (n.lat != null && n.lng != null && !isNaN(n.lat) && !isNaN(n.lng)) {
      recs.push({ kind: 'point', name, styleId: 'restrict', description, lat: n.lat, lng: n.lng });
    }
  });
  return recs;
}

// Imported TFRs — plain-English summary first, then the structured details.
function _exportTfrRecords() {
  const recs = [];
  const now = Date.now();
  (S.tfrs || []).forEach(t => {
    const active = (typeof isTfrActiveNow === 'function') ? isTfrActiveNow(t, now) : null;
    const alt = (t.lowerAlt != null || t.upperAlt != null)
      ? `${t.lowerAlt != null ? t.lowerAlt : 'SFC'}-${t.upperAlt != null ? t.upperAlt : 'UNL'} ${t.altUom || 'ft'}`.trim()
      : 'altitude n/a';
    const status = active === true ? 'ACTIVE NOW' : active === false ? 'inactive / scheduled' : 'status unknown';
    const summary = `TFR ${t.id || ''}: ${t.name || 'Temporary Flight Restriction'} — ${status}. Altitude ${alt}.`.replace(/\s+/g, ' ').trim();
    const details = [
      `ID: ${t.id || '--'}`,
      t.type ? `Type: ${t.type}` : '',
      `Altitude: ${alt}`,
      t.artcc ? `ARTCC: ${t.artcc}` : '',
      (t.effectiveStart || t.effectiveEnd) ? `Effective: ${t.effectiveStart || '?'} to ${t.effectiveEnd || '?'}` : '',
      t.reason ? `Reason: ${t.reason}` : '',
    ].filter(Boolean).join('\n');
    const description = summary + '\n\n— Details —\n' + details;
    const name = `TFR ${t.id || ''}`.trim();
    (t.polygons || []).forEach(ring => {
      if (!ring || ring.length < 3) return;
      recs.push({ kind: 'polygon', name, styleId: 'restrict', description, rings: [ring] });
    });
  });
  return recs;
}

// Airports — point per airport, plane icon for airports / circle-H for heliports.
function _exportAirportRecords() {
  const recs = [];
  const c = S.areaCenter;
  const list = (typeof filterAirportsByDistance === 'function' && c)
    ? filterAirportsByDistance(S.nearbyAirports || [], c.lat, c.lng, 55)
    : (S.nearbyAirports || []);
  list.forEach(a => {
    if (a.lat == null || a.lng == null) return;
    const isHeli = a.type === 'heliport';
    const typeLabel = String(a.type || '').replace(/_/g, ' ');
    const description = [
      `${a.icao || ''} — ${a.name || ''}`.trim(),
      typeLabel ? `Type: ${typeLabel}` : '',
      a.elevation_ft ? `Elevation: ${a.elevation_ft} ft` : '',
      a.municipality ? `Municipality: ${a.municipality}` : '',
    ].filter(Boolean).join('\n');
    recs.push({ kind: 'point', name: a.icao || a.name || 'Airport', styleId: isHeli ? 'heliport' : 'airport', description, lat: a.lat, lng: a.lng });
  });
  return recs;
}

// Observer points (one per viewshed record) — name + AGL/VLOS/coverage plus
// the visual-observation advisories (sun-glare windows for the export day,
// terrain-backdrop sectors) so they survive into CalTopo/Google Earth.
function _exportObserverRecords() {
  const recs = [];
  (S.viewsheds || []).forEach(rec => {
    if (!rec.observer || rec.observer.lat == null || rec.observer.lng == null) return;
    let glareText = '';
    try { glareText = _glareAdvisoryText(rec); } catch (e) { /* advisory only */ }
    const backdropText = rec.backdrop
      ? formatSectorRanges(rec.backdrop.map(f => f >= BACKDROP_SECTOR_MIN_FRAC)) : '';
    recs.push({ kind: 'point', name: rec.name || 'Observer', styleId: 'observer',
      description: observerKmlDescription(rec, { glareText, backdropText }),
      lat: rec.observer.lat, lng: rec.observer.lng });
  });
  return recs;
}

// Low-poly vector polygons of every COMPUTED viewshed (same rule as the GeoTIFF
// export: r.grid && r.mask, map visibility ignored). One 'polygon' record per
// visible-region blob (holes ride along as inner rings) so the serializers'
// single-Polygon shape is enough — no MultiPolygon needed.
function _exportViewshedPolygonRecords() {
  const recs = [];
  (S.viewsheds || []).filter(r => r.grid && r.mask).forEach(rec => {
    let parts = [];
    try { parts = viewshedToPolygons(rec.grid, rec.mask); }
    catch (e) { console.error('viewshed polygonize error:', e); return; }
    const n = parts.length;
    parts.forEach((p, i) => {
      const base = `${rec.name || 'Observer'} viewshed`;
      recs.push({ kind: 'polygon',
        name: n > 1 ? `${base} (part ${i + 1}/${n})` : base,
        styleId: 'viewshed',
        description: viewshedPolygonDescription(rec, { index: i + 1, count: n, areaM2: p.areaM2 }),
        rings: p.rings });
    });
  });
  return recs;
}

// Emergency LZ points — a SYNTHETIC source. The emergency_lz map layer is left
// empty on purpose (see renderLZMarkers): these are terrain-suitability estimates
// from a coarse 25-point elevation grid, NOT verified landing zones. So we harvest
// directly from S.lzs, take only the top few by score, drop clearly-too-steep ones,
// and lead every record with a strong disclaimer (the folder also carries
// EXPORT_DISCLAIMER via EXPORT_DISCLAIMER_KEYS).
const EXPORT_LZ_MAX = 5;         // top candidates by score
const EXPORT_LZ_MAX_SLOPE = 15;  // deg; skip candidates clearly too steep to be useful
function _exportLZRecords() {
  const lzs = (S.lzs || [])
    .filter(lz => lz && lz.lat != null && lz.lng != null &&
      (lz.slopeDeg == null || lz.slopeDeg <= EXPORT_LZ_MAX_SLOPE))
    .slice(0, EXPORT_LZ_MAX);  // S.lzs is pre-sorted by score (findEmergencyLZs)
  return lzs.map((lz, i) => {
    const scorePct = lz.score != null ? Math.round(lz.score * 100) : null;
    const description = [
      'TERRAIN ESTIMATE ONLY — NOT a verified landing zone.',
      'Derived from a coarse 25-point elevation grid; confirm on satellite imagery and by visual scan before any use.',
      '',
      scorePct != null ? `Suitability score: ${scorePct}%` : '',
      lz.slopeDeg != null ? `Approx. slope: ${lz.slopeDeg.toFixed(1)}°` : '',
      `Coordinates: ${lz.lat.toFixed(5)}, ${lz.lng.toFixed(5)}`,
    ].filter(Boolean).join('\n');
    const name = `Emergency LZ #${i + 1}${scorePct != null ? ` (score ${scorePct}%)` : ''}`;
    return { kind: 'point', name, styleId: 'protected', description, lat: lz.lat, lng: lz.lng };
  });
}

// Group every currently-visible map overlay into ordered folder groups of records.
// `selectedKeys` (a Set of layer keys) optionally restricts which layers are
// included; null = all visible. Returns [{ label, disclaim, features:[record,...] }].
function collectExportFolderGroups(selectedKeys) {
  const groups = [];
  if (!S.map || !S.mapLayers) return groups;
  const keys = Object.keys(S.mapLayers).filter(k =>
    !EXPORT_SKIP_LAYERS.has(k) && S.mapLayers[k] &&
    (S.map.hasLayer(S.mapLayers[k]) || EXPORT_HIDDEN_OK.has(k)));
  // Emergency LZ is a synthetic source (its map layer is intentionally empty).
  if (S.lzs && S.lzs.length && !keys.includes('emergency_lz')) keys.push('emergency_lz');
  keys.sort((a, b) => _aggMeta(a).pri - _aggMeta(b).pri); // safety layers first
  const byLabel = {};
  keys.forEach(k => {
    if (selectedKeys && !selectedKeys.has(k)) return;
    // Layers we describe richly from state (plain-English first, icon by type)
    // rather than scraping their popups generically.
    let recs;
    if (k === 'notam_imported') recs = _exportNotamRecords();
    else if (k === 'tfr_imported') recs = _exportTfrRecords();
    else if (k === 'airports') recs = _exportAirportRecords();
    else if (k === 'observers') recs = _exportObserverRecords();
    else if (k === 'emergency_lz') recs = _exportLZRecords();
    else recs = _exportLayerRecords(k, S.mapLayers[k]);
    if (!recs || !recs.length) return;
    const label = _aggMeta(k).label || 'Other';
    if (!byLabel[label]) { byLabel[label] = { label, disclaim: false, features: [] }; groups.push(byLabel[label]); }
    byLabel[label].features.push(...recs);
    if (_exportNeedsDisclaimer(k)) byLabel[label].disclaim = true;
  });
  return groups;
}

// ----- Record serializers -----
function recordToKml(f) {
  if (f.kind === 'point') return kmlPointPlacemark({ name: f.name, styleUrl: f.styleId, description: f.description, lat: f.lat, lng: f.lng });
  if (f.kind === 'line') return kmlLinePlacemark({ name: f.name, styleUrl: f.styleId, description: f.description, coords: f.coords });
  if (f.kind === 'polygon') return kmlPolygonPlacemark({ name: f.name, styleUrl: f.styleId, description: f.description, rings: (f.rings || []).map(r => kmlRingFromLatLng(r)) });
  return '';
}

// CalTopo GeoJSON feature for a record, bound to its folder.
function recordToGeoJsonFeature(f, folderId, id) {
  if (f.kind === 'point') {
    return geojsonMarkerFeature(id, folderId, { name: f.name, description: f.description, lat: f.lat, lng: f.lng, styleId: f.styleId });
  }
  if (f.kind === 'line') {
    return geojsonShapeFeature(id, folderId, { name: f.name, description: f.description, styleId: f.styleId, geometry: geojsonLineGeometry(f.coords) });
  }
  if (f.kind === 'polygon') {
    return geojsonShapeFeature(id, folderId, { name: f.name, description: f.description, styleId: f.styleId, geometry: geojsonPolygonGeometry(f.rings) });
  }
  return null;
}

function folderGroupsToKml(groups) {
  let folders = '';
  (groups || []).forEach(g => {
    let inner = '';
    g.features.forEach(f => { inner += recordToKml(f); });
    folders += kmlFolder(g.label, inner, g.disclaim ? { description: EXPORT_DISCLAIMER } : {});
  });
  return folders;
}

// One CalTopo folder feature per group, followed by its member features.
function folderGroupsToGeoJsonFeatures(groups, idGen) {
  const out = [];
  (groups || []).forEach(g => {
    const folderId = idGen();
    out.push(geojsonFolderFeature(folderId, g.label));
    g.features.forEach(f => { const feat = recordToGeoJsonFeature(f, folderId, idGen()); if (feat) out.push(feat); });
  });
  return out;
}

// Build KML folders for every currently-visible map overlay (back-compat wrapper).
function gatherVisibleLayerFolders(selectedKeys) {
  return folderGroupsToKml(collectExportFolderGroups(selectedKeys));
}

// Arrow length scaled to the operational area (clamped 400 m .. 4 km).
function _exportArrowLengthM() {
  let r = 1500;
  try {
    if (S.areaType === 'CIRCLE' && S.currentArea && S.currentArea.getRadius) r = S.currentArea.getRadius();
    else if (S.areaBounds && S.areaCenter && S.map) r = S.map.distance(S.areaCenter, { lat: S.areaBounds.getNorth(), lng: S.areaCenter.lng });
  } catch (e) { /* default */ }
  return Math.max(400, Math.min(4000, r * 0.9));
}

// Folders of hourly sun + wind arrows from the 24 h weather timeline.
function buildSunWindFolders() {
  let folders = '';
  const c = S.areaCenter;
  const hourly = S.wx && S.wx.hourly;
  const times = hourly && hourly.time;
  if (!c || !times) return folders;
  const lengthM = _exportArrowLengthM();
  if (document.getElementById('expSun')?.checked && typeof sunArrowsKml === 'function') {
    folders += kmlFolder('Sun Position (hourly, daylight only)', sunArrowsKml(c.lat, c.lng, times, c.lat, c.lng, { lengthM }),
      { description: 'Hourly bearing lines pointing toward the sun over the next 24 h (omitted while the sun is below the horizon). Drag the Google Earth time slider to animate.' });
  }
  if (document.getElementById('expWind')?.checked && typeof windArrowsKml === 'function') {
    folders += kmlFolder('Wind (hourly)', windArrowsKml(times, hourly.wind_direction_10m, hourly.wind_speed_10m, hourly.wind_gusts_10m, c.lat, c.lng, { lengthM }),
      { description: 'Hourly wind bearing lines for the next 24 h. Line points DOWNWIND (drift direction); label gives the meteorological FROM bearing, speed and gust. Drag the time slider to animate.' });
  }
  return folders;
}

// Which dynamic layer checkboxes are ticked (null = no list rendered \u2192 include all visible).
function _exportSelectedLayerKeys() {
  const boxes = document.querySelectorAll('#exportLayerList input[type="checkbox"]');
  if (!boxes || !boxes.length) return null;
  const set = new Set();
  boxes.forEach(b => { if (b.checked && b.dataset.layerKey) b.dataset.layerKey.split(',').forEach(k => set.add(k)); });
  return set;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// RFC-4122 v4 id for CalTopo GeoJSON features (crypto where available).
function _uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Operational-area boundary as an array of [lat,lng] (open ring; auto-closed downstream).
function _areaRingLatLng() {
  const ring = [];
  const c = S.areaCenter;
  if (S.areaType === 'CIRCLE' && c && S.currentArea && S.currentArea.getRadius) {
    const r = S.currentArea.getRadius();
    for (let i = 0; i <= 36; i++) {
      const a = (i * 10) * Math.PI / 180;
      ring.push([c.lat + (r / 111320) * Math.cos(a), c.lng + (r / (111320 * Math.cos(c.lat * Math.PI / 180))) * Math.sin(a)]);
    }
  } else if (S.areaType === 'RECTANGLE' && S.areaBounds) {
    [S.areaBounds.getNorthWest(), S.areaBounds.getNorthEast(), S.areaBounds.getSouthEast(), S.areaBounds.getSouthWest()]
      .forEach(p => ring.push([p.lat, p.lng]));
  } else if (S.currentArea && S.currentArea.getLatLngs) {
    (S.currentArea.getLatLngs()[0] || []).forEach(p => ring.push([p.lat, p.lng]));
  }
  return ring;
}

// Resolve a raster overlay's grid + RGBA + label, or null if not loaded.
// For viewsheds, `ref` selects a record (id, record, or default = active).
function _exportRasterData(layerId, ref) {
  if (layerId === 'canopy' && S.canopy && S.canopy.grid && S.canopy.canopyFlat) {
    return { grid: S.canopy.grid, rgba: canopyGridToRGBA(S.canopy.grid, S.canopy.canopyFlat), label: 'Canopy' };
  }
  if (layerId === 'viewshed') {
    let rec = null;
    if (ref && typeof ref === 'object') rec = ref;
    else if (ref) rec = (S.viewsheds || []).find(r => r.id === ref);
    else rec = (S.viewsheds || []).find(r => r.id === S.activeViewshedId);
    if (rec && rec.grid && rec.mask) {
      return { grid: rec.grid, rgba: viewshedMaskToRGBA(rec.grid, rec.mask), label: 'Viewshed', name: rec.name };
    }
  }
  return null;
}

// RGBA -> PNG bytes via an offscreen canvas (browser only).
function _rgbaToPngBytes(rgba, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const b64 = canvas.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Export a raster overlay as a georeferenced GeoTIFF in EPSG:3857 (Web Mercator) —
// the projection CalTopo's "Map Sheet" import expects (matches the SAR_UAS_Segment
// tool's working export). The 4326 grid is resampled to a square-pixel mercator grid.
function exportRasterGeoTiff(layerId, ref) {
  const ts = new Date().toISOString().split('T')[0];
  const r = _exportRasterData(layerId, ref);
  if (!r) return;
  try {
    const { grid, rgba, label, name } = r;
    try { Diag.note('export.geotiff', { layer: layerId, px: grid.cols * grid.rows }); } catch (_) {}
    const merc = reprojectRgbaTo3857(rgba, grid);
    const buf = encodeGeoTiffRGBA(merc.rgba, merc.width, merc.height, merc.bounds, { epsg: 3857 });
    const fname = name ? `SAR_Viewshed_${viewshedFilenameSlug(name)}_${ts}.tif` : `SAR_${label}_${ts}.tif`;
    downloadBlob(new Blob([buf], { type: 'image/tiff' }), fname);
  } catch (e) {
    console.error('GeoTIFF export error:', e);
    alert('Could not export ' + r.label + ' GeoTIFF: ' + (e && e.message || e));
  }
}

// One EPSG:3857 GeoTIFF per computed viewshed (filenames de-duped by slug).
function exportAllViewshedGeoTiffs() {
  const seen = {};
  (S.viewsheds || []).filter(r => r.grid && r.mask).forEach(rec => {
    let slug = viewshedFilenameSlug(rec.name);
    if (seen[slug]) { seen[slug]++; slug = slug + '_' + seen[slug]; } else { seen[slug] = 1; }
    // Pass a shallow record whose name carries the de-duped slug for the filename.
    exportRasterGeoTiff('viewshed', Object.assign({}, rec, { name: slug }));
  });
}

// Export a raster overlay as a KMZ GroundOverlay — the reliable way to load a
// georeferenced image into CalTopo (and Google Earth).
function exportRasterKmz(layerId, ref) {
  const ts = new Date().toISOString().split('T')[0];
  const r = _exportRasterData(layerId, ref);
  if (!r) return;
  try {
    const { grid, rgba, label, name } = r;
    const png = _rgbaToPngBytes(rgba, grid.cols, grid.rows);
    const title = name ? `SAR Viewshed ${name}` : `SAR ${label} — ${ts}`;
    const doc = groundOverlayKml(title, grid.bounds, 'overlay.png',
      { description: (name || label) + ' overlay exported from SAR Pre-Flight. Georeferenced (WGS84).' });
    const kmz = zipStore([
      { name: 'doc.kml', data: new TextEncoder().encode(doc) },
      { name: 'overlay.png', data: png },
    ]);
    const fname = name ? `SAR_Viewshed_${viewshedFilenameSlug(name)}_${ts}.kmz` : `SAR_${label}_${ts}.kmz`;
    downloadBlob(new Blob([kmz], { type: 'application/vnd.google-earth.kmz' }), fname);
  } catch (e) {
    console.error('KMZ overlay export error:', e);
    alert('Could not export ' + r.label + ' KMZ overlay: ' + (e && e.message || e));
  }
}

function exportAllViewshedKmz() {
  (S.viewsheds || []).filter(r => r.grid && r.mask).forEach(rec => exportRasterKmz('viewshed', rec.id));
}

function openExport() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  populateExportModal();
  document.getElementById('exportModal').classList.add('active');
}
function closeExport() { document.getElementById('exportModal').classList.remove('active'); }

function _setExportRasterRow(cbId, rowId, enabled, checkedDefault) {
  const cb = document.getElementById(cbId); const row = document.getElementById(rowId);
  if (cb) { cb.disabled = !enabled; cb.checked = enabled && checkedDefault !== false; }
  if (row) row.style.display = enabled ? '' : 'none';
}

// (Re)build the dynamic parts of the export modal: a checklist of currently-visible
// map layers (merged by label, with feature counts) and the raster GeoTIFF rows.
function populateExportModal() {
  const list = document.getElementById('exportLayerList');
  if (list) {
    const keys = (S.map && S.mapLayers) ? Object.keys(S.mapLayers).filter(k =>
      !EXPORT_SKIP_LAYERS.has(k) && S.mapLayers[k] &&
      (S.map.hasLayer(S.mapLayers[k]) || EXPORT_HIDDEN_OK.has(k))) : [];
    // Emergency LZ is a synthetic source (its map layer is intentionally empty).
    if (S.lzs && S.lzs.length && !keys.includes('emergency_lz')) keys.push('emergency_lz');
    keys.sort((a, b) => _aggMeta(a).pri - _aggMeta(b).pri);
    const byLabel = {}; const order = [];
    keys.forEach(k => {
      // Count features; emergency_lz comes from S.lzs, not the (empty) layer.
      let n;
      if (k === 'emergency_lz') n = _exportLZRecords().length;
      else { n = 0; eachPopupLayer(S.mapLayers[k], () => { n++; }); }
      if (!n) return;
      const label = _aggMeta(k).label || 'Other';
      if (!byLabel[label]) { byLabel[label] = { keys: [], count: 0 }; order.push(label); }
      byLabel[label].keys.push(k); byLabel[label].count += n;
    });
    if (!order.length) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">No visible map layers to export.</div>';
    } else {
      list.innerHTML = order.map(label => {
        const g = byLabel[label];
        return `<label class="export-check-row"><input type="checkbox" data-layer-key="${g.keys.join(',')}" checked> ${label} (${g.count})</label>`;
      }).join('');
    }
  }
  const canopyOk = !!(S.canopy && S.canopy.canopyFlat);
  const nViewsheds = (S.viewsheds || []).filter(r => r.grid && r.mask).length;
  // GeoTIFF (EPSG:3857) is the default — CalTopo Map Sheet import; KMZ overlay
  // (Google Earth) is opt-in.
  _setExportRasterRow('expCanopyTiff', 'expCanopyRow', canopyOk, true);
  _setExportRasterRow('expCanopyKmz', 'expCanopyKmzRow', canopyOk, false);
  _setExportRasterRow('expViewshedTiff', 'expViewshedRow', nViewsheds > 0, true);
  _setExportRasterRow('expViewshedKmz', 'expViewshedKmzRow', nViewsheds > 0, false);
  // Reflect the count in the row labels (one GeoTIFF per observer).
  const vt = document.getElementById('expViewshedTiffLabel');
  if (vt) vt.textContent = `Viewsheds (${nViewsheds}) → GeoTIFF, Web Mercator (CalTopo Map Sheet / QGIS)`;
  const vk = document.getElementById('expViewshedKmzLabel');
  if (vk) vk.textContent = `Viewsheds (${nViewsheds}) → KMZ overlay (Google Earth)`;
  // Low-poly vector polygons ride inside the KML/GeoJSON file itself.
  _setExportRasterRow('expViewshedVec', 'expViewshedVecRow', nViewsheds > 0, true);
  const vv = document.getElementById('expViewshedVecLabel');
  if (vv) vv.textContent = `Viewsheds (${nViewsheds}) → vector polygons (in the KML / GeoJSON file)`;
}

function doExport() {
  if (!S.areaCenter) return alert('Draw an operational area first.');
  try { Diag.note('export.kml.start'); } catch (_) {}
  const c = S.areaCenter;
  const ts = new Date().toISOString().split('T')[0];
  let folders = '';

  // 1. Operational area polygon
  if (document.getElementById('expOpsArea')?.checked) {
    folders += kmlFolder('Operational Area', kmlPolygonPlacemark({
      name: `${S.areaType} Search Area`, styleUrl: 'opsArea',
      description: `Center: ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}\nType: ${S.areaType}`,
      rings: [getKMLCoords()],
    }));
  }

  // 2. Text-summary placemarks (weather / terrain / ops etc.) at the area centre
  EXPORT_SUMMARY_SECTIONS.forEach(s => {
    if (!document.getElementById(s.id)?.checked) return;
    folders += kmlFolder(s.name, kmlPointPlacemark({ name: `${s.name} \u2014 ${ts}`, lat: c.lat, lng: c.lng, description: _exportSummaryDesc(s) }));
  });

  // 3. Every currently-visible map overlay as real geometry
  folders += gatherVisibleLayerFolders(_exportSelectedLayerKeys());

  // 3b. Low-poly vector polygons of each computed viewshed
  if (document.getElementById('expViewshedVec')?.checked) {
    const vrecs = _exportViewshedPolygonRecords();
    if (vrecs.length) folders += kmlFolder('Viewshed Polygons', vrecs.map(recordToKml).join(''),
      { description: 'Simplified vector outlines of each observer viewshed. Low-poly by design — the GeoTIFF/KMZ raster export is authoritative.' });
  }

  // 4. Hourly sun + wind bearing lines
  folders += buildSunWindFolders();

  const kml = kmlDocument(`SAR Preflight Intel \u2014 ${ts}`, kmlStyles(), folders, EXPORT_DISCLAIMER);
  downloadBlob(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }), `SAR_Preflight_${ts}.kml`);

  // 5. Canopy raster + one raster per observer viewshed (GeoTIFF for CalTopo, KMZ for Google Earth)
  if (document.getElementById('expCanopyKmz')?.checked) exportRasterKmz('canopy');
  if (document.getElementById('expCanopyTiff')?.checked) exportRasterGeoTiff('canopy');
  if (document.getElementById('expViewshedKmz')?.checked) exportAllViewshedKmz();
  if (document.getElementById('expViewshedTiff')?.checked) exportAllViewshedGeoTiffs();

  closeExport();
}

// Export the same vector content as CalTopo-native GeoJSON, which preserves the
// folder hierarchy on import (KML does not — CalTopo flattens it by geometry type).
// Rasters can't live in GeoJSON, so canopy/viewshed still export as GeoTIFF/KMZ.
// The hourly sun/wind bearing lines are KML-only (they rely on KML time animation).
function doExportGeoJson() {
  if (!S.areaCenter) return alert('Draw an operational area first.');
  const c = S.areaCenter;
  const ts = new Date().toISOString().split('T')[0];
  const features = [];

  // 1. Operational area polygon (own folder)
  if (document.getElementById('expOpsArea')?.checked) {
    const fid = _uuid();
    features.push(geojsonFolderFeature(fid, 'Operational Area'));
    features.push(geojsonShapeFeature(_uuid(), fid, {
      name: `${S.areaType} Search Area`, styleId: 'opsArea',
      description: `Center: ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}\nType: ${S.areaType}`,
      geometry: geojsonPolygonGeometry([_areaRingLatLng()]),
    }));
  }

  // 2. Data-summary markers at the area centre, grouped under one "Info" folder.
  const infoMarkers = EXPORT_SUMMARY_SECTIONS.filter(s => document.getElementById(s.id)?.checked);
  if (infoMarkers.length) {
    const fid = _uuid();
    features.push(geojsonFolderFeature(fid, 'Info'));
    infoMarkers.forEach(s => features.push(geojsonMarkerFeature(_uuid(), fid, {
      name: `${s.name} — ${ts}`, description: _exportSummaryDesc(s), lat: c.lat, lng: c.lng, styleId: 'generic',
    })));
  }

  // 3. Every currently-visible map overlay as real geometry, one folder per layer.
  folderGroupsToGeoJsonFeatures(collectExportFolderGroups(_exportSelectedLayerKeys()), _uuid)
    .forEach(f => features.push(f));

  // 3b. Low-poly vector polygons of each computed viewshed (own folder).
  if (document.getElementById('expViewshedVec')?.checked) {
    const vrecs = _exportViewshedPolygonRecords();
    if (vrecs.length) {
      const fid = _uuid();
      features.push(geojsonFolderFeature(fid, 'Viewshed Polygons'));
      vrecs.forEach(r => { const f = recordToGeoJsonFeature(r, fid, _uuid()); if (f) features.push(f); });
    }
  }

  const fc = geojsonFeatureCollection(features);
  downloadBlob(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `SAR_Preflight_${ts}.geojson`);

  // 4. Canopy + viewshed rasters (GeoTIFF for CalTopo Map Sheet, KMZ for Google Earth) — same as KML.
  if (document.getElementById('expCanopyKmz')?.checked) exportRasterKmz('canopy');
  if (document.getElementById('expCanopyTiff')?.checked) exportRasterGeoTiff('canopy');
  if (document.getElementById('expViewshedKmz')?.checked) exportAllViewshedKmz();
  if (document.getElementById('expViewshedTiff')?.checked) exportAllViewshedGeoTiffs();

  closeExport();
}

function getKMLCoords() {
  const coords = [];
  if (S.areaType === 'CIRCLE') {
    const c = S.areaCenter, r = S.currentArea.getRadius();
    for (let i = 0; i <= 36; i++) {
      const a = (i*10)*Math.PI/180;
      coords.push(`${(c.lng + (r/(111320*Math.cos(c.lat*Math.PI/180)))*Math.sin(a)).toFixed(6)},${(c.lat + (r/111320)*Math.cos(a)).toFixed(6)},0`);
    }
  } else {
    const ll = S.areaType === 'RECTANGLE'
      ? [S.areaBounds.getNorthWest(), S.areaBounds.getNorthEast(), S.areaBounds.getSouthEast(), S.areaBounds.getSouthWest()]
      : S.currentArea.getLatLngs()[0];
    ll.forEach(p => coords.push(`${p.lng.toFixed(6)},${p.lat.toFixed(6)},0`));
    coords.push(coords[0]);
  }
  return coords.join(' ');
}

// ============================================================
// TAB SCROLLING
// ============================================================
function scrollTabs(dir) {
  const nav = document.getElementById('tabNav');
  nav.scrollBy({ left: dir * 120, behavior: 'smooth' });
}
function updateScrollBtns() {
  const nav = document.getElementById('tabNav');
  document.getElementById('tabScrollLeft').classList.toggle('hidden', nav.scrollLeft < 5);
  document.getElementById('tabScrollRight').classList.toggle('hidden', nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 5);
}

// ============================================================
// UI CONTROLS
// ============================================================
function toggleHeaderMenu() {
  document.getElementById('headerActions')?.classList.toggle('open');
}
function toggleLayerControl() {
  const el = document.getElementById('layerControl');
  if (el) el.classList.toggle('collapsed');
}
function toggleDrawToolbar() {
  const el = document.getElementById('drawToolbar');
  if (el) el.classList.toggle('collapsed');
}
function togglePanel() {
  S.panelOpen = !S.panelOpen;
  document.getElementById('sidePanel').classList.toggle('collapsed');
  document.getElementById('btnPanel').classList.toggle('active');
  // Close hamburger menu when toggling panel
  document.getElementById('headerActions')?.classList.remove('open');
  setTimeout(() => { S.map.invalidateSize(); if (S.map3d) S.map3d.resize(); }, 350);
}
function switchTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) panel.style.display = '';
  if (!S.currentArea) document.getElementById('noAreaState').style.display = '';
  else document.getElementById('noAreaState').style.display = 'none';
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  if (tab === 'notams' && typeof renderAutoCheckStatus === 'function') renderAutoCheckStatus();
}

// Helpers for the layer-control rows added below (used by the newer overlays).
function _layerHasFeatures(id) {
  const g = S.mapLayers[id];
  return !!(g && g.getLayers && g.getLayers().length > 0);
}
function _layerRow(id, color, label) {
  const g = S.mapLayers[id];
  const on = g && S.map.hasLayer(g);
  const count = (g && g.getLayers) ? g.getLayers().length : null;
  const txt = (count != null && count > 0) ? `${label} (${count})` : label;
  return `<div class="layer-item${on ? ' active' : ''}" data-layer="${id}" onclick="toggleLayer('${id}',this)">
    <div class="layer-check"></div><div class="layer-color" style="background:${color}"></div><span>${txt}</span>
  </div>`;
}

// --- Collapsible layer-control sections ---
// Each generated category is <h4 data-section="key"> + a wrapping body div, so a
// tap on the header hides just that category's rows. buildLayerControl runs after
// virtually every fetch, so the collapsed set lives on S (not in the DOM) to
// survive those rebuilds; _persistLayerUiState mirrors it to localStorage.
function _sectionOpen(key, title) {
  const c = S.layerSections && S.layerSections.has(key) ? ' collapsed' : '';
  return `<h4 class="layer-section${c}" style="margin-top:10px" data-section="${key}" onclick="toggleLayerSection('${key}')">${title}</h4>`
    + `<div class="layer-section-body${c}" data-section-body="${key}">`;
}
function _sectionClose() { return '</div>'; }

function toggleLayerSection(key) {
  if (!S.layerSections) S.layerSections = new Set();
  if (S.layerSections.has(key)) S.layerSections.delete(key);
  else S.layerSections.add(key);
  // Toggle in place rather than rebuilding — no flicker, and no layer re-render.
  document.querySelector(`#layerList [data-section="${key}"]`)?.classList.toggle('collapsed');
  document.querySelector(`#layerList [data-section-body="${key}"]`)?.classList.toggle('collapsed');
  _persistLayerUiState();
}

// ' · frame 22:40Z (2h 05m old)' suffix for the GOES layer row, '' until known.
function _goesFrameLabel() {
  if (!S.goesFrameTime) return '';
  const t = new Date(S.goesFrameTime);
  if (isNaN(t)) return '';
  const ageMin = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
  const age = ageMin >= 60 ? `${Math.floor(ageMin / 60)}h ${String(ageMin % 60).padStart(2, '0')}m` : `${ageMin}m`;
  const hhmm = t.toISOString().slice(11, 16);
  return ` <span style="opacity:0.65;font-size:10px;">· frame ${hhmm}Z (${age} old)</span>`;
}

function buildLayerControl() {
  // PLANS mode suppresses operational clutter as it arrives — do it before the
  // rows are emitted so the panel reflects the post-suppression truth.
  _applyPlansMode();
  const baseLayers = [
    { id: 'satellite', name: 'Satellite', color: '#3d8bfd' },
    { id: 'topo', name: 'Topographic', color: '#22c55e' },
    { id: 'sectional', name: 'FAA Sectional', color: '#f59e0b' },
  ];
  let html = baseLayers.map(l =>
    `<div class="layer-item${S.map.hasLayer(S.mapLayers[l.id]) ? ' active' : ''}" data-layer="${l.id}" onclick="toggleLayer('${l.id}',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:${l.color}"></div><span>${l.name}</span>
    </div>`
  ).join('');
  // Streets/labels overlay — independent of the mutually-exclusive base group,
  // so it can drape over satellite (or any base). Raw row (not _layerRow) to
  // avoid the misleading "(2)" LayerGroup count.
  if (S.mapLayers.streets) {
    const streetsOn = S.map.hasLayer(S.mapLayers.streets);
    html += `<div class="layer-item${streetsOn ? ' active' : ''}" data-layer="streets" onclick="toggleLayer('streets',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#e5e7eb"></div><span>Streets / Labels</span>
    </div>`;
  }

  // Radar overlay
  if (S.radarAnim && S.radarAnim.layers && S.radarAnim.layers.length > 0) {
    html += _sectionOpen('radar', 'Radar');
    const radarOn = S.radarAnim.layers.some(l => S.map.hasLayer(l) && l.options.opacity > 0);
    html += `<div class="layer-item${radarOn ? ' active' : ''}" data-layer="radar" onclick="toggleLayer('radar',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#22c55e"></div><span>Weather Radar</span>
    </div>`;
    html += _sectionClose();
  }

  // Weather Imagery (optional near-real-time global rasters): GOES-East GeoColor clouds
  // + NOAA lightning strike density. Both built lazily so their toggles are always available.
  {
    ensureGoesLayer(); ensureGlmLayer();
    if (S.mapLayers.goes_clouds || S.mapLayers.glm_lightning) {
      html += _sectionOpen('wximagery', 'Weather Imagery');
      if (S.mapLayers.goes_clouds) {
        const on = S.map.hasLayer(S.mapLayers.goes_clouds);
        html += `<div class="layer-item${on ? ' active' : ''}" data-layer="goes_clouds" onclick="toggleLayer('goes_clouds',this)">
          <div class="layer-check"></div><div class="layer-color" style="background:#93c5fd"></div><span>GOES Clouds (GeoColor)${_goesFrameLabel()}</span>
        </div>`;
      }
      if (S.mapLayers.glm_lightning) {
        const on = S.map.hasLayer(S.mapLayers.glm_lightning);
        html += `<div class="layer-item${on ? ' active' : ''}" data-layer="glm_lightning" onclick="toggleLayer('glm_lightning',this)">
          <div class="layer-check"></div><div class="layer-color" style="background:#fde047"></div><span>Lightning strike density (NOAA)</span>
        </div>`;
      }
      html += _sectionClose();
    }
  }

  // Facilities section: airports + cell towers + emergency LZs
  const hasAirports = S.mapLayers.airports && S.mapLayers.airports.getLayers().length > 0;
  const hasTowers = S.mapLayers.cell_towers && S.mapLayers.cell_towers.getLayers().length > 0;
  const hasLZs = S.mapLayers.emergency_lz && S.mapLayers.emergency_lz.getLayers().length > 0;
  if (hasAirports || hasTowers || hasLZs || _layerHasFeatures('hospitals')) {
    html += _sectionOpen('facilities', 'Facilities');
    if (hasAirports) {
      const airportCount = S.mapLayers.airports.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.airports);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="airports" onclick="toggleLayer('airports',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>Airports (${airportCount})</span>
      </div>`;
    }
    if (hasTowers) {
      const towerCount = S.mapLayers.cell_towers.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.cell_towers);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="cell_towers" onclick="toggleLayer('cell_towers',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#00CCFF"></div><span>Towers (${towerCount})</span>
      </div>`;
    }
    if (_layerHasFeatures('hospitals')) html += _layerRow('hospitals', '#ef4444', 'Hospitals / LZs');
    if (_layerHasFeatures('buildings')) html += _layerRow('buildings', '#9ca3af', 'Buildings (OSM, 3D)');
    // LZ markers removed — elevation grid too coarse for reliable LZ placement.
    // Terrain tab shows suitability assessment instead.
    html += _sectionClose();
  }

  // ADS-B Traffic
  const hasAdsbAc = S.mapLayers.adsb_aircraft && S.mapLayers.adsb_aircraft.getLayers().length > 0;
  const hasAdsbTrails = S.mapLayers.adsb_trails && S.mapLayers.adsb_trails.getLayers().length > 0;
  if (hasAdsbAc || hasAdsbTrails) {
    html += _sectionOpen('traffic', 'Traffic');
    if (hasAdsbAc) {
      const acCount = S.mapLayers.adsb_aircraft.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.adsb_aircraft);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="adsb_aircraft" onclick="toggleLayer('adsb_aircraft',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#a78bfa"></div><span>Aircraft (${acCount})</span>
      </div>`;
    }
    if (hasAdsbTrails) {
      const on = S.map.hasLayer(S.mapLayers.adsb_trails);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="adsb_trails" onclick="toggleLayer('adsb_trails',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#3d8bfd"></div><span>Position Trails</span>
      </div>`;
    }
    html += _sectionClose();
  }

  // Ops overlays: swap radius
  const hasSwap = S.mapLayers.swap_radius && S.mapLayers.swap_radius.getLayers().length > 0;
  if (hasSwap) {
    html += _sectionOpen('operations', 'Operations');
    const on = S.map.hasLayer(S.mapLayers.swap_radius);
    html += `<div class="layer-item${on ? ' active' : ''}" data-layer="swap_radius" onclick="toggleLayer('swap_radius',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>Swap Radius</span>
    </div>`;
    html += _sectionClose();
  }

  // NWS Alerts section
  if (S.nwsAlerts.length > 0 && S.mapLayers.nws_alerts) {
    html += _sectionOpen('alerts', 'Alerts');
    const on = S.map.hasLayer(S.mapLayers.nws_alerts);
    html += `<div class="layer-item${on ? ' active' : ''}" data-layer="nws_alerts" onclick="toggleLayer('nws_alerts',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>NWS Alerts (${S.nwsAlerts.length})</span>
    </div>`;
    html += _sectionClose();
  }

  // Active Fires section
  const hasFirePerimeters = S.mapLayers.fire_perimeters && S.mapLayers.fire_perimeters.getLayers && S.mapLayers.fire_perimeters.getLayers().length > 0;
  if (hasFirePerimeters) {
    html += _sectionOpen('fire', 'Fire');
    const on = S.map.hasLayer(S.mapLayers.fire_perimeters);
    html += `<div class="layer-item${on ? ' active' : ''}" data-layer="fire_perimeters" onclick="toggleLayer('fire_perimeters',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#f97316"></div><span>Fire Perimeters (${S.mapLayers.fire_perimeters.getLayers().length})</span>
    </div>`;
    html += _sectionClose();
  }

  // Smoke (NOAA HMS) section
  if (_layerHasFeatures('hms_smoke')) {
    html += _sectionOpen('smoke', 'Smoke');
    html += _layerRow('hms_smoke', '#ea580c', 'HMS Smoke Plumes');
    html += _sectionClose();
  }

  // FAA Airspace section
  const hasFAAclass = S.mapLayers.faa_class_airspace && S.mapLayers.faa_class_airspace.getLayers && S.mapLayers.faa_class_airspace.getLayers().length > 0;
  const hasFAAsua = S.mapLayers.faa_sua && S.mapLayers.faa_sua.getLayers && S.mapLayers.faa_sua.getLayers().length > 0;
  const hasFAAtfr = S.mapLayers.faa_tfr && S.mapLayers.faa_tfr.getLayers && S.mapLayers.faa_tfr.getLayers().length > 0;
  const hasFAAlaanc = S.mapLayers.faa_laanc && S.mapLayers.faa_laanc.getLayers && S.mapLayers.faa_laanc.getLayers().length > 0;
  const hasFAAns = S.mapLayers.faa_ns_restrictions && S.mapLayers.faa_ns_restrictions.getLayers && S.mapLayers.faa_ns_restrictions.getLayers().length > 0;
  const hasFAAprohibited = S.mapLayers.faa_prohibited && S.mapLayers.faa_prohibited.getLayers && S.mapLayers.faa_prohibited.getLayers().length > 0;
  if (hasFAAclass || hasFAAsua || hasFAAtfr || hasFAAlaanc || hasFAAns || hasFAAprohibited) {
    html += _sectionOpen('faa_airspace', 'FAA Airspace');
    if (hasFAAclass) {
      const on = S.map.hasLayer(S.mapLayers.faa_class_airspace);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_class_airspace" onclick="toggleLayer('faa_class_airspace',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#3d8bfd"></div><span>Class Airspace</span>
      </div>`;
    }
    if (hasFAAsua) {
      const on = S.map.hasLayer(S.mapLayers.faa_sua);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_sua" onclick="toggleLayer('faa_sua',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>Special Use</span>
      </div>`;
    }
    if (hasFAAtfr) {
      const on = S.map.hasLayer(S.mapLayers.faa_tfr);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_tfr" onclick="toggleLayer('faa_tfr',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>TFRs</span>
      </div>`;
    }
    if (hasFAAlaanc) {
      const on = S.map.hasLayer(S.mapLayers.faa_laanc);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_laanc" onclick="toggleLayer('faa_laanc',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#22c55e"></div><span>LAANC Grid</span>
      </div>`;
    }
    if (hasFAAns) {
      const on = S.map.hasLayer(S.mapLayers.faa_ns_restrictions);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_ns_restrictions" onclick="toggleLayer('faa_ns_restrictions',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#dd1133"></div><span>National Security</span>
      </div>`;
    }
    if (hasFAAprohibited) {
      const on = S.map.hasLayer(S.mapLayers.faa_prohibited);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_prohibited" onclick="toggleLayer('faa_prohibited',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#991b1b"></div><span>Prohibited Areas</span>
      </div>`;
    }
    html += _sectionClose();
  }

  // Imported TFR / NOTAM section
  const hasImpTfr = S.mapLayers.tfr_imported && S.mapLayers.tfr_imported.getLayers && S.mapLayers.tfr_imported.getLayers().length > 0;
  const hasImpNotam = S.mapLayers.notam_imported && S.mapLayers.notam_imported.getLayers && S.mapLayers.notam_imported.getLayers().length > 0;
  if (hasImpTfr || hasImpNotam) {
    html += _sectionOpen('imported_restrictions', 'Imported TFR/NOTAM');
    if (hasImpTfr) {
      const on = S.map.hasLayer(S.mapLayers.tfr_imported);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="tfr_imported" onclick="toggleLayer('tfr_imported',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>TFRs (${S.mapLayers.tfr_imported.getLayers().length})</span>
      </div>`;
    }
    if (hasImpNotam) {
      const on = S.map.hasLayer(S.mapLayers.notam_imported);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="notam_imported" onclick="toggleLayer('notam_imported',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#f59e0b"></div><span>NOTAMs (${S.mapLayers.notam_imported.getLayers().length})</span>
      </div>`;
    }
    html += _sectionClose();
  }

  // Protected Areas section
  const hasDams = S.mapLayers.dams && S.mapLayers.dams.getLayers && S.mapLayers.dams.getLayers().length > 0;
  const hasWilderness = S.mapLayers.wilderness && S.mapLayers.wilderness.getLayers && S.mapLayers.wilderness.getLayers().length > 0;
  const hasNatlParks = S.mapLayers.national_parks && S.mapLayers.national_parks.getLayers && S.mapLayers.national_parks.getLayers().length > 0;
  if (hasDams || hasWilderness || hasNatlParks) {
    html += _sectionOpen('protected', 'Protected Areas');
    if (hasDams) {
      const count = S.mapLayers.dams.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.dams);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="dams" onclick="toggleLayer('dams',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>Dams (${count})</span>
      </div>`;
    }
    if (hasWilderness) {
      const count = S.mapLayers.wilderness.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.wilderness);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="wilderness" onclick="toggleLayer('wilderness',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#166534"></div><span>Wilderness Areas (${count})</span>
      </div>`;
    }
    if (hasNatlParks) {
      const count = S.mapLayers.national_parks.getLayers().length;
      const on = S.map.hasLayer(S.mapLayers.national_parks);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="national_parks" onclick="toggleLayer('national_parks',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#78350f"></div><span>National Parks (${count})</span>
      </div>`;
    }
    html += _sectionClose();
  }

  // FAA Obstacles (Digital Obstacle File) section
  const hasObstacles = S.mapLayers.faa_obstacles && S.mapLayers.faa_obstacles.getLayers && S.mapLayers.faa_obstacles.getLayers().length > 0;
  if (hasObstacles) {
    const count = S.mapLayers.faa_obstacles.getLayers().length;
    const on = S.map.hasLayer(S.mapLayers.faa_obstacles);
    html += _sectionOpen('obstacles', 'FAA Obstacles (DOF)');
    html += `<div class="layer-item${on ? ' active' : ''}" data-layer="faa_obstacles" onclick="toggleLayer('faa_obstacles',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#ef4444"></div><span>Obstacles (${count})</span>
    </div>`;
    html += _sectionClose();
  }

  const wireCounts = Object.assign({}, S.wireHazardCounts, S.utilityWireCounts);
  const totalWires = Object.values(wireCounts).reduce((a, b) => a + b, 0);
  if (totalWires > 0) {
    html += _sectionOpen('wires', 'Wire Hazards');
    Object.entries(WIRE_CATEGORIES).forEach(([k, info]) => {
      const count = wireCounts[k] || 0;
      if (count === 0) return;
      const lid = 'wire_' + k;
      const on = S.map.hasLayer(S.mapLayers[lid]);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="${lid}" onclick="toggleLayer('${lid}',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:${info.color}"></div><span>${info.label} (${count})</span>
      </div>`;
    });
    html += _sectionClose();
  }
  // Ground Access section: forest roads/trails, MVUM, BLM routes
  if (_layerHasFeatures('usfs_roads') || _layerHasFeatures('usfs_trails') || _layerHasFeatures('mvum_roads') || _layerHasFeatures('mvum_trails') || _layerHasFeatures('blm_gtlf') || _layerHasFeatures('trails')) {
    html += _sectionOpen('ground_access', 'Ground Access');
    if (_layerHasFeatures('usfs_roads')) html += _layerRow('usfs_roads', '#c98a3a', 'NFS Roads');
    if (_layerHasFeatures('usfs_trails')) html += _layerRow('usfs_trails', '#8b5a2b', 'NFS Trails');
    if (_layerHasFeatures('mvum_roads')) html += _layerRow('mvum_roads', '#e0a458', 'MVUM Roads');
    if (_layerHasFeatures('mvum_trails')) html += _layerRow('mvum_trails', '#c97f3a', 'MVUM Trails');
    if (_layerHasFeatures('blm_gtlf')) html += _layerRow('blm_gtlf', '#84cc16', 'BLM Routes');
    if (_layerHasFeatures('trails')) html += _layerRow('trails', TRAILS_COLOR, 'Named Trails (OSM)');
    html += _sectionClose();
  }

  // Public Lands (surface management agency) + Water
  if (_layerHasFeatures('public_lands')) {
    html += _sectionOpen('public_lands', 'Public Lands');
    html += _layerRow('public_lands', '#2e8b3d', 'Land Ownership');
    html += _sectionClose();
  }
  if (_layerHasFeatures('nhd_water')) {
    html += _sectionOpen('water', 'Water');
    html += _layerRow('nhd_water', '#3b82f6', 'Streams & Lakes');
    html += _sectionClose();
  }

  // Cell Coverage (per-carrier FCC LTE)
  if (_layerHasFeatures('cell_att') || _layerHasFeatures('cell_tmobile') || _layerHasFeatures('cell_verizon')) {
    html += _sectionOpen('cell_coverage', 'Cell Coverage (FCC LTE)');
    if (_layerHasFeatures('cell_att')) html += _layerRow('cell_att', '#2563eb', 'AT&T');
    if (_layerHasFeatures('cell_tmobile')) html += _layerRow('cell_tmobile', '#e6007e', 'T-Mobile');
    if (_layerHasFeatures('cell_verizon')) html += _layerRow('cell_verizon', '#cd040b', 'Verizon');
    html += _sectionClose();
  }

  // Reference overlays (parcels)
  if (S.mapLayers.parcels) {
    html += _sectionOpen('reference', 'Reference');
    html += _layerRow('parcels', '#9ca3af', 'Parcels');
    html += _sectionClose();
  }

  // Imported FAA charts section
  const chartIds = Object.keys(S.faaCharts || {});
  if (chartIds.length > 0) {
    html += _sectionOpen('charts', 'Imported Charts');
    for (const cid of chartIds) {
      const c = S.faaCharts[cid];
      const lid = 'chart_' + cid;
      const on = S.map.hasLayer(c.layer);
      html += `<div class="layer-item${on ? ' active' : ''}" data-layer="${lid}" onclick="toggleLayer('${lid}',this)">
        <div class="layer-check"></div><div class="layer-color" style="background:#e879f9"></div><span>${c.chartName}</span>
      </div>`;
    }
    html += _sectionClose();
  }

  // Terrain hillshade (always available — a global tile overlay)
  if (S.mapLayers.slope) {
    html += _sectionOpen('terrain', 'Terrain');
    html += _layerRow('slope', '#9ca3af', 'Hillshade (steepness)');
    html += _sectionClose();
  }

  // Analysis overlays. Vegetation height + sun shadow are ALWAYS listed (like
  // Hillshade / Snow Depth): checking a row is what loads them, so the row can
  // never be gated on the overlay already being displayed. Observers/viewshed
  // still appear only once they exist.
  const hasCanopy = !!(S.mapLayers.canopy && S.map.hasLayer(S.mapLayers.canopy));
  const hasViewshed = !!(S.mapLayers.viewshed && S.map.hasLayer(S.mapLayers.viewshed));
  const hasShadow = !!(S.mapLayers.shadow && S.map.hasLayer(S.mapLayers.shadow));
  const hasObservers = !!(S.mapLayers.observers && (S.viewsheds || []).length);
  // Inline slider under a checked raster row; its twin lives in the Terrain tab
  // and setCanopyOpacity/setShadowOpacity/setViewshedOpacity keep the two in step.
  const _overlayOpacity = (id, fallback) => {
    const o = S.mapLayers[id] && S.mapLayers[id].options.opacity;
    return o != null ? o : fallback;
  };
  const _opacityRow = (id, fn, op) =>
    `<div style="display:flex;align-items:center;gap:6px;margin:2px 0 4px 22px;">
      <input type="range" id="lc${id}Opacity" min="0" max="1" step="0.05" value="${op}" style="width:90px;" oninput="${fn}(this.value)" onclick="event.stopPropagation()">
      <span style="font-size:9px;color:var(--text-muted);">opacity</span>
    </div>`;
  html += _sectionOpen('analysis', 'Analysis');
  if (hasObservers) {
    const on = S.map.hasLayer(S.mapLayers.observers);
    html += `<div class="layer-item${on ? ' active' : ''}" data-layer="observers" onclick="toggleLayer('observers',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#5ec522"></div><span>Observers (${S.viewsheds.length})</span>
    </div>`;
  }
  html += `<div class="layer-item${hasCanopy ? ' active' : ''}" data-layer="canopy" onclick="toggleLayer('canopy',this)">
    <div class="layer-check"></div><div class="layer-color" style="background:#0d5e28"></div><span>Vegetation Height</span>
  </div>`;
  if (hasCanopy) html += _opacityRow('Canopy', 'setCanopyOpacity', _overlayOpacity('canopy', CANOPY_OVERLAY_OPACITY));
  if (hasViewshed) {
    html += `<div class="layer-item active" data-layer="viewshed" onclick="toggleLayer('viewshed',this)">
      <div class="layer-check"></div><div class="layer-color" style="background:#22c55e"></div><span>Viewshed</span>
    </div>`;
    html += _opacityRow('Viewshed', 'setViewshedOpacity', _overlayOpacity('viewshed', VIEWSHED_OVERLAY_OPACITY));
  }
  html += `<div class="layer-item${hasShadow ? ' active' : ''}" data-layer="shadow" onclick="toggleLayer('shadow',this)">
    <div class="layer-check"></div><div class="layer-color" style="background:#0b1220;border:1px solid #475569"></div><span>Sun Shadow</span>
  </div>`;
  if (hasShadow) html += _opacityRow('Shadow', 'setShadowOpacity', _overlayOpacity('shadow', SHADOW_OVERLAY_OPACITY));
  html += _sectionClose();

  // Winter Ops (optional): avalanche danger zones + SNODAS snow depth. Snow depth is a
  // CONUS-wide WMS overlay (NOHRSC analysis domain, not clipped to the drawn area) built lazily so its toggle is always available; avalanche rows
  // appear once zones near the area have been fetched. Both are off by default.
  {
    ensureSnowLayer();
    const hasAval = _layerHasFeatures('avalanche');
    const hasSnow = !!S.mapLayers.snow_depth;
    if (hasAval || hasSnow) {
      html += _sectionOpen('winter', 'Winter Ops');
      if (hasAval) html += _layerRow('avalanche', '#ef4444', 'Avalanche Danger');
      if (hasSnow) {
        const on = S.map.hasLayer(S.mapLayers.snow_depth);
        html += `<div class="layer-item${on ? ' active' : ''}" data-layer="snow_depth" onclick="toggleLayer('snow_depth',this)">
          <div class="layer-check"></div><div class="layer-color" style="background:#38bdf8"></div><span>Snow Depth (SNODAS)</span>
        </div>`;
      }
      html += _sectionClose();
    }
  }

  document.getElementById('layerList').innerHTML = html;
  // buildLayerControl runs after virtually every layer (re)render, so use it as
  // the chokepoint to (re)wire feature clicks into the aggregated popup system.
  wirePopupAggregation();
  // Same chokepoint keeps the 3D view's mirrored vectors current as data loads.
  if (S.is3D && typeof sync3d === 'function') sync3d();
}
function toggleLayer(id, el) {
  // Canopy edit mode pins the satellite base + edit canvas — ignore toggles that would fight it.
  if (S._canopyEditing && ['satellite', 'topo', 'sectional', 'canopy'].includes(id)) return;
  el.classList.toggle('active');
  const on = el.classList.contains('active');
  _notePlansOverride(id, on); // only the click path counts as user intent
  setLayerVisible(id, on);
}
// The layer-visibility logic itself, callable without a DOM row (PLANS mode).
function setLayerVisible(id, on) {
  const overlayIds = ['satellite', 'topo', 'sectional'];
  if (overlayIds.includes(id)) {
    if (on) {
      S.mapLayers[id].addTo(S.map);
      // Turn off other base overlays (mutually exclusive)
      overlayIds.filter(x => x !== id).forEach(x => {
        if (S.map.hasLayer(S.mapLayers[x])) S.map.removeLayer(S.mapLayers[x]);
        document.querySelector(`[data-layer="${x}"]`)?.classList.remove('active');
      });
    } else {
      S.map.removeLayer(S.mapLayers[id]);
    }
  } else if (id === 'radar') {
    // Toggle radar frame + its play panel together
    if (S.radarAnim && S.radarAnim.layers) {
      const layer = S.radarAnim.layers[S.radarAnim.index];
      if (on) { if (!S.map.hasLayer(layer)) layer.addTo(S.map); layer.setOpacity(0.5); }
      else {
        if (S.map.hasLayer(layer)) layer.setOpacity(0);
        // Stop playback so hidden frames don't cycle back into view
        if (S.radarAnim.playing) {
          clearInterval(S.radarAnim.interval);
          S.radarAnim.interval = null;
          S.radarAnim.playing = false;
          const btn = document.getElementById('radarPlayBtn');
          if (btn) btn.innerHTML = '&#9654;';
        }
      }
    }
    // Play panel is visible only while the radar layer is checked on
    const controls = document.getElementById('radarControls');
    if (controls) controls.style.display = on ? 'flex' : 'none';
  } else if (id === 'snow_depth') {
    const layer = ensureSnowLayer();
    if (layer) { if (on) S.map.addLayer(layer); else S.map.removeLayer(layer); }
  } else if (id === 'goes_clouds') {
    const layer = ensureGoesLayer();
    if (layer) { if (on) { S.map.addLayer(layer); refreshGoesFrameTime(); } else S.map.removeLayer(layer); } // no TIME param — GIBS serves its latest frame; label shows frame age
  } else if (id === 'glm_lightning') {
    const layer = ensureGlmLayer();
    if (layer) { if (on) S.map.addLayer(layer); else S.map.removeLayer(layer); }
  } else if (id === 'canopy' || id === 'shadow') {
    // These two OWN their fetch: checking the row must load the raster, not just
    // re-attach a layer that may not exist yet. Both re-run buildLayerControl.
    if (id === 'canopy') toggleCanopyOverlay(on);
    else toggleShadowOverlay(on);
    return; // their own paths handle _overlayWanted + the 3D mirror
  } else if (id === 'parcels') {
    // Live vector parcels: view-driven fetch while on (moveend hook), abort +
    // chip teardown when off. Zoom gate + tiering live in loadParcelsForView.
    S._parcelsWanted = on;
    if (on) {
      S.map.addLayer(S.mapLayers.parcels);
      maybeShowParcelDisclaimer();
      loadParcelsForView();
    } else {
      S.map.removeLayer(S.mapLayers.parcels);
      if (S._parcelAbort) { try { S._parcelAbort.abort(); } catch (_) {} }
      _setParcelChip(null);
    }
  } else if ((id === 'airports' || id === 'nws_alerts' || id === 'cell_towers' || id === 'fire_perimeters' || id === 'emergency_lz' || id === 'swap_radius' || id === 'dams' || id === 'wilderness' || id === 'national_parks' || id === 'adsb_aircraft' || id === 'adsb_trails' || id === 'viewshed' || id === 'observers' || id === 'public_lands' || id === 'nhd_water' || id === 'hospitals' || id === 'slope' || id === 'streets' || id === 'trails' || id === 'hms_smoke' || id === 'avalanche' || id.startsWith('wire_') || id.startsWith('faa_') || id.startsWith('chart_') || id.startsWith('tfr_') || id.startsWith('notam_') || id.startsWith('usfs_') || id.startsWith('mvum_') || id.startsWith('blm_') || id.startsWith('cell_')) && S.mapLayers[id]) {
    if (id === 'viewshed') {
      // Keep the zoom-cap's "wanted" flag in sync — otherwise _applyOverlayZoomCap
      // re-adds the overlay on the next zoomend after it was unchecked here.
      if (!S._overlayWanted) S._overlayWanted = {};
      S._overlayWanted[id] = on;
    }
    if (on) {
      // Raster overlays go through the zoom cap so the mobile display-size budget still applies
      if (id === 'viewshed') _applyOverlayZoomCap();
      else S.map.addLayer(S.mapLayers[id]);
    } else S.map.removeLayer(S.mapLayers[id]);
    // Observer markers and their VLOS range rings are one logical layer.
    if (id === 'observers' && S.mapLayers.observer_rings) {
      if (on) S.map.addLayer(S.mapLayers.observer_rings);
      else S.map.removeLayer(S.mapLayers.observer_rings);
    }
    // Toggling aircraft also toggles trails
    if (id === 'adsb_aircraft' && S.mapLayers.adsb_trails) {
      if (on) S.map.addLayer(S.mapLayers.adsb_trails);
      else S.map.removeLayer(S.mapLayers.adsb_trails);
      const trailEl = document.querySelector('[data-layer="adsb_trails"]');
      if (trailEl) { if (on) trailEl.classList.add('active'); else trailEl.classList.remove('active'); }
    }
  }
  // Mirror raster layer changes into the 3D view while it is active.
  if (S.is3D && typeof sync3d === 'function') sync3d();
}

// ============================================================
// PLANS MODE — pre-mission declutter
// Turns off (and collapses) the live-operational categories so the map shows
// planning data only. Sticky, because these layers re-add THEMSELVES: fetchRadar
// drapes a brand-new frame at 0.5 opacity on every auto-refresh, and
// computeOpsData re-attaches the swap radius whenever it recomputes. So the
// suppression re-runs at every buildLayerControl rather than once per layer —
// what makes it not fight the user is _plansUserOverride, the set of layers the
// user has deliberately switched back on by clicking their row.
// ============================================================
const PLANS_OFF_SECTIONS = ['radar', 'traffic', 'operations', 'smoke'];
const PLANS_OFF_LAYERS = ['radar', 'adsb_aircraft', 'adsb_trails', 'swap_radius', 'hms_smoke'];

// Radar is not an S.mapLayers entry — its frames live on S.radarAnim.
function _plansLayerExists(id) {
  if (id === 'radar') return !!(S.radarAnim && S.radarAnim.layers && S.radarAnim.layers.length);
  return _layerHasFeatures(id);
}

// Called from toggleLayer (the click path ONLY, never from app-driven renders),
// so a deliberate re-check is remembered and stops being suppressed.
function _notePlansOverride(id, on) {
  if (!S.plansMode || !PLANS_OFF_LAYERS.includes(id)) return;
  if (!S._plansUserOverride) S._plansUserOverride = new Set();
  // Aircraft and its trails are one logical toggle (see setLayerVisible).
  const ids = id === 'adsb_aircraft' ? [id, 'adsb_trails'] : [id];
  ids.forEach(k => on ? S._plansUserOverride.add(k) : S._plansUserOverride.delete(k));
}

// True while PLANS owns this layer, i.e. the user has not re-checked it. Render
// paths that re-attach a layer of their own accord should consult this.
function _plansSuppressed(id) {
  return !!(S.plansMode && PLANS_OFF_LAYERS.includes(id)
    && !(S._plansUserOverride && S._plansUserOverride.has(id)));
}

function _applyPlansMode() {
  if (!S.plansMode) return;
  if (!S._plansUserOverride) S._plansUserOverride = new Set();
  for (const id of PLANS_OFF_LAYERS) {
    if (!_plansSuppressed(id)) continue;  // the user asked this one back
    if (!_plansLayerExists(id)) continue; // not created yet; catch it when it arrives
    setLayerVisible(id, false);           // idempotent — a no-op once it is already off
  }
}

function togglePlansMode() {
  S.plansMode = !S.plansMode;
  document.getElementById('btnPlans')?.classList.toggle('active', S.plansMode);
  document.getElementById('headerActions')?.classList.remove('open'); // close the mobile menu
  S._plansUserOverride = S.plansMode ? new Set() : null;
  if (!S.layerSections) S.layerSections = new Set();
  PLANS_OFF_SECTIONS.forEach(k => S.plansMode ? S.layerSections.add(k) : S.layerSections.delete(k));
  _persistLayerUiState();
  buildLayerControl(); // runs _applyPlansMode(), then re-emits with the sections collapsed
}

// Collapsed sections + PLANS mode survive a reload (same convention as sar_theme).
function _persistLayerUiState() {
  try {
    localStorage.setItem('sar_layer_ui', JSON.stringify({
      sections: [...(S.layerSections || [])],
      plans: !!S.plansMode,
    }));
  } catch (_) { /* private mode / quota — UI chrome only */ }
}

function restoreLayerUiState() {
  try {
    const raw = localStorage.getItem('sar_layer_ui');
    if (!raw) return;
    const st = JSON.parse(raw);
    if (Array.isArray(st.sections)) S.layerSections = new Set(st.sections);
    if (st.plans) {
      S.plansMode = true;
      S._plansUserOverride = new Set(); // a reloaded PLANS session suppresses again from scratch
      document.getElementById('btnPlans')?.classList.add('active');
    }
  } catch (_) { /* corrupt entry — fall back to defaults */ }
}

// ============================================================
// AGGREGATED MULTI-FEATURE POPUP
// A single click can land on many overlapping features (e.g. Class airspace +
// LAANC grid + an obstacle + a NOTAM). Leaflet only opens the topmost feature's
// popup, so instead we hit-test every visible overlay at the click point and
// show all matches in one popup with "<- n/N ->" pagination.
// ============================================================
const AGG_HIT_PX = 8; // pixel tolerance for line / point hit-testing
// observer_rings: a VLOS ring covers a large area, so hit-testing it would add a
// spurious page to the popup for every click inside the ring.
const AGG_SKIP_LAYERS = new Set(['basemap_dark', 'basemap_light', 'satellite', 'topo', 'sectional', 'adsb_trails', 'canopy', 'viewshed', 'shadow', 'slope', 'streets', 'snow_depth', 'goes_clouds', 'glm_lightning', 'observer_rings']);
// Export-only exclusion set. Extends the popup-skip set (so basemaps /
// rasters stay out of the vector export) and adds layers CalTopo already provides
// natively and that would be stale by import time. These layers remain visible and
// clickable on the map — this set is used ONLY by the export paths, never by popup
// aggregation. (Canopy & viewshed are excluded here but still export as GeoTIFF/KMZ
// via the raster rows.)
const EXPORT_SKIP_LAYERS = new Set([
  ...AGG_SKIP_LAYERS,
  'adsb_aircraft', 'mvum_roads', 'mvum_trails', 'usfs_trails',
  'cell_att', 'cell_tmobile', 'cell_verizon',  // FCC LTE coverage polygons
  'public_lands',                              // land ownership
  'cell_towers', 'dams',                       // user-requested additions
  'parcels',                                   // view-driven advisory data — huge, stays out of exports
]);
// Layers that may be exported even when hidden on the map, provided they are built
// and populated (e.g. LAANC is built unconditionally but off by default).
const EXPORT_HIDDEN_OK = new Set(['faa_laanc']);
// Per-layer display label + cycle priority (lower = shown first). Safety-relevant
// restrictions sort ahead of advisory/terrain features.
const AGG_LAYER_META = {
  faa_tfr: { label: 'TFR', pri: 0 }, faa_prohibited: { label: 'Prohibited Area', pri: 0 },
  faa_ns_restrictions: { label: 'Nat. Security', pri: 0 }, tfr_imported: { label: 'TFR (imported)', pri: 0 },
  notam_imported: { label: 'NOTAM', pri: 1 }, faa_sua: { label: 'Special Use', pri: 1 },
  nws_alerts: { label: 'NWS Alert', pri: 1 }, fire_perimeters: { label: 'Fire Perimeter', pri: 1 },
  faa_class_airspace: { label: 'Class Airspace', pri: 2 }, adsb_aircraft: { label: 'Aircraft', pri: 2 },
  faa_laanc: { label: 'LAANC Grid', pri: 3 }, airports: { label: 'Airport', pri: 3 },
  faa_obstacles: { label: 'Obstacle', pri: 4 }, dams: { label: 'Dam', pri: 4 },
  cell_towers: { label: 'Tower', pri: 5 }, buildings: { label: 'Building', pri: 7 },
  wilderness: { label: 'Wilderness', pri: 6 },
  national_parks: { label: 'National Park', pri: 6 }, swap_radius: { label: 'Swap Radius', pri: 8 },
  observers: { label: 'Observer', pri: 3 },
  parcels: { label: 'Parcel', pri: 8 },
  public_lands: { label: 'Land Status', pri: 6 }, nhd_water: { label: 'Water', pri: 7 },
  hospitals: { label: 'Hospital/LZ', pri: 4 }, emergency_lz: { label: 'Emergency LZ', pri: 4 },
  usfs_roads: { label: 'NFS Road', pri: 7 }, usfs_trails: { label: 'NFS Trail', pri: 7 },
  trails: { label: 'Named Trail (OSM)', pri: 7 },
  mvum_roads: { label: 'MVUM Road', pri: 7 }, mvum_trails: { label: 'MVUM Trail', pri: 7 },
  blm_gtlf: { label: 'BLM Route', pri: 7 },
  cell_att: { label: 'AT&T LTE', pri: 8 }, cell_tmobile: { label: 'T-Mobile LTE', pri: 8 },
  cell_verizon: { label: 'Verizon LTE', pri: 8 },
  hms_smoke: { label: 'Smoke Plume', pri: 5 }, avalanche: { label: 'Avalanche Zone', pri: 6 },
};

function _aggMeta(key) {
  if (AGG_LAYER_META[key]) return AGG_LAYER_META[key];
  if (key.indexOf('wire_') === 0) {
    const info = typeof WIRE_CATEGORIES !== 'undefined' && WIRE_CATEGORIES[key.slice(5)];
    return { label: info ? info.label : 'Wire', pri: 5 };
  }
  if (key.indexOf('chart_') === 0) return { label: 'Chart', pri: 9 };
  return { label: '', pri: 7 };
}

// Walk a layer tree, invoking cb on each layer that carries its OWN popup
// (stops descending once found — a GeoJSON wrapper holds the popup, not its child).
function eachPopupLayer(root, cb) {
  if (!root) return;
  if (root.getPopup && root.getPopup()) { cb(root); return; }
  if (root.getLayers) root.getLayers().forEach(c => eachPopupLayer(c, cb));
}

function _aggContentToHtml(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'function') { try { return _aggContentToHtml(c()); } catch (e) { return ''; } }
  if (c.outerHTML) return c.outerHTML;
  return String(c);
}

// Flatten Leaflet getLatLngs() (which nests for holes / multi-geometries) into
// an array of rings, each ring an array of [lat, lng].
function _aggRings(latlngs, out) {
  out = out || [];
  if (!Array.isArray(latlngs)) return out;
  if (latlngs.length && latlngs[0] && typeof latlngs[0].lat === 'number') {
    out.push(latlngs.map(p => [p.lat, p.lng]));
  } else {
    latlngs.forEach(s => _aggRings(s, out));
  }
  return out;
}

function _aggPolygonHit(lyr, latlng) {
  try { if (lyr.getBounds && !lyr.getBounds().contains(latlng)) return false; } catch (e) { /* no bounds */ }
  return pointInRings(latlng.lat, latlng.lng, _aggRings(lyr.getLatLngs()));
}

function _aggPolylineHit(lyr, clickPt) {
  const segs = [];
  const collect = a => {
    if (!Array.isArray(a)) return;
    if (a.length && a[0] && typeof a[0].lat === 'number') segs.push(a);
    else a.forEach(collect);
  };
  collect(lyr.getLatLngs());
  for (const seg of segs) {
    for (let i = 1; i < seg.length; i++) {
      const a = S.map.latLngToLayerPoint(seg[i - 1]);
      const b = S.map.latLngToLayerPoint(seg[i]);
      if (distPointToSegment(clickPt.x, clickPt.y, a.x, a.y, b.x, b.y) <= AGG_HIT_PX) return true;
    }
  }
  return false;
}

function _aggPointHit(lyr, latlng, clickPt) {
  if (typeof L !== 'undefined' && L.Circle && lyr instanceof L.Circle) {
    return S.map.distance(latlng, lyr.getLatLng()) <= lyr.getRadius(); // radius in metres
  }
  const mp = S.map.latLngToLayerPoint(lyr.getLatLng());
  let pad = AGG_HIT_PX;
  if (typeof L !== 'undefined' && L.CircleMarker && lyr instanceof L.CircleMarker) {
    pad = (lyr.getRadius ? lyr.getRadius() : 5) + 6;
  } else {
    const sz = lyr.options && lyr.options.icon && lyr.options.icon.options && lyr.options.icon.options.iconSize;
    pad = (Array.isArray(sz) ? Math.max(sz[0], sz[1]) / 2 : 14) + 2;
  }
  return clickPt.distanceTo(mp) <= pad;
}

// Does this geometry (descending into groups) contain / sit under the click?
function _aggLayerHit(lyr, latlng, clickPt) {
  try {
    if (typeof L !== 'undefined' && L.Polygon && lyr instanceof L.Polygon) return _aggPolygonHit(lyr, latlng);
    if (typeof L !== 'undefined' && L.Polyline && lyr instanceof L.Polyline) return _aggPolylineHit(lyr, clickPt);
    if (lyr.getLatLng) return _aggPointHit(lyr, latlng, clickPt);
    if (lyr.getLayers) return lyr.getLayers().some(c => _aggLayerHit(c, latlng, clickPt));
    if (lyr.getBounds) return lyr.getBounds().contains(latlng);
  } catch (e) { /* malformed geometry — treat as miss */ }
  return false;
}

function collectFeaturesAt(latlng) {
  const hits = [];
  const seen = new Set(); // collapse exact-duplicate popups (e.g. tiered airspace split into segments)
  if (!S.map || !S.mapLayers) return hits;
  const clickPt = S.map.latLngToLayerPoint(latlng);
  for (const key of Object.keys(S.mapLayers)) {
    if (AGG_SKIP_LAYERS.has(key)) continue;
    const group = S.mapLayers[key];
    if (!group || !S.map.hasLayer(group)) continue;
    const meta = _aggMeta(key);
    eachPopupLayer(group, pl => {
      if (!_aggLayerHit(pl, latlng, clickPt)) return;
      const content = _aggContentToHtml(pl.getPopup().getContent());
      if (!content || seen.has(content)) return;
      seen.add(content);
      hits.push({ content, label: meta.label, pri: meta.pri });
    });
  }
  hits.sort((a, b) => a.pri - b.pri);
  return hits;
}

let _aggLastEvent = null;
// Lift the popup clear of an observer pin (25x41 default icon anchored at its
// tip) so the pin stays tappable underneath — tapping it toggles the viewshed.
const OBSERVER_POPUP_LIFT_PX = -46;
function openAggregatePopup(latlng, ev, offsetY) {
  if (!S.map || !latlng) return;
  // Don't hijack clicks while a draw tool is placing points.
  if (typeof document !== 'undefined' && document.querySelector('.draw-btn.active')) return;
  const oe = ev && ev.originalEvent;
  // Ignore clicks that originate INSIDE the popup (e.g. the pager arrows) — those
  // must page the popup, not be treated as a fresh map click that re-aggregates.
  if (oe && oe.target && oe.target.closest && oe.target.closest('.leaflet-popup')) return;
  // A feature click and the map click both fire for one user click — they share
  // the same underlying DOM event, so dedupe on its identity (distinct user
  // clicks get a fresh event; programmatic calls pass none and never dedupe).
  if (oe) { if (oe === _aggLastEvent) return; _aggLastEvent = oe; }

  const hits = collectFeaturesAt(latlng);
  if (!hits.length) return;
  S._aggPopup.items = hits;
  S._aggPopup.index = 0;
  if (!S._aggPopup.popup) S._aggPopup.popup = L.popup({ maxWidth: 340, minWidth: 180, autoPan: true, className: 'agg-popup' });
  // The popup is shared across every open — set the anchor offset each time
  // (7 is Leaflet's stock popup offset; observer taps pass a lift instead).
  S._aggPopup.popup.options.offset = L.point(0, offsetY != null ? offsetY : 7);
  S._aggPopup.popup.setLatLng(latlng);
  renderAggregatePopup();
  S._aggPopup.popup.openOn(S.map);
  // Stop clicks inside the popup from bubbling to the map (which would re-open the
  // aggregate or close the popup via closePopupOnClick). Re-applied each open
  // because Leaflet recreates the popup container when it is re-added to the map.
  const el = S._aggPopup.popup.getElement && S._aggPopup.popup.getElement();
  if (el && !el._aggStop && typeof L !== 'undefined' && L.DomEvent) {
    el._aggStop = true;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.on(el, 'click', L.DomEvent.stopPropagation);
  }
}

function renderAggregatePopup() {
  const st = S._aggPopup;
  if (!st.popup || !st.items.length) return;
  const n = st.items.length, i = ((st.index % n) + n) % n;
  st.index = i;
  const item = st.items[i];
  const btn = 'background:rgba(128,128,128,0.16);border:1px solid rgba(128,128,128,0.5);color:inherit;border-radius:4px;cursor:pointer;font:600 14px/1 monospace;padding:1px 9px';
  let html = '';
  if (n > 1) {
    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;padding-bottom:5px;border-bottom:1px solid rgba(128,128,128,0.3)">`
      + `<button type="button" title="Previous" onclick="aggPopupStep(-1)" style="${btn}">&#8592;</button>`
      + `<span style="font:600 11px/1.25 monospace;opacity:0.8;text-align:center">${i + 1} / ${n}`
      + (item.label ? `<br><span style="opacity:0.6;font-weight:400">${item.label}</span>` : '')
      + `</span>`
      + `<button type="button" title="Next" onclick="aggPopupStep(1)" style="${btn}">&#8594;</button>`
      + `</div>`;
  } else if (item.label) {
    html += `<div style="font:600 10px/1.2 monospace;opacity:0.55;margin-bottom:4px">${item.label}</div>`;
  }
  html += `<div class="agg-popup-body">${item.content}</div>`;
  st.popup.setContent(html);
}

function aggPopupStep(dir) {
  const st = S._aggPopup;
  if (!st.items.length) return;
  st.index += dir;
  renderAggregatePopup();
  if (st.popup && st.popup.update) st.popup.update();
}

function _aggFeatureClick(e) {
  if (e && e.originalEvent && typeof L !== 'undefined' && L.DomEvent) L.DomEvent.stopPropagation(e);
  // While picking a viewshed observer, a click that lands on an interactive
  // feature (TFR/NOTAM polygon) must still place the observer — the feature
  // handler stops propagation, so the map-level click handler never sees it.
  if (S._viewshedPicking) { onViewshedMapClick(e.latlng); return; }
  // An observer-marker tap toggles its viewshed (the marker's own click
  // handler) — anchor the popup at the pin and lift it above the icon so the
  // pin stays visible and tappable for the next toggle.
  const t = e && e.target;
  const obs = t && (S.viewsheds || []).some(r => r._marker === t);
  if (obs && t.getLatLng) { openAggregatePopup(t.getLatLng(), e, OBSERVER_POPUP_LIFT_PX); return; }
  openAggregatePopup(e.latlng, e);
}

// Route every popup-bearing feature's click into the aggregated popup, replacing
// Leaflet's default "open just my popup" behavior. Idempotent via _aggWired.
function wirePopupAggregation() {
  if (!S.map || !S.mapLayers) return;
  for (const key of Object.keys(S.mapLayers)) {
    if (AGG_SKIP_LAYERS.has(key)) continue;
    const group = S.mapLayers[key];
    if (!group) continue;
    eachPopupLayer(group, pl => {
      if (pl._aggWired || typeof pl.on !== 'function') return;
      if (pl._openPopup) pl.off('click', pl._openPopup, pl); // suppress native single-popup open
      pl.on('click', _aggFeatureClick);
      pl._aggWired = true;
    });
  }
}

// Back-compat shim: aircraft selection + per-threshold values now live in the
// unified "Aircraft & SOP Profile" picker; any config edit just recomputes.
function saveConfig() { onThresholdEdit(); }

let _metaTick = 0;
function updateClock() {
  const now = new Date();
  const local = now.toLocaleTimeString('en-US', { hour12: false, timeZone: _localTZ() });
  const utc = now.toISOString().substr(11, 8);
  document.getElementById('clockDisplay').textContent = `${local} L / ${utc} Z`;
  // Refresh the per-section "(Xm ago)" ages every ~30s (cheap; text only).
  if ((++_metaTick % 30) === 0 && typeof renderAllSectionMeta === 'function') renderAllSectionMeta();
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', () => {
  if (typeof L === 'undefined') {
    console.error('Leaflet failed to load from CDN.');
    return;
  }
  startApp();
});
const APP_VERSION = '2026.03.27';

function checkDisclaimer() {
  const accepted = localStorage.getItem('sar_disclaimer_version');
  if (accepted !== APP_VERSION) {
    document.getElementById('disclaimerModal')?.classList.add('active');
  }
}

function acceptDisclaimer() {
  localStorage.setItem('sar_disclaimer_version', APP_VERSION);
  document.getElementById('disclaimerModal')?.classList.remove('active');
  // A pending update supersedes What's New: the update modal shows the NEWER
  // version's notes, so showing last update's notes too would just stack modals.
  if (S._pendingUpdateModal) {
    S._pendingUpdateModal = false; S._pendingWhatsNew = false;
    try { showUpdateModal(); } catch (_) {}
  } else if (S._pendingWhatsNew) {
    S._pendingWhatsNew = false;
    try { showChangelog(true); } catch (_) {}
  }
}

function startApp() {
  // Crash tracing must run as early as possible so the "did the previous
  // session exit cleanly?" check sees the prior flag before anything resets it.
  try { Diag.init(); Diag.bindTrigger(); } catch (_) {}
  checkDisclaimer();
  initMap();
  resolveSectionalEdition();
  updateClock();
  setInterval(updateClock, 1000);
  renderAllSectionMeta(); // show "Not loaded" freshness lines before an area is drawn
  const tabNav = document.getElementById('tabNav');
  tabNav.addEventListener('scroll', updateScrollBtns);
  setTimeout(updateScrollBtns, 100);
  window.addEventListener('resize', updateScrollBtns);

  // PWA: register service worker
  // updateViaCache:'none' forces the browser to bypass the HTTP cache when
  // fetching sw.js and its importScripts (version.js), so iOS PWAs reliably
  // discover new versions instead of serving stale cached scripts.
  if ('serviceWorker' in navigator) {
    const trackInstallingSW = (sw) => {
      sw.addEventListener('statechange', () => {
        // Fire the update modal once the new SW is installed (before activation).
        // On an update, navigator.serviceWorker.controller is already set by
        // the old SW, so this distinguishes "update" from "first install".
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateModal();
        }
      });
    };

    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
      S._swReg = reg;

      // Cover three cases missed by a naked updatefound listener:
      // 1. An update is already waiting from a previous session
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateModal();
      }
      // 2. An update is currently installing (race: install may start before listener attaches)
      if (reg.installing) {
        trackInstallingSW(reg.installing);
      }
      // 3. Future updates discovered after registration
      reg.addEventListener('updatefound', () => {
        if (reg.installing) trackInstallingSW(reg.installing);
      });

      // Proactively re-check for updates whenever the PWA regains focus —
      // critical for iOS where tabs may live for days between launches.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && S._swReg) {
          S._swReg.update().catch(() => {});
          checkDeployedVersion();
        }
      });

      // The SW byte-compare misses version.js-only deploys — actively compare
      // the deployed version once at startup too.
      checkDeployedVersion();
    }).catch(err => console.warn('SW registration failed:', err));

    // Listen for tile download progress from SW
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'TILE_PROGRESS') {
        const pct = Math.round((event.data.done / event.data.total) * 100);
        const bar = document.getElementById('tileProgressBar');
        const text = document.getElementById('tileProgressText');
        if (bar) bar.style.width = `${pct}%`;
        if (text) text.textContent = `Downloading tile ${event.data.done} of ${event.data.total} (${pct}%)`;
      }
      if (event.data?.type === 'TILE_DOWNLOAD_COMPLETE') {
        const text = document.getElementById('tileProgressText');
        if (text) text.textContent = `Download complete: ${event.data.total} tiles cached`;
        document.getElementById('btnDownloadTiles')?.removeAttribute('disabled');
        updateCacheStatus();
      }
      if (event.data?.type === 'TILE_CACHE_CLEARED') {
        updateCacheStatus();
      }
      if (event.data?.type === 'CACHE_SIZE') {
        const el = document.getElementById('cacheStatus');
        if (el && event.data.size) {
          const usage = event.data.size.usage || 0, quota = event.data.size.quota || 0;
          const mb = (usage / 1048576).toFixed(1);
          el.textContent = quota > 0
            ? `Using ${mb} MB of ${(quota / 1073741824).toFixed(2)} GB (${Math.round(usage / quota * 100)}%)`
            : `Using ${mb} MB`;
        }
      }
    });
  }

  // Connectivity monitoring
  if (typeof initConnectivity === 'function') initConnectivity();

  // Update cache status display
  updateCacheStatus();

  // Restore last config from IndexedDB
  restoreConfig();
  restoreFAACharts();
  setupTfrDropzone();
  // Load bundled per-carrier cell coverage (no-op if the build hasn't been run)
  if (typeof loadCellCoverage === 'function') loadCellCoverage();

  // Update notification status display
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const el = document.getElementById('notifyStatus');
    if (el) el.textContent = 'Enabled';
  }
  // Show "What's New" if the running version changed since the last visit.
  maybeShowWhatsNew();

  // Anonymous, cookieless, country-level usage analytics (no-op until a token
  // is set, offline, on file://, or when the user has opted out / set DNT).
  initUsageAnalytics();

  // App version labels are populated by version.js directly on DOMContentLoaded
  // so the display survives any earlier failure in startApp.
}

function showUpdateBanner() {
  if (document.getElementById('swUpdateBanner')) return;
  const banner = document.getElementById('assessmentBanner');
  if (!banner) return;
  const div = document.createElement('div');
  div.id = 'swUpdateBanner';
  div.style.cssText = 'padding:8px 16px;background:var(--bg-tertiary);border-bottom:1px solid var(--accent-cyan);font-family:var(--font-mono);font-size:11px;color:var(--accent-cyan);display:flex;align-items:center;gap:8px;';
  div.innerHTML = 'Update available <button class="btn btn-primary" style="padding:3px 10px;font-size:10px;" onclick="applyUpdate()">Reload</button>';
  banner.parentElement.insertBefore(div, banner);
}

// Fetch the server's current version.js, bypassing the SW cache. The cache-busting
// query makes the SW's cache-first match miss, so the request passes through to the
// network and returns the *deployed* version (what a reload would actually load).
async function fetchLatestVersion() {
  try {
    const r = await fetch('version.js?cb=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    const m = (await r.text()).match(/SAR_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

async function checkForUpdates() {
  const btn = document.getElementById('btnCheckUpdates');
  const status = document.getElementById('updateCheckStatus');
  if (!status) return;

  if (btn) btn.disabled = true;
  status.textContent = 'Checking…';
  status.style.color = 'var(--text-muted)';

  const current = (typeof SAR_VERSION !== 'undefined') ? SAR_VERSION : null;
  try {
    // Nudge the service worker to fetch/install any new version so the reload is
    // instant and works offline. We do NOT gate the result on reg.waiting/installing:
    // the SW uses skipWaiting + clients.claim, so a new worker activates immediately
    // and those go null — comparing versions is the only reliable signal.
    if (S._swReg && S._swReg.update) { try { await S._swReg.update(); } catch (_) {} }

    const latest = await fetchLatestVersion();
    if (!latest) {
      status.textContent = 'Couldn’t reach the server — check your connection.';
      status.style.color = 'var(--accent-amber)';
    } else if (current && latest !== current) {
      status.innerHTML = 'Update available: v' + latest +
        ' — <a href="#" onclick="applyUpdate();return false;" style="color:var(--accent-cyan);text-decoration:underline;">reload to update</a>';
      status.style.color = 'var(--accent-cyan)';
      showUpdateModal(true);
    } else {
      status.textContent = 'Up to date (v' + (current || latest) + ')';
      status.style.color = 'var(--accent-green)';
    }
  } catch (err) {
    status.textContent = 'Check failed: ' + (err.message || 'unknown error');
    status.style.color = 'var(--accent-amber)';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Shared renderer for a list of changelog entries. `cur` (optional) highlights
// that version and tags it "— current".
function _changelogEntriesHtml(entries, cur) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (entries || []).map(function (e) {
    const isCur = cur && e.version === cur;
    const items = (e.changes || []).map(function (c) { return '<li style="margin-bottom:3px;">' + esc(c) + '</li>'; }).join('');
    return '<div style="margin-bottom:14px;">' +
      '<div style="font-family:var(--font-mono);font-size:12px;font-weight:700;color:' + (isCur ? 'var(--accent-cyan)' : 'var(--text-secondary)') + ';">' +
      'v' + esc(e.version) + (isCur ? ' — current' : '') +
      ' <span style="color:var(--text-muted);font-weight:400;">' + esc(e.date || '') + '</span></div>' +
      '<ul style="margin:6px 0 0 0;padding-left:18px;font-size:12px;line-height:1.5;color:var(--text-secondary);">' + items + '</ul>' +
      '</div>';
  }).join('');
}

// Render the changelog modal. whatsNew=true titles it "What's New — v<current>"
// (shown automatically after an update); false is the on-demand "Changelog" view.
function showChangelog(whatsNew) {
  const modal = document.getElementById('changelogModal');
  const body = document.getElementById('changelogBody');
  if (!modal || !body) return;
  const entries = (typeof CHANGELOG_ENTRIES !== 'undefined' && Array.isArray(CHANGELOG_ENTRIES)) ? CHANGELOG_ENTRIES : [];
  const cur = (typeof SAR_VERSION !== 'undefined') ? SAR_VERSION : '';
  const title = document.getElementById('changelogTitle');
  if (title) title.textContent = whatsNew ? ('What\'s New — v' + cur) : 'Changelog';
  body.innerHTML = entries.length ? _changelogEntriesHtml(entries, cur)
    : '<div style="color:var(--text-muted);font-size:12px;">No changelog available.</div>';
  const link = document.getElementById('changelogGithubLink');
  if (link && typeof CHANGELOG_URL !== 'undefined' && CHANGELOG_URL) link.href = CHANGELOG_URL;
  modal.classList.add('active');
}

// "Update Available" modal — shown when the SW discovers a newly deployed
// version (or a manual check finds one). Fetches the DEPLOYED changelog +
// version (cache-busted, so the SW cache is bypassed) to show what the update
// contains before the user reloads; "Later" dismisses it, leaving the thin
// update banner as a persistent reminder. Auto-discovery paths show it once
// per session (`force` bypasses that for the manual Config check).
async function showUpdateModal(force) {
  showUpdateBanner(); // persistent fallback reminder if the modal is dismissed
  if (S._updateModalShown && !force) return;
  // Never cover the (legally required) disclaimer — defer like What's New.
  const disc = document.getElementById('disclaimerModal');
  if (disc && disc.classList.contains('active')) { S._pendingUpdateModal = true; return; }
  const modal = document.getElementById('updateModal');
  const body = document.getElementById('updateModalBody');
  if (!modal || !body) return;
  S._updateModalShown = true;
  const cur = (typeof SAR_VERSION !== 'undefined') ? SAR_VERSION : null;
  const latest = await fetchLatestVersion();
  let entries = [];
  try {
    const r = await fetch('CHANGELOG.md?cb=' + Date.now(), { cache: 'no-store' });
    if (r.ok && typeof parseChangelogMd === 'function') entries = parseChangelogMd(await r.text(), cur);
  } catch (_) { /* offline — show the modal without details */ }
  const sub = document.getElementById('updateModalSub');
  if (sub) {
    sub.textContent = (latest && cur && latest !== cur)
      ? ('v' + cur + '  →  v' + latest)
      : ('A newer version than v' + (cur || '?') + ' is ready');
  }
  body.innerHTML = entries.length ? _changelogEntriesHtml(entries, null)
    : '<div style="color:var(--text-muted);font-size:12px;">Change details unavailable (offline?) — reload to apply the update, or check the changelog afterwards.</div>';
  modal.classList.add('active');
}

function dismissUpdateModal() {
  document.getElementById('updateModal')?.classList.remove('active');
}

// Active deployed-version check. The browser's SW update byte-compare does NOT
// notice deploys that only change version.js (an imported script) — verified in
// Chrome even with updateViaCache:'none' — so releases that don't touch sw.js
// itself would never fire update discovery. This compares the deployed
// version.js (cache-busted network fetch) against the running version instead.
// Throttled; called at startup and whenever the app regains visibility.
async function checkDeployedVersion() {
  try {
    if (typeof isOnline === 'function' && !isOnline()) return;
    const now = Date.now();
    if (S._lastVersionCheck && now - S._lastVersionCheck < 10 * 60 * 1000) return;
    S._lastVersionCheck = now;
    const cur = (typeof SAR_VERSION !== 'undefined') ? SAR_VERSION : null;
    const latest = await fetchLatestVersion();
    if (cur && latest && latest !== cur) await showUpdateModal();
  } catch (_) { /* offline / transient — next visibility change retries */ }
}

// Ask the active SW to re-fetch the app shell from the network into its cache
// (REFRESH_SHELL). Resolves false on timeout — e.g. an older deployed SW
// without the handler — so the caller can fall back.
function _swRefreshShell(sw, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    setTimeout(() => finish(false), timeoutMs || 12000);
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => finish(!!(e.data && e.data.ok));
      sw.postMessage({ type: 'REFRESH_SHELL' }, [ch.port2]);
    } catch (_) { finish(false); }
  });
}

// Wait for an in-flight SW install to settle (installed/activated) so a reload
// lands on the new worker's cache rather than racing the install.
function _swAwaitInstalled(reg, timeoutMs) {
  return new Promise((resolve) => {
    const sw = reg && reg.installing;
    if (!sw) return resolve(true);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(true), timeoutMs || 8000);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated') finish(true);
      if (sw.state === 'redundant') finish(false);
    });
  });
}

// Apply a discovered update.
// 1) sw.js itself changed → normal SW update: nudge it, wait for the install
//    to settle (skipWaiting + clients.claim), reload.
// 2) Only app files / version.js changed (sw.js byte-identical → the browser
//    installs nothing) → REFRESH_SHELL: the ACTIVE SW re-pulls the shell from
//    the network into its cache, then a plain reload serves the new version
//    cache-first. NEVER unregister here: an unregistered reload falls back to
//    the browser HTTP cache, which can hold the OLD shell for its full
//    max-age (10 min on GitHub Pages) — that caused an "Update Available" →
//    reload → same old version modal loop.
// 3) Old deployed SW without REFRESH_SHELL (timeout) → legacy fallback:
//    unregister so the reload fetches from the network.
async function applyUpdate() {
  try {
    const reg = S._swReg;
    const online = (typeof isOnline !== 'function') || isOnline();
    if (reg && online) {
      if (!reg.waiting && !reg.installing) { try { await reg.update(); } catch (_) {} }
      if (reg.waiting || reg.installing) {
        await _swAwaitInstalled(reg);
        location.reload();
        return;
      }
      if (reg.active) {
        const ok = await _swRefreshShell(reg.active);
        if (ok) { location.reload(); return; }
      }
      try { await reg.unregister(); } catch (_) {}
    }
  } catch (_) {}
  location.reload();
}

function closeChangelog() {
  document.getElementById('changelogModal')?.classList.remove('active');
}

// Show "What's New" once, on the first load after the running version changes.
// Skips the first-ever install (no prior version stored) and defers behind the
// disclaimer modal if that's showing.
function maybeShowWhatsNew() {
  try {
    const cur = (typeof SAR_VERSION !== 'undefined') ? SAR_VERSION : null;
    if (!cur) return;
    const last = localStorage.getItem('sar_last_seen_version');
    localStorage.setItem('sar_last_seen_version', cur);
    if (!last || last === cur) return;
    const disc = document.getElementById('disclaimerModal');
    if (disc && disc.classList.contains('active')) {
      S._pendingWhatsNew = true;
    } else {
      showChangelog(true);
    }
  } catch (_) {}
}

function downloadTilesForView() {
  if (!navigator.serviceWorker?.controller) {
    const el = document.getElementById('tileProgressText');
    if (el) el.textContent = 'Service worker not active. Reload the page first.';
    return;
  }
  const bounds = S.map.getBounds();
  const zooms = (document.getElementById('cfgTileZooms')?.value || '10,11,12,13,14').split(',').map(Number);
  document.getElementById('btnDownloadTiles')?.setAttribute('disabled', 'true');
  document.getElementById('tileProgressText').textContent = 'Starting download...';
  navigator.serviceWorker.controller.postMessage({
    type: 'DOWNLOAD_TILES',
    bounds: {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    },
    zooms,
    providers: getSelectedTileProviders(),
  });
}

function getSelectedTileProviders() {
  const providers = ['carto']; // always include base map
  if (document.getElementById('cfgTileSat')?.checked) providers.push('satellite');
  if (document.getElementById('cfgTileTopo')?.checked) providers.push('topo');
  if (document.getElementById('cfgTileSectional')?.checked) providers.push('sectional');
  if (document.getElementById('cfgTileHillshade')?.checked) providers.push('hillshade');
  if (document.getElementById('cfgTileStreets')?.checked) providers.push('streets_roads', 'streets_labels');
  return providers;
}

// Shared view → analysis grid (keeps DEM/canopy cache keys aligned across the
// pre-cache and live-analysis paths). Mirrors the canopy-analysis grid build.
function gridForView(bounds) {
  const center = bounds.getCenter();
  const halfWidthM = Math.max(
    center.distanceTo(L.latLng(center.lat, bounds.getWest())),
    center.distanceTo(L.latLng(bounds.getNorth(), center.lng))
  );
  const resM = Math.max(WORK_RES_M, (2 * halfWidthM) / MAX_GRID);
  return makeGrid(center.lat, center.lng, halfWidthM, resM);
}
async function _cacheViewRaster(kind, bounds) {
  try {
    const grid = gridForView(bounds);
    if (kind === 'dem') return await fetch3DEPDEM(grid);
    if (kind === 'canopy') {
      if (!getCanopyProxyBase()) return { source: 'no proxy' };
      return await fetchCanopyRaster(grid);
    }
  } catch (e) { return { error: (e && e.message) || String(e) }; }
}
// Pre-fetch + cache all vector layers (and optionally DEM/vegetation rasters) for
// the CURRENT map view so they're available offline — independent of the SW tile
// flow (which caches base/sat/topo/sectional/hillshade image tiles).
async function cacheCurrentView() {
  if (!S.map) return;
  const bounds = S.map.getBounds();
  const center = bounds.getCenter();
  const btn = document.getElementById('btnCacheView');
  const prog = document.getElementById('viewCacheProgress');
  if (btn) btn.setAttribute('disabled', 'true');
  const jobs = [
    fetchFAAairspace(bounds), fetchFaaObstacles(bounds), fetchWireHazards(bounds),
    fetchUtilityWires(bounds),
    fetchProtectedAreas(bounds), fetchNearbyAirports(center, bounds),
    fetchPublicLands(bounds), fetchGroundAccess(bounds), fetchWaterFeatures(bounds),
    fetchFireDanger(center.lat, center.lng, bounds), fetchHospitals(bounds),
    fetchTrails(bounds),
  ];
  if (document.getElementById('cfgViewDEM')?.checked) jobs.push(_cacheViewRaster('dem', bounds));
  if (document.getElementById('cfgViewCanopy')?.checked) jobs.push(_cacheViewRaster('canopy', bounds));
  const total = jobs.length;
  let done = 0;
  if (prog) prog.textContent = `Caching 0/${total}…`;
  await Promise.all(jobs.map(j => Promise.resolve(j).catch(() => null).then(r => {
    done++; if (prog) prog.textContent = `Caching ${done}/${total}…`; return r;
  })));
  if (prog) prog.textContent = `Cached ${total} data sources for this view ✓ (add base tiles with "Download" above)`;
  if (btn) btn.removeAttribute('disabled');
  if (typeof updateCacheStatus === 'function') updateCacheStatus();
}

function clearAllCaches() {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_TILE_CACHE' });
  }
  if (typeof clearApiCache === 'function') clearApiCache();
  const el = document.getElementById('cacheStatus');
  if (el) el.textContent = 'Caches cleared';
}

function updateCacheStatus() {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'GET_CACHE_SIZE' });
  }
  // Request persistent storage (reduces eviction on mobile) + a direct estimate
  // fallback for when the Service Worker isn't controlling the page yet.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(est => {
        const el = document.getElementById('cacheStatus');
        if (!el || !est) return;
        if (!el.textContent || el.textContent === 'Checking...') {
          const usage = est.usage || 0, quota = est.quota || 0;
          const mb = (usage / 1048576).toFixed(1);
          el.textContent = quota > 0
            ? `Using ${mb} MB of ${(quota / 1073741824).toFixed(2)} GB (${Math.round(usage / quota * 100)}%)`
            : `Using ${mb} MB`;
        }
      }).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

function enableNotifications() {
  if (typeof requestNotificationPermission === 'function') {
    requestNotificationPermission().then(perm => {
      const el = document.getElementById('notifyStatus');
      if (el) el.textContent = perm === 'granted' ? 'Enabled' : 'Denied';
    });
  }
}

async function restoreConfig() {
  if (typeof getAppState !== 'function') return;
  const rpic = await getAppState('cfgRPIC');
  if (rpic) {
    const el = document.getElementById('cfgRPIC');
    if (el) el.value = rpic;
  }
  const refreshInterval = await getAppState('refreshInterval');
  if (refreshInterval !== null && refreshInterval !== undefined) {
    const el = document.getElementById('cfgRefreshInterval');
    if (el) { el.value = refreshInterval; setAutoRefresh(); }
  }
  // Restore active profile. Migrate the legacy aircraft-dropdown selection to its
  // matching built-in profile for users upgrading from before the merge.
  let profileName = await getAppState('activeProfile');
  if (!profileName) {
    const legacy = await getAppState('cfgAircraft');
    if (legacy && LEGACY_AIRCRAFT_PROFILE[legacy]) profileName = LEGACY_AIRCRAFT_PROFILE[legacy];
  }
  // Populate the dropdown first so loadSopProfile can select the restored option.
  await populateSopDropdown();
  if (profileName) loadSopProfile(profileName);
  // Restore the buildings-in-3D mode select (localStorage).
  const bld3dEl = document.getElementById('cfgBuildings3d');
  if (bld3dEl) bld3dEl.value = getBuildings3dSetting();
  // Restore custom proxy URL (localStorage) + hint. Field stays empty when the
  // built-in default proxy is in use.
  const proxyEl = document.getElementById('cfgCanopyProxy');
  if (proxyEl) proxyEl.value = getCustomProxy() || '';
  if (typeof saveCanopyProxy === 'function') saveCanopyProxy(getCustomProxy() || '');
  // Reflect the analytics opt-out toggle (also shows DNT/GPC as opted-out).
  // If the browser forces opt-out via DNT/GPC, lock the checkbox so unchecking
  // it isn't a silent no-op.
  const optOutEl = document.getElementById('cfgAnalyticsOptOut');
  if (optOutEl && typeof analyticsOptedOut === 'function') {
    optOutEl.checked = analyticsOptedOut();
    let flagSet = false;
    try { flagSet = localStorage.getItem('sar_analytics_optout') === '1'; } catch (_) {}
    const forcedByBrowser = optOutEl.checked && !flagSet;
    optOutEl.disabled = forcedByBrowser;
    optOutEl.title = forcedByBrowser ? 'Forced off by your browser’s Do-Not-Track / Global Privacy Control setting' : '';
  }
}

// ============================================================
// KML/KMZ IMPORT
// ============================================================
function importKML() {
  const input = document.getElementById('kmlFileInput');
  if (input) { input.value = ''; input.click(); }
}

function handleKMLFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.kmz')) {
    // Try reading as text; KMZ is typically a ZIP binary
    const reader = new FileReader();
    reader.onload = function() {
      try {
        // If it parsed as valid XML text, treat it as KML
        const text = reader.result;
        if (text.indexOf('<kml') !== -1 || text.indexOf('<Placemark') !== -1) {
          parseKML(text);
        } else {
          alert('KMZ files (binary ZIP) are not supported. Please extract the .kml file from the KMZ archive and import that instead.');
        }
      } catch (e) {
        alert('KMZ files (binary ZIP) are not supported. Please extract the .kml file from the KMZ archive and import that instead.');
      }
    };
    reader.onerror = function() {
      alert('KMZ files (binary ZIP) are not supported. Please extract the .kml file from the KMZ archive and import that instead.');
    };
    reader.readAsText(file);
  } else {
    const reader = new FileReader();
    reader.onload = function() { parseKML(reader.result); };
    reader.readAsText(file);
  }
}

function parseKML(kmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, 'text/xml');
  const KML_NS = 'http://www.opengis.net/kml/2.2';

  // Helper: find elements with namespace fallback
  function findElements(parent, tagName) {
    let els = parent.getElementsByTagNameNS(KML_NS, tagName);
    if (els.length === 0) els = parent.getElementsByTagName(tagName);
    return els;
  }

  // Extract coordinates text from a <coordinates> element
  function getCoordinatesText(parent) {
    const coords = findElements(parent, 'coordinates');
    return coords.length > 0 ? coords[0].textContent.trim() : '';
  }

  // Parse KML coordinate string: "lng,lat,alt lng,lat,alt ..."
  function parseCoordString(str) {
    return str.split(/\s+/).filter(Boolean).map(c => {
      const parts = c.split(',');
      return [parseFloat(parts[1]), parseFloat(parts[0])]; // [lat, lng]
    }).filter(p => !isNaN(p[0]) && !isNaN(p[1]));
  }

  let coords = [];
  let shapeType = 'polygon';

  // Try Polygon first
  const polygons = findElements(doc, 'Polygon');
  if (polygons.length > 0) {
    const outerBoundary = findElements(polygons[0], 'outerBoundaryIs');
    const parent = outerBoundary.length > 0 ? outerBoundary[0] : polygons[0];
    const coordText = getCoordinatesText(parent);
    coords = parseCoordString(coordText);
    shapeType = 'polygon';
  }

  // Try LineString if no polygon found
  if (coords.length === 0) {
    const lines = findElements(doc, 'LineString');
    if (lines.length > 0) {
      const coordText = getCoordinatesText(lines[0]);
      coords = parseCoordString(coordText);
      shapeType = 'polygon'; // treat linestring as polygon boundary
    }
  }

  // Try Point if nothing else
  if (coords.length === 0) {
    const points = findElements(doc, 'Point');
    if (points.length > 0) {
      const coordText = getCoordinatesText(points[0]);
      const parsed = parseCoordString(coordText);
      if (parsed.length > 0) {
        coords = parsed;
        shapeType = 'point';
      }
    }
  }

  if (coords.length === 0) {
    alert('No valid geometry found in KML file.');
    return;
  }

  // Clear existing drawn items
  S.drawnItems.clearLayers();

  let layer;
  if (shapeType === 'point') {
    // Create a circle with 2km radius around the point
    layer = L.circle(coords[0], {
      radius: 2000,
      color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4'
    });
    S.drawnItems.addLayer(layer);
    S.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
    processArea(layer, 'circle');
  } else {
    // Remove duplicate closing point if present
    if (coords.length > 2) {
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) coords.pop();
    }
    layer = L.polygon(coords, {
      color: '#3d8bfd', weight: 2, fillColor: '#3d8bfd', fillOpacity: 0.08, dashArray: '6,4'
    });
    S.drawnItems.addLayer(layer);
    S.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
    processArea(layer, 'polygon');
  }
}

// ============================================================
// COPY BRIEFING TO CLIPBOARD
// ============================================================
// Plain-text observer block for the briefing/PDF/email exports: one entry per
// observer with position, profile, coverage, and the visual-observation
// advisories (sun glare for today + terrain-backdrop sectors).
function _briefingObserverLines() {
  const out = [];
  (S.viewsheds || []).forEach(rec => {
    if (!rec || !rec.observer || rec.observer.lat == null || rec.observer.lng == null) return;
    const cov = rec.coverage == null
      ? (rec.computedAt ? 'no terrain data' : 'not computed')
      : Math.round(rec.coverage * 100) + '% of VLOS visible';
    out.push(`  ${rec.name || 'Observer'}: ${(+rec.observer.lat).toFixed(5)}, ${(+rec.observer.lng).toFixed(5)} | Drone ${rec.aglFt} ft AGL | VLOS ${rec.vlosFt} ft | ${cov}`);
    try {
      const glare = _glareAdvisoryText(rec);
      if (glare) out.push(`    Sun glare today: ${glare} (near-overhead passes can glare any time the sun is up)`);
    } catch (e) { /* advisory only */ }
    if (rec.backdrop) {
      const ranges = formatSectorRanges(rec.backdrop.map(f => f >= BACKDROP_SECTOR_MIN_FRAC));
      if (ranges) out.push(`    Terrain backdrop toward ${ranges} — drone below skyline, hard to see`);
    }
  });
  return out;
}

function buildBriefingText() {
  const sections = [
    { name: 'WEATHER', fields: ['wxTemp','wxFeels','wxDew','wxHumidity','wxPressure','wxDensity','wxVis','wxCloud','wxCeiling','wxConditions','wxPrecip','wxLightning','wxUV','wxKp','wxIcing','wxFire','wxAQI'] },
    { name: 'WIND', fields: ['windMax','windGustMax','windDir','windImpact'] },
    { name: 'AIRSPACE', fields: ['airClass','airLAANC','airLAANCAlt','airNearAirport','airNearDist'] },
    { name: 'TERRAIN', fields: ['terrMin','terrMax','terrRange','terrLaunch','terrClass','terrSlope','terrPower','terrTowers','terrVeg','terrCell'] },
    { name: 'SUN/MOON', fields: ['astSunrise','astSunset','astTwilightAM','astTwilightPM','astSunAz','astSunEl','astMoonPhase','astMoonIllum','astDayWindow','astMagDec'] },
    { name: 'GNSS', fields: ['satKp','satAccuracy','satAssessment'] },
    { name: 'OPS', fields: ['opsTempFactor','opsAltFactor','opsWindFactor','opsFlightTime','opsCapacity'] },
  ];

  const lines = [];
  lines.push('=== SAR UAS PRE-FLIGHT BRIEFING ===');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // Area info
  const center = document.getElementById('areaCenter')?.textContent || '--';
  const size = document.getElementById('areaSize')?.textContent || '--';
  const type = document.getElementById('areaType')?.textContent || '--';
  lines.push(`AREA: Center ${center} | Size ${size} | Type ${type}`);
  lines.push('');

  // Assessment
  const badge = document.getElementById('assessBadge')?.textContent || '--';
  const assessText = document.getElementById('assessText')?.textContent || '';
  lines.push(`ASSESSMENT: ${badge}`);
  if (assessText) lines.push(assessText);
  lines.push('');

  // Data sections
  sections.forEach(s => {
    lines.push(`--- ${s.name} ---`);
    s.fields.forEach(f => {
      const el = document.getElementById(f);
      if (!el) return;
      const label = el.closest('.data-cell')?.querySelector('.data-label')?.textContent || f;
      const value = el.textContent || '--';
      lines.push(`  ${label}: ${value}`);
    });
    lines.push('');
  });

  // Observers (viewshed records) — only when any are placed.
  const obsLines = _briefingObserverLines();
  if (obsLines.length) {
    lines.push('--- OBSERVERS ---');
    obsLines.forEach(l => lines.push(l));
    lines.push('');
  }

  return lines.join('\n');
}

function copyBriefing() {
  if (!S.currentArea) return;
  const text = buildBriefingText();
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btnCopy');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'COPIED';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    }
  }).catch(() => {
    // Fallback: select a hidden textarea
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch(e) { /* ignore */ }
    document.body.removeChild(ta);
  });
}

// ============================================================
// PDF BRIEFING REPORT
// ============================================================
function generatePDFBriefing() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
    return alert('jsPDF library not loaded. Check your internet connection.');
  }


  const btn = document.getElementById('btnPDF');
  if (btn) btn.textContent = 'GENERATING...';

  const rpic = document.getElementById('cfgRPIC')?.value || 'Not specified';
  const aircraft = (S.activeProfile && (S.activeProfile.model || S.activeProfile.name)) || 'Default';
  const assessBadge = document.getElementById('assessBadge')?.textContent || '--';
  const assessText = document.getElementById('assessText')?.textContent || '';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeLocal = now.toLocaleTimeString('en-US', { hour12: false, timeZone: _localTZ() });
  const timeUTC = now.toISOString().substr(11, 8);

  const briefingText = buildBriefingText();
  const sections = briefingText.split('\n\n');
  const badgeColor = assessBadge === 'GO' ? '#22c55e' : assessBadge === 'CAUTION' ? '#f59e0b' : '#ef4444';

  // Capture the map by compositing layers separately:
  // 1. html2canvas for tiles only (works correctly for <img> tiles)
  // 2. Native SVG→Image→Canvas for vector overlays (avoids html2canvas SVG transform bugs)
  // 3. Marker icons drawn from their screen positions
  const mapEl = document.getElementById('map');
  setTimeout(() => {
    _compositeMapCapture(mapEl).then(mapDataUrl => {
      S._lastMapImage = mapDataUrl;
      _buildAndExportPDF(mapDataUrl, briefingText, sections, badgeColor, rpic, aircraft, assessBadge, assessText, dateStr, timeLocal, timeUTC, btn, now);
    }).catch(err => {
      console.warn('Map capture failed, generating PDF without map:', err);
      _buildAndExportPDF(null, briefingText, sections, badgeColor, rpic, aircraft, assessBadge, assessText, dateStr, timeLocal, timeUTC, btn, now);
    });
  }, 300);
}

// Composite map capture: renders tiles via html2canvas, SVG overlays natively,
// and markers via screen position — avoids html2canvas SVG transform bugs entirely.
async function _compositeMapCapture(mapEl) {
  const mapRect = mapEl.getBoundingClientRect();
  const w = Math.round(mapRect.width);
  const h = Math.round(mapRect.height);
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Layer 1: Tiles via html2canvas (only the tile pane — html2canvas handles tiles correctly)
  try {
    const tileCanvas = await html2canvas(mapEl, {
      scale: scale,
      useCORS: true,
      allowTaint: true,
      logging: false,
      ignoreElements: (el) => {
        // Capture ONLY tiles — ignore overlays, markers, and UI controls
        return el.classList?.contains('leaflet-overlay-pane') ||
               el.classList?.contains('leaflet-marker-pane') ||
               el.classList?.contains('leaflet-tooltip-pane') ||
               el.classList?.contains('leaflet-popup-pane') ||
               el.classList?.contains('draw-toolbar') ||
               el.classList?.contains('map-info') ||
               el.classList?.contains('no-area-overlay') ||
               el.classList?.contains('layer-control') ||
               el.classList?.contains('radar-controls') ||
               el.classList?.contains('leaflet-control-zoom');
      },
    });
    ctx.drawImage(tileCanvas, 0, 0, w, h);
  } catch(e) {
    console.warn('Tile capture failed:', e);
    // Fill with dark background as fallback
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, w, h);
  }

  // Layer 2: SVG overlays rendered natively (power lines, circles, swap radius)
  const svgs = mapEl.querySelectorAll('.leaflet-overlay-pane svg');
  for (const svg of svgs) {
    try {
      const svgRect = svg.getBoundingClientRect();
      const clone = svg.cloneNode(true);
      clone.style.transform = 'none';
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const svgStr = new XMLSerializer().serializeToString(clone);
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const x = svgRect.left - mapRect.left;
      const y = svgRect.top - mapRect.top;
      ctx.drawImage(img, x, y, svgRect.width, svgRect.height);
      URL.revokeObjectURL(url);
    } catch(e) {
      console.warn('SVG overlay capture failed:', e);
    }
  }

  // Layer 3: Marker icons (airports, cell towers, heliports)
  const markerPane = mapEl.querySelector('.leaflet-marker-pane');
  if (markerPane) {
    const markers = markerPane.querySelectorAll('.leaflet-marker-icon');
    for (const marker of markers) {
      const mRect = marker.getBoundingClientRect();
      const x = mRect.left - mapRect.left;
      const y = mRect.top - mapRect.top;
      const innerSvg = marker.querySelector('svg');
      if (innerSvg) {
        try {
          const clone = innerSvg.cloneNode(true);
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          const svgStr = new XMLSerializer().serializeToString(clone);
          const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = url;
          });
          ctx.drawImage(img, x, y, mRect.width, mRect.height);
          URL.revokeObjectURL(url);
        } catch(e) {}
      }
    }
  }

  return canvas.toDataURL('image/jpeg', 0.90);
}

function _buildAndExportPDF(mapDataUrl, briefingText, sections, badgeColor, rpic, aircraft, assessBadge, assessText, dateStr, timeLocal, timeUTC, btn, now) {
  const mapHtml = mapDataUrl
    ? `<div style="margin-bottom:12px;border:1px solid #ccc;"><img src="${mapDataUrl}" style="width:100%;display:block;" /></div>`
    : '';

  // Build an off-screen styled HTML div for rendering
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0;width:750px;padding:30px 40px;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;';

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:15px;">
      <div>
        <h1 style="margin:0;font-size:20px;letter-spacing:2px;">SAR UAS PRE-FLIGHT BRIEFING</h1>
        <div style="font-size:11px;color:#555;margin-top:4px;">SAR UAS Team</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:18px;font-weight:bold;padding:4px 14px;border-radius:4px;background:${badgeColor};color:#fff;display:inline-block;">${assessBadge}</div>
      </div>
    </div>
    <table style="width:100%;font-size:11px;margin-bottom:12px;border-collapse:collapse;">
      <tr>
        <td style="padding:3px 0;"><b>Date:</b> ${dateStr}</td>
        <td style="padding:3px 0;"><b>Local:</b> ${timeLocal} ${new Date().toLocaleTimeString('en-US',{timeZoneName:'short'}).split(' ').pop()}</td>
        <td style="padding:3px 0;"><b>UTC:</b> ${timeUTC}Z</td>
      </tr>
      <tr>
        <td style="padding:3px 0;"><b>RPIC:</b> ${rpic}</td>
        <td style="padding:3px 0;"><b>Aircraft:</b> ${aircraft}</td>
        <td style="padding:3px 0;"><b>Area:</b> ${document.getElementById('areaCenter')?.textContent || '--'}</td>
      </tr>
    </table>
    <div style="margin-bottom:12px;padding:8px;background:#f0f0f0;border-left:4px solid ${badgeColor};font-size:12px;">
      <b>Assessment: ${assessBadge}</b> \u2014 ${assessText}
    </div>
    ${mapHtml}
    ${sections.map(s => {
      const lines = s.split('\n');
      const title = lines[0];
      const body = lines.slice(1).join('<br>');
      return `<div style="margin-bottom:10px;"><div style="font-size:13px;font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;margin-bottom:4px;">${title}</div><div style="font-size:11px;color:#333;">${body}</div></div>`;
    }).join('')}
    <div style="margin-top:20px;border-top:2px solid #111;padding-top:10px;">
      <div style="font-size:11px;color:#555;margin-bottom:15px;">I have reviewed this pre-flight briefing and accept responsibility for the safe conduct of this UAS operation.</div>
      <table style="width:100%;font-size:11px;">
        <tr>
          <td style="width:50%;padding-top:30px;border-top:1px solid #333;">RPIC Signature</td>
          <td style="width:50%;padding-top:30px;border-top:1px solid #333;">Date / Time</td>
        </tr>
      </table>
    </div>
  `;

  document.body.appendChild(container);

  html2canvas(container, { scale: 2, useCORS: true }).then(canvas => {
    document.body.removeChild(container);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'letter');
    const pageWidth = 215.9; // letter width mm
    const pageHeight = 279.4; // letter height mm
    const margin = 10;
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    let yOffset = margin;
    let remainingHeight = imgHeight;
    const usableHeight = pageHeight - margin * 2;

    // First page
    pdf.addImage(imgData, 'JPEG', margin, yOffset, imgWidth, imgHeight);

    // Add more pages if content overflows
    remainingHeight -= usableHeight;
    while (remainingHeight > 0) {
      pdf.addPage();
      yOffset -= usableHeight;
      pdf.addImage(imgData, 'JPEG', margin, yOffset, imgWidth, imgHeight);
      remainingHeight -= usableHeight;
    }

    const ts = now.toISOString().split('T')[0];
    pdf.save(`SAR_Briefing_${ts}.pdf`);
    if (btn) btn.textContent = 'PDF';
  }).catch(err => {
    document.body.removeChild(container);
    console.error('PDF generation error:', err);
    if (btn) btn.textContent = 'PDF';
    alert('PDF generation failed: ' + err.message);
  });
}

// ============================================================
// EMAIL SHARE
// ============================================================
function shareBriefingEmail() {
  if (!S.currentArea) return alert('Draw an operational area first.');

  // Use cached map image from PDF, or capture fresh via composite method
  if (S._lastMapImage) {
    _openEmailBriefingWindow(S._lastMapImage);
  } else {
    const mapEl = document.getElementById('map');
    if (mapEl) {
      _compositeMapCapture(mapEl).then(dataUrl => {
        S._lastMapImage = dataUrl;
        _openEmailBriefingWindow(dataUrl);
      }).catch(() => _openEmailBriefingWindow(null));
    } else {
      _openEmailBriefingWindow(null);
    }
  }
}

function _openEmailBriefingWindow(mapDataUrl) {
  const assessBadge = document.getElementById('assessBadge')?.textContent || '--';
  const assessText = document.getElementById('assessText')?.textContent || '';
  const badgeColor = assessBadge === 'GO' ? '#22c55e' : assessBadge === 'CAUTION' ? '#f59e0b' : '#ef4444';
  const rpic = document.getElementById('cfgRPIC')?.value || 'Not specified';
  const aircraft = (S.activeProfile && (S.activeProfile.model || S.activeProfile.name)) || 'Default';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: _localTZ() });
  const briefingText = buildBriefingText();
  const sections = briefingText.split('\n\n');
  const mapHtml = mapDataUrl ? `<img src="${mapDataUrl}" style="width:100%;max-width:700px;border:1px solid #ccc;margin:10px 0;" />` : '';

  const html = `<!DOCTYPE html><html><head><title>SAR Briefing - ${dateStr}</title>
    <style>body{font-family:Arial,sans-serif;max-width:750px;margin:20px auto;padding:0 20px;color:#111;font-size:13px;line-height:1.5}
    h1{font-size:20px;letter-spacing:2px;margin:0}
    .badge{display:inline-block;padding:4px 14px;border-radius:4px;color:#fff;font-weight:bold;font-size:16px}
    .section{margin-bottom:12px}.section-title{font-size:14px;font-weight:bold;border-bottom:1px solid #ccc;padding-bottom:2px;margin-bottom:4px}
    .sig-line{border-top:1px solid #333;padding-top:25px;width:45%;display:inline-block;margin-right:5%}
    @media print{body{margin:0;font-size:11px}}</style></head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:15px;">
      <div><h1>SAR UAS PRE-FLIGHT BRIEFING</h1><div style="font-size:11px;color:#555;">SAR UAS Team</div></div>
      <div><span class="badge" style="background:${badgeColor}">${assessBadge}</span></div>
    </div>
    <table style="width:100%;font-size:12px;margin-bottom:10px;"><tr>
      <td><b>Date:</b> ${dateStr}</td><td><b>Local:</b> ${timeStr}</td><td><b>RPIC:</b> ${rpic}</td><td><b>Aircraft:</b> ${aircraft}</td>
    </tr></table>
    <div style="padding:8px;background:#f0f0f0;border-left:4px solid ${badgeColor};margin-bottom:12px;">
      <b>Assessment: ${assessBadge}</b> \u2014 ${assessText}
    </div>
    ${mapHtml}
    ${sections.map(s => { const lines = s.split('\n'); return `<div class="section"><div class="section-title">${lines[0]}</div><div>${lines.slice(1).join('<br>')}</div></div>`; }).join('')}
    <div style="margin-top:20px;border-top:2px solid #111;padding-top:10px;">
      <div style="font-size:11px;color:#555;margin-bottom:15px;">I have reviewed this pre-flight briefing and accept responsibility for the safe conduct of this UAS operation.</div>
      <span class="sig-line">RPIC Signature</span><span class="sig-line">Date / Time</span>
    </div>
    <div style="margin-top:20px;text-align:center;font-size:11px;color:#888;">
      <button onclick="window.print()" style="padding:8px 20px;font-size:13px;cursor:pointer;">Print / Save as PDF</button>
      &nbsp;&nbsp;
      <button onclick="navigator.clipboard.writeText(document.body.innerText).then(()=>alert('Copied!'))" style="padding:8px 20px;font-size:13px;cursor:pointer;">Copy Text</button>
    </div></body></html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  } else {
    alert('Pop-up blocked. Allow pop-ups and try again.');
  }
}

// ============================================================
// SARTOPO DEEP LINK
// ============================================================
function openInSARTopo() {
  if (!S.areaCenter) return alert('Draw an operational area first.');
  const lat = S.areaCenter.lat.toFixed(5);
  const lng = S.areaCenter.lng.toFixed(5);
  const zoom = S.map.getZoom();
  window.open(`https://sartopo.com/map.html#ll=${lat},${lng}&z=${zoom}`, '_blank');
}

// ============================================================
// FAA CHART IMPORT
// ============================================================
async function loadFAAChart(input) {
  const file = input?.files?.[0];
  if (!file) return;
  const bar = document.getElementById('chartProgressBar');
  const text = document.getElementById('chartProgressText');

  if (typeof processVFRChart !== 'function') {
    if (text) text.textContent = 'Chart processing libraries not loaded. Check internet connection.';
    return;
  }

  try {
    const collarMargin = parseFloat(document.getElementById('chartCollarMargin')?.value || '3') / 100;
    const result = await processVFRChart(file, (msg, pct) => {
      if (bar) bar.style.width = pct + '%';
      if (text) text.textContent = msg;
    }, { collarMargin });

    const chartId = result.chartId;

    // If re-importing same chart, remove old version first
    if (S.faaCharts[chartId]) {
      await removeChart(chartId);
    }

    // Create chart-specific tile layer
    const layer = new L.TileLayer.FAAChart({
      chartId: chartId,
      minNativeZoom: result.zoomRange[0],
      maxNativeZoom: result.zoomRange[1],
      minZoom: 4,
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'FAA ' + result.chartName,
    });
    layer.addTo(S.map);

    // Register in multi-chart state
    S.faaCharts[chartId] = {
      chartId, chartName: result.chartName, layer,
      bounds: result.bounds, zoomRange: result.zoomRange,
    };
    S.mapLayers['chart_' + chartId] = layer;

    buildLayerControl();
    updateChartList();
    if (text) text.textContent = `${result.chartName}: ${result.tileCount} tiles cached (z=${result.zoomRange[0]}-${result.zoomRange[1]})`;
    _saveFaaChartsState();
  } catch (err) {
    console.error('FAA chart import error:', err);
    if (text) text.textContent = 'Error: ' + err.message;
    if (bar) bar.style.width = '0';
  }
}

// Custom Leaflet TileLayer that reads tiles from the Cache API
if (typeof L !== 'undefined' && L.TileLayer && typeof L.TileLayer.extend === 'function') {
  L.TileLayer.FAAChart = L.TileLayer.extend({
    initialize: function(options) {
      L.TileLayer.prototype.initialize.call(this, '', options || {});
    },
    getTileUrl: function(coords) {
      const ns = this.options.chartId || 'default';
      return `https://local-tiles.sar-preflight/faa-sectional-${ns}/${coords.z}/${coords.x}/${coords.y}.png`;
    },
    createTile: function(coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');
      const url = this.getTileUrl(coords);

      caches.open('sar-tiles-v1').then(cache => {
        return cache.match(url);
      }).then(response => {
        if (response) {
          return response.blob();
        }
        return null;
      }).then(blob => {
        if (blob) {
          tile.src = URL.createObjectURL(blob);
          // NOTE: this object URL is never revoked — tracked as a leak so the
          // trail shows imported-FAA-chart tile memory climbing with pan/zoom.
          try { Diag.leak('faaTileBlob', blob.size || 0); Diag.noteThrottled('faaTile', 1500, { kb: Math.round((blob.size || 0) / 1024) }); } catch (_) {}
          done(null, tile);
        } else {
          // No cached tile — return transparent
          tile.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
          done(null, tile);
        }
      }).catch(() => {
        done(new Error('Tile not found'), tile);
      });

      return tile;
    },
  });
}

// Persist multi-chart metadata to IndexedDB
function _saveFaaChartsState() {
  if (typeof saveAppState !== 'function') return;
  const data = Object.keys(S.faaCharts).map(id => ({
    chartId: id,
    chartName: S.faaCharts[id].chartName,
    bounds: S.faaCharts[id].bounds,
    zoomRange: S.faaCharts[id].zoomRange,
  }));
  saveAppState('faaCharts', data);
}

// Restore all FAA chart layers on startup
async function restoreFAACharts() {
  if (typeof getAppState !== 'function') return;
  if (!('caches' in window)) return;
  if (typeof L === 'undefined' || !L.TileLayer.FAAChart) return;

  // Load chart list (with backward-compat migration from single-chart format)
  let charts = await getAppState('faaCharts');
  if (!charts) {
    const old = await getAppState('faaChart');
    if (old) {
      const chartId = typeof sanitizeChartName === 'function' ? sanitizeChartName(old.name) : old.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().substring(0, 40);
      charts = [{ chartId, chartName: old.name, bounds: old.bounds, zoomRange: old.zoomRange }];
      saveAppState('faaCharts', charts);
    }
  }
  if (!charts || !charts.length) return;

  const cache = await caches.open('sar-tiles-v1');
  const keys = await cache.keys();

  for (const info of charts) {
    const prefix = 'local-tiles.sar-preflight/faa-sectional-' + info.chartId;
    const hasTiles = keys.some(r => r.url.includes(prefix));
    if (!hasTiles) continue;

    const layer = new L.TileLayer.FAAChart({
      chartId: info.chartId,
      minNativeZoom: info.zoomRange[0],
      maxNativeZoom: info.zoomRange[1],
      minZoom: 4,
      maxZoom: 18,
      opacity: 0.85,
      attribution: 'FAA ' + info.chartName,
    });
    S.faaCharts[info.chartId] = {
      chartId: info.chartId, chartName: info.chartName,
      layer, bounds: info.bounds, zoomRange: info.zoomRange,
    };
    S.mapLayers['chart_' + info.chartId] = layer;
  }

  updateChartList();
}

// Remove a single imported chart and its cached tiles
async function removeChart(chartId) {
  const entry = S.faaCharts[chartId];
  if (!entry) return;

  if (S.map && S.map.hasLayer(entry.layer)) S.map.removeLayer(entry.layer);
  delete S.faaCharts[chartId];
  delete S.mapLayers['chart_' + chartId];

  // Delete tiles from cache
  if ('caches' in window) {
    const cache = await caches.open('sar-tiles-v1');
    const keys = await cache.keys();
    const prefix = 'local-tiles.sar-preflight/faa-sectional-' + chartId;
    for (const req of keys) {
      if (req.url.includes(prefix)) await cache.delete(req);
    }
  }

  _saveFaaChartsState();
  updateChartList();
  buildLayerControl();
}

// Remove all imported charts
async function clearAllCharts() {
  const ids = Object.keys(S.faaCharts);
  for (const id of ids) {
    await removeChart(id);
  }
  const text = document.getElementById('chartProgressText');
  if (text) text.textContent = '';
}

// Render loaded chart list in the settings UI
function updateChartList() {
  const el = document.getElementById('chartList');
  if (!el) return;
  const ids = Object.keys(S.faaCharts);
  const btn = document.getElementById('btnClearCharts');
  if (ids.length === 0) {
    el.innerHTML = '';
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) btn.style.display = '';
  el.innerHTML = ids.map(id => {
    const c = S.faaCharts[id];
    return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text-secondary);padding:2px 0;">' +
      '<span>' + c.chartName + '</span>' +
      '<button class="btn btn-ghost" onclick="removeChart(\'' + id + '\')" style="padding:2px 6px;font-size:9px;">Remove</button>' +
      '</div>';
  }).join('');
}

// ============================================================
// AUTO-REFRESH
// ============================================================
function setAutoRefresh() {
  const el = document.getElementById('cfgRefreshInterval');
  const val = parseInt(el?.value) || 0;

  // Clear existing interval and countdown
  if (S.autoRefreshInterval) { clearInterval(S.autoRefreshInterval); S.autoRefreshInterval = null; }
  if (S._refreshCountdownInterval) { clearInterval(S._refreshCountdownInterval); S._refreshCountdownInterval = null; }
  S._nextRefreshTime = null;

  const countdownEl = document.getElementById('refreshCountdown');

  if (val > 0) {
    const ms = val * 60 * 1000;
    S._nextRefreshTime = Date.now() + ms;

    S.autoRefreshInterval = setInterval(() => {
      if (S.areaCenter) refreshData();
      S._nextRefreshTime = Date.now() + ms;
    }, ms);

    // Update countdown display every second
    S._refreshCountdownInterval = setInterval(() => {
      if (!S._nextRefreshTime) return;
      const remaining = Math.max(0, S._nextRefreshTime - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      if (countdownEl) {
        countdownEl.style.display = '';
        countdownEl.textContent = `NEXT: ${mins}m${secs < 10 ? '0' : ''}${secs}s`;
      }
    }, 1000);
  } else {
    if (countdownEl) { countdownEl.style.display = 'none'; countdownEl.textContent = ''; }
  }

  // Persist setting
  if (typeof saveAppState === 'function') saveAppState('refreshInterval', String(val));
}

// ============================================================
// SOP RISK PROFILES
// ============================================================
// Map from the legacy aircraft-dropdown codes to the new built-in profile names,
// so users who had selected an aircraft before this change keep it on upgrade.
const LEGACY_AIRCRAFT_PROFILE = {
  m4t: 'DJI Matrice 4T', m30t: 'DJI Matrice 30T', m300: 'DJI Matrice 300 RTK',
  m350: 'DJI Matrice 350 RTK', mavic3t: 'DJI Mavic 3T', skydio_x10: 'Skydio X10',
};

async function loadSopProfile(name) {
  const dd = document.getElementById('cfgSopProfile');
  if (!name) {
    S.activeProfile = null;
    if (dd) dd.value = '';
    updateSopThresholdFields();
    if (typeof saveAppState === 'function') saveAppState('activeProfile', '');
    if (S.currentArea) { computeOpsData(); computeAssessment(); }
    return;
  }
  // Built-in aircraft profiles take precedence over a saved custom of the same name.
  let profile = (typeof DRONE_PROFILES !== 'undefined') ? DRONE_PROFILES.find(p => p.name === name) : null;
  if (!profile && typeof getSopProfile === 'function') {
    profile = await getSopProfile(name);
  }
  if (profile) {
    S.activeProfile = profile;
    if (dd) dd.value = name;
    updateSopThresholdFields();
    if (typeof saveAppState === 'function') saveAppState('activeProfile', name);
    if (S.currentArea) { computeOpsData(); computeAssessment(); }
  }
}

async function saveSopProfileFromUI() {
  const name = document.getElementById('sopProfileName')?.value?.trim();
  if (!name) return alert('Enter a profile name.');
  if (typeof DRONE_PROFILES !== 'undefined' && DRONE_PROFILES.some(p => p.name === name)) {
    return alert('That name is a built-in aircraft profile — choose a different name for your custom profile.');
  }
  // Capture the full live threshold set (defaults + any edits) under this name.
  const profile = Object.assign({}, readActiveThresholds(), { name, model: name });
  if (typeof saveSopProfile === 'function') {
    await saveSopProfile(profile);
    await populateSopDropdown();
    const dd = document.getElementById('cfgSopProfile');
    if (dd) dd.value = name;
    S.activeProfile = profile;
    if (typeof saveAppState === 'function') saveAppState('activeProfile', name);
    if (S.currentArea) { computeOpsData(); computeAssessment(); }
  }
}

async function deleteSopProfileFromUI() {
  const dd = document.getElementById('cfgSopProfile');
  const name = dd?.value;
  if (!name) return;
  if (typeof DRONE_PROFILES !== 'undefined' && DRONE_PROFILES.some(p => p.name === name)) {
    return alert('Built-in aircraft profiles cannot be deleted.');
  }
  if (!confirm(`Delete profile "${name}"?`)) return;
  if (typeof deleteSopProfile === 'function') {
    await deleteSopProfile(name);
    S.activeProfile = null;
    if (typeof saveAppState === 'function') saveAppState('activeProfile', '');
    await populateSopDropdown();
    const dd2 = document.getElementById('cfgSopProfile');
    if (dd2) dd2.value = '';
    updateSopThresholdFields();
    if (S.currentArea) { computeOpsData(); computeAssessment(); }
  }
}

async function populateSopDropdown() {
  const dd = document.getElementById('cfgSopProfile');
  if (!dd) return;
  const current = dd.value;
  dd.innerHTML = '<option value="">Default</option>';
  // Built-in aircraft profiles
  if (typeof DRONE_PROFILES !== 'undefined' && DRONE_PROFILES.length) {
    const og = document.createElement('optgroup');
    og.label = 'Aircraft';
    DRONE_PROFILES.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      og.appendChild(opt);
    });
    dd.appendChild(og);
  }
  // User-saved custom profiles
  if (typeof getAllSopProfiles === 'function') {
    const profiles = await getAllSopProfiles();
    if (profiles && profiles.length) {
      const og = document.createElement('optgroup');
      og.label = 'Custom';
      profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        og.appendChild(opt);
      });
      dd.appendChild(og);
    }
  }
  if (current) dd.value = current;
}

function updateSopThresholdFields() {
  const defaults = (typeof DEFAULT_THRESHOLDS !== 'undefined') ? DEFAULT_THRESHOLDS : {};
  const src = Object.assign({}, defaults, S.activeProfile || {});
  THRESHOLD_FIELDS.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el && src[key] !== undefined) el.value = src[key];
  });
}

// ============================================================
// MISSION LOGGING
// ============================================================
async function logMission() {
  if (!S.currentArea) return alert('Draw an operational area first.');
  const notes = prompt('Mission notes (optional):') || '';
  const entry = {
    timestamp: Date.now(),
    rpic: document.getElementById('cfgRPIC')?.value || '',
    aircraft: (S.activeProfile && (S.activeProfile.model || S.activeProfile.name)) || 'Default',
    areaCenter: S.areaCenter ? { lat: S.areaCenter.lat, lng: S.areaCenter.lng } : null,
    areaType: S.areaType,
    assessment: {
      level: document.getElementById('assessBadge')?.textContent,
      text: document.getElementById('assessText')?.textContent,
    },
    wx: {
      temp: S.wx.temperature_2m,
      humidity: S.wx.relative_humidity_2m,
      pressure: S.wx.surface_pressure,
      visibility: S.wx.visibility,
      windSpeed: S.wind?.maxWind,
      windGust: S.wind?.maxGust,
      precip: S.wx.precipitation_probability,
      weatherCode: S.wx.weather_code,
    },
    elev: S.elev ? { center: S.elev.center, min: S.elev.min, max: S.elev.max, range: S.elev.range } : null,
    nwsAlerts: S.nwsAlerts?.length || 0,
    wireHazards: Object.values(S.wireHazardCounts || {}).reduce((a, b) => a + b, 0)
      + Object.values(S.utilityWireCounts || {}).reduce((a, b) => a + b, 0),
    sopProfile: S.activeProfile?.name || 'Default',
    notes: notes,
  };
  if (typeof saveMissionLog === 'function') {
    await saveMissionLog(entry);
    const btn = document.getElementById('btnLog');
    if (btn) { btn.textContent = 'LOGGED'; setTimeout(() => { btn.textContent = 'LOG'; }, 1500); }
  }
}

async function showMissionLogs() {
  if (typeof getMissionLogs !== 'function') return;
  const logs = await getMissionLogs();
  const list = document.getElementById('missionLogList');
  if (!list) return;
  if (!logs || logs.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">No mission logs recorded.</div>';
  } else {
    let html = '<table style="width:100%;border-collapse:collapse;font-family:var(--font-mono);font-size:11px;">';
    html += '<tr style="border-bottom:1px solid var(--border);color:var(--text-muted);font-size:9px;text-transform:uppercase;letter-spacing:1px;">' +
      '<th style="padding:6px;text-align:left;">Date</th><th style="padding:6px;text-align:left;">RPIC</th>' +
      '<th style="padding:6px;text-align:left;">Assessment</th><th style="padding:6px;text-align:left;">Location</th>' +
      '<th style="padding:6px;text-align:left;">Aircraft</th><th style="padding:6px;text-align:left;">Notes</th>' +
      '<th style="padding:6px;"></th></tr>';
    logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    logs.forEach(log => {
      const date = log.timestamp ? new Date(log.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '--';
      const loc = log.areaCenter ? `${log.areaCenter.lat.toFixed(3)}, ${log.areaCenter.lng.toFixed(3)}` : '--';
      const assessColor = log.assessment?.level === 'GO' ? 'var(--accent-green)' : log.assessment?.level === 'CAUTION' ? 'var(--accent-amber)' : 'var(--accent-red)';
      html += `<tr style="border-bottom:1px solid var(--border);">` +
        `<td style="padding:6px;color:var(--text-secondary);">${date}</td>` +
        `<td style="padding:6px;">${log.rpic || '--'}</td>` +
        `<td style="padding:6px;color:${assessColor};font-weight:600;">${log.assessment?.level || '--'}</td>` +
        `<td style="padding:6px;color:var(--text-secondary);">${loc}</td>` +
        `<td style="padding:6px;">${log.aircraft || '--'}</td>` +
        `<td style="padding:6px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(log.notes || '').replace(/"/g, '&quot;')}">${log.notes || '--'}</td>` +
        `<td style="padding:6px;"><button class="btn btn-ghost" style="padding:2px 6px;font-size:9px;color:var(--accent-red);" onclick="deleteMissionLogEntry(${log.id || log.timestamp})">DEL</button></td></tr>`;
    });
    html += '</table>';
    list.innerHTML = html;
  }
  document.getElementById('missionLogModal').classList.add('active');
}

function closeMissionLogModal() {
  document.getElementById('missionLogModal').classList.remove('active');
}

async function deleteMissionLogEntry(id) {
  if (!confirm('Delete this mission log entry?')) return;
  if (typeof deleteMissionLog === 'function') {
    await deleteMissionLog(id);
    await showMissionLogs();
  }
}

async function exportMissionLogsAsCSV() {
  if (typeof getMissionLogs !== 'function') return;
  const logs = await getMissionLogs();
  if (!logs || logs.length === 0) return alert('No logs to export.');
  const headers = ['Date', 'RPIC', 'Aircraft', 'Assessment', 'Lat', 'Lng', 'Area Type', 'Wind (mph)', 'Visibility', 'Temp (F)', 'SOP Profile', 'NWS Alerts', 'Wire Hazards', 'Notes'];
  const rows = logs.map(l => [
    l.timestamp ? new Date(l.timestamp).toISOString() : '',
    l.rpic || '', l.aircraft || '', l.assessment?.level || '',
    l.areaCenter?.lat?.toFixed(5) || '', l.areaCenter?.lng?.toFixed(5) || '',
    l.areaType || '', l.wx?.windSpeed || '', l.wx?.visibility || '',
    l.wx?.temp || '', l.sopProfile || '', l.nwsAlerts || 0, l.wireHazards || 0,
    (l.notes || '').replace(/"/g, '""'),
  ]);
  let csv = headers.join(',') + '\n';
  rows.forEach(r => { csv += r.map(v => `"${v}"`).join(',') + '\n'; });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `SAR_Mission_Logs_${new Date().toISOString().split('T')[0]}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// VEGETATION (CANOPY) OVERLAY + VIEWSHED
// Canopy: Meta/WRI 1 m COG tiles via a user-configured CORS proxy (Cloudflare
// Worker — see tools/canopy-proxy). DEM: USGS 3DEP exportImage (CORS-enabled).
// Line-of-sight math lives in sar-preflight-raster.js. Processed rasters are
// cached in IndexedDB so previously-viewed areas work offline.
// ============================================================

const CANOPY_OVERLAY_OPACITY = 0.6;
const VIEWSHED_OVERLAY_OPACITY = 0.5;
const SHADOW_OVERLAY_OPACITY = 0.45;
const CANOPY_MAX_M = 60;        // clamp canopy heights (guards COG fill/nodata artifacts)
// Cap the per-tile COG window read; a coarser overview is chosen if larger.
// (Meta canopy COGs turned out to have NO usable overviews, so this rarely
// helps for them — the real bound is the strip-wise read below.)
const COG_MAX_READ_PX = 1024;
// Peak decode budget for the strip-wise COG read (~128 MB at 4 bytes/px).
// GeoTIFF.js decodes the ENTIRE requested window before downsampling, and the
// Meta tiles lack overviews, so a wide AOI needs a multi-thousand-px native
// window — a 22,727×20,756 single read hit ~1.8 GB and crashed the iOS PWA.
// We read the window in row strips capped to this budget so peak stays bounded.
const CANOPY_DECODE_BUDGET_PX = 32000000;
// Skip the canopy overlay when the view half-width exceeds this (~12 km AOI):
// 1 m canopy over a wider area is hundreds of MB–GB to fetch/decode and is only
// upscaled blur at that scale, so we tell the user to zoom in instead.
const MAX_CANOPY_HALF_M = 6000;
const CANOPY_TILE_ATTEMPTS = 4; // retry a tile this many times (with backoff) on transient proxy/S3 5xx before skipping it

// ============================================================
// ANONYMOUS USAGE ANALYTICS (Cloudflare Web Analytics)
// ============================================================
// Privacy-first and SAR-safe by design:
//   • Cookieless, no personal data, no persistent ID, no fingerprinting.
//   • Country-level geography only (Cloudflare reports nothing finer); the raw
//     IP is never stored by us — it is used by Cloudflare only to derive the
//     country, then discarded.
//   • NOTHING from the map is ever sent: no GPS, no drawn operational area, no
//     observer/viewshed coordinates, no query strings. Only that the page was
//     opened.
//   • Loads only when served online over http(s). The offline single-file field
//     build (file://) and any offline session never phone home.
//   • Honors Do-Not-Track, Global Privacy Control, and the in-app opt-out.
//
// To ACTIVATE (one-time, free): in the Cloudflare dashboard go to
// Analytics & Logs → Web Analytics → "Add a site", enter the deployed hostname
// (e.g. thecoderperson.github.io). Cloudflare generates a snippet containing
//   <script ... data-cf-beacon='{"token":"<32-hex>"}'></script>
// Copy that token and paste it below. Until a token is set this is a no-op, so
// nothing is collected. One token works for both the GitHub Pages and
// Cloudflare Pages hosts (filter by "Host" in the dashboard). The token is a
// public client-side beacon id (visible in page source on any analytics site),
// not a secret — safe to commit.
const CF_ANALYTICS_TOKEN = 'a0f745c3968b4e97a7cedecda692bee7';

// User has opted out (in-app toggle) or signaled Do-Not-Track / Global Privacy
// Control via the browser. Honored before any beacon is loaded.
function analyticsOptedOut() {
  try {
    if (localStorage.getItem('sar_analytics_optout') === '1') return true;
  } catch (_) {}
  try {
    const dnt = (typeof navigator !== 'undefined' && (navigator.doNotTrack || navigator.msDoNotTrack)) ||
                (typeof window !== 'undefined' && window.doNotTrack);
    if (dnt === '1' || dnt === 'yes') return true;
    if (typeof navigator !== 'undefined' && navigator.globalPrivacyControl === true) return true;
  } catch (_) {}
  return false;
}

// Pure decision: given a token and an environment snapshot, should the beacon
// load? Kept side-effect-free so the privacy guards are unit-testable.
//   env = { protocol, hostname, online, optedOut }
function _shouldLoadAnalytics(token, env) {
  if (!token) return false;                                // not configured
  env = env || {};
  // file:// (offline single-file field build) → never phone home
  if (env.protocol !== 'http:' && env.protocol !== 'https:') return false;
  // Keep local dev out of the real numbers
  const h = env.hostname || '';
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
      h === '::1' || h === '[::1]' || h.endsWith('.local')) return false;
  if (env.online === false) return false;                  // offline
  if (env.optedOut) return false;                          // user opt-out / DNT / GPC
  return true;
}

function initUsageAnalytics() {
  try {
    if (typeof location === 'undefined' || typeof document === 'undefined') return;
    const ok = _shouldLoadAnalytics(CF_ANALYTICS_TOKEN, {
      protocol: location.protocol,
      hostname: location.hostname,
      online: (typeof navigator !== 'undefined') ? navigator.onLine : true,
      optedOut: analyticsOptedOut(),
    });
    if (!ok) return;
    const s = document.createElement('script');
    s.defer = true;
    s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: CF_ANALYTICS_TOKEN }));
    (document.head || document.documentElement).appendChild(s);
  } catch (_) { /* analytics must never break the app */ }
}

// Persist the in-app opt-out toggle (Config tab). Takes effect on next load.
function setAnalyticsOptOut(optOut) {
  try {
    if (optOut) localStorage.setItem('sar_analytics_optout', '1');
    else localStorage.removeItem('sar_analytics_optout');
  } catch (_) {}
}

// Built-in shared data proxy (maintainer's Cloudflare Worker) so the app works
// out of the box. A custom URL saved in Config overrides it; clearing the field
// returns to the default. The Worker enforces an Origin allowlist + per-IP rate
// limit, so it only serves the app's known deploy origins (see tools/canopy-proxy).
const DEFAULT_DATA_PROXY = 'https://sar-canopy-proxy.joja15.workers.dev';

// The user's own proxy URL (Config tab), or null when using the built-in default.
function getCustomProxy() {
  try {
    const v = localStorage.getItem('sar_canopy_proxy');
    return v && v.trim() ? v.trim().replace(/\/+$/, '') : null;
  } catch (_) { return null; }
}

function getCanopyProxyBase() {
  return getCustomProxy() || DEFAULT_DATA_PROXY;
}

// Build a proxied URL for a CORS-blocked self-hosted ArcGIS server (USFS/BLM).
// routePrefix is a Worker route ('/usfs/' or '/blm/'); upstreamPath is everything
// after the upstream host (e.g. 'arcx/rest/services/.../query?...'). Returns null
// when no data proxy is configured, so callers can degrade gracefully.
function proxiedArcgis(routePrefix, upstreamPath) {
  const base = getCanopyProxyBase();
  if (!base) return null;
  return base + routePrefix + String(upstreamPath || '').replace(/^\/+/, '');
}

function saveCanopyProxy(url) {
  try {
    const v = (url || '').trim().replace(/\/+$/, '');
    if (v) localStorage.setItem('sar_canopy_proxy', v);
    else localStorage.removeItem('sar_canopy_proxy');
  } catch (_) {}
  const hint = document.getElementById('canopyProxyHint');
  if (hint) hint.textContent = getCustomProxy() ? 'Custom data proxy configured ✓' : 'Using built-in default data proxy';
}

// Quantized AOI key for the processed-raster cache (~100 m).
function _aoiKey(b) {
  return [b.west, b.south, b.east, b.north].map(v => v.toFixed(3)).join('_');
}

// --- DEM: USGS 3DEP exportImage (CORS-enabled, direct) ---
async function fetch3DEPDEM(grid) {
  const b = grid.bounds;
  const cacheKey = 'dem_' + _aoiKey(b) + '_' + grid.cols + 'x' + grid.rows;
  const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
    + '?bbox=' + [b.west, b.south, b.east, b.north].join(',')
    + '&bboxSR=4326&imageSR=4326&size=' + grid.cols + ',' + grid.rows
    + '&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image';
  let buf = null;
  try {
    if (typeof isOnline !== 'function' || isOnline()) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('3DEP HTTP ' + res.status);
      buf = await res.arrayBuffer();
      if (typeof cacheRaster === 'function') cacheRaster('dem', cacheKey, { buf });
    }
  } catch (e) {
    recordDataSourceError('DEM (3DEP)', e);
  }
  if (!buf && typeof getCachedRaster === 'function') {
    const c = await getCachedRaster('dem', cacheKey);
    if (c && c.data && c.data.buf) buf = c.data.buf;
  }
  if (!buf) return { demFlat: null, source: 'unavailable' };
  const tiff = await GeoTIFF.fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const w = image.getWidth(), h = image.getHeight();
  const rasters = await image.readRasters();
  const demFlat = resampleToGrid(grid, {
    data: rasters[0], srcCols: w, srcRows: h,
    srcBounds: { west: b.west, south: b.south, east: b.east, north: b.north },
    srcIsMercator: false, nodata: null,
  });
  // 3DEP nodata is a very-negative sentinel → NaN.
  for (let i = 0; i < demFlat.length; i++) if (demFlat[i] <= -1e30) demFlat[i] = NaN;
  clearDataSourceError('DEM (3DEP)');
  return { demFlat, source: '3DEP ~' + Math.round(grid.resM) + ' m' };
}

// Replay the user's saved canopy edits (delete polygons + paint strokes) onto a
// fetched raster. Ops are geographic, so they apply to ANY grid that overlaps —
// the view overlay, every viewshed grid, 3D, exports. Works on a COPY when ops
// apply so the pristine array (possibly queued for an async IndexedDB cache
// write) is never mutated. Returns { flat, edited }.
async function _applyCanopyEdits(grid, flat) {
  try {
    if (!flat || typeof getCachedRaster !== 'function') return { flat, edited: false };
    const rec = await getCachedRaster('canopyedit', 'global');
    const ops = rec && rec.data && rec.data.ops;
    if (!Array.isArray(ops) || !ops.length) return { flat, edited: false };
    const copy = flat.slice();
    const n = canopyApplyOps(grid, copy, ops, pointInPolygon);
    return n > 0 ? { flat: copy, edited: true } : { flat, edited: false };
  } catch (_) { return { flat, edited: false }; }
}

// --- Canopy: Meta 1 m COG tiles via the proxy (online), else IndexedDB cache ---
async function fetchCanopyRaster(grid) {
  const base = getCanopyProxyBase();
  const b = grid.bounds;
  const cacheKey = 'canopy_' + _aoiKey(b) + '_' + grid.cols + 'x' + grid.rows;
  if (base && (typeof isOnline !== 'function' || isOnline())) {
    try {
      const res = await _fetchCanopyFromProxy(base, grid);
      if (res && res.canopy) {
        if (typeof cacheRaster === 'function') cacheRaster('canopy', cacheKey, { canopyArr: res.canopy });
        if (res.tilesFailed > 0) recordDataSourceError('Canopy', new Error(`${res.tilesFailed} of ${res.tilesTotal} canopy tiles failed to load (proxy/data-service errors)`));
        else clearDataSourceError('Canopy');
        const ed = await _applyCanopyEdits(grid, res.canopy);
        return { canopyFlat: ed.flat, source: 'Meta 1 m' + (ed.edited ? ' (edited)' : ''), tilesTotal: res.tilesTotal, tilesLoaded: res.tilesLoaded, tilesFailed: res.tilesFailed };
      }
    } catch (e) {
      recordDataSourceError('Canopy', e);
    }
  }
  if (typeof getCachedRaster === 'function') {
    const c = await getCachedRaster('canopy', cacheKey);
    if (c && c.data && c.data.canopyArr) {
      const ed = await _applyCanopyEdits(grid, c.data.canopyArr);
      return { canopyFlat: ed.flat, source: 'Meta 1 m (cached)' + (ed.edited ? ' (edited)' : '') };
    }
  }
  return { canopyFlat: null, source: base ? 'unavailable' : 'no proxy' };
}

async function _fetchCanopyFromProxy(base, grid) {
  const b = grid.bounds;
  const qks = metaQuadkeysForBBox(b.west, b.south, b.east, b.north);
  try { Diag.note('canopy.tiles', { qk: qks.length }); } catch (_) {}
  const canopy = new Float32Array(grid.rows * grid.cols).fill(NaN);
  let any = false, loaded = 0, failed = 0;
  for (let t = 0; t < qks.length; t++) {
    const qk = qks[t];
    const url = base + '/chm/' + qk + '.tif';
    let tileGrid = null;
    // Retry transient proxy/S3 errors: cold Range fetches of these large COGs
    // intermittently 5xx even though the tile is valid. Back off between tries.
    for (let attempt = 0; attempt < CANOPY_TILE_ATTEMPTS && tileGrid == null; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 300 * attempt)); // 300/600/900ms backoff
      try {
        const tiff = await GeoTIFF.fromUrl(url);
        tileGrid = await _cogTileToGrid(tiff, grid);
      } catch (_) { tileGrid = null; } // missing tile / CORS / transient
    }
    if (!tileGrid) {
      failed++;
      try { Diag.note('canopy.tileFail', { qk }); } catch (_) {}
      // GeoTIFF.js fetches internally, so a proxy 429 only surfaces as a thrown
      // error. Probe the tile once: if the proxy is rate-limiting this IP, flag
      // the status bar and stop — more tiles would just burn more of the limit.
      try {
        const probe = await fetch(url, { method: 'HEAD' });
        if (probe && probe.status === 429) {
          if (typeof notifyProxyRateLimited === 'function') {
            notifyProxyRateLimited(parseInt(probe.headers.get('Retry-After') || '', 10));
          }
          failed += qks.length - t - 1; // remaining tiles won't be attempted
          break;
        }
      } catch (_) { /* probe is best-effort */ }
      continue;
    }
    loaded++;
    for (let i = 0; i < canopy.length; i++) {
      if (Number.isNaN(canopy[i]) && Number.isFinite(tileGrid[i])) { canopy[i] = tileGrid[i]; any = true; }
    }
  }
  return any ? { canopy, tilesTotal: qks.length, tilesLoaded: loaded, tilesFailed: failed } : null;
}

// Read the AOI window from a (Web-Mercator) COG, choosing an overview so the read
// stays under COG_MAX_READ_PX per side, and resample onto the grid.
async function _cogTileToGrid(tiff, grid) {
  const b = grid.bounds;
  const count = await tiff.getImageCount();
  const base = await tiff.getImage(0);
  const bbox = base.getBoundingBox(); // [minX,minY,maxX,maxY] mercator metres
  const axMin = lngToMercX(b.west), axMax = lngToMercX(b.east);
  const ayMin = latToMercY(b.south), ayMax = latToMercY(b.north);
  if (axMax <= bbox[0] || axMin >= bbox[2] || ayMax <= bbox[1] || ayMin >= bbox[3]) return null; // no overlap
  const ovX = Math.max(axMin, bbox[0]), ovX2 = Math.min(axMax, bbox[2]);
  const ovY = Math.max(ayMin, bbox[1]), ovY2 = Math.min(ayMax, bbox[3]);
  // COG IFDs are ordered full-res first, then progressively coarser overviews.
  let img = base;
  for (let i = 0; i < count; i++) {
    const cand = await tiff.getImage(i);
    img = cand;
    const w = cand.getWidth(), h = cand.getHeight();
    const winW = (ovX2 - ovX) / (bbox[2] - bbox[0]) * w;
    const winH = (ovY2 - ovY) / (bbox[3] - bbox[1]) * h;
    if (Math.max(winW, winH) <= COG_MAX_READ_PX) break;
  }
  const w = img.getWidth(), h = img.getHeight();
  const resX = (bbox[2] - bbox[0]) / w, resY = (bbox[3] - bbox[1]) / h;
  let px0 = Math.max(0, Math.min(w, Math.floor((axMin - bbox[0]) / resX)));
  let px1 = Math.max(0, Math.min(w, Math.ceil((axMax - bbox[0]) / resX)));
  let py0 = Math.max(0, Math.min(h, Math.floor((bbox[3] - ayMax) / resY)));
  let py1 = Math.max(0, Math.min(h, Math.ceil((bbox[3] - ayMin) / resY)));
  if (px1 <= px0 || py1 <= py0) return null;
  // --- Strip-wise read (bounds peak decode memory) ---
  // GeoTIFF.js decodes the ENTIRE requested window before downsampling, and the
  // Meta canopy COGs have no usable overviews, so a wide AOI needs a ~22k-px
  // native window (~1.8 GB) that crashed the iOS PWA. Read the window in row
  // strips capped to CANOPY_DECODE_BUDGET_PX, resample each onto the grid and
  // free it, so peak memory stays ~128 MB regardless of AOI size.
  const winW = px1 - px0;
  const sampleW = Math.min(winW, 1024);                                  // horizontal downsample of each strip
  // Desktop has no per-tab memory ceiling, so read the whole window in one pass
  // (one readRasters = far fewer proxy Range requests, less transient-5xx
  // exposure). Mobile keeps the bounded strip budget to avoid the OOM crash.
  const budget = _isConstrained() ? CANOPY_DECODE_BUDGET_PX : Infinity;
  const stripRows = Math.max(1, Math.floor(budget / winW));              // native rows per strip within the budget
  const nStrips = Math.ceil((py1 - py0) / stripRows);
  const peakBytes = Math.min(py1 - py0, stripRows) * winW * 4;
  try { Diag.note('canopy.read', { winW, winH: py1 - py0, strips: nStrips, peakMb: Math.round(peakBytes / 1048576) }); } catch (_) {}
  const out = new Float32Array(grid.rows * grid.cols).fill(NaN);
  for (let ny = py0; ny < py1; ny += stripRows) {
    const nyEnd = Math.min(py1, ny + stripRows);
    const nativeRows = nyEnd - ny;
    const sampleH = Math.max(1, Math.min(nativeRows, Math.ceil(nativeRows * sampleW / winW)));
    const stripBytes = nativeRows * winW * 4;
    let strip;
    try {
      try { Diag.alloc('canopyDecode', stripBytes); } catch (_) {}
      strip = await img.readRasters({ window: [px0, ny, px1, nyEnd], width: sampleW, height: sampleH, resampleMethod: 'nearest', samples: [0] });
    } finally {
      try { Diag.free('canopyDecode', stripBytes); } catch (_) {}
    }
    const data = strip[0];
    // Clamp to a sane canopy range (guards COG fill/nodata artifacts).
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v) || v < 0) data[i] = 0;
      else if (v > CANOPY_MAX_M) data[i] = CANOPY_MAX_M;
    }
    const wMinX = bbox[0] + px0 * resX, wMaxX = bbox[0] + px1 * resX;
    const wTopY = bbox[3] - ny * resY, wBotY = bbox[3] - nyEnd * resY;
    const sb = { west: mercXToLng(wMinX), east: mercXToLng(wMaxX), north: mercYToLat(wTopY), south: mercYToLat(wBotY) };
    const partial = resampleToGrid(grid, { data, srcCols: sampleW, srcRows: sampleH, srcBounds: sb, srcIsMercator: true, nodata: null });
    for (let i = 0; i < out.length; i++) {
      if (Number.isNaN(out[i]) && Number.isFinite(partial[i])) out[i] = partial[i];
    }
  }
  return out;
}

// --- Render a computed raster as a semi-transparent image overlay ---
// --- Raster overlay display-size cap (iOS compositing-memory guard) ---
// A fixed-bounds L.imageOverlay (canopy/viewshed) is stretched to an enormous
// on-screen pixel size at deep zoom (a device trace caught 75,119 px at ~z18.7).
// Leaflet sizes the <img> element to that full projected size, and the
// backing-store/compositing memory — invisible to the JS heap — was crashing
// the iOS PWA. We detach the overlay while it would exceed this budget and
// re-attach it when zoomed back out. The source raster is only ~512 px, so the
// hidden zoom range showed nothing but upscaled blur anyway.
const MAX_OVERLAY_DISPLAY_PX = 4096;
function _overlayDisplayPx(layer) {
  try {
    if (!layer || !layer._bounds || !S.map) return 0;
    const ne = S.map.latLngToContainerPoint(layer._bounds.getNorthEast());
    const sw = S.map.latLngToContainerPoint(layer._bounds.getSouthWest());
    return Math.max(Math.abs(ne.x - sw.x), Math.abs(ne.y - sw.y));
  } catch (_) { return 0; }
}
function _applyOverlayZoomCap() {
  if (!S.map || !S._overlayWanted) return;
  const constrained = _isConstrained();
  ['canopy', 'viewshed', 'shadow'].forEach(id => {
    const layer = S.mapLayers[id];
    if (!layer || !S._overlayWanted[id]) return;
    // Desktop: never hide for size (no compositing-memory crash risk) — keep the
    // overlay attached at every zoom. Mobile: detach when stretched too large.
    const tooBig = constrained && _overlayDisplayPx(layer) > MAX_OVERLAY_DISPLAY_PX;
    const on = S.map.hasLayer(layer);
    if (tooBig && on) { S.map.removeLayer(layer); try { Diag.note('overlay.cap.hide', { id }); } catch (_) {} }
    else if (!tooBig && !on) { layer.addTo(S.map); }
  });
}
// During a zoom gesture Leaflet re-sizes the overlay element to the full
// projected pixel size before zoomend fires; detach first so that giant element
// is never created, then re-evaluate once the zoom settles (_applyOverlayZoomCap).
function _hideOverlaysForZoom() {
  if (!_isConstrained()) return; // desktop keeps overlays visible throughout zoom
  if (!S.map || !S._overlayWanted) return;
  ['canopy', 'viewshed', 'shadow'].forEach(id => {
    const layer = S.mapLayers[id];
    if (layer && S._overlayWanted[id] && S.map.hasLayer(layer)) S.map.removeLayer(layer);
  });
}

function renderRasterOverlay(layerId, rgba, grid, opacity) {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols; canvas.height = grid.rows;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(rgba, grid.cols, grid.rows), 0, 0);
  const url = canvas.toDataURL('image/png');
  // The prior dataURL handed to Leaflet's imageOverlay is not explicitly
  // released; count each encoded string as leaked + the transient RGBA buffer.
  try { Diag.leak('rasterDataUrl', url.length); Diag.note('overlay.render', { id: layerId, kb: Math.round(url.length / 1024) }); } catch (_) {}
  const bounds = L.latLngBounds([grid.bounds.south, grid.bounds.west], [grid.bounds.north, grid.bounds.east]);
  let layer = S.mapLayers[layerId];
  if (layer && layer.setUrl) {
    layer.setUrl(url); layer.setBounds(bounds); layer.setOpacity(opacity);
  } else {
    layer = L.imageOverlay(url, bounds, { opacity, interactive: false, className: 'raster-overlay-' + layerId });
    S.mapLayers[layerId] = layer;
  }
  if (!S._overlayWanted) S._overlayWanted = {};
  S._overlayWanted[layerId] = true;
  // Retain the encoded image + bounds so the 3D view can drape the same raster.
  if (!S._raster3d) S._raster3d = {};
  S._raster3d[layerId] = { url, bounds: grid.bounds };
  if (S.is3D && typeof sync3d === 'function') sync3d();
  _applyOverlayZoomCap(); // adds to the map only if within the display-size budget
  return layer;
}

// Each overlay has two sliders — one in the Terrain tab, one inline in the layer
// control — so whichever the user moves, push the value to the other.
function _syncOpacitySliders(v, ...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.value !== String(v)) el.value = v;
  }
}
function setCanopyOpacity(v) {
  const o = parseFloat(v);
  if (S.mapLayers.canopy && S.mapLayers.canopy.setOpacity) S.mapLayers.canopy.setOpacity(o);
  if (S._canopyEditing && S.canopyEdit && S.canopyEdit.canvas) S.canopyEdit.canvas.style.opacity = o;
  const span = document.getElementById('canopyOpacityVal');
  if (span) span.textContent = Math.round(o * 100) + '%';
  _syncOpacitySliders(v, 'canopyOpacity', 'lcCanopyOpacity');
  // 2D drape only — the 3D canopy surface renders fully opaque by design.
  if (S.is3D && typeof sync3d === 'function') sync3d();
}
function setViewshedOpacity(v) {
  const o = parseFloat(v);
  if (S.mapLayers.viewshed && S.mapLayers.viewshed.setOpacity) S.mapLayers.viewshed.setOpacity(o);
  const span = document.getElementById('viewshedOpacityVal');
  if (span) span.textContent = Math.round(o * 100) + '%';
  _syncOpacitySliders(v, 'vsOpacity', 'lcViewshedOpacity');
  if (S.is3D && typeof sync3d === 'function') sync3d();
}

// on: explicit target state (the Map Layers row drives this). Omit to flip.
async function toggleCanopyOverlay(on) {
  if (S._canopyEditing) return; // edit mode owns the canopy display
  if (on == null) on = !(S.mapLayers.canopy && S.map.hasLayer(S.mapLayers.canopy));
  if (!on) {
    if (S._overlayWanted) S._overlayWanted.canopy = false;
    if (S.mapLayers.canopy && S.map.hasLayer(S.mapLayers.canopy)) S.map.removeLayer(S.mapLayers.canopy);
    if (S.is3D && typeof sync3d === 'function') sync3d();
    buildLayerControl();
    return;
  }
  if (!getCanopyProxyBase()) {
    setStatus('canopyStatus', 'error', 'NO PROXY');
    buildLayerControl(); // revert the row the user just checked
    if (typeof alert === 'function') alert('Set a Canopy proxy URL in the Config tab first (see tools/canopy-proxy/README.md).');
    return;
  }
  // Re-showing after a toggle: if the already-loaded canopy still covers the
  // current view centre, reuse it (and the cached 3D mesh) instead of
  // refetching + re-decoding the COG tiles.
  if (S.canopy && S.canopy.grid && S.mapLayers.canopy) {
    const b = S.canopy.grid.bounds;
    const c2 = S.map.getCenter();
    if (c2.lat <= b.north && c2.lat >= b.south && c2.lng >= b.west && c2.lng <= b.east) {
      if (!S.map.hasLayer(S.mapLayers.canopy)) S.map.addLayer(S.mapLayers.canopy);
      if (!S._overlayWanted) S._overlayWanted = {};
      S._overlayWanted.canopy = true;
      buildLayerControl();
      if (S.is3D && typeof sync3d === 'function') sync3d();
      return;
    }
  }
  await loadCanopyForView();
}

async function loadCanopyForView() {
  if (!S.map) return;
  if (S._canopyEditing) return; // grid must not change mid-edit
  trackFetchStart('Canopy');
  setStatus('canopyStatus', 'loading', 'Fetching...');
  try {
    const vb = S.map.getBounds();
    const center = vb.getCenter();
    const halfWidthM = Math.max(
      center.distanceTo(L.latLng(center.lat, vb.getWest())),
      center.distanceTo(L.latLng(vb.getNorth(), center.lng))
    );
    if (_isConstrained() && halfWidthM > MAX_CANOPY_HALF_M) {
      // Mobile only: 1 m canopy over a very wide view is hundreds of MB–GB to
      // decode and only blur at that scale — guide the user to zoom in rather
      // than crash. On desktop there's no memory ceiling, so we always fetch.
      setStatus('canopyStatus', 'error', 'ZOOM IN');
      markSection('canopy', { status: 'error', error: 'Zoom in to load 1 m canopy for this view' });
      try { Diag.note('canopy.skip', { halfKm: Math.round(halfWidthM / 100) / 10 }); } catch (_) {}
      if (S._overlayWanted) S._overlayWanted.canopy = false;
      buildLayerControl(); // revert the row the user just checked
      return;
    }
    const resM = Math.max(WORK_RES_M, (2 * halfWidthM) / MAX_GRID);
    const grid = makeGrid(center.lat, center.lng, halfWidthM, resM);
    try { Diag.note('canopy.start', { z: S.map.getZoom(), cols: grid.cols, rows: grid.rows, halfKm: Math.round(halfWidthM / 100) / 10 }); } catch (_) {}
    const { canopyFlat, source, tilesFailed, tilesLoaded, tilesTotal } = await fetchCanopyRaster(grid);
    if (S._canopyEditing) return; // user entered edit mode while this load was in flight — don't fight the edit canvas
    if (!canopyFlat) {
      setStatus('canopyStatus', 'error', source === 'no proxy' ? 'NO PROXY' : 'NO DATA');
      markSection('canopy', { status: 'error', error: source === 'no proxy' ? 'No canopy proxy configured' : 'No canopy data for this view' });
      if (S._overlayWanted) S._overlayWanted.canopy = false;
      buildLayerControl(); // revert the row the user just checked
      return;
    }
    const op = parseFloat((document.getElementById('canopyOpacity') || {}).value) || CANOPY_OVERLAY_OPACITY;
    renderRasterOverlay('canopy', canopyGridToRGBA(grid, canopyFlat), grid, op);
    try { if (S.canopy && S.canopy.canopyFlat && S.canopy.canopyFlat.byteLength) Diag.free('canopyFlat', S.canopy.canopyFlat.byteLength); } catch (_) {}
    S.canopy = { grid, source, canopyFlat }; // retain pixels for GeoTIFF export
    try { Diag.alloc('canopyFlat', canopyFlat.byteLength); Diag.note('canopy.loaded', { src: source }); } catch (_) {}
    const cached = source.includes('cached');
    if (tilesFailed > 0) {
      // Some tiles failed even after retries — tell the user coverage is incomplete and why.
      setStatus('canopyStatus', 'partial', `PARTIAL ${tilesLoaded}/${tilesTotal} TILES`);
    } else {
      setStatus('canopyStatus', cached ? 'cached' : 'live', cached ? 'CACHED' : 'LIVE');
    }
    // Canopy is view-based; record when this view's overlay was loaded.
    markSection('canopy', { status: 'live', updatedAt: Date.now(), error: null });
    buildLayerControl();
  } catch (e) {
    console.error('Canopy overlay error:', e);
    recordDataSourceError('Canopy', e);
    setStatus('canopyStatus', 'error', 'ERROR');
    markSection('canopy', { status: 'error', error: e && e.message ? e.message : String(e) });
    if (S._overlayWanted) S._overlayWanted.canopy = false;
    buildLayerControl(); // revert the row the user just checked
  } finally {
    trackFetchEnd('Canopy');
  }
}

// ============================================================
// CANOPY EDIT MODE — user corrections to the canopy raster.
// Entered from the Terrain tab. Satellite base + a live edit canvas replace the
// normal canopy imageOverlay; the user deletes trees inside drawn polygons or
// paints them in with a brush. Edits are stored as geographic OPS (see
// sar-preflight-raster.js) and replayed by fetchCanopyRaster onto any grid.
// ============================================================
const CANOPY_EDIT_BRUSH_SIZES = { S: 5, M: 10, L: 20 }; // ground radius, metres

// Show exactly one of the mutually-exclusive base overlays (null → none).
function _setBaseOverlay(id) {
  ['satellite', 'topo', 'sectional'].forEach(x => {
    const layer = S.mapLayers[x];
    if (!layer) return;
    const on = x === id;
    if (on && !S.map.hasLayer(layer)) layer.addTo(S.map);
    if (!on && S.map.hasLayer(layer)) S.map.removeLayer(layer);
    document.querySelector(`[data-layer="${x}"]`)?.classList.toggle('active', on);
  });
}

async function startCanopyEdit() {
  if (S._canopyEditing || !S.map) return;
  if (S.is3D && typeof _exit3D === 'function') _exit3D();
  if (typeof cancelViewshedPick === 'function') cancelViewshedPick();
  if (S.drawHandler) { S.drawHandler.disable(); S.drawHandler = null; clearDrawBtns(); }
  if (!S.canopy || !S.canopy.canopyFlat) await loadCanopyForView();
  if (!S.canopy || !S.canopy.canopyFlat) {
    if (typeof alert === 'function') alert('Canopy data is not loaded for this view — load the vegetation overlay first, then edit.');
    return;
  }
  S.map.closePopup();
  const prevBase = ['satellite', 'topo', 'sectional'].find(id => S.mapLayers[id] && S.map.hasLayer(S.mapLayers[id])) || null;
  _setBaseOverlay('satellite');
  // The edit canvas replaces the normal canopy overlay while editing.
  if (S._overlayWanted) S._overlayWanted.canopy = false;
  if (S.mapLayers.canopy && S.map.hasLayer(S.mapLayers.canopy)) S.map.removeLayer(S.mapLayers.canopy);
  const grid = S.canopy.grid;
  const workFlat = S.canopy.canopyFlat.slice();
  const avg = canopyAvgHeight(workFlat);
  S.canopyEdit = {
    subMode: null, grid, workFlat,
    avgM: avg.avgM, brushRadiusM: CANOPY_EDIT_BRUSH_SIZES.M,
    sessionOps: [], undoStack: [],
    polyLayer: null, drawHandler: null, prevBase,
    canvas: null, off: null, _stroke: null, _raf: 0,
  };
  S._canopyEditing = true;
  try { Diag.alloc('canopyEditWork', workFlat.byteLength); Diag.note('canopyEdit.start', { cells: workFlat.length, avgM: Math.round(avg.avgM * 10) / 10 }); } catch (_) {}
  _canopyEditCanvasCreate();
  _canopyEditPointerAttach();
  document.querySelector('.map-container')?.classList.add('mode-canopy-edit');
  setCanopyEditSubMode('pan');
  _canopyEditFlash('BRUSH paints trees at ' + Math.round(mToFt(S.canopyEdit.avgM)) + ' ft · POLY deletes them');
}

function exitCanopyEdit(force) {
  const ce = S.canopyEdit;
  if (!ce) return;
  if (!force && ce.sessionOps.length && typeof confirm === 'function'
      && !confirm('Discard unsaved canopy edits?')) return;
  _canopyEditPointerDetach();
  if (ce.drawHandler) { try { ce.drawHandler.disable(); } catch (_) {} ce.drawHandler = null; }
  _canopyEditDiscardPoly();
  if (ce._raf) { cancelAnimationFrame(ce._raf); ce._raf = 0; }
  if (ce._onMapMove) { S.map.off('move resize', ce._onMapMove); S.map.off('zoomstart', ce._onZoomStart); S.map.off('zoomend', ce._onZoomEnd); }
  if (ce.canvas) ce.canvas.remove();
  const el = S.map.getContainer();
  S.map.dragging.enable();
  if (S.map.touchZoom) S.map.touchZoom.enable();
  if (S.map.doubleClickZoom) S.map.doubleClickZoom.enable();
  el.style.cursor = ''; el.style.touchAction = '';
  _setBaseOverlay(ce.prevBase);
  document.querySelector('.map-container')?.classList.remove('mode-canopy-edit');
  try { Diag.free('canopyEditWork', ce.workFlat.byteLength); Diag.note('canopyEdit.exit', { saved: !ce.sessionOps.length }); } catch (_) {}
  S._canopyEditing = false;
  S.canopyEdit = null;
  _canopyEditBarSync(); // hides the toolbar
  // Restore the normal canopy overlay from app state (reflects edits iff saved).
  if (S.canopy && S.canopy.canopyFlat) {
    const op = parseFloat((document.getElementById('canopyOpacity') || {}).value) || CANOPY_OVERLAY_OPACITY;
    renderRasterOverlay('canopy', canopyGridToRGBA(S.canopy.grid, S.canopy.canopyFlat), S.canopy.grid, op);
  }
  buildLayerControl();
}

function setCanopyEditSubMode(mode) {
  const ce = S.canopyEdit;
  if (!ce) return;
  if (ce.drawHandler) { try { ce.drawHandler.disable(); } catch (_) {} ce.drawHandler = null; }
  if (mode !== 'polygonEdit') _canopyEditDiscardPoly();
  ce.subMode = mode;
  ce._stroke = null;
  const el = S.map.getContainer();
  if (mode === 'brush') {
    S.map.dragging.disable();
    if (S.map.touchZoom) S.map.touchZoom.disable();
    if (S.map.doubleClickZoom) S.map.doubleClickZoom.disable();
    el.style.cursor = 'crosshair';
    el.style.touchAction = 'none';
  } else {
    S.map.dragging.enable();
    if (S.map.touchZoom) S.map.touchZoom.enable();
    if (S.map.doubleClickZoom) S.map.doubleClickZoom.enable();
    el.style.cursor = mode === 'polygon' ? 'crosshair' : '';
    el.style.touchAction = '';
  }
  if (mode === 'polygon') {
    ce.drawHandler = new L.Draw.Polygon(S.map, {
      shapeOptions: { color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.1, dashArray: '6,4' },
      allowIntersection: false,
    });
    ce.drawHandler.enable();
  }
  _canopyEditBarSync();
}

function setCanopyBrushSize(radiusM) {
  const ce = S.canopyEdit;
  if (!ce) return;
  ce.brushRadiusM = radiusM;
  _canopyEditBarSync();
}

// Completed edit-mode polygon (routed from the global CREATED handler):
// keep it on the map with draggable vertices until DELETE or CANCEL.
function onCanopyEditPolygon(layer) {
  const ce = S.canopyEdit;
  if (!ce) return;
  ce.drawHandler = null; // L.Draw disables itself after CREATED
  layer.setStyle({ color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.12, dashArray: '6,4' });
  layer.addTo(S.map);
  if (layer.editing && layer.editing.enable) layer.editing.enable(); // draggable vertex handles
  ce.polyLayer = layer;
  ce.subMode = 'polygonEdit';
  S.map.getContainer().style.cursor = '';
  _canopyEditBarSync();
  _canopyEditFlash('Drag vertices to refine, then DELETE trees inside — or CANCEL');
}

function canopyEditDelete() {
  const ce = S.canopyEdit;
  if (!ce || !ce.polyLayer) return;
  const ring = (ce.polyLayer.getLatLngs()[0] || []).map(p => [p.lat, p.lng]);
  _canopyEditDiscardPoly();
  if (ring.length >= 3) {
    const diff = canopyApplyDelete(ce.grid, ce.workFlat, ring, pointInPolygon);
    // Keep the op even when no displayed cells changed: finer viewshed grids may
    // still have (1 m source) trees inside this polygon that the op must clear.
    _canopyEditPushOp({ t: 'del', poly: ring }, diff);
    _canopyEditRepaintIndices(diff.indices);
    _canopyEditFlash(diff.indices.length ? 'Deleted ' + diff.indices.length + ' tree cells' : 'No trees in polygon (delete saved for finer grids)');
  }
  setCanopyEditSubMode('pan');
}

function canopyEditCancelPoly() {
  const ce = S.canopyEdit;
  if (!ce) return;
  setCanopyEditSubMode('pan'); // discards the pending polygon / in-progress draw
}

function _canopyEditDiscardPoly() {
  const ce = S.canopyEdit;
  if (!ce || !ce.polyLayer) return;
  try {
    if (ce.polyLayer.editing && ce.polyLayer.editing.disable) ce.polyLayer.editing.disable();
    S.map.removeLayer(ce.polyLayer);
  } catch (_) {}
  ce.polyLayer = null;
}

function _canopyEditPushOp(op, sparseDiff) {
  const ce = S.canopyEdit;
  ce.sessionOps.push(op);
  ce.undoStack.push({ op, diff: sparseDiff });
  if (ce.undoStack.length > 20) ce.undoStack.shift(); // oldest becomes un-undoable; op itself stays
  _canopyEditBarSync();
}

function canopyEditUndo() {
  const ce = S.canopyEdit;
  if (!ce || !ce.undoStack.length) return;
  const entry = ce.undoStack.pop();
  canopyRevertDiff(ce.workFlat, entry.diff);
  const i = ce.sessionOps.indexOf(entry.op);
  if (i >= 0) ce.sessionOps.splice(i, 1);
  _canopyEditRepaintIndices(entry.diff.indices);
  _canopyEditBarSync();
}

async function canopyEditSave() {
  const ce = S.canopyEdit;
  if (!ce) return;
  if (!ce.sessionOps.length) { _canopyEditFlash('No changes to save'); return; }
  try {
    let ops = [];
    if (typeof getCachedRaster === 'function') {
      const rec = await getCachedRaster('canopyedit', 'global');
      if (rec && rec.data && Array.isArray(rec.data.ops)) ops = rec.data.ops;
    }
    ops = ops.concat(ce.sessionOps);
    if (typeof cacheRaster === 'function') await cacheRaster('canopyedit', 'global', { ops });
    // Adopt the edited raster into app state. New object identity on purpose —
    // the 3D canopy mesh cache is keyed by it and must invalidate.
    const src = (S.canopy && S.canopy.source) || 'Meta 1 m';
    S.canopy = { grid: ce.grid, source: src.includes('(edited)') ? src : src + ' (edited)', canopyFlat: ce.workFlat.slice() };
    const n = ce.sessionOps.length;
    ce.sessionOps = [];
    ce.undoStack = [];
    try { Diag.note('canopyEdit.save', { ops: n, total: ops.length }); } catch (_) {}
    setStatus('canopyStatus', 'cached', 'EDITED');
    _canopyEditFlash('Saved ' + n + ' edit' + (n === 1 ? '' : 's') + ' — recompute viewsheds to apply' + (ops.length > 400 ? ' (many edits stored — consider Clear canopy edits in Config)' : ''));
  } catch (e) {
    console.error('Canopy edit save failed:', e);
    _canopyEditFlash('SAVE FAILED — edits kept in this session');
  }
  _canopyEditBarSync();
}

// Config-tab escape hatch: forget every saved edit and restore original data.
async function clearCanopyEdits() {
  if (S._canopyEditing) { if (typeof alert === 'function') alert('Exit canopy edit mode first.'); return; }
  if (typeof confirm === 'function' && !confirm('Remove ALL saved canopy edits and restore original vegetation data?')) return;
  try { if (typeof cacheRaster === 'function') await cacheRaster('canopyedit', 'global', { ops: [] }); } catch (_) {}
  try { Diag.note('canopyEdit.clear', {}); } catch (_) {}
  // Re-fetch the current view so the overlay reverts immediately.
  if (S.canopy && S.canopy.canopyFlat) await loadCanopyForView();
}

// --- Edit canvas: container-anchored <canvas> painted from an offscreen
// grid-resolution canvas. Replaces the imageOverlay while editing so brush
// strokes repaint in ~0 ms (no PNG encode) and deep zoom is exempt from the
// mobile overlay display-size cap (the screen canvas never exceeds the view).
function _canopyEditCanvasCreate() {
  const ce = S.canopyEdit;
  const off = document.createElement('canvas');
  off.width = ce.grid.cols; off.height = ce.grid.rows;
  off.getContext('2d').putImageData(new ImageData(canopyGridToRGBA(ce.grid, ce.workFlat), ce.grid.cols, ce.grid.rows), 0, 0);
  ce.off = off;
  // The canvas must live INSIDE the map pane: the pane's transform creates a
  // stacking context, so a sibling of it can only render fully above or fully
  // below the whole map. A custom pane at z 350 sits above base tiles (200)
  // but below vector overlays (400), keeping the edit polygon + its vertex
  // handles visible on top of the drape.
  let pane = S.map.getPane && S.map.getPane('canopyEditPane');
  if (!pane && S.map.createPane) {
    pane = S.map.createPane('canopyEditPane');
    pane.style.zIndex = 350;
    pane.style.pointerEvents = 'none';
  }
  const canvas = document.createElement('canvas');
  canvas.id = 'canopyEditCanvas';
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  canvas.style.opacity = parseFloat((document.getElementById('canopyOpacity') || {}).value) || CANOPY_OVERLAY_OPACITY;
  (pane || S.map.getContainer()).appendChild(canvas);
  ce.canvas = canvas;
  ce._onMapMove = () => _canopyEditRedraw();
  ce._onZoomStart = () => { if (ce.canvas) ce.canvas.style.visibility = 'hidden'; };
  ce._onZoomEnd = () => { if (ce.canvas) { ce.canvas.style.visibility = ''; _canopyEditRedraw(); } };
  S.map.on('move resize', ce._onMapMove);
  S.map.on('zoomstart', ce._onZoomStart);
  S.map.on('zoomend', ce._onZoomEnd);
  _canopyEditRedraw();
}

function _canopyEditRedraw() {
  const ce = S.canopyEdit;
  if (!ce || !ce.canvas) return;
  const el = S.map.getContainer();
  const w = el.clientWidth, h = el.clientHeight;
  if (ce.canvas.width !== w) ce.canvas.width = w;
  if (ce.canvas.height !== h) ce.canvas.height = h;
  // The pane is positioned in layer coords — re-pin the canvas to the viewport
  // so drawing can use plain container coordinates.
  if (L.DomUtil && L.DomUtil.setPosition && S.map.containerPointToLayerPoint) {
    L.DomUtil.setPosition(ce.canvas, S.map.containerPointToLayerPoint([0, 0]));
  }
  const ctx = ce.canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const b = ce.grid.bounds;
  const nw = S.map.latLngToContainerPoint([b.north, b.west]);
  const se = S.map.latLngToContainerPoint([b.south, b.east]);
  ctx.imageSmoothingEnabled = false; // crisp cells, no blur between tree/no-tree
  ctx.drawImage(ce.off, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
}

// Refresh offscreen pixels for a dirty cell rect from workFlat, then redraw.
function _canopyEditRepaintRect(r0, r1, c0, c1) {
  const ce = S.canopyEdit;
  if (!ce || !ce.off || r1 < r0 || c1 < c0) return;
  const g = ce.grid;
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  const ctx = ce.off.getContext('2d');
  const img = ctx.getImageData(c0, r0, w, h);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const col = canopyColorRamp(ce.workFlat[r * g.cols + c]);
      const o = ((r - r0) * w + (c - c0)) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = col[3];
    }
  }
  ctx.putImageData(img, c0, r0);
  if (!ce._raf) ce._raf = requestAnimationFrame(() => { ce._raf = 0; _canopyEditRedraw(); });
}

function _canopyEditRepaintIndices(indices) {
  const ce = S.canopyEdit;
  if (!ce || !indices || !indices.length) return;
  const cols = ce.grid.cols;
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1;
  for (let i = 0; i < indices.length; i++) {
    const r = (indices[i] / cols) | 0, c = indices[i] % cols;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
  }
  _canopyEditRepaintRect(r0, r1, c0, c1);
}

// --- Brush: capture-phase pointer handlers on the map container. Only active
// in the brush sub-mode; PAN/POLY sub-modes let events flow to Leaflet.
function _canopyEditPointerAttach() {
  const ce = S.canopyEdit;
  const el = S.map.getContainer();
  const stampRect = (aLat, aLng, bLat, bLng) => {
    const g = ce.grid;
    const dLat = ce.brushRadiusM / g.mPerDegLat, dLng = ce.brushRadiusM / g.mPerDegLng;
    _canopyEditRepaintRect(
      gridLatToRow(g, Math.max(aLat, bLat) + dLat), gridLatToRow(g, Math.min(aLat, bLat) - dLat),
      gridLngToCol(g, Math.min(aLng, bLng) - dLng), gridLngToCol(g, Math.max(aLng, bLng) + dLng));
  };
  ce._onDown = e => {
    if (!S._canopyEditing || ce.subMode !== 'brush' || e.isPrimary === false) return;
    e.preventDefault(); e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    const ll = S.map.mouseEventToLatLng(e);
    ce._stroke = { pts: [[ll.lat, ll.lng]], diff: new Map(), last: ll, lastRec: ll };
    canopyStampBrush(ce.grid, ce.workFlat, ll.lat, ll.lng, ce.brushRadiusM, ce.avgM, ce._stroke.diff);
    stampRect(ll.lat, ll.lng, ll.lat, ll.lng);
  };
  ce._onMove = e => {
    const st = ce._stroke;
    if (!st) return;
    e.preventDefault(); e.stopPropagation();
    const ll = S.map.mouseEventToLatLng(e);
    const g = ce.grid, a = st.last;
    const dist = Math.hypot((ll.lat - a.lat) * g.mPerDegLat, (ll.lng - a.lng) * g.mPerDegLng);
    if (dist <= 0) return;
    // Stamp along the segment at radius/2 steps — same spacing canopyApplyStroke
    // uses on replay, so the live result matches the persisted op.
    const step = Math.max(ce.brushRadiusM / 2, 0.5);
    const nSteps = Math.max(1, Math.ceil(dist / step));
    for (let s = 1; s <= nSteps; s++) {
      const t = s / nSteps;
      canopyStampBrush(g, ce.workFlat, a.lat + (ll.lat - a.lat) * t, a.lng + (ll.lng - a.lng) * t, ce.brushRadiusM, ce.avgM, st.diff);
    }
    stampRect(a.lat, a.lng, ll.lat, ll.lng);
    st.last = ll;
    // Thin the recorded polyline — replay interpolates, so radius/4 spacing is enough.
    const recDist = Math.hypot((ll.lat - st.lastRec.lat) * g.mPerDegLat, (ll.lng - st.lastRec.lng) * g.mPerDegLng);
    if (recDist >= ce.brushRadiusM / 4) { st.pts.push([ll.lat, ll.lng]); st.lastRec = ll; }
  };
  ce._onUp = e => {
    const st = ce._stroke;
    if (!st) return;
    e.preventDefault(); e.stopPropagation();
    ce._stroke = null;
    if (st.last !== st.lastRec) st.pts.push([st.last.lat, st.last.lng]);
    _canopyEditPushOp({ t: 'paint', pts: st.pts, rM: ce.brushRadiusM, hM: Math.round(ce.avgM * 100) / 100 }, canopyDiffToSparse(st.diff));
  };
  ce._onTouchGuard = e => { if (S._canopyEditing && ce.subMode === 'brush') e.preventDefault(); };
  el.addEventListener('pointerdown', ce._onDown, true);
  el.addEventListener('pointermove', ce._onMove, true);
  el.addEventListener('pointerup', ce._onUp, true);
  el.addEventListener('pointercancel', ce._onUp, true);
  el.addEventListener('touchstart', ce._onTouchGuard, { capture: true, passive: false });
}

function _canopyEditPointerDetach() {
  const ce = S.canopyEdit;
  if (!ce || !ce._onDown || !S.map) return;
  const el = S.map.getContainer();
  el.removeEventListener('pointerdown', ce._onDown, true);
  el.removeEventListener('pointermove', ce._onMove, true);
  el.removeEventListener('pointerup', ce._onUp, true);
  el.removeEventListener('pointercancel', ce._onUp, true);
  el.removeEventListener('touchstart', ce._onTouchGuard, { capture: true });
}

// --- Toolbar state sync + transient messages ---
function _canopyEditBarSync() {
  const ce = S.canopyEdit;
  const bar = document.getElementById('canopyEditBar');
  if (!bar) return;
  if (!ce) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const mode = ce.subMode;
  document.getElementById('ceBtnPan')?.classList.toggle('active', mode === 'pan');
  document.getElementById('ceBtnBrush')?.classList.toggle('active', mode === 'brush');
  document.getElementById('ceBtnPoly')?.classList.toggle('active', mode === 'polygon' || mode === 'polygonEdit');
  const sizes = document.getElementById('ceBrushSizes');
  if (sizes) sizes.style.display = mode === 'brush' ? 'flex' : 'none';
  Object.entries(CANOPY_EDIT_BRUSH_SIZES).forEach(([k, m]) =>
    document.getElementById('ceSize' + k)?.classList.toggle('active', ce.brushRadiusM === m));
  const polyActions = document.getElementById('cePolyActions');
  if (polyActions) polyActions.style.display = mode === 'polygonEdit' ? 'flex' : 'none';
  const undo = document.getElementById('ceBtnUndo');
  if (undo) undo.disabled = !ce.undoStack.length;
  const save = document.getElementById('ceBtnSave');
  if (save) save.disabled = !ce.sessionOps.length;
}

function _canopyEditFlash(msg) {
  const el = document.getElementById('canopyEditMsg');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ============================================================
// SUN SHADOW OVERLAY — terrain-cast shade at the time bar's hour.
// View-based like the canopy overlay: fetch a 3DEP DEM for the current map
// view once, then recompute the (cheap, O(cells)) shadow sweep whenever the
// forecast time bar is scrubbed. Bare-earth terrain only — tree/building
// shade is NOT modeled.
// ============================================================

// The time the shadow (and the rest of the time-scrubbed UI) represents:
// the time bar's selected hour when available, else now.
function _shadowTime() {
  const hourly = S.wx && S.wx.hourly;
  if (hourly && hourly.time && hourly.time.length && S.timeIdx != null && hourly.time[S.timeIdx] != null) {
    return new Date(hourly.time[S.timeIdx]);
  }
  return new Date();
}

function setShadowOpacity(v) {
  const o = parseFloat(v);
  if (S.mapLayers.shadow && S.mapLayers.shadow.setOpacity) S.mapLayers.shadow.setOpacity(o);
  const span = document.getElementById('shadowOpacityVal');
  if (span) span.textContent = Math.round(o * 100) + '%';
  _syncOpacitySliders(v, 'shadowOpacity', 'lcShadowOpacity');
  if (S.is3D && typeof sync3d === 'function') sync3d();
}

// on: explicit target state (the Map Layers row drives this). Omit to flip.
async function toggleShadowOverlay(on) {
  if (on == null) on = !(S.mapLayers.shadow && S.map.hasLayer(S.mapLayers.shadow));
  if (!on) {
    if (S._overlayWanted) S._overlayWanted.shadow = false;
    if (S.mapLayers.shadow && S.map.hasLayer(S.mapLayers.shadow)) S.map.removeLayer(S.mapLayers.shadow);
    if (S.is3D && typeof sync3d === 'function') sync3d();
    buildLayerControl();
    return;
  }
  // Re-showing after a toggle: if the loaded DEM still covers the current view
  // centre, just recompute for the current hour instead of refetching.
  if (S.shadow && S.shadow.grid && S.shadow.demFlat) {
    const b = S.shadow.grid.bounds;
    const c2 = S.map.getCenter();
    if (c2.lat <= b.north && c2.lat >= b.south && c2.lng >= b.west && c2.lng <= b.east) {
      _renderShadowForTime();
      buildLayerControl();
      return;
    }
  }
  await loadShadowForView();
}

async function loadShadowForView() {
  if (!S.map) return;
  trackFetchStart('Sun shadow');
  setStatus('shadowStatus', 'loading', 'Fetching...');
  try {
    const vb = S.map.getBounds();
    const center = vb.getCenter();
    const halfWidthM = Math.max(
      center.distanceTo(L.latLng(center.lat, vb.getWest())),
      center.distanceTo(L.latLng(vb.getNorth(), center.lng))
    );
    // One capped-size exportImage request regardless of view width (unlike the
    // 1 m canopy COGs), so no zoom guard is needed — wide views just go coarse.
    const resM = Math.max(WORK_RES_M, (2 * halfWidthM) / MAX_GRID);
    const grid = makeGrid(center.lat, center.lng, halfWidthM, resM);
    const dem = await fetch3DEPDEM(grid);
    if (!dem.demFlat) {
      setStatus('shadowStatus', 'error', 'NO DEM');
      if (S._overlayWanted) S._overlayWanted.shadow = false;
      buildLayerControl(); // revert the row the user just checked
      return;
    }
    S.shadow = { grid, demFlat: dem.demFlat, source: dem.source };
    _renderShadowForTime();
    buildLayerControl();
  } catch (e) {
    console.error('Sun shadow overlay error:', e);
    recordDataSourceError('Sun shadow', e);
    setStatus('shadowStatus', 'error', 'ERROR');
    if (S._overlayWanted) S._overlayWanted.shadow = false;
    buildLayerControl(); // revert the row the user just checked
  } finally {
    trackFetchEnd('Sun shadow');
  }
}

// Compute + paint the shadow mask for the currently selected hour. Cheap
// enough (single O(cells) sweep over the resident DEM) to run per scrub tick.
function _renderShadowForTime() {
  if (!S.shadow || !S.shadow.grid || !S.shadow.demFlat) return;
  const grid = S.shadow.grid;
  const t = _shadowTime();
  const sun = calcSunPosition(grid.lat0, grid.lng0, t);
  const mask = computeShadowMask(grid, S.shadow.demFlat, sun.azimuth, sun.elevation);
  S.shadow.mask = mask;
  S.shadow.sun = sun;
  S.shadow.timeMs = t.getTime();
  const op = parseFloat((document.getElementById('shadowOpacity') || {}).value) || SHADOW_OVERLAY_OPACITY;
  renderRasterOverlay('shadow', shadowMaskToRGBA(grid, mask), grid, op);
  const night = !(sun.elevation > 0);
  setStatus('shadowStatus', 'live', night ? 'NIGHT' : `SUN ${Math.round(sun.azimuth)}° ↑${Math.round(sun.elevation)}°`);
  const res = document.getElementById('shadowResult');
  if (res) {
    // mask holds graded shade depth (0..255) — weight partially shaded cells.
    let shaded = 0, known = 0;
    for (let i = 0; i < mask.length; i++) { if (Number.isFinite(S.shadow.demFlat[i])) { known++; shaded += mask[i] / 255; } }
    const pct = known ? Math.round(shaded / known * 100) : 0;
    const when = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: _localTZ() });
    res.textContent = night
      ? `${when}: sun below horizon — all terrain shaded (${S.shadow.source})`
      : `${when}: ${pct}% of view in shade (${S.shadow.source})`;
  }
}

// Time-bar hook: recompute the mask for the newly scrubbed hour (debounced —
// the scrubber fires on every mousemove).
function _updateShadowForTime() {
  if (!S.shadow || !S._overlayWanted || !S._overlayWanted.shadow) return;
  clearTimeout(S._shadowTimeTimer);
  S._shadowTimeTimer = setTimeout(_renderShadowForTime, 120);
}

// ============================================================
// PARCELS — live assessor-parcel vector layer (view-driven, zoom-gated).
// Two-tier source registry in core.js (PARCEL_REGISTRY): county GIS where a
// verified Tier 1 endpoint exists (El Dorado), CA statewide DWR/LightBox
// everywhere else. Both are CORS-open ArcGIS servers queried DIRECT (no proxy).
// Degradation ladder (design §12): tier1 → tier2 → IndexedDB cache → an
// EXPLICIT "unavailable" chip — an empty parcel layer must never read as
// "this area is all public land". Planning intelligence only, not survey data.
// ============================================================
const PARCEL_DEBOUNCE_MS = 400;

async function loadParcelsForView() {
  if (!S.map || !S._parcelsWanted) return;
  const zoom = S.map.getZoom();
  if (zoom < PARCEL_MIN_ZOOM) { // gate: a wider view would blow past the servers' record caps
    S.mapLayers.parcels.clearLayers();
    _setParcelChip({ zoom, gateZoom: PARCEL_MIN_ZOOM });
    buildLayerControl();
    return;
  }
  if (S._parcelAbort) { try { S._parcelAbort.abort(); } catch (_) {} }
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  S._parcelAbort = ctl;
  const gen = S._parcelGen = (S._parcelGen || 0) + 1; // staleness guard alongside the abort
  _setParcelChip({ zoom, gateZoom: PARCEL_MIN_ZOOM, loading: true });
  const b = S.map.getBounds();
  const bbox = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  const sources = parcelSourcesForBounds(PARCEL_REGISTRY, bbox);
  let failedTier1 = false;
  for (const cfg of sources) {
    const cacheKey = cfg.id + '_' + _bboxCacheKey(b);
    const r = await _fetchGeoJsonLayer('parcels', cacheKey, parcelQueryUrl(cfg, bbox), ctl ? { signal: ctl.signal } : undefined);
    if (gen !== S._parcelGen || (r && r.error === 'aborted')) return; // superseded by a newer pan
    if (r && r.features && r.features.length) {
      const truncated = !!r.exceededTransferLimit || r.features.length >= cfg.maxRecordCount;
      const n = _renderParcels(r.features, cfg);
      _setParcelChip({ zoom, gateZoom: PARCEL_MIN_ZOOM, cfg, count: n, truncated,
        fromCache: r.fromCache, cachedAt: r.cachedAt, failedTier1 });
      buildLayerControl();
      return;
    }
    if (r && r.features && !r.features.length && cfg.tier === 2) {
      // Statewide layer answered with a genuine empty result — say so explicitly.
      S.mapLayers.parcels.clearLayers();
      _setParcelChip({ zoom, gateZoom: PARCEL_MIN_ZOOM, cfg, count: 0 });
      buildLayerControl();
      return;
    }
    if (cfg.tier === 1) failedTier1 = true; // error OR empty county result → fall through to statewide
  }
  // Every rung failed, cache included → explicit empty state (never silent blank).
  S.mapLayers.parcels.clearLayers();
  _setParcelChip({ unavailable: true });
  buildLayerControl();
}

// Moveend hook — attached once in initMap; no-ops while the layer is off.
function _parcelsOnMoveEnd() {
  if (!S._parcelsWanted) return;
  if (S._parcelMoveT) clearTimeout(S._parcelMoveT);
  S._parcelMoveT = setTimeout(loadParcelsForView, PARCEL_DEBOUNCE_MS);
}

// Neutral thin outline + near-invisible fill (design §8): the layer must not
// compete with hazard / land-status / terrain overlays. No labels — APN lives
// in the tap popup only.
const PARCEL_STYLE = { color: '#9ca3af', weight: 0.75, opacity: 0.55, fillColor: '#9ca3af', fillOpacity: 0.06 };

function _renderParcels(features, cfg) {
  const parcels = normalizeParcels(features, cfg, Date.now());
  S.mapLayers.parcels.clearLayers();
  parcels.forEach(p => {
    try {
      const layer = L.geoJSON({ type: 'Feature', geometry: p.geometry, properties: {} }, { style: PARCEL_STYLE });
      layer.bindPopup(_parcelPopup(p)); // popup aggregation picks this up automatically
      S.mapLayers.parcels.addLayer(layer);
    } catch (_) { /* one bad geometry must not kill the layer */ }
  });
  return parcels.length;
}

function _parcelPopup(p) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lines = [`<b style="color:#9ca3af">Parcel ${p.apn ? esc(p.apn) : '(no APN)'}</b>`];
  const situs = [p.situsAddress, p.city, p.zip].filter(Boolean).map(esc).join(', ');
  if (situs) lines.push(situs);
  const detail = [
    p.acreage != null ? `${p.acreage} ac` : null,
    p.landUseDesc ? esc(p.landUseDesc) : null,
  ].filter(Boolean).join(' · ');
  if (detail) lines.push(detail);
  const extras = [
    p.yearBuilt ? `Built ${esc(p.yearBuilt)}` : null,
    p.jurisdiction ? esc(p.jurisdiction) : null,
    p.fireDistrict ? `Fire: ${esc(p.fireDistrict)}` : null,
  ].filter(Boolean).join(' · ');
  if (extras) lines.push(`<span style="font-size:10px">${extras}</span>`);
  lines.push(`<span style="font-size:10px;opacity:0.65">${esc(p.sourceLabel)} · fetched ${relAge(p.fetchedAt, Date.now()) || '<1m'} ago</span>`);
  lines.push(`<span style="font-size:10px;color:var(--accent-amber,#f59e0b)">Planning use only — not survey accurate. Field-verify boundaries.</span>`);
  return lines.join('<br>');
}

// Provenance chip over the map — visible whenever the layer is on. This is the
// §12 ladder's voice: zoom gate, loading, tier/cache provenance, truncation,
// and the mandatory unavailable state.
function _setParcelChip(st) {
  const el = document.getElementById('parcelChip');
  if (!el) return;
  if (!st) { el.style.display = 'none'; return; }
  const c = parcelChipState(Object.assign({ nowMs: Date.now() }, st));
  el.textContent = c.text;
  el.className = 'parcel-chip ' + c.tone;
  el.style.display = '';
}

// One-time disclaimer (design §9): planning only, not survey accurate. Shown on
// first layer enable, acknowledged forever (unlike the versioned app disclaimer).
function maybeShowParcelDisclaimer() {
  try {
    if (localStorage.getItem('sar_parcel_disclaimer_ack')) return;
  } catch (_) { return; }
  document.getElementById('parcelDisclaimerModal')?.classList.add('active');
}

function ackParcelDisclaimer() {
  try { localStorage.setItem('sar_parcel_disclaimer_ack', '1'); } catch (_) {}
  document.getElementById('parcelDisclaimerModal')?.classList.remove('active');
}

// --- Viewshed: tap-to-pick observer + compute ---
function _readVsInputs() {
  const aglFt = parseFloat((document.getElementById('vsAgl') || {}).value) || 200;
  const vlosFt = parseFloat((document.getElementById('vsVlos') || {}).value) || 2500;
  return { aglFt, vlosFt };
}

// Dashed ring showing how far the VLOS range actually reaches at the current map
// scale — as a cursor ghost while picking, and permanently around every placed
// observer (touch devices never fire mousemove, so the placed rings are the only
// guide there).
const VLOS_RING_STYLE = { color: '#5ec522', weight: 1.5, dashArray: '5,7', fillColor: '#5ec522', fillOpacity: 0.04, interactive: false };

function startViewshedPick() {
  if (S._canopyEditing) return; // observer pick is disabled in canopy edit mode
  if (S.is3D && typeof _exit3D === 'function') _exit3D(); // observer pick is a 2D map tap
  // Mutually exclusive with the draw tools.
  if (S.drawHandler) { S.drawHandler.disable(); S.drawHandler = null; }
  clearDrawBtns();
  S._viewshedPicking = true;
  document.getElementById('vsPickBtnMap')?.classList.add('active');
  document.getElementById('vsPickBtn')?.classList.add('active');
  if (S.map) S.map.getContainer().style.cursor = 'crosshair';
  const { vlosFt } = _readVsInputs();
  setStatus('viewshedStatus', 'loading', `TAP MAP · VLOS ${vlosFt} ft`);
  // Own mousemove handler rather than folding into the cursor-coordinate one in
  // initMap — that one runs a debounced elevation fetch we don't want to touch.
  if (S.map && !S._vlosMove) {
    S._vlosMove = e => _updateVlosGhost(e.latlng);
    S.map.on('mousemove', S._vlosMove);
  }
}

// Lazily created on the first cursor move, so it never flashes at a stale point.
function _updateVlosGhost(latlng) {
  if (!S.map || typeof L === 'undefined' || typeof L.circle !== 'function') return;
  const radius = ftToM(_readVsInputs().vlosFt);
  if (!S._vlosGhost) {
    S._vlosGhost = L.circle(latlng, Object.assign({ radius }, VLOS_RING_STYLE));
    S._vlosGhost.addTo(S.map); // bare on the map, NOT in S.mapLayers — invisible to popup aggregation, export and the 3D mirror
    return;
  }
  S._vlosGhost.setLatLng(latlng);
  if (S._vlosGhost.getRadius() !== radius) S._vlosGhost.setRadius(radius);
}

// Live-resize the ghost while the VLOS field is being edited mid-pick.
function _onVlosInputChange() {
  if (!S._viewshedPicking || !S._vlosGhost) return;
  const radius = ftToM(_readVsInputs().vlosFt);
  if (S._vlosGhost.getRadius() !== radius) S._vlosGhost.setRadius(radius);
  const { vlosFt } = _readVsInputs();
  setStatus('viewshedStatus', 'loading', `TAP MAP · VLOS ${vlosFt} ft`);
}

function cancelViewshedPick() {
  S._viewshedPicking = false;
  document.getElementById('vsPickBtnMap')?.classList.remove('active');
  document.getElementById('vsPickBtn')?.classList.remove('active');
  if (S.map) S.map.getContainer().style.cursor = '';
  if (S.map && S._vlosMove) { S.map.off('mousemove', S._vlosMove); }
  S._vlosMove = null;
  if (S._vlosGhost) {
    if (S.map && S.map.hasLayer(S._vlosGhost)) S.map.removeLayer(S._vlosGhost);
    S._vlosGhost = null;
  }
}

function genViewshedId() {
  return 'vs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function _currentAreaKey() {
  return (S.areaCenter && typeof areaKey === 'function') ? areaKey(S.areaCenter.lat, S.areaCenter.lng) : null;
}

function _ensureObserverLayer() {
  if (!S.mapLayers.observers) {
    S.mapLayers.observers = L.layerGroup();
    if (S.map) S.mapLayers.observers.addTo(S.map);
  }
  // VLOS rings ride in their OWN group, not alongside the markers: a big circle
  // inside `observers` would be hit-tested by the aggregated popup and match
  // every click inside it. Shown/hidden in lockstep via the observers toggle.
  if (!S.mapLayers.observer_rings) {
    S.mapLayers.observer_rings = L.layerGroup();
    if (S.map && S.map.hasLayer(S.mapLayers.observers)) S.mapLayers.observer_rings.addTo(S.map);
  }
  return S.mapLayers.observers;
}

// One ring per observer, each at ITS OWN stored vlosFt — editing the #vsVlos
// field must not move rings for observers already placed.
function _renderObserverRings() {
  if (typeof L === 'undefined' || typeof L.circle !== 'function') return;
  _ensureObserverLayer();
  const g = S.mapLayers.observer_rings;
  if (!g || !g.clearLayers) return;
  g.clearLayers();
  for (const rec of (S.viewsheds || [])) {
    if (!rec || !rec.observer) continue;
    g.addLayer(L.circle([rec.observer.lat, rec.observer.lng],
      Object.assign({ radius: ftToM(rec.vlosFt) }, VLOS_RING_STYLE)));
  }
}

const BACKDROP_SECTOR_MIN_FRAC = 0.5; // sector flagged when most in-VLOS positions sit below the skyline
const HORIZON_RADIUS_M = 10000;       // terrain-horizon DEM reach (sun-blocking ridges)
const HORIZON_RES_M = 40;             // coarse is fine for skyline angles at km ranges

// Today's sun-glare windows formatted for the observer popup:
// "06:10–08:40 brg 050°–115°". The sun-elevation ceiling comes from the
// observer's own AGL/VLOS (glareMaxElevation); the bearing range is the
// sun's azimuth track across the window widened by the glare cone on each
// side — looking anywhere in that range during the window means tracking
// the drone in/near the glare disc.
// → { text } (windows exist), { shielded: true } (the sun crosses the glare
// band astronomically but surrounding terrain hides it the whole time — a
// deep canyon/cirque), or null (no low-sun crossing at all, e.g. polar day).
function _glareAdvisory(rec) {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const maxEl = glareMaxElevation(ftToM(rec.aglFt), ftToM(rec.vlosFt));
  const open = sunGlareWindows(rec.observer.lat, rec.observer.lng, day, { maxElDeg: maxEl });
  if (!open.length) return null;
  const wins = sunGlareWindows(rec.observer.lat, rec.observer.lng, day, { maxElDeg: maxEl, horizon: rec.horizon || null });
  if (!wins.length) return { shielded: true };
  const tz = (typeof _localTZ === 'function') ? _localTZ() : undefined;
  const fmt = t => t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  const brg = b => String(Math.round(((b % 360) + 360) % 360)).padStart(3, '0') + '°';
  return { text: wins.map(w =>
    `${fmt(w.start)}–${fmt(w.end)} brg ${brg(w.azStart - GLARE_CONE_DEG)}–${brg(w.azEnd + GLARE_CONE_DEG)}`
  ).join(' · ') };
}

// String form for the briefing and CalTopo export descriptions.
function _glareAdvisoryText(rec) {
  const g = _glareAdvisory(rec);
  if (!g) return '';
  return g.shielded ? 'none — surrounding terrain hides the low sun' : g.text;
}

function _observerPopupHtml(rec) {
  const cov = rec.coverage == null
    ? (rec.computedAt && !(rec.grid && rec.mask) ? 'no terrain (not computed)' : '')
    : Math.round(rec.coverage * 100) + '% of VLOS visible';
  let html = `<b>${_esc(rec.name || 'Observer')}</b><br>Drone ${rec.aglFt} ft AGL · VLOS ${rec.vlosFt} ft`
    + (cov ? `<br>${_esc(cov)}` : '');
  try {
    const glare = _glareAdvisory(rec);
    if (glare && glare.shielded) {
      html += `<br>☀ No low-sun glare today — surrounding terrain hides the sun below the glare band<br><span style="opacity:0.65">(near-overhead passes can still glare)</span>`;
    } else if (glare && glare.text) {
      html += `<br>☀ Glare risk today ${_esc(glare.text)}<br><span style="opacity:0.65">(near-overhead passes can glare any time the sun is up)</span>`;
    }
  } catch (e) { /* advisory only */ }
  if (rec.backdrop) {
    const ranges = formatSectorRanges(rec.backdrop.map(f => f >= BACKDROP_SECTOR_MIN_FRAC));
    if (ranges) html += `<br>⛰ Terrain backdrop toward ${_esc(ranges)} — drone below skyline, hard to see`;
  }
  return html;
}

function _addObserverMarker(rec) {
  if (typeof L === 'undefined' || !L.marker) return null;
  _ensureObserverLayer();
  const m = L.marker([rec.observer.lat, rec.observer.lng], { draggable: true, title: rec.name || 'Observer', featId: rec.id });
  if (m.bindPopup) m.bindPopup(_observerPopupHtml(rec));
  if (m.on) m.on('dragend', () => {
    const p = m.getLatLng();
    const r = S.viewsheds.find(x => x.id === rec.id);
    if (!r) return;
    r.observer = { lat: p.lat, lng: p.lng };
    _renderObserverRings(); // ring follows the marker immediately, before the recompute
    setActiveViewshed(r.id);
    runViewshed(r.id);
  });
  if (m.on) m.on('click', () => {
    if (S._viewshedPicking) return; // pick-mode click places a NEW observer
    toggleViewshedVisible(rec.id);
  });
  rec._marker = m;
  S.mapLayers.observers.addLayer(m);
  return m;
}

// Strip runtime-only fields before persisting to IndexedDB.
function _toPersistable(rec) {
  return {
    id: rec.id, areaKey: rec.areaKey, name: rec.name, observer: rec.observer,
    aglFt: rec.aglFt, vlosFt: rec.vlosFt, grid: rec.grid, mask: rec.mask,
    coverage: rec.coverage, demSource: rec.demSource, canopySource: rec.canopySource,
    buildingCount: rec.buildingCount != null ? rec.buildingCount : null,
    backdrop: rec.backdrop || null,
    horizon: rec.horizon || null,
    computedAt: rec.computedAt, visible: rec.visible !== false,
  };
}

// Map-click handler when "Add Observer" is armed: append a record + compute it.
function onViewshedMapClick(latlng) {
  cancelViewshedPick();
  const { aglFt, vlosFt } = _readVsInputs();
  const names = S.viewsheds.map(r => r.name);
  const name = uniqueViewshedName('Observer ' + (S.viewsheds.length + 1), names);
  const rec = makeViewshedRecord({
    id: genViewshedId(), areaKey: _currentAreaKey(), name,
    observer: { lat: latlng.lat, lng: latlng.lng }, aglFt, vlosFt,
  });
  if (!rec) return;
  S.viewsheds.push(rec);
  S.activeViewshedId = rec.id;
  if (typeof saveAppState === 'function') saveAppState('activeViewshedId', rec.id);
  _addObserverMarker(rec);
  renderObserverList();
  buildLayerControl(); // the Observers row appears with the first observer, even if the compute fails
  runViewshed(rec.id);
}

function _vsProgress(frac) {
  const pb = document.getElementById('vsProgressBar');
  if (pb) pb.style.width = Math.round(frac * 100) + '%';
}

// Paint the union of every visible record's stored mask into the single
// viewshed overlay (compositeViewsheds — no recompute). Removes the overlay
// when no visible record has a computed mask yet.
function _renderVisibleViewsheds() {
  const vis = S.viewsheds.filter(rec => rec.visible !== false);
  const computed = vis.filter(rec => rec.grid && rec.mask);
  const r = document.getElementById('vsResult');
  if (!computed.length) {
    if (S._overlayWanted) S._overlayWanted.viewshed = false;
    if (S.mapLayers.viewshed && S.map && S.map.hasLayer(S.mapLayers.viewshed)) S.map.removeLayer(S.mapLayers.viewshed);
    if (S.is3D && typeof sync3d === 'function') sync3d();
    if (r) {
      const rec = vis.find(x => x.id === S.activeViewshedId) || vis[0] || null;
      r.textContent = rec ? `${rec.name}: ${rec.computedAt ? 'terrain unavailable — no viewshed' : 'computing…'}` : '';
    }
    buildLayerControl();
    return;
  }
  const comp = compositeViewsheds(computed);
  const op = parseFloat((document.getElementById('vsOpacity') || {}).value) || VIEWSHED_OVERLAY_OPACITY;
  renderRasterOverlay('viewshed', viewshedMaskToRGBA(comp.grid, comp.mask), comp.grid, op);
  if (r) {
    const rec = computed.find(x => x.id === S.activeViewshedId) || computed[computed.length - 1];
    const canLabel = rec.canopySource ? ('canopy ' + rec.canopySource) : 'bare earth (no canopy)';
    const bldLabel = rec.buildingCount != null ? ` · ${rec.buildingCount} OSM bldgs` : '';
    r.textContent = `${rec.name}: ${Math.round((rec.coverage || 0) * 100)}% of ${rec.vlosFt} ft VLOS visible @ ${rec.aglFt} ft AGL · DEM ${rec.demSource} · ${canLabel}${bldLabel}`
      + (computed.length > 1 ? ` · ${computed.length} viewsheds shown (darker green = overlap)` : '');
  }
  buildLayerControl();
}

// Select an observer and make sure its viewshed is shown (instant — reads the
// stored mask). Other visible viewsheds stay on.
function setActiveViewshed(id) {
  const rec = S.viewsheds.find(r => r.id === id);
  if (rec && rec.visible === false) {
    rec.visible = true;
    if (typeof saveViewshed === 'function') saveViewshed(_toPersistable(rec));
  }
  S.activeViewshedId = id;
  if (typeof saveAppState === 'function') saveAppState('activeViewshedId', id);
  _renderVisibleViewsheds();
  renderObserverList();
}

// Marker/list tap: toggle this observer's viewshed on/off — several can be
// shown at once (the overlay drapes their union).
function toggleViewshedVisible(id) {
  const rec = S.viewsheds.find(r => r.id === id);
  if (!rec) return;
  rec.visible = rec.visible === false;
  if (rec.visible) {
    S.activeViewshedId = id;
    if (typeof saveAppState === 'function') saveAppState('activeViewshedId', id);
  }
  if (typeof saveViewshed === 'function') saveViewshed(_toPersistable(rec));
  _renderVisibleViewsheds();
  renderObserverList();
}

function recomputeViewshed(id) {
  const rec = S.viewsheds.find(r => r.id === id);
  if (!rec) return;
  const { aglFt, vlosFt } = _readVsInputs();
  rec.aglFt = aglFt; rec.vlosFt = vlosFt;
  setActiveViewshed(id);
  runViewshed(id);
}

function renameViewshed(id, name) {
  const rec = S.viewsheds.find(r => r.id === id);
  if (!rec) return;
  const others = S.viewsheds.filter(r => r.id !== id).map(r => r.name);
  rec.name = uniqueViewshedName(name, others);
  if (rec._marker && rec._marker.setPopupContent) rec._marker.setPopupContent(_observerPopupHtml(rec));
  if (typeof saveViewshed === 'function') saveViewshed(_toPersistable(rec));
  renderObserverList();
  if (rec.visible !== false) _renderVisibleViewsheds(); // name shows in the result line
}

function renameViewshedPrompt(id) {
  const rec = S.viewsheds.find(r => r.id === id);
  if (!rec) return;
  const name = (typeof prompt === 'function') ? prompt('Observer name:', rec.name) : null;
  if (name != null && String(name).trim()) renameViewshed(id, String(name).trim());
}

// App-level delete handler (named removeViewshed to avoid shadowing offline's deleteViewshed CRUD).
function removeViewshed(id) {
  const idx = S.viewsheds.findIndex(r => r.id === id);
  if (idx < 0) return;
  if (S.observerView && S.observerView.id === id) exitObserverView();
  const rec = S.viewsheds[idx];
  if (rec._marker && S.mapLayers.observers) S.mapLayers.observers.removeLayer(rec._marker);
  S.viewsheds.splice(idx, 1);
  if (typeof deleteViewshed === 'function') deleteViewshed(id);
  if (S.activeViewshedId === id) {
    const next = S.viewsheds[idx] || S.viewsheds[idx - 1] || null;
    S.activeViewshedId = next ? next.id : null;
    if (typeof saveAppState === 'function') saveAppState('activeViewshedId', S.activeViewshedId);
  }
  _renderVisibleViewsheds(); // repaint the composite without the removed mask
  renderObserverList();
  buildLayerControl();
}

function clearAllViewsheds() {
  if (S.observerView) exitObserverView();
  if (S.mapLayers.observers) S.mapLayers.observers.clearLayers();
  if (S.mapLayers.viewshed && S.map && S.map.hasLayer(S.mapLayers.viewshed)) S.map.removeLayer(S.mapLayers.viewshed);
  if (typeof clearViewsheds === 'function') clearViewsheds(_currentAreaKey());
  S.viewsheds = [];
  S.activeViewshedId = null;
  if (typeof saveAppState === 'function') saveAppState('activeViewshedId', null);
  setStatus('viewshedStatus', '', '');
  const r = document.getElementById('vsResult'); if (r) r.textContent = '';
  const pb = document.getElementById('vsProgressBar'); if (pb) pb.style.width = '0';
  renderObserverList();
  buildLayerControl();
}

// Render the observer list UI (one row per record).
function renderObserverList() {
  // Chokepoint for add / remove / rename / visibility — keep the VLOS rings with it.
  _renderObserverRings();
  const el = document.getElementById('vsObserverList');
  if (!el) return;
  if (!S.viewsheds.length) {
    el.innerHTML = '<div style="font-size:10px;color:var(--text-muted);padding:4px 0;">No observers yet — tap “Add Observer”, then tap the map.</div>';
    return;
  }
  el.innerHTML = S.viewsheds.map(r => {
    const shown = r.visible !== false;
    const cov = r.coverage == null
      ? (r.computedAt ? (r.grid && r.mask ? '' : 'no DEM') : 'pending…')
      : Math.round(r.coverage * 100) + '%';
    return `<div class="vs-obs-row${shown ? ' active' : ''}" data-id="${r.id}">`
      + `<span class="vs-obs-name" title="Rename" onclick="renameViewshedPrompt('${r.id}')">${_esc(r.name)}</span>`
      + `<span class="vs-obs-cov">${_esc(cov)}</span>`
      + `<span class="vs-obs-actions">`
      + `<button title="${shown ? 'Hide' : 'Show'}" onclick="toggleViewshedVisible('${r.id}')">${shown ? '◉' : '○'}</button>`
      + `<button title="Recompute" onclick="recomputeViewshed('${r.id}')">↻</button>`
      + `<button title="Delete" onclick="removeViewshed('${r.id}')">✕</button>`
      + `</span></div>`;
  }).join('');
}

// Restore this area's saved viewsheds from IndexedDB (markers + active overlay,
// repainted from the stored mask — no DEM/canopy refetch, no recompute). Idempotent.
async function restoreViewsheds() {
  if (typeof getAllViewsheds !== 'function') return;
  const ak = _currentAreaKey();
  if (S.mapLayers.observers) S.mapLayers.observers.clearLayers();
  if (S.mapLayers.observer_rings) S.mapLayers.observer_rings.clearLayers();
  if (S.mapLayers.viewshed && S.map && S.map.hasLayer(S.mapLayers.viewshed)) S.map.removeLayer(S.mapLayers.viewshed);
  S.viewsheds = [];
  let recs = [];
  try { recs = await getAllViewsheds(ak); } catch (e) { recs = []; }
  const legacy = []; // records saved before the visible flag existed
  recs.forEach(raw => {
    const rec = makeViewshedRecord(raw);
    if (!rec) return;
    if (raw.visible === undefined) legacy.push(rec);
    S.viewsheds.push(rec);
    try { if (rec.mask && rec.mask.length) Diag.alloc('viewshedMask', rec.mask.length); } catch (_) {}
    _addObserverMarker(rec);
  });
  try { Diag.note('viewshed.restore', { n: S.viewsheds.length, maskKb: Math.round((S.viewsheds || []).reduce((a, r) => a + ((r.mask && r.mask.length) || 0), 0) / 1024) }); } catch (_) {}
  let activeId = null;
  if (typeof getAppState === 'function') { try { activeId = await getAppState('activeViewshedId'); } catch (e) { /* ignore */ } }
  if (!S.viewsheds.find(r => r.id === activeId)) activeId = S.viewsheds.length ? S.viewsheds[S.viewsheds.length - 1].id : null;
  S.activeViewshedId = activeId;
  legacy.forEach(rec => { rec.visible = rec.id === activeId; }); // preserve the old single-overlay look
  _renderVisibleViewsheds();
  renderObserverList();
  buildLayerControl();
}

// OSM buildings for a viewshed grid — stamped onto the DSM as solid obstacles.
// Separate from the 3D view's fetchBuildings state machine (different bbox,
// no layer side effects) but shares the Overpass helper, parser, and the
// osm_buildings IndexedDB cache. Buildings are an advisory enhancement, so
// the wait is hard-capped: _overpassFetch walks 3 mirrors with no client
// timeout and must never stall the viewshed. Resolves null when OSM can't
// answer in time and nothing is cached — the compute then runs terrain +
// canopy only.
const BUILDINGS_FETCH_TIMEOUT_MS = 12000;
async function fetchBuildingsForGrid(grid) {
  const gb = grid.bounds;
  const bboxKey = `${gb.south.toFixed(3)}_${gb.west.toFixed(3)}_${gb.north.toFixed(3)}_${gb.east.toFixed(3)}`;
  // Short server-side timeout too — a busy mirror should fail fast, not queue.
  const query = `[out:json][timeout:10];way["building"](${gb.south},${gb.west},${gb.north},${gb.east});out body ${_buildingsCap()};>;out skel qt;`;
  try {
    const data = await Promise.race([
      _overpassFetch(query),
      new Promise((_, rej) => setTimeout(() => rej(new Error('buildings fetch timed out')), BUILDINGS_FETCH_TIMEOUT_MS)),
    ]);
    if (typeof cacheApiResponse === 'function') cacheApiResponse('osm_buildings', bboxKey, data);
    return parseOverpassBuildings(data, _buildingsCap());
  } catch (err) {
    try {
      const cached = (typeof getCachedApiResponse === 'function') ? await getCachedApiResponse('osm_buildings', bboxKey) : null;
      if (cached && cached.data) return parseOverpassBuildings(cached.data, _buildingsCap());
    } catch (cacheErr) { /* fall through */ }
    return null; // unavailable — advisory enhancement only
  }
}

async function runViewshed(id) {
  const rec = S.viewsheds.find(r => r.id === id);
  if (!rec) return;
  if (S._viewshedRunningId) { rec._pendingRecompute = true; return; }
  S._viewshedRunningId = id;
  trackFetchStart('Viewshed');
  setStatus('viewshedStatus', 'loading', 'Computing...');
  const obs = rec.observer;
  const aglFt = rec.aglFt, vlosFt = rec.vlosFt;
  try { Diag.note('viewshed.start', { vlosFt, aglFt, n: S.viewsheds.length }); } catch (_) {}
  try {
    const vlosM = ftToM(vlosFt), aglM = ftToM(aglFt);
    const halfWidthM = vlosM + 50;
    const resM = Math.max(WORK_RES_M, (2 * halfWidthM) / MAX_GRID);
    const grid = makeGrid(obs.lat, obs.lng, halfWidthM, resM);
    // Wide, coarse bare-earth grid (~10 km) purely for the terrain horizon —
    // a ridge well beyond VLOS can still hide the rising/setting sun.
    const hGrid = makeGrid(obs.lat, obs.lng, HORIZON_RADIUS_M, HORIZON_RES_M);
    _vsProgress(0.05);
    const [demRes, canRes, bldRes, horRes] = await Promise.allSettled([
      fetch3DEPDEM(grid), fetchCanopyRaster(grid), fetchBuildingsForGrid(grid), fetch3DEPDEM(hGrid)]);
    const dem = demRes.status === 'fulfilled' ? demRes.value : { demFlat: null, source: 'unavailable' };
    const can = canRes.status === 'fulfilled' ? canRes.value : { canopyFlat: null, source: 'unavailable' };
    const blds = bldRes.status === 'fulfilled' ? bldRes.value : null; // null = OSM unavailable
    const horDem = (horRes.status === 'fulfilled' && horRes.value && horRes.value.demFlat) ? horRes.value.demFlat : null;
    if (!dem.demFlat) {
      setStatus('viewshedStatus', 'error', 'NO DEM');
      rec.grid = null; rec.mask = null; rec.coverage = null;
      rec.demSource = 'unavailable'; rec.canopySource = can.canopyFlat ? can.source : null;
      rec.buildingCount = null;
      rec.backdrop = null;
      rec.horizon = null;
      rec.computedAt = Date.now();
      if (typeof saveViewshed === 'function') await saveViewshed(_toPersistable(rec));
      if (rec.visible !== false) _renderVisibleViewsheds();
      renderObserverList();
      return;
    }
    _vsProgress(0.2);
    const n = grid.rows * grid.cols;
    const dsmRaw = buildDSM(dem.demFlat, can.canopyFlat, n);
    // Buildings become solid obstacles: dsm = max(dsm, ground + building height).
    rec.buildingCount = blds ? stampBuildingsOnDSM(grid, dsmRaw, dem.demFlat, blds) : null;
    const dsm = sanitizeForKernel(dsmRaw, n);
    const { col: obsCol, row: obsRow } = latLngToCell(grid, obs.lat, obs.lng);
    const mask = await _runViewshedKernel({ grid, dem: dem.demFlat, dsm, obsCol, obsRow, aglM, vlosRangeM: vlosM });
    // Sectors where a VISIBLE drone would sit below the terrain skyline
    // (terrain backdrop — hard to keep in sight). The skyline is seeded per
    // sector with the bare-earth horizon BEYOND the viewshed grid (from the
    // wide DEM) so a mountainside rising past VLOS still counts. Cheap: 16 rays.
    const farHor = horDem ? computeHorizonProfile(hGrid, horDem, obs.lat, obs.lng, undefined, 22.5, halfWidthM) : null;
    rec.backdrop = computeBackdropSectors({
      grid, dem: dem.demFlat, dsm, obsCol, obsRow, aglM, vlosRangeM: vlosM,
      mask, farHorizonDeg: farHor ? farHor.angles : null,
    });
    // Terrain horizon out to ~10 km — masks glare windows where a ridge
    // actually hides the sun. Advisory: null when the wide DEM didn't load.
    rec.horizon = horDem ? computeHorizonProfile(hGrid, horDem, obs.lat, obs.lng) : null;
    try { if (rec.mask && rec.mask.length) Diag.free('viewshedMask', rec.mask.length); } catch (_) {}
    rec.grid = grid;
    rec.mask = mask;
    try { Diag.alloc('viewshedMask', mask.length); } catch (_) {}
    rec.coverage = viewshedCoverage(grid, mask, obsCol, obsRow, vlosM);
    rec.demSource = dem.source;
    rec.canopySource = can.canopyFlat ? can.source : null;
    rec.computedAt = Date.now();
    if (rec._marker && rec._marker.setPopupContent) rec._marker.setPopupContent(_observerPopupHtml(rec));
    if (typeof saveViewshed === 'function') await saveViewshed(_toPersistable(rec));
    if (rec.visible !== false) _renderVisibleViewsheds();
    setStatus('viewshedStatus', 'live', 'DONE');
    _vsProgress(1);
    renderObserverList();
    buildLayerControl();
  } catch (e) {
    console.error('Viewshed error:', e);
    recordDataSourceError('Viewshed', e);
    setStatus('viewshedStatus', 'error', 'ERROR');
  } finally {
    S._viewshedRunningId = null;
    trackFetchEnd('Viewshed');
    try { Diag.note('viewshed.end', { n: S.viewsheds.length }); } catch (_) {}
    // Run the next queued compute — ANY record, not just this one (a second
    // observer added while this one computed queues on its own record).
    const next = S.viewsheds.find(r => r._pendingRecompute);
    if (next) { next._pendingRecompute = false; runViewshed(next.id); }
  }
}

// Cooperative (UI-yielding) viewshed kernel — reuses the pure isVisible math so
// it stays in sync with the unit-tested computeViewshed in sar-preflight-raster.js.
async function _runViewshedKernel(opts) {
  const { grid, dem, dsm, obsCol, obsRow, aglM, vlosRangeM } = opts;
  const cols = grid.cols, rows = grid.rows, cellSizeM = grid.resM;
  const out = new Uint8Array(rows * cols);
  const obsIdx = obsRow * cols + obsCol;
  const obsGround = dem[obsIdx];
  if (!Number.isFinite(obsGround)) return out;
  const pilotZ = obsGround + PILOT_EYE_M;
  const vlosCells = vlosRangeM / cellSizeM;
  const vlosCells2 = vlosCells * vlosCells;
  const rMin = Math.max(0, Math.floor(obsRow - vlosCells));
  const rMax = Math.min(rows - 1, Math.ceil(obsRow + vlosCells));
  const cMin = Math.max(0, Math.floor(obsCol - vlosCells));
  const cMax = Math.min(cols - 1, Math.ceil(obsCol + vlosCells));
  out[obsIdx] = 1;
  for (let row = rMin; row <= rMax; row++) {
    for (let col = cMin; col <= cMax; col++) {
      const dc = col - obsCol, dr = row - obsRow;
      if (dc * dc + dr * dr > vlosCells2) continue;
      const idx = row * cols + col;
      if (idx === obsIdx) continue;
      const g = dem[idx];
      if (!Number.isFinite(g)) continue;
      if (isVisible(obsCol, obsRow, pilotZ, col, row, g + aglM, dsm, cols, rows, cellSizeM)) out[idx] = 1;
    }
    if ((row - rMin) % 16 === 0) {
      _vsProgress(0.2 + 0.78 * (row - rMin) / Math.max(1, rMax - rMin));
      await new Promise(requestAnimationFrame);
    }
  }
  return out;
}

// ============================================================
// 3D TERRAIN VIEW (MapLibre GL)
// Opt-in second view: real terrain (AWS Terrarium DEM tiles) with the same
// raster layers the 2D map is showing draped over it — basemap, satellite/
// topo/sectional, hillshade, streets, canopy + viewshed. Vector
// overlays, radar and the draw tools stay 2D; entering a draw/viewshed-pick
// tool drops back to 2D automatically. Online-only planning aid: the
// MapLibre engine + terrain tiles come from the network on first use, so
// the library is lazy-loaded here instead of shipping in the app shell.
// ============================================================
const MAPLIBRE_JS_URL = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js';
const MAPLIBRE_CSS_URL = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.css';
const TERRAIN_EXAGGERATION = 1.15;

let _mlLoadPromise = null;
function _loadMaplibre() {
  if (typeof maplibregl !== 'undefined') return Promise.resolve();
  if (_mlLoadPromise) return _mlLoadPromise;
  _mlLoadPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = MAPLIBRE_CSS_URL;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = MAPLIBRE_JS_URL;
    js.onload = () => resolve();
    js.onerror = () => { _mlLoadPromise = null; reject(new Error('maplibre load failed')); };
    document.head.appendChild(js);
  });
  return _mlLoadPromise;
}

// Vector layers mirrored into 3D: everything the popup aggregation covers,
// minus live ADS-B (Phase 3 — needs per-poll updates + altitude placement).
const VEC3D_SKIP = new Set([...AGG_SKIP_LAYERS, 'adsb_aircraft', 'parcels']); // parcels: thousands of view-driven polygons — not mirrored into 3D

// Walk a Leaflet layer tree and emit neutral geometry records for the 3D
// mirror. A popup bound on a group (L.geoJSON wrapper) is inherited by its
// leaf geometries, mirroring how eachPopupLayer/_aggLayerHit treat hits.
function _vec3dRecords(root, meta, out, inheritedPopup) {
  if (!root) return;
  let popupHtml = inheritedPopup || '';
  if (root.getPopup && root.getPopup()) popupHtml = _aggContentToHtml(root.getPopup().getContent());
  const common = { popupHtml, label: meta.label, pri: meta.pri };
  if (L.Circle && root instanceof L.Circle) {
    const c = root.getLatLng();
    const ring = circleToPolygon(c.lat, c.lng, root.getRadius()).map(p => ({ lat: p[0], lng: p[1] }));
    out.push(Object.assign({ kind: 'polygon', multiPolygon: latlngsToMultiPolygon(ring), style: leafletStyleTo3d(root.options), dashArray: root.options && root.options.dashArray }, common));
  } else if (L.CircleMarker && root instanceof L.CircleMarker) {
    const c = root.getLatLng();
    out.push(Object.assign({ kind: 'point', point: [c.lng, c.lat], radius: Math.min(root.getRadius ? root.getRadius() : 6, 10), style: leafletStyleTo3d(root.options) }, common));
  } else if (L.Polygon && root instanceof L.Polygon) {
    out.push(Object.assign({ kind: 'polygon', multiPolygon: latlngsToMultiPolygon(root.getLatLngs()), style: leafletStyleTo3d(root.options), dashArray: root.options && root.options.dashArray }, common));
  } else if (L.Polyline && root instanceof L.Polyline) {
    out.push(Object.assign({ kind: 'line', multiLine: latlngsToMultiLine(root.getLatLngs()), style: leafletStyleTo3d(root.options), dashArray: root.options && root.options.dashArray }, common));
  } else if (root.getLatLng) {
    // Icon markers (divIcon SVGs) render as a uniform dot in 3D for now.
    const c = root.getLatLng();
    const featId = (root.options && root.options.featId) || undefined;
    out.push(Object.assign({ kind: 'point', point: [c.lng, c.lat], radius: 6, featId, style: { stroke: '#e2e8f0', strokeWidth: 1.5, strokeOpacity: 1, fill: '#3d8bfd', fillOpacity: 0.9 } }, common));
  } else if (root.getLayers) {
    root.getLayers().forEach(c => _vec3dRecords(c, meta, out, popupHtml));
    return;
  }
  // Anything that reported an AGL height (obstacles, towers, dams) also gets a
  // ground-to-height cylinder so its vertical extent is visible in 3D.
  // MapLibre renders fill-extrusions RELATIVE to the terrain surface when
  // terrain is enabled (verified empirically on 5.24), so base 0 = the ground
  // at the feature; heights use the terrain exaggeration for a matched scale.
  const aglFt = root.options && Number(root.options.aglFt);
  if (root.getLatLng && Number.isFinite(aglFt) && aglFt > 0) {
    const c = root.getLatLng();
    const hM = aglFt * 0.3048 * TERRAIN_EXAGGERATION;
    const st = leafletStyleTo3d(root.options);
    if (root.options.cylColor) { st.fill = root.options.cylColor; st.stroke = root.options.cylColor; }
    else if (!root.options.fillColor && !root.options.color) { st.fill = '#3d8bfd'; st.stroke = '#3d8bfd'; } // divIcon markers carry no path color
    out.push(Object.assign({ kind: 'cylinder', lat: c.lat, lng: c.lng, radiusM: cylRadiusForHeightM(hM), baseM: 0, topM: hM, style: st }, common));
  }
}

function collect3dVectorGroups() {
  const groups = [];
  if (!S.map || !S.mapLayers || typeof L === 'undefined') return groups;
  for (const key of Object.keys(S.mapLayers)) {
    if (VEC3D_SKIP.has(key)) continue;
    const group = S.mapLayers[key];
    if (!group || !S.map.hasLayer(group)) continue;
    const meta = _aggMeta(key);
    const feats = [];
    try { _vec3dRecords(group, meta, feats, ''); } catch (e) { /* malformed layer — skip group */ }
    if (feats.length) groups.push({ id: key, pri: meta.pri, features: feats });
  }
  // The drawn ops area lives outside S.mapLayers.
  if (S.drawnItems) {
    const feats = [];
    try { _vec3dRecords(S.drawnItems, { label: 'Ops Area', pri: 8 }, feats, ''); } catch (e) { /* skip */ }
    if (feats.length) groups.push({ id: 'ops_area', pri: 8, features: feats });
  }
  const adsb = _aircraft3dGroup();
  if (adsb) groups.push(adsb);
  return groups;
}

// Live ADS-B aircraft as 3D cylinders: a slab at true AGL altitude + a thin
// drop line to the ground, colored by the same AGL scale as the 2D markers.
function _aircraft3dGroup() {
  if (!S.map || !S.mapLayers.adsb_aircraft || !S.map.hasLayer(S.mapLayers.adsb_aircraft)) return null;
  if (!Array.isArray(S.adsbAircraft) || !S.adsbAircraft.length) return null;
  const recs = aircraft3dRecords(S.adsbAircraft.map(ac => ({
    lat: ac.lat, lng: ac.lon,
    aglM: (isFinite(ac.agl) && ac.agl > 0) ? ac.agl * 0.3048 * TERRAIN_EXAGGERATION : null,
    color: adsbAglColor(ac.agl),
    popupHtml: _adsbPopupHtml(ac),
  })));
  // Draped ground dot per aircraft: visual anchor for the drop line + the
  // clickable handle for the popup (custom-layer verticals aren't clickable).
  S.adsbAircraft.forEach(ac => {
    recs.push({
      kind: 'point', point: [ac.lon, ac.lat], radius: 5,
      style: { stroke: '#000', strokeWidth: 1, strokeOpacity: 1, fill: adsbAglColor(ac.agl), fillOpacity: 0.9 },
      popupHtml: _adsbPopupHtml(ac), label: 'Aircraft', pri: 2,
    });
  });
  return recs.length ? { id: 'adsb3d', pri: 2, features: recs } : null;
}

// Fast per-poll path: replace the aircraft source data in place (no restyle).
function _refresh3dAircraft() {
  if (!S.map3d || !S.is3D) return;
  const group = _aircraft3dGroup();
  const src = S.map3d.getSource('vec_adsb3d');
  if (src && group) {
    const built = vector3dSourceAndLayers(group);
    if (built) {
      try {
        src.setData(built.source.data);
        _updateVert3dVerts(); // drop lines + altitude markers track the new positions
        return;
      } catch (e) { /* fall through to restyle */ }
    }
  }
  // Source doesn't exist yet (first aircraft) or all aircraft left — restyle.
  sync3d();
}

// Snapshot the live 2D layer state into the shape build3dStyle() consumes.
function collect3dState() {
  const active = id => !!(S.map && S.mapLayers[id] && S.map.hasLayer(S.mapLayers[id]));
  let base = null;
  ['satellite', 'topo', 'sectional'].forEach(id => { if (active(id)) base = id; });
  const rasters = [];
  ['canopy', 'viewshed', 'shadow'].forEach(id => {
    const info = S._raster3d && S._raster3d[id];
    if (!info || !S._overlayWanted || !S._overlayWanted[id]) return;
    // The canopy renders as a 3D surface mesh instead of a flat drape when
    // its grid is resident — don't double-render the draped image under it.
    if (id === 'canopy' && S.canopy && S.canopy.grid && S.canopy.canopyFlat) return;
    const lyr = S.mapLayers[id];
    const op = (lyr && lyr.options && lyr.options.opacity != null) ? lyr.options.opacity : 0.7;
    rasters.push({ id, url: info.url, bounds: info.bounds, opacity: op });
  });
  // Current radar frame (if the radar layer is toggled on in 2D).
  let radarUrl = null;
  if (S.radarAnim && S.radarAnim.layers && S.radarAnim.layers.length) {
    const frame = S.radarAnim.layers[S.radarAnim.index];
    if (frame && S.map.hasLayer(frame) && frame.options && frame.options.opacity > 0 && frame._url) {
      radarUrl = frame._url;
    }
  }
  // Terrain hillshade tracks the scene light (sun/moon) direction.
  const shade = typeof hillshadeParams === 'function'
    ? hillshadeParams(S._light3d || (typeof lightForTime === 'function' && S.areaCenter
      ? lightForTime(S.areaCenter.lat, S.areaCenter.lng, _context3dTime()) : null))
    : null;
  return {
    theme: (S.theme === 'light' || S.theme === 'light-map') ? 'light' : 'dark',
    base,
    sectionalUrl: sectionalTileUrl(getStoredSectionalEdition()),
    overlays: { slope: active('slope'), streets: active('streets') },
    rasters,
    radarUrl,
    vectors: collect3dVectorGroups(),
    exaggeration: TERRAIN_EXAGGERATION,
    lightAzimuth: shade ? shade.azimuth : undefined,
    lightShade: shade ? shade.exaggeration : undefined,
  };
}

function _sync3dNow() {
  if (!S.map3d || !S.is3D) return;
  try {
    S.map3d.setStyle(build3dStyle(collect3dState()), { diff: true });
  } catch (e) {
    try { Diag.note('3d.sync.err', { m: String(e && e.message).slice(0, 120) }); } catch (_) {}
  }
  _ensureVert3dLayer();
  _updateVert3dVerts();
}

// ============================================================
// Custom WebGL layer: vertical extents (obstacle/tower heights, aircraft
// drop lines + altitude X markers). MapLibre's fill-extrusion misplaces
// GeoJSON extrusions over high terrain (maplibre-gl-js#2560 family), so
// verticals are drawn directly: two GL vertices per line at mercator
// altitude = terrain elevation + height, which cannot drift.
// ============================================================
const VERT3D_LAYER_ID = 'vert3d';

// Screen-space width of the thick (obstacle/tower/dam) vertical lines.
const VERT3D_THICK_PX = 4.5;

function _vert3dMakeLayer() {
  return {
    id: VERT3D_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    onAdd(map, gl) {
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      };
      const link = (vs, fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        return p;
      };
      const fs = 'precision mediump float;varying vec3 v_color;void main(){gl_FragColor=vec4(v_color,1.0);}';
      // Thin 1px GL lines (aircraft verticals).
      this.lineProg = link(
        'attribute vec3 a_pos;attribute vec3 a_color;uniform mat4 u_matrix;varying vec3 v_color;'
        + 'void main(){gl_Position=u_matrix*vec4(a_pos,1.0);v_color=a_color;}',
        fs);
      this.lineAttrs = {
        pos: gl.getAttribLocation(this.lineProg, 'a_pos'),
        color: gl.getAttribLocation(this.lineProg, 'a_color'),
        matrix: gl.getUniformLocation(this.lineProg, 'u_matrix'),
      };
      // Thick lines as screen-space quads: each vertex carries its endpoint,
      // the OTHER endpoint, and a side sign; the shader expands perpendicular
      // to the projected line direction by u_width pixels (GL lineWidth is
      // clamped to 1 on most implementations, so quads are the only way).
      this.quadProg = link(
        'attribute vec3 a_pos;attribute vec3 a_other;attribute float a_side;attribute vec3 a_color;'
        + 'uniform mat4 u_matrix;uniform vec2 u_halfvp;uniform float u_width;varying vec3 v_color;'
        + 'void main(){'
        + 'vec4 ca=u_matrix*vec4(a_pos,1.0);vec4 cb=u_matrix*vec4(a_other,1.0);'
        + 'vec2 sa=ca.xy/ca.w*u_halfvp;vec2 sb=cb.xy/cb.w*u_halfvp;'
        + 'vec2 d=sb-sa;float len=length(d);'
        + 'vec2 dir=len>0.0001?d/len:vec2(0.0,1.0);'
        + 'vec2 norm=vec2(-dir.y,dir.x)*a_side*u_width*0.5;'
        + 'gl_Position=ca+vec4(norm/u_halfvp*ca.w,0.0,0.0);'
        + 'v_color=a_color;}',
        fs);
      this.quadAttrs = {
        pos: gl.getAttribLocation(this.quadProg, 'a_pos'),
        other: gl.getAttribLocation(this.quadProg, 'a_other'),
        side: gl.getAttribLocation(this.quadProg, 'a_side'),
        color: gl.getAttribLocation(this.quadProg, 'a_color'),
        matrix: gl.getUniformLocation(this.quadProg, 'u_matrix'),
        halfvp: gl.getUniformLocation(this.quadProg, 'u_halfvp'),
        width: gl.getUniformLocation(this.quadProg, 'u_width'),
      };
      // Filled triangles (building prisms, canopy surface): per-vertex RGBA +
      // ENU surface normal, Lambert-lit by the sun/moon direction uniform
      // (see lightForTime). Positions are mercator but normals and the light
      // vector share the local ENU frame, so N·L is computed there — the
      // light moves with the time slider via a uniform, no mesh rebuild.
      this.triProg = link(
        'attribute vec3 a_pos;attribute vec4 a_color;attribute vec3 a_normal;'
        + 'uniform mat4 u_matrix;varying vec4 v_color;varying vec3 v_normal;'
        + 'void main(){gl_Position=u_matrix*vec4(a_pos,1.0);v_color=a_color;v_normal=a_normal;}',
        'precision mediump float;varying vec4 v_color;varying vec3 v_normal;'
        + 'uniform float u_alpha;uniform vec3 u_light;uniform float u_diffuse;uniform float u_ambient;'
        + 'void main(){'
        + 'float d=max(0.0,dot(normalize(v_normal),u_light));'
        + 'float b=clamp(u_ambient+u_diffuse*d,0.0,1.0);'
        + 'gl_FragColor=vec4(v_color.rgb*b,v_color.a*u_alpha);}');
      this.triAttrs = {
        pos: gl.getAttribLocation(this.triProg, 'a_pos'),
        color: gl.getAttribLocation(this.triProg, 'a_color'),
        normal: gl.getAttribLocation(this.triProg, 'a_normal'),
        matrix: gl.getUniformLocation(this.triProg, 'u_matrix'),
        alpha: gl.getUniformLocation(this.triProg, 'u_alpha'),
        light: gl.getUniformLocation(this.triProg, 'u_light'),
        diffuse: gl.getUniformLocation(this.triProg, 'u_diffuse'),
        ambient: gl.getUniformLocation(this.triProg, 'u_ambient'),
      };
      this.lineBuffer = gl.createBuffer();
      this.quadBuffer = gl.createBuffer();
      this.triOpaqueBuffer = gl.createBuffer();
      this.triCanopyBuffer = gl.createBuffer();
      this.triCanopyIndexBuffer = gl.createBuffer();
      gl.getExtension('OES_element_index_uint'); // no-op on WebGL2; enables Uint32 indices on WebGL1
      // onAdd re-runs whenever a style reset re-adds the layer (fresh GL
      // buffers) — flag every retained CPU-side mesh for re-upload.
      S._vert3dDirty = true;
      S._tri3dOpaqueDirty = true;
      S._tri3dCanopyDirty = true;
    },
    render(gl, matrixOrArgs) {
      // v4+ passes an args object (globe support); older versions the raw matrix.
      const m = (matrixOrArgs && matrixOrArgs.defaultProjectionData)
        ? matrixOrArgs.defaultProjectionData.mainMatrix : matrixOrArgs;
      // Relative-to-anchor rendering: buffers hold offsets from a per-mesh
      // mercator anchor (absolute mercator in Float32 quantizes at ~0.5 m —
      // building-sized — making geometry crawl and depth flip as the camera
      // moves). Fold the anchor back in here, in float64, per frame.
      const mFor = anchor => {
        if (!anchor) return m;
        const out = new Float32Array(16);
        for (let i = 0; i < 12; i++) out[i] = m[i];
        out[12] = m[0] * anchor[0] + m[4] * anchor[1] + m[12];
        out[13] = m[1] * anchor[0] + m[5] * anchor[1] + m[13];
        out[14] = m[2] * anchor[0] + m[6] * anchor[1] + m[14];
        out[15] = m[3] * anchor[0] + m[7] * anchor[1] + m[15];
        return out;
      };
      const mVert = mFor(S._vert3dAnchor);
      const thin = S._vert3dVerts;
      const thick = S._vert3dThickVerts;
      const light = S._light3d || { dir: [0, 0, 1], diffuse: 0.4, ambient: 0.55 };
      const drawTris = (buffer, verts, dirty, alpha, indexBuffer, indices, anchor) => {
        gl.useProgram(this.triProg);
        gl.disable(gl.CULL_FACE);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        if (dirty) gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        const stride = 40; // pos(3) + color rgba(4) + normal(3) floats
        gl.enableVertexAttribArray(this.triAttrs.pos);
        gl.vertexAttribPointer(this.triAttrs.pos, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this.triAttrs.color);
        gl.vertexAttribPointer(this.triAttrs.color, 4, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(this.triAttrs.normal);
        gl.vertexAttribPointer(this.triAttrs.normal, 3, gl.FLOAT, false, stride, 28);
        gl.uniformMatrix4fv(this.triAttrs.matrix, false, mFor(anchor));
        gl.uniform1f(this.triAttrs.alpha, alpha);
        gl.uniform3f(this.triAttrs.light, light.dir[0], light.dir[1], light.dir[2]);
        gl.uniform1f(this.triAttrs.diffuse, light.diffuse);
        gl.uniform1f(this.triAttrs.ambient, light.ambient);
        if (indices && indices.length) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
          if (dirty) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
          gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); // don't leak into MapLibre's state
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, verts.length / 10);
        }
      };
      // Opaque prisms (buildings) and the opaque canopy surface draw before
      // the lines so height lines stay visible on top of them. Both write
      // depth, so canopy hills correctly occlude each other and buildings.
      if (S._tri3dOpaque && S._tri3dOpaque.length && this.triProg) {
        drawTris(this.triOpaqueBuffer, S._tri3dOpaque, S._tri3dOpaqueDirty, 1.0,
          null, null, S._tri3dOpaqueAnchor);
        S._tri3dOpaqueDirty = false;
      }
      if (S._tri3dCanopy && S._tri3dCanopy.length && this.triProg) {
        drawTris(this.triCanopyBuffer, S._tri3dCanopy, S._tri3dCanopyDirty, 1.0,
          this.triCanopyIndexBuffer, S._tri3dCanopyIndices, S._tri3dCanopyAnchor);
        S._tri3dCanopyDirty = false;
      }
      if (thin && thin.length && this.lineProg) {
        gl.useProgram(this.lineProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
        if (S._vert3dDirty) gl.bufferData(gl.ARRAY_BUFFER, thin, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.lineAttrs.pos);
        gl.vertexAttribPointer(this.lineAttrs.pos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(this.lineAttrs.color);
        gl.vertexAttribPointer(this.lineAttrs.color, 3, gl.FLOAT, false, 24, 12);
        gl.uniformMatrix4fv(this.lineAttrs.matrix, false, mVert);
        gl.drawArrays(gl.LINES, 0, thin.length / 6);
      }
      if (thick && thick.length && this.quadProg) {
        gl.useProgram(this.quadProg);
        gl.disable(gl.CULL_FACE);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        if (S._vert3dDirty) gl.bufferData(gl.ARRAY_BUFFER, thick, gl.DYNAMIC_DRAW);
        const stride = 40; // pos(3) + other(3) + side(1) + color(3) floats
        gl.enableVertexAttribArray(this.quadAttrs.pos);
        gl.vertexAttribPointer(this.quadAttrs.pos, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(this.quadAttrs.other);
        gl.vertexAttribPointer(this.quadAttrs.other, 3, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(this.quadAttrs.side);
        gl.vertexAttribPointer(this.quadAttrs.side, 1, gl.FLOAT, false, stride, 24);
        gl.enableVertexAttribArray(this.quadAttrs.color);
        gl.vertexAttribPointer(this.quadAttrs.color, 3, gl.FLOAT, false, stride, 28);
        gl.uniformMatrix4fv(this.quadAttrs.matrix, false, mVert);
        const c = gl.canvas;
        gl.uniform2f(this.quadAttrs.halfvp, c.width / 2, c.height / 2);
        gl.uniform1f(this.quadAttrs.width, VERT3D_THICK_PX * (window.devicePixelRatio || 1));
        gl.drawArrays(gl.TRIANGLES, 0, thick.length / 10);
      }
      S._vert3dDirty = false;
    },
  };
}

function _ensureVert3dLayer() {
  if (!S.map3d) return;
  try {
    if (!S.map3d.getLayer(VERT3D_LAYER_ID)) {
      if (!S._vert3dLayer) S._vert3dLayer = _vert3dMakeLayer();
      S.map3d.addLayer(S._vert3dLayer);
    }
  } catch (e) {
    // Style still loading — add once it settles.
    try { S.map3d.once('styledata', () => { if (S.is3D) _ensureVert3dLayer(); }); } catch (err) { /* give up */ }
  }
}

// Rebuild the GL vertex buffer from the current vertical segments. Ground
// elevation comes from the rendered terrain (queryTerrainElevation); segments
// over not-yet-loaded terrain get a bounded re-run once the map goes idle.
// Mercator x/y of the scene anchor for relative-to-anchor rendering (see the
// custom layer's mFor). z stays absolute — its magnitude (~2e-5) is fully
// representable in Float32.
function _vert3dAnchorOf() {
  const c = S.areaCenter || (S.map && S.map.getCenter && S.map.getCenter());
  if (!c || typeof maplibregl === 'undefined') return [0, 0];
  const mc = maplibregl.MercatorCoordinate.fromLngLat([c.lng, c.lat], 0);
  return [mc.x, mc.y];
}

function _updateVert3dVerts() {
  if (!S.map3d || !S.is3D || typeof maplibregl === 'undefined') return;
  _update3dLight();
  const segs = collectVerticalSegments(collect3dVectorGroups());
  const thin = [];
  const thick = [];
  let missing = false;
  const groundOf = (lat, lng) => {
    try {
      const e = S.map3d.queryTerrainElevation([lng, lat]);
      if (Number.isFinite(e)) return e;
    } catch (err) { /* terrain not ready */ }
    missing = true;
    return 0;
  };
  const anchor = _vert3dAnchorOf();
  S._vert3dAnchor = anchor;
  // Offsets from the anchor (relative-to-anchor rendering — see mFor).
  const mcOf = (lng, lat, altM) => {
    const mc = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], altM);
    return { x: mc.x - anchor[0], y: mc.y - anchor[1], z: mc.z };
  };
  const pushThin = (mc, c) => { thin.push(mc.x, mc.y, mc.z, c[0], c[1], c[2]); };
  // One quad (2 triangles) per thick line; each vertex carries its endpoint,
  // the opposite endpoint, and the expansion side for the billboard shader.
  const pushThickLine = (a, b, c) => {
    const v = (p, o, side) => { thick.push(p.x, p.y, p.z, o.x, o.y, o.z, side, c[0], c[1], c[2]); };
    v(a, b, 1); v(a, b, -1); v(b, a, -1);
    v(a, b, -1); v(b, a, 1); v(b, a, -1);
  };
  segs.forEach(sg => {
    const g = groundOf(sg.lat, sg.lng);
    if (sg.type === 'line') {
      const a = mcOf(sg.lng, sg.lat, g + sg.fromM);
      const b = mcOf(sg.lng, sg.lat, g + sg.toM);
      if (sg.thin) { pushThin(a, sg.color); pushThin(b, sg.color); }
      else pushThickLine(a, b, sg.color);
    } else if (sg.type === 'cross') {
      const alt = g + sg.atM;
      const arm = sg.armM || 50;
      const dLat = arm / 111320;
      const dLng = arm / (111320 * Math.cos(sg.lat * Math.PI / 180));
      pushThin(mcOf(sg.lng - dLng, sg.lat, alt), sg.color);
      pushThin(mcOf(sg.lng + dLng, sg.lat, alt), sg.color);
      pushThin(mcOf(sg.lng, sg.lat - dLat, alt), sg.color);
      pushThin(mcOf(sg.lng, sg.lat + dLat, alt), sg.color);
    }
  });
  // Building prisms: rebuilt only when the source object changes or an
  // earlier build sampled unloaded terrain — NOT on every aircraft-poll
  // refresh. The built mesh is kept when the layer is toggled off so
  // re-enabling it is instant.
  const triSt = S._tri3dState || (S._tri3dState = {});
  const rebuildTri = (key, src, build) => {
    const rec = triSt[key] || (triSt[key] = { active: undefined, cacheSrc: null, cacheData: null, data: null, missing: false, dirty: false });
    if (rec.active === src && !(src && rec.missing)) return rec;
    if (src) {
      if (rec.cacheSrc !== src || rec.missing) {
        const outerMissing = missing;
        missing = false;
        rec.cacheData = build(src);
        rec.missing = missing;
        missing = outerMissing || missing;
        rec.cacheSrc = src;
      }
      rec.data = rec.cacheData;
    } else {
      rec.data = null; // hidden — cache retained for reactivation
    }
    rec.active = src;
    rec.dirty = true;
    return rec;
  };
  const bldOn = S.map && S.mapLayers.buildings && S.map.hasLayer(S.mapLayers.buildings)
    && S.buildings && S.buildings.list && S.buildings.list.length
    && _buildings3dMode() === 'prisms'; // 'flat' keeps only the draped footprints
  const bldRec = rebuildTri('buildings', bldOn ? S.buildings : null,
    b => _buildBuildingTriVerts(b.list, groundOf, mcOf, anchor));
  if (bldRec.dirty) {
    S._tri3dOpaque = bldRec.data ? bldRec.data.verts : new Float32Array(0);
    S._tri3dOpaqueAnchor = bldRec.data ? bldRec.data.anchor : null;
    S._tri3dOpaqueDirty = true;
    bldRec.dirty = false;
  }
  // Canopy surface: built asynchronously in chunks (progress bar + cancel)
  // by _startCanopy3dBuild; here we only activate whatever cache matches the
  // current source. The cache survives layer toggles and 2D/3D switches.
  const canopyOn = S.canopy && S.canopy.grid && S.canopy.canopyFlat
    && S._overlayWanted && S._overlayWanted.canopy;
  const canopySrc = canopyOn ? S.canopy : null;
  if (!canopySrc) S._canopy3dCancelledFor = null; // toggling the layer re-arms a cancelled build
  let canopyActive = null;
  if (canopySrc) {
    const cache = S._canopy3dCache;
    if (cache && cache.src === canopySrc) canopyActive = cache;
    else if (S._canopy3dCancelledFor !== canopySrc) _startCanopy3dBuild(canopySrc);
  }
  if (S._canopy3dActive !== canopyActive) {
    S._tri3dCanopy = canopyActive ? canopyActive.verts : new Float32Array(0);
    S._tri3dCanopyIndices = canopyActive ? canopyActive.indices : null;
    S._tri3dCanopyAnchor = canopyActive ? canopyActive.anchor : null;
    S._tri3dCanopyDirty = true;
    S._canopy3dActive = canopyActive;
  }
  S._vert3dVerts = new Float32Array(thin);
  S._vert3dThickVerts = new Float32Array(thick);
  S._vert3dDirty = true;
  S.map3d.triggerRepaint();
  if (missing && (S._vert3dRetry || 0) < 4) {
    S._vert3dRetry = (S._vert3dRetry || 0) + 1;
    try { S.map3d.once('idle', () => { if (S.is3D) _updateVert3dVerts(); }); } catch (e) { /* skip */ }
  } else if (!missing) {
    S._vert3dRetry = 0;
  }
}

// Buildings → opaque prism triangles (pos3 + rgba4 + ENU normal3 per
// vertex; the shader lights them by sun/moon position). One terrain sample
// per building at its centroid; the base is sunk 3 m so prisms don't float
// on slopes (per-vertex terrain sampling is overkill at house scale).
// Anti-z-fighting: footprints are inset a hair toward their centroid so
// adjacent buildings' shared walls separate, and a tiny deterministic height
// jitter keeps overlapping OSM footprints' default-height roofs off a common
// plane. mcOf must already subtract `anchor` (relative-to-anchor rendering);
// the anchor is returned with the mesh so the draw can fold it back in.
const BUILDING_3D_COLOR = '#8fa3b8';
const BUILDING_INSET_M = 0.25;

function _buildBuildingTriVerts(list, groundOf, mcOf, anchor) {
  const arr = [];
  const col = hexToRgb01(BUILDING_3D_COLOR);
  list.forEach(b => {
    const fp = b.footprint;
    let cx = 0, cy = 0;
    fp.forEach(p => { cx += p[0]; cy += p[1]; });
    cx /= fp.length; cy /= fp.length;
    const mLat = 111320, mLng = 111320 * Math.cos(cy * Math.PI / 180);
    const inset = fp.map(p => {
      const dx = cx - p[0], dy = cy - p[1];
      const distM = Math.hypot(dx * mLng, dy * mLat);
      if (distM <= BUILDING_INSET_M * 2) return p;
      const s = BUILDING_INSET_M / distM;
      return [p[0] + dx * s, p[1] + dy * s];
    });
    const g = groundOf(cy, cx);
    const hM = b.heightM + (b.id % 13) * 0.015; // ≤18 cm jitter, invisible
    const base = g - 3 * TERRAIN_EXAGGERATION;
    const top = g + hM * TERRAIN_EXAGGERATION;
    buildingMeshLocal(inset, hM).forEach(v => {
      const mc = mcOf(v.lng, v.lat, v.top ? top : base);
      arr.push(mc.x, mc.y, mc.z, col[0], col[1], col[2], 1.0, v.normal[0], v.normal[1], v.normal[2]);
    });
  });
  return { verts: new Float32Array(arr), anchor: anchor || null };
}

// --- 3D canopy surface: async chunked build + cache -----------------------
// The canopy renders as a single opaque green surface (field feedback: the
// height-ramp coloring read poorly in 3D). Desktop builds the grid at full
// resolution (the grid itself caps at MAX_GRID = 512²); constrained devices
// max-pool down to 128². Ground elevation is sampled from the RENDERED
// terrain once per shared vertex (not 3DEP) so the surface hugs the
// displayed ground by construction.
// The build runs in UI-yielding chunks (same idea as _runViewshedKernel)
// with a progress bar + cancel button; the finished {verts, indices} mesh is
// cached on S._canopy3dCache keyed by the S.canopy object identity, so layer
// toggles and 2D/3D switches reuse it instead of rebuilding.
const CANOPY_3D_COLOR = '#15803d';
const CANOPY3D_CHUNK = 20000; // vertices per UI yield
// Anti-z-fighting vs the terrain surface: cull near-ground scrub (the Meta
// CHM is noisy below ~2 m and a green film at ground level just shimmers)
// and float the whole surface slightly above the ground it hugs.
const CANOPY3D_MIN_H = 2;   // m — corners below this don't count as forest
const CANOPY3D_LIFT_M = 1.2; // m — constant lift off the terrain

async function _buildCanopy3dMeshChunked(src, onProgress, isCancelled) {
  const maxDim = (typeof _isConstrained === 'function' && _isConstrained()) ? 128 : MAX_GRID;
  const mesh = decimateCanopyMesh(src.grid, src.canopyFlat, maxDim);
  const im = canopyMeshIndexed(mesh, { color: hexToRgb01(CANOPY_3D_COLOR), minH: CANOPY3D_MIN_H });
  const n = im.vRow.length;
  const verts = new Float32Array(n * 10); // pos3 + rgba4 + normal3
  const state = { missing: false };
  const groundOf = (lat, lng) => {
    try {
      const e = S.map3d.queryTerrainElevation([lng, lat]);
      if (Number.isFinite(e)) return e;
    } catch (err) { /* terrain not ready */ }
    state.missing = true;
    return 0;
  };
  // Lazily-cached surface altitude (exaggerated terrain + canopy) for every
  // mesh grid point — each vertex needs its 4 neighbours for the normal, and
  // neighbours are shared, so the cache keeps terrain queries ~1 per point.
  const rowsN = mesh.rows, colsN = mesh.cols;
  const altCache = new Float32Array(rowsN * colsN).fill(NaN);
  const altAt = (r, c) => {
    const k = r * colsN + c;
    let v = altCache[k];
    if (Number.isNaN(v)) {
      v = groundOf(mesh.lats[r], mesh.lngs[c]) + mesh.canopy[k] * TERRAIN_EXAGGERATION + CANOPY3D_LIFT_M;
      altCache[k] = v;
    }
    return v;
  };
  const anchor = _vert3dAnchorOf();
  // Mean vertex spacing in meters (E-W and N-S) for slope → normal math.
  const g = src.grid;
  const spacingEm = Math.max(1, (mesh.lngs[colsN - 1] - mesh.lngs[0]) / Math.max(1, colsN - 1) * g.mPerDegLng);
  const spacingNm = Math.max(1, (mesh.lats[0] - mesh.lats[rowsN - 1]) / Math.max(1, rowsN - 1) * g.mPerDegLat);
  for (let start = 0; start < n; start += CANOPY3D_CHUNK) {
    if (isCancelled()) return null;
    const end = Math.min(n, start + CANOPY3D_CHUNK);
    for (let i = start; i < end; i++) {
      const r = im.vRow[i], c = im.vCol[i];
      const lat = mesh.lats[r], lng = mesh.lngs[c];
      const mcAbs = maplibregl.MercatorCoordinate.fromLngLat([lng, lat], altAt(r, c));
      const mc = { x: mcAbs.x - anchor[0], y: mcAbs.y - anchor[1], z: mcAbs.z };
      // Central differences on the lit surface (row 0 = north, so +row is south).
      const cW = Math.max(0, c - 1), cE = Math.min(colsN - 1, c + 1);
      const rN = Math.max(0, r - 1), rS = Math.min(rowsN - 1, r + 1);
      const dzdx = (altAt(r, cE) - altAt(r, cW)) / (spacingEm * Math.max(1, cE - cW));
      const dzdy = (altAt(rN, c) - altAt(rS, c)) / (spacingNm * Math.max(1, rS - rN));
      const nrm = normalFromSlopes(dzdx, dzdy);
      const o = i * 10;
      verts[o] = mc.x; verts[o + 1] = mc.y; verts[o + 2] = mc.z;
      verts[o + 3] = im.vColor[i * 4]; verts[o + 4] = im.vColor[i * 4 + 1];
      verts[o + 5] = im.vColor[i * 4 + 2]; verts[o + 6] = im.vColor[i * 4 + 3];
      verts[o + 7] = nrm[0]; verts[o + 8] = nrm[1]; verts[o + 9] = nrm[2];
    }
    onProgress(end / Math.max(1, n));
    await new Promise(r => setTimeout(r, 0)); // let the progress bar paint
  }
  return { verts, indices: im.indices, missing: state.missing, anchor };
}

function _startCanopy3dBuild(src) {
  if (S._canopy3dBuild) return; // single-flight
  const build = { src, cancelled: false, startedAt: Date.now() };
  S._canopy3dBuild = build;
  _canopy3dProgressShow();
  _buildCanopy3dMeshChunked(src,
    frac => { if (!build.cancelled) _canopy3dProgressUpdate(frac, build.startedAt); },
    () => build.cancelled || !S.map3d)
    .then(result => {
      if (S._canopy3dBuild === build) S._canopy3dBuild = null;
      _canopy3dProgressHide();
      if (!result) return; // cancelled
      S._canopy3dCache = { src, verts: result.verts, indices: result.indices, missing: result.missing, anchor: result.anchor };
      if (S.is3D) _updateVert3dVerts();
      // Some vertices sampled not-yet-loaded terrain: show the mesh now, but
      // rebuild once the map settles (bounded, mirrors the verticals' retry).
      if (result.missing && (S._canopy3dRetry || 0) < 4 && S.map3d) {
        S._canopy3dRetry = (S._canopy3dRetry || 0) + 1;
        try {
          S.map3d.once('idle', () => {
            if (S.is3D && S._canopy3dCache && S._canopy3dCache.src === src) {
              S._canopy3dCache = null;
              _updateVert3dVerts();
            }
          });
        } catch (e) { /* skip retry */ }
      } else if (!result.missing) {
        S._canopy3dRetry = 0;
      }
    })
    .catch(err => {
      if (S._canopy3dBuild === build) S._canopy3dBuild = null;
      _canopy3dProgressHide();
      console.warn('3D canopy build failed:', err);
    });
}

// User-facing cancel (progress-bar button): stops the build and suppresses
// auto-restart until the canopy layer is toggled off/on or new canopy loads.
function cancelCanopy3dBuild() {
  const b = S._canopy3dBuild;
  if (!b) return;
  b.cancelled = true;
  S._canopy3dCancelledFor = b.src;
  _canopy3dProgressHide();
}

// Silent abort (leaving 3D): the build restarts on the next 3D entry.
function _abortCanopy3dBuild() {
  const b = S._canopy3dBuild;
  if (!b) return;
  b.cancelled = true;
  _canopy3dProgressHide();
}

function _canopy3dProgressShow() {
  const el = document.getElementById('canopy3dProgress');
  if (el) el.style.display = 'flex';
  _canopy3dProgressUpdate(0, Date.now());
}

function _canopy3dProgressUpdate(frac, startedAt) {
  const fill = document.getElementById('canopy3dProgressFill');
  if (fill) fill.style.width = Math.round(frac * 100) + '%';
  const txt = document.getElementById('canopy3dProgressText');
  if (txt) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = frac > 0.02 ? Math.max(0, elapsed / frac - elapsed) : null;
    txt.textContent = Math.round(frac * 100) + '%' + (eta != null ? ` · ~${Math.ceil(eta)}s left` : '');
  }
}

function _canopy3dProgressHide() {
  const el = document.getElementById('canopy3dProgress');
  if (el) el.style.display = 'none';
}

// --- 3D scene lighting (sun/moon) ----------------------------------------
// The selected time-bar hour (idx 0 = NOW) drives the light direction, so
// scrubbing the timeline swings the lighting across the day.
function _context3dTime() {
  try {
    const hourly = S.wx && S.wx.hourly;
    if (hourly && hourly.time && S.timeIdx > 0 && hourly.time[S.timeIdx]) {
      return new Date(hourly.time[S.timeIdx]);
    }
  } catch (e) { /* fall through to now */ }
  return new Date();
}

function _update3dLight() {
  if (typeof lightForTime !== 'function') return;
  const c = S.areaCenter || (S.map && S.map.getCenter && S.map.getCenter());
  if (!c) return;
  S._light3d = lightForTime(c.lat, c.lng, _context3dTime());
  if (S.map3d && S.is3D) {
    try {
      // Swing the terrain hillshade with the light (paint-only, no restyle).
      if (typeof hillshadeParams === 'function' && S.map3d.getLayer('sunshade')) {
        const hs = hillshadeParams(S._light3d);
        S.map3d.setPaintProperty('sunshade', 'hillshade-illumination-direction', Math.round(hs.azimuth) % 360);
        S.map3d.setPaintProperty('sunshade', 'hillshade-exaggeration', hs.exaggeration);
      }
      S.map3d.triggerRepaint();
    } catch (e) { /* not up yet */ }
  }
}

// Debounced: buildLayerControl fires in bursts while an area's data loads, and
// each sync re-harvests every visible vector layer — coalesce to one restyle.
function sync3d() {
  if (!S.map3d || !S.is3D) return;
  clearTimeout(S._sync3dTimer);
  S._sync3dTimer = setTimeout(_sync3dNow, 150);
}

// --- 3D aggregated popup (mirrors the 2D "← n/N →" pager) ---
function _vec3dLayerIds() {
  try {
    return S.map3d.getStyle().layers.map(l => l.id).filter(id => id.indexOf('vec_') === 0);
  } catch (e) { return []; }
}

function _agg3dHtml() {
  const st = S._agg3d;
  const n = st.items.length, i = ((st.index % n) + n) % n;
  st.index = i;
  const item = st.items[i];
  const btn = 'background:rgba(128,128,128,0.16);border:1px solid rgba(128,128,128,0.5);color:inherit;border-radius:4px;cursor:pointer;font:600 14px/1 monospace;padding:1px 9px';
  let html = '';
  if (n > 1) {
    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;padding-bottom:5px;border-bottom:1px solid rgba(128,128,128,0.3)">`
      + `<button type="button" title="Previous" onclick="agg3dStep(-1)" style="${btn}">&#8592;</button>`
      + `<span style="font:600 11px/1.25 monospace;opacity:0.8;text-align:center">${i + 1} / ${n}`
      + (item.label ? `<br><span style="opacity:0.6;font-weight:400">${item.label}</span>` : '')
      + `</span>`
      + `<button type="button" title="Next" onclick="agg3dStep(1)" style="${btn}">&#8594;</button>`
      + `</div>`;
  } else if (item.label) {
    html += `<div style="font:600 10px/1.2 monospace;opacity:0.55;margin-bottom:4px">${item.label}</div>`;
  }
  html += `<div class="agg-popup-body">${item.content}</div>`;
  return html;
}

function agg3dStep(dir) {
  const st = S._agg3d;
  if (!st || !st.items || !st.items.length || !st.popup) return;
  st.index += dir;
  st.popup.setHTML(_agg3dHtml());
}

function _open3dPopup(e) {
  if (!S.map3d) return;
  const pad = 6;
  const box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  let feats = [];
  try { feats = S.map3d.queryRenderedFeatures(box, { layers: _vec3dLayerIds() }); } catch (err) { return; }
  const seen = new Set();
  const items = [];
  feats.forEach(f => {
    const p = f.properties || {};
    if (!p.popupHtml || seen.has(p.popupHtml)) return; // dedupe fill/line double-hits + tiered airspace
    seen.add(p.popupHtml);
    items.push({ content: p.popupHtml, label: p.label || '', pri: p.pri == null ? 7 : Number(p.pri) });
  });
  if (!items.length) return;
  items.sort((a, b) => a.pri - b.pri);
  if (!S._agg3d) S._agg3d = {};
  const st = S._agg3d;
  st.items = items;
  st.index = 0;
  if (st.popup) { try { st.popup.remove(); } catch (err) { /* already gone */ } }
  st.popup = new maplibregl.Popup({ maxWidth: '340px', className: 'agg-popup' })
    .setLngLat(e.lngLat)
    .setHTML(_agg3dHtml())
    .addTo(S.map3d);
}

// ============================================================
// OBSERVER PERSPECTIVE VIEW — first-person from an observer point.
// Tap an observer dot in 3D to stand at that observer (bare ground +
// PILOT_EYE_M, same eye the viewshed kernel uses) and drag/scroll to look
// around from the fixed camera position (MapLibre FreeCameraOptions).
// Tap the ground (or the EXIT VIEW button) to return; tap another observer
// dot to switch perspective.
// ============================================================

// MapLibre handlers that fight a fixed free camera while in observer mode.
const _OBS_HANDLERS = ['dragPan', 'dragRotate', 'scrollZoom', 'doubleClickZoom', 'keyboard', 'boxZoom', 'touchZoomRotate', 'touchPitch'];

// MapLibre auto-computes the near clip plane as canvasHeight/50 projected
// units, which at the eye camera's derived zoom lands ~200 m in front of the
// observer — nearby terrain/canopy/buildings vanish until you look up. While
// in observer mode we override near/far to human-scale distances (converted
// via transform.pixelsPerMeter, which tracks the current zoom).
const OBSERVER_NEAR_M = 1.0;
const OBSERVER_FAR_M = 150000; // distant Sierra ridgelines stay visible

function _observer3dFeatureAt(point) {
  if (!S.map3d || !point) return null;
  try {
    if (!S.map3d.getLayer('vec_observers_pt')) return null;
    const pad = 8; // draped dots are nearly edge-on at horizon pitch — be generous
    const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
    const feats = S.map3d.queryRenderedFeatures(box, { layers: ['vec_observers_pt'] });
    for (const f of feats) {
      const id = f && f.properties && f.properties.featId;
      if (id) return id;
    }
  } catch (e) { /* style mid-rebuild */ }
  return null;
}

function enterObserverView(id) {
  if (!S.map3d || !S.is3D) return;
  const rec = S.viewsheds.find(r => r.id === id);
  if (!rec || !rec.observer) return;
  const switching = !!S.observerView;
  if (!switching) {
    const m = S.map3d;
    const prevCam = { center: m.getCenter(), zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing() };
    _OBS_HANDLERS.forEach(h => { try { m[h] && m[h].disable(); } catch (e) { /* handler absent */ } });
    try { m.setMaxPitch(OBSERVER_MAX_PITCH); } catch (e) { try { m.setMaxPitch(85); } catch (e2) { /* keep default */ } }
    // The eye camera carries its own elevation — terrain must not re-clamp it.
    try { m.setCenterClampedToGround(false); } catch (e) { /* older engine */ }
    S.observerView = { id, pitch: OBSERVER_START_PITCH, bearing: prevCam.bearing, prevCam, eyeLngLat: null, eyeAltM: null, dragPx: 0 };
    const container = document.querySelector('.map-container');
    if (container) container.classList.add('mode-observer');
    _attachObserverInput();
  } else {
    // Keep the ORIGINAL prevCam — exit restores the pre-observer camera.
    S.observerView.id = id;
    S.observerView.pitch = OBSERVER_START_PITCH;
    S.observerView.eyeLngLat = null;
    S.observerView.eyeAltM = null;
  }
  if (S._agg3d && S._agg3d.popup) { try { S._agg3d.popup.remove(); } catch (e) { /* already gone */ } S._agg3d.popup = null; }
  setActiveViewshed(id); // drape this observer's viewshed
  // Force terrain tiles at the observer before sampling ground height.
  try { S.map3d.jumpTo({ center: [rec.observer.lng, rec.observer.lat], zoom: 14 }); } catch (e) { /* camera race */ }
  _lockObserverCamera(rec, 0);
  try { Diag.note('3d.obsview.enter', { sw: switching ? 1 : 0 }); } catch (_) {}
}

function _lockObserverCamera(rec, attempt) {
  const ov = S.observerView;
  if (!ov || ov.id !== rec.id || !S.map3d) return; // exited/switched while waiting
  const lng = rec.observer.lng, lat = rec.observer.lat;
  let g = null;
  try { g = S.map3d.queryTerrainElevation([lng, lat]); } catch (e) { /* terrain not ready */ }
  if (!Number.isFinite(g) && (attempt || 0) < 4) {
    S.map3d.once('idle', () => _lockObserverCamera(rec, (attempt || 0) + 1));
    return;
  }
  if (!Number.isFinite(g)) { try { Diag.note('3d.obsview.noterrain', {}); } catch (_) {} }
  // queryTerrainElevation returns the exaggerated rendered ground, so the eye
  // lands exactly eye-height above the terrain the user sees.
  ov.eyeLngLat = [lng, lat];
  ov.eyeAltM = observerEyeAltitudeM(g, PILOT_EYE_M, TERRAIN_EXAGGERATION);
  _applyObserverLook();
}

function _applyObserverLook() {
  const ov = S.observerView;
  if (!ov || !ov.eyeLngLat || !S.map3d) return;
  try {
    const cam = S.map3d.calculateCameraOptionsFromCameraLngLatAltRotation(
      ov.eyeLngLat, ov.eyeAltM, ov.bearing, ov.pitch, 0);
    // maplibre 5.24 returns a `roll: undefined` key here; jumpTo then calls
    // setRoll(undefined), which NaNs the view matrix and permanently wedges
    // the transform (every later jumpTo throws). Force a real number.
    if (!Number.isFinite(cam.roll)) cam.roll = 0;
    S.map3d.jumpTo(cam);
    // Re-apply per look change: pixelsPerMeter shifts with the derived zoom.
    const tr = S.map3d.transform;
    if (tr && typeof tr.overrideNearFarZ === 'function' && Number.isFinite(tr.pixelsPerMeter)) {
      tr.overrideNearFarZ(OBSERVER_NEAR_M * tr.pixelsPerMeter, OBSERVER_FAR_M * tr.pixelsPerMeter);
    }
  } catch (e) { /* mid-teardown */ }
}

function _attachObserverInput() {
  const canvas = S.map3d && S.map3d.getCanvas && S.map3d.getCanvas();
  if (!canvas) return;
  const ov = S.observerView;
  let last = null;
  const down = (e) => {
    if (!S.observerView) return;
    last = { x: e.clientX, y: e.clientY };
    S.observerView.dragPx = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* mouse w/o capture */ }
  };
  const move = (e) => {
    if (!last || !S.observerView) return;
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    S.observerView.dragPx += Math.abs(dx) + Math.abs(dy);
    const look = applyLookDrag(S.observerView.pitch, S.observerView.bearing, dx, dy);
    S.observerView.pitch = look.pitch;
    S.observerView.bearing = look.bearing;
    _applyObserverLook();
  };
  const up = () => { last = null; };
  const wheel = (e) => {
    if (!S.observerView) return;
    e.preventDefault();
    const look = wheelLook(S.observerView.pitch, S.observerView.bearing, e.deltaX, e.deltaY);
    S.observerView.pitch = look.pitch;
    S.observerView.bearing = look.bearing;
    _applyObserverLook();
  };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  ov._detachInput = () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('wheel', wheel);
  };
}

function exitObserverView() {
  const ov = S.observerView;
  if (!ov) return;
  S.observerView = null;
  const container = document.querySelector('.map-container');
  if (container) container.classList.remove('mode-observer');
  if (ov._detachInput) { try { ov._detachInput(); } catch (e) { /* canvas gone */ } }
  const m = S.map3d;
  if (m) {
    _OBS_HANDLERS.forEach(h => { try { m[h] && m[h].enable(); } catch (e) { /* handler absent */ } });
    try { if (m.transform && m.transform.clearNearFarZOverride) m.transform.clearNearFarZOverride(); } catch (e) { /* older engine */ }
    try { m.setCenterClampedToGround(true); } catch (e) { /* older engine */ }
    try {
      const p = ov.prevCam;
      m.jumpTo({ center: p.center, zoom: p.zoom, pitch: p.pitch, bearing: p.bearing });
    } catch (e) { /* mid-teardown */ }
    try { m.setMaxPitch(80); } catch (e) { /* keep raised */ }
  }
  try { Diag.note('3d.obsview.exit', {}); } catch (_) {}
}

// 3D click router: observer taps take precedence over the aggregate popup.
function _on3dClick(e) {
  if (S.observerView) {
    if (S.observerView.dragPx > 5) { S.observerView.dragPx = 0; return; } // DOM click still fires after our manual drags
    const id = _observer3dFeatureAt(e.point);
    if (id && id !== S.observerView.id) enterObserverView(id); // switch perspective
    else if (!id) exitObserverView();                          // tap anywhere else → exit
    return;                                                    // same-observer tap: no-op
  }
  const id = _observer3dFeatureAt(e.point);
  if (id) { enterObserverView(id); return; }
  _open3dPopup(e);
}

async function toggle3D() {
  if (S._canopyEditing) return; // finish/exit canopy editing first
  if (S.is3D) { _exit3D(); return; }
  if (_isConstrained() && !S._warned3d) {
    const go = (typeof confirm !== 'function') || confirm('3D terrain view uses significant memory and may be unstable on phones/tablets. Continue?');
    if (!go) return;
    S._warned3d = true;
  }
  const btn = document.getElementById('view3dToggle');
  if (btn) btn.textContent = '⛰ …';
  try {
    await _loadMaplibre();
  } catch (e) {
    if (btn) btn.textContent = '⛰ 3D';
    if (typeof alert === 'function') alert('Could not load the 3D engine — the 3D view needs an internet connection.');
    return;
  }
  _enter3D();
}

function _enter3D() {
  const container = document.querySelector('.map-container');
  if (!container || !S.map) return;
  // Drop tools that depend on 2D map clicks.
  if (S.drawHandler) { S.drawHandler.disable(); S.drawHandler = null; clearDrawBtns(); }
  if (typeof cancelViewshedPick === 'function') cancelViewshedPick();
  container.classList.add('mode-3d');
  S.is3D = true;
  const c = S.map.getCenter();
  const cam = leafletToMaplibreCamera(c.lat, c.lng, S.map.getZoom());
  if (!S.map3d) {
    try {
      S.map3d = new maplibregl.Map({
        container: 'map3d',
        style: build3dStyle(collect3dState()),
        center: cam.center, zoom: cam.zoom, pitch: 60, bearing: 0,
        maxPitch: 80, maxZoom: MAX_MAP_ZOOM - 1,
        attributionControl: false,
      });
      S.map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
      S.map3d.on('mousemove', e => {
        const el = document.getElementById('cursorCoord');
        if (el) el.textContent = `${e.lngLat.lat.toFixed(5)}°, ${e.lngLat.lng.toFixed(5)}°`;
      });
      S.map3d.on('click', _on3dClick);
      S.map3d.on('load', () => { _ensureVert3dLayer(); _updateVert3dVerts(); });
      S.map3d.on('error', ev => {
        try { Diag.noteThrottled('3d.err', 5000, { m: String(ev && ev.error && ev.error.message).slice(0, 120) }); } catch (_) {}
      });
    } catch (e) {
      container.classList.remove('mode-3d');
      S.is3D = false;
      S.map3d = null;
      if (typeof alert === 'function') alert('3D view failed to start (WebGL unavailable?).');
      return;
    }
  } else {
    S.map3d.jumpTo({ center: cam.center, zoom: cam.zoom });
    _sync3dNow();
    S.map3d.resize();
  }
  const btn = document.getElementById('view3dToggle');
  if (btn) { btn.textContent = '▦ 2D'; btn.classList.add('active'); btn.title = 'Return to 2D map'; }
  // Buildings are 3D-only value — fetch lazily on entry, preferring the ops
  // area (padded) over the current view, which may be zoomed way out.
  try {
    const b = (S.drawnItems && S.drawnItems.getLayers().length)
      ? S.drawnItems.getBounds().pad(0.3) : S.map.getBounds();
    fetchBuildings(b);
  } catch (e) { /* enhancement only */ }
  try { Diag.note('3d.enter', { z: Math.round(cam.zoom * 10) / 10 }); } catch (_) {}
}

function _exit3D() {
  if (S.observerView) exitObserverView(); // restore the orbit camera BEFORE the 2D copy-back below
  const container = document.querySelector('.map-container');
  if (S._agg3d && S._agg3d.popup) { try { S._agg3d.popup.remove(); } catch (e) { /* already gone */ } S._agg3d.popup = null; }
  if (S.map3d && S.map) {
    const c = S.map3d.getCenter();
    const cam = maplibreToLeafletCamera(c.lng, c.lat, S.map3d.getZoom());
    S.map.setView([cam.lat, cam.lng], Math.round(cam.zoom), { animate: false });
  }
  if (container) container.classList.remove('mode-3d');
  S.is3D = false;
  const btn = document.getElementById('view3dToggle');
  if (btn) {
    btn.textContent = '⛰ 3D';
    btn.classList.remove('active');
    btn.title = '3D terrain view — imagery layers drape on real terrain (data overlays stay in 2D)';
  }
  if (S.map) setTimeout(() => S.map.invalidateSize(), 50);
  _abortCanopy3dBuild(); // its progress bar would float over the 2D map
  // Desktop keeps the built tri meshes so re-entering 3D is instant (the
  // rebuild was the noticeable pause); constrained devices free the memory
  // and rebuild on the next entry instead.
  if (typeof _isConstrained === 'function' && _isConstrained()) {
    S._tri3dOpaque = null;
    S._tri3dOpaqueAnchor = null;
    S._tri3dCanopy = null;
    S._tri3dCanopyIndices = null;
    S._tri3dCanopyAnchor = null;
    S._tri3dState = {};
    S._canopy3dCache = null;
    S._canopy3dActive = undefined;
  }
  try { Diag.note('3d.exit', {}); } catch (_) {}
}

// --- CJS export for Node/Vitest ---
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    S, Diag, setText, setColor, setStatus, switchTab, togglePanel,
    showUpdateModal, dismissUpdateModal, _changelogEntriesHtml, showChangelog, showUpdateBanner, acceptDisclaimer,
    checkDeployedVersion, applyUpdate, fetchLatestVersion, _swRefreshShell, _swAwaitInstalled,
    getCanopyProxyBase, getCustomProxy, saveCanopyProxy, DEFAULT_DATA_PROXY, fetch3DEPDEM, fetchCanopyRaster, _cogTileToGrid,
    notifyProxyRateLimited, _proxyFetch,
    analyticsOptedOut, initUsageAnalytics, setAnalyticsOptOut, _shouldLoadAnalytics,
    renderRasterOverlay, _applyOverlayZoomCap, _hideOverlaysForZoom, _overlayDisplayPx, _isConstrained, setCanopyOpacity, setViewshedOpacity,
    toggleCanopyOverlay, loadCanopyForView,
    setShadowOpacity, toggleShadowOverlay, loadShadowForView, _renderShadowForTime, _updateShadowForTime, _shadowTime,
    startViewshedPick, cancelViewshedPick, onViewshedMapClick, runViewshed, clearAllViewsheds,
    genViewshedId, _ensureObserverLayer, _addObserverMarker, _observerPopupHtml, _toPersistable,
    _renderVisibleViewsheds, setActiveViewshed, toggleViewshedVisible, recomputeViewshed, renameViewshed, renameViewshedPrompt,
    removeViewshed, renderObserverList, restoreViewsheds,
    VLOS_RING_STYLE, _updateVlosGhost, _onVlosInputChange, _renderObserverRings,
    buildLayerControl, toggleLayer, setLayerVisible, updateWireDisplay,
    _sectionOpen, _sectionClose, toggleLayerSection, _persistLayerUiState, restoreLayerUiState,
    PLANS_OFF_SECTIONS, PLANS_OFF_LAYERS, togglePlansMode, _applyPlansMode, _plansLayerExists,
    _notePlansOverride, _plansSuppressed,
    openAggregatePopup, aggPopupStep, renderAggregatePopup, collectFeaturesAt,
    wirePopupAggregation, eachPopupLayer, _aggFeatureClick,
    AGG_SKIP_LAYERS, EXPORT_SKIP_LAYERS,
    computeAirspace, computeOpsData, computeAssessment,
    snapshotAtIdx, renderWeather, renderWind, refreshPanelForHour, updateTimeContextBanner,
    renderKp, _parseKpForecast,
    THRESHOLD_FIELDS, readActiveThresholds, onThresholdEdit,
    loadSopProfile, saveSopProfileFromUI, deleteSopProfileFromUI, populateSopDropdown, updateSopThresholdFields,
    fetchWeather, fetchKpIndex, fetchElevation, fetchSunMoon,
    renderNotamsTab, fetchWireHazards, processArea,
    fetchUtilityWires, _renderUtilityWires, _utilityWirePopup,
    tfrGeoJsonUrlForBounds, fetchLiveTFRs, fetchNotams, fetchLiveRestrictions,
    renderAutoCheckStatus, reCheckRestrictionsNow, _restrictionEmptyMsg,
    toDMS, fmtTfrTime, currentAreaPolygon,
    renderDeepLinks, renderTfrCards, renderNotamCards, renderImportStatus,
    renderImportedTfrLayer, renderImportedNotamLayer,
    importFaaFile, handleFaaFiles, ingestFaaFileText, applyTfrImport, toggleNotamShowAll,
    mergeTfrs, mergeNotams, afterFaaImport, setupTfrDropzone,
    parsePastedNotams, clearImportedNotams, focusTfr, focusNotam,
    fetchFAAairspace, renderFAAairspaceLayers, fetchProtectedAreas, renderProtectedAreaLayers,
    fetchFaaObstacles, renderObstacleLayer, updateObstacleDisplay,
    renderAirportMarkers, fetchNWSAlerts, renderNWSAlertCards, renderNWSAlertPolygons,
    renderForecastChart, fetchRadar,
    radarToggle, radarStep, updateRadarTime,
    openExport, closeExport, doExport, doExportGeoJson, getKMLCoords, populateExportModal,
    downloadBlob, exportRasterGeoTiff, exportRasterKmz, gatherVisibleLayerFolders, buildSunWindFolders,
    exportAllViewshedGeoTiffs, exportAllViewshedKmz, _exportObserverRecords, _exportViewshedPolygonRecords,
    _exportLayerRecords, _polyRingsGroups, _exportStyleForLayer, _exportNeedsDisclaimer,
    _exportSelectedLayerKeys, _exportArrowLengthM, EXPORT_DISCLAIMER, EXPORT_SUMMARY_SECTIONS,
    _exportNotamRecords, _exportTfrRecords, _exportAirportRecords, _exportLZRecords, _exportRasterData,
    collectExportFolderGroups, folderGroupsToKml, folderGroupsToGeoJsonFeatures,
    recordToKml, recordToGeoJsonFeature, _uuid, _areaRingLatLng, _exportSummaryDesc,
    saveConfig, updateClock, refreshData,
    proxiedArcgis, _arcgisGeoJsonUrl, _govArcgisUrl, _envelopeGeom, _bboxCacheKey, _prop,
    fetchGroundAccess, fetchPublicLands, fetchWaterFeatures, fetchHospitals,
    loadParcelsForView, _renderParcels, _parcelPopup, _setParcelChip, _parcelsOnMoveEnd,
    maybeShowParcelDisclaimer, ackParcelDisclaimer, PARCEL_DEBOUNCE_MS,
    _renderPublicLands, computeLandStatus, _renderHospitals,
    fetchTrails, _renderTrails, TRAILS_COLOR,
    _markSectionFromResults, _syncStatusFromMeta,
    loadCellCoverage, cellCoverageReadout, _pointInRegion, _ringsBBox,
    cacheCurrentView, gridForView, _cacheViewRaster, getSelectedTileProviders,
    initMap, startDraw, clearDrawBtns, clearArea, enterCoords, locateMe,
    _noteDeviceFix, searchAnchor, DEVICE_FIX_MAX_AGE_MS,
    closeCoordSearch, submitCoordSearch, onCoordSearchKey,
    _syncCoordRadiusRow, _coordSearchRadiusM,
    _memoGeocode, _cachedGeocode, _fetchGeocode, runGeocodeSearch,
    _setGeocodeBusy, _setGeocodeStatus,
    _renderGeocodeResults, _highlightGeocodeRow, pickGeocodeResult, _applyCoordTarget,
    getStoredTheme, applyTheme, cycleTheme,
    toggle3D, collect3dState, sync3d, _enter3D, _exit3D, _loadMaplibre,
    collect3dVectorGroups, _vec3dRecords, _open3dPopup, agg3dStep, _agg3dHtml, VEC3D_SKIP,
    enterObserverView, exitObserverView, _on3dClick, _observer3dFeatureAt, _lockObserverCamera, _applyObserverLook,
    _aircraft3dGroup, _refresh3dAircraft, _adsbPopupHtml,
    _overpassFetch, fetchBuildings, renderBuildingsLayer, _buildingsCap,
    getBuildings3dSetting, setBuildings3dMode, _buildings3dMode,
    _buildBuildingTriVerts, _vert3dMakeLayer, _updateVert3dVerts,
    _buildCanopy3dMeshChunked, _startCanopy3dBuild, cancelCanopy3dBuild, CANOPY_3D_COLOR,
    _update3dLight, _context3dTime,
    scrollTabs, updateScrollBtns,
    importKML, handleKMLFile, parseKML,
    copyBriefing, buildBriefingText,
    generatePDFBriefing, shareBriefingEmail, openInSARTopo,
    recordDataSourceError, clearDataSourceError, retryFailedSource, retryAllFailed, showDataSourceStatus,
    setAutoRefresh, loadFAAChart, removeChart, clearAllCharts, updateChartList, restoreFAACharts,
    fetchFireDanger, renderFirePerimeters, renderFireDangerCard,
    fetchNearbyAirports,
    initTimeBar, hideTimeBar,
    renderTerrainFeatures, renderLZMarkers,
    // Phase 6: SOP Profiles, Mission Logging
    loadSopProfile, saveSopProfileFromUI, deleteSopProfileFromUI, populateSopDropdown, updateSopThresholdFields,
    logMission, showMissionLogs, closeMissionLogModal, deleteMissionLogEntry, exportMissionLogsAsCSV,
    // ADS-B
    ADSB_APIS, fetchAdsb, _adsbAttemptUrls, updateAdsbTrails, renderAdsbMap, renderAdsbTab,
    startAdsbPolling, stopAdsbPolling, toggleAdsbPolling, adsbAglColor,
    ensureAdsbDem, adsbGroundElevFnFt, _adsbToRaw,
    refineLowCloseAdsbAgl, fetch3DEPPointElevations, _parseGetSamples, _adsbHiresKey, _isAdsbLowClose,
    // Per-section data freshness
    SECTION_DEFS, markSection, renderSectionMeta, renderAllSectionMeta, updateSection, _sectionUpdatable,
    // Canopy edit mode
    CANOPY_EDIT_BRUSH_SIZES, _setBaseOverlay, _applyCanopyEdits,
    startCanopyEdit, exitCanopyEdit, setCanopyEditSubMode, setCanopyBrushSize,
    onCanopyEditPolygon, canopyEditDelete, canopyEditCancelPoly, canopyEditUndo, canopyEditSave,
    clearCanopyEdits, _canopyEditPushOp, _canopyEditBarSync,
  };
}
