// A NEW operational area must never be shown — or judged — with the previous
// area's numbers while its own data is on the way. Before v2026.11.18-c every
// cell kept the previous area's value until its fetch answered, so a slow
// request showed a foothill area's 46 °F / 1,234 ft for an area at 6,400 ft in
// snow, with only a small "Fetching…" pill to say otherwise.
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
  marker: () => ({ bindPopup() { return this; }, on() { return this; } }),
  divIcon: () => ({}),
};

const app = require('../../sar-preflight.js');
const { S, fetchWeather, fetchElevation, _resetPanelForNewArea, _areaKeyOf, AREA_BLANK_SECTIONS, sectionCellsFor, SECTION_DEFS } = app;
const { formatAge } = require('../../sar-preflight-offline.js');

const APP_BODY = (() => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'sar-preflight.html'), 'utf8');
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m[1].replace(/<script[\s\S]*?<\/script>/gi, '');
})();

const BASS = { lat: 38.683, lng: -121.024 };  // foothills, ~1,234 ft
const LOON = { lat: 38.9998, lng: -120.3062 }; // ~6,408 ft
const boundsOf = c => ({
  getNorthEast: () => ({ lat: c.lat + 0.01, lng: c.lng + 0.01 }),
  getSouthWest: () => ({ lat: c.lat - 0.01, lng: c.lng - 0.01 }),
});
const T0 = Math.floor(Date.now() / 3600000) * 3600;
// Current conditions only (no hourly block): the time bar and its map arrows
// are not part of what is tested here.
const wxBody = tempF => ({
  utc_offset_seconds: -28800, timezone: 'America/Los_Angeles',
  current: { time: T0, temperature_2m: tempF, dew_point_2m: tempF - 2, visibility: 16000, surface_pressure: 950,
    precipitation_probability: 0, weather_code: 0, wind_speed_10m: 5, wind_gusts_10m: 6, wind_direction_10m: 180 },
});
const aqiBody = { current: { us_aqi: 20, pm2_5: 3, pm10: 5, ozone: 40 } };
const kpBody = [['time_tag', 'kp'], [new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' '), '2.00']];
// 25 3DEP samples, all at `m` metres (locationId order).
const demBody = m => ({ samples: Array.from({ length: 25 }, (_, i) => ({ locationId: i, value: String(m) })) });

const resp = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const text = id => document.getElementById(id).textContent;

// Each service answers through a function, so a test can hold one back.
let hold;
function install(answers) {
  hold = {};
  globalThis.fetch = vi.fn(url => {
    url = String(url);
    const kind = /air-quality-api/.test(url) ? 'aqi' : /open-meteo\.com\/v1\/forecast/.test(url) ? 'wx'
      : /getSamples/.test(url) ? 'dem' : /swpc/.test(url) ? 'kp' : 'other';
    const a = answers[kind];
    if (a === 'hold') return new Promise(res => { (hold[kind] = hold[kind] || []).push(res); });
    if (typeof a === 'function') return Promise.resolve(a(url));
    return Promise.resolve(a || resp({}));
  });
}

async function loadArea(c, tempF, elevM) {
  install({ wx: resp(wxBody(tempF)), aqi: resp(aqiBody), kp: resp(kpBody), dem: resp(demBody(elevM)) });
  S.areaCenter = c;
  await Promise.all([fetchWeather(c.lat, c.lng), fetchElevation(c, boundsOf(c))]);
}

beforeEach(() => {
  globalThis.cacheApiResponse = vi.fn(async () => {});
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.getCachedApiResponse = vi.fn(async () => null);
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
  document.body.innerHTML = APP_BODY;
  S.wx = null; S.wxAreaKey = null; S.aqi = null; S.aqiAreaKey = null; S.kp = null; S.kpForecast = null;
  S.wind = {}; S.elev = {}; S._dataArea = {}; S.cellStatus = null; S.lzs = [];
  S.sectionMeta = {}; S.dataSourceErrors = {}; S.mapLayers = {};
  S.map = { hasLayer: () => false, addLayer() {}, removeLayer() {} };
  S.currentArea = null; S.timeIdx = 0; S.assessment = null;
});
afterEach(() => {
  delete globalThis.cacheApiResponse; delete globalThis.setLastDataTimestamp;
  delete globalThis.getCachedApiResponse; delete globalThis.areaKey; delete globalThis.formatAge; delete globalThis.fetch;
  S.map = null; S.areaCenter = null;
  document.body.innerHTML = '';
});

describe('weather: another area\'s values go when a request for this area begins', () => {
  it('shows UPDATING…, not the previous area\'s temperature, while the answer is on its way', async () => {
    await loadArea(BASS, 46, 376);
    expect(text('wxTemp')).toBe('46°F');
    expect(S.wxAreaKey).toBe(_areaKeyOf(BASS.lat, BASS.lng));

    install({ wx: 'hold', aqi: resp(aqiBody), kp: resp(kpBody) });
    S.areaCenter = LOON;
    const p = fetchWeather(LOON.lat, LOON.lng);
    await Promise.resolve();
    // Request in flight: the panel and the state hold no other area's weather.
    expect(text('wxTemp')).toBe('UPDATING…');
    expect(text('wxVis')).toBe('UPDATING…');
    expect(text('windMax')).toBe('UPDATING…');
    expect(S.wx).toEqual({});
    expect(S.wind).toEqual({});
    expect(S.wxAreaKey).toBeNull();
    expect(text('wxStatus')).toBe('Fetching...');
    expect(document.getElementById('windTableBody').innerHTML).toBe('');

    hold.wx[0](resp(wxBody(31)));
    await p;
    expect(text('wxTemp')).toBe('31°F');
    expect(S.wxAreaKey).toBe(_areaKeyOf(LOON.lat, LOON.lng));
  });

  it('a refresh of the SAME area keeps its values on screen while it loads', async () => {
    await loadArea(LOON, 31, 1953.2);
    install({ wx: 'hold', aqi: resp(aqiBody), kp: resp(kpBody) });
    const p = fetchWeather(LOON.lat, LOON.lng);
    await Promise.resolve();
    expect(text('wxTemp')).toBe('31°F');
    expect(S.wx.temperature_2m).toBe(31);
    hold.wx[0](resp(wxBody(30)));
    await p;
    expect(text('wxTemp')).toBe('30°F');
  });

  it('drops the other area\'s air quality too', async () => {
    await loadArea(BASS, 46, 376);
    expect(S.aqi).toBe(20);
    install({ wx: 'hold', aqi: 'hold', kp: resp(kpBody) });
    fetchWeather(LOON.lat, LOON.lng);
    await Promise.resolve();
    expect(S.aqi).toBeNull();
    expect(text('wxAQI')).toBe('UPDATING…');
  });
});

