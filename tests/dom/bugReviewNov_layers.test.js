// Regression tests for the Nov 2026 bug review — layer control, canopy /
// sun-shadow / viewshed overlay lifecycle, canopy edit, observer view and the
// map wind arrow (items M9, M13.2-M13.9, M17.1, M17.2, Low 9).
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// ---- Leaflet / canvas mocks ------------------------------------------------
class MockImageOverlay {
  constructor(url, bounds, opts) { this._url = url; this._bounds = bounds; this.options = Object.assign({}, opts); }
  setUrl(u) { this._url = u; return this; }
  setBounds(b) { this._bounds = b; return this; }
  setOpacity(o) { this.options.opacity = o; return this; }
  addTo(map) { map.addLayer(this); return this; }
}
const group = () => {
  const g = {
    _layers: [],
    addLayer(l) { g._layers.push(l); return g; },
    clearLayers() { g._layers.length = 0; return g; },
    getLayers() { return g._layers.slice(); },
    addTo(map) { map.addLayer(g); return g; },
    eachLayer(fn) { g._layers.forEach(fn); },
  };
  return g;
};
const LL = (lat, lng) => ({ lat, lng, distanceTo: () => 300 });
class MockDrawPolygon { constructor() {} enable() {} disable() {} }

globalThis.L = {
  Browser: { mobile: false },
  Draw: { Event: {}, Polygon: MockDrawPolygon },
  DomEvent: { stopPropagation() {} },
  DomUtil: { setPosition() {} },
  latLng: (lat, lng) => LL(lat, lng),
  latLngBounds: (sw, ne) => ({
    getNorthEast: () => ({ lat: ne[0], lng: ne[1], __ne: true }),
    getSouthWest: () => ({ lat: sw[0], lng: sw[1] }),
  }),
  imageOverlay: (url, bounds, opts) => new MockImageOverlay(url, bounds, opts),
  layerGroup: () => group(),
  divIcon: o => o,
  marker: (ll, o) => ({ ll, o, on() { return this; } }),
  polyline: c => ({ c }),
  circle: () => ({}),
};

const fakeCtx = () => ({
  putImageData() {}, clearRect() {}, drawImage() {}, imageSmoothingEnabled: false,
  getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
});
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function () { return fakeCtx(); };
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  }
  if (typeof globalThis.requestAnimationFrame === 'undefined') globalThis.requestAnimationFrame = () => 0;
});

const app = require('../../sar-preflight.js');
const {
  S, buildLayerControl, toggleLayer, renderAdsbMap, togglePlansMode,
  toggleCanopyOverlay, loadCanopyForView, setCanopySource,
  toggleShadowOverlay, _updateShadowForTime,
  startCanopyEdit, exitCanopyEdit, setCanopyEditSubMode, onCanopyEditPolygon, canopyEditSave,
  clearArea,
} = app;

// Pull a non-exported top-level function out of the app source and bind its
// free variables explicitly (keeps the test independent of the export block).
const APP_SRC = fs.readFileSync(path.join(__dirname, '../../sar-preflight.js'), 'utf8');
function extractFn(name, deps) {
  const start = APP_SRC.indexOf('\nfunction ' + name + '(');
  if (start < 0) throw new Error('no function ' + name);
  let i = APP_SRC.indexOf('{', start), depth = 0;
  for (; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}' && --depth === 0) break;
  }
  const src = APP_SRC.slice(start, i + 1);
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...names, src + '\nreturn ' + name + ';')(...names.map(n => deps[n]));
}

