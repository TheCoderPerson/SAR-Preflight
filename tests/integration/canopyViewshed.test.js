const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// ---- Minimal Leaflet mock (mirrors tests/integration/aggregatePopup.test.js) ----
class MockPoint { constructor(x, y) { this.x = x; this.y = y; } distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y); } }
const project = ll => new MockPoint(ll.lng * 1000, -ll.lat * 1000);
class MockLayer {
  constructor() { this._events = {}; this._popup = null; }
  on(t, f) { (this._events[t] = this._events[t] || []).push(f); return this; }
  off() { return this; }
  bindPopup(c) { this._popup = { getContent: () => c }; return this; }
  getPopup() { return this._popup; }
}
class MockCircleMarker extends MockLayer {
  constructor(latlng, radius, popup) { super(); this._ll = latlng; this._r = radius; if (popup) this.bindPopup(popup); }
  getLatLng() { return this._ll; }
  getRadius() { return this._r; }
}
class MockGroup { constructor(layers) { this._layers = layers; } getLayers() { return this._layers; } }

globalThis.L = {
  Point: MockPoint, point: (x, y) => new MockPoint(x, y),
  Polygon: class {}, Polyline: class {}, CircleMarker: MockCircleMarker, Circle: class {}, Marker: class {},
  DomEvent: { stopPropagation: () => {} },
  popup: () => ({ setLatLng() { return this; }, setContent() { return this; }, openOn() { return this; }, update() { return this; } }),
};

const {
  S, collectFeaturesAt, setCanopyOpacity, setViewshedOpacity, getCanopyProxyBase, getCustomProxy,
  saveCanopyProxy, DEFAULT_DATA_PROXY,
} = require('../../sar-preflight.js');

const LL = (lat, lng) => ({ lat, lng });

describe('canopy/viewshed overlays are excluded from the aggregated popup', () => {
  beforeEach(() => {
    S.map = { latLngToLayerPoint: project, hasLayer: () => true };
    S.mapLayers = {};
  });

  it('skips features in the canopy and viewshed layers but keeps normal layers', () => {
    const click = LL(38.7, -120.99);
    S.mapLayers.canopy = new MockGroup([new MockCircleMarker(click, 50, 'canopy-popup')]);
    S.mapLayers.viewshed = new MockGroup([new MockCircleMarker(click, 50, 'viewshed-popup')]);
    S.mapLayers.faa_obstacles = new MockGroup([new MockCircleMarker(click, 50, 'real-feature')]);
    const contents = collectFeaturesAt(click).map(h => h.content);
    expect(contents).toContain('real-feature');
    expect(contents).not.toContain('canopy-popup');
    expect(contents).not.toContain('viewshed-popup');
  });
});

describe('opacity setters', () => {
  it('setCanopyOpacity updates the layer opacity and the % readout', () => {
    document.body.innerHTML = '<span id="canopyOpacityVal"></span>';
    let applied = null;
    S.mapLayers.canopy = { setOpacity: v => { applied = v; } };
    setCanopyOpacity('0.3');
    expect(applied).toBe(0.3);
    expect(document.getElementById('canopyOpacityVal').textContent).toBe('30%');
  });

  it('setViewshedOpacity updates the layer opacity and the % readout', () => {
    document.body.innerHTML = '<span id="viewshedOpacityVal"></span>';
    let applied = null;
    S.mapLayers.viewshed = { setOpacity: v => { applied = v; } };
    setViewshedOpacity('0.75');
    expect(applied).toBe(0.75);
    expect(document.getElementById('viewshedOpacityVal').textContent).toBe('75%');
  });
});

describe('canopy proxy config', () => {
  beforeEach(() => {
    document.body.innerHTML = '<span id="canopyProxyHint"></span>';
    localStorage.removeItem('sar_canopy_proxy');
  });

  it('defaults to the built-in proxy when no custom URL is saved', () => {
    expect(getCustomProxy()).toBe(null);
    expect(getCanopyProxyBase()).toBe(DEFAULT_DATA_PROXY);
    saveCanopyProxy('');
    expect(document.getElementById('canopyProxyHint').textContent.toLowerCase()).toContain('default');
  });

  it('saves and reads back a custom proxy base, trimming trailing slashes', () => {
    saveCanopyProxy('https://x.workers.dev/');
    expect(getCustomProxy()).toBe('https://x.workers.dev');
    expect(getCanopyProxyBase()).toBe('https://x.workers.dev');
    expect(document.getElementById('canopyProxyHint').textContent.toLowerCase()).toContain('configured');
  });

  it('falls back to the default when the custom proxy is cleared', () => {
    saveCanopyProxy('https://x.workers.dev');
    saveCanopyProxy('');
    expect(getCustomProxy()).toBe(null);
    expect(getCanopyProxyBase()).toBe(DEFAULT_DATA_PROXY);
  });
});
