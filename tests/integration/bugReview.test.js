// Regression tests for BUG_REVIEW.md (reviewed version 2026.09.20-a).
// Each describe block reproduces one finding with controlled responses and
// asserts the corrected behavior.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

const layerGroupMock = () => ({ _layers: [], addLayer(x) { this._layers.push(x); }, clearLayers() { this._layers = []; }, getLayers() { return this._layers; }, addTo() { return this; } });
globalThis.L = {
  map: vi.fn(), tileLayer: vi.fn(), control: { zoom: vi.fn() }, Draw: { Event: {} }, FeatureGroup: vi.fn(),
  layerGroup: () => layerGroupMock(),
  polygon: () => ({ bindPopup() { return this; } }),
  circleMarker: () => ({ bindPopup() { return this; } }),
};

const app = require('../../sar-preflight.js');
const { S, fetchWeather, fetchKpIndex, renderWind, computeAssessment, fetchLiveRestrictions, NOTAM_MANUAL_UPDATE_CAUTION } = app;
const { formatAge } = require('../../sar-preflight-offline.js');

// The real app DOM (scripts stripped) so every render path finds its cells.
const APP_BODY = (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m[1].replace(/<script[\s\S]*?<\/script>/gi, '');
})();

const nominalWeather = {
  temperature_2m: 65, dew_point_2m: 40, visibility: 16000, precipitation_probability: 0,
  weather_code: 0, wind_speed_10m: 5, wind_gusts_10m: 5, wind_direction_10m: 0,
};
const kpPayload = [['time_tag', 'kp'], [new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' '), '2.00']];
const aqiPayload = { current: { us_aqi: 20, pm2_5: 3, pm10: 5, ozone: 40 } };

