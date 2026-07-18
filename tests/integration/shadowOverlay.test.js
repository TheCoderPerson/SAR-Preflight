const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// ---- Minimal Leaflet mock (mirrors tests/integration/canopyViewshed.test.js) ----
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
class MockImageOverlay {
  constructor(url, bounds, opts) { this._url = url; this._bounds = bounds; this.options = opts || {}; }
  setUrl(u) { this._url = u; return this; }
  setBounds(b) { this._bounds = b; return this; }
  setOpacity(o) { this.options.opacity = o; return this; }
  addTo() { return this; }
}

globalThis.L = {
  Point: MockPoint, point: (x, y) => new MockPoint(x, y),
  Polygon: class {}, Polyline: class {}, CircleMarker: MockCircleMarker, Circle: class {}, Marker: class {},
  DomEvent: { stopPropagation: () => {} },
  latLngBounds: (a, b) => ({ sw: a, ne: b, getNorthEast: () => ({ lat: b[0], lng: b[1] }), getSouthWest: () => ({ lat: a[0], lng: a[1] }) }),
  imageOverlay: (url, bounds, opts) => new MockImageOverlay(url, bounds, opts),
  popup: () => ({ setLatLng() { return this; }, setContent() { return this; }, openOn() { return this; }, update() { return this; } }),
};

const {
  S, collectFeaturesAt, setShadowOpacity, _renderShadowForTime, _updateShadowForTime, _shadowTime,
} = require('../../sar-preflight.js');

const LL = (lat, lng) => ({ lat, lng });

// jsdom has no canvas: stub the raster paint path renderRasterOverlay uses.
beforeAll(() => {
  document.createElement = (orig => function (tag) {
    const el = orig.call(document, tag);
    if (tag === 'canvas') {
      el.getContext = () => ({ putImageData: () => {} });
      el.toDataURL = () => 'data:image/png;base64,';
    }
    return el;
  })(document.createElement);
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
});

describe('shadow overlay is excluded from the aggregated popup', () => {
  beforeEach(() => {
    S.map = { latLngToLayerPoint: project, hasLayer: () => true };
    S.mapLayers = {};
  });

  it('skips features in the shadow layer but keeps normal layers', () => {
    const click = LL(38.7, -120.99);
    S.mapLayers.shadow = new MockGroup([new MockCircleMarker(click, 50, 'shadow-popup')]);
    S.mapLayers.faa_obstacles = new MockGroup([new MockCircleMarker(click, 50, 'real-feature')]);
    const contents = collectFeaturesAt(click).map(h => h.content);
    expect(contents).toContain('real-feature');
    expect(contents).not.toContain('shadow-popup');
  });
});

describe('setShadowOpacity', () => {
  it('updates the layer opacity and the % readout', () => {
    document.body.innerHTML = '<span id="shadowOpacityVal"></span>';
    let applied = null;
    S.mapLayers.shadow = { setOpacity: v => { applied = v; } };
    setShadowOpacity('0.4');
    expect(applied).toBe(0.4);
    expect(document.getElementById('shadowOpacityVal').textContent).toBe('40%');
  });
});

describe('_shadowTime', () => {
  it('uses the time bar hour when hourly data is loaded', () => {
    S.wx = { hourly: { time: ['2026-07-18T08:00', '2026-07-18T09:00', '2026-07-18T10:00'] } };
    S.timeIdx = 2;
    expect(_shadowTime().getTime()).toBe(new Date('2026-07-18T10:00').getTime());
  });

  it('falls back to now without hourly data', () => {
    S.wx = null;
    const before = Date.now();
    const t = _shadowTime().getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('_renderShadowForTime', () => {
  beforeEach(() => {
    document.body.innerHTML = '<span id="shadowStatus"></span><div id="shadowResult"></div>';
    S.map = { latLngToLayerPoint: project, hasLayer: () => false, addLayer: () => {}, removeLayer: () => {} };
    S.mapLayers = {};
    S._overlayWanted = {};
    S.is3D = false;
    // Midday over a flat DEM at the default map center.
    S.wx = { hourly: { time: ['2026-07-18T12:00'] } };
    S.timeIdx = 0;
    const grid = makeGrid(38.685, -120.99, 100, 10);
    S.shadow = { grid, demFlat: new Float32Array(grid.rows * grid.cols), source: '3DEP ~10 m' };
  });

  it('computes a mask, paints the overlay, and reports sun + shade %', () => {
    _renderShadowForTime();
    expect(S.shadow.mask).toBeInstanceOf(Uint8Array);
    expect(S.shadow.sun.elevation).toBeGreaterThan(0); // noon local is daytime
    expect(S.mapLayers.shadow).toBeTruthy();
    expect(S._overlayWanted.shadow).toBe(true);
    expect(document.getElementById('shadowStatus').textContent).toMatch(/^SUN \d+° ↑\d+°$/);
    expect(document.getElementById('shadowResult').textContent).toMatch(/% of view in shade/);
  });

  it('night hour → full-shade mask and NIGHT status', () => {
    S.wx.hourly.time = ['2026-07-18T00:30'];
    _renderShadowForTime();
    expect(S.shadow.sun.elevation).toBeLessThanOrEqual(0);
    expect(Array.from(S.shadow.mask).every(v => v === 255)).toBe(true);
    expect(document.getElementById('shadowStatus').textContent).toBe('NIGHT');
    expect(document.getElementById('shadowResult').textContent).toMatch(/sun below horizon/);
  });

  it('does nothing without a loaded DEM', () => {
    S.shadow = null;
    _renderShadowForTime();
    expect(S.mapLayers.shadow).toBeUndefined();
  });
});

describe('_updateShadowForTime (time-bar hook)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span id="shadowStatus"></span><div id="shadowResult"></div>';
    S.map = { latLngToLayerPoint: project, hasLayer: () => false, addLayer: () => {}, removeLayer: () => {} };
    S.mapLayers = {};
    S.is3D = false;
    S.wx = { hourly: { time: ['2026-07-18T12:00', '2026-07-18T18:00'] } };
    S.timeIdx = 0;
    const grid = makeGrid(38.685, -120.99, 100, 10);
    S.shadow = { grid, demFlat: new Float32Array(grid.rows * grid.cols), source: '3DEP ~10 m' };
  });
  afterEach(() => vi.useRealTimers());

  it('recomputes (debounced) when the overlay is wanted', () => {
    S._overlayWanted = { shadow: true };
    S.timeIdx = 1;
    _updateShadowForTime();
    expect(S.shadow.mask).toBeUndefined(); // not yet — debounced
    vi.advanceTimersByTime(150);
    expect(S.shadow.mask).toBeInstanceOf(Uint8Array);
    expect(S.shadow.timeMs).toBe(new Date('2026-07-18T18:00').getTime());
  });

  it('does nothing when the overlay is toggled off', () => {
    S._overlayWanted = { shadow: false };
    _updateShadowForTime();
    vi.advanceTimersByTime(150);
    expect(S.shadow.mask).toBeUndefined();
  });
});
