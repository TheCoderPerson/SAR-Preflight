// Regression tests for the Nov 2026 bug review — export, briefing capture,
// view caching, KML area import, FAA charts, mission log and small UI items.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// ---- Minimal Leaflet mock with real classes so `instanceof` works ----
const popupOf = (html) => (html == null ? undefined : { getContent: () => html });
class MGroup {
  constructor(layers, popup) { this._layers = layers || []; this._p = popupOf(popup); }
  getLayers() { return this._layers; }
  getPopup() { return this._p; }
  addLayer(l) { this._layers.push(l); return this; }
  clearLayers() { this._layers = []; }
  addTo() { return this; }
}
class MPolyline {
  constructor(latlngs, popup) { this._ll = latlngs; this._p = popupOf(popup); }
  getLatLngs() { return this._ll; }
  getPopup() { return this._p; }
}
class MPolygon extends MPolyline {}
class MMarker {
  constructor(ll, popup) { this._ll = ll; this._p = popupOf(popup); }
  getLatLng() { return this._ll; }
  getPopup() { return this._p; }
}
class MFaaChart { constructor(opts) { this.options = opts; } }
globalThis.L = {
  Polygon: MPolygon, Polyline: MPolyline, Marker: MMarker, Circle: class {}, CircleMarker: class {},
  layerGroup: () => new MGroup([]),
  TileLayer: { FAAChart: MFaaChart },
  // parseKML builders: record the call, then stop before processArea runs.
  rectangle: vi.fn(() => { throw new Error('stop-rectangle'); }),
  polygon: vi.fn(() => { throw new Error('stop-polygon'); }),
  circle: vi.fn(() => { throw new Error('stop-circle'); }),
};

const app = require('../../sar-preflight.js');
const {
  S, _exportLayerRecords, gatherVisibleLayerFolders, collectExportFolderGroups,
  folderGroupsToGeoJsonFeatures, populateExportModal, _exportAirportRecords,
  downloadBlob, exportAllViewshedKmz, exportMissionLogsAsCSV, showMissionLogs,
  showDataSourceStatus, updateChartList, clearAllCaches, restoreFAACharts,
  parseKML, fetchFAAairspace, _cacheViewJobOutcome, CACHE_VIEW_JOBS,
  briefingPdfSlices, _captureBriefingMap, _compositeMapCapture, shareBriefingEmail,
  _openEmailBriefingWindow, checkDisclaimer, acceptDisclaimer, _updateTimeBar,
  onCoordSearchKey, resolveSectionalEdition,
} = app;

const LL = (lat, lng) => ({ lat, lng });

