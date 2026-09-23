// Regression tests for the D01–D14 review findings (Sept 2026):
// request ownership for every area-bound source, partial/cached/truncated
// honesty through the shared loaders, assessment inputs that used to be
// ignored or silently dropped, terrain/geometry correctness and time context.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

function chain() {
  const fn = function () { return chain(); };
  return new Proxy(fn, { get(t, p) { if (p === 'then') return undefined; if (p in t) return t[p]; return chain(); } });
}
function mockLayerGroup() {
  const g = { _layers: [], addTo() { return g; }, clearLayers() { g._layers.length = 0; }, addLayer(l) { g._layers.push(l); },
    getLayers() { return g._layers; }, eachLayer(cb) { g._layers.forEach(cb); }, hasLayer() { return false; }, removeLayer(l) { const i = g._layers.indexOf(l); if (i >= 0) g._layers.splice(i, 1); } };
  return g;
}
const leafletLayer = () => {
  const self = new Proxy({}, { get(t, p) {
    if (p === 'then') return undefined;
    if (p === 'addTo') return grp => { if (grp && grp.addLayer) grp.addLayer(self); return self; };
    return () => self;
  } });
  return self;
};
globalThis.L = new Proxy({
  layerGroup: () => mockLayerGroup(),
  marker: () => leafletLayer(), circleMarker: () => leafletLayer(), polyline: () => leafletLayer(),
  polygon: () => leafletLayer(), circle: () => leafletLayer(), geoJSON: () => leafletLayer(),
  Browser: { mobile: false },
}, { get(t, p) { return p in t ? t[p] : chain(); } });

const app = require('../../sar-preflight.js');
const { S, computeAssessment } = app;
const { formatAge } = require('../../sar-preflight-offline.js');

const APP_BODY = (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
  return html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');
})();

function resp(body, { status = 200, headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: k => (h[String(k).toLowerCase()] ?? null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => body,
  };
}
const fc = (features, extra) => Object.assign({ type: 'FeatureCollection', features }, extra || {});
const square = (lat, lng, d, props) => ({ type: 'Feature', properties: props || {},
  geometry: { type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] } });
const line = (lat, lng, props) => ({ type: 'Feature', properties: props || {},
  geometry: { type: 'LineString', coordinates: [[lng - 0.001, lat], [lng + 0.001, lat]] } });
const bbox = (lat, lng, d = 0.02) => ({
  getSouthWest: () => ({ lat: lat - d, lng: lng - d }), getNorthEast: () => ({ lat: lat + d, lng: lng + d }),
  getCenter: () => ({ lat, lng }),
  getSouth: () => lat - d, getNorth: () => lat + d, getWest: () => lng - d, getEast: () => lng + d,
});
const areaLayer = (lat, lng, d = 0.02) => ({
  getBounds: () => bbox(lat, lng, d),
  getLatLngs: () => [[{ lat: lat - d, lng: lng - d }, { lat: lat - d, lng: lng + d }, { lat: lat + d, lng: lng + d }, { lat: lat + d, lng: lng - d }]],
});
const A = { lat: 38, lng: -121 }, B = { lat: 39, lng: -120 };
const text = id => document.getElementById(id).textContent;
const hasClass = (id, c) => document.getElementById(id).classList.contains(c);
const flush = () => new Promise(r => setTimeout(r, 0));

