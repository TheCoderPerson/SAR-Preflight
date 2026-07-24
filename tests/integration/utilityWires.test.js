// fetchUtilityWires — CA utility circuits (PG&E GRIP + CEC), mocked fetch.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// ---- Leaflet mock (polyline-capable) ----
class MockGroup {
  constructor() { this._layers = []; }
  getLayers() { return this._layers.slice(); }
  addLayer(l) { this._layers.push(l); }
  clearLayers() { this._layers.length = 0; }
  addTo() { return this; }
}
class MockPolyline {
  constructor(latlngs, opts) { this._latlngs = latlngs; this.options = opts || {}; this._p = null; }
  bindPopup(html) { this._p = { getContent: () => html }; return this; }
  getPopup() { return this._p; }
  addTo(group) { group.addLayer(this); return this; }
  on() {} off() {}
}
globalThis.L = {
  Polygon: class {}, Polyline: class {}, Marker: class {}, Circle: class {}, CircleMarker: class {},
  layerGroup: () => new MockGroup(),
  polyline: (ll, o) => new MockPolyline(ll, o),
};

const app = require('../../sar-preflight.js');
const { S, fetchUtilityWires } = app;

const pgeFixture = require('../fixtures/utility-pge-response.json');
const cecFixture = require('../fixtures/utility-cec-response.json');

function mkBounds(w, s, e, n) {
  return {
    getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n,
    getSouthWest: () => ({ lat: s, lng: w }), getNorthEast: () => ({ lat: n, lng: e }),
  };
}

const EDC_BOUNDS = mkBounds(-120.82, 38.70, -120.78, 38.73);  // Placerville — PG&E + CEC
const DENVER_BOUNDS = mkBounds(-105.1, 39.6, -104.8, 39.9);   // out of coverage entirely

function distLayer() { return S.mapLayers.wire_utility_distribution; }
function transLayer() { return S.mapLayers.wire_utility_transmission; }

beforeEach(() => {
  document.body.innerHTML = '<div id="layerList"></div>';
  S.map = { hasLayer: () => true, addLayer: () => {}, removeLayer: () => {}, on: () => {}, off: () => {} };
  S.mapLayers = {};
  S.wireHazardCounts = {};
  S.utilityWireCounts = {};
  S.utilityWireInfo = {};
  S.dataSourceErrors = {};
  S.sectionMeta = {};
  S.towerCount = 0;
});
afterEach(() => {
  document.body.innerHTML = '';
  S.map = null; S.mapLayers = {};
  delete globalThis.fetch;
  delete globalThis.cacheApiResponse;
  delete globalThis.getCachedApiResponse;
});

function mockFetchOk() {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (url.includes('services2.arcgis.com/mJaJSax0KPHoCNB6')) return { ok: true, json: async () => pgeFixture };
    if (url.includes('services3.arcgis.com/bWPjFyq029ChCGur')) return { ok: true, json: async () => cecFixture };
    throw new Error('unexpected url ' + url);
  };
  return urls;
}