// ---- map stub --------------------------------------------------------------
const CENTER = { lat: 38.685, lng: -120.99 };
function makeMap({ px = 0 } = {}) {
  const on = new Set();
  const handlers = {};
  return {
    _on: on, _handlers: handlers, _px: px,
    hasLayer: l => on.has(l),
    addLayer(l) { on.add(l); return this; },
    removeLayer(l) { on.delete(l); return this; },
    getCenter: () => LL(CENTER.lat, CENTER.lng),
    getZoom: () => 16,
    getBounds: () => ({
      getCenter: () => LL(CENTER.lat, CENTER.lng),
      getWest: () => CENTER.lng - 0.004, getNorth: () => CENTER.lat + 0.003,
    }),
    latLngToContainerPoint(p) { return p && p.__ne ? { x: this._px, y: this._px } : { x: 0, y: 0 }; },
    containerPointToLayerPoint: () => ({ x: 0, y: 0 }),
    closePopup() {},
    on(evts, fn) { String(evts).split(' ').forEach(e => { (handlers[e] = handlers[e] || []).push(fn); }); return this; },
    off() { return this; },
    getContainer: () => document.getElementById('mapEl') || document.body,
    getPane: () => null,
    dragging: { enable() {}, disable() {} }, touchZoom: { enable() {}, disable() {} }, doubleClickZoom: { enable() {}, disable() {} },
  };
}

// The grid loadCanopyForView / loadShadowForView build for makeMap()'s view
// (half-width 300 m from the LL stub's distanceTo).
const viewGrid = () => makeGrid(CENTER.lat, CENTER.lng, 300, Math.max(WORK_RES_M, 600 / MAX_GRID));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function baseReset() {
  document.body.innerHTML = `<div id="mapEl"></div><div id="layerList"></div>
    <span id="canopyStatus"></span><input id="canopyOpacity" value="0.6"><span id="canopyOpacityVal"></span>
    <span id="shadowStatus"></span><input id="shadowOpacity" value="0.45"><div id="shadowResult"></div>
    <input id="vsOpacity" value="0.6"><div id="vsObserverList"></div><div id="vsResult"></div>`;
  L.Browser.mobile = false;
  S.layerSections = new Set();
  S.plansMode = false;
  S._plansUserOverride = null;
  S._overlayWanted = {};
  S._canopyEditing = false;
  S.canopyEdit = null;
  S.is3D = false;
  S.mapLayers = {};
  S.radarAnim = null;
  S.wireHazardCounts = {};
  S.utilityWireCounts = {};
  S.nwsAlerts = [];
  S.faaCharts = {};
  S.viewsheds = [];
  S.canopy = null;
  S.shadow = null;
  S._canopyLoadGen = 0; S._canopyLoading = false;
  S._shadowLoadGen = 0; S._shadowLoading = false;
  S.map = makeMap();
  try { localStorage.removeItem('sar_canopy_source'); } catch (_) {}
}

