const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// ---- Leaflet mock (geoJSON-capable) ----
class MockGroup {
  constructor(layers) { this._layers = layers || []; }
  getLayers() { return this._layers.slice(); }
  addLayer(l) { this._layers.push(l); }
  clearLayers() { this._layers.length = 0; }
  addTo() { return this; }
}
class MGeoJson {
  constructor(gj, opts) { this._gj = gj; this.options = (opts && opts.style) || {}; this._p = null; }
  bindPopup(html) { this._p = { getContent: () => html }; return this; }
  getPopup() { return this._p; }
  on() {} off() {}
}
globalThis.L = {
  Polygon: class {}, Polyline: class {}, Marker: class {}, Circle: class {}, CircleMarker: class {},
  layerGroup: (init) => new MockGroup(init),
  geoJSON: (gj, opts) => new MGeoJson(gj, opts),
};

const app = require('../../sar-preflight.js');
const {
  S, loadParcelsForView, _renderParcels, _parcelPopup, _setParcelChip, _parcelsOnMoveEnd,
  PARCEL_DEBOUNCE_MS, fetchPublicLands, _arcgisGeoJsonUrl,
} = app;

const edcFixture = require('../fixtures/parcels-edc-response.json');
const dwrFixture = require('../fixtures/parcels-dwr-response.json');

const EDC = core.PARCEL_REGISTRY.counties['06017'];
const DWR = core.PARCEL_REGISTRY.fallback;

function mkBounds(w, s, e, n) {
  return {
    getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n,
    getSouthWest: () => ({ lat: s, lng: w }), getNorthEast: () => ({ lat: n, lng: e }),
  };
}

function mkMap(zoom, bounds) {
  return {
    getZoom: () => zoom, getBounds: () => bounds,
    hasLayer: () => true, addLayer: () => {}, removeLayer: () => {}, on: () => {}, off: () => {},
    distance: () => 1500,
  };
}

const PV_BOUNDS = mkBounds(-120.82, 38.72, -120.79, 38.74);   // Placerville (El Dorado)
const SAC_BOUNDS = mkBounds(-121.50, 38.52, -121.42, 38.60);  // Sacramento (no Tier 1)

function chipText() { return document.getElementById('parcelChip').textContent; }

beforeEach(() => {
  document.body.innerHTML = '<div id="layerList"></div><div id="parcelChip" style="display:none"></div>';
  S.mapLayers = { parcels: new MockGroup() };
  S.map = mkMap(16, PV_BOUNDS);
  S._parcelsWanted = true;
  S._parcelAbort = null;
  S._parcelGen = 0;
});
afterEach(() => {
  document.body.innerHTML = '';
  S.map = null; S.mapLayers = {}; S._parcelsWanted = false;
  delete globalThis.fetch;
  delete globalThis.getCachedApiResponse;
});