describe('fetchUtilityWires — coverage gating + rendering', () => {
  it('El Dorado op area queries both sources and renders their categories', async () => {
    const urls = mockFetchOk();
    await fetchUtilityWires(EDC_BOUNDS);
    expect(urls).toHaveLength(2);
    expect(distLayer().getLayers()).toHaveLength(2);   // PG&E fixture feeders
    expect(transLayer().getLayers()).toHaveLength(3);  // CEC minus Proposed + geometry-less
    expect(S.utilityWireCounts).toEqual({ utility_distribution: 2, utility_transmission: 3 });
    expect(S.dataSourceErrors['Utility Circuits']).toBeUndefined();
    expect(S.sectionMeta.obstacles.sources.utility.status).toBe('live');
  });

  it('feeder popups carry name, voltage, and the no-OH/UG + no-service-drop caveat', async () => {
    mockFetchOk();
    await fetchUtilityWires(EDC_BOUNDS);
    const html = distLayer().getLayers()[0].getPopup().getContent();
    expect(html).toContain('PG&E Distribution Circuits');
    expect(html).toContain('DIAMOND SPRINGS 1106');
    expect(html).toContain('12 kV');
    expect(html).toContain('Substation: DIAMOND SPRINGS');
    expect(html).toMatch(/no overhead\/underground/i);
    expect(html).toContain('PG&E GRIP');
  });

  it('CEC popups show voltage with the overhead flag and CEC attribution', async () => {
    mockFetchOk();
    await fetchUtilityWires(EDC_BOUNDS);
    const html = transLayer().getLayers()[0].getPopup().getContent();
    expect(html).toContain('CA Transmission (CEC)');
    expect(html).toContain('115 kV · Overhead');
    expect(html).toContain('Owner: PG&E');
    expect(html).toContain('California Energy Commission');
  });

  it('an out-of-state op area is a silent no-op — no fetches, no error, empty layers', async () => {
    const urls = [];
    globalThis.fetch = async (url) => { urls.push(url); throw new Error('should not be called'); };
    await fetchUtilityWires(DENVER_BOUNDS);
    expect(urls).toHaveLength(0);
    expect(distLayer().getLayers()).toHaveLength(0);
    expect(S.utilityWireCounts).toEqual({});
    expect(S.dataSourceErrors['Utility Circuits']).toBeUndefined();
    expect(S.sectionMeta.obstacles).toBeUndefined(); // out of coverage ≠ a data-source state
  });

  it('caches normalized records per source under the utility_wires endpoint', async () => {
    mockFetchOk();
    const cached = [];
    globalThis.cacheApiResponse = async (endpoint, key, data) => { cached.push({ endpoint, key, data }); };
    await fetchUtilityWires(EDC_BOUNDS);
    expect(cached).toHaveLength(2);
    expect(cached.every(c => c.endpoint === 'utility_wires')).toBe(true);
    expect(cached.map(c => c.key).join('|')).toContain('pge-grip-feeders');
    expect(cached[0].data.recs.length).toBeGreaterThan(0);
    expect(cached[0].data.truncated).toBe(true); // fixtures carry exceededTransferLimit
  });
});

describe('fetchUtilityWires — degradation', () => {
  it('one source failing still renders the other and records the error', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('mJaJSax0KPHoCNB6')) return { ok: false, status: 503 };
      return { ok: true, json: async () => cecFixture };
    };
    await fetchUtilityWires(EDC_BOUNDS);
    expect(distLayer().getLayers()).toHaveLength(0);
    expect(transLayer().getLayers()).toHaveLength(3);
    expect(S.dataSourceErrors['Utility Circuits']).toBeDefined();
    expect(S.utilityWireInfo['pge-grip-feeders'].failed).toBe(true);
    expect(S.sectionMeta.obstacles.sources.utility.status).toBe('error');
  });

  it('an ArcGIS HTTP-200 in-body error is a failure, not an empty layer', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: { code: 400, message: 'Failed to execute query.' } }) });
    await fetchUtilityWires(EDC_BOUNDS);
    expect(distLayer().getLayers()).toHaveLength(0);
    expect(transLayer().getLayers()).toHaveLength(0);
    expect(S.dataSourceErrors['Utility Circuits']).toBeDefined();
  });

  it('serves cached records when the network is down', async () => {
    globalThis.fetch = async () => { throw new Error('offline'); };
    const recs = core.normalizeUtilityWires(pgeFixture.features, core.UTILITY_WIRE_SOURCES[0], 111);
    globalThis.getCachedApiResponse = async (endpoint, key) => {
      if (key.includes('pge-grip-feeders')) return { data: { recs, truncated: false }, timestamp: 999 };
      return null;
    };
    await fetchUtilityWires(EDC_BOUNDS);
    expect(distLayer().getLayers()).toHaveLength(2);
    expect(S.utilityWireInfo['pge-grip-feeders'].fromCache).toBe(true);
    expect(S.utilityWireInfo['pge-grip-feeders'].cachedAt).toBe(999);
    // CEC had no cache → that source failed
    expect(S.utilityWireInfo['cec-transmission'].failed).toBe(true);
    expect(S.dataSourceErrors['Utility Circuits']).toBeDefined();
  });
});