function resp(body, { status = 200, headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: k => (h[String(k).toLowerCase()] ?? null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// Route by exact host (a substring match on open-meteo would also hit the AQI host).
function installFetch(handlers) {
  const calls = [];
  globalThis.fetch = vi.fn((url, opts) => {
    calls.push(url);
    const host = new URL(url).host;
    const h = handlers[host];
    if (!h) return Promise.resolve(resp({}, { status: 404 }));
    return typeof h === 'function' ? h(url, opts) : Promise.resolve(h);
  });
  return calls;
}

function resetWeatherState() {
  document.body.innerHTML = APP_BODY;
  S.wx = null; S.aqi = null; S.kp = null; S.kpForecast = null;
  S.wind = {}; S.elev = {};
  S.sectionMeta = {};
  S.dataSourceErrors = {};
  S.areaCenter = { lat: 38, lng: -121 };
  S.currentArea = null;
  S.timeIdx = 0;
}

beforeEach(() => {
  globalThis.cacheApiResponse = vi.fn(async () => {});
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.getCachedApiResponse = vi.fn(async () => null);
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
});
afterEach(() => {
  delete globalThis.cacheApiResponse; delete globalThis.setLastDataTimestamp;
  delete globalThis.getCachedApiResponse; delete globalThis.areaKey; delete globalThis.formatAge;
  document.body.innerHTML = '';
});

// ------------------------------------------------------------------
describe('BUG-01 — SW offline-fallback responses are not labeled LIVE', () => {
  beforeEach(resetWeatherState);
  const DAY = 86400000;

  it('weather cached 24 h ago shows CACHED with its original time and is not re-cached', async () => {
    const cachedAt = Date.now() - DAY;
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }, { headers: { 'X-SAR-SW-Cache': cachedAt } }),
      'air-quality-api.open-meteo.com': resp(aqiPayload, { headers: { 'X-SAR-SW-Cache': cachedAt } }),
      'services.swpc.noaa.gov': resp(kpPayload, { headers: { 'X-SAR-SW-Cache': cachedAt } }),
    });
    await fetchWeather(38, -121);
    expect(document.getElementById('wxStatus').textContent).toMatch(/CACHED/);
    expect(document.getElementById('windStatus').textContent).toMatch(/CACHED/);
    expect(S.sectionMeta.weather.status).toBe('cached');
    expect(S.sectionMeta.weather.cachedAt).toBe(cachedAt);
    expect(S.sectionMeta.weather.updatedAt ?? null).toBeNull();
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'weather')).toBe(false);
    // an all-offline refresh must not stamp a fresh "last data" time
    expect(setLastDataTimestamp).not.toHaveBeenCalled();
    // the value itself is still shown (cached ≠ unavailable)
    expect(S.wx.temperature_2m).toBe(65);
  });

  it("an 'unknown' marker never becomes a fresh live timestamp", async () => {
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }, { headers: { 'X-SAR-SW-Cache': 'unknown' } }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.sectionMeta.weather.status).toBe('cached');
    expect(S.sectionMeta.weather.updatedAt ?? null).toBeNull();
    expect(document.getElementById('wxStatus').textContent).toMatch(/CACHED/);
    expect(document.getElementById('meta_wx').textContent).toMatch(/Cached/i);
  });

  it('live weather + cached AQI are labeled independently', async () => {
    const cachedAt = Date.now() - DAY;
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }),
      'air-quality-api.open-meteo.com': resp(aqiPayload, { headers: { 'X-SAR-SW-Cache': cachedAt } }),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.sectionMeta.weather.status).toBe('live');
    expect(S.sectionMeta.airQuality.status).toBe('cached');
    expect(S.sectionMeta.airQuality.cachedAt).toBe(cachedAt);
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'weather')).toBe(true);
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'aqi')).toBe(false);
  });

  it('cached weather + live AQI are labeled independently', async () => {
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }, { headers: { 'X-SAR-SW-Cache': Date.now() - DAY } }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.sectionMeta.weather.status).toBe('cached');
    expect(S.sectionMeta.airQuality.status).toBe('live');
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'aqi')).toBe(true);
  });

  it('Kp from the SW fallback is labeled cached and not re-cached', async () => {
    const cachedAt = Date.now() - DAY;
    installFetch({ 'services.swpc.noaa.gov': resp(kpPayload, { headers: { 'X-SAR-SW-Cache': cachedAt } }) });
    await fetchKpIndex();
    expect(S.sectionMeta.spaceWx.status).toBe('cached');
    expect(S.sectionMeta.spaceWx.cachedAt).toBe(cachedAt);
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'kp')).toBe(false);
    expect(S.kp).toBe(2);
  });

  it('parses the current SWPC Kp feed (array of objects, ISO UTC) and the legacy one', () => {
    const current = [
      { time_tag: '2026-09-15T00:00:00', kp: 3.0, observed: 'observed', noaa_scale: null },
      { time_tag: '2026-09-15T03:00:00', kp: 2.33, observed: 'observed', noaa_scale: null },
    ];
    expect(app._parseKpForecast(current)).toEqual([
      { t: Date.UTC(2026, 8, 15, 0), kp: 3 }, { t: Date.UTC(2026, 8, 15, 3), kp: 2.33 },
    ]);
    const legacy = [['time_tag', 'kp', 'observed'], ['2026-06-20 00:00:00', '2.00', 'observed']];
    expect(app._parseKpForecast(legacy)).toEqual([{ t: Date.UTC(2026, 5, 20, 0), kp: 2 }]);
    expect(app._parseKpForecast({ error: 'x' })).toEqual([]);
  });

  it('an unreadable Kp feed is an error, never a made-up Kp 2 labeled LIVE', async () => {
    S.kp = null;
    installFetch({ 'services.swpc.noaa.gov': resp([{ unexpected: true }]) });
    await fetchKpIndex();
    expect(S.sectionMeta.spaceWx.status).toBe('error');
    expect(S.kp).toBeNull();
  });

  it('buildSectionMetaLine shows an unknown-age cache as cached, not "Not loaded"', () => {
    const line = buildSectionMetaLine({ status: 'cached', cachedAt: null }, Date.now());
    expect(line.state).toBe('cached');
    expect(line.text).toMatch(/Cached/);
  });
});