describe('loadParcelsForView — tiering + rendering', () => {
  it('at z16 in El Dorado fetches the county endpoint and renders parcels with popups', async () => {
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => edcFixture }; };
    await loadParcelsForView();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('gis.eldoradocounty.ca.gov');
    const layers = S.mapLayers.parcels.getLayers();
    expect(layers).toHaveLength(2); // geometry-less feature dropped
    const html = layers[0].getPopup().getContent();
    expect(html).toContain('Parcel 003101032');
    expect(html).toContain('3211 SACRAMENTO ST');
    expect(html).toContain('0.55 ac');
    expect(html).toContain('El Dorado County GIS');
    expect(html).toContain('not survey accurate');
    expect(chipText()).toContain('El Dorado County GIS');
    expect(chipText()).toContain('2 in view');
  });

  it('falls through to DWR when the county endpoint 500s, chip warns about degradation', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      if (url.includes('eldoradocounty')) return { ok: false, status: 500 };
      return { ok: true, json: async () => dwrFixture };
    };
    await loadParcelsForView();
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('gis.water.ca.gov');
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(2);
    expect(chipText()).toContain('County source unavailable');
  });

  it('shows the explicit empty state when every source fails and nothing is cached', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    await loadParcelsForView();
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(0);
    expect(chipText()).toContain('do not interpret as public land');
  });

  it('treats an ArcGIS HTTP-200 in-body error as a FAILURE, not an empty layer (observed live from DWR)', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { code: 400, message: 'Failed to execute query.' } }) });
    await loadParcelsForView();
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(0);
    expect(chipText()).toContain('do not interpret as public land'); // NOT "0 parcels in view"
  });

  it('ignores a cached ArcGIS error body instead of serving it as data', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    globalThis.getCachedApiResponse = async () => ({ data: { error: { code: 400, message: 'Failed to execute query.' } }, timestamp: Date.now() });
    await loadParcelsForView();
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(0);
    expect(chipText()).toContain('do not interpret as public land');
  });

  it('serves cached parcels with a cache-age chip when offline', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };
    globalThis.getCachedApiResponse = async (endpoint, key) =>
      key.startsWith('edc-parcels') ? { data: edcFixture, timestamp: Date.now() - 5 * 60000 } : null;
    await loadParcelsForView();
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(2);
    expect(chipText()).toContain('cached 5m ago');
  });

  it('below the zoom gate issues no fetch and shows the gate chip', async () => {
    S.map = mkMap(13, PV_BOUNDS);
    let called = 0;
    globalThis.fetch = async () => { called++; return { ok: true, json: async () => edcFixture }; };
    await loadParcelsForView();
    expect(called).toBe(0);
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(0);
    expect(chipText()).toContain('zoom in to load');
  });

  it('outside any Tier 1 county queries DWR only and flags truncation', async () => {
    S.map = mkMap(15, SAC_BOUNDS);
    const urls = [];
    const big = { type: 'FeatureCollection', exceededTransferLimit: true, features: dwrFixture.features };
    globalThis.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => big }; };
    await loadParcelsForView();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('gis.water.ca.gov');
    expect(chipText()).toContain('first 2 only');
  });

  it('does nothing while the layer is toggled off', async () => {
    S._parcelsWanted = false;
    let called = 0;
    globalThis.fetch = async () => { called++; return { ok: true, json: async () => edcFixture }; };
    await loadParcelsForView();
    expect(called).toBe(0);
  });

  it('a superseded load (newer generation) never repaints', async () => {
    let resolveFirst;
    globalThis.fetch = () => new Promise(res => { resolveFirst = res; });
    const p1 = loadParcelsForView();
    S._parcelGen++; // simulate a newer pan-triggered load taking over
    resolveFirst({ ok: true, json: async () => edcFixture });
    await p1;
    expect(S.mapLayers.parcels.getLayers()).toHaveLength(0);
  });
});

describe('moveend debounce', () => {
  it('coalesces rapid moveend events into one load after 400 ms', async () => {
    vi.useFakeTimers();
    let called = 0;
    globalThis.fetch = async () => { called++; return { ok: true, json: async () => edcFixture }; };
    _parcelsOnMoveEnd();
    _parcelsOnMoveEnd();
    _parcelsOnMoveEnd();
    expect(called).toBe(0);
    await vi.advanceTimersByTimeAsync(PARCEL_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(called).toBe(1);
  });

  it('no-ops while the layer is off', () => {
    vi.useFakeTimers();
    S._parcelsWanted = false;
    let called = 0;
    globalThis.fetch = async () => { called++; return { ok: true, json: async () => edcFixture }; };
    _parcelsOnMoveEnd();
    vi.advanceTimersByTime(PARCEL_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    expect(called).toBe(0);
  });
});

describe('_parcelPopup', () => {
  it('omits absent fields without looking broken (DWR: no acreage/land use)', () => {
    const p = core.normalizeParcels(dwrFixture.features, DWR, Date.now())[0];
    const html = _parcelPopup(p);
    expect(html).toContain('Parcel 051-250-013');
    expect(html).toContain('4210 MAIN ST, SACRAMENTO, 95820');
    expect(html).not.toContain('ac ·');
    expect(html).not.toContain('null');
    expect(html).toContain('Planning use only');
  });
});

describe('fetchPublicLands (Land Ownership fix)', () => {
  it('_arcgisGeoJsonUrl appends generalization params only when asked', () => {
    const bounds = PV_BOUNDS;
    const plain = _arcgisGeoJsonUrl('base', '1', bounds, 'F1,F2', {});
    expect(plain).not.toContain('maxAllowableOffset');
    expect(plain).not.toContain('geometryPrecision');
    const gen = _arcgisGeoJsonUrl('base', '1', bounds, 'F1,F2', { maxAllowableOffset: 0.001, geometryPrecision: 5 });
    expect(gen).toContain('maxAllowableOffset=0.001');
    expect(gen).toContain('geometryPrecision=5');
  });

  it('queries BLM SMA with maxAllowableOffset (server 500s without it)', async () => {
    document.body.innerHTML += '<span id="publicLandsStatus"></span><div id="terrLandOwnership"></div><div class="section-meta" id="meta_land"></div>';
    S.sectionMeta = {};
    S.areaCenter = { lat: 38.73, lng: -120.8 };
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) }; };
    await fetchPublicLands(PV_BOUNDS);
    const blm = urls.find(u => u.includes('BLM_Natl_SMA_LimitedScale'));
    expect(blm).toBeTruthy();
    expect(blm).toContain('maxAllowableOffset=0.001');
    expect(blm).toContain('geometryPrecision=5');
  });
});