afterEach(() => {
  delete globalThis.getCachedRaster;
  delete globalThis.cacheRaster;
  delete globalThis.isOnline;
  delete globalThis.fetch;
  delete globalThis.GeoTIFF;
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe('M17.1 Viewshed row survives being unchecked / zoom-capped', () => {
  beforeEach(baseReset);
  const rec = (over = {}) => Object.assign({ id: 'a', name: 'A', visible: true, grid: {}, mask: new Uint8Array(1) }, over);
  const row = () => document.querySelector('#layerList [data-layer="viewshed"]');

  it('keeps an UNCHECKED row when the user turned the overlay off', () => {
    S.mapLayers.viewshed = new MockImageOverlay('', null, { opacity: 0.6 });
    S.viewsheds = [rec()];
    S._overlayWanted.viewshed = false; // not on the map, not wanted
    buildLayerControl();
    expect(row()).toBeTruthy();
    expect(row().classList.contains('active')).toBe(false);
  });

  it('shows the row CHECKED while the mobile cap has detached a wanted overlay', () => {
    S.mapLayers.viewshed = new MockImageOverlay('', null, { opacity: 0.6 });
    S.viewsheds = [rec()];
    S._overlayWanted.viewshed = true; // wanted, but detached by the cap
    buildLayerControl();
    expect(row().classList.contains('active')).toBe(true);
  });

  it('re-checking the row puts the overlay back', () => {
    S.mapLayers.viewshed = new MockImageOverlay('', null, { opacity: 0.6 });
    S.viewsheds = [rec()];
    buildLayerControl();
    toggleLayer('viewshed', row());
    expect(S.map.hasLayer(S.mapLayers.viewshed)).toBe(true);
    expect(S._overlayWanted.viewshed).toBe(true);
  });

  it('has no row when no visible observer has a computed viewshed', () => {
    S.mapLayers.viewshed = new MockImageOverlay('', null, { opacity: 0.6 });
    S.viewsheds = [rec({ mask: null }), rec({ id: 'b', visible: false })];
    buildLayerControl();
    expect(row()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('M17.2 ADS-B respects PLANS mode on every poll', () => {
  beforeEach(() => {
    baseReset();
    S.adsbAircraft = [];
    S.adsbTrails = {};
    S._adsbSel = {};
    togglePlansMode(); // PLANS on before any traffic exists
    expect(S.plansMode).toBe(true);
  });
  afterEach(() => { S.plansMode = false; S._plansUserOverride = null; });

  it('an empty first poll does not leave the traffic groups attached', () => {
    renderAdsbMap();
    expect(S.mapLayers.adsb_aircraft).toBeTruthy();
    expect(S.map.hasLayer(S.mapLayers.adsb_aircraft)).toBe(false);
    expect(S.map.hasLayer(S.mapLayers.adsb_trails)).toBe(false);
  });

  it('a later poll with aircraft does not draw them onto the decluttered map', () => {
    renderAdsbMap();
    S.adsbAircraft = [{ hex: 'abc123', lat: 38.7, lon: -120.9, agl: 1200, distNm: 3, track: 90 }];
    renderAdsbMap();
    expect(S.mapLayers.adsb_aircraft.getLayers().length).toBe(1);
    expect(S.map.hasLayer(S.mapLayers.adsb_aircraft)).toBe(false);
  });

  it('a user re-check still shows traffic under PLANS', () => {
    renderAdsbMap();
    S._plansUserOverride.add('adsb_aircraft');
    S._plansUserOverride.add('adsb_trails');
    S.map.addLayer(S.mapLayers.adsb_aircraft);
    S.adsbAircraft = [{ hex: 'abc123', lat: 38.7, lon: -120.9, agl: 1200, distNm: 3, track: 90 }];
    renderAdsbMap();
    expect(S.map.hasLayer(S.mapLayers.adsb_aircraft)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('M13.2 canopy load cannot resurrect an unchecked overlay', () => {
  let calls;
  beforeEach(() => {
    baseReset();
    calls = [];
    globalThis.isOnline = () => false; // straight to the (mocked) IndexedDB copy
    globalThis.getCachedRaster = (store, key) => {
      if (store === 'canopyedit') return Promise.resolve(null);
      const d = deferred();
      calls.push({ store, key, d });
      return d.promise;
    };
  });
  const cachedFor = grid => ({
    data: {
      canopyArr: new Float32Array(grid.rows * grid.cols).fill(12),
      bounds: Object.assign({}, grid.bounds), cols: grid.cols, rows: grid.rows,
    },
  });

  it('control: an uninterrupted load attaches the overlay', async () => {
    const p = toggleCanopyOverlay(true);
    await flush();
    calls[0].d.resolve(cachedFor(viewGrid()));
    await p;
    expect(S.mapLayers.canopy).toBeTruthy();
    expect(S.map.hasLayer(S.mapLayers.canopy)).toBe(true);
  });

  it('unchecking while the load is in flight keeps it off', async () => {
    const p = toggleCanopyOverlay(true);
    await flush();
    await toggleCanopyOverlay(false);
    calls[0].d.resolve(cachedFor(viewGrid()));
    await p;
    expect(!S.mapLayers.canopy || !S.map.hasLayer(S.mapLayers.canopy)).toBe(true);
    expect(S._overlayWanted.canopy).toBe(false);
    expect(S.canopy).toBeNull();
    expect(document.getElementById('canopyStatus').textContent).not.toMatch(/Fetching/);
  });

  it('switching dataset mid-load drops the old dataset result and reloads', async () => {
    const p = toggleCanopyOverlay(true);
    await flush();
    const old = calls[0];
    expect(old.key).toMatch(/^canopy2_/);
    setCanopySource('naip');
    await flush();
    // The new load asked for the NAIP-CHM copy.
    expect(calls.some(c => /^naipchm_/.test(c.key))).toBe(true);
    old.d.resolve(cachedFor(viewGrid()));
    await p;
    expect(S.canopy).toBeNull(); // the CHMv2 answer was not adopted
    localStorage.removeItem('sar_canopy_source');
  });

  it('a 0 % opacity slider is honoured, not snapped back to the default', async () => {
    document.getElementById('canopyOpacity').value = '0';
    const p = toggleCanopyOverlay(true);
    await flush();
    calls[0].d.resolve(cachedFor(viewGrid()));
    await p;
    expect(S.mapLayers.canopy.options.opacity).toBe(0);
  });
});

describe('Low 9: NAIP-CHM error cleared on switching back to CHMv2', () => {
  beforeEach(baseReset);
  it('drops the stale Canopy (NAIP-CHM) data-source error', () => {
    S.dataSourceErrors['Canopy (NAIP-CHM)'] = { message: 'NAIP-CHM unavailable here', timestamp: 1 };
    setCanopySource('chmv2');
    expect(S.dataSourceErrors['Canopy (NAIP-CHM)']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('M13.6 re-showing loaded canopy goes through the mobile zoom cap', () => {
  beforeEach(baseReset);
  it('does not attach a stretched overlay on a constrained device', async () => {
    L.Browser.mobile = true;
    S.map = makeMap({ px: 100000 }); // way beyond MAX_OVERLAY_DISPLAY_PX
    const grid = viewGrid();
    S.canopy = { grid, canopyFlat: new Float32Array(grid.rows * grid.cols), source: 'Meta CHMv2' };
    S.mapLayers.canopy = new MockImageOverlay('', L.latLngBounds([0, 0], [1, 1]), { opacity: 0.6 });
    await toggleCanopyOverlay(true);
    expect(S._overlayWanted.canopy).toBe(true);           // still wanted …
    expect(S.map.hasLayer(S.mapLayers.canopy)).toBe(false); // … but held back by the cap
  });
  it('attaches it when within the display budget', async () => {
    L.Browser.mobile = true;
    S.map = makeMap({ px: 800 });
    const grid = viewGrid();
    S.canopy = { grid, canopyFlat: new Float32Array(grid.rows * grid.cols), source: 'Meta CHMv2' };
    S.mapLayers.canopy = new MockImageOverlay('', L.latLngBounds([0, 0], [1, 1]), { opacity: 0.6 });
    await toggleCanopyOverlay(true);
    expect(S.map.hasLayer(S.mapLayers.canopy)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('M13.2 sun shadow cannot resurrect after being unchecked', () => {
  let fetchD;
  beforeEach(() => {
    baseReset();
    S.wx = null;
    globalThis.isOnline = () => true;
    fetchD = deferred();
    globalThis.fetch = () => fetchD.promise;
    globalThis.GeoTIFF = {
      fromArrayBuffer: async () => ({
        getImage: async () => ({
          getWidth: () => 2, getHeight: () => 2,
          readRasters: async () => [new Float32Array([500, 500, 500, 500])],
        }),
      }),
    };
  });
  const okResponse = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };

  it('control: an uninterrupted load attaches the shadow overlay', async () => {
    const p = toggleShadowOverlay(true);
    fetchD.resolve(okResponse);
    await p;
    expect(S.mapLayers.shadow).toBeTruthy();
    expect(S.map.hasLayer(S.mapLayers.shadow)).toBe(true);
  });

  it('unchecking while the DEM is in flight keeps it off', async () => {
    const p = toggleShadowOverlay(true);
    await flush();
    await toggleShadowOverlay(false);
    fetchD.resolve(okResponse);
    await p;
    expect(!S.mapLayers.shadow || !S.map.hasLayer(S.mapLayers.shadow)).toBe(true);
    expect(S._overlayWanted.shadow).toBe(false);
  });

  it('a 0 % shadow opacity is honoured', async () => {
    document.getElementById('shadowOpacity').value = '0';
    const p = toggleShadowOverlay(true);
    fetchD.resolve(okResponse);
    await p;
    expect(S.mapLayers.shadow.options.opacity).toBe(0);
  });

  it('a pending time-bar re-render does not re-attach after uncheck', async () => {
    const p = toggleShadowOverlay(true);
    fetchD.resolve(okResponse);
    await p;
    vi.useFakeTimers();
    _updateShadowForTime();       // debounced re-render queued …
    await toggleShadowOverlay(false); // … then the user unchecks
    vi.advanceTimersByTime(500);
    expect(S.map.hasLayer(S.mapLayers.shadow)).toBe(false);
    expect(S._overlayWanted.shadow).toBe(false);
  });

  it('the debounce re-checks intent even when the timer was not cleared', async () => {
    const p = toggleShadowOverlay(true);
    fetchD.resolve(okResponse);
    await p;
    vi.useFakeTimers();
    _updateShadowForTime();
    S._overlayWanted.shadow = false;
    S.map.removeLayer(S.mapLayers.shadow);
    vi.advanceTimersByTime(500);
    expect(S.map.hasLayer(S.mapLayers.shadow)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('M9 map wind arrow points downwind', () => {
  it('rotates by FROM + 180 (matches windArrowsKml)', () => {
    const fakeS = { map: { removeLayer() {} }, areaCenter: { lat: 38, lng: -120 }, _windArrow: null };
    let icon = null;
    const fakeL = {
      divIcon: o => o,
      marker: (ll, o) => { icon = o.icon; return { addTo() { return this; } }; },
    };
    const fn = extractFn('_updateWindArrow', { S: fakeS, L: fakeL });
    fn(270, 10); // wind FROM the west → drifts east
    expect(icon.html).toMatch(/rotate\(90, 30, 30\)/);
    fakeS._windArrow = null;
    fn(0, 10); // FROM north → points south
    expect(icon.html).toMatch(/rotate\(180, 30, 30\)/);
  });
});

// ---------------------------------------------------------------------------
describe('M13.7 aborting a 3D canopy build frees the single-flight slot', () => {
  it('clears S._canopy3dBuild so a quick 3D re-entry can build again', () => {
    const fakeS = { _canopy3dBuild: { src: {}, cancelled: false } };
    const b = fakeS._canopy3dBuild;
    const fn = extractFn('_abortCanopy3dBuild', { S: fakeS, _canopy3dProgressHide: () => {} });
    fn();
    expect(b.cancelled).toBe(true);
    expect(fakeS._canopy3dBuild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('M13.8 observer free-look follows ONE pointer', () => {
  function setup() {
    const canvas = document.createElement('canvas');
    const ov = { pitch: 80, bearing: 0, dragPx: 0 };
    const fakeS = { map3d: { getCanvas: () => canvas }, observerView: ov };
    const looks = [];
    const fn = extractFn('_attachObserverInput', {
      S: fakeS,
      applyLookDrag: (p, b, dx, dy) => { looks.push([dx, dy]); return { pitch: p, bearing: b + dx }; },
      wheelLook: (p, b) => ({ pitch: p, bearing: b }),
      _applyObserverLook: () => {},
    });
    fn();
    const fire = (type, props) => {
      const e = new Event(type);
      Object.assign(e, props);
      canvas.dispatchEvent(e);
    };
    return { fire, looks, ov };
  }

  it('ignores a second finger and its moves', () => {
    const { fire, looks } = setup();
    fire('pointerdown', { pointerId: 1, isPrimary: true, clientX: 100, clientY: 100 });
    fire('pointerdown', { pointerId: 2, isPrimary: false, clientX: 900, clientY: 900 });
    fire('pointermove', { pointerId: 2, clientX: 905, clientY: 900 });
    fire('pointermove', { pointerId: 1, clientX: 110, clientY: 100 });
    expect(looks).toEqual([[10, 0]]); // only finger 1, from ITS last position
  });

  it('the second finger lifting does not end the first finger drag', () => {
    const { fire, looks } = setup();
    fire('pointerdown', { pointerId: 1, isPrimary: true, clientX: 100, clientY: 100 });
    fire('pointerdown', { pointerId: 2, isPrimary: false, clientX: 900, clientY: 900 });
    fire('pointerup', { pointerId: 2 });
    fire('pointermove', { pointerId: 1, clientX: 120, clientY: 100 });
    expect(looks).toEqual([[20, 0]]);
  });

  it('a new primary pointer takes over after a lost pointerup', () => {
    const { fire, looks } = setup();
    fire('pointerdown', { pointerId: 1, isPrimary: true, clientX: 100, clientY: 100 });
    // pointerup for 1 never arrives
    fire('pointerdown', { pointerId: 7, isPrimary: true, clientX: 300, clientY: 300 });
    fire('pointermove', { pointerId: 7, clientX: 305, clientY: 300 });
    expect(looks).toEqual([[5, 0]]);
  });
});

// ---------------------------------------------------------------------------
describe('canopy edit mode fixes', () => {
  function setupEditable() {
    baseReset();
    S.mapLayers = {
      satellite: { addTo(m) { m.addLayer(this); return this; } },
      topo: { addTo(m) { m.addLayer(this); return this; } },
      sectional: { addTo(m) { m.addLayer(this); return this; } },
      canopy: new MockImageOverlay('', L.latLngBounds([0, 0], [1, 1]), { opacity: 0.6 }),
    };
    S._overlayWanted = { canopy: true };
    const grid = makeGrid(38.7, -120.99, 250, 10);
    S.canopy = { grid, source: 'Meta CHMv2', canopyFlat: new Float32Array(grid.rows * grid.cols) };
    return grid;
  }
  afterEach(() => { if (S._canopyEditing) exitCanopyEdit(true); });

  it('M13.4 SAVE resets the undo byte budget with the undo stack', async () => {
    setupEditable();
    await startCanopyEdit();
    const ce = S.canopyEdit;
    globalThis.getCachedRaster = async () => null;
    globalThis.cacheRaster = async () => {};
    ce.sessionOps = [{ t: 'del', poly: [[0, 0], [0, 1], [1, 1]] }];
    ce.undoStack = [{ op: ce.sessionOps[0], diff: null, bytes: 9e6 }];
    ce._undoBytes = 9e6;
    await canopyEditSave();
    expect(ce.undoStack.length).toBe(0);
    expect(ce._undoBytes).toBe(0);
  });

  it('M13.3 the VEG polygon gets no draggable vertices (preview/apply use the drawn ring)', async () => {
    setupEditable();
    await startCanopyEdit();
    setCanopyEditSubMode('vegPolygon');
    const enable = vi.fn();
    const layer = {
      setStyle() {}, addTo(m) { m.addLayer(this); return this; },
      editing: { enable, disable() {} },
      // Far outside the loaded grid → the sample bails out immediately.
      getLatLngs: () => [[LL(10, 10), LL(10, 11), LL(11, 11)]],
    };
    onCanopyEditPolygon(layer);
    await flush();
    expect(enable).not.toHaveBeenCalled();
  });

  it('Low 9: the VEG preview canvas hides during the zoom animation', async () => {
    setupEditable();
    await startCanopyEdit();
    const ce = S.canopyEdit;
    ce.vegCanvas = document.createElement('canvas');
    S.map._handlers.zoomstart.forEach(f => f());
    expect(ce.vegCanvas.style.visibility).toBe('hidden');
    expect(ce.canvas.style.visibility).toBe('hidden');
    S.map._handlers.zoomend.forEach(f => f());
    expect(ce.vegCanvas.style.visibility).toBe('');
    expect(ce.canvas.style.visibility).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('M13.9 clearing the area leaves the observer view and empties the list', () => {
  it('exits the 3D observer view and re-renders the observer list', () => {
    baseReset();
    document.body.innerHTML += `<div id="noAreaOverlay"></div><div id="assessmentBanner"></div>
      <div id="areaInfoBar"></div><div id="noAreaState"></div><div class="map-container mode-observer"></div>`;
    S.drawnItems = { clearLayers() {} };
    S.mapLayers.observers = group();
    S.mapLayers.observer_rings = group();
    S.viewsheds = [{ id: 'a', name: 'Ridge', visible: true, observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    document.getElementById('vsObserverList').innerHTML = '<div class="vs-obs-row" data-id="a">Ridge</div>';
    S.observerView = { id: 'a', prevCam: { center: [0, 0], zoom: 10, pitch: 0, bearing: 0 } };
    S.map3d = null;
    clearArea();
    expect(S.observerView).toBeNull();
    expect(document.querySelector('.map-container').classList.contains('mode-observer')).toBe(false);
    expect(document.querySelector('#vsObserverList .vs-obs-row')).toBeNull();
  });
});