// Record every file the app hands to the browser (anchor download + blob).
function captureDownloads() {
  const out = [];
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
  const realClick = HTMLAnchorElement.prototype.click;
  let lastBlob = null;
  URL.createObjectURL = (b) => { lastBlob = b; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () { out.push({ name: this.download, blob: lastBlob }); };
  out.restore = () => {
    URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;
    HTMLAnchorElement.prototype.click = realClick;
  };
  return out;
}

beforeEach(() => {
  S.map = { hasLayer: () => true, distance: () => 1500 };
  S.mapLayers = {};
  S.areaCenter = LL(38.7, -120.99);
  S.areaType = 'CIRCLE';
  S.currentArea = { getRadius: () => 1500 };
  S.viewsheds = [];
  S.lzs = [];
  document.body.innerHTML = '';
});

// ------------------------------------------------------------------ C1
describe('C1 — popup bound on an L.geoJSON wrapper exports its geometry', () => {
  // layerGroup (no popup) → L.geoJSON wrapper (popup) → leaf geometries (no popup)
  const outer = [LL(38.6, -121.0), LL(38.6, -120.9), LL(38.7, -120.9), LL(38.7, -121.0)];
  const hole = [LL(38.62, -120.98), LL(38.62, -120.95), LL(38.65, -120.95)];
  const polyB = [LL(38.8, -121.0), LL(38.8, -120.9), LL(38.9, -120.9)];
  function airspaceGroup() {
    return new MGroup([
      new MGroup([new MPolygon([outer, hole])], '<b>Class D</b> — SACRAMENTO'),       // polygon with a hole
      new MGroup([new MPolygon([[outer], [polyB]])], '<b>Class E</b> — MULTI'),       // MultiPolygon
      new MGroup([new MPolyline([[LL(38.7, -121), LL(38.71, -121.01)], [LL(38.72, -121), LL(38.73, -121.02)]])], 'Trail pair'), // MultiLineString
      new MGroup([new MMarker(LL(38.75, -120.95))], 'Point feature'),
    ]);
  }

  it('descends into the wrapper and keeps holes / multi-parts / multi-lines', () => {
    const recs = _exportLayerRecords('faa_class_airspace', airspaceGroup());
    const polys = recs.filter(r => r.kind === 'polygon');
    const lines = recs.filter(r => r.kind === 'line');
    const pts = recs.filter(r => r.kind === 'point');
    expect(polys).toHaveLength(3);                       // 1 holed + 2 multipolygon parts
    expect(polys[0].rings).toHaveLength(2);              // outer + hole kept
    expect(polys[0].name).toBe('Class D — SACRAMENTO');  // wrapper popup names the child
    expect(polys[1].name).toBe('Class E — MULTI');
    expect(lines).toHaveLength(2);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ lat: 38.75, lng: -120.95, name: 'Point feature' });
  });

  it('the export modal count matches features that actually reach KML and CalTopo GeoJSON', () => {
    S.mapLayers.faa_class_airspace = airspaceGroup();
    document.body.innerHTML = '<div id="exportLayerList"></div>';
    populateExportModal();
    expect(document.getElementById('exportLayerList').textContent).toContain('Class Airspace (4)');
    const kml = gatherVisibleLayerFolders(null);
    expect((kml.match(/<Polygon>/g) || []).length).toBe(3);
    expect(kml).toContain('<LineString>');
    expect(kml).toContain('<Point>');
    let n = 0;
    const feats = folderGroupsToGeoJsonFeatures(collectExportFolderGroups(null), () => 'id' + (n++));
    expect(feats.filter(f => f.geometry).length).toBe(6);
  });

  it('drops far-away parts of a multi-part feature (statewide land-status multipolygons), keeps single parts', () => {
    const b = { getSouth: () => 38.70, getNorth: () => 38.76, getWest: () => -120.55, getEast: () => -120.47 };
    S.areaBounds = b;
    try {
      const near = [LL(38.72, -120.52), LL(38.72, -120.50), LL(38.74, -120.50)];
      const far = [LL(32.61, -117.11), LL(32.62, -117.11), LL(32.62, -117.10)];       // San Diego
      const farLine = [LL(34.0, -118.2), LL(34.1, -118.3)];
      const g = new MGroup([
        new MGroup([new MPolygon([[near], [far]])], 'Undetermined — MULTI'),
        new MGroup([new MPolygon([far])], 'Single far part'),                            // single part: kept
        new MGroup([new MPolyline([[LL(38.71, -120.5), LL(38.72, -120.49)], farLine])], 'Road pair'),
      ]);
      const recs = _exportLayerRecords('usfs_roads', g);
      expect(recs.filter(r => r.name === 'Undetermined — MULTI')).toHaveLength(1);
      expect(recs.find(r => r.name === 'Undetermined — MULTI').rings[0][0]).toEqual([38.72, -120.52]);
      expect(recs.filter(r => r.name === 'Single far part')).toHaveLength(1);
      expect(recs.filter(r => r.name === 'Road pair')).toHaveLength(1);
      S.areaBounds = null;                                                               // no area: nothing clipped
      expect(_exportLayerRecords('usfs_roads', g)).toHaveLength(5);
    } finally {
      S.areaBounds = null;
    }
  });
});

