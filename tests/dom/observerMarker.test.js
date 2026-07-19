const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// Capturing marker stub — stores handlers so tests can fire them.
globalThis.L = {
  marker: (latlng, opts) => {
    const handlers = {};
    return {
      options: opts || {},
      _handlers: handlers,
      on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return this; },
      off() { return this; },
      bindPopup() { return this; },
      addTo() { return this; },
      getLatLng() { return { lat: latlng[0], lng: latlng[1] }; },
      setPopupContent() { return this; },
    };
  },
  layerGroup: () => ({ _l: [], addLayer(x) { this._l.push(x); }, removeLayer(x) { this._l = this._l.filter(y => y !== x); }, clearLayers() { this._l = []; }, getLayers() { return this._l; }, addTo() { return this; } }),
  DomEvent: { stopPropagation() {} },
};

const {
  S, _addObserverMarker, _on3dClick, enterObserverView, exitObserverView, removeViewshed,
} = require('../../sar-preflight.js');

function makeRec(id, name) {
  return { id, name: name || id, observer: { lat: 38.7, lng: -120.9 }, aglFt: 200, vlosFt: 2500, grid: null, mask: null, coverage: null, computedAt: 0 };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="vsObserverList"></div><div id="layerList"></div><div class="map-container"></div>';
  S.map = { hasLayer: () => false };
  S.mapLayers = {};
  S.wireHazardCounts = {};
  S.nwsAlerts = [];
  S.radarAnim = null;
  S.viewsheds = [];
  S.activeViewshedId = null;
  S._viewshedPicking = false;
  S.observerView = null;
  S.is3D = false;
  S.map3d = null;
});

describe('2D observer marker tap-to-activate', () => {
  it('stamps the record id into the marker featId option', () => {
    const rec = makeRec('vs1');
    S.viewsheds = [rec];
    const m = _addObserverMarker(rec);
    expect(m.options.featId).toBe('vs1');
  });

  it('activates the tapped observer viewshed', () => {
    const a = makeRec('vs_a'), b = makeRec('vs_b');
    S.viewsheds = [a, b];
    S.activeViewshedId = 'vs_a';
    const m = _addObserverMarker(b);
    m._handlers.click[0]({});
    expect(S.activeViewshedId).toBe('vs_b');
  });

  it('does not activate while viewshed pick mode is placing a new observer', () => {
    const rec = makeRec('vs1');
    S.viewsheds = [rec];
    S._viewshedPicking = true;
    const m = _addObserverMarker(rec);
    m._handlers.click[0]({});
    expect(S.activeViewshedId).toBe(null);
  });
});

// --- 3D observer perspective view routing ---

function fakeMap3d() {
  const noopCanvas = { addEventListener() {}, removeEventListener() {}, setPointerCapture() {} };
  return {
    _jumps: [],
    _maxPitches: [],
    _clamps: [],
    _hits: [], // queue of queryRenderedFeatures results
    jumpTo(o) { this._jumps.push(o); },
    setMaxPitch(v) { this._maxPitches.push(v); },
    setCenterClampedToGround(v) { this._clamps.push(v); },
    getCenter() { return { lng: -120.9, lat: 38.7 }; },
    getZoom() { return 12; },
    getPitch() { return 60; },
    getBearing() { return 30; },
    getLayer() { return true; },
    queryRenderedFeatures() { return this._hits.length ? this._hits.shift() : []; },
    queryTerrainElevation() { return 1000; },
    calculateCameraOptionsFromCameraLngLatAltRotation(lngLat, alt, bearing, pitch, roll) {
      return { center: { lng: lngLat[0], lat: lngLat[1] }, elevation: alt - 300, zoom: 13.8, bearing, pitch, roll };
    },
    transform: {
      _nearFar: [],
      pixelsPerMeter: 0.22,
      overrideNearFarZ(n, f) { this._nearFar.push([n, f]); },
      clearNearFarZOverride() { this._nearFar.push('clear'); },
    },
    once() {},
    getCanvas() { return noopCanvas; },
  };
}

