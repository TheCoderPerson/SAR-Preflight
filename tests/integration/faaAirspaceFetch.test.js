// fetchFAAairspace — failures must stay failures.
//
// Before: every rejected request became an EMPTY feature collection, so six
// outages rendered as "LIVE — no restrictions", the empties were written to the
// IndexedDB cache as if real, and the error banner was cleared. Now: all six
// down → cached copy (explicitly labeled) or ERROR; some down → PARTIAL, with
// missing layers filled from the cached copy where one exists and flagged
// `_unavailable` (→ assessment CAUTION) where not.
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const layerGroupMock = () => ({
  _layers: [],
  addLayer(x) { this._layers.push(x); },
  clearLayers() { this._layers = []; },
  getLayers() { return this._layers; },
  addTo() { return this; },
});
globalThis.L = {
  layerGroup: () => layerGroupMock(),
  geoJSON: () => ({ bindPopup() { return this; } }),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const { S, fetchFAAairspace, faaAirspaceUnavailableLayers, computeAssessment } = require('../../sar-preflight.js');

S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };

const bounds = {
  getSouthWest: () => ({ lat: 38.6, lng: -121.1 }),
  getNorthEast: () => ({ lat: 38.8, lng: -120.9 }),
};

const fc = (features) => ({ type: 'FeatureCollection', features: features || [] });
const suaFeature = { type: 'Feature', properties: { NAME: 'R-2508', TYPE_CODE: 'R' }, geometry: { type: 'Polygon', coordinates: [[[-121, 38.6], [-120.9, 38.6], [-120.9, 38.7], [-121, 38.6]]] } };

// Route the six FAA requests by service name. `plan[service]` is either a
// Response-like object or a function returning one; unknown → ok + empty.
function mockFetch(plan) {
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(url);
    const svc = Object.keys(plan).find(k => url.includes('/' + k + '/'));
    const r = svc ? plan[svc] : null;
    const out = typeof r === 'function' ? r() : r;
    if (out && out.reject) return Promise.reject(new Error(out.reject));
    return Promise.resolve(out || { ok: true, status: 200, json: async () => fc() });
  };
  return calls;
}
const ok = (body, headers) => ({
  ok: true, status: 200,
  headers: { get: (k) => (headers && headers[k]) != null ? headers[k] : null },
  json: async () => body,
});
const http = (status) => ({ ok: false, status, json: async () => ({}) });

function setBody() {
  document.body.innerHTML = `
    <input id="cfgMaxWind" type="number" value="27" />
    <span id="assessBadge" class="assessment-badge">--</span><span id="assessText">--</span>
    <span id="faaAirspaceStatus" class="fetch-status"></span>
    <div id="layerList"></div>
  `;
}

