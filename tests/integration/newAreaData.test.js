// A NEW operational area starts from nothing. Until v2026.11.19-a every source
// kept the previous area's data until its own fetch answered, so a slow check
// left the old area's warnings, airspace, fires and obstacles in the banner
// and on the map. Now a different area drops all of it, the banner waits for
// the weather and then names every check that has not answered yet.
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
const { S, computeAssessment, _dropAreaData, _areaAwaitingLabels, _areaAwaits, _areaAnswered, _fetchTimed,
  AREA_AWAIT_LABELS, AREA_DATA_LAYERS, AREA_DERIVED_CELLS, WX_TIMEOUT_MS, ELEV_TIMEOUT_MS } = app;
const { formatAge } = require('../../sar-preflight-offline.js');

const APP_BODY = (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
  return html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script[\s\S]*?<\/script>/gi, '');
})();

function resp(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
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
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const T0 = Math.floor(Date.now() / 3600000) * 3600;
const wxBody = tempF => ({
  utc_offset_seconds: -28800, timezone: 'America/Los_Angeles',
  current: { time: T0, temperature_2m: tempF, dew_point_2m: tempF - 10, visibility: 16000, surface_pressure: 950,
    precipitation_probability: 0, weather_code: 0, wind_speed_10m: 5, wind_gusts_10m: 6, wind_direction_10m: 180 },
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
// A fetch handler that parks every request until release(response) is called.
function held() {
  const waiting = [];
  const h = () => new Promise(r => waiting.push(r));
  h.release = r => { waiting.splice(0).forEach(w => w(r)); };
  h.count = () => waiting.length;
  return h;
}

// Everything the previous area (A) left behind.
function seedPreviousArea() {
  S.wx = { temperature_2m: 46, visibility: 16000, precipitation_probability: 0, weather_code: 0 };
  S.wxAreaKey = app._areaKeyOf(A.lat, A.lng);
  S.wind = { maxWind: 5, maxGust: 6 };
  S.aqi = 160; S.aqiAreaKey = S.wxAreaKey;
  S.elev = { center: 1234, min: 1200, max: 1300, range: 100 };
  S.cellStatus = { inRegion: true, count: 0 };
  S.lzs = [{ lat: A.lat, lng: A.lng, score: 0.9 }];
  S.metar = { ok: true, station: 'KO61', ceilingFt: 300, visSm: 1, obsTime: new Date().toISOString() };
  S.metarUnverified = true; S.metarUnverifiedReason = 'old';
  S.nwsAlerts = [{ id: 'a1', event: 'Tornado Warning', severity: 'Severe' }];
  S.nwsAlertsUnverified = true; S.nwsAlertsSource = 'live'; S.nwsAlertsAt = Date.now();
  S.activeFires = [{ name: 'Old Fire', distNm: 0 }];
  S.fireDanger = { ercPct: 95 }; S.fireDataUnverified = true;
  S.faaAirspace = { classAirspace: fc([{ properties: { CLASS: 'C' } }]), sua: fc([]), tfrs: fc([{ properties: { NAME: 'OLD TFR' } }]),
    laanc: fc([]), nsRestrictions: fc([]), prohibited: fc([]) };
  S.nearbyAirports = [{ name: 'Cameron Airpark', lat: 38.684, lng: -120.987 }];
  S.faaObstacles = Object.assign(fc([]), { _unavailable: true });
  S.protectedAreas = { dams: [{}], wilderness: [{}], nationalParks: [] };
  S.wireHazardCounts = { power: 4 }; S.utilityWireCounts = { feeder: 2 }; S.utilityWireInfo = { x: 1 }; S.towerCount = 3;
  S.hmsSmoke = [{ properties: { Density: 'Heavy' }, geometry: null }];
  S.avalanche = [{ properties: { danger_level: 4 }, geometry: null }];
  S.publicLands = [{}]; S.landStatus = { sampled: 10, privateFrac: 1 };
  S.astro = { sunrise: 'x' };
  S.tfrs = [{ id: 'LIVE-TFR', _live: true, polygons: [] }, { id: 'MANUAL-TFR', polygons: [] }];
  S.importedNotams = [{ id: 'LIVE-NOTAM', _live: true, polygons: [] }, { id: 'MANUAL-NOTAM', polygons: [] }];
  S.autoCheck = { state: 'error', ms: Date.now(), tfrOk: false, notamOk: false };
  S._dataArea = { elevation: S.wxAreaKey, nwsAlerts: S.wxAreaKey, fireDanger: S.wxAreaKey, faaAirspace: 'x', metar: S.wxAreaKey };
}

beforeEach(() => {
  document.body.innerHTML = APP_BODY;
  // jsdom has no scrollIntoView; processArea → switchTab calls it on the tab button.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
  S.map = new Proxy({ hasLayer: () => false, addLayer() {}, removeLayer() {} }, { get(t, p) { return p in t ? t[p] : chain(); } });
  S.mapLayers = {};
  S.sectionMeta = {}; S.dataSourceErrors = {}; S._dataArea = {};
  S.wx = {}; S.wxAreaKey = null; S.wind = {}; S.aqi = null; S.aqiAreaKey = null; S.elev = {};
  S.protectedAreas = null; S.faaObstacles = null; S.nearbyAirports = []; S.faaAirspace = null;
  S.nwsAlerts = []; S.nwsAlertsUnverified = false; S.nwsAlertsSource = null; S.nwsAlertsAt = null;
  S.tfrs = []; S.importedNotams = []; S.activeFires = []; S.adsbAircraft = [];
  S.kp = null; S.kpForecast = null; S.metar = null; S.metarUnverified = false; S.metarUnverifiedReason = null;
  S.fireDanger = null; S.fireDataUnverified = false; S.autoCheck = null;
  S.landStatus = null; S.cellStatus = null; S.hmsSmoke = null; S.avalanche = null; S.publicLands = null;
  S.timeIdx = 0; S.lzs = []; S.assessment = null;
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
  ['cacheApiResponse', 'getCachedApiResponse', 'setLastDataTimestamp', 'areaKey', 'formatAge', 'fetch'].forEach(k => delete globalThis[k]);
  S.currentArea = null; S.areaCenter = null; S._areaAwaiting = null; S._processedAreaKey = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================================
describe('_dropAreaData — nothing fetched for an area survives it', () => {
  it('resets every source to "nothing held"', () => {
    seedPreviousArea();
    _dropAreaData();
    expect(S.wx).toEqual({});
    expect(S.wind).toEqual({});
    expect(S.wxAreaKey).toBeNull();
    expect(S.aqi).toBeNull();
    expect(S.elev).toEqual({});
    expect(S.cellStatus).toBeNull();
    expect(S.lzs).toEqual([]);
    expect(S.metar).toBeNull();
    expect(S.metarUnverified).toBe(false);
    expect(S.nwsAlerts).toEqual([]);
    expect(S.nwsAlertsUnverified).toBe(false);
    expect(S.nwsAlertsSource).toBe('checking');
    expect(S.activeFires).toEqual([]);
    expect(S.fireDanger).toBeNull();
    expect(S.fireDataUnverified).toBe(false);
    expect(S.faaAirspace).toBeNull();
    expect(S.nearbyAirports).toEqual([]);
    expect(S.faaObstacles).toBeNull();
    expect(S.protectedAreas).toBeNull();
    expect(S.wireHazardCounts).toEqual({});
    expect(S.utilityWireCounts).toEqual({});
    expect(S.towerCount).toBe(0);
    expect(S.hmsSmoke).toBeNull();
    expect(S.avalanche).toBeNull();
    expect(S.landStatus).toBeNull();
    expect(S.publicLands).toBeNull();
    expect(S.astro).toBeNull();
    expect(S.autoCheck).toBeNull();
    expect(S._dataArea).toEqual({});
  });

  it('drops the live TFR and NOTAM sets but keeps what the pilot imported', () => {
    seedPreviousArea();
    _dropAreaData();
    expect(S.tfrs.map(t => t.id)).toEqual(['MANUAL-TFR']);
    expect(S.importedNotams.map(n => n.id)).toEqual(['MANUAL-NOTAM']);
  });

  it('empties every area map layer, wires included', () => {
    const filled = () => { const g = mockLayerGroup(); g.addLayer({}); g.addLayer({}); return g; };
    AREA_DATA_LAYERS.forEach(id => { S.mapLayers[id] = filled(); });
    Object.keys(WIRE_CATEGORIES).forEach(k => { S.mapLayers['wire_' + k] = filled(); });
    S.mapLayers.observers = filled(); // not area DATA: observers have their own lifecycle
    _dropAreaData();
    AREA_DATA_LAYERS.forEach(id => expect(S.mapLayers[id].getLayers().length, id).toBe(0));
    Object.keys(WIRE_CATEGORIES).forEach(k => expect(S.mapLayers['wire_' + k].getLayers().length, k).toBe(0));
    expect(S.mapLayers.observers.getLayers().length).toBe(2);
  });

  it('the alert and wildfire cards say they are checking — never an all-clear', () => {
    seedPreviousArea();
    document.getElementById('fireDangerCards').innerHTML = '<div>No wildland fire perimeters detected</div>';
    _dropAreaData();
    const alerts = text('alertList');
    expect(alerts).toMatch(/CHECKING ALERTS/);
    expect(alerts).not.toMatch(/NO ACTIVE ALERTS|Tornado/);
    const fire = text('fireDangerCards');
    expect(fire).toMatch(/CHECKING WILDFIRE DATA/);
    expect(fire).not.toMatch(/No wildland fire perimeters detected/);
  });

  it('a failed alert check after that reads UNKNOWN, a live empty one reads clear', async () => {
    _dropAreaData();
    route({ 'alerts/active': resp({}, { status: 503 }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(text('alertList')).toMatch(/ALERT STATUS UNKNOWN/);
    _dropAreaData();
    route({ 'alerts/active': resp({ features: [] }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(text('alertList')).toMatch(/NO ACTIVE ALERTS/);
  });
});

// ============================================================================
describe('checks a new area is still waiting for', () => {
  const nominal = () => {
    S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
    S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
    S.faaAirspace = { classAirspace: fc([]), sua: fc([]), tfrs: fc([]), laanc: fc([]), nsRestrictions: fc([]), prohibited: fc([]) };
  };
  const await_ = names => { S._areaAwaiting = { area: S.currentArea, names: new Set(names) }; };

  it('names every source that feeds the banner', () => {
    expect(Object.keys(AREA_AWAIT_LABELS).sort()).toEqual(['airspace', 'alerts', 'avalanche', 'elevation', 'fire', 'metar',
      'obstacles', 'protectedAreas', 'publicLands', 'restrictions', 'smoke', 'weather']);
  });

  it('with no list nothing is awaited', () => {
    nominal();
    expect(_areaAwaitingLabels()).toEqual([]);
    computeAssessment();
    expect(text('assessBadge')).toBe('NOMINAL');
  });

  it('the banner stays LOADING until the weather has answered', () => {
    nominal();
    await_(['weather', 'alerts']);
    computeAssessment();
    expect(text('assessBadge')).toBe('LOADING');
    expect(text('assessText')).toBe('Loading data for this area…');
    expect(S.assessment).toBeNull();
  });

  it('after the weather it lists what has not been checked yet, and is not NOMINAL', () => {
    nominal();
    await_(['alerts', 'fire', 'restrictions']);
    computeAssessment();
    expect(S.assessment.advisories).toContain('Still loading, not yet checked for this area: TFRs and NOTAMs, NWS alerts, wildfire data');
    expect(text('assessBadge')).not.toBe('NOMINAL');
    expect(S.assessment.level).toBe('CAUTION');
  });

  it('does not also call airspace "UNVERIFIED" while its check is on the way', () => {
    nominal();
    S.faaAirspace = null;
    await_(['airspace']);
    computeAssessment();
    expect(S.assessment.advisories.some(a => /FAA airspace UNVERIFIED/.test(a))).toBe(false);
    expect(S.assessment.advisories.some(a => /Still loading.*FAA airspace/.test(a))).toBe(true);
    // The check ended without data: now it is unverified, in so many words.
    _areaAnswered('airspace');
    expect(S.assessment.advisories.some(a => /FAA airspace UNVERIFIED/.test(a))).toBe(true);
    expect(S.assessment.advisories.some(a => /Still loading/.test(a))).toBe(false);
  });

  it('each answer recomputes the banner and shortens the list', () => {
    nominal();
    await_(['alerts', 'fire']);
    computeAssessment();
    S.nwsAlerts = [{ id: 'w', event: 'Winter Storm Warning', severity: 'Severe' }];
    _areaAnswered('alerts');
    expect(S.assessment.limits).toContain('NWS: Winter Storm Warning');
    expect(S.assessment.advisories).toContain('Still loading, not yet checked for this area: wildfire data');
    _areaAnswered('fire');
    expect(S.assessment.advisories.some(a => /Still loading/.test(a))).toBe(false);
    expect(_areaAwaits('fire')).toBe(false);
  });

  it('an answer for something not awaited changes nothing', () => {
    nominal();
    document.getElementById('assessText').textContent = 'untouched';
    _areaAnswered('alerts');
    _areaAnswered('no-such-check');
    expect(text('assessText')).toBe('untouched');
  });

  it('the list belongs to one area: another area, or none, ignores it', () => {
    nominal();
    await_(['weather', 'alerts']);
    S.currentArea = areaLayer(B.lat, B.lng); // a different layer object
    expect(_areaAwaitingLabels()).toEqual([]);
    computeAssessment();
    expect(text('assessBadge')).toBe('NOMINAL');
    S.currentArea = null;
    expect(_areaAwaits('weather')).toBe(false);
  });

  it('never uses a verdict word', () => {
    nominal();
    await_(['weather']);
    computeAssessment();
    const loading = text('assessBadge') + ' ' + text('assessText');
    await_(['alerts']);
    computeAssessment();
    expect(loading + ' ' + text('assessBadge') + ' ' + text('assessText')).not.toMatch(/\bGO\b|CAUTION|NO-GO/);
  });
});

// ============================================================================
describe('processArea — a different area starts from nothing', () => {
  const quiet = extra => Object.assign({
    'air-quality-api': resp(aqiBody), 'swpc': resp(kpBody), 'interpreter': resp({ elements: [] }),
  }, extra);

  it('drops the previous area, waits for the weather, then names what is still loading', async () => {
    seedPreviousArea();
    S._processedAreaKey = 'the-previous-area';
    const wx = held(), alerts = held(), dem = held();
    route(quiet({ 'api.open-meteo.com/v1/forecast': wx, 'alerts/active': alerts, 'getSamples': dem }));
    const layerB = areaLayer(B.lat, B.lng);
    const done = app.processArea(layerB, 'polygon').catch(() => {});
    await flush();

    // Nothing of area A is left in state or on the panel.
    expect(S.nwsAlerts).toEqual([]);
    expect(S.activeFires).toEqual([]);
    expect(S.elev).toEqual({});
    expect(S.wx).toEqual({});
    expect(S.tfrs.map(t => t.id)).toEqual(['MANUAL-TFR']);
    expect(text('wxTemp')).toBe('UPDATING…');
    expect(text('terrLaunch')).toBe('UPDATING…');
    AREA_DERIVED_CELLS.forEach(id => expect(text(id), id).toBe('--'));
    // The weather has not answered: the banner says so and nothing else.
    expect(text('assessBadge')).toBe('LOADING');
    expect(text('assessText')).toBe('Loading data for this area…');
    expect(text('alertList')).toMatch(/CHECKING ALERTS/);

    wx.release(resp(wxBody(31)));
    await flush();
    expect(text('wxTemp')).toBe('31°F');
    expect(text('assessBadge')).not.toBe('LOADING');
    const mid = text('assessText');
    expect(mid).toMatch(/Still loading, not yet checked for this area: /);
    expect(mid).toMatch(/terrain elevation/);
    expect(mid).toMatch(/NWS alerts/);
    expect(mid).not.toMatch(/Still loading[^|•]*\bweather\b/);
    // …and none of area A's findings.
    expect(mid).not.toMatch(/Tornado|Old Fire|Active TFR|Wilderness Area — UAS|Dam nearby|Hazardous air quality|Controlled airspace|private \/ non-public land/);

    alerts.release(resp({ features: [] }));
    dem.release(resp(demBody(1953.2)));
    await done;
    await flush();
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    expect(text('assessText')).not.toMatch(/Still loading/);
    expect(text('alertList')).toMatch(/NO ACTIVE ALERTS/);
    expect(_areaAwaitingLabels()).toEqual([]);
  });

  it('a refresh of the same area keeps its values and waits for nothing', async () => {
    route(quiet({ 'api.open-meteo.com/v1/forecast': resp(wxBody(31)), 'alerts/active': resp({ features: [] }), 'getSamples': resp(demBody(1953.2)) }));
    const layerB = areaLayer(B.lat, B.lng);
    await app.processArea(layerB, 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe('31°F');
    const before = text('assessText');

    const wx = held(), dem = held();
    route(quiet({ 'api.open-meteo.com/v1/forecast': wx, 'alerts/active': resp({ features: [] }), 'getSamples': dem }));
    const again = app.processArea(layerB, 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe('31°F');
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    expect(text('assessBadge')).not.toBe('LOADING');
    // The same findings, led by the refresh now in flight (DATA SOURCES list).
    expect(text('assessText')).toMatch(/Data sources updating: Weather, Air Quality, Elevation/);
    expect(text('assessText').replace(/ • Data sources updating: [^•]*(?= •)/, '')).toBe(before);
    expect(_areaAwaitingLabels()).toEqual([]);
    wx.release(resp(wxBody(30))); dem.release(resp(demBody(1953.2)));
    await again;
  });

  it('the same centre with other bounds is a new area too (half the sources query by bounds)', async () => {
    route(quiet({ 'api.open-meteo.com/v1/forecast': resp(wxBody(31)), 'alerts/active': resp({ features: [] }), 'getSamples': resp(demBody(1953.2)) }));
    await app.processArea(areaLayer(B.lat, B.lng), 'polygon').catch(() => {});
    await flush();
    expect(text('assessBadge')).not.toBe('LOADING');

    const wx = held();
    route(quiet({ 'api.open-meteo.com/v1/forecast': wx, 'alerts/active': resp({ features: [] }), 'getSamples': resp(demBody(1953.2)) }));
    const bigger = app.processArea(areaLayer(B.lat, B.lng, 0.08), 'polygon').catch(() => {});
    await flush();
    expect(text('assessBadge')).toBe('LOADING');
    expect(text('wxTemp')).toBe('UPDATING…');
    wx.release(resp(wxBody(31)));
    await bigger;
  });

  it('a check that FAILS for the new area leaves its own unverified line, not the old area\'s data', async () => {
    seedPreviousArea();
    S._processedAreaKey = 'the-previous-area';
    route(quiet({ 'api.open-meteo.com/v1/forecast': resp(wxBody(31)), 'alerts/active': resp({}, { status: 503 }), 'getSamples': resp(demBody(1953.2)) }));
    await app.processArea(areaLayer(B.lat, B.lng), 'polygon').catch(() => {});
    await flush();
    const t = text('assessText');
    expect(t).toMatch(/NWS weather alerts UNVERIFIED/);
    expect(t).not.toMatch(/Tornado|Still loading/);
  });
});

// ============================================================================
describe('requests that never answer give up', () => {
  it('limits are 20 s for weather and 15 s for terrain', () => {
    expect(WX_TIMEOUT_MS).toBe(20000);
    expect(ELEV_TIMEOUT_MS).toBe(15000);
  });

  it('_fetchTimed passes an answer through and starts the request at once', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(resp({ ok: 1 })));
    const p = _fetchTimed('https://example.test/a', 5000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // synchronously, like a bare fetch()
    expect((await p).status).toBe(200);
  });

  it('_fetchTimed fails with a plain error after the limit and aborts the request', async () => {
    vi.useFakeTimers();
    let signal;
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      signal = opts.signal;
      signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
    const p = _fetchTimed('https://example.test/slow', 15000);
    const outcome = p.then(() => 'answered', e => e);
    await vi.advanceTimersByTimeAsync(14999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const err = await outcome;
    expect(signal.aborted).toBe(true);
    expect(err.message).toBe('no answer within 15 s');
    expect(err.name).not.toBe('AbortError');
  });

  it('_fetchTimed lets the caller cancel: that stays an AbortError', async () => {
    const ctl = new AbortController();
    globalThis.fetch = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    }));
    const p = _fetchTimed('https://example.test/x', 15000, { signal: ctl.signal }).then(() => 'answered', e => e);
    ctl.abort();
    expect((await p).name).toBe('AbortError');
  });

  it('weather that never answers ends as a failed check, not "Fetching…" for good', async () => {
    vi.useFakeTimers();
    route({ 'api.open-meteo.com/v1/forecast': () => new Promise(() => {}), 'air-quality-api': resp(aqiBody), 'swpc': resp(kpBody) });
    const p = app.fetchWeather(B.lat, B.lng);
    await vi.advanceTimersByTimeAsync(WX_TIMEOUT_MS + 5);
    await p;
    expect(S.sectionMeta.weather.status).toBe('error');
    expect(S.sectionMeta.weather.error).toMatch(/no answer within 20 s/);
    expect(text('wxStatus')).toBe('ERROR');
    expect(S.aqi).toBe(20); // air quality answered and is kept
  });

  it('a stalled 3DEP request falls back to the other elevation source', async () => {
    vi.useFakeTimers();
    route({
      'getSamples': () => new Promise(() => {}),
      'open-meteo.com/v1/elevation': url => Promise.resolve(resp({
        elevation: Array.from({ length: (String(url).match(/latitude=([^&]*)/)[1] || '').split(',').length }, () => 1953.2) })),
    });
    const p = app.fetchElevation(B, bbox(B.lat, B.lng));
    await vi.advanceTimersByTimeAsync(ELEV_TIMEOUT_MS + 5);
    await p;
    expect(S.elev.center).toBe(6408);
    expect(text('elevStatus')).toMatch(/COPERNICUS/);
  });
});

// ============================================================================
// While a source is still trying (any mirror or fallback), its fields say
// UPDATING…; only when its last source has failed do they say UNKNOWN, and at
// that moment — not when the slowest other source gives up — it is listed in
// the red DATA SOURCE ERRORS panel.
describe('fields say UPDATING… until the last source has answered', () => {
  const base = extra => Object.assign({
    'air-quality-api': resp(aqiBody), 'swpc': resp(kpBody), 'alerts/active': resp({ features: [] }),
    'getSamples': resp(demBody(1953.2)),
  }, extra);
  // Like held(), but once opened every later request answers at once too — the
  // app queues OpenStreetMap lookups two at a time, so some arrive after release.
  const gate = () => {
    let open = null;
    const h = held();
    const g = () => (open ? Promise.resolve(open) : h());
    g.release = r => { open = r; h.release(r); };
    g.count = () => h.count();
    return g;
  };
  const panelSources = () => {
    const p = document.getElementById('dataSourceWarning');
    return p ? [...p.querySelectorAll('.ds-row.ds-error b')].map(b => b.textContent) : [];
  };

  it('a failed weather check shows UNKNOWN and joins the error panel while slow sources are still pending', async () => {
    S._processedAreaKey = 'the-previous-area';
    const wx = held(), overpass = gate();
    route(base({ 'api.open-meteo.com/v1/forecast': wx, 'interpreter': overpass }));
    let finished = false;
    const done = app.processArea(areaLayer(B.lat, B.lng), 'polygon').catch(() => {}).then(() => { finished = true; });
    await flush();
    expect(text('wxTemp')).toBe(app.UPDATING_CELL_TEXT);
    expect(text('windMax')).toBe(app.UPDATING_CELL_TEXT);
    expect(panelSources()).not.toContain('Weather');

    wx.release(resp({}, { status: 503 }));
    await flush();
    expect(text('wxTemp')).toBe('UNKNOWN: NEEDS UPDATE');
    expect(panelSources()).toContain('Weather');
    expect(finished).toBe(false);                       // OpenStreetMap lookups still out
    expect(overpass.count()).toBeGreaterThan(0);
    expect(text('terrTrails')).toBe(app.UPDATING_CELL_TEXT); // …and their fields still say so
    // Redrawn when OTHER sources answered (utility circuits, FAA airspace), but
    // their own OpenStreetMap lookups have not: not "None mapped" / "None found".
    expect(text('terrPower')).toBe(app.UPDATING_CELL_TEXT);
    expect(text('airNearAirport')).toBe(app.UPDATING_CELL_TEXT);

    overpass.release(resp({ elements: [] }));
    await done;
    await flush();
    expect(text('terrTrails')).not.toBe(app.UPDATING_CELL_TEXT);
    expect(text('terrPower')).toBe('None mapped (verify imagery)');   // now it is a finding
    expect(text('airNearAirport')).toBe('None found');
  });

  it('wire / airport "none" texts follow their own lookup: UPDATING…, then UNKNOWN or None', () => {
    const area = areaLayer(B.lat, B.lng);
    S.currentArea = area;
    S._srcAnswer = {};
    S.utilityWireCounts = {};
    app.updateWireDisplay({}, 0);                      // e.g. the utility circuits answered first
    expect(text('terrPower')).toBe(app.UPDATING_CELL_TEXT);
    expect(text('terrTowers')).toBe(app.UPDATING_CELL_TEXT);
    app._noteSourceAnswer('wire', false);              // every Overpass mirror failed, nothing held
    app.updateWireDisplay({}, 0);
    expect(text('terrPower')).toBe('UNKNOWN: NEEDS UPDATE');
    app._noteSourceAnswer('wire', true);
    app.updateWireDisplay({}, 0);
    expect(text('terrPower')).toBe('None mapped (verify imagery)');
    app.updateWireDisplay({ power_line: 2 }, 1);
    expect(text('terrPower')).toBe('2 lines mapped \u2014 see map');
    // A different area: that answer no longer counts.
    S.currentArea = areaLayer(A.lat, A.lng);
    app.updateWireDisplay({}, 0);
    expect(text('terrPower')).toBe(app.UPDATING_CELL_TEXT);
  });

  it('a refresh of the same area: UNKNOWN fields say UPDATING… while it runs, real values stay', async () => {
    route(base({ 'api.open-meteo.com/v1/forecast': resp({}, { status: 503 }), 'interpreter': resp({ elements: [] }) }));
    const layer = areaLayer(B.lat, B.lng);
    await app.processArea(layer, 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe('UNKNOWN: NEEDS UPDATE');
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');

    const wx = held();
    route(base({ 'api.open-meteo.com/v1/forecast': wx, 'interpreter': resp({ elements: [] }) }));
    const again = app.processArea(layer, 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe(app.UPDATING_CELL_TEXT);
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    wx.release(resp(wxBody(31)));
    await again;
    await flush();
    expect(text('wxTemp')).toBe('31°F');
  });

  it('UPDATE and RETRY show UPDATING… during the re-check, then the answer', async () => {
    route(base({ 'api.open-meteo.com/v1/forecast': resp({}, { status: 503 }), 'interpreter': resp({ elements: [] }) }));
    await app.processArea(areaLayer(B.lat, B.lng), 'polygon').catch(() => {});
    await flush();
    expect(text('wxTemp')).toBe('UNKNOWN: NEEDS UPDATE');

    // Section UPDATE button: still failing → back to UNKNOWN.
    let wx = held();
    route(base({ 'api.open-meteo.com/v1/forecast': wx }));
    let p = app.updateSection('weather');
    await flush();
    expect(text('wxTemp')).toBe(app.UPDATING_CELL_TEXT);
    wx.release(resp({}, { status: 503 }));
    await p;
    expect(text('wxTemp')).toBe('UNKNOWN: NEEDS UPDATE');

    // Error panel RETRY: answers this time.
    wx = held();
    route(base({ 'api.open-meteo.com/v1/forecast': wx }));
    p = app.retryFailedSource('Weather');
    await flush();
    expect(text('wxTemp')).toBe(app.UPDATING_CELL_TEXT);
    wx.release(resp(wxBody(29)));
    await p;
    expect(text('wxTemp')).toBe('29°F');
  });

  it('a source that answers without filling a field does not leave it UPDATING…', () => {
    app.markCellsUpdating(['wxTemp', 'wxUV']);
    document.getElementById('wxTemp').textContent = '40°F';          // the render filled this one
    app.markSection('weather', { status: 'live', updatedAt: Date.now(), error: null });
    expect(text('wxTemp')).toBe('40°F');
    expect(text('wxUV')).toBe('--');

    // A failure on top of earlier data flags real values stale — never "UPDATING… (stale)".
    app.markCellsUpdating(['wxUV']);
    app.markSection('weather', { status: 'error', error: 'x' });
    expect(text('wxTemp')).toBe('40°F (stale: Verify)');
    expect(text('wxUV')).toBe('UNKNOWN: NEEDS UPDATE');
  });

  it('markCellsUpdating leaves fields that hold values alone', () => {
    document.getElementById('wxTemp').textContent = '40°F';
    document.getElementById('wxDew').textContent = '--';
    document.getElementById('wxVis').textContent = 'UNKNOWN: NEEDS UPDATE';
    app.markCellsUpdating(['wxTemp', 'wxDew', 'wxVis']);
    expect(text('wxTemp')).toBe('40°F');
    expect(text('wxDew')).toBe(app.UPDATING_CELL_TEXT);
    expect(text('wxVis')).toBe(app.UPDATING_CELL_TEXT);
  });
});
