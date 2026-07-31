// VLOS range rings: a dashed ghost follows the cursor while an observer is being
// placed, and every placed observer keeps a permanent ring (touch devices never
// fire mousemove, so the placed rings are the only guide there).
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster); // ftToM is a runtime global in the browser too

// Leaflet stub: circles record their own latlng/radius so the tests can read them.
function makeCircle(latlng, opts) {
  return {
    __kind: 'circle',
    _latlng: latlng,
    _radius: opts.radius,
    options: opts,
    getRadius() { return this._radius; },
    setRadius(r) { this._radius = r; },
    getLatLng() { return this._latlng; },
    setLatLng(ll) { this._latlng = ll; },
    addTo(map) { map.addLayer(this); return this; },
  };
}
globalThis.L = {
  map: vi.fn(),
  tileLayer: vi.fn(),
  control: { zoom: vi.fn() },
  Draw: { Event: {} },
  FeatureGroup: vi.fn(),
  circle: vi.fn((latlng, opts) => makeCircle(latlng, opts)),
  layerGroup: vi.fn(() => {
    const layers = [];
    return {
      __kind: 'group',
      addTo(map) { map.addLayer(this); return this; },
      clearLayers() { layers.length = 0; },
      addLayer(l) { layers.push(l); },
      getLayers() { return layers; },
    };
  }),
};

const app = require('../../sar-preflight.js');
const {
  S, startViewshedPick, cancelViewshedPick, _updateVlosGhost, _onVlosInputChange,
  _renderObserverRings, VLOS_RING_STYLE,
} = app;

function fakeMap() {
  const on = new Set();
  const handlers = {};
  return {
    _on: on, _handlers: handlers,
    on: vi.fn((ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }),
    off: vi.fn((ev, fn) => { handlers[ev] = (handlers[ev] || []).filter(h => h !== fn); }),
    addLayer: vi.fn(l => on.add(l)),
    removeLayer: vi.fn(l => on.delete(l)),
    hasLayer: l => on.has(l),
    getContainer: () => ({ style: {} }),
    fire: (ev, e) => (handlers[ev] || []).forEach(h => h(e)),
  };
}

function reset(vlosFt = 2500) {
  S.map = fakeMap();
  S.mapLayers = {};
  S.viewsheds = [];
  S._viewshedPicking = false;
  S._canopyEditing = false;
  S._vlosGhost = null;
  S._vlosMove = null;
  S.drawHandler = null;
  S.is3D = false;
  document.body.innerHTML = `
    <input id="vsAgl" type="number" value="200">
    <input id="vsVlos" type="number" value="${vlosFt}">
    <div id="viewshedStatus"></div>
    <button id="vsPickBtn"></button>
    <button id="vsPickBtnMap"></button>
    <div id="vsObserverList"></div>
    <div id="layerList"></div>`;
}

describe('cursor ghost ring during observer pick', () => {
  beforeEach(() => reset());

  it('arms a mousemove handler but draws nothing until the cursor actually moves', () => {
    startViewshedPick();
    expect(S._viewshedPicking).toBe(true);
    expect(S.map.on).toHaveBeenCalledWith('mousemove', S._vlosMove);
    expect(S._vlosGhost).toBeNull(); // no flash at a stale point
  });

  it('puts the VLOS range in the status line so the number is visible while picking', () => {
    startViewshedPick();
    expect(document.getElementById('viewshedStatus').textContent).toContain('2500 ft');
  });

  it('creates the ring at the cursor with the radius in METRES on the first move', () => {
    startViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 38.7, lng: -120.9 } });
    expect(S._vlosGhost).toBeTruthy();
    expect(S._vlosGhost.getRadius()).toBeCloseTo(2500 * 0.3048, 6); // 762 m
    expect(S._vlosGhost.getLatLng()).toEqual({ lat: 38.7, lng: -120.9 });
  });

  it('reuses the one ring on subsequent moves instead of piling them up', () => {
    L.circle.mockClear();
    startViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 38.7, lng: -120.9 } });
    const first = S._vlosGhost;
    S.map.fire('mousemove', { latlng: { lat: 38.8, lng: -121.0 } });
    expect(S._vlosGhost).toBe(first);
    expect(S._vlosGhost.getLatLng()).toEqual({ lat: 38.8, lng: -121.0 });
    expect(L.circle).toHaveBeenCalledTimes(1);
  });

  it('stays out of S.mapLayers so popup aggregation, export and 3D never see it', () => {
    startViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 38.7, lng: -120.9 } });
    expect(Object.values(S.mapLayers)).not.toContain(S._vlosGhost);
    expect(S._vlosGhost.options.interactive).toBe(false);
  });

  it('resizes live when the VLOS field is edited mid-pick', () => {
    startViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 38.7, lng: -120.9 } });
    document.getElementById('vsVlos').value = '5000';
    _onVlosInputChange();
    expect(S._vlosGhost.getRadius()).toBeCloseTo(5000 * 0.3048, 6);
    expect(document.getElementById('viewshedStatus').textContent).toContain('5000 ft');
  });

  it('editing VLOS outside pick mode is a no-op', () => {
    expect(() => _onVlosInputChange()).not.toThrow();
    expect(S._vlosGhost).toBeNull();
  });

  it('falls back to the default 2500 ft when the field is blank', () => {
    reset();
    document.getElementById('vsVlos').value = '';
    startViewshedPick();
    _updateVlosGhost({ lat: 0, lng: 0 });
    expect(S._vlosGhost.getRadius()).toBeCloseTo(2500 * 0.3048, 6);
  });
});