describe('fetchFAAairspace — outage handling', () => {
  beforeEach(() => {
    setBody();
    S.areaCenter = { lat: 38.7, lng: -121.0 };
    S.faaAirspace = null;
    S.dataSourceErrors = {};
    S.sectionMeta = {};
    S.nearbyAirports = [];
    globalThis.cacheApiResponse = vi.fn(async () => {});
    globalThis.getCachedApiResponse = vi.fn(async () => null);
  });
  afterEach(() => {
    delete globalThis.fetch;
    delete globalThis.cacheApiResponse;
    delete globalThis.getCachedApiResponse;
    document.body.innerHTML = '';
  });

  it('all six fail with no cached copy → ERROR, state untouched, nothing cached, error recorded', async () => {
    S.faaAirspace = { marker: 'previous' };
    mockFetch({ Class_Airspace: http(503), Special_Use_Airspace: http(503), National_Defense_Airspace_TFR_Areas: http(503), FAA_UAS_FacilityMap_Data_V5: http(503), Part_Time_National_Security_UAS_Flight_Restrictions: http(503), Prohibited_Areas: http(503) });
    await fetchFAAairspace(bounds);
    const st = document.getElementById('faaAirspaceStatus');
    expect(st.className).toContain('error');
    expect(st.textContent).toBe('ERROR');
    expect(S.faaAirspace).toEqual({ marker: 'previous' });   // not replaced with empties
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
    expect(S.dataSourceErrors['FAA Airspace']).toBeTruthy();
    expect(S.dataSourceErrors['FAA Airspace'].message).toMatch(/All 6 FAA airspace requests failed/);
    expect(S.sectionMeta.airspace.sources.faa.status).toBe('error');
  });

  it('all six fail with a cached copy → explicitly labeled CACHED, error still recorded', async () => {
    const ts = Date.now() - 3600 * 1000;
    globalThis.getCachedApiResponse = vi.fn(async () => ({ timestamp: ts, data: { classAirspace: fc(), sua: fc([suaFeature]), tfrs: fc(), laanc: fc(), nsRestrictions: fc(), prohibited: fc() } }));
    mockFetch({ Class_Airspace: { reject: 'net down' }, Special_Use_Airspace: { reject: 'net down' }, National_Defense_Airspace_TFR_Areas: { reject: 'net down' }, FAA_UAS_FacilityMap_Data_V5: { reject: 'net down' }, Part_Time_National_Security_UAS_Flight_Restrictions: { reject: 'net down' }, Prohibited_Areas: { reject: 'net down' } });
    await fetchFAAairspace(bounds);
    const st = document.getElementById('faaAirspaceStatus');
    expect(st.className).toContain('cached');
    expect(st.textContent).toMatch(/^CACHED/);
    expect(S.faaAirspace.sua.features.length).toBe(1);
    expect(S.dataSourceErrors['FAA Airspace']).toBeTruthy();
    expect(S.sectionMeta.airspace.sources.faa.status).toBe('cached');
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
  });

  it('one layer fails with no cached copy → PARTIAL, layer flagged unavailable, result NOT cached', async () => {
    mockFetch({ Special_Use_Airspace: http(502) });
    await fetchFAAairspace(bounds);
    const st = document.getElementById('faaAirspaceStatus');
    expect(st.className).toContain('partial');
    expect(st.textContent).toContain('1/6');
    expect(S.faaAirspace.sua._unavailable).toBe(true);
    expect(S.faaAirspace.sua.features).toEqual([]);
    expect(S.faaAirspace.classAirspace._unavailable).toBeUndefined();
    expect(faaAirspaceUnavailableLayers(S.faaAirspace)).toEqual(['sua']);
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
    expect(S.dataSourceErrors['FAA Airspace'].message).toContain('Special-use airspace');
    expect(S.dataSourceErrors['FAA Airspace'].message).toContain('UNAVAILABLE');
    expect(S.sectionMeta.airspace.sources.faa.status).toBe('error');
  });

  it('an unavailable layer drops the assessment to CAUTION (unverified ≠ clear)', async () => {
    mockFetch({ Part_Time_National_Security_UAS_Flight_Restrictions: http(500) });
    await fetchFAAairspace(bounds);
    S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
    S.wind = { maxWind: 5, maxGust: 8 };
    S.elev = { center: 2000 };
    computeAssessment();
    expect(document.getElementById('assessBadge').textContent).toMatch(/ADVISOR/);
    expect(document.getElementById('assessText').textContent).toContain('NS UAS restrictions');
    expect(document.getElementById('assessText').textContent).toContain('unverified');
  });

  it('one layer fails but a cached copy has it → PARTIAL with the cached layer, marked by its cache time', async () => {
    const ts = Date.now() - 600 * 1000;
    globalThis.getCachedApiResponse = vi.fn(async () => ({ timestamp: ts, data: { sua: fc([suaFeature]) } }));
    mockFetch({ Special_Use_Airspace: http(502) });
    await fetchFAAairspace(bounds);
    expect(document.getElementById('faaAirspaceStatus').className).toContain('partial');
    expect(S.faaAirspace.sua._unavailable).toBeUndefined();
    expect(S.faaAirspace.sua._cachedAt).toBe(ts);
    expect(S.faaAirspace.sua.features.length).toBe(1);
    expect(faaAirspaceUnavailableLayers(S.faaAirspace)).toEqual([]);
    expect(S.dataSourceErrors['FAA Airspace'].message).toContain('cached copy used for Special-use airspace');
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
  });

  it('an ArcGIS 200 carrying an error body counts as a failure', async () => {
    mockFetch({ Prohibited_Areas: ok({ error: { code: 400, message: 'Invalid query' } }) });
    await fetchFAAairspace(bounds);
    expect(document.getElementById('faaAirspaceStatus').className).toContain('partial');
    expect(S.faaAirspace.prohibited._unavailable).toBe(true);
    expect(S.dataSourceErrors['FAA Airspace'].message).toContain('Invalid query');
  });

  it('all six succeed → LIVE, cached once, no error', async () => {
    mockFetch({ Special_Use_Airspace: ok(fc([suaFeature])) });
    await fetchFAAairspace(bounds);
    const st = document.getElementById('faaAirspaceStatus');
    expect(st.className).toContain('live');
    expect(st.textContent).toBe('LIVE');
    expect(S.faaAirspace.sua.features.length).toBe(1);
    expect(globalThis.cacheApiResponse).toHaveBeenCalledTimes(1);
    expect(S.dataSourceErrors['FAA Airspace']).toBeUndefined();
    expect(S.sectionMeta.airspace.sources.faa.status).toBe('live');
  });

  it('answers served from the Service Worker offline fallback are labeled CACHED, not LIVE', async () => {
    const ts = Date.now() - 2 * 3600 * 1000;
    const swHdr = { 'X-SAR-SW-Cache': String(ts) };
    mockFetch({
      Class_Airspace: ok(fc(), swHdr), Special_Use_Airspace: ok(fc([suaFeature]), swHdr), National_Defense_Airspace_TFR_Areas: ok(fc(), swHdr),
      FAA_UAS_FacilityMap_Data_V5: ok(fc(), swHdr), Part_Time_National_Security_UAS_Flight_Restrictions: ok(fc(), swHdr), Prohibited_Areas: ok(fc(), swHdr),
    });
    await fetchFAAairspace(bounds);
    const st = document.getElementById('faaAirspaceStatus');
    expect(st.className).toContain('cached');
    expect(st.textContent).toMatch(/^CACHED/);
    expect(S.sectionMeta.airspace.sources.faa.status).toBe('cached');
    expect(S.sectionMeta.airspace.sources.faa.cachedAt).toBe(ts);
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
    expect(S.dataSourceErrors['FAA Airspace']).toBeUndefined();
  });
});