describe('terrain: another area\'s values go when a request for this area begins', () => {
  it('shows UPDATING…, not the previous area\'s launch elevation, while the answer is on its way', async () => {
    await loadArea(BASS, 46, 376);
    expect(text('terrLaunch')).toBe('1,234 ft AMSL');
    expect(S.elev.center).toBe(1234);

    install({ dem: 'hold' });
    S.areaCenter = LOON;
    const p = fetchElevation(LOON, boundsOf(LOON));
    await Promise.resolve();
    expect(text('terrLaunch')).toBe('UPDATING…');
    expect(text('terrMin')).toBe('UPDATING…');
    expect(text('terrCell')).toBe('UPDATING…');
    expect(S.elev).toEqual({});
    expect(S.cellStatus).toBeNull();
    expect(text('elevStatus')).toBe('Fetching...');

    hold.dem[0](resp(demBody(1953.2)));
    await p;
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    expect(S.elev.center).toBe(6408);
  });

  it('a refresh of the SAME area keeps its values on screen while it loads', async () => {
    await loadArea(LOON, 31, 1953.2);
    install({ dem: 'hold' });
    const p = fetchElevation(LOON, boundsOf(LOON));
    await Promise.resolve();
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    expect(S.elev.center).toBe(6408);
    hold.dem[0](resp(demBody(1953.2)));
    await p;
  });
});

describe('terrain arriving after the weather refreshes what depends on both', () => {
  it('the Ops tab and the banner stop saying the elevation is missing', async () => {
    S.currentArea = {};
    S.areaCenter = LOON;
    install({ wx: resp(wxBody(31)), aqi: resp(aqiBody), kp: resp(kpBody), dem: 'hold' });
    const elev = fetchElevation(LOON, boundsOf(LOON));
    await fetchWeather(LOON.lat, LOON.lng);
    // What the time bar does when an hourly forecast arrives: compute now.
    app.computeOpsData(); app.computeAssessment();
    // Weather is in, terrain is not: the estimate has to assume, and says so.
    expect(text('opsAltFactor')).toMatch(/^Elevation missing, assuming 9,000 ft/);
    expect(text('assessText')).toMatch(/Elevation missing/);

    hold.dem[0](resp(demBody(1953.2)));
    await elev;
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    expect(text('opsAltFactor')).not.toMatch(/missing/);
    expect(text('assessText')).not.toMatch(/Elevation missing/);
  });

  it('with no weather for this area yet it computes nothing (the weather commit will)', async () => {
    S.currentArea = {};
    S.areaCenter = LOON;
    install({ dem: resp(demBody(1953.2)) });
    document.getElementById('assessText').textContent = 'untouched';
    await fetchElevation(LOON, boundsOf(LOON));
    expect(text('terrLaunch')).toBe('6,408 ft AMSL');
    expect(text('assessText')).toBe('untouched');
  });
});

describe('_resetPanelForNewArea', () => {
  it('sets every cell an area fetch writes to UPDATING… and puts the banner in a loading state', async () => {
    await loadArea(BASS, 46, 376);
    document.getElementById('airClass').textContent = 'Class G';
    document.getElementById('astSunrise').textContent = '06:47 AM';
    document.getElementById('terrWater').textContent = '2 streams';
    document.getElementById('assessBadge').textContent = '3 LIMITS EXCEEDED';
    document.getElementById('assessBadge').className = 'assessment-badge nogo';
    document.getElementById('assessText').textContent = 'Wind 30/48g exceeds limits';
    S.assessment = { level: 'NO-GO' };

    _resetPanelForNewArea();
    AREA_BLANK_SECTIONS.forEach(k => sectionCellsFor(k).forEach(id => {
      expect(document.getElementById(id), id).not.toBeNull();
      expect(text(id), id).toBe('UPDATING…');
    }));
    expect(text('assessBadge')).toBe('LOADING');
    expect(document.getElementById('assessBadge').className).toBe('assessment-badge');
    expect(text('assessText')).toBe('Loading data for this area…');
    expect(S.assessment).toBeNull();
  });

  it('covers only sections that exist and are area-bound', () => {
    AREA_BLANK_SECTIONS.forEach(k => {
      expect(SECTION_DEFS[k], k).toBeTruthy();
      expect(SECTION_DEFS[k].viewBased, k).toBeFalsy();
    });
    // Kp is global, ADS-B and the response estimate run their own lifecycle.
    ['spaceWx', 'adsb', 'response'].forEach(k => expect(AREA_BLANK_SECTIONS).not.toContain(k));
  });

  it('never shows a verdict word', () => {
    _resetPanelForNewArea();
    expect(text('assessBadge') + ' ' + text('assessText')).not.toMatch(/\bGO\b|CAUTION|NO-GO/);
  });
});
