const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Minimal Leaflet mock (render layer fns are guarded; we exercise the fetch→parse→merge path)
const layerGroupMock = () => ({ _layers: [], addLayer(x){ this._layers.push(x); }, clearLayers(){ this._layers = []; }, getLayers(){ return this._layers; }, addTo(){ return this; } });
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const { S, fetchLiveTFRs, tfrGeoJsonUrlForBounds, DEFAULT_DATA_PROXY } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const geojsonObj = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: { NOTAM_KEY: '6/4112-1-FDC-F', TITLE: 'Wildfire near Placerville', LEGAL: 'HAZARDS', CNS_LOCATION_ID: 'ZOA', STATE: 'CA' },
    geometry: { type: 'Polygon', coordinates: [[[-121.0, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121.0, 38.7], [-121.0, 38.6]]] },
  }],
};

// Detail XML for TFR 6/4112 (altitude band + effective/expire window).
const detailXml = `<?xml version="1.0"?><XNOTAM><Group><Add><Not>
  <txtLocalName>6/4112</txtLocalName>
  <codeType>91.137</codeType>
  <codeFacility>ZOA</codeFacility>
  <txtNameUSState>CALIFORNIA</txtNameUSState>
  <txtNameTitle>Wildfire near Placerville</txtNameTitle>
  <txtDescrPurpose>TEMPORARY FLIGHT RESTRICTIONS</txtDescrPurpose>
  <dateEffective>2026-06-13T22:30:00</dateEffective>
  <dateExpire>2026-12-31T23:59:00</dateExpire>
  <valDistVerLower>0</valDistVerLower>
  <valDistVerUpper>10000</valDistVerUpper>
  <uomDistVerUpper>FT</uomDistVerUpper>
</Not></Add></Group></XNOTAM>`;

const bounds = {
  getSouthWest: () => ({ lat: 38.6, lng: -121.0 }),
  getNorthEast: () => ({ lat: 38.7, lng: -120.9 }),
};

// fetch mock that routes by URL and records every call.
function installFetch({ wfsOk = true, detailOk = true } = {}) {
  const urls = [];
  globalThis.fetch = (url) => {
    urls.push(url);
    if (url.includes('/geoserver/')) {
      return Promise.resolve(wfsOk
        ? { ok: true, json: async () => geojsonObj }
        : { ok: false, status: 503 });
    }
    if (url.includes('/download/detail_')) {
      return Promise.resolve(detailOk
        ? { ok: true, text: async () => detailXml }
        : { ok: false, status: 404 });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };
  return urls;
}

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

  it('uses the built-in default proxy when no custom proxy is configured', async () => {
    localStorage.removeItem('sar_canopy_proxy');
    const urls = installFetch();
    await fetchLiveTFRs(bounds);
    const wfs = urls.find(u => u.includes('/geoserver/'));
    expect(wfs).toContain(DEFAULT_DATA_PROXY + '/tfr/geoserver/TFR/ows');
    expect(S.tfrs.length).toBe(1);
  });

  it('fetches the proxied /tfr/ GeoServer URL and populates S.tfrs flagged _live', async () => {
    const urls = installFetch();
    await fetchLiveTFRs(bounds);
    const wfs = urls.find(u => u.includes('/geoserver/'));
    expect(wfs).toContain('https://x.workers.dev/tfr/geoserver/TFR/ows');
    expect(wfs).toContain('typeName=TFR:V_TFR_LOC');
    expect(wfs).toContain('bbox=');
    expect(S.tfrs.length).toBe(1);
    expect(S.tfrs[0].id).toBe('6/4112');
    expect(S.tfrs[0]._live).toBe(true);
    expect(document.getElementById('notamStatus').textContent).toContain('LIVE');
  });

  it('enriches the TFR with altitude + times from its detail XML', async () => {
    const urls = installFetch();
    await fetchLiveTFRs(bounds);
    expect(urls.some(u => u.includes('/tfr/download/detail_6_4112.xml'))).toBe(true);
    const t = S.tfrs[0];
    expect(t.lowerAlt).toBe(0);
    expect(t.upperAlt).toBe(10000);
    expect(t.altUom).toBe('FT');
    expect(t.effectiveStart).toBeTruthy();
    expect(t.effectiveEnd).toBeTruthy();
    // geometry from the WFS feed is preserved through enrichment
    expect(t.polygons && t.polygons.length).toBeTruthy();
  });

  it('still succeeds when a detail XML is missing (geometry-only TFR)', async () => {
    installFetch({ detailOk: false });
    await fetchLiveTFRs(bounds);
    expect(S.tfrs.length).toBe(1);
    expect(S.tfrs[0].id).toBe('6/4112');
    expect(S.tfrs[0].upperAlt == null).toBe(true); // no enrichment, but TFR still present
  });

  it('replaces a previous live set but keeps manually-imported TFRs', async () => {
    S.tfrs = [
      { id: 'MANUAL-1', polygons: [], name: 'manual' },              // kept
      { id: 'OLD-LIVE', polygons: [], name: 'stale', _live: true },  // dropped
    ];
    installFetch();
    await fetchLiveTFRs(bounds);
    const ids = S.tfrs.map(t => t.id);
    expect(ids).toContain('MANUAL-1');
    expect(ids).not.toContain('OLD-LIVE');
    expect(ids).toContain('6/4112');
  });

  it('on fetch error leaves existing TFRs intact (manual flow preserved)', async () => {
    S.tfrs = [{ id: 'MANUAL-1', polygons: [], name: 'manual' }];
    installFetch({ wfsOk: false });
    await fetchLiveTFRs(bounds);
    expect(S.tfrs.map(t => t.id)).toContain('MANUAL-1');
  });

  it('on fetch error marks the tfr section and turns the pill red (no stuck loading pill)', async () => {
    S.sectionMeta.tfr = null;
    installFetch({ wfsOk: false });
    await fetchLiveTFRs(bounds);
    expect(S.sectionMeta.tfr.status).toBe('error');
    const pill = document.getElementById('notamStatus');
    expect(pill.className).toContain('error');
    expect(pill.textContent).toBe('TFR FAILED');
  });

  it('on success stamps the tfr section with the fetch time', async () => {
    S.sectionMeta.tfr = null;
    installFetch();
    const before = Date.now();
    await fetchLiveTFRs(bounds);
    expect(S.sectionMeta.tfr.status).toBe('live');
    expect(S.sectionMeta.tfr.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('tfrGeoJsonUrlForBounds still builds the direct GeoServer URL', () => {
    const url = tfrGeoJsonUrlForBounds(bounds);
    expect(url).toContain('tfr.faa.gov/geoserver/TFR/ows');
    expect(url).toContain('typeName=TFR:V_TFR_LOC');
    expect(url).toContain('bbox=');
  });
});