// ------------------------------------------------------------------ Low 5
describe('Low 5 — export details', () => {
  it('a sea-level airport keeps its 0 ft elevation in the export description', () => {
    S.nearbyAirports = [{ icao: 'KSFO', name: 'San Francisco', type: 'large_airport', elevation_ft: 0, lat: 38.7, lng: -120.99 }];
    const [rec] = _exportAirportRecords();
    expect(rec.description).toContain('Elevation: 0 ft');
  });

  it('downloadBlob revokes the object URL only after the download has started', () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = revoke;
    HTMLAnchorElement.prototype.click = () => {};
    try {
      downloadBlob(new Blob(['x']), 'a.txt');
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30000);
      expect(revoke).toHaveBeenCalledWith('blob:x');
    } finally {
      vi.useRealTimers();
      URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('briefingPdfSlices tiles the page without overlap or gaps, each inside the usable height', () => {
    const sl = briefingPdfSlices(1000, 2, 200); // 400 px per page
    expect(sl.map(s => [s.yPx, s.hPx])).toEqual([[0, 400], [400, 400], [800, 200]]);
    sl.forEach(s => expect(s.hMm).toBeLessThanOrEqual(200));
    expect(briefingPdfSlices(300, 2, 200)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ M23
describe('M23 — viewshed KMZ filenames, mission-log CSV, FAA charts', () => {
  let realCtx, realToData;
  beforeEach(() => {
    realCtx = HTMLCanvasElement.prototype.getContext;
    realToData = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.getContext = () => ({ putImageData() {} });
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
    if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  });
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = realCtx;
    HTMLCanvasElement.prototype.toDataURL = realToData;
  });

  it('exportAllViewshedKmz de-duplicates same-named observers like the GeoTIFF export', () => {
    const grid = { cols: 2, rows: 2, bounds: { west: -121, east: -120.99, south: 38.7, north: 38.71 } };
    S.viewsheds = [
      { id: 'a', name: 'Observer', grid, mask: new Uint8Array(4).fill(1) },
      { id: 'b', name: 'Observer', grid, mask: new Uint8Array(4).fill(1) },
    ];
    const dl = captureDownloads();
    try { exportAllViewshedKmz(); } finally { dl.restore(); }
    const names = dl.map(d => d.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[1]).toMatch(/^SAR_Viewshed_Observer_2_/);
  });

  it('mission-log CSV escapes quotes in every field and keeps real 0 readings', async () => {
    globalThis.getMissionLogs = async () => [{
      id: 1, timestamp: Date.UTC(2026, 10, 20), rpic: 'Jo "Ace" Smith', aircraft: 'M30 "T"',
      sopProfile: 'Night "B"', areaCenter: { lat: 38.7, lng: -120.99 }, areaType: 'CIRCLE',
      wx: { windSpeed: 0, visibility: 0, temp: 0 }, nwsAlerts: 0, wireHazards: 0, notes: 'say "hi"',
    }];
    const dl = captureDownloads();
    try { await exportMissionLogsAsCSV(); } finally { dl.restore(); delete globalThis.getMissionLogs; }
    expect(dl).toHaveLength(1);
    const csv = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsText(dl[0].blob); });
    const row = csv.split('\n')[1];
    expect(row).toContain('"Jo ""Ace"" Smith"');
    expect(row).toContain('"M30 ""T"""');
    expect(row).toContain('"Night ""B"""');
    expect(row).toContain('"say ""hi"""');
    expect(row).toContain('"CIRCLE","0","0","0"'); // wind, visibility, temp
  });

  it('restoreFAACharts adds the restored charts to the layer control', async () => {
    document.body.innerHTML = '<div id="layerList"></div><div id="chartList"></div><button id="btnClearCharts"></button>';
    S.map = { hasLayer: () => false };
    S.faaCharts = {};
    S.wireHazardCounts = {}; S.utilityWireCounts = {}; S.nwsAlerts = [];
    globalThis.getAppState = async () => [{ chartId: 'sf-sec', chartName: 'San Francisco SEC', bounds: {}, zoomRange: [8, 11] }];
    globalThis.saveAppState = () => {};
    window.caches = { open: async () => ({ keys: async () => [{ url: 'https://local-tiles.sar-preflight/faa-sectional-sf-sec/8/1/2.png' }] }) };
    try { await restoreFAACharts(); } finally { delete globalThis.getAppState; delete window.caches; }
    expect(S.faaCharts['sf-sec']).toBeTruthy();
    expect(document.getElementById('layerList').innerHTML).toContain('San Francisco SEC');
  });

  it('chart names from file names are escaped and never spliced into onclick JS', () => {
    document.body.innerHTML = '<div id="chartList"></div><button id="btnClearCharts"></button><div id="layerList"></div>';
    S.map = { hasLayer: () => false };
    S.wireHazardCounts = {}; S.utilityWireCounts = {}; S.nwsAlerts = [];
    S.faaCharts = { evil: { chartId: 'evil', chartName: '<img src=x onerror="window.__pwn=1">.tif', layer: {} } };
    updateChartList();
    app.buildLayerControl();
    for (const id of ['chartList', 'layerList']) {
      const el = document.getElementById(id);
      expect(el.querySelector('img')).toBeNull();
      expect(el.textContent).toContain('<img src=x');
    }
    const row = document.querySelector('#layerList [data-layer="chart_evil"]');
    expect(row.getAttribute('onclick')).toBe('toggleLayer(this.dataset.layer,this)');
    expect(document.querySelector('#chartList button').dataset.chartId).toBe('evil');
  });

  it('clearAllCaches drops imported charts whose tiles the SW wipe deletes', () => {
    document.body.innerHTML = '<div id="chartList"></div><button id="btnClearCharts"></button><div id="layerList"></div><span id="cacheStatus"></span>';
    const layer = {};
    const removed = [];
    S.map = { hasLayer: (l) => l === layer, removeLayer: (l) => removed.push(l) };
    S.wireHazardCounts = {}; S.utilityWireCounts = {}; S.nwsAlerts = [];
    S.faaCharts = { 'sf-sec': { chartId: 'sf-sec', chartName: 'SF', layer } };
    S.mapLayers = { 'chart_sf-sec': layer };
    const posted = [];
    const saved = [];
    globalThis.saveAppState = (k, v) => saved.push([k, v]);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: { postMessage: (m) => posted.push(m) } } });
    try { clearAllCaches(); } finally { delete navigator.serviceWorker; }
    expect(posted).toEqual([{ type: 'CLEAR_TILE_CACHE' }]);
    expect(S.faaCharts).toEqual({});
    expect(S.mapLayers['chart_sf-sec']).toBeUndefined();
    expect(removed).toEqual([layer]);
    expect(saved).toContainEqual(['faaCharts', []]);
    expect(document.getElementById('cacheStatus').textContent).toContain('1 imported chart removed');
  });
});

