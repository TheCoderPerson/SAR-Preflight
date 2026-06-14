const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock (render layer fns are guarded; we exercise the fetch→parse→merge path)
const layerGroupMock = () => ({ _layers: [], addLayer(x){ this._layers.push(x); }, clearLayers(){ this._layers = []; }, getLayers(){ return this._layers; }, addTo(){ return this; } });
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const { S, fetchLiveTFRs, tfrGeoJsonUrlForBounds } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const geojsonObj = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { NOTAM_KEY: '6/4112-1-FDC-F', TITLE: 'Wildfire near Placerville', LEGAL: 'HAZARDS', CNS_LOCATION_ID: 'ZOA', STATE: 'CA' },
    geometry: { type: 'Polygon', coordinates: [[[-121.0, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121.0, 38.7], [-121.0, 38.6]]] },
  }],
};

const bounds = {
  getSouthWest: () => ({ lat: 38.6, lng: -121.0 }),
  getNorthEast: () => ({ lat: 38.7, lng: -120.9 }),
};

function setBody() {
  document.body.innerHTML = `
    <input id="cfgMaxWind" type="number" value="27" />
    <span id="assessBadge" class="assessment-badge">--</span>
    <span id="assessText">--</span>
    <span id="notamStatus"></span>
    <div id="tfrStaleBanner"></div>
    <div id="notamDeepLinks"></div>
    <div id="tfrList"></div><span id="tfrCount"></span>
    <textarea id="notamPasteBox"></textarea>
    <div id="notamParseMsg"></div>
    <div id="notamList"></div>
    <div id="layerList"></div>
  `;
}

describe('fetchLiveTFRs (live TFR via proxy)', () => {
  beforeEach(() => {
    setBody();
    S.tfrs = []; S.importedNotams = []; S.tfrImportMeta = null;
    S.areaType = 'POLYGON';
    S.areaCenter = { lat: 38.65, lng: -120.95 };
    S.areaBounds = bounds;
    S.currentArea = null; // skip computeAssessment branch
    localStorage.setItem('sar_canopy_proxy', 'https://x.workers.dev');
  });
  afterEach(() => {
    S.tfrs = []; document.body.innerHTML = '';
    localStorage.removeItem('sar_canopy_proxy');
    delete globalThis.fetch;
  });

  it('is a no-op when no proxy is configured', async () => {
    localStorage.removeItem('sar_canopy_proxy');
    let called = false;
    globalThis.fetch = () => { called = true; return Promise.resolve({ ok: true, json: async () => geojsonObj }); };
    await fetchLiveTFRs(bounds);
    expect(called).toBe(false);
    expect(S.tfrs.length).toBe(0);
  });

  it('fetches the proxied /tfr/ GeoServer URL and populates S.tfrs flagged _live', async () => {
    let calledUrl = null;
    globalThis.fetch = (url) => { calledUrl = url; return Promise.resolve({ ok: true, json: async () => geojsonObj }); };
    await fetchLiveTFRs(bounds);
    expect(calledUrl).toContain('https://x.workers.dev/tfr/geoserver/TFR/ows');
    expect(calledUrl).toContain('typeName=TFR:V_TFR_LOC');
    expect(calledUrl).toContain('bbox=');
    expect(S.tfrs.length).toBe(1);
    expect(S.tfrs[0].id).toBe('6/4112');
    expect(S.tfrs[0]._live).toBe(true);
    expect(document.getElementById('notamStatus').textContent).toContain('LIVE');
  });

  it('replaces a previous live set but keeps manually-imported TFRs', async () => {
    S.tfrs = [
      { id: 'MANUAL-1', polygons: [], name: 'manual' },          // kept
      { id: 'OLD-LIVE', polygons: [], name: 'stale', _live: true }, // dropped
    ];
    globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => geojsonObj });
    await fetchLiveTFRs(bounds);
    const ids = S.tfrs.map(t => t.id);
    expect(ids).toContain('MANUAL-1');
    expect(ids).not.toContain('OLD-LIVE');
    expect(ids).toContain('6/4112');
  });

  it('on fetch error leaves existing TFRs intact (manual flow preserved)', async () => {
    S.tfrs = [{ id: 'MANUAL-1', polygons: [], name: 'manual' }];
    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
    await fetchLiveTFRs(bounds);
    expect(S.tfrs.map(t => t.id)).toContain('MANUAL-1');
  });

  it('tfrGeoJsonUrlForBounds still builds the direct GeoServer URL', () => {
    const url = tfrGeoJsonUrlForBounds(bounds);
    expect(url).toContain('tfr.faa.gov/geoserver/TFR/ows');
    expect(url).toContain('typeName=TFR:V_TFR_LOC');
    expect(url).toContain('bbox=');
  });
});
