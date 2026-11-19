// The area forecast (fetchWeather) is requested with precipitation_unit=inch,
// and Open-Meteo then answers `visibility` and `freezing_level_height` in FEET.
// Until v2026.11.18-c the app read both as metres: the Weather tab, the time
// bar hours and the assessment were 3.28× too high. Values here are a live
// answer for one point on a storm day (38.845, -120.235, 2026-11-18).
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
const { S, fetchWeather, snapshotAtIdx } = app;
const { formatAge } = require('../../sar-preflight-offline.js');

const APP_BODY = (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m[1].replace(/<script[\s\S]*?<\/script>/gi, '');
})();

const T0 = Math.floor(Date.now() / 3600000) * 3600;
// What the app's own request returns: feet, and unit blocks that say so.
function imperialBody(over) {
  return Object.assign({
    latitude: 38.853683, longitude: -120.25562, elevation: 2118,
    utc_offset_seconds: -28800, timezone: 'America/Los_Angeles', timezone_abbreviation: 'GMT-8',
    current_units: { temperature_2m: '°F', visibility: 'ft', wind_speed_10m: 'mp/h' },
    current: {
      time: T0, temperature_2m: 29.5, dew_point_2m: 28.2, relative_humidity_2m: 95, surface_pressure: 778.3,
      visibility: 1968.504, precipitation_probability: 100, weather_code: 75, cloud_cover: 100,
      wind_speed_10m: 10, wind_gusts_10m: 14, wind_direction_10m: 179, is_day: 0,
    },
    hourly_units: { temperature_2m: '°F', visibility: 'ft', freezing_level_height: 'ft' },
    hourly: {
      time: [T0, T0 + 3600, T0 + 7200],
      temperature_2m: [29.3, 29.6, 29.5],
      dew_point_2m: [28.2, 28.4, 28.3],
      relative_humidity_2m: [95, 95, 95],
      surface_pressure: [778.3, 778.0, 777.8],
      visibility: [984.252, 2624.672, 26246.72],
      precipitation_probability: [100, 100, 80],
      weather_code: [75, 73, 71],
      cloud_cover: [100, 100, 100],
      wind_speed_10m: [10, 10, 10],
      wind_direction_10m: [180, 180, 180],
      wind_gusts_10m: [14, 14, 14],
      freezing_level_height: [6200.788, 6266.405, 8202.1],
      is_day: [0, 0, 0],
    },
  }, over || {});
}
const kpPayload = [['time_tag', 'kp'], [new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' '), '2.00']];
const aqiPayload = { current: { us_aqi: 20, pm2_5: 3, pm10: 5, ozone: 40 } };