describe('3D observer perspective view', () => {
  beforeEach(() => {
    vi.useFakeTimers(); // hold sync3d's debounce so the fake map never gets restyled
    S.is3D = true;
    S.map3d = fakeMap3d();
    S.viewsheds = [makeRec('vs_a'), makeRec('vs_b')];
  });
  afterEach(() => {
    S.observerView = null;
    vi.useRealTimers();
  });

  it('tapping an observer dot in normal 3D enters its perspective and activates its viewshed', () => {
    S.map3d._hits = [[{ properties: { featId: 'vs_a' } }]];
    _on3dClick({ point: { x: 100, y: 100 } });
    expect(S.observerView).toBeTruthy();
    expect(S.observerView.id).toBe('vs_a');
    expect(S.activeViewshedId).toBe('vs_a');
    // Eye camera applied: a jump at the observer start pitch with a real roll
    const eye = S.map3d._jumps.find(j => j.pitch === 88);
    expect(eye).toBeTruthy();
    expect(eye.roll).toBe(0);
    expect(eye.elevation).toBeCloseTo(1000 + 1.6764 * 1.15 - 300, 1);
    // maxPitch raised + terrain clamp released for the eye-level view
    expect(S.map3d._maxPitches[0]).toBeGreaterThan(80);
    expect(S.map3d._clamps[0]).toBe(false);
    // Near clip pulled to human scale (1 m × pixelsPerMeter), far generous
    const nf = S.map3d.transform._nearFar[0];
    expect(nf[0]).toBeCloseTo(0.22, 5);
    expect(nf[1]).toBeCloseTo(150000 * 0.22, 1);
  });

  it('tapping the ground in observer view exits and restores the saved camera', () => {
    S.map3d._hits = [[{ properties: { featId: 'vs_a' } }], []];
    _on3dClick({ point: { x: 100, y: 100 } }); // enter
    _on3dClick({ point: { x: 200, y: 200 } }); // empty tap → exit
    expect(S.observerView).toBe(null);
    const restore = S.map3d._jumps[S.map3d._jumps.length - 1];
    expect(restore.center).toEqual({ lng: -120.9, lat: 38.7 });
    expect(restore.zoom).toBe(12);
    expect(restore.pitch).toBe(60);
    expect(restore.bearing).toBe(30);
    // maxPitch + terrain clamp + near/far planes restored to normal-3D behavior
    expect(S.map3d._maxPitches[S.map3d._maxPitches.length - 1]).toBe(80);
    expect(S.map3d._clamps[S.map3d._clamps.length - 1]).toBe(true);
    expect(S.map3d.transform._nearFar[S.map3d.transform._nearFar.length - 1]).toBe('clear');
  });

  it('tapping a different observer dot switches perspective and keeps the original saved camera', () => {
    S.map3d._hits = [[{ properties: { featId: 'vs_a' } }], [{ properties: { featId: 'vs_b' } }], []];
    _on3dClick({ point: { x: 100, y: 100 } }); // enter vs_a
    const savedCam = S.observerView.prevCam;
    _on3dClick({ point: { x: 150, y: 150 } }); // tap vs_b → switch
    expect(S.observerView.id).toBe('vs_b');
    expect(S.observerView.prevCam).toBe(savedCam);
    expect(S.activeViewshedId).toBe('vs_b');
    _on3dClick({ point: { x: 200, y: 200 } }); // ground → exit
    expect(S.observerView).toBe(null);
  });

  it('suppresses the click that lands right after a look drag', () => {
    S.map3d._hits = [[{ properties: { featId: 'vs_a' } }]];
    _on3dClick({ point: { x: 100, y: 100 } }); // enter
    S.observerView.dragPx = 12;
    _on3dClick({ point: { x: 200, y: 200 } }); // post-drag click → ignored
    expect(S.observerView).toBeTruthy();
    expect(S.observerView.dragPx).toBe(0);
  });

  it('a tap on the currently-viewed observer is a no-op', () => {
    S.map3d._hits = [[{ properties: { featId: 'vs_a' } }], [{ properties: { featId: 'vs_a' } }]];
    _on3dClick({ point: { x: 100, y: 100 } });
    const ov = S.observerView;
    _on3dClick({ point: { x: 101, y: 101 } });
    expect(S.observerView).toBe(ov);
  });

  it('removing the viewed observer exits observer view', () => {
    S.mapLayers.observers = null; // rebuilt by _addObserverMarker
    S.map3d._hits = [[{ properties: { featId: 'vs_a' } }]];
    _on3dClick({ point: { x: 100, y: 100 } });
    expect(S.observerView.id).toBe('vs_a');
    removeViewshed('vs_a');
    expect(S.observerView).toBe(null);
  });

  it('enterObserverView ignores unknown ids', () => {
    enterObserverView('nope');
    expect(S.observerView).toBe(null);
  });

  it('exitObserverView is safe to call when not in observer view', () => {
    expect(() => exitObserverView()).not.toThrow();
  });
});