// ------------------------------------------------------------------ H16
describe('H16 — external / user text is escaped in modals and briefings', () => {
  const EVIL = '<img src=x onerror="window.__pwn=1">';

  it('showMissionLogs escapes RPIC, aircraft and notes', async () => {
    document.body.innerHTML = '<div id="missionLogList"></div><div id="missionLogModal"></div>';
    globalThis.getMissionLogs = async () => [{ id: 7, timestamp: Date.now(), rpic: EVIL, aircraft: EVIL, notes: EVIL }];
    try { await showMissionLogs(); } finally { delete globalThis.getMissionLogs; }
    const list = document.getElementById('missionLogList');
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x');
    expect(list.querySelector('button').getAttribute('onclick')).toBe('deleteMissionLogEntry(7)');
  });

  it('showDataSourceStatus escapes source names and error text; RETRY uses a listener', () => {
    document.body.innerHTML = '<div><div id="assessmentBanner"></div></div>';
    S.dataSourceErrors = { ["x');window.__pwn=1;('"]: { message: EVIL } };
    showDataSourceStatus();
    const box = document.getElementById('dataSourceWarning');
    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain('<img src=x');
    const retry = [...box.querySelectorAll('button')].find(b => b.textContent === 'RETRY');
    expect(retry.getAttribute('onclick')).toBeNull();
    S.dataSourceErrors = {};
  });

  it('the email briefing escapes RPIC / assessment / section text', () => {
    document.body.innerHTML = `<input id="cfgRPIC" value='${EVIL.replace(/'/g, '')}'>
      <span id="assessBadge">1 ADVISORY</span><span id="assessText">${EVIL.replace(/</g, '&lt;')}</span>`;
    let written = '';
    const realOpen = window.open;
    window.open = () => ({ document: { write: (h) => { written += h; }, close() {} } });
    try { _openEmailBriefingWindow(null); } finally { window.open = realOpen; }
    const doc = new DOMParser().parseFromString(written, 'text/html');
    expect(doc.querySelector('img')).toBeNull();
    expect(written).toContain('&lt;img src=x');
    expect(written).toContain('Map image unavailable');
  });
});

