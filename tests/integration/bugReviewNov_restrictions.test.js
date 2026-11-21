// Regression tests for the Nov 2026 bug review: section freshness across
// refreshes (H1), TFR / NOTAM honesty (H3, H4), airspace readouts (H5),
// observed ceiling (H6, G02), markSection lifecycle (M14), the offline
// forecast (M15), area teardown and guards (M16), assessment (M18) and Ops
// bird-water / cell readouts (M19).
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
  polygon: () => leafletLayer(), circle: () => leafletLayer(), geoJSON: () => leafletLayer(), tileLayer: () => leafletLayer(),
  Browser: { mobile: false },
}, { get(t, p) { return p in t ? t[p] : chain(); } });

const app = require('../../sar-preflight.js');
const { S, computeAssessment, computeAirspace, markSection, SECTION_CELLS, SECTION_DEFS, UNKNOWN_CELL_TEXT } = app;
const { formatAge } = require('../../sar-preflight-offline.js');

const APP_BODY = (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
  return html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');
})();

function resp(body, { status = 200, sw = null } = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: { get: n => (sw != null && n === 'X-SAR-SW-Cache') ? String(sw) : null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => body };
}
const fc = features => ({ type: 'FeatureCollection', features });
const bbox = (lat, lng, d = 0.02) => ({
  getSouthWest: () => ({ lat: lat - d, lng: lng - d }), getNorthEast: () => ({ lat: lat + d, lng: lng + d }),
  getCenter: () => ({ lat, lng }),
  getSouth: () => lat - d, getNorth: () => lat + d, getWest: () => lng - d, getEast: () => lng + d,
});
const areaLayer = (lat, lng, d = 0.02) => ({
  getBounds: () => bbox(lat, lng, d),
  getLatLngs: () => [[{ lat: lat - d, lng: lng - d }, { lat: lat - d, lng: lng + d }, { lat: lat + d, lng: lng + d }, { lat: lat + d, lng: lng - d }]],
});
const A = { lat: 38.683, lng: -121.024 }, B = { lat: 39, lng: -120.306 };
const text = id => document.getElementById(id).textContent;
const hasClass = (id, c) => document.getElementById(id).classList.contains(c);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const T0 = Math.floor(Date.now() / 3600000) * 3600;
const wxBody = tempF => ({
  utc_offset_seconds: -28800, timezone: 'America/Los_Angeles',
  current: { time: T0, temperature_2m: tempF, dew_point_2m: tempF - 10, visibility: 16000, surface_pressure: 950,
    relative_humidity_2m: 40, precipitation_probability: 0, weather_code: 0, wind_speed_10m: 5, wind_gusts_10m: 6, wind_direction_10m: 180 },
  hourly: { time: [T0, T0 + 3600], temperature_2m: [tempF, tempF + 1], wind_speed_10m: [5, 5], wind_direction_10m: [180, 180] },
});
const aqiBody = { current: { us_aqi: 20, pm2_5: 3, pm10: 5, ozone: 40 } };
const kpBody = [['time_tag', 'kp'], [new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' '), '2.00']];
const demBody = m => ({ samples: Array.from({ length: 25 }, (_, i) => ({ locationId: i, value: String(m) })) });

function route(table) {
  globalThis.fetch = vi.fn((url, opts) => {
    for (const [needle, h] of Object.entries(table)) {
      if (String(url).includes(needle)) return typeof h === 'function' ? h(url, opts) : Promise.resolve(h);
    }
    return Promise.resolve(resp({}, { status: 404 }));
  });
}
const quiet = extra => Object.assign({
  'air-quality-api': resp(aqiBody), 'swpc': resp(kpBody), 'interpreter': resp({ elements: [] }),
  'alerts/active': resp({ features: [] }), 'getSamples': resp(demBody(600)),
}, extra);
const faaAll = over => Object.assign({ classAirspace: fc([]), sua: fc([]), tfrs: fc([]), laanc: fc([]), nsRestrictions: fc([]), prohibited: fc([]) }, over);
const nominal = () => {
  S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
  S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
  S.faaAirspace = faaAll();
};

