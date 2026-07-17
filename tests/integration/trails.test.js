const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// ---- Leaflet mock with real classes so `instanceof` works in the export path ----
class MockGroup {
  constructor(layers) { this._layers = layers || []; }
  getLayers() { return this._layers.slice(); }
  addLayer(l) { this._layers.push(l); }
  clearLayers() { this._layers.length = 0; }
  addTo() { return this; }
}
class MPolyline {
  constructor(latlngs, opts) { this._ll = latlngs; this.options = opts || {}; this._p = null; }
  getLatLngs() { return this._ll; }
  bindPopup(html) { this._p = { getContent: () => html }; return this; }
  getPopup() { return this._p; }
  addTo(g) { g.addLayer(this); return this; }
  on() {} off() {}
}
class MPolygon extends MPolyline {}
class MMarker {
  constructor(ll, popup) { this._ll = ll; this._p = { getContent: () => popup }; }
  getLatLng() { return this._ll; }
  getPopup() { return this._p; }
  on() {} off() {}
}
globalThis.L = {
  Polygon: MPolygon, Polyline: MPolyline, Marker: MMarker,
  Circle: class {}, CircleMarker: class {},
  layerGroup: (init) => new MockGroup(init),
  polyline: (ll, opts) => new MPolyline(ll.map(([lat, lng]) => ({ lat, lng })), opts),
};

const app = require('../../sar-preflight.js');
const {
  S, SECTION_DEFS, fetchTrails, _renderTrails, TRAILS_COLOR,
  gatherVisibleLayerFolders, buildLayerControl,
} = app;
const fixture = require('../fixtures/overpass-trails-response.json');

const bounds = {
  getSouthWest: () => ({ lat: 38.6, lng: -121.0 }),
  getNorthEast: () => ({ lat: 38.8, lng: -120.5 }),
};

beforeEach(() => {
  document.body.innerHTML =
    '<div id="layerList"></div><div class="section-meta" id="meta_trails"></div>' +
    '<span id="trailsStatus"></span><div id="terrTrails"></div>';
  S.map = { hasLayer: () => true, addLayer: () => {}, removeLayer: () => {} };
  S.mapLayers = {};
  S.areaCenter = { lat: 38.7, lng: -120.8 };
  S.sectionMeta = {};
});
afterEach(() => {
  document.body.innerHTML = '';
  S.map = null; S.mapLayers = {}; S.areaCenter = null; S.sectionMeta = {};
  delete globalThis.fetch;
  delete globalThis.getCachedApiResponse;
});

describe('SECTION_DEFS.trails', () => {
  it('has a fetch and an UPDATE-button meta line', () => {
    expect(SECTION_DEFS.trails).toBeTruthy();
    expect(typeof SECTION_DEFS.trails.fetch).toBe('function');
    expect(SECTION_DEFS.trails.lines.some(l => l.button)).toBe(true);
    expect(SECTION_DEFS.trails.lines[0].id).toBe('meta_trails');
  });
});

describe('_renderTrails', () => {
  it('renders one pink dashed polyline per record, with a name popup', () => {
    const n = _renderTrails(parseOverpassTrails(fixture));
    expect(n).toBe(2);
    const layers = S.mapLayers.trails.getLayers();
    expect(layers).toHaveLength(2);
    expect(layers[0].options.color).toBe(TRAILS_COLOR);
    expect(layers[0].options.dashArray).toBe('5,4');
    const html = layers[0].getPopup().getContent();
    expect(html).toContain('Caples Creek Trail');
    expect(html).toContain('Trail (path)');
    expect(html).toContain('SAC scale: mountain hiking');
    expect(layers[1].getPopup().getContent()).toContain('Surface: dirt');
  });

  it('clears previous render instead of stacking', () => {
    _renderTrails(parseOverpassTrails(fixture));
    _renderTrails(parseOverpassTrails(fixture));
    expect(S.mapLayers.trails.getLayers()).toHaveLength(2);
  });
});

describe('fetchTrails', () => {
  it('fetches Overpass, renders trails, and marks the section live', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => fixture }));
    await fetchTrails(bounds);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = globalThis.fetch.mock.calls[0][1].body;
    expect(decodeURIComponent(body)).toContain('["name"]');
    expect(S.mapLayers.trails.getLayers()).toHaveLength(2);
    expect(document.getElementById('terrTrails').textContent).toContain('2 named trails');
    expect(S.sectionMeta.trails.status).toBe('live');
    // Ground Access row for trails appears in the layer control
    expect(document.getElementById('layerList').innerHTML).toContain('Named Trails (OSM)');
  });

  it('falls back to the IndexedDB cache when all mirrors fail', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    globalThis.getCachedApiResponse = vi.fn(async () => ({ data: fixture, timestamp: Date.now() - 60000 }));
    await fetchTrails(bounds);
    expect(globalThis.getCachedApiResponse).toHaveBeenCalledWith('trails', expect.any(String));
    expect(S.mapLayers.trails.getLayers()).toHaveLength(2);
    expect(S.sectionMeta.trails.status).toBe('cached');
  });

  it('marks the section error with no network and no cache', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    await fetchTrails(bounds);
    expect(S.sectionMeta.trails.status).toBe('error');
    expect(document.getElementById('terrTrails').textContent).toContain('Unavailable');
  });
});

describe('trails KML export', () => {
  it('exports visible trails as a styled folder of lines', () => {
    _renderTrails(parseOverpassTrails(fixture));
    const kml = gatherVisibleLayerFolders(null);
    expect(kml).toContain('<Folder><name>Named Trail (OSM)</name>');
    expect(kml).toContain('#trail');
    expect(kml).toContain('<LineString>');
    expect(kml).toContain('Caples Creek Trail');
  });
});