// ------------------------------------------------------------------ H12
describe('H12 — briefing map capture', () => {
  let realCtx, realToData, ctxs;
  beforeEach(() => {
    realCtx = HTMLCanvasElement.prototype.getContext;
    realToData = HTMLCanvasElement.prototype.toDataURL;
    ctxs = [];
    HTMLCanvasElement.prototype.getContext = function () {
      if (!this._fakeCtx) {
        this._fakeCtx = { canvas: this, drawn: [], globalAlpha: 1, scale() {}, fillRect() {},
          drawImage(el) { this.drawn.push(el); }, getImageData() { return { data: [0, 0, 0, 0] }; } };
        ctxs.push(this._fakeCtx);
      }
      return this._fakeCtx;
    };
    HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,MAP'; };
    S.is3D = false; S.map3d = null;
  });
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = realCtx;
    HTMLCanvasElement.prototype.toDataURL = realToData;
    delete globalThis.html2canvas;
    S.is3D = false; S.map3d = null;
  });

  const rect = (el, left, top, width, height) => { el.getBoundingClientRect = () => ({ left, top, width, height }); return el; };
  const loaded = (img) => {
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 16 });
    return img;
  };
  function buildMap() {
    document.body.innerHTML = `<div id="map">
      <div class="leaflet-pane leaflet-overlay-pane">
        <canvas id="vecCanvas"></canvas>
        <img id="canopyImg" class="leaflet-image-layer" style="opacity:0.6" src="data:image/png;base64,AAAA">
        <img id="foreignImg" class="leaflet-image-layer" src="https://tiles.example.com/radar.png">
      </div>
      <div class="leaflet-pane leaflet-marker-pane">
        <img id="obsPin" class="leaflet-marker-icon" src="data:image/png;base64,BBBB">
      </div></div>`;
    const map = rect(document.getElementById('map'), 0, 0, 400, 300);
    rect(document.getElementById('vecCanvas'), -20, -20, 440, 340);
    loaded(rect(document.getElementById('canopyImg'), 50, 40, 100, 80));
    loaded(rect(document.getElementById('foreignImg'), 0, 0, 400, 300));
    loaded(rect(document.getElementById('obsPin'), 200, 150, 25, 41));
    return map;
  }

  it('composites overlay-pane canvases, image overlays and <img> markers; skips tainting images', async () => {
    const map = buildMap();
    globalThis.html2canvas = async () => document.createElement('canvas');
    const url = await _compositeMapCapture(map);
    expect(url).toBe('data:image/jpeg;base64,MAP');
    const drawn = ctxs[0].drawn.map(el => el.id || el.tagName);
    expect(drawn).toContain('vecCanvas');
    expect(drawn).toContain('canopyImg');
    expect(drawn).toContain('obsPin');
    expect(drawn).not.toContain('foreignImg');
  });

  it('a tainted capture retries without base tiles instead of failing the briefing', async () => {
    const map = buildMap();
    let tileCalls = 0;
    globalThis.html2canvas = async () => { tileCalls++; return document.createElement('canvas'); };
    let first = true;
    HTMLCanvasElement.prototype.toDataURL = function () {
      if (first) { first = false; const e = new Error('tainted'); e.name = 'SecurityError'; throw e; }
      return 'data:image/jpeg;base64,NOTILES';
    };
    expect(await _compositeMapCapture(map)).toBe('data:image/jpeg;base64,NOTILES');
    expect(tileCalls).toBe(1); // the retry skipped html2canvas
  });

  it('in 3D the briefing reads the WebGL canvas from the render frame, not the hidden 2D map', async () => {
    let cb = null;
    S.is3D = true;
    S.map3d = {
      once(ev, fn) { if (ev === 'render') cb = fn; },
      triggerRepaint() { cb && cb(); },
      getCanvas: () => ({ toDataURL: () => 'data:image/jpeg;base64,THREE_D' }),
    };
    expect(await _captureBriefingMap()).toBe('data:image/jpeg;base64,THREE_D');
  });

  it('every email briefing captures the map afresh (no stale image from another area)', async () => {
    document.body.innerHTML = '<span id="assessBadge">NOMINAL</span><span id="assessText"></span>';
    S.currentArea = { getRadius: () => 1500 };
    let n = 0, cb = null;
    S.is3D = true;
    S.map3d = {
      once(ev, fn) { cb = fn; }, triggerRepaint() { cb && cb(); },
      getCanvas: () => ({ toDataURL: () => 'data:image/jpeg;base64,AREA' + (++n) }),
    };
    const pages = [];
    const realOpen = window.open;
    window.open = () => { const p = { html: '' }; pages.push(p); return { document: { write: (h) => { p.html += h; }, close() {} } }; };
    try {
      shareBriefingEmail(); await new Promise(r => setTimeout(r, 0));
      shareBriefingEmail(); await new Promise(r => setTimeout(r, 0));
    } finally { window.open = realOpen; }
    expect(pages[0].html).toContain('AREA1');
    expect(pages[1].html).toContain('AREA2');
  });
});