beforeEach(() => {
  document.body.innerHTML = APP_BODY;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
  S.map = new Proxy({ hasLayer: () => false, addLayer() {}, removeLayer() {} }, { get(t, p) { return p in t ? t[p] : chain(); } });
  S.mapLayers = {};
  S.drawnItems = mockLayerGroup();
  S.sectionMeta = {}; S.dataSourceErrors = {}; S._dataArea = {};
  S.wx = {}; S.wxAreaKey = null; S.wind = {}; S.aqi = null; S.aqiAreaKey = null; S.elev = {};
  S.protectedAreas = null; S.faaObstacles = null; S.nearbyAirports = []; S.faaAirspace = null;
  S.nwsAlerts = []; S.nwsAlertsUnverified = false; S.nwsAlertsSource = null; S.nwsAlertsAt = null;
  S.tfrs = []; S.importedNotams = []; S.activeFires = []; S.adsbAircraft = [];
  S.tfrImportMeta = null; S.notamFetchMeta = null; S.restrictionCacheExpired = null;
  S.kp = null; S.kpForecast = null; S.metar = null; S.metarUnverified = false; S.metarUnverifiedReason = null;
  S.fireDanger = null; S.fireDataUnverified = false; S.autoCheck = null;
  S.landStatus = null; S.cellStatus = null; S.cellCoverage = null; S.hmsSmoke = null; S.avalanche = null; S.publicLands = null;
  S.timeIdx = 0; S.lzs = []; S.assessment = null; S.radarAnim = null;
  S.areaType = 'POLYGON'; S.activeTab = 'wx';
  S.areaCenter = A; S.areaBounds = bbox(A.lat, A.lng); S.currentArea = areaLayer(A.lat, A.lng);
  S._processedAreaKey = null; S._areaAwaiting = null;
  S.viewsheds = []; S.response = null;
  globalThis.cacheApiResponse = vi.fn(async () => {});
  globalThis.getCachedApiResponse = vi.fn(async () => null);
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  ['cacheApiResponse', 'getCachedApiResponse', 'setLastDataTimestamp', 'areaKey', 'formatAge', 'fetch', 'isOnline', '_lastDataTimestamp']
    .forEach(k => delete globalThis[k]);
  S.currentArea = null; S.areaCenter = null; S._areaAwaiting = null; S._processedAreaKey = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ============================================================================
describe('H1 — a refresh of the SAME area keeps its freshness', () => {
  it('a failed weather refresh flags the values stale instead of blanking them UNKNOWN', async () => {
    const layer = areaLayer(B.lat, B.lng);
    route(quiet({ 'api.open-meteo.com/v1/forecast': resp(wxBody(31)) }));
    await app.processArea(layer, 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe('31°F');

    route(quiet({ 'api.open-meteo.com/v1/forecast': resp({}, { status: 503 }) }));
    await app.processArea(layer, 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe('31°F (stale: Verify)');
    expect(hasClass('wxTemp', 'amber')).toBe(true);
    expect(S.sectionMeta.weather.status).toBe('error');
  });

  it('a NEW area resets area freshness but keeps the global Kp line and view-based errors', async () => {
    S.sectionMeta.spaceWx = { status: 'live', updatedAt: Date.now() };
    S.sectionMeta.weather = { status: 'live', updatedAt: Date.now() };
    S.dataSourceErrors = { 'Old Area Source': { message: 'x' }, Canopy: { message: 'y' } };
    S._processedAreaKey = 'the-previous-area';
    route(quiet({ 'api.open-meteo.com/v1/forecast': () => new Promise(() => {}) }));
    app.processArea(areaLayer(B.lat, B.lng), 'polygon').catch(() => {});
    await flush();
    expect(S.sectionMeta.spaceWx && S.sectionMeta.spaceWx.status).toBe('live');
    expect(S.sectionMeta.weather).toBeUndefined();
    expect(S.dataSourceErrors['Old Area Source']).toBeUndefined();
    expect(S.dataSourceErrors.Canopy).toBeTruthy();
    app.invalidateAreaRequests();
  });
});

// ============================================================================
describe('H3 — live TFR / NOTAM honesty', () => {
  it('a malformed 200 TFR body is a failed check, and keeps the previous live set', async () => {
    S.tfrs = [{ id: 'OLD', _live: true, polygons: [] }];
    route({ '/tfr/geoserver': resp({ status: 'ERROR' }) });
    await app.fetchLiveTFRs(S.areaBounds);
    expect(S.sectionMeta.tfr.status).toBe('error');
    expect(S.dataSourceErrors.TFR.message).toMatch(/malformed/);
    expect(S.tfrs.map(t => t.id)).toEqual(['OLD']);
    expect(text('notamStatus')).not.toMatch(/NO TFR \(LIVE\)/);
  });

  it('a truncated NOTAM search is incomplete — listed, flagged, not cached as complete', async () => {
    route({ '/notam?': resp({ notamList: [{ facilityDesignator: 'SAC', notamNumber: '01/234', keyword: 'OBST',
      traditionalMessage: '!SAC 01/234 OBST TOWER', mapPointer: 'POINT(-121.0 38.68)' }], truncated: true }) });
    await app.fetchNotams(A.lat, A.lng, 20);
    expect(S.importedNotams.length).toBe(1);
    expect(S.sectionMeta.notam.status).toBe('error');
    expect(S.sectionMeta.notam.partial).toBe(true);
    expect(S.dataSourceErrors.NOTAM.message).toMatch(/incomplete/);
    expect(globalThis.cacheApiResponse.mock.calls.some(c => c[0] === 'tfr_import')).toBe(false);

    // A later complete search is a plain LIVE result again (partial does not stick).
    route({ '/notam?': resp({ notamList: [], truncated: false }) });
    await app.fetchNotams(A.lat, A.lng, 20);
    expect(S.sectionMeta.notam.status).toBe('live');
    expect(S.sectionMeta.notam.partial).toBeUndefined();
  });

  it('offline before the check: both legs are failures and the manual-update notice shows', async () => {
    globalThis.isOnline = () => false;
    await app.fetchLiveRestrictions(A, S.areaBounds);
    expect(S.autoCheck.state).toBe('error');
    expect(S.sectionMeta.tfr.status).toBe('error');
    expect(S.sectionMeta.notam.status).toBe('error');
    expect(document.getElementById('notamManualNotice').style.display).toBe('');
    expect(text('notamStatus')).toBe('CHECK FAILED');
  });

  it('connectivity lost between the legs: the NOTAM leg records its failure (never CHECKED)', async () => {
    let online = true;
    globalThis.isOnline = () => online;
    route({ '/tfr/geoserver': () => { online = false; return Promise.resolve(resp(fc([]))); } });
    await app.fetchLiveRestrictions(A, S.areaBounds);
    expect(S.autoCheck.tfrOk).toBe(true);
    expect(S.autoCheck.notamOk).toBe(false);
    expect(S.autoCheck.state).toBe('error');
    expect(text('notamStatus')).toBe('CHECK FAILED');
  });
});

// ============================================================================
describe('H4 — renderNotamsTab IndexedDB hydration', () => {
  const cachedRec = () => ({ status: 'fresh', timestamp: Date.now() - 600000,
    data: { tfrs: [{ id: 'CACHED-TFR', polygons: [] }], notams: [{ id: 'CACHED-NOTAM', polygons: [] }], meta: { fileName: 'live' } } });

  it('an area switch during the IndexedDB read drops the old area\'s copy', async () => {
    let release;
    globalThis.getCachedApiResponse = vi.fn(() => new Promise(r => { release = r; }));
    const p = app.renderNotamsTab(A.lat, A.lng);
    app.invalidateAreaRequests(); // another area (or a clear) took over
    release(cachedRec());
    await p;
    expect(S.tfrs).toEqual([]);
    expect(S.importedNotams).toEqual([]);
  });

  it('a live check that found nothing is not overwritten by a slower cached copy', async () => {
    markSection('tfr', { status: 'live', updatedAt: Date.now(), error: null });
    markSection('notam', { status: 'live', updatedAt: Date.now(), error: null });
    globalThis.getCachedApiResponse = vi.fn(async () => cachedRec());
    await app.renderNotamsTab(A.lat, A.lng);
    expect(S.tfrs).toEqual([]);
    expect(S.importedNotams).toEqual([]);
  });

  it('does not repaint the airspace cells (they belong to the FAA / airport fetches)', async () => {
    app._resetPanelForNewArea();
    const before = [text('airClass'), text('airNearAirport')]; // UPDATING… while a new area loads
    await app.renderNotamsTab(A.lat, A.lng);
    expect([text('airClass'), text('airNearAirport')]).toEqual(before);
    expect(text('airClass')).not.toMatch(/Class G/);
    expect(text('airNearAirport')).not.toMatch(/None found/);
  });
});

// ============================================================================
describe('H5 — airspace readouts', () => {
  it('a failed airport lookup stays UNKNOWN when FAA airspace answers later', () => {
    markSection('airspace', { source: 'airports', status: 'error', error: 'Overpass down' });
    expect(text('airNearAirport')).toBe(UNKNOWN_CELL_TEXT);
    S.faaAirspace = faaAll();
    computeAirspace(A.lat, A.lng);
    expect(text('airNearAirport')).toBe(UNKNOWN_CELL_TEXT);
    expect(text('airHeliports')).toBe(UNKNOWN_CELL_TEXT);
  });

  it('an SW offline-fallback answer is labeled cached per layer', async () => {
    route({ 'FeatureServer': () => Promise.resolve(resp(fc([]), { sw: Date.now() - 3600e3 })) });
    await app.fetchFAAairspace(S.areaBounds);
    expect(S.faaAirspace.sua._cachedAt).toBeGreaterThan(0);
    expect(text('airMOA')).toBe('None (cached)');
    expect(hasClass('airMOA', 'green')).toBe(false);
  });

  it('the full IndexedDB fallback is labeled cached per layer', async () => {
    route({ 'FeatureServer': () => Promise.resolve(resp({}, { status: 503 })) });
    globalThis.getCachedApiResponse = vi.fn(async ns => ns === 'faa_airspace'
      ? { status: 'stale', timestamp: Date.now() - 7200e3, data: faaAll() } : null);
    await app.fetchFAAairspace(S.areaBounds);
    expect(text('airMOA')).toBe('None (cached)');
    expect(text('airClass')).toMatch(/\(cached\)/);
  });

  it('a failed LAANC layer reads UNKNOWN, not "400 ft AGL"', () => {
    S.faaAirspace = faaAll({ classAirspace: fc([{ properties: { CLASS: 'D', IDENT: 'KMCC', LOWER_VAL: 0 } }]),
      laanc: { type: 'FeatureCollection', features: [], _unavailable: true } });
    computeAirspace(A.lat, A.lng);
    expect(text('airLAANCAlt')).toBe(UNKNOWN_CELL_TEXT);
  });

  it('a Class E SURFACE area needs authorization; a 700 ft Class E floor does not', () => {
    S.faaAirspace = faaAll({ classAirspace: fc([
      { properties: { CLASS: 'E', IDENT: 'E5', LOCAL_TYPE: 'CLASS_E5', LOWER_VAL: 700 } },
      { properties: { CLASS: 'E', IDENT: 'KXYZ', LOCAL_TYPE: 'CLASS_E2', LOWER_VAL: 0 } },
    ]) });
    computeAirspace(A.lat, A.lng);
    expect(text('airLAANC')).toBe('Yes — required');
    expect(text('airClass')).toMatch(/surface area/);
    expect(hasClass('airLAANC', 'amber')).toBe(true);

    S.faaAirspace = faaAll({ classAirspace: fc([{ properties: { CLASS: 'E', IDENT: 'E5', LOCAL_TYPE: 'CLASS_E5', LOWER_VAL: 700 } }]) });
    computeAirspace(A.lat, A.lng);
    expect(text('airLAANC')).toBe('N/A (Class G)');
  });

  it('a verified-empty class layer is Class G — not the airport-radius guess', () => {
    S.nearbyAirports = [{ icao: 'KSMF', name: 'Sacramento International', type: 'large_airport', lat: A.lat + 0.01, lng: A.lng }];
    S.faaAirspace = faaAll();
    computeAirspace(A.lat, A.lng);
    expect(text('airClass')).toBe('Class G — Uncontrolled');
  });

  it('the banner flags a Class E surface area without LAANC data, and NSFR sites by Facility', () => {
    nominal();
    S.faaAirspace = faaAll({
      classAirspace: fc([{ properties: { CLASS: 'E', LOCAL_TYPE: 'CLASS_E2', LOWER_VAL: 0 } }]),
      nsRestrictions: fc([{ properties: { Facility: 'Folsom Dam', Base: 'USBR' } }, { properties: null }]),
      tfrs: fc([{ properties: null }]),
    });
    expect(() => computeAssessment()).not.toThrow();
    expect(text('assessText')).toMatch(/Controlled airspace without LAANC data/);
    expect(text('assessText')).toMatch(/NS UAS restriction: Folsom Dam, NS area/);
    computeAirspace(A.lat, A.lng);
    expect(text('airNSRestrict')).toBe('Folsom Dam, NS Restriction');
  });
});

// ============================================================================
describe('H6 / G02 — observed ceiling', () => {
  it('a failed METAR at NOW never shows a green ceiling estimate', () => {
    S.metarUnverified = true;
    app.renderObservedCeiling({ _isNow: true, cloud_cover: 5 });
    expect(text('wxCeiling')).toMatch(/CLR \(est\) · no METAR/);
    expect(hasClass('wxCeiling', 'green')).toBe(false);
    app.renderObservedCeiling({ _isNow: true, cloud_cover: null });
    expect(text('wxCeiling')).toBe(UNKNOWN_CELL_TEXT);
  });

  it('a new area blanks the ceiling and flight category; lightning and fire are weather cells', () => {
    document.getElementById('wxCeiling').textContent = '300 ft (KOLD)';
    document.getElementById('wxFlightCat').textContent = 'LIFR';
    app._resetPanelForNewArea();
    expect(text('wxCeiling')).toBe('--');
    expect(text('wxFlightCat')).toBe('--');
    expect(SECTION_CELLS.weather).toEqual(expect.arrayContaining(['wxLightning', 'wxFire']));
    expect(SECTION_CELLS.fireDanger).not.toContain('wxFire');
  });

  it('the Weather UPDATE also refreshes the METAR', async () => {
    route(quiet({ 'api.open-meteo.com/v1/forecast': resp(wxBody(50)), 'api.weather.gov/points': resp({}, { status: 503 }) }));
    await SECTION_DEFS.weather.fetch(A, S.areaBounds);
    expect(globalThis.fetch.mock.calls.some(c => String(c[0]).includes('api.weather.gov/points'))).toBe(true);
  });

  const obs = (ts) => resp({ properties: { timestamp: new Date(ts).toISOString(), rawMessage: '',
    cloudLayers: [{ amount: 'FEW', base: { value: 3000 } }], visibility: { value: 16093 } } });
  const stationsRoute = (ids, obsById) => ({
    'observations/latest': url => Promise.resolve(obsById[ids.find(id => url.includes('/' + id + '/'))]),
    'api.weather.gov/points': resp({ properties: { observationStations: 'https://api.weather.gov/gridpoints/X/stations' } }),
    'gridpoints/X/stations': resp({ features: ids.map(id => ({ properties: { stationIdentifier: id, name: id }, geometry: { coordinates: [A.lng, A.lat] } })) }),
  });

  it('a future-dated report cannot displace this area\'s valid held observation', async () => {
    S.metar = { ok: true, station: 'KHELD', ceilingFt: 100, visSm: 1, fltCat: 'LIFR', obsTime: Date.now() - 30 * 60e3 };
    app._setDataArea('metar', globalThis.areaKey(A.lat, A.lng));
    route(stationsRoute(['KFUT'], { KFUT: obs(Date.now() + 12 * 3600e3) }));
    await app.fetchAviationWeather(A, S.areaBounds);
    expect(S.metar && S.metar.station).toBe('KHELD');
    expect(S.metarUnverified).toBe(true);
  });

  // Real station list for a foothill area (Nov 2026): seven RAWS / mesonet
  // sites, which never report sky condition or visibility, sit ahead of the
  // first airport. The walk used to stop after four and report "no station".
  it('asks the 4 nearest stations, then the nearest airport, past fire-weather sites with no sky/visibility', async () => {
    const raws = () => resp({ properties: { timestamp: new Date().toISOString(), rawMessage: '', cloudLayers: [], visibility: { value: null } } });
    const ids = ['BDMC1', 'OWNC1', 'BENC1', 'HLLC1', 'PLTC1', 'FSHC1', 'MTZC1', 'KAUN'];
    const byId = {}; ids.forEach(id => { byId[id] = id === 'KAUN' ? obs(Date.now() - 73 * 60e3) : raws(); });
    route(stationsRoute(ids, byId));
    await app.fetchAviationWeather(A, S.areaBounds);
    expect(S.metar && S.metar.station).toBe('KAUN');
    expect(S.metarUnverified).toBe(false);
    expect(S.dataSourceErrors['Aviation Wx']).toBeUndefined();
    // The four nearest first, then straight to the airport (not the RAWS between).
    const asked = globalThis.fetch.mock.calls.map(c => String(c[0])).filter(u => u.includes('observations/latest'))
      .map(u => u.match(/stations\/([^/]+)\//)[1]);
    expect(asked).toEqual(['BDMC1', 'OWNC1', 'BENC1', 'HLLC1', 'KAUN']);
    expect(text('wxCeiling')).toMatch(/\(KAUN, <1 nm\)/);
    expect(text('wxObsVis')).toMatch(/^10\+ SM \(KAUN, <1 nm\)/);
  });

  it('each reading comes from the closest station reporting it, with its distance', async () => {
    // B reports visibility only (no ceilometer); C, farther, reports both.
    const at = (id, lat, lng) => ({ properties: { stationIdentifier: id, name: id }, geometry: { coordinates: [lng, lat] } });
    const now = new Date(Date.now() - 20 * 60e3).toISOString();
    route({
      'api.weather.gov/points': resp({ properties: { observationStations: 'https://api.weather.gov/gridpoints/X/stations' } }),
      'gridpoints/X/stations': resp({ features: [at('KVIS', A.lat + 0.05, A.lng), at('KBTH', A.lat + 0.3, A.lng)] }),
      'stations/KVIS/observations/latest': resp({ properties: { timestamp: now, cloudLayers: [], visibility: { value: 4828 } } }),
      'stations/KBTH/observations/latest': resp({ properties: { timestamp: now,
        cloudLayers: [{ amount: 'OVC', base: { value: 300 } }], visibility: { value: 16093 } } }),
    });
    await app.fetchAviationWeather(A, S.areaBounds);
    const m = S.metar;
    expect(m.visSrc.station).toBe('KVIS');          // closest visibility: 3 SM
    expect(m.visSm).toBeCloseTo(3, 1);
    expect(m.ceilingSrc.station).toBe('KBTH');      // closest sky condition: OVC 984 ft
    expect(m.ceilingFt).toBe(984);
    expect(m.fltCat).toBe('IFR');
    expect(text('wxCeiling')).toMatch(/^984 ft \(KBTH, 18 nm\)/);
    expect(text('wxObsVis')).toMatch(/^3 SM \(KVIS, 3\.0 nm\)/);
    expect(app.metarSourcesText(m)).toBe('ceiling KBTH, 18 nm; visibility KVIS, 3.0 nm');
  });

  it('when nothing usable comes back, the error names each station, its distance and why', async () => {
    const empty = resp({ properties: { timestamp: new Date().toISOString(), cloudLayers: [], visibility: { value: null } } });
    route(stationsRoute(['BENC1', 'KXYZ'], { BENC1: empty, KXYZ: resp({}, { status: 503 }) }));
    await app.fetchAviationWeather(A, S.areaBounds);
    const msg = S.dataSourceErrors['Aviation Wx'].message;
    expect(msg).toMatch(/No nearby station reported/);
    expect(msg).toContain('KXYZ (<1 nm): HTTP 503');
    expect(msg).toContain('BENC1 (<1 nm): no sky condition or visibility reported');
    expect(globalThis.describeSourceError(msg).headline).toMatch(/^No usable report/);
  });

  it('station plan: the 4 nearest of any kind, then up to 4 airports beyond them', () => {
    const f = id => ({ properties: { stationIdentifier: id } });
    const plan = app.metarStationPlan(['BENC1', 'KPVF', 'C1234', 'PLTC1', 'MTZC1', 'KAUN', 'D9999', 'PAJN', 'KMHR', 'KSAC', 'KLHM'].map(f));
    expect(plan.nearest.map(x => x.properties.stationIdentifier)).toEqual(['BENC1', 'KPVF', 'C1234', 'PLTC1']);
    expect(plan.airports.map(x => x.properties.stationIdentifier)).toEqual(['KAUN', 'PAJN', 'KMHR', 'KSAC']);
  });

  it('a valid 2.5 h old report beats a future-dated one as the retained candidate', async () => {
    route(stationsRoute(['KFUT', 'KOLD'], { KFUT: obs(Date.now() + 12 * 3600e3), KOLD: obs(Date.now() - 2.5 * 3600e3) }));
    await app.fetchAviationWeather(A, S.areaBounds);
    expect(S.metar && S.metar.station).toBe('KOLD');
  });
});

// ============================================================================
describe('M14 — markSection lifecycle and cached labels', () => {
  it('a real value written over UNKNOWN drops the red; a value colored by its renderer keeps its color', () => {
    app.markCellsUnknown(['terrWater', 'wxVis']);
    app.setText('terrWater', '3 water features');
    expect(hasClass('terrWater', 'red')).toBe(false);
    app.setText('wxVis', '0.5 mi'); app.setColor('wxVis', 'red');
    expect(hasClass('wxVis', 'red')).toBe(true);
  });

  it('prior data is judged from the state BEFORE the patch', () => {
    markSection('water', { status: 'live', updatedAt: Date.now() - 60000, error: null });
    document.getElementById('terrWater').textContent = '4 water features';
    markSection('water', { status: 'error', error: 'x', updatedAt: null });
    expect(text('terrWater')).toBe('4 water features (stale: Verify)');
  });

  it('a cached copy replaces the live stamp, and live replaces the cached one', () => {
    markSection('water', { status: 'live', updatedAt: 1000, error: null });
    markSection('water', { status: 'cached', cachedAt: 500, error: 'x' });
    expect(S.sectionMeta.water.updatedAt).toBeNull();
    markSection('water', { status: 'live', updatedAt: 2000, error: null });
    expect(S.sectionMeta.water.cachedAt).toBeNull();
  });

  it('a fresh IndexedDB copy is badged cached, not a pulsing expired', async () => {
    route({ 'sunrise-sunset': resp({}, { status: 503 }) });
    const r = { sunrise: '2026-11-20T15:00:00Z', sunset: '2026-11-21T00:50:00Z', civil_twilight_begin: '2026-11-20T14:30:00Z',
      civil_twilight_end: '2026-11-21T01:20:00Z', nautical_twilight_begin: '2026-11-20T14:00:00Z', nautical_twilight_end: '2026-11-21T01:50:00Z',
      solar_noon: '2026-11-20T19:55:00Z' };
    const today = localDateISO(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    globalThis.getCachedApiResponse = vi.fn(async ns => ns === 'sunrise'
      ? { status: 'fresh', timestamp: Date.now() - 600000, data: { status: 'OK', results: r, date: today } } : null);
    await app.fetchSunMoon(A.lat, A.lng);
    expect(document.getElementById('astroStatus').className).toMatch(/cached/);
    // Every cell the fallback can fill is filled — the local ones included.
    ['astNauticalAM', 'astNauticalPM', 'astSolarNoon', 'astSunAz', 'astSunEl', 'astMoonPhase', 'astMoonIllum', 'astNightOps', 'astShadow']
      .forEach(id => { expect(text(id), id).not.toBe(UNKNOWN_CELL_TEXT); expect(hasClass(id, 'red'), id).toBe(false); });
    expect(S.astro.moonPhase).toBeTruthy();
  });
});

// ============================================================================
describe('M15 — an offline-fallback forecast is current conditions only', () => {
  it('the SW copy\'s hourly forecast is not put on the time bar', async () => {
    route(quiet({ 'api.open-meteo.com/v1/forecast': resp(wxBody(40), { sw: Date.now() - 2 * 86400e3 }) }));
    await app.fetchWeather(A.lat, A.lng);
    expect(S.wx.temperature_2m).toBe(40);
    expect(S.wx.hourly).toBeUndefined();
    expect(S.sectionMeta.weather.status).toBe('cached');
  });
});

// ============================================================================
describe('M16 — area teardown, section defs and guards', () => {
  it('_dropAreaData forgets the live restriction stamps but keeps a manual import\'s', () => {
    S.tfrImportMeta = { fileName: 'live', importedAtMs: 1 };
    S.notamFetchMeta = { fetchedAtMs: 1, source: 'live' };
    S.restrictionCacheExpired = { atMs: 1 };
    app._dropAreaData();
    expect(S.tfrImportMeta).toBeNull();
    expect(S.notamFetchMeta).toBeNull();
    expect(S.restrictionCacheExpired).toBeNull();
    S.tfrImportMeta = { fileName: 'oakland.geojson', importedAtMs: 1 };
    app._dropAreaData();
    expect(S.tfrImportMeta.fileName).toBe('oakland.geojson');
  });

  it('clearArea drops the area freshness, bounds and panel values', () => {
    markSection('weather', { status: 'live', updatedAt: Date.now(), error: null });
    S.sectionMeta.spaceWx = { status: 'live', updatedAt: Date.now() };
    document.getElementById('wxTemp').textContent = '55°F';
    app.clearArea();
    expect(S.sectionMeta.weather).toBeUndefined();
    expect(S.sectionMeta.spaceWx).toBeTruthy();
    expect(S.areaBounds).toBeNull();
    expect(text('wxTemp')).toBe('--');
  });

  it('Obstacles UPDATE recomputes the banner too; zero dams clears an earlier UNKNOWN', async () => {
    expect(SECTION_DEFS.obstacles.computes).toBe('both');
    app.markCellsUnknown(['terrHwy']);
    route({ 'FeatureServer': () => Promise.resolve(resp(fc([]))) });
    await app.fetchProtectedAreas(S.areaBounds);
    expect(text('terrHwy')).not.toBe(UNKNOWN_CELL_TEXT);
    expect(hasClass('terrHwy', 'red')).toBe(false);
  });

  it('retryFailedSource does not recompute for an area that was replaced meanwhile', async () => {
    let release;
    route({ 'rainviewer': () => new Promise(r => { release = r; }) });
    document.getElementById('opsFlightTime').textContent = 'untouched';
    const p = app.retryFailedSource('Radar');
    await flush(2);
    app.invalidateAreaRequests();
    release(resp({ radar: { past: [] } }));
    await p;
    expect(text('opsFlightTime')).toBe('untouched');
  });

  it('fetchRadar with no frames leaves the previous animation intact (no orphaned state)', async () => {
    // The radar rewrite removes old layers only AFTER it has new frames, so an
    // empty answer keeps the previous animation and its layers consistent.
    const layer = { options: { opacity: 0.5 }, setOpacity() {} };
    const prev = { playing: false, index: 0, layers: [layer], interval: null, frames: [{ source: 'rainviewer', time: 1, path: '/x' }] };
    S.radarAnim = prev;
    S.map.hasLayer = l => l === layer;
    route({ 'rainviewer': resp({ radar: { past: [] } }) });
    await app.fetchRadar();
    expect(S.radarAnim).toBe(prev);
    expect(S.radarAnim.layers[0]).toBe(layer);
  });
});

// ============================================================================
describe('M18 — DATA STALE is a real advisory', () => {
  it('counts in the badge and is listed in S.assessment.advisories', () => {
    nominal();
    globalThis._lastDataTimestamp = Date.now() - 2 * 3600e3;
    computeAssessment();
    expect(text('assessBadge')).not.toBe('NOMINAL');
    expect(S.assessment.advisories.some(a => /DATA STALE/.test(a))).toBe(true);
  });
});

// ============================================================================
describe('M19 — Ops bird water and the cell readout', () => {
  it('missing terrain / water data is Unknown, never a green "No water features detected"', () => {
    S.elev = {}; S.protectedAreas = null;
    app.computeOpsData({});
    expect(text('opsBirdWater')).toBe('Unknown');
    expect(hasClass('opsBirdWater', 'green')).toBe(false);
  });

  it('NHD streams / lakes in the area count as water', () => {
    S.elev = { center: 5000, min: 4800, max: 5400, range: 600 };
    S.mapLayers.nhd_water = mockLayerGroup(); S.mapLayers.nhd_water.addLayer({});
    markSection('water', { status: 'live', updatedAt: Date.now(), error: null });
    app.computeOpsData({});
    expect(text('opsBirdWater')).toMatch(/Water\/wetland nearby/);
  });

  it('with terrain and a checked, empty NHD lookup it says no water', () => {
    S.elev = { center: 5000, min: 4800, max: 5400, range: 600 };
    markSection('water', { status: 'live', updatedAt: Date.now(), error: null });
    app.computeOpsData({});
    expect(text('opsBirdWater')).toBe('No water features detected');
  });

  it('loadCellCoverage refreshes the cell readout and the no-LTE advisory', async () => {
    nominal();
    S.elev = { center: 2000, min: 1900, max: 2100, range: 200 };
    S.cellStatus = null;
    const ring = [[A.lat + 1, A.lng + 1], [A.lat + 1, A.lng + 1.1], [A.lat + 1.1, A.lng + 1.1], [A.lat + 1, A.lng + 1]];
    const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring.map(p => [p[1], p[0]])] } };
    // Region spans the area centre, but the only coverage polygon lies outside it.
    const far = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[A.lng - 1, A.lat - 1], [A.lng - 0.9, A.lat - 1], [A.lng - 0.9, A.lat - 0.9], [A.lng - 1, A.lat - 1]]] } };
    route({ 'data/cell/': resp(fc([feature, far])) });
    await app.loadCellCoverage();
    expect(S.cellStatus && S.cellStatus.inRegion).toBe(true);
    expect(text('terrCell')).toMatch(/No mapped LTE coverage/);
    expect(text('assessText')).toMatch(/outside all mapped carrier LTE coverage/);
  });
});