// ------------------------------------------------------------------
describe('BUG-02 — an obsolete area response cannot overwrite the selected area', () => {
  beforeEach(resetWeatherState);

  function deferredWeather() {
    const pending = {};
    installFetch({
      'api.open-meteo.com': url => new Promise(r => { pending[new URL(url).searchParams.get('latitude')] = r; }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    return pending;
  }

  it('delayed A success does not overwrite B', async () => {
    const pending = deferredWeather();
    const a = fetchWeather(38, -121);
    S.areaCenter = { lat: 40, lng: -120 };
    const b = fetchWeather(40, -120);
    await Promise.resolve();
    pending['40'](resp({ current: { ...nominalWeather, temperature_2m: 80 } }));
    await b;
    expect(S.wx.temperature_2m).toBe(80);
    pending['38'](resp({ current: { ...nominalWeather, temperature_2m: 20 } }));
    await a;
    expect(S.areaCenter).toEqual({ lat: 40, lng: -120 });
    expect(S.wx.temperature_2m).toBe(80);
    expect(document.getElementById('wxTemp').textContent).toBe('80°F');
    expect(S.sectionMeta.weather.status).toBe('live');
    // A's body is not persisted under any key
    expect(cacheApiResponse.mock.calls.filter(c => c[0] === 'weather').map(c => c[1])).toEqual(['40.000_-120.000']);
  });

  it('delayed A failure does not mark B failed', async () => {
    const pending = deferredWeather();
    const a = fetchWeather(38, -121);
    S.areaCenter = { lat: 40, lng: -120 };
    const b = fetchWeather(40, -120);
    await Promise.resolve();
    pending['40'](resp({ current: { ...nominalWeather, temperature_2m: 80 } }));
    await b;
    pending['38'](resp({ error: true, reason: 'boom' }, { status: 500 }));
    await a;
    expect(S.sectionMeta.weather.status).toBe('live');
    expect(S.dataSourceErrors.Weather).toBeUndefined();
    expect(document.getElementById('wxStatus').textContent).toBe('LIVE');
  });

  it('clearing the area while a request is pending prevents repopulation', async () => {
    const pending = deferredWeather();
    const a = fetchWeather(38, -121);
    await Promise.resolve();
    app.invalidateAreaRequests();   // what clearArea() does
    S.areaCenter = null;
    pending['38'](resp({ current: { ...nominalWeather, temperature_2m: 20 } }));
    await a;
    expect(S.wx).toBeNull();
  });

  it('overlapping refreshes of the same area keep the newest result', async () => {
    const order = [];
    installFetch({
      'api.open-meteo.com': () => new Promise(r => order.push(r)),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    const first = fetchWeather(38, -121);
    const second = fetchWeather(38, -121);
    await Promise.resolve();
    order[1](resp({ current: { ...nominalWeather, temperature_2m: 70 } }));
    await second;
    order[0](resp({ current: { ...nominalWeather, temperature_2m: 50 } }));
    await first;
    expect(S.wx.temperature_2m).toBe(70);
  });
});

// ------------------------------------------------------------------
describe('BUG-03 — the combined restriction re-check recomputes the assessment', () => {
  const bounds = { getSouthWest: () => ({ lat: 38.6, lng: -121.0 }), getNorthEast: () => ({ lat: 38.7, lng: -120.9 }), getCenter: () => ({ lat: 38.65, lng: -120.95 }) };
  const center = { lat: 38.65, lng: -120.95 };
  const emptyFc = { type: 'FeatureCollection', features: [] };

  function install({ tfrOk, notamOk }) {
    globalThis.fetch = vi.fn(url => {
      if (url.includes('/tfr/geoserver/')) return Promise.resolve(tfrOk ? resp(emptyFc) : resp({}, { status: 503 }));
      if (url.includes('/notam?')) return Promise.resolve(notamOk ? resp({ notamList: [] }) : resp({ error: 'unavailable' }, { status: 502 }));
      return Promise.resolve(resp({}, { status: 404 }));
    });
  }

  beforeEach(() => {
    document.body.innerHTML = APP_BODY;
    S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {}, fitBounds: vi.fn(), setView: vi.fn() };
    S.wx = { ...nominalWeather }; S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
    S.tfrs = []; S.importedNotams = []; S.tfrImportMeta = null; S.notamFetchMeta = null;
    S.nwsAlerts = []; S.activeFires = []; S.adsbAircraft = []; S.faaObstacles = null;
    // FAA airspace loaded and clear (a selected area with NO airspace data is unverified)
    const emptyFc = () => ({ type: 'FeatureCollection', features: [] });
    S.faaAirspace = { classAirspace: emptyFc(), sua: emptyFc(), tfrs: emptyFc(), laanc: emptyFc(), nsRestrictions: emptyFc(), prohibited: emptyFc() };
    S.protectedAreas = null; S.hmsSmoke = null; S.avalanche = null; S.landStatus = null; S.cellStatus = null;
    S.kp = null; S.aqi = null; S.metar = null; S.fireDanger = null;
    S.sectionMeta = {}; S.dataSourceErrors = {};
    S.currentArea = { getLatLngs: () => [[{ lat: 38.6, lng: -121 }, { lat: 38.6, lng: -120.9 }, { lat: 38.7, lng: -120.9 }, { lat: 38.7, lng: -121 }]], getBounds: () => bounds };
    S.areaCenter = center; S.areaBounds = bounds; S.areaType = 'RECTANGLE';
  });

  it('seeded error state shows the manual-update advisory', () => {
    S.autoCheck = { state: 'error', tfrOk: true, notamOk: false };
    computeAssessment();
    expect(S.assessment.advisories).toContain(NOTAM_MANUAL_UPDATE_CAUTION);
  });

  it('TFR success + NOTAM failure ends with the NOTAM advisory in the banner', async () => {
    S.autoCheck = { state: 'error', tfrOk: true, notamOk: false };
    computeAssessment();
    install({ tfrOk: true, notamOk: false });
    await fetchLiveRestrictions(center, bounds);
    expect(S.autoCheck.state).toBe('error');
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(S.assessment.advisories).toContain(NOTAM_MANUAL_UPDATE_CAUTION);
    expect(document.getElementById('assessText').textContent).toContain('NOTAMs NEED MANUAL UPDATE');
  });

  it('NOTAM success + TFR failure ends with the TFR advisory', async () => {
    install({ tfrOk: false, notamOk: true });
    await fetchLiveRestrictions(center, bounds);
    expect(S.assessment.advisories.some(a => /TFR check FAILED/.test(a))).toBe(true);
  });

  it('both failures keep the assessment unverified', async () => {
    install({ tfrOk: false, notamOk: false });
    await fetchLiveRestrictions(center, bounds);
    expect(S.assessment.advisories).toContain(NOTAM_MANUAL_UPDATE_CAUTION);
    expect(S.assessment.advisories.some(a => /TFR check FAILED/.test(a))).toBe(true);
  });

  it('both successes clear the obsolete failure advisories', async () => {
    S.autoCheck = { state: 'error', tfrOk: false, notamOk: false };
    computeAssessment();
    install({ tfrOk: true, notamOk: true });
    await fetchLiveRestrictions(center, bounds);
    expect(S.autoCheck.state).toBe('ok');
    expect(S.assessment.label).toBe('NOMINAL');
  });

  it('the banner never reads NOMINAL while a re-check after a failure is pending', async () => {
    S.autoCheck = { state: 'error', tfrOk: true, notamOk: false };
    computeAssessment();
    const labels = [];
    let releaseNotam;
    globalThis.fetch = vi.fn(url => {
      if (url.includes('/tfr/geoserver/')) return Promise.resolve(resp(emptyFc));
      if (url.includes('/notam?')) { labels.push(S.assessment.label); return new Promise(r => { releaseNotam = r; }); }
      return Promise.resolve(resp({}, { status: 404 }));
    });
    const p = fetchLiveRestrictions(center, bounds);
    await new Promise(r => setTimeout(r, 0));
    labels.push(S.assessment.label);
    releaseNotam(resp({ error: 'unavailable' }, { status: 502 }));
    await p;
    labels.push(S.assessment.label);
    expect(labels.every(l => l !== 'NOMINAL')).toBe(true);
  });
});

// ------------------------------------------------------------------
describe('BUG-04 — weather HTTP errors are reported as failures', () => {
  beforeEach(resetWeatherState);

  for (const status of [429, 500]) {
    it(`HTTP ${status} with a JSON body records a weather error and leaves loading`, async () => {
      installFetch({
        'api.open-meteo.com': resp({ error: true, reason: 'rate limited' }, { status }),
        'air-quality-api.open-meteo.com': resp(aqiPayload),
        'services.swpc.noaa.gov': resp(kpPayload),
      });
      await fetchWeather(38, -121);
      expect(document.getElementById('wxStatus').textContent).not.toBe('Fetching...');
      expect(document.getElementById('windStatus').textContent).not.toBe('Fetching...');
      expect(S.dataSourceErrors.Weather).toBeTruthy();
      expect(S.dataSourceErrors.Weather.message).toMatch(new RegExp(String(status)));
      expect(S.sectionMeta.weather.status).toBe('error');
      expect(cacheApiResponse.mock.calls.some(c => c[0] === 'weather')).toBe(false);
      // AQI succeeded independently
      expect(S.sectionMeta.airQuality.status).toBe('live');
      expect(S.aqi).toBe(20);
    });
  }

  it('HTTP 200 with an API error object is rejected', async () => {
    installFetch({
      'api.open-meteo.com': resp({ error: true, reason: 'Parameter out of range' }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.dataSourceErrors.Weather.message).toMatch(/Parameter out of range/);
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'weather')).toBe(false);
  });

  it('HTTP 200 without `current` is rejected', async () => {
    installFetch({
      'api.open-meteo.com': resp({ hourly: { time: [] } }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.dataSourceErrors.Weather).toBeTruthy();
    expect(S.sectionMeta.weather.status).toBe('error');
  });

  it('malformed JSON and network rejection fail the same way', async () => {
    installFetch({
      'api.open-meteo.com': resp('{not json', {}),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.sectionMeta.weather.status).toBe('error');
    resetWeatherState();
    installFetch({
      'api.open-meteo.com': () => Promise.reject(new TypeError('Failed to fetch')),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.sectionMeta.weather.status).toBe('error');
    expect(document.getElementById('wxStatus').textContent).toBe('ERROR');
    expect(S.sectionMeta.airQuality.status).toBe('live');
  });

  it("another area's retained weather is not carried into this area's assessment", async () => {
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.wx.visibility).toBe(16000);
    // new area; weather fails with no cached copy
    S.areaCenter = { lat: 40, lng: -120 }; S.sectionMeta = {};
    installFetch({
      'api.open-meteo.com': resp({ error: true, reason: 'down' }, { status: 500 }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(40, -120);
    expect(S.wx.visibility).toBeUndefined();
    expect(S.wind.maxWind).toBeUndefined();
  });

  it('same-area refresh failure keeps prior values, flagged stale', async () => {
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    installFetch({
      'api.open-meteo.com': resp({ error: true, reason: 'down' }, { status: 500 }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.wx.temperature_2m).toBe(65);
    expect(document.getElementById('wxTemp').textContent).toMatch(/stale/i);
  });

  it('a later success clears the error and restores LIVE', async () => {
    installFetch({
      'api.open-meteo.com': resp({ error: true, reason: 'down' }, { status: 500 }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }),
      'air-quality-api.open-meteo.com': resp(aqiPayload),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.dataSourceErrors.Weather).toBeUndefined();
    expect(document.getElementById('wxStatus').textContent).toBe('LIVE');
    expect(S.sectionMeta.weather.status).toBe('live');
  });

  it('an AQI-only failure does not block valid weather', async () => {
    installFetch({
      'api.open-meteo.com': resp({ current: nominalWeather }),
      'air-quality-api.open-meteo.com': resp({ error: true, reason: 'x' }, { status: 503 }),
      'services.swpc.noaa.gov': resp(kpPayload),
    });
    await fetchWeather(38, -121);
    expect(S.sectionMeta.weather.status).toBe('live');
    expect(S.sectionMeta.airQuality.status).toBe('error');
    expect(S.dataSourceErrors.Weather).toBeUndefined();
    expect(cacheApiResponse.mock.calls.some(c => c[0] === 'aqi')).toBe(false);
  });
});

// ------------------------------------------------------------------
describe('BUG-05 — wind direction interpolates across north', () => {
  beforeEach(() => {
    document.body.innerHTML = '<table><tbody id="windTableBody"></tbody></table><span id="windShear"></span>';
    S.elev = {};
  });

  it('lerpBearing takes the short way round', () => {
    expect(Math.round(lerpBearing(350, 10, 0.37))).toBe(357);
    expect(Math.round(lerpBearing(350, 10, 0.74))).toBe(5);
    expect(Math.round(lerpBearing(10, 350, 0.37))).toBe(3);
    expect(Math.round(lerpBearing(10, 350, 0.74))).toBe(355);
    expect(lerpBearing(90, 110, 0.5)).toBe(100);
    expect(lerpBearing(45, 45, 0.3)).toBe(45);
    expect(lerpBearing(0, 360, 0.5)).toBe(0);
    expect(lerpBearing(360, 0, 0.5)).toBe(0);
    // exactly opposite: defined (counter-clockwise), in range
    const opp = lerpBearing(0, 180, 0.5);
    expect(opp).toBe(270);
    expect(lerpBearing(-10, 10, 0.5)).toBe(0);
    for (const t of [0, 0.25, 0.5, 1]) {
      const v = lerpBearing(350, 10, t);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(360);
    }
  });

  it('the north-crossing profile has no false directional shear', () => {
    renderWind({ ...nominalWeather, wind_direction_10m: 350, wind_direction_80m: 10, wind_direction_120m: 10 });
    const dirs = S.wind.profile.map(p => p.dir);
    expect(dirs).toEqual([350, 357, 5, 10, 10]);
    expect(document.getElementById('windShear').textContent).toBe('2mph / 8°');
    // speeds unchanged by the direction fix
    expect(S.wind.profile.map(p => p.speed)).toEqual([5, 6, 6, 8, 8]);
  });

  it('never renders 360°', () => {
    renderWind({ ...nominalWeather, wind_direction_10m: 359.6, wind_direction_80m: 359.6, wind_direction_120m: 359.6 });
    expect(S.wind.profile.every(p => p.dir >= 0 && p.dir < 360)).toBe(true);
  });
});

// ------------------------------------------------------------------
describe('Missing wind reads "Wind unavailable", never 0 mph', () => {
  beforeEach(() => {
    document.body.innerHTML = APP_BODY;
    S.elev = { center: 2000 }; S.nwsAlerts = []; S.tfrs = []; S.importedNotams = []; S.activeFires = [];
    S.faaAirspace = null; S.faaObstacles = null; S.protectedAreas = null; S.adsbAircraft = [];
    S.kp = null; S.aqi = null; S.metar = null; S.fireDanger = null; S.autoCheck = null;
    S.currentArea = null; S.landStatus = null; S.cellStatus = null; S.hmsSmoke = null; S.avalanche = null;
  });

  it('a forecast without wind fields renders UNAVAILABLE (no NaN) and the banner says so', () => {
    const snap = { ...nominalWeather };
    delete snap.wind_speed_10m; delete snap.wind_gusts_10m; delete snap.wind_direction_10m;
    S.wx = snap;
    renderWind(snap);
    expect(S.wind.maxWind).toBeNull();
    expect(S.wind.maxGust).toBeNull();
    expect(document.getElementById('windMax').textContent).toBe('UNAVAILABLE');
    expect(document.getElementById('windGustMax').textContent).toBe('UNAVAILABLE');
    expect(document.getElementById('windTableBody').textContent).not.toMatch(/NaN/);
    expect(document.getElementById('windShear').textContent).not.toMatch(/NaN/);
    computeAssessment(snap);
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(S.assessment.advisories.some(a => a.startsWith('Wind unavailable'))).toBe(true);
    expect(S.assessment.advisories.some(a => a.startsWith('Gust unavailable'))).toBe(true);
  });

  it('wind present but gust missing: sustained wind judged, gust unavailable', () => {
    const snap = { ...nominalWeather, wind_speed_10m: 40 };
    delete snap.wind_gusts_10m;
    S.wx = snap;
    renderWind(snap);
    expect(S.wind.maxWind).toBeGreaterThan(27);
    expect(S.wind.maxGust).toBeNull();
    computeAssessment(snap);
    expect(S.assessment.limits.some(l => /^Wind \d+\/\?g exceeds/.test(l))).toBe(true);
    expect(S.assessment.advisories.some(a => a.startsWith('Gust unavailable'))).toBe(true);
  });
});

// ------------------------------------------------------------------
describe('BUG-06 — an exceeded limit does not erase other advisories', () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="cfgMaxWind" type="number" value="27" />
      <span id="assessBadge" class="assessment-badge">--</span><span id="assessText">--</span>`;
    S.wx = { ...nominalWeather }; S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
    S.nwsAlerts = []; S.tfrs = []; S.importedNotams = []; S.activeFires = []; S.faaAirspace = null;
    S.faaObstacles = null; S.protectedAreas = null; S.hmsSmoke = null; S.avalanche = null;
    S.landStatus = null; S.cellStatus = null; S.kp = null; S.aqi = null; S.metar = null; S.fireDanger = null;
    S.autoCheck = null; S.currentArea = null; S.areaCenter = null;
    S.adsbAircraft = [{ agl: 200, distNm: 1, squawk: '7700' }];
  });
  afterEach(() => { S.adsbAircraft = []; });

  it('traffic advisories survive a wind limit', () => {
    computeAssessment();
    expect(S.assessment.advisories.length).toBe(2);
    S.wind = { maxWind: 50, maxGust: 60 };
    computeAssessment();
    expect(S.assessment.level).toBe('NO-GO');
    expect(S.assessment.limits.some(l => /Wind/.test(l))).toBe(true);
    expect(S.assessment.advisories.some(a => /Emergency aircraft/.test(a))).toBe(true);
    expect(S.assessment.advisories.some(a => /below 500ft/.test(a))).toBe(true);
    expect(S.assessment.text).toMatch(/Wind .*\| Advisory: .*Emergency aircraft/);
  });

  it('Kp, obstacles, AQI, fire danger, dams and moderate NWS survive a limit', () => {
    S.wind = { maxWind: 50, maxGust: 60 };
    S.kp = 7; S.aqi = 180; S.fireDanger = { ercPct: 95 };
    S.protectedAreas = { dams: [{}] };
    S.nwsAlerts = [{ severity: 'Moderate', event: 'Wind Advisory' }];
    S.faaObstacles = { features: [{ properties: { AGL: 900, AMSL: 3000 }, geometry: { type: 'Point', coordinates: [-121, 38] } }] };
    computeAssessment();
    const adv = S.assessment.advisories.join('\n');
    expect(adv).toMatch(/Kp 7/);
    expect(adv).toMatch(/AQI 180/);
    expect(adv).toMatch(/fire danger/);
    expect(adv).toMatch(/Dam nearby/);
    expect(adv).toMatch(/NWS: Wind Advisory/);
    expect(adv).toMatch(/tall obstacle/);
    expect(S.assessment.level).toBe('NO-GO');
  });

  it('a later advisory cannot downgrade a limit, and items are not duplicated', () => {
    S.wind = { maxWind: 50, maxGust: 60 };
    S.kp = 7;
    computeAssessment();
    expect(S.assessment.cls).toBe('nogo');
    const all = S.assessment.limits.concat(S.assessment.advisories);
    expect(new Set(all).size).toBe(all.length);
  });

  it('assessmentDisplay drops duplicate items', () => {
    const d = assessmentDisplay({ issues: ['A', 'A'], cautions: ['B', 'B', 'A'] });
    expect(d.limits).toEqual(['A']);
    expect(d.advisories).toEqual(['B']);
  });
});