// ------------------------------------------------------------------ H13
describe('H13 — cache current view', () => {
  it('fetchFAAairspace with no area drawn caches instead of crashing', async () => {
    S.areaCenter = null; S.currentArea = null;
    S.dataSourceErrors = {}; S.sectionMeta = {};
    document.body.innerHTML = '<span id="faaAirspaceStatus"></span><div id="layerList"></div>';
    const cached = [];
    globalThis.cacheApiResponse = async (ep, k, d) => { cached.push(ep); };
    globalThis.getCachedApiResponse = async () => null;
    const realL = { geoJSON: L.geoJSON };
    L.geoJSON = () => ({ bindPopup() { return this; } });
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ type: 'FeatureCollection', features: [] }) });
    const bounds = { getSouthWest: () => LL(38.6, -121.1), getNorthEast: () => LL(38.8, -120.9) };
    S.wireHazardCounts = {}; S.utilityWireCounts = {}; S.nwsAlerts = []; S.faaCharts = {};
    try {
      await fetchFAAairspace(bounds);
    } finally {
      delete globalThis.fetch; delete globalThis.cacheApiResponse; delete globalThis.getCachedApiResponse;
      L.geoJSON = realL.geoJSON;
    }
    expect(cached).toContain('faa_airspace');
    expect(S.sectionMeta.airspace.sources.faa.status).toBe('live');
  });

  it('job outcomes come from what each fetcher marked, never assumed success', () => {
    const job = CACHE_VIEW_JOBS.find(j => j.key === 'airspace' && j.src === 'faa');
    S.sectionMeta = {};
    const before = JSON.stringify(null);
    expect(_cacheViewJobOutcome(job, before, 'fulfilled')).toBe('skipped');           // marked nothing
    expect(_cacheViewJobOutcome(job, before, 'rejected')).toBe('failed');              // threw
    S.sectionMeta = { airspace: { sources: { faa: { status: 'error', error: 'offline' } } } };
    expect(_cacheViewJobOutcome(job, before, 'fulfilled')).toBe('failed');
    S.sectionMeta = { airspace: { sources: { faa: { status: 'cached', cachedAt: 1 } } } };
    expect(_cacheViewJobOutcome(job, before, 'fulfilled')).toBe('stale');
    S.sectionMeta = { airspace: { sources: { faa: { status: 'live', updatedAt: Date.now() } } } };
    expect(_cacheViewJobOutcome(job, before, 'fulfilled')).toBe('ok');
    // Unchanged since before the run → the fetcher did not report (e.g. superseded).
    const same = JSON.stringify(S.sectionMeta.airspace.sources.faa);
    expect(_cacheViewJobOutcome(job, same, 'fulfilled')).toBe('skipped');
  });
});