let cacheStore;
beforeEach(() => {
  document.body.innerHTML = APP_BODY;
  S.map = new Proxy({ hasLayer: () => false, addLayer() {}, removeLayer() {} }, { get(t, p) { return p in t ? t[p] : chain(); } });
  S.mapLayers = {};
  S.sectionMeta = {}; S.dataSourceErrors = {}; S._dataArea = {};
  S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
  S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
  S.protectedAreas = { dams: [], wilderness: [], nationalParks: [] };
  S.faaObstacles = fc([]); S.nearbyAirports = [];
  S.nwsAlerts = []; S.nwsAlertsUnverified = false; S.nwsAlertsSource = null; S.nwsAlertsAt = null;
  S.tfrs = []; S.importedNotams = []; S.activeFires = []; S.adsbAircraft = [];
  S.faaAirspace = { classAirspace: fc([]), sua: fc([]), tfrs: fc([]), laanc: fc([]), nsRestrictions: fc([]), prohibited: fc([]) };
  S.kp = null; S.aqi = null; S.metar = null; S.metarUnverified = false; S.fireDanger = null; S.autoCheck = null;
  S.landStatus = null; S.cellStatus = null; S.hmsSmoke = null; S.avalanche = null; S.publicLands = null;
  S.timeIdx = 0; S.lzs = [];
  S.areaType = 'RECTANGLE';
  S.areaCenter = A; S.areaBounds = bbox(A.lat, A.lng); S.currentArea = areaLayer(A.lat, A.lng);
  cacheStore = {};
  globalThis.cacheApiResponse = vi.fn(async (ep, k, data) => { cacheStore[ep + '_' + k] = { data, timestamp: Date.now(), status: 'fresh' }; });
  globalThis.getCachedApiResponse = vi.fn(async (ep, k) => cacheStore[ep + '_' + k] || null);
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  ['cacheApiResponse', 'getCachedApiResponse', 'setLastDataTimestamp', 'areaKey', 'formatAge'].forEach(k => delete globalThis[k]);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function route(table) {
  globalThis.fetch = vi.fn((url, opts) => {
    for (const [needle, h] of Object.entries(table)) {
      if (String(url).includes(needle)) return typeof h === 'function' ? h(url, opts) : Promise.resolve(h);
    }
    return Promise.resolve(resp({}, { status: 404 }));
  });
}
// A fetch handler that parks every request until release(response) is called.
function held() {
  const waiting = [];
  const h = () => new Promise(r => waiting.push(r));
  h.release = r => { waiting.splice(0).forEach(w => w(r)); };
  h.fail = () => { waiting.splice(0).forEach(w => w(resp({}, { status: 503 }))); };
  h.count = () => waiting.length;
  return h;
}
// Switch the selected area the way processArea does (without its fetches).
function selectArea(p) {
  app.invalidateAreaRequests();
  S.sectionMeta = {};
  S.areaCenter = p; S.areaBounds = bbox(p.lat, p.lng); S.currentArea = areaLayer(p.lat, p.lng);
}
const limits = () => (computeAssessment(), S.assessment.limits);
const advisories = () => (computeAssessment(), S.assessment.advisories);

// --- METAR fixtures ---------------------------------------------------------
const OBS_M = 1609.344;
function metarRoutes({ station, visSm, ceilM, when = Date.now() }) {
  return {
    'api.weather.gov/points/': resp({ properties: { observationStations: `https://api.weather.gov/gridpoints/${station}/stations` } }),
    [`gridpoints/${station}/stations`]: resp({ features: [{ properties: { stationIdentifier: station, name: station }, geometry: { coordinates: [-120, 39] } }] }),
    [`stations/${station}/observations/latest`]: resp({ properties: {
      cloudLayers: ceilM == null ? [] : [{ amount: 'OVC', base: { value: ceilM } }],
      visibility: { value: visSm * OBS_M }, timestamp: new Date(when).toISOString(), rawMessage: station + ' test' } }),
  };
}

// ============================================================================
describe('D01 — request ownership for every area-bound source', () => {
  it('METAR: a late answer for area A cannot replace B\'s observation or clear its limits', async () => {
    const hA = held();
    route({ 'api.weather.gov/points/38': hA });
    const a = app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    selectArea(B);
    route(metarRoutes({ station: 'KBBB', visSm: 1, ceilM: 100 }));
    await app.fetchAviationWeather(B, bbox(B.lat, B.lng));
    expect(S.metar.station).toBe('KBBB');
    expect(limits()).toHaveLength(2);
    route(metarRoutes({ station: 'KAAA', visSm: 10, ceilM: null }));
    hA.release(resp({ properties: { observationStations: 'https://api.weather.gov/gridpoints/KAAA/stations' } }));
    await a;
    expect(S.metar.station).toBe('KBBB');
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(limits()).toHaveLength(2);
  });

  it('METAR: a late FAILURE for area A does not flag B\'s check unverified', async () => {
    const hA = held();
    route({ 'api.weather.gov/points/38': hA });
    const a = app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    selectArea(B);
    route(metarRoutes({ station: 'KBBB', visSm: 1, ceilM: 100 }));
    await app.fetchAviationWeather(B, bbox(B.lat, B.lng));
    hA.fail(); await a;
    expect(S.metarUnverified).toBe(false);
    expect(S.dataSourceErrors['Aviation Wx']).toBeUndefined();
  });

  it('smoke: a late empty answer for A cannot clear B\'s plume advisory', async () => {
    const hA = held();
    route({ NOAA_Satellite_Smoke: hA });
    const a = app.fetchHMSSmoke(bbox(A.lat, A.lng));
    selectArea(B);
    route({ NOAA_Satellite_Smoke: resp(fc([square(B.lat, B.lng, 0.5, { Density: 'Heavy' })])) });
    await app.fetchHMSSmoke(bbox(B.lat, B.lng));
    expect(advisories().some(s => /smoke plume/i.test(s))).toBe(true);
    hA.release(resp(fc([]))); await a;
    expect(S.hmsSmoke).toHaveLength(1);
    expect(advisories().some(s => /smoke plume/i.test(s))).toBe(true);
  });

  it('avalanche: a late empty answer for A cannot clear B\'s warning', async () => {
    const hA = held();
    route({ 'api.avalanche.org': hA });
    const a = app.fetchAvalanche(bbox(A.lat, A.lng));
    selectArea(B);
    route({ 'api.avalanche.org': resp(fc([square(B.lat, B.lng, 0.3, { warning: true, danger_level: 4, name: 'B zone' })])) });
    await app.fetchAvalanche(bbox(B.lat, B.lng));
    expect(advisories()).toContain('Avalanche warning in effect for area');
    hA.release(resp(fc([]))); await a;
    expect(advisories()).toContain('Avalanche warning in effect for area');
  });

  it('public lands: a late empty answer for A cannot clear B\'s private-land advisory', async () => {
    const hA = held();
    route({ BLM_Natl_SMA_LimitedScale: hA });
    const a = app.fetchPublicLands(bbox(A.lat, A.lng));
    selectArea(B);
    route({ BLM_Natl_SMA_LimitedScale: resp(fc([square(B.lat, B.lng, 0.1, { ADMIN_AGENCY_CODE: 'PVT' })])) });
    await app.fetchPublicLands(bbox(B.lat, B.lng));
    expect(advisories().some(s => /private \/ non-public land/.test(s))).toBe(true);
    hA.release(resp(fc([]))); await a;
    expect(S.landStatus && S.landStatus.privateFrac).toBeGreaterThan(0.9);
    expect(advisories().some(s => /private \/ non-public land/.test(s))).toBe(true);
  });

  it('water and ground access: late answers for A leave B\'s readouts alone', async () => {
    const hA = held();
    route({ nhd: hA, EDW: hA, GTLF: hA });
    const w = app.fetchWaterFeatures(bbox(A.lat, A.lng));
    const g = app.fetchGroundAccess(bbox(A.lat, A.lng));
    selectArea(B);
    route({ 'MapServer/6/query': resp(fc([line(B.lat, B.lng)])), 'MapServer/12/query': resp(fc([])),
      EDW_RoadBasic: resp(fc([line(B.lat, B.lng)])), EDW: resp(fc([])), GTLF: resp(fc([])) });
    await app.fetchWaterFeatures(bbox(B.lat, B.lng));
    await app.fetchGroundAccess(bbox(B.lat, B.lng));
    expect(text('terrWater')).toBe('1 water features');
    expect(text('terrGroundAccess')).toMatch(/^Roads 1 /);
    hA.release(resp(fc([]))); await w; await g;
    expect(text('terrWater')).toBe('1 water features');
    expect(text('terrGroundAccess')).toMatch(/^Roads 1 /);
  });

  it('clearing the area discards a pending answer', async () => {
    const hA = held();
    route({ NOAA_Satellite_Smoke: hA });
    const a = app.fetchHMSSmoke(bbox(A.lat, A.lng));
    app.invalidateAreaRequests(); S.hmsSmoke = null; S.currentArea = null;
    hA.release(resp(fc([square(A.lat, A.lng, 0.5, { Density: 'Heavy' })]))); await a;
    expect(S.hmsSmoke).toBeNull();
  });

  it('overlapping same-area refreshes keep the NEWEST request, not the last to arrive', async () => {
    const h1 = held();
    route({ NOAA_Satellite_Smoke: h1 });
    const first = app.fetchHMSSmoke(bbox(A.lat, A.lng));
    route({ NOAA_Satellite_Smoke: resp(fc([square(A.lat, A.lng, 0.5, { Density: 'Heavy' })])) });
    await app.fetchHMSSmoke(bbox(A.lat, A.lng));
    h1.release(resp(fc([]))); await first;
    expect(S.hmsSmoke).toHaveLength(1);
  });
});

// ============================================================================
describe('D02 — a partial multi-source outage is never a complete LIVE result', () => {
  const FLOW = 'MapServer/6/query', WB = 'MapServer/12/query';

  it('streams 503 + lakes empty → PARTIAL, failure retained, no "None found in area"', async () => {
    route({ [FLOW]: resp({}, { status: 503 }), [WB]: resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('waterStatus')).toBe('PARTIAL');
    expect(S.sectionMeta.water.status).toBe('error');
    expect(S.sectionMeta.water.partial).toBe(true);
    expect(S.sectionMeta.water.error).toMatch(/Streams/);
    expect(text('terrWater')).not.toBe('None found in area');
    expect(text('terrWater')).toMatch(/INCOMPLETE — Streams \(NHD flowline\) unavailable/);
  });

  it('lakes fail while streams return features → the count is qualified', async () => {
    route({ [FLOW]: resp(fc([line(A.lat, A.lng), line(A.lat + 0.001, A.lng)])), [WB]: resp({}, { status: 500 }) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('terrWater')).toBe('2 water features (INCOMPLETE — Lakes (NHD waterbody) unavailable)');
    expect(text('waterStatus')).toBe('PARTIAL');
  });

  it('complete recovery returns to LIVE with no error', async () => {
    route({ [FLOW]: resp({}, { status: 503 }), [WB]: resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    route({ [FLOW]: resp(fc([])), [WB]: resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('waterStatus')).toBe('LIVE');
    expect(S.sectionMeta.water.status).toBe('live');
    expect(S.sectionMeta.water.error).toBeNull();
    expect(text('terrWater')).toBe('None found in area');
  });

  it('ground access: one road/trail source failing is PARTIAL and names the source', async () => {
    route({ EDW_TrailNFSPublish: resp({}, { status: 502 }), EDW: resp(fc([])), GTLF: resp(fc([])) });
    await app.fetchGroundAccess(bbox(A.lat, A.lng));
    expect(text('groundAccessStatus')).toBe('PARTIAL');
    expect(S.sectionMeta.groundAccess.error).toMatch(/USFS trails/);
    expect(text('terrGroundAccess')).toMatch(/INCOMPLETE — USFS trails unavailable/);
  });

  it('every source failing → ERROR and UNKNOWN, not "None found"', async () => {
    route({ [FLOW]: resp({}, { status: 503 }), [WB]: resp({}, { status: 503 }) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('waterStatus')).toBe('ERROR');
    expect(text('terrWater')).toMatch(/UNKNOWN/);
  });
});

// ============================================================================
describe('D03 — the alert card follows verification state', () => {
  const NWS = 'api.weather.gov/alerts';
  const cardText = () => text('alertList');

  it('first-load failure → ALERT STATUS UNKNOWN, never the green all-clear', async () => {
    route({ [NWS]: resp({}, { status: 503 }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(text('alertStatus')).toBe('ERROR');
    expect(cardText()).toMatch(/ALERT STATUS UNKNOWN/);
    expect(cardText()).not.toMatch(/NO ACTIVE ALERTS/);
    expect(advisories().some(a => /NWS weather alerts UNVERIFIED/.test(a))).toBe(true);
  });

  it('live empty → green; failed refresh → dated, amber, unverified; recovery → green again', async () => {
    route({ [NWS]: resp(fc([])) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(cardText()).toMatch(/NO ACTIVE ALERTS/);
    route({ [NWS]: resp({}, { status: 503 }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(cardText()).not.toMatch(/NO ACTIVE ALERTS/);
    expect(cardText()).toMatch(/NO ALERTS IN CACHED DATA/);
    expect(document.getElementById('alertList').innerHTML).not.toContain('accent-green');
    route({ [NWS]: resp(fc([])) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(cardText()).toMatch(/NO ACTIVE ALERTS/);
  });

  it('an expired empty cached copy is labeled as cached data, not a current all-clear', async () => {
    cacheStore['nws_' + areaKey(A.lat, A.lng)] = { data: fc([]), timestamp: Date.now() - 6 * 3600e3, status: 'expired' };
    route({ [NWS]: resp({}, { status: 503 }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(cardText()).toMatch(/NO ALERTS IN CACHED DATA/);
    expect(cardText()).toMatch(/not a current live check/);
  });

  it('a SW offline copy with alerts carries the unverified note above the list', async () => {
    route({ [NWS]: resp(fc([{ properties: { id: 'x', event: 'Red Flag Warning', severity: 'Severe' } }]), { headers: { 'X-SAR-SW-Cache': Date.now() - 3600e3 } }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(cardText()).toMatch(/Red Flag Warning/);
    expect(cardText()).toMatch(/not a current live check/);
  });
});

// ============================================================================
describe('D04 — the dedicated prohibited-area layer reaches readout and assessment', () => {
  const P = props => fc([square(A.lat, A.lng, 0.05, Object.assign({ NAME: 'P-TEST', TYPE_CODE: 'P' }, props))]);
  const setFaa = over => { S.faaAirspace = Object.assign({ classAirspace: fc([]), sua: fc([]), tfrs: fc([]), laanc: fc([]), nsRestrictions: fc([]), prohibited: fc([]) }, over); };
  const pLimit = () => limits().filter(l => /Prohibited airspace/.test(l));

  it('dedicated layer only → limit + readout', async () => {
    const FAA = 'ssFJjBXIUyZDrSYZ';
    route({ Prohibited_Areas: resp(P()), [FAA]: resp(fc([])) });
    await app.fetchFAAairspace(bbox(A.lat, A.lng));
    expect(S.faaAirspace.prohibited.features).toHaveLength(1);
    expect(text('airProhibited')).toBe('P-TEST');
    expect(pLimit()).toEqual(['Prohibited airspace: P-TEST']);
    expect(S.assessment.label).not.toBe('NOMINAL');
  });

  it('SUA only → limit', () => {
    setFaa({ sua: P() });
    expect(pLimit()).toEqual(['Prohibited airspace: P-TEST']);
  });

  it('the same area in both layers is reported once', () => {
    setFaa({ sua: P(), prohibited: P() });
    expect(pLimit()).toEqual(['Prohibited airspace: P-TEST']);
    app.computeAirspace(A.lat, A.lng);
    expect(text('airProhibited')).toBe('P-TEST');
  });

  it('a failed SUA lookup does not suppress a dedicated-layer hit', () => {
    setFaa({ sua: fc([], { _unavailable: true }), prohibited: P() });
    expect(pLimit()).toEqual(['Prohibited airspace: P-TEST']);
    app.computeAirspace(A.lat, A.lng);
    expect(text('airProhibited')).toBe('P-TEST');
    expect(text('airMOA')).toMatch(/UNKNOWN/);
  });

  it('both successfully empty → None and no limit; one failed + none found → UNKNOWN', () => {
    setFaa({});
    expect(pLimit()).toEqual([]);
    app.computeAirspace(A.lat, A.lng);
    expect(text('airProhibited')).toBe('None');
    setFaa({ prohibited: fc([], { _unavailable: true }) });
    app.computeAirspace(A.lat, A.lng);
    expect(text('airProhibited')).toMatch(/UNKNOWN/);
  });
});

// ============================================================================
describe('D05 — an unsuccessful METAR check never silently removes observed limits', () => {
  const lowObs = () => route(metarRoutes({ station: 'KTEST', visSm: 1, ceilM: 100 }));

  it('failed refresh after a low ceiling/visibility keeps both limits and adds an advisory', async () => {
    lowObs();
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(limits()).toHaveLength(2);
    route({ 'api.weather.gov/points/': resp({}, { status: 503 }) });
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar.station).toBe('KTEST');
    expect(limits()).toHaveLength(2);
    expect(advisories().some(a => /Observed ceiling\/visibility UNVERIFIED/.test(a))).toBe(true);
    expect(text('wxFlightCat')).toMatch(/stale: Verify/);
  });

  it('all candidate stations unusable → unverified, previous observation kept', async () => {
    lowObs();
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    route(Object.assign(metarRoutes({ station: 'KTEST', visSm: 1, ceilM: 100 }), {
      'stations/KTEST/observations/latest': resp({ properties: { cloudLayers: [], visibility: { value: null } } }) }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar.station).toBe('KTEST');
    expect(S.metarUnverified).toBe(true);
    expect(limits()).toHaveLength(2);
  });

  it('first-load outage → no limits invented, but the check is reported unverified', async () => {
    route({ 'api.weather.gov/points/': resp({}, { status: 503 }) });
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar).toBeNull();
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(advisories().some(a => /UNVERIFIED — NWS points HTTP 503; no current observation available/.test(a))).toBe(true);
    expect(text('wxFlightCat')).toMatch(/UNKNOWN/);
  });

  it("an outage on a NEW area does not carry the old area's observation forward", async () => {
    lowObs();
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    selectArea(B);
    route({ 'api.weather.gov/points/': resp({}, { status: 503 }) });
    await app.fetchAviationWeather(B, bbox(B.lat, B.lng));
    expect(S.metar).toBeNull();
    expect(S.metarUnverified).toBe(true);
    expect(limits()).toHaveLength(0);
  });

  it("this area's cached observation is used (unverified) when nothing is held", async () => {
    lowObs();
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    S.metar = null; S._dataArea.metar = null;
    route({ 'api.weather.gov/points/': resp({}, { status: 503 }) });
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar.station).toBe('KTEST');
    expect(S.metarUnverified).toBe(true);
    expect(limits()).toHaveLength(2);
  });

  it('an observation older than the retention window no longer gates, but stays unverified', async () => {
    route(metarRoutes({ station: 'KTEST', visSm: 1, ceilM: 100, when: Date.now() - app.METAR_RETAIN_MAX_MS - 60e3 }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    route({ 'api.weather.gov/points/': resp({}, { status: 503 }) });
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar).toBeNull();
    expect(advisories().some(a => /UNVERIFIED/.test(a))).toBe(true);
  });

  it('successful recovery clears the unverified state', async () => {
    route({ 'api.weather.gov/points/': resp({}, { status: 503 }) });
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    route(metarRoutes({ station: 'KTEST', visSm: 10, ceilM: null }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metarUnverified).toBe(false);
    expect(advisories().some(a => /UNVERIFIED/.test(a))).toBe(false);
  });

  it('a SW offline copy of the observation is not a verified check', async () => {
    const r = metarRoutes({ station: 'KTEST', visSm: 10, ceilM: null });
    const obsKey = 'stations/KTEST/observations/latest';
    const body = await r[obsKey].json();
    r[obsKey] = resp(body, { headers: { 'X-SAR-SW-Cache': Date.now() - 3600e3 } });
    route(r);
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metarUnverified).toBe(true);
    expect(cacheStore['metar_' + areaKey(A.lat, A.lng)]).toBeUndefined();
  });
});

// ============================================================================
describe('D06 — cached elevation rebuilds every derived value for THIS area', () => {
  const bFlatCache = withPositions => {
    const pts = generateElevationGrid(B.lat, B.lng, { lat: B.lat + 0.02, lng: B.lng + 0.02 }, { lat: B.lat - 0.02, lng: B.lng - 0.02 }, 5);
    cacheStore['elevation_' + areaKey(B.lat, B.lng)] = {
      timestamp: Date.now() - 3600e3, status: 'stale',
      data: Object.assign({ centerIndex: 12, results: pts.map(() => ({ elevation: 100 })) },
        withPositions ? { points: pts.map(p => [p.latitude, p.longitude]) } : {}),
    };
  };
  const failBoth = () => route({ getSamples: resp({}, { status: 503 }), '/v1/elevation': resp({}, { status: 503 }) });

  it("A's landing zones and cell coverage do not survive a cache fallback on B", async () => {
    S.lzs = [{ lat: 38, lng: -121, elevFt: 500, score: 0.9, slopeDeg: 1, description: 'A' }];
    const aCell = { inRegion: true, count: 0, label: 'A coverage', level: 'amber' };
    S.cellStatus = aCell;
    selectArea(B);
    bFlatCache(true); failBoth();
    await app.fetchElevation(B, bbox(B.lat, B.lng));
    expect(S.elev.center).toBe(328);
    expect(S.cellStatus).not.toBe(aCell);
    expect(S.lzs.length).toBeGreaterThan(0);
    expect(S.lzs.every(z => Math.abs(z.lat - B.lat) < 0.03 && Math.abs(z.lng - B.lng) < 0.03)).toBe(true);
    expect(S.sectionMeta.elevation.status).toBe('cached');
  });

  it('a legacy cached copy without positions clears landing zones and reads UNKNOWN', async () => {
    S.lzs = [{ lat: 38, lng: -121, elevFt: 500, score: 0.9, slopeDeg: 1, description: 'A' }];
    selectArea(B);
    bFlatCache(false); failBoth();
    await app.fetchElevation(B, bbox(B.lat, B.lng));
    expect(S.lzs).toEqual([]);
    expect(text('terrLZ')).toMatch(/UNKNOWN/);
    expect(text('terrSlope')).toMatch(/UNKNOWN/);
    expect(S.cellStatus).toBeTruthy();
  });

  it('no cache on a new area → LZ suitability UNKNOWN, not "terrain unsuitable"', async () => {
    S.lzs = [{ lat: 38, lng: -121, elevFt: 500, score: 0.9, slopeDeg: 1, description: 'A' }];
    selectArea(B); failBoth();
    await app.fetchElevation(B, bbox(B.lat, B.lng));
    expect(S.lzs).toEqual([]);
    expect(text('terrLZ')).toMatch(/UNKNOWN/);
  });
});

// ============================================================================
describe('D07 — slope uses the true north/south spacing on rectangular grids', () => {
  it('a 31° north-rising plane over a wide, short rectangle is not "flat"', async () => {
    // Half-spans from the finding: lat ±0.00045°, lng ±0.0057°.
    const c = { lat: 38, lng: -121 };
    const area = { getSouthWest: () => ({ lat: c.lat - 0.00045, lng: c.lng - 0.0057 }), getNorthEast: () => ({ lat: c.lat + 0.00045, lng: c.lng + 0.0057 }) };
    const n = 25;
    const ftPerRow = 50;
    route({ getSamples: url => {
      const pts = JSON.parse(new URL(url).searchParams.get('geometry')).points;
      return Promise.resolve(resp({ samples: pts.map((_, i) => ({ locationId: i, value: String((100 + ftPerRow * Math.floor(i / 5)) / 3.28084) })) }));
    } });
    await app.fetchElevation(c, area);
    expect(S.elev.points).toHaveLength(n);
    // Every interior point sits on the same ~31° plane → no flat landing candidates.
    expect(S.lzs.every(z => z.slopeDeg > 25)).toBe(true);
    expect(text('terrLZ')).not.toMatch(/Generally flat/);
  });
});

// ============================================================================
describe('D08 — Service-Worker copies through the shared GeoJSON loader stay CACHED', () => {
  const FLOW = 'MapServer/6/query', WB = 'MapServer/12/query';
  it('day-old SW copies → CACHED at their stored time, never re-cached', async () => {
    const t = Date.now() - 86400000;
    route({ [FLOW]: resp(fc([]), { headers: { 'X-SAR-SW-Cache': t } }), [WB]: resp(fc([]), { headers: { 'X-SAR-SW-Cache': t } }) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(S.sectionMeta.water.status).toBe('cached');
    expect(S.sectionMeta.water.cachedAt).toBe(t);
    expect(text('waterStatus')).toMatch(/^CACHED 1d/);
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
  });

  it('unknown-age SW copy → "age unknown", not stamped now', async () => {
    route({ [FLOW]: resp(fc([]), { headers: { 'X-SAR-SW-Cache': 'unknown' } }), [WB]: resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(S.sectionMeta.water.status).toBe('cached');
    expect(S.sectionMeta.water.cachedAt).toBeNull();
    expect(text('waterStatus')).toBe('CACHED (age unknown)');
  });

  it('a genuinely live answer is LIVE and cached', async () => {
    route({ [FLOW]: resp(fc([])), [WB]: resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('waterStatus')).toBe('LIVE');
    expect(globalThis.cacheApiResponse).toHaveBeenCalledTimes(2);
  });

  it('smoke via the shared loader is not re-cached from a SW copy either', async () => {
    route({ NOAA_Satellite_Smoke: resp(fc([]), { headers: { 'X-SAR-SW-Cache': Date.now() - 3600e3 } }) });
    await app.fetchHMSSmoke(bbox(A.lat, A.lng));
    expect(globalThis.cacheApiResponse).not.toHaveBeenCalled();
  });
});

// ============================================================================
describe('D09 — briefings state the forecast time they describe', () => {
  it('a selected +1h hour is identified with its valid time and the current-time notice', () => {
    const t0 = Date.parse('2026-09-22T20:00:00Z');
    S.wx = { temperature_2m: 65, hourly: { time: [new Date(t0).toISOString(), new Date(t0 + 3600e3).toISOString()], temperature_2m: [65, 90] } };
    S.timeIdx = 1;
    const txt = app.buildBriefingText();
    expect(txt).toMatch(/Weather valid: FORECAST \+1h — .+ \(2026-09-22T21:00:00\.000Z\)/);
    expect(txt).toMatch(/CURRENT-TIME/);
    expect(txt).toMatch(/Generated: .+\(\d{4}-\d{2}-\d{2}T/);
  });

  it('NOW is labeled as current conditions, with no forecast notice', () => {
    S.timeIdx = 0;
    const txt = app.buildBriefingText();
    expect(txt).toMatch(/Weather valid: NOW/);
    expect(txt).not.toMatch(/FORECAST/);
  });
});

// ============================================================================
describe('D10 — observer async work cannot undo a delete or cross areas', () => {
  const obs = { lat: 38.7, lng: -120.99 };
  beforeEach(() => {
    S._viewshedRunningId = null;
    globalThis.saveViewshed = vi.fn(async () => {});
    globalThis.deleteViewshed = vi.fn(async () => {});
    globalThis.clearViewsheds = vi.fn(async () => {});
    globalThis.saveAppState = vi.fn();
    globalThis.getAppState = vi.fn(async () => null);
    globalThis.isOnline = () => true;
  });
  afterEach(() => { ['saveViewshed', 'deleteViewshed', 'clearViewsheds', 'saveAppState', 'getAppState', 'getAllViewsheds', 'isOnline'].forEach(k => delete globalThis[k]); });

  it('deleting an observer mid-compute: the finished compute never saves it back', async () => {
    const dem = held();
    route({ exportImage: dem });
    S.viewsheds = [makeViewshedRecord({ id: 'v1', observer: obs, aglFt: 200, vlosFt: 300, name: 'T' })];
    const run = app.runViewshed('v1');
    await flush();
    app.removeViewshed('v1');
    expect(S.viewsheds).toHaveLength(0);
    dem.fail();
    await run;
    expect(globalThis.saveViewshed).not.toHaveBeenCalled();
    expect(S.viewsheds).toHaveLength(0);
  });

  it('clear-all mid-compute: nothing is saved back', async () => {
    const dem = held();
    route({ exportImage: dem });
    S.viewsheds = [makeViewshedRecord({ id: 'v1', observer: obs, aglFt: 200, vlosFt: 300, name: 'T' })];
    const run = app.runViewshed('v1');
    await flush();
    app.clearAllViewsheds();
    dem.fail(); await run;
    expect(globalThis.saveViewshed).not.toHaveBeenCalled();
  });

  it('a queued recompute of a deleted observer never runs', async () => {
    const dem = held();
    route({ exportImage: dem });
    S.viewsheds = [makeViewshedRecord({ id: 'v1', observer: obs, aglFt: 200, vlosFt: 300, name: 'T' }),
      makeViewshedRecord({ id: 'v2', observer: obs, aglFt: 200, vlosFt: 300, name: 'U' })];
    const run = app.runViewshed('v1');
    await flush();
    app.runViewshed('v2');                 // queued behind v1
    app.removeViewshed('v2');
    dem.fail(); await run; await flush();
    expect(globalThis.saveViewshed.mock.calls.every(c => c[0].id !== 'v2')).toBe(true);
  });

  it("area A's pending restore does not insert its observers while B is selected", async () => {
    let releaseA;
    globalThis.getAllViewsheds = vi.fn(ak => ak === areaKey(A.lat, A.lng)
      ? new Promise(r => { releaseA = r; }) : Promise.resolve([]));
    const a = app.restoreViewsheds();
    selectArea(B);
    await app.restoreViewsheds();
    releaseA([{ id: 'va', observer: A, aglFt: 200, vlosFt: 300, name: 'A obs' }]);
    await a;
    expect(S.viewsheds).toHaveLength(0);
  });
});

// ============================================================================
describe('D11 — polygon area is the area of the polygon', () => {
  it('a right triangle reports ~1.95 km², not its 3.9 km² bounding box', async () => {
    const verts = [{ lat: 37.99, lng: -121.01 }, { lat: 37.99, lng: -120.99 }, { lat: 38.01, lng: -120.99 }];
    const layer = {
      getBounds: () => ({ getNorthEast: () => ({ lat: 38.01, lng: -120.99 }), getSouthWest: () => ({ lat: 37.99, lng: -121.01 }),
        getCenter: () => ({ lat: 38, lng: -121 }) }),
      getLatLngs: () => [verts],
    };
    route({});
    await app.processArea(layer, 'polygon').catch(() => {});
    expect(text('areaSize')).toMatch(/^1\.9[45] km²/);
  });
});

// ============================================================================
describe('D12 — ArcGIS truncation is incomplete data, never a complete inventory', () => {
  const DOF = 'Digital_Obstacle_File';
  const ob = (agl, id) => ({ type: 'Feature', properties: { OAS_Number: id, AGL: agl, AMSL: agl + 1000, Type_Code: 'TOWER' },
    geometry: { type: 'Point', coordinates: [A.lng, A.lat] } });

  it('a flagged first page is paged to completion; a hazard on page 2 is found', async () => {
    route({ [DOF]: url => Promise.resolve(resp(url.includes('resultOffset=1')
      ? fc([ob(900, 'B')]) : fc([ob(100, 'A')], { properties: { exceededTransferLimit: true } }))) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.faaObstacles.features).toHaveLength(2);
    expect(S.faaObstacles._truncated).toBeUndefined();
    expect(S.sectionMeta.obstacles.sources.dof.status).toBe('live');
    expect(advisories().some(a => /tall obstacle/.test(a))).toBe(true);
  });

  it('top-level flag + failed continuation → PARTIAL, advisory, not cached', async () => {
    route({ [DOF]: url => Promise.resolve(url.includes('resultOffset=')
      ? resp({}, { status: 503 }) : resp(fc([ob(100, 'A')], { exceededTransferLimit: true }))) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.faaObstacles._truncated).toBe(true);
    expect(S.sectionMeta.obstacles.sources.dof.status).toBe('error');
    expect(text('obstacleStatus')).toMatch(/PARTIAL/);
    expect(globalThis.cacheApiResponse.mock.calls.some(c => c[0] === 'faa_obstacles')).toBe(false);
    expect(advisories().some(a => /FAA obstacle data incomplete/.test(a))).toBe(true);
  });

  it('an unflagged complete result makes one request and stays LIVE', async () => {
    route({ [DOF]: resp(fc([ob(100, 'A')])) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(S.sectionMeta.obstacles.sources.dof.status).toBe('live');
  });

  it('FAA airspace: a truncated layer that cannot be completed is PARTIAL + advisory', async () => {
    const FAA = 'ssFJjBXIUyZDrSYZ';
    route({ [FAA]: url => Promise.resolve(url.includes('resultOffset=') ? resp({}, { status: 500 })
      : url.includes('FAA_UAS_FacilityMap') ? resp(fc([square(A.lat, A.lng, 0.01, { CEILING: 200 })], { exceededTransferLimit: true }))
      : resp(fc([]))) });
    await app.fetchFAAairspace(bbox(A.lat, A.lng));
    expect(S.faaAirspace.laanc._truncated).toBe(true);
    expect(text('faaAirspaceStatus')).toMatch(/PARTIAL/);
    expect(advisories().some(a => /LAANC grid truncated/.test(a))).toBe(true);
    expect(globalThis.cacheApiResponse.mock.calls.some(c => c[0] === 'faa_airspace')).toBe(false);
  });

  it('a continuation page served from the SW fallback makes the result CACHED, not re-cached', async () => {
    const t = Date.now() - 86400000;
    route({ [DOF]: url => Promise.resolve(url.includes('resultOffset=')
      ? resp(fc([ob(600, 'B')]), { headers: { 'X-SAR-SW-Cache': t } })
      : resp(fc([ob(100, 'A')], { exceededTransferLimit: true }))) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.faaObstacles.features).toHaveLength(2);
    expect(S.sectionMeta.obstacles.sources.dof.status).toBe('cached');
    expect(S.sectionMeta.obstacles.sources.dof.cachedAt).toBe(t);
    expect(globalThis.cacheApiResponse.mock.calls.some(c => c[0] === 'faa_obstacles')).toBe(false);

    route({ 'MapServer/6/query': url => Promise.resolve(url.includes('resultOffset=')
        ? resp(fc([line(A.lat, A.lng)]), { headers: { 'X-SAR-SW-Cache': t } })
        : resp(fc([line(A.lat, A.lng)], { exceededTransferLimit: true }))),
      'MapServer/12/query': resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(S.sectionMeta.water.status).toBe('cached');
    expect(globalThis.cacheApiResponse.mock.calls.some(c => String(c[1]).startsWith('flow_'))).toBe(false);
  });

  it('a completed paged result is cached WITHOUT the truncation flag and reads back complete', async () => {
    route({ 'MapServer/6/query': url => Promise.resolve(url.includes('resultOffset=')
        ? resp(fc([line(A.lat + 0.001, A.lng)]))
        : resp(fc([line(A.lat, A.lng)], { properties: { exceededTransferLimit: true } }))),
      'MapServer/12/query': resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    const stored = Object.entries(cacheStore).find(([k]) => k.startsWith('nhd_water_flow_'))[1].data;
    expect(stored.features).toHaveLength(2);
    expect(arcgisExceededLimit(stored)).toBe(false);
    route({ 'MapServer/6/query': resp({}, { status: 503 }), 'MapServer/12/query': resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('terrWater')).toBe('2 water features');
    expect(text('waterStatus')).toMatch(/^CACHED/);
  });

  it('shared loader: a truncated water layer is paged; a failed page is PARTIAL', async () => {
    route({ 'MapServer/6/query': url => Promise.resolve(url.includes('resultOffset=')
        ? resp({}, { status: 503 }) : resp(fc([line(A.lat, A.lng)], { exceededTransferLimit: true }))),
      'MapServer/12/query': resp(fc([])) });
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(text('waterStatus')).toBe('PARTIAL');
    expect(text('terrWater')).toMatch(/truncated/);
    expect(globalThis.cacheApiResponse.mock.calls.some(c => String(c[1]).startsWith('flow_'))).toBe(false);
  });
});

// ============================================================================
describe('D13 — raster cache entries keep their own geography', () => {
  // Index of the tallest cell (cells outside the source raster are NaN).
  const hillOf = (grid, flat) => { let mi = -1; for (let i = 0; i < flat.length; i++) if (flat[i] > (mi < 0 ? -Infinity : flat[mi])) mi = i; return mi; };
  let rasterStore;
  beforeEach(() => {
    rasterStore = new Map();
    globalThis.cacheRaster = vi.fn(async (kind, key, data) => { rasterStore.set(kind + '|' + key, data); });
    globalThis.getCachedRaster = vi.fn(async (kind, key) => { const d = rasterStore.get(kind + '|' + key); return d ? { data: d } : null; });
    // A controlled decoder: 54×54 px with one 100 m hill in the central pixel.
    globalThis.GeoTIFF = { fromArrayBuffer: async () => ({ getImage: async () => ({
      getWidth: () => 54, getHeight: () => 54,
      readRasters: async () => { const a = new Float32Array(54 * 54); a[27 * 54 + 27] = 100; return [a]; },
    }) }) };
  });
  afterEach(() => { ['cacheRaster', 'getCachedRaster', 'GeoTIFF', 'isOnline'].forEach(k => delete globalThis[k]); });

  it("nearby grids whose rounded keys collided no longer share an entry", () => {
    const gA = makeGrid(38, -121, 80, 3), gB = makeGrid(38.0002, -121, 80, 3);
    expect(app._rasterGridKey('dem', gA)).not.toBe(app._rasterGridKey('dem', gB));
  });

  it('a cached DEM is placed at the bounds stored with it, not the request\'s', async () => {
    const gA = makeGrid(38, -121, 80, 3), gB = makeGrid(38.0002, -121, 80, 3);
    globalThis.isOnline = () => true;
    route({ exportImage: resp(new ArrayBuffer(8)) });
    const a = await app.fetch3DEPDEM(gA);
    const hillA = hillOf(gA, a.demFlat);
    const hillLat = gA.north - (Math.floor(hillA / gA.cols) + 0.5) * (gA.north - gA.south) / gA.rows;
    const hillLng = gA.west + ((hillA % gA.cols) + 0.5) * (gA.east - gA.west) / gA.cols;
    // Simulate an entry under B's key that actually holds A's raster (the old
    // collision): it must be laid at A's coordinates inside B's grid.
    rasterStore.set('dem|' + app._rasterGridKey('dem', gB), rasterStore.get('dem|' + app._rasterGridKey('dem', gA)));
    globalThis.isOnline = () => false;
    const b = await app.fetch3DEPDEM(gB);
    const hillB = hillOf(gB, b.demFlat);
    const want = latLngToCell(gB, hillLat, hillLng);
    expect(Math.abs(Math.floor(hillB / gB.cols) - want.row)).toBeLessThanOrEqual(1);
    expect(Math.abs((hillB % gB.cols) - want.col)).toBeLessThanOrEqual(1);
  });

  it('offline with no entry for the exact grid → unavailable, never a neighbour\'s raster', async () => {
    const gA = makeGrid(38, -121, 80, 3), gB = makeGrid(38.0002, -121, 80, 3);
    globalThis.isOnline = () => true;
    route({ exportImage: resp(new ArrayBuffer(8)) });
    await app.fetch3DEPDEM(gA);
    globalThis.isOnline = () => false;
    const b = await app.fetch3DEPDEM(gB);
    expect(b.demFlat).toBeNull();
  });

  it('a canopy entry whose stored grid does not match is not reused', () => {
    const gA = makeGrid(38, -121, 80, 3), gB = makeGrid(38.0002, -121, 80, 3);
    expect(app._rasterEntryFits(app._rasterGridRef(gA), gA)).toBe(true);
    expect(app._rasterEntryFits(app._rasterGridRef(gA), gB)).toBe(false);
    expect(app._rasterEntryFits({ canopyArr: [] }, gA)).toBe(false); // legacy: no spatial metadata
  });
});

// ============================================================================
describe('D14 — solar events are requested for the LOCAL day', () => {
  it('8 p.m. Sept 22 in Los Angeles (03:00Z Sept 23) requests 2026-09-22 and shows the date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T03:00:00Z'));
    const realRO = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function () {
      return Object.assign({}, realRO.call(this), { timeZone: 'America/Los_Angeles' });
    });
    try {
      const r = { sunrise: '2026-09-22T14:00:00+00:00', sunset: '2026-09-23T02:00:00+00:00', solar_noon: '2026-09-22T20:00:00+00:00',
        civil_twilight_begin: '2026-09-22T13:30:00+00:00', civil_twilight_end: '2026-09-23T02:30:00+00:00',
        nautical_twilight_begin: '2026-09-22T13:00:00+00:00', nautical_twilight_end: '2026-09-23T03:00:00+00:00' };
      route({ 'api.sunrise-sunset.org': resp({ status: 'OK', results: r }) });
      await app.fetchSunMoon(38, -121);
      expect(globalThis.fetch.mock.calls[0][0]).toMatch(/date=2026-09-22/);
      expect(text('astDayWindow')).toMatch(/Sep 22/);
      expect(cacheStore['sunrise_' + areaKey(38, -121)].data.date).toBe('2026-09-22');
    } finally {
      vi.useRealTimers();
    }
  });

  it("another day's cached events are labeled, not silently used as today's", async () => {
    cacheStore['sunrise_' + areaKey(38, -121)] = { timestamp: Date.now() - 2 * 86400e3, status: 'expired',
      data: { status: 'OK', date: '2000-01-01', results: { sunrise: '2000-01-01T15:00:00Z', sunset: '2000-01-02T01:00:00Z',
        civil_twilight_begin: '2000-01-01T14:30:00Z', civil_twilight_end: '2000-01-02T01:30:00Z' } } };
    route({ 'api.sunrise-sunset.org': resp({}, { status: 503 }) });
    await app.fetchSunMoon(38, -121);
    expect(text('astDayWindow')).toMatch(/NOT TODAY/);
    expect(text('astSunrise')).toMatch(/Jan 1/);
    expect(text('astroStatus')).toMatch(/Jan 1/);
  });
});

// ============================================================================
// Follow-up bugs: an old METAR accepted as current, forecast times read in the
// device zone instead of the mission zone, and a wrong-signed declination.
describe('an old METAR is never accepted as a current observation', () => {
  const H = 3600e3;
  it('a successful response with a 36-hour-old observation → no gate, stale advisory, never NOMINAL', async () => {
    route(metarRoutes({ station: 'KOLD', visSm: 10, ceilM: null, when: Date.now() - 36 * H }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar).toBeNull();
    expect(S.metarUnverified).toBe(true);
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(advisories().some(a => /UNVERIFIED — Latest KOLD observation is 36 h old/.test(a))).toBe(true);
    expect(text('wxFlightCat')).toMatch(/UNKNOWN/);
    expect(cacheStore['metar_' + areaKey(A.lat, A.lng)]).toBeUndefined();
  });

  it('a 36-hour-old LOW observation does not gate as if current either', async () => {
    route(metarRoutes({ station: 'KOLD', visSm: 1, ceilM: 100, when: Date.now() - 36 * H }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(limits()).toHaveLength(0);
    expect(advisories().some(a => /36 h old/.test(a))).toBe(true);
  });

  it('an observation 2.5 h old still gates, but is reported unverified', async () => {
    route(metarRoutes({ station: 'KLAG', visSm: 1, ceilM: 100, when: Date.now() - 2.5 * H }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(limits()).toHaveLength(2);
    expect(advisories().some(a => /Latest KLAG observation is 2\.5 h old/.test(a))).toBe(true);
    expect(text('wxCeiling')).toMatch(/stale: Verify/);
  });

  it('a stale nearest station is skipped for a current one further out', async () => {
    const r = metarRoutes({ station: 'KOLD', visSm: 10, ceilM: null, when: Date.now() - 36 * H });
    const cur = metarRoutes({ station: 'KNEW', visSm: 10, ceilM: null });
    r['gridpoints/KOLD/stations'] = resp({ features: [
      { properties: { stationIdentifier: 'KOLD' }, geometry: { coordinates: [-121, 38] } },
      { properties: { stationIdentifier: 'KNEW' }, geometry: { coordinates: [-121.1, 38.1] } }] });
    r['stations/KNEW/observations/latest'] = cur['stations/KNEW/observations/latest'];
    route(r);
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(S.metar.station).toBe('KNEW');
    expect(S.metarUnverified).toBe(false);
    expect(advisories().some(a => /UNVERIFIED/.test(a))).toBe(false);
  });

  it('a current observation that ages past the limits while the panel is open stops gating', async () => {
    route(metarRoutes({ station: 'KTEST', visSm: 1, ceilM: 100 }));
    await app.fetchAviationWeather(A, bbox(A.lat, A.lng));
    expect(limits()).toHaveLength(2);
    S.metar.obsTime = Date.now() - 5 * H;          // no refresh for five hours
    expect(limits()).toHaveLength(0);
    expect(advisories().some(a => /latest KTEST observation is 5\.0 h old/.test(a))).toBe(true);
  });
});

describe('forecast hours are absolute instants in the mission zone', () => {
  const t0 = Date.parse('2026-09-22T19:00:00Z');   // 15:00 EDT, 12:00 PDT
  const wxBody = time => ({
    timezone: 'America/New_York', timezone_abbreviation: 'GMT-4', utc_offset_seconds: -14400,
    current: { temperature_2m: 65, visibility: 16000, wind_speed_10m: 5, wind_gusts_10m: 5, wind_direction_10m: 0, weather_code: 0, precipitation_probability: 0 },
    hourly: { time, temperature_2m: [65, 90], wind_speed_10m: [5, 5], wind_gusts_10m: [5, 5], wind_direction_10m: [0, 0] },
  });
  async function load(time) {
    route({ 'api.open-meteo.com': resp(wxBody(time)), 'air-quality-api': resp({ current: { us_aqi: 10 } }), 'swpc.noaa.gov': resp([]) });
    await app.fetchWeather(A.lat, A.lng);
  }

  it('requests unix timestamps and stores UTC instants', async () => {
    await load([t0 / 1000, t0 / 1000 + 3600]);
    expect(globalThis.fetch.mock.calls.some(c => /api\.open-meteo\.com\/v1\/forecast.*timeformat=unixtime/.test(c[0]))).toBe(true);
    expect(S.wx.hourly.time[1]).toBe('2026-09-22T20:00:00.000Z');
    expect(S.wx.missionTz).toBe('America/New_York');
  });

  it('legacy mission-local strings are converted with the response offset', async () => {
    await load(['2026-09-22T15:00', '2026-09-22T16:00']);
    expect(S.wx.hourly.time[1]).toBe('2026-09-22T20:00:00.000Z');
  });

  it('the briefing states the forecast hour in mission-local time, with the right UTC instant', async () => {
    await load([t0 / 1000, t0 / 1000 + 3600]);
    S.timeIdx = 1;
    const txt = app.buildBriefingText();
    expect(txt).toMatch(/Weather valid: FORECAST \+1h — Sep 22, 2026, 16:00 EDT mission local/);
    expect(txt).toMatch(/\(2026-09-22T20:00:00\.000Z\)/);
  });
});

describe('magnetic declination comes from WMM2025', () => {
  it('California (38, −121): ~12.6° E (BGS reference 12.647° E), even when sun times fail', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    try {
      route({ 'api.sunrise-sunset.org': resp({}, { status: 503 }) });
      await app.fetchSunMoon(38, -121);
      expect(text('astMagDec')).toBe('12.6° E (WMM2025)');
    } finally { vi.useRealTimers(); }
  });
});