function resp(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function installFetch(handlers) {
  globalThis.fetch = vi.fn(url => {
    const h = handlers[new URL(url).host];
    if (!h) return Promise.resolve(resp({}, { status: 404 }));
    return typeof h === 'function' ? h(url) : Promise.resolve(h);
  });
}
const text = id => document.getElementById(id).textContent;

beforeEach(() => {
  globalThis.cacheApiResponse = vi.fn(async () => {});
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.getCachedApiResponse = vi.fn(async () => null);
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
  document.body.innerHTML = APP_BODY;
  S.wx = null; S.aqi = null; S.kp = null; S.kpForecast = null;
  S.wind = {}; S.elev = { center: 6956 };
  S.sectionMeta = {}; S.dataSourceErrors = {};
  S.areaCenter = { lat: 38.845, lng: -120.235 };
  S.currentArea = null; S.timeIdx = 0;
});
afterEach(() => {
  delete globalThis.cacheApiResponse; delete globalThis.setLastDataTimestamp;
  delete globalThis.getCachedApiResponse; delete globalThis.areaKey; delete globalThis.formatAge;
  document.body.innerHTML = '';
});

describe('forecast lengths arrive in feet and are shown correctly', () => {
  const live = body => installFetch({
    'api.open-meteo.com': resp(body),
    'air-quality-api.open-meteo.com': resp(aqiPayload),
    'services.swpc.noaa.gov': resp(kpPayload),
  });

  it('the request still asks for the unit system that returns feet', async () => {
    live(imperialBody());
    await fetchWeather(38.845, -120.235);
    const url = globalThis.fetch.mock.calls.map(c => c[0]).find(u => new URL(u).host === 'api.open-meteo.com');
    expect(url).toContain('precipitation_unit=inch');
    expect(url).toContain('latitude=38.845&longitude=-120.235');
  });

  it('state holds metres', async () => {
    live(imperialBody());
    await fetchWeather(38.845, -120.235);
    expect(S.wx.visibility).toBeCloseTo(600, 2);
    expect(S.wx.hourly.visibility[0]).toBeCloseTo(300, 2);
    expect(S.wx.hourly.freezing_level_height[0]).toBeCloseTo(1890, 1);
  });

  it('the Weather tab shows 0.2 mi and a 6,201 ft freezing level, not 0.6 mi and 20,344 ft', async () => {
    live(imperialBody());
    await fetchWeather(38.845, -120.235);
    expect(text('wxVis')).toBe('0.2 mi');
    expect(text('wxFreezing')).toBe('6,201 ft MSL');
    // 0 °C level below the 6,956 ft launch elevation: inside the envelope → amber.
    expect(document.getElementById('wxFreezing').className).toMatch(/amber/);
  });

  it('a later hour on the time bar is converted too', async () => {
    live(imperialBody());
    await fetchWeather(38.845, -120.235);
    const h2 = snapshotAtIdx(2);
    expect(h2.visibility).toBeCloseTo(8000, 1);          // 26,246.72 ft
    expect(h2.freezing_level_height).toBeCloseTo(2500, 1); // 8,202.1 ft
  });

  it('the assessment reports the visibility limit and the freezing-level advisory', async () => {
    live(imperialBody());
    await fetchWeather(38.845, -120.235);
    const r = assessRisk(snapshotAtIdx(0), { maxWind: 10, maxGust: 14 }, { center: 6956 });
    expect(r.issues).toContain('Visibility 0.2 mi');
    expect(r.cautions.some(c => /^Freezing level — 0°C level 6,201 ft at\/below launch elevation/.test(c))).toBe(true);
  });

  it('half a mile of visibility is a limit — read as metres it passed as 1.6 mi', async () => {
    const b = imperialBody();
    b.current.visibility = 2640;
    b.hourly.visibility = [2640, 2640, 2640];
    live(b);
    await fetchWeather(38.845, -120.235);
    expect(text('wxVis')).toBe('0.5 mi');
    const r = assessRisk(snapshotAtIdx(0), { maxWind: 10, maxGust: 14 }, { center: 6956 });
    expect(r.issues).toContain('Visibility 0.5 mi');
    // The old reading of the same number: above the 1 SM limit.
    expect(2640 / 1609.34).toBeGreaterThan(DEFAULT_THRESHOLDS.visNoGo);
  });

  it('the cached copy keeps the body as it arrived', async () => {
    live(imperialBody());
    await fetchWeather(38.845, -120.235);
    const stored = cacheApiResponse.mock.calls.find(c => c[0] === 'weather')[2];
    expect(stored.current.visibility).toBe(1968.504);
    expect(stored.current_units.visibility).toBe('ft');
    expect(stored.hourly.freezing_level_height[0]).toBe(6200.788);
    // …and is not carrying this fetch's hourly arrays inside `current`.
    expect(stored.current.hourly).toBeUndefined();
  });

  it('an unknown unit reads as visibility unavailable, never a guessed distance', async () => {
    const b = imperialBody();
    b.current_units.visibility = 'km';
    b.hourly_units.visibility = 'km';
    live(b);
    await fetchWeather(38.845, -120.235);
    expect(S.wx.visibility).toBeNull();
    const r = assessRisk(snapshotAtIdx(0), { maxWind: 10, maxGust: 14 }, { center: 6956 });
    expect(r.unavailable).toContain('visibility');
  });
});

describe('offline copy of the forecast', () => {
  const failing = () => installFetch({
    'api.open-meteo.com': () => Promise.reject(new TypeError('Failed to fetch')),
    'air-quality-api.open-meteo.com': resp(aqiPayload),
    'services.swpc.noaa.gov': resp(kpPayload),
  });

  it('a copy stored in feet is converted when it is used', async () => {
    failing();
    globalThis.getCachedApiResponse = vi.fn(async ep => ep === 'weather'
      ? { data: imperialBody(), timestamp: Date.now() - 3600e3, status: 'stale' } : null);
    await fetchWeather(38.845, -120.235);
    expect(S.sectionMeta.weather.status).toBe('cached');
    expect(S.wx.visibility).toBeCloseTo(600, 2);
    expect(text('wxVis')).toBe('0.4 mi'); // current conditions only: 600 m
  });

  it("a copy from an earlier version does not bring its old hourly arrays along", async () => {
    failing();
    const legacy = imperialBody();
    // Earlier versions stored the body after attaching that fetch's hourly
    // arrays to `current` — still in feet.
    legacy.current.hourly = { time: [new Date(T0 * 1000).toISOString()], visibility: [984.252], freezing_level_height: [6200.788] };
    globalThis.getCachedApiResponse = vi.fn(async ep => ep === 'weather'
      ? { data: legacy, timestamp: Date.now() - 3600e3, status: 'stale' } : null);
    await fetchWeather(38.845, -120.235);
    expect(S.wx.hourly).toBeUndefined();
    expect(text('wxVis')).toBe('0.4 mi');
    // …and the stored record itself is left as it was.
    expect(legacy.current.hourly.visibility).toEqual([984.252]);
  });
});