// ------------------------------------------------------------------ M22
describe('M22 — parseKML never builds a degenerate (< 3 vertex) area', () => {
  const kml = (geom) => `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark>${geom}</Placemark></kml>`;
  let realAlert;
  beforeEach(() => {
    realAlert = window.alert; window.alert = vi.fn();
    S.drawnItems = { clearLayers() {}, addLayer() {} };
    L.rectangle.mockClear(); L.polygon.mockClear(); L.circle.mockClear();
  });
  afterEach(() => { window.alert = realAlert; });

  it('a 2-point LineString becomes a padded rectangle around the segment (and says so)', () => {
    expect(() => parseKML(kml('<LineString><coordinates>-121.0,38.7,0 -120.9,38.8,0</coordinates></LineString>'))).toThrow('stop-rectangle');
    expect(L.polygon).not.toHaveBeenCalled();
    const [[[s, w], [n, e]]] = L.rectangle.mock.calls[0];
    expect(s).toBeLessThan(38.7); expect(n).toBeGreaterThan(38.8);
    expect(w).toBeLessThan(-121.0); expect(e).toBeGreaterThan(-120.9);
    expect(window.alert).toHaveBeenCalled();
  });

  it('a due-north 2-point line still gets a real width', () => {
    expect(() => parseKML(kml('<LineString><coordinates>-121.0,38.7 -121.0,38.8</coordinates></LineString>'))).toThrow('stop-rectangle');
    const [[[, w], [, e]]] = L.rectangle.mock.calls[0];
    expect(e - w).toBeGreaterThan(0.005);
  });

  it('a self-closing 3-coordinate "polygon" (2 distinct vertices) is not passed on as a 2-vertex polygon', () => {
    expect(() => parseKML(kml('<Polygon><outerBoundaryIs><LinearRing><coordinates>-121,38.7 -120.9,38.8 -121,38.7</coordinates></LinearRing></outerBoundaryIs></Polygon>'))).toThrow('stop-rectangle');
    expect(L.polygon).not.toHaveBeenCalled();
  });

  it('a polygon whose vertices are all the same point becomes the point area', () => {
    expect(() => parseKML(kml('<Polygon><outerBoundaryIs><LinearRing><coordinates>-121,38.7 -121,38.7 -121,38.7 -121,38.7</coordinates></LinearRing></outerBoundaryIs></Polygon>'))).toThrow('stop-circle');
  });

  it('a proper triangle is still imported as a polygon', () => {
    expect(() => parseKML(kml('<Polygon><outerBoundaryIs><LinearRing><coordinates>-121,38.7 -120.9,38.7 -120.95,38.8 -121,38.7</coordinates></LinearRing></outerBoundaryIs></Polygon>'))).toThrow('stop-polygon');
    expect(L.polygon.mock.calls[0][0]).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ Low 8
describe('Low 8 — robustness', () => {
  it('a throwing localStorage shows the disclaimer instead of aborting startup', () => {
    document.body.innerHTML = '<div id="disclaimerModal"></div>';
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
    try {
      expect(() => checkDisclaimer()).not.toThrow();
      expect(document.getElementById('disclaimerModal').classList.contains('active')).toBe(true);
      expect(() => acceptDisclaimer()).not.toThrow();
      expect(document.getElementById('disclaimerModal').classList.contains('active')).toBe(false);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it('a one-hour forecast puts the time bar at 0 %, not NaN %', () => {
    document.body.innerHTML = '<div id="tbFill"></div><div id="tbThumb"></div><span id="tbTime"></span><span id="tbWind"></span>';
    S.areaCenter = LL(38.7, -120.99);
    const realWx = S.wx;
    S.wx = { hourly: { time: ['2026-11-20T18:00:00Z'], wind_speed_10m: [5], wind_direction_10m: [270] } };
    try { _updateTimeBar(0.5); } catch (_) { /* later panel refreshes need more state */ }
    expect(document.getElementById('tbFill').style.width).toBe('0%');
    expect(document.getElementById('tbThumb').style.left).toBe('0%');
    S.wx = realWx;
  });

  it('typing a new query drops the highlighted result, so Enter searches instead of jumping to the old pick', () => {
    S._geocodeResults = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
    S._geocodeSel = 1;
    document.body.innerHTML = '<div id="coordSearchResults"><div class="geo-result"></div><div class="geo-result sel"></div></div>';
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (u) => { calls.push(u); return Promise.reject(new Error('no')); };
    try {
      onCoordSearchKey({ key: 'B', preventDefault() {} });
      expect(S._geocodeSel).toBe(-1);
      expect(document.querySelector('.geo-result.sel')).toBeNull();
      expect(calls).toEqual([]); // a keystroke still never searches
      S._geocodeSel = 0;
      onCoordSearchKey({ key: 'Shift', preventDefault() {} });
      expect(S._geocodeSel).toBe(0); // navigation/modifier keys keep the pick
    } finally { globalThis.fetch = realFetch; }
  });

  it('a SW offline-fallback sectional metadata body is never labeled "current"', async () => {
    document.body.innerHTML = '<span id="sectionalEditionStatus"></span>';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: (k) => (k === 'X-SAR-SW-Cache' ? String(Date.now() - 86400000) : null) },
      json: async () => ({ documentInfo: { subject: 'Updated with the latest charts on 07-09-2026.' } }),
    });
    try { await resolveSectionalEdition(); } finally { globalThis.fetch = realFetch; }
    const txt = document.getElementById('sectionalEditionStatus').textContent;
    expect(txt).not.toContain('current');
    expect(txt).toContain('offline');
  });
});