describe('cancelViewshedPick tears the ghost down', () => {
  beforeEach(() => reset());

  it('removes the ring and detaches the handler', () => {
    startViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 38.7, lng: -120.9 } });
    const ghost = S._vlosGhost;
    cancelViewshedPick();
    expect(S.map.removeLayer).toHaveBeenCalledWith(ghost);
    expect(S._vlosGhost).toBeNull();
    expect(S._vlosMove).toBeNull();
    expect(S.map._handlers.mousemove).toEqual([]);
  });

  it('a later cursor move cannot resurrect the ring', () => {
    startViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 38.7, lng: -120.9 } });
    cancelViewshedPick();
    S.map.fire('mousemove', { latlng: { lat: 39, lng: -121 } });
    expect(S._vlosGhost).toBeNull();
  });

  it('is safe when no cursor move ever happened', () => {
    startViewshedPick();
    expect(() => cancelViewshedPick()).not.toThrow();
    expect(S._vlosMove).toBeNull();
  });
});

describe('permanent rings around placed observers', () => {
  beforeEach(() => reset());

  it('draws one ring per observer at that observer’s OWN stored VLOS', () => {
    S.viewsheds = [
      { id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 },
      { id: 'b', observer: { lat: 38.8, lng: -121.0 }, vlosFt: 5000 },
    ];
    _renderObserverRings();
    const rings = S.mapLayers.observer_rings.getLayers();
    expect(rings).toHaveLength(2);
    expect(rings[0].getRadius()).toBeCloseTo(2500 * 0.3048, 6);
    expect(rings[1].getRadius()).toBeCloseTo(5000 * 0.3048, 6);
  });

  it('editing the VLOS input does not move rings for observers already placed', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    document.getElementById('vsVlos').value = '9000';
    _renderObserverRings();
    expect(S.mapLayers.observer_rings.getLayers()[0].getRadius()).toBeCloseTo(2500 * 0.3048, 6);
  });

  it('rebuilding replaces the rings rather than stacking them', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    _renderObserverRings();
    _renderObserverRings();
    expect(S.mapLayers.observer_rings.getLayers()).toHaveLength(1);
  });

  it('clears every ring when the last observer is deleted', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    S.viewsheds = [];
    _renderObserverRings();
    expect(S.mapLayers.observer_rings.getLayers()).toHaveLength(0);
  });

  it('skips records with no placed position', () => {
    S.viewsheds = [{ id: 'a', vlosFt: 2500 }, { id: 'b', observer: { lat: 1, lng: 2 }, vlosFt: 2500 }];
    _renderObserverRings();
    expect(S.mapLayers.observer_rings.getLayers()).toHaveLength(1);
  });

  it('renderObserverList keeps the rings in step with the list UI', () => {
    S.viewsheds = [{ id: 'a', name: 'OP1', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500, visible: true }];
    app.renderObserverList();
    expect(S.mapLayers.observer_rings.getLayers()).toHaveLength(1);
  });

  it('rings ride in their own group, not among the observer markers', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    expect(S.mapLayers.observer_rings).not.toBe(S.mapLayers.observers);
    expect(S.mapLayers.observers.getLayers()).toHaveLength(0);
  });

  it('is excluded from popup aggregation and export (a ring would match every click inside it)', () => {
    expect(app.AGG_SKIP_LAYERS.has('observer_rings')).toBe(true);
    expect(app.EXPORT_SKIP_LAYERS.has('observer_rings')).toBe(true);
  });

  it('shares the dashed style with the cursor ghost', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    const ring = S.mapLayers.observer_rings.getLayers()[0];
    expect(ring.options.dashArray).toBe(VLOS_RING_STYLE.dashArray);
    expect(ring.options.interactive).toBe(false);
  });
});

describe('setLayerVisible("observers") moves markers and rings together', () => {
  beforeEach(() => reset());

  it('hides both', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    app.setLayerVisible('observers', false);
    expect(S.map.removeLayer).toHaveBeenCalledWith(S.mapLayers.observers);
    expect(S.map.removeLayer).toHaveBeenCalledWith(S.mapLayers.observer_rings);
  });

  it('and shows both', () => {
    S.viewsheds = [{ id: 'a', observer: { lat: 38.7, lng: -120.9 }, vlosFt: 2500 }];
    _renderObserverRings();
    app.setLayerVisible('observers', false);
    app.setLayerVisible('observers', true);
    expect(S.map.hasLayer(S.mapLayers.observers)).toBe(true);
    expect(S.map.hasLayer(S.mapLayers.observer_rings)).toBe(true);
  });
});
