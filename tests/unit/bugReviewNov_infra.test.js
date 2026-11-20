// Regression tests for the November bug review, infrastructure group:
// data-proxy Worker (H3.4/H3.5), service worker tile caching (H10), offline
// IndexedDB helpers + notifications (H8/H20/Low 8), FAA chart import (H11/Low 6).
import { handleNotam, handleAdsb, _adsbCooldownUntil } from '../../tools/canopy-proxy/worker.js';

const fs = require('fs');
const path = require('path');
const sw = require('../../sw.js');
const offline = require('../../sar-preflight-offline.js');
const charts = require('../../sar-preflight-charts.js');

// ---------------------------------------------------------------- Worker /notam
describe('H3.4 handleNotam — a 200 without a notamList array is a failure', () => {
  const HOME = 'https://notams.aim.faa.gov/notamSearch/';
  const SEARCH = 'https://notams.aim.faa.gov/notamSearch/search';
  const url = () => new URL('https://proxy.example/notam?lat=38.685&lng=-120.99&radius=25');
  const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  let saved;
  beforeEach(() => { saved = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = saved; });
  function mock(pages) {
    let i = 0;
    globalThis.fetch = (u) => {
      if (u === HOME) return Promise.resolve(new Response('', { status: 200 }));
      if (u === SEARCH) return Promise.resolve(pages[Math.min(i++, pages.length - 1)]);
      return Promise.reject(new Error('unexpected ' + u));
    };
  }

  for (const body of [{ status: 'ERROR' }, {}, { notamList: null }, { notamList: 'x' }]) {
    it('answers 502 for ' + JSON.stringify(body), async () => {
      mock([ok(body)]);
      const res = await handleNotam(url(), '*');
      expect(res.status).toBe(502);
      const j = await res.json();
      expect(j.error).toMatch(/notamList/);
      expect(j.notamList).toEqual([]);
      expect(j.partial).toBe(false);
    });
  }

  it('a malformed later page fails the search and flags the earlier pages partial', async () => {
    const items = Array.from({ length: 30 }, (_, k) => ({ notamNumber: '01/' + k }));
    mock([ok({ notamList: items, totalNotamCount: 45 }), ok({})]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.partial).toBe(true);
    expect(j.notamList.length).toBe(30);
  });

  it('a genuine empty list is still a 200', async () => {
    mock([ok({ notamList: [], totalNotamCount: 0 })]);
    const res = await handleNotam(url(), '*');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------- Worker /adsb
describe('H3.5 handleAdsb — strict lat/lon/dist validation', () => {
  let calls, saved;
  beforeEach(() => {
    saved = globalThis.fetch;
    for (const k of Object.keys(_adsbCooldownUntil)) delete _adsbCooldownUntil[k];
    calls = [];
    globalThis.fetch = (u) => { calls.push(u); return Promise.resolve(new Response(JSON.stringify({ ac: [] }), { status: 200 })); };
  });
  afterEach(() => { globalThis.fetch = saved; });
  const req = q => handleAdsb(new URL('https://proxy.example/adsb?' + q), '*', {});

  for (const q of [
    'lat=38.6/../../x&lon=-121&dist=25', 'lat=38.6&lon=-121abc&dist=25', 'lat=&lon=-121&dist=25',
    'lat=95&lon=-121&dist=25', 'lat=38&lon=-181&dist=25', 'lat=38&lon=-121&dist=-5',
    'lat=38&lon=-121&dist=0.4', 'lat=38&lon=-121', 'lat=38&lon=-121&dist=abc',
  ]) {
    it('rejects ' + q + ' with 400 and contacts no provider', async () => {
      const res = await req(q);
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  }

  it('interpolates the PARSED numbers into the upstream URL and caps dist at 250', async () => {
    const res = await req('lat=%2038.690000&lon=-121.59&dist=900');
    expect(res.status).toBe(200);
    expect(calls[0]).toContain('/lat/38.69/lon/-121.59/dist/250');
  });
});

// ---------------------------------------------------------------- Service worker
describe('H10 service worker tile pre-download', () => {
  it('tileSubdomain matches Leaflet/MapLibre ((x + y) % 3 over a,b,c)', () => {
    expect(sw.tileSubdomain(0, 0)).toBe('a');
    expect(sw.tileSubdomain(1, 0)).toBe('b');
    expect(sw.tileSubdomain(335, 785)).toBe(['a', 'b', 'c'][(335 + 785) % 3]);
  });

  it('latlngToTile clamps to the tile grid (poles, antimeridian)', () => {
    const t = sw.latlngToTile(90, 180, 3);
    expect(t).toEqual({ x: 7, y: 0 });
    const b = sw.latlngToTile(-90, -180, 3);
    expect(b).toEqual({ x: 0, y: 7 });
    expect(Number.isFinite(sw.latlngToTile(89.99, 0, 10).y)).toBe(true);
  });

  describe('downloadTiles', () => {
    let saved, put, messages;
    beforeEach(() => {
      saved = { caches: globalThis.caches, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
      put = [];
      messages = [];
      globalThis.caches = { open: async () => ({ put: async (u) => { put.push(u); } }) };
    });
    afterEach(() => { globalThis.caches = saved.caches; globalThis.fetch = saved.fetch; });
    const client = { postMessage: m => messages.push(m) };
    const bounds = { south: 38.68, west: -121.0, north: 38.69, east: -120.99 };

    it('uses the subdomain the map will request for OpenTopoMap', async () => {
      globalThis.fetch = async () => ({ ok: true });
      await sw.downloadTiles({ bounds, zooms: [14], providers: ['topo'] }, client);
      expect(put.length).toBeGreaterThan(0);
      for (const u of put) {
        const m = /https:\/\/([abc])\.tile\.opentopomap\.org\/14\/(\d+)\/(\d+)\.png/.exec(u);
        expect(m).not.toBe(null);
        expect(m[1]).toBe(['a', 'b', 'c'][(+m[2] + +m[3]) % 3]);
      }
    });

    it('never reports a failed fetch as cached', async () => {
      let n = 0;
      globalThis.fetch = async () => { n++; if (n % 2) throw new Error('offline'); return { ok: n % 4 === 0 }; };
      await sw.downloadTiles({ bounds, zooms: [15], providers: ['satellite'] }, client);
      const done = messages.find(m => m.type === 'TILE_DOWNLOAD_COMPLETE');
      expect(done.total).toBe(put.length);
      expect(done.failed).toBe(done.attempted - put.length);
      expect(done.failed).toBeGreaterThan(0);
    });

    it('knows the light basemap pair', async () => {
      globalThis.fetch = async () => ({ ok: true });
      await sw.downloadTiles({ bounds, zooms: [12], providers: ['basemap_light', 'basemap_light_labels'] }, client);
      expect(put.some(u => u.includes('World_Light_Gray_Base'))).toBe(true);
      expect(put.some(u => u.includes('World_Light_Gray_Reference'))).toBe(true);
    });
  });

  it('sectional strategy does not serve a legacy opaque entry to a CORS request', async () => {
    const saved = { caches: globalThis.caches, fetch: globalThis.fetch };
    const fresh = { status: 200, clone() { return this; } };
    globalThis.caches = { match: async () => ({ type: 'opaque', status: 0 }), open: async () => ({ put: async () => {} }) };
    globalThis.fetch = async () => fresh;
    try {
      const r = await sw.sectionalTileStrategy({ url: 'https://tiles.arcgis.com/x/VFR_Sectional/MapServer/tile/9/1/1', mode: 'cors' });
      expect(r).toBe(fresh);
    } finally { globalThis.caches = saved.caches; globalThis.fetch = saved.fetch; }
  });
});

// ---------------------------------------------------------------- Offline helpers
describe('H8 / Low 8 offline IndexedDB helpers', () => {
  it('clearViewsheds(null) touches nothing (it used to clear every area)', async () => {
    const saved = globalThis.indexedDB;
    const open = vi.fn(() => { throw new Error('must not open'); });
    globalThis.indexedDB = { open };
    try {
      await offline.clearViewsheds(null);
      await offline.clearViewsheds(undefined);
      expect(open).not.toHaveBeenCalled();
    } finally { globalThis.indexedDB = saved; }
  });

  it('a write transaction that aborts or errors settles (rejects) instead of hanging', async () => {
    const tx1 = {}; const p1 = offline._txDone(tx1); tx1.onabort();
    await expect(p1).rejects.toThrow(/abort/);
    const tx2 = { error: new Error('QuotaExceededError') }; const p2 = offline._txDone(tx2); tx2.onerror();
    await expect(p2).rejects.toThrow(/Quota/);
    const tx3 = {}; const p3 = offline._txDone(tx3); tx3.oncomplete();
    await expect(p3).resolves.toBeUndefined();
  });
});

describe('H20 checkAndNotify', () => {
  let saved, shown;
  beforeEach(() => {
    saved = { N: globalThis.Notification, vis: Object.getOwnPropertyDescriptor(document, 'visibilityState') };
    shown = [];
    globalThis.Notification = function (title, opts) { shown.push({ title, body: opts.body }); };
    globalThis.Notification.permission = 'granted';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  afterEach(() => {
    globalThis.Notification = saved.N;
    if (saved.vis) Object.defineProperty(document, 'visibilityState', saved.vis); else delete document.visibilityState;
  });

  it('reads `limits`, notifies once on entry into limits, never with verdict words', () => {
    offline.checkAndNotify({ limits: [], advisories: ['x'] });
    expect(shown).toHaveLength(0);
    offline.checkAndNotify({ level: 'NO-GO', limits: ['Wind 30 mph exceeds 25 mph limit'], advisories: [] });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('SAR Preflight: 1 LIMIT EXCEEDED');
    expect(shown[0].title).not.toMatch(/NO-GO|CAUTION|\bGO\b/);
    expect(shown[0].body).toContain('Wind 30 mph');
    // A recompute that still has limits is not a transition — no repeat.
    offline.checkAndNotify({ limits: ['Wind 30 mph exceeds 25 mph limit', 'Gust'], advisories: [] });
    expect(shown).toHaveLength(1);
  });

  it('does nothing when notifications are not enabled', () => {
    globalThis.Notification.permission = 'default';
    offline.checkAndNotify({ limits: [] });
    offline.checkAndNotify({ limits: ['Some limit'] });
    expect(shown).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- App wiring
describe('app: viewsheds clear-all, tile providers, FAA chart re-import', () => {
  const core = require('../../sar-preflight-core.js');
  Object.assign(globalThis, core);
  Object.assign(globalThis, require('../../sar-preflight-raster.js'));
  function chain() {
    const fn = function () { return chain(); };
    return new Proxy(fn, { get(t, p) { if (p === 'then') return undefined; if (p in t) return t[p]; return chain(); } });
  }
  const mockGroup = () => { const g = { _l: [], addTo() { return g; }, clearLayers() { g._l.length = 0; }, addLayer(l) { g._l.push(l); },
    getLayers() { return g._l; }, eachLayer(cb) { g._l.forEach(cb); }, hasLayer() { return false; }, removeLayer() {} }; return g; };
  globalThis.L = new Proxy({ layerGroup: () => mockGroup(), Browser: { mobile: false } },
    { get(t, p) { return p in t ? t[p] : chain(); } });
  const app = require('../../sar-preflight.js');
  const { S } = app;
  const APP_BODY = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8')
    .match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');

  beforeEach(() => {
    document.body.innerHTML = APP_BODY;
    S.map = new Proxy({ hasLayer: () => true, addLayer() {}, removeLayer() {} }, { get(t, p) { return p in t ? t[p] : chain(); } });
    S.mapLayers = {};
  });

  describe('H8 clearAllViewsheds', () => {
    beforeEach(() => {
      globalThis.clearViewsheds = vi.fn(async () => {});
      globalThis.deleteViewshed = vi.fn(async () => {});
      globalThis.saveAppState = vi.fn();
    });
    afterEach(() => { ['clearViewsheds', 'deleteViewshed', 'saveAppState', 'areaKey'].forEach(k => delete globalThis[k]); });

    it('with no area drawn: never clears the whole store, deletes only the listed records, and drops the overlay', () => {
      S.areaCenter = null;
      S.viewsheds = [makeViewshedRecord({ id: 'v1', observer: { lat: 38.7, lng: -121 } }),
        makeViewshedRecord({ id: 'v2', observer: { lat: 38.7, lng: -121 } })];
      S.mapLayers.viewshed = { setOpacity() {} };
      S._overlayWanted = { canopy: false, viewshed: true, shadow: false };
      S._raster3d = { viewshed: { url: 'x' } };
      app.clearAllViewsheds();
      expect(globalThis.clearViewsheds).not.toHaveBeenCalled();
      expect(globalThis.deleteViewshed.mock.calls.map(c => c[0]).sort()).toEqual(['v1', 'v2']);
      expect(S._overlayWanted.viewshed).toBe(false);
      expect(S.mapLayers.viewshed).toBe(null);
      expect(S._raster3d.viewshed).toBeUndefined();
      expect(S.viewsheds).toHaveLength(0);
    });

    it('with an area drawn: clears only that area', () => {
      S.areaCenter = { lat: 38.7, lng: -121 };
      globalThis.areaKey = offline.areaKey;
      S.viewsheds = [];
      app.clearAllViewsheds();
      expect(globalThis.clearViewsheds).toHaveBeenCalledWith(offline.areaKey(38.7, -121));
    });
  });

  it('H10.3 pre-download fetches the basemap pair the active theme shows', () => {
    S.theme = 'light-map';
    expect(app.getSelectedTileProviders().slice(0, 2)).toEqual(['basemap_light', 'basemap_light_labels']);
    S.theme = 'dark';
    expect(app.getSelectedTileProviders().slice(0, 2)).toEqual(['basemap', 'basemap_labels']);
  });

  describe('H11 FAA chart re-import', () => {
    let store, savedCaches;
    beforeEach(() => {
      store = new Map();
      savedCaches = globalThis.caches;
      globalThis.caches = { open: async () => ({
        keys: async () => [...store.keys()].map(url => ({ url })),
        delete: async req => store.delete(req.url || req),
        put: async (req, res) => { store.set(req.url || req, res); },
        match: async u => store.get(u) || null,
      }) };
      globalThis.sanitizeChartName = charts.sanitizeChartName;
      globalThis.saveAppState = vi.fn();
      L.TileLayer = Object.assign(L.TileLayer || {}, { FAAChart: function () { return { addTo() { return this; } }; } });
    });
    afterEach(() => {
      globalThis.caches = savedCaches;
      ['sanitizeChartName', 'saveAppState', 'processVFRChart'].forEach(k => delete globalThis[k]);
    });

    it('keeps the newly written tiles, and never deletes a chart whose id merely starts with this one', async () => {
      const T = (id, n) => `https://local-tiles.sar-preflight/faa-sectional-${id}/7/${n}/1.png`;
      store.set(T('los-angeles', 1), 'old');
      store.set(T('los-angeles-tac', 1), 'tac');
      S.faaCharts = { 'los-angeles': { chartId: 'los-angeles', layer: {}, chartName: 'Los Angeles' },
        'los-angeles-tac': { chartId: 'los-angeles-tac', layer: {}, chartName: 'Los Angeles TAC' } };
      globalThis.processVFRChart = vi.fn(async (file, onProgress, opts) => {
        store.set(T(opts.chartId, 2), 'new');
        return { chartId: opts.chartId, chartName: 'Los Angeles', bounds: {}, zoomRange: [7, 12], tileCount: 1 };
      });
      await app.loadFAAChart({ files: [{ name: 'Los Angeles.tif' }] });
      expect(globalThis.processVFRChart).toHaveBeenCalled();
      expect(store.get(T('los-angeles', 2))).toBe('new');      // new tiles survive
      expect(store.has(T('los-angeles', 1))).toBe(false);      // old ones removed first
      expect(store.get(T('los-angeles-tac', 1))).toBe('tac');  // other chart untouched
      expect(S.faaCharts['los-angeles']).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------- Low 6 chart reprojection
describe('Low 6 processVFRChart reprojection', () => {
  // A tiny fake "LCC" chart (1 km square): lng = x/1e5, and parallels curve so
  // the top edge's middle is 0.0025° higher than its corners.
  const K = 100;
  const fwd = ([x, y]) => { const lng = -121 + x / 1e5; return [lng, 38 + y / 1e5 - K * (x / 1e5) ** 2]; };
  const inv = ([lng, lat]) => { const x = (lng + 121) * 1e5; return [x, (lat - 38 + K * (x / 1e5) ** 2) * 1e5]; };
  let saved, firstTileLats;

  beforeEach(() => {
    saved = { GeoTIFF: globalThis.GeoTIFF, proj4: globalThis.proj4, caches: globalThis.caches,
      gc: HTMLCanvasElement.prototype.getContext, tb: HTMLCanvasElement.prototype.toBlob };
    firstTileLats = [];
    const image = {
      getWidth: () => 10, getHeight: () => 10,
      getTiePoints: () => [{ i: 0, j: 0, x: -500, y: 500 }],
      getFileDirectory: () => ({ ModelPixelScale: [100, 100], GeoAsciiParams: 'Lambert Conformal Conic', GeoDoubleParams: [38, -121, 33, 45, 0, 0] }),
      getGeoKeys: () => ({}),
      readRasters: async () => [new Uint8Array(100).fill(200), new Uint8Array(100).fill(200), new Uint8Array(100).fill(200)],
    };
    globalThis.GeoTIFF = { fromArrayBuffer: async () => ({ getImage: async () => image }) };
    const proj4 = (a) => ({ forward: a === 'LCC_CHART' ? fwd : (p => { if (firstTileLats.length < 65536) firstTileLats.push(p[1]); return inv(p); }) });
    proj4.defs = () => {};
    globalThis.proj4 = proj4;
    globalThis.caches = { open: async () => ({ put: async () => {} }) };
    HTMLCanvasElement.prototype.getContext = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} });
    HTMLCanvasElement.prototype.toBlob = cb => cb(new Blob([]));
  });
  afterEach(() => {
    globalThis.GeoTIFF = saved.GeoTIFF; globalThis.proj4 = saved.proj4; globalThis.caches = saved.caches;
    HTMLCanvasElement.prototype.getContext = saved.gc; HTMLCanvasElement.prototype.toBlob = saved.tb;
  });

  it('samples tile rows in Web Mercator Y and widens north to the LCC arc', async () => {
    const file = { name: 'Test Chart.tif', arrayBuffer: async () => new ArrayBuffer(8) };
    const res = await charts.processVFRChart(file, () => {}, { collarMargin: 0 });
    // Corners alone gave 38.005 - 0.0025; the top edge's middle reaches 38.005.
    expect(res.bounds.north).toBeCloseTo(38.005, 6);
    // First tile rendered is z7 at the chart's north-west tile: every pixel row
    // samples the Mercator latitude of its centre, not a linear interpolation.
    const z = 7, n = 2 ** z;
    const ty = charts.latlngToTileCoord(res.bounds.north, res.bounds.west, z).y;
    for (const py of [0, 64, 128, 200, 255]) {
      const want = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + (py + 0.5) / 256) / n))) * 180 / Math.PI;
      expect(firstTileLats[py * 256]).toBeCloseTo(want, 9);
    }
  });
});
