// Bug review (Nov 2026) — fetcher honesty, area ownership and escaping.
// Covers: C4 avalanche warning, H2 wildfire SW/truncation/malformed, H7 ADS-B
// validation + waiting text + timeouts, H14 land-status holes / no-data,
// H15 wire-hazard cache fallback, H16 escaping, H18 buildings layer, H19 +
// M13.1 canopy tiles, M20 fetcher resilience, M21 config restore, Low-7 nulls.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);
const raster = require('../../sar-preflight-raster.js');
Object.assign(globalThis, raster);

// Permissive Leaflet mock: unknown calls chain harmlessly; layer groups keep
// real arrays, and layers remember their popup / tooltip so tests can read them.
function chain() {
  const fn = function () { return chain(); };
  return new Proxy(fn, { get(t, p) { if (p === 'then') return undefined; if (p in t) return t[p]; return chain(); } });
}
function mockLayerGroup() {
  const g = { _layers: [], addTo() { return g; }, clearLayers() { g._layers.length = 0; }, addLayer(l) { g._layers.push(l); },
    getLayers() { return g._layers; }, eachLayer(cb) { g._layers.forEach(cb); }, hasLayer() { return false; }, removeLayer() {} };
  return g;
}
const leafletLayer = () => {
  const rec = { popup: null, tooltip: null };
  const self = new Proxy(rec, { get(t, p) {
    if (p === 'then') return undefined;
    if (p in t) return t[p];
    if (p === 'addTo') return grp => { if (grp && grp.addLayer) grp.addLayer(self); return self; };
    if (p === 'bindPopup') return h => { t.popup = h; return self; };
    if (p === 'bindTooltip') return h => { t.tooltip = h; return self; };
    return () => self;
  } });
  return self;
};
globalThis.L = new Proxy({
  layerGroup: () => mockLayerGroup(),
  marker: () => leafletLayer(), circleMarker: () => leafletLayer(), polyline: () => leafletLayer(),
  polygon: () => leafletLayer(), circle: () => leafletLayer(), geoJSON: () => leafletLayer(),
}, { get(t, p) { return p in t ? t[p] : chain(); } });

const app = require('../../sar-preflight.js');
const { S, computeAssessment } = app;
const { formatAge } = require('../../sar-preflight-offline.js');
const pgeFixture = require('../fixtures/utility-pge-response.json');

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
  };
}
const fc = (features, extra) => Object.assign({ type: 'FeatureCollection', features }, extra || {});
const pt = (props, lng = -121, lat = 38.65) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props });
const square = (lat, lng, d) => [[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]];
const bbox = (lat, lng, d = 0.02) => ({
  getSouthWest: () => ({ lat: lat - d, lng: lng - d }), getNorthEast: () => ({ lat: lat + d, lng: lng + d }),
  getCenter: () => ({ lat, lng }),
  getWest: () => lng - d, getEast: () => lng + d, getSouth: () => lat - d, getNorth: () => lat + d,
});
const areaLayer = (lat, lng, d = 0.02) => ({
  getBounds: () => bbox(lat, lng, d),
  getLatLngs: () => [[{ lat: lat - d, lng: lng - d }, { lat: lat - d, lng: lng + d }, { lat: lat + d, lng: lng + d }, { lat: lat + d, lng: lng - d }]],
});
const A = { lat: 38.65, lng: -121.0 };
const text = id => document.getElementById(id).textContent;
const html = id => document.getElementById(id).innerHTML;
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

let cacheStore;
beforeEach(() => {
  document.body.innerHTML = APP_BODY;
  S.map = new Proxy({ hasLayer: () => false, addLayer: vi.fn(), removeLayer: vi.fn(), panTo: vi.fn() },
    { get(t, p) { return p in t ? t[p] : chain(); } });
  S.mapLayers = {};
  S.sectionMeta = {}; S.dataSourceErrors = {}; S._dataArea = {}; S._activeFetches = {};
  S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
  S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
  S.protectedAreas = null; S.faaObstacles = null; S.nearbyAirports = [];
  S.nwsAlerts = []; S.tfrs = []; S.importedNotams = []; S.activeFires = []; S.adsbAircraft = [];
  S.faaAirspace = null; S.kp = null; S.aqi = null; S.metar = null; S.fireDanger = null; S.autoCheck = null;
  S.landStatus = null; S.publicLands = null; S.cellStatus = null; S.hmsSmoke = null; S.avalanche = null;
  S.wireHazardCounts = {}; S.utilityWireCounts = {}; S.utilityWireInfo = {}; S.towerCount = 0;
  S.buildings = null; S._buildingsFetching = false;
  S.areaCenter = A; S.areaBounds = bbox(A.lat, A.lng); S.currentArea = null;
  cacheStore = {};
  globalThis.cacheApiResponse = vi.fn(async (ep, k, data) => { cacheStore[ep + '_' + k] = { data, timestamp: Date.now(), status: 'fresh' }; });
  globalThis.getCachedApiResponse = vi.fn(async (ep, k) => cacheStore[ep + '_' + k] || null);
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
});
afterEach(() => {
  ['cacheApiResponse', 'getCachedApiResponse', 'setLastDataTimestamp', 'areaKey', 'formatAge',
    'getAppState', 'saveAppState', 'GeoTIFF', 'getCachedRaster', 'cacheRaster', 'isOnline'].forEach(k => delete globalThis[k]);
  delete globalThis.fetch;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

// Route fetch by a substring of the URL (first match wins).
function route(table) {
  globalThis.fetch = vi.fn((url, opts) => {
    for (const [needle, h] of Object.entries(table)) {
      if (String(url).includes(needle)) return typeof h === 'function' ? h(url, opts) : Promise.resolve(h);
    }
    return Promise.resolve(resp({}, { status: 404 }));
  });
}
const cachedEp = ep => globalThis.cacheApiResponse.mock.calls.some(c => c[0] === ep);

// ------------------------------------------------------------------
describe('C4 — avalanche.org warning: { product: null } is NOT a warning', () => {
  const zone = (props) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [square(A.lat, A.lng, 0.2)] } });

  it('helper + popup', () => {
    expect(app.avalancheWarningActive({ warning: { product: null } })).toBe(false);
    expect(app.avalancheWarningActive({ warning: { product: { id: 7 } } })).toBe(true);
    expect(app.avalancheWarningActive({ warning: 'Avalanche Warning' })).toBe(true);
    expect(app.avalancheWarningActive({})).toBe(false);
    const p = app._avalanchePopup({ name: 'Bridgeport', danger_level: 3, warning: { product: null } });
    expect(p).not.toMatch(/warning in effect/);
    expect(p).toMatch(/Considerable/);
    expect(app._avalanchePopup({ name: 'X', danger_level: 4, warning: { product: { id: 1 } } })).toMatch(/warning in effect/);
  });

  it('assessment: an off-season zone with product:null raises no advisory; danger 3 reads as danger, not warning', () => {
    S.currentArea = areaLayer(A.lat, A.lng);
    S.avalanche = [zone({ name: 'Off season', danger_level: -1, warning: { product: null } })];
    computeAssessment();
    expect(S.assessment.advisories.some(a => /Avalanche/.test(a))).toBe(false);
    S.avalanche = [zone({ name: 'Bridgeport', danger_level: 3, warning: { product: null } })];
    computeAssessment();
    expect(S.assessment.advisories).toContain('Avalanche danger level 3 — ground-team hazard');
    expect(S.assessment.advisories.some(a => /warning in effect/.test(a))).toBe(false);
  });

  it('an ONLINE failure falls back to the stored copy (it used to only when offline)', async () => {
    cacheStore['avalanche_us'] = { data: fc([zone({ name: 'Stored', danger_level: 2, warning: { product: null } })]), timestamp: Date.now() - 3600e3, status: 'fresh' };
    route({ 'api.avalanche.org': resp({}, { status: 503 }) });
    await app.fetchAvalanche(bbox(A.lat, A.lng));
    expect(S.avalanche).toHaveLength(1);
    expect(S.dataSourceErrors.Avalanche.message).toMatch(/503.*cached copy/);
  });
});

// ------------------------------------------------------------------
describe('H2 / M20 — wildfire perimeters + NFDRS', () => {
  const perim = (name) => ({ type: 'Feature', properties: { poly_IncidentName: name, poly_GISAcres: 500, attr_PercentContained: 10 },
    geometry: { type: 'Polygon', coordinates: [square(A.lat + 0.3, A.lng, 0.05)] } });
  const WFIGS = 'WFIGS_Interagency_Perimeters_Current';

  it('a Service-Worker offline copy is UNVERIFIED and dated, never "Live" / a green all-clear', async () => {
    const ts = Date.now() - 6 * 3600e3;
    route({ [WFIGS]: resp(fc([]), { headers: { 'X-SAR-SW-Cache': ts } }), CA_NFDRS: resp({ features: [] }) });
    await app.fetchFireDanger(A.lat, A.lng, bbox(A.lat, A.lng));
    expect(S.fireDataUnverified).toBe(true);
    expect(S.sectionMeta.fireDanger.status).toBe('cached');
    expect(html('fireDangerCards')).toMatch(/OFFLINE COPY/);
    expect(html('fireDangerCards')).not.toMatch(/NO ACTIVE FIRES NEARBY/);
    S.currentArea = areaLayer(A.lat, A.lng);
    computeAssessment();
    expect(S.assessment.advisories.some(a => /Wildfire data UNVERIFIED/.test(a))).toBe(true);
  });

  it('more perimeters than one page are paged; an unfinished page is INCOMPLETE, not LIVE', async () => {
    route({
      resultOffset: resp({}, { status: 500 }),
      [WFIGS]: resp(fc([perim('Alpha')], { exceededTransferLimit: true })),
      CA_NFDRS: resp({ features: [] }),
    });
    await app.fetchFireDanger(A.lat, A.lng, bbox(A.lat, A.lng));
    expect(S.activeFires.map(f => f.name)).toEqual(['Alpha']);
    expect(S.sectionMeta.fireDanger.status).toBe('error');
    expect(S.sectionMeta.fireDanger.partial).toBe(true);
    expect(S.fireDataUnverified).toBe(true);
    expect(html('fireDangerCards')).toMatch(/INCOMPLETE/);
  });

  it('a completed second page is merged and LIVE', async () => {
    route({
      resultOffset: resp(fc([perim('Bravo')])),
      [WFIGS]: resp(fc([perim('Alpha')], { exceededTransferLimit: true })),
      CA_NFDRS: resp({ features: [] }),
    });
    await app.fetchFireDanger(A.lat, A.lng, bbox(A.lat, A.lng));
    expect(S.activeFires.map(f => f.name).sort()).toEqual(['Alpha', 'Bravo']);
    expect(S.sectionMeta.fireDanger.status).toBe('live');
    expect(S.fireDataUnverified).toBe(false);
  });

  it('a 200 body without a features array is an ERROR, not "no fires"', async () => {
    route({ [WFIGS]: resp({ type: 'FeatureCollection' }), CA_NFDRS: resp({ features: [] }) });
    await app.fetchFireDanger(A.lat, A.lng, bbox(A.lat, A.lng));
    expect(S.sectionMeta.fireDanger.status).toBe('error');
    expect(html('fireDangerCards')).not.toMatch(/NO ACTIVE FIRES NEARBY/);
  });

  it('a malformed NFDRS body does not discard valid perimeters', async () => {
    route({
      [WFIGS]: resp(fc([perim('Charlie')])),
      CA_NFDRS: { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad json'); } },
    });
    await app.fetchFireDanger(A.lat, A.lng, bbox(A.lat, A.lng));
    expect(S.activeFires.map(f => f.name)).toEqual(['Charlie']);
    expect(S.sectionMeta.fireDanger.status).toBe('live');
  });

  it('Reno (inside the CA box, no CA PSA) falls back to the national RAWS rating', async () => {
    const R = { lat: 39.53, lng: -119.81 };
    route({
      [WFIGS]: resp(fc([])),
      CA_NFDRS: resp({ features: [] }),
      NFDRS_ERC_and_BI: resp({ features: [{ attributes: { Station_ID: '260117', Station_Name: 'RENO', Latitude: 39.5, Longitude: -119.8, Display: 1 } }] }),
      'fems.fs2c': resp({ data: { nfdrsObs: { data: [{ nfdr_type: 'O', energy_release_component: 50, burning_index: 40 }] },
        percentileLevels: { data: [{ energy_release_component: { '50th': 40, '70th': 60, '90th': 80, '97th': 90 }, burning_index: null }] } } }),
    });
    await app.fetchFireDanger(R.lat, R.lng, bbox(R.lat, R.lng));
    expect(S.fireDanger && S.fireDanger.psa).toMatch(/RENO/);
    expect(S.fireDanger.ercPct).toBe(60);
    expect(S.fireDanger.biPct).toBeNull();
  });

  it('_nfdrsPercentile: missing thresholds / value are unknown, not 0 → EXTREME', () => {
    const nul = { '50th': null, '70th': null, '90th': null, '97th': null };
    expect(app._nfdrsPercentile(50, nul)).toBeNull();
    expect(app._nfdrsPercentile(50, { '50th': '', '70th': '', '90th': '', '97th': '' })).toBeNull();
    expect(app._nfdrsPercentile('', { '50th': 40, '70th': 60, '90th': 80, '97th': 90 })).toBeNull();
    expect(app._nfdrsPercentile(null, { '50th': 40 })).toBeNull();
    expect(app._nfdrsPercentile(50, { '50th': 40, '70th': 60, '90th': 80, '97th': 90 })).toBe(60);
  });

  it('card: an unknown ERC percentile reads UNKNOWN, never a green LOW', () => {
    app.renderFireDangerCard([], { psa: 'Test PSA', bi: 10, biPct: null, erc: 20, ercPct: null }, A.lat, A.lng);
    expect(html('fireDangerCards')).toMatch(/FIRE DANGER: UNKNOWN/);
    expect(html('fireDangerCards')).not.toMatch(/FIRE DANGER: LOW/);
  });
});

// ------------------------------------------------------------------
describe('H7 — ADS-B', () => {
  beforeEach(() => {
    S._adsbEnabled = true; S._adsbPolling = false; S._adsbFailStreak = 0;
    S.adsbSearchRadiusNm = 10; S.adsbDem = null; S._adsbDemKey = null;
    S.currentArea = areaLayer(A.lat, A.lng);
  });

  it('a 200 without an aircraft list (rate-limit body) is a failure, not "0 AIRCRAFT · LIVE"', async () => {
    S.adsbAircraft = [];
    route({ getSamples: resp({ samples: [] }), adsb: resp({ msg: 'Rate limited' }), 'airplanes.live': resp({ msg: 'Rate limited' }) });
    await app.fetchAdsb();
    expect(S.sectionMeta.adsb.status).toBe('error');
    expect(text('adsbStatus')).toMatch(/UNAVAILABLE/);
    expect(text('adsbAircraftList')).toMatch(/UNKNOWN/);
    expect(text('adsbAircraftList')).not.toMatch(/No aircraft detected/);
  });

  it('stopping/restarting the feed shows a neutral "waiting" list, not an all-clear', () => {
    app.stopAdsbPolling();
    expect(text('adsbAircraftList')).toMatch(/Waiting for ADS-B data/);
    expect(text('adsbEmergencyList')).toMatch(/Waiting for ADS-B data/);
    expect(text('adsbEmergencyList')).not.toMatch(/No emergency squawks/);
    expect(text('adsbLowCount')).toBe('--');
  });

  it('a hung source is abandoned after ADSB_FETCH_TIMEOUT_MS instead of stalling the poll chain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    route({ getSamples: resp({ samples: [] }), adsb: () => new Promise(() => {}), 'airplanes.live': () => new Promise(() => {}) });
    let done = false;
    const p = app.fetchAdsb().then(() => { done = true; });
    for (let i = 0; i < 8 && !done; i++) await vi.advanceTimersByTimeAsync(app.ADSB_FETCH_TIMEOUT_MS + 10);
    await p;
    expect(done).toBe(true);
    expect(S.sectionMeta.adsb.status).toBe('error');
    expect(S.dataSourceErrors['ADS-B'].message).toMatch(/no answer within/);
  });

  it('3DEP point sampling is time-limited (a hung socket wedged AGL refinement)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    route({ getSamples: () => new Promise(() => {}) });
    const p = app.fetch3DEPPointElevations([{ lat: A.lat, lng: A.lng, key: 'k' }]);
    const settled = p.then(() => 'ok', e => e.message);
    await vi.advanceTimersByTimeAsync(40000);
    expect(await settled).toMatch(/no answer within/);
  });

  it('list rows carry hex in an escaped data attribute (no inline onclick) and escape feed text', () => {
    const evilHex = "abc');alert(1);('";
    S.adsbAircraft = [{ hex: evilHex, flight: '<img src=x onerror=alert(1)>', agl: 300, distNm: 1.2, gs: 120, squawk: '1200',
      emergency: 'none', lat: A.lat + 0.01, lon: A.lng }];
    app.renderAdsbTab();
    const list = document.getElementById('adsbAircraftList');
    expect(list.innerHTML).not.toMatch(/onclick/);
    expect(list.innerHTML).not.toMatch(/<img/);
    const row = list.querySelector('tr[data-hex]');
    expect(row.getAttribute('data-hex')).toBe(evilHex);
    row.querySelector('td').click();
    expect(S.map.panTo).toHaveBeenCalledWith([A.lat + 0.01, A.lng]);
  });

  it('grounded traffic (agl 0) is not coloured as a red low flyer', () => {
    S.adsbAircraft = [{ hex: 'a1b2c3', flight: 'N1', agl: 0, distNm: 0.5, gs: 0, squawk: '', emergency: 'none', lat: A.lat, lon: A.lng }];
    app.renderAdsbTab();
    expect(document.getElementById('adsbNearestAlt').classList.contains('red')).toBe(false);
  });

  it('popup falls back to the geometric altitude and escapes feed text', () => {
    const h = app._adsbPopupHtml({ hex: 'a1b2c3', flight: '<b>X</b>', reg: '<i>', type: 'C172', alt_baro: null, alt_geom: 5500, agl: 900, distNm: 2 });
    expect(h).toMatch(/5,500 ft MSL \(geometric\)/);
    expect(h).not.toMatch(/<b>X<\/b>/);
    expect(h).toMatch(/&lt;b&gt;X/);
  });
});

// ------------------------------------------------------------------
describe('H14 — land status: holes and no-data', () => {
  it('a private inholding (hole) inside public land is NOT public', () => {
    const outer = [[38.0, -122.0], [38.0, -120.0], [39.0, -120.0], [39.0, -122.0], [38.0, -122.0]];
    const hole = [[38.6, -121.05], [38.6, -120.95], [38.7, -120.95], [38.7, -121.05], [38.6, -121.05]];
    const aoi = [[38.63, -121.02], [38.63, -120.98], [38.67, -120.98], [38.67, -121.02], [38.63, -121.02]];
    expect(core.classifyAreaPublicPrivate(aoi, [outer], 7).privateFrac).toBe(0);          // outer only → all public
    expect(core.classifyAreaPublicPrivate(aoi, [[outer, hole]], 7).privateFrac).toBe(1);  // with the hole → all private
  });

  it('computeLandStatus keeps GeoJSON holes', () => {
    S.currentArea = areaLayer(A.lat, A.lng);
    const f = { type: 'Feature', properties: { ADMIN_AGENCY_CODE: 'USFS' },
      geometry: { type: 'Polygon', coordinates: [square(A.lat, A.lng, 0.5), square(A.lat, A.lng, 0.05)] } };
    const st = app.computeLandStatus([f]);
    expect(st.sampled).toBeGreaterThan(0);
    expect(st.privateFrac).toBe(1);
  });

  it('an empty BLM SMA answer reads "No land-status data", not "No private land detected"', async () => {
    S.currentArea = areaLayer(A.lat, A.lng);
    route({ BLM_Natl_SMA: resp(fc([])) });
    await app.fetchPublicLands(bbox(A.lat, A.lng));
    expect(text('terrLandOwnership')).toBe('No land-status data for area — verify ownership');
    expect(document.getElementById('terrLandOwnership').classList.contains('amber')).toBe(true);
  });

  it('a same-area failure keeps this area\'s land status (and its private-land advisory)', async () => {
    S.currentArea = areaLayer(A.lat, A.lng);
    const priv = { type: 'Feature', properties: { ADMIN_AGENCY_CODE: 'PVT' }, geometry: { type: 'Polygon', coordinates: [square(A.lat, A.lng, 0.5)] } };
    route({ BLM_Natl_SMA: resp(fc([priv])) });
    await app.fetchPublicLands(bbox(A.lat, A.lng));
    expect(S.landStatus.privateFrac).toBe(1);
    cacheStore = {};                         // no stored copy to fall back on
    route({ BLM_Natl_SMA: resp({}, { status: 500 }) });
    await app.fetchPublicLands(bbox(A.lat, A.lng));
    expect(S.landStatus && S.landStatus.privateFrac).toBe(1);
    expect(text('terrLandOwnership')).toMatch(/stale/i);
    expect(S.mapLayers.public_lands._layers.length).toBe(1);
  });
});

// ------------------------------------------------------------------
describe('H15 — OSM wire hazards: cache fallback draws through the live renderer', () => {
  const elements = [
    { type: 'node', id: 1, lat: 38.64, lon: -121.01 }, { type: 'node', id: 2, lat: 38.66, lon: -120.99 },
    { type: 'way', id: 10, nodes: [1, 2], tags: { power: 'line', name: '<script>x</script>' } },
    { type: 'node', id: 3, lat: 38.65, lon: -121.0, tags: { man_made: 'mast', height: '30', operator: '<b>Op</b>' } },
  ];

  it('cached wires AND towers are drawn, counted and badged "cached" (fresh copy)', async () => {
    cacheStore['overpass_' + areaKey(A.lat, A.lng)] = { data: { elements }, timestamp: Date.now() - 60e3, status: 'fresh' };
    route({ interpreter: () => Promise.reject(new Error('network down')) });
    await app.fetchWireHazards(bbox(A.lat, A.lng));
    expect(S.mapLayers.wire_power_line._layers).toHaveLength(1);
    expect(S.mapLayers.cell_towers._layers).toHaveLength(1);
    expect(S.towerCount).toBe(1);
    expect(document.getElementById('wireStatus').className).toMatch(/\bcached\b/);
    expect(text('wireStatus')).toMatch(/^2 FEAT CACHED/);
    expect(S.sectionMeta.obstacles.sources.wire.status).toBe('cached');
    // OSM text is escaped in the popups
    expect(S.mapLayers.wire_power_line._layers[0].popup).not.toMatch(/<script>/);
    expect(S.mapLayers.cell_towers._layers[0].popup).toMatch(/&lt;b&gt;Op/);
  });

  it('a same-area failure with no copy keeps the wires; another area\'s are cleared', async () => {
    route({ interpreter: resp({ elements, osm3s: { timestamp_osm_base: new Date().toISOString() } }) });
    await app.fetchWireHazards(bbox(A.lat, A.lng));
    expect(S.mapLayers.wire_power_line._layers).toHaveLength(1);
    cacheStore = {};
    route({ interpreter: () => Promise.reject(new Error('network down')) });
    await app.fetchWireHazards(bbox(A.lat, A.lng));
    expect(S.mapLayers.wire_power_line._layers).toHaveLength(1);
    await app.fetchWireHazards(bbox(39.5, -119.8));
    expect(S.mapLayers.wire_power_line._layers).toHaveLength(0);
    expect(S.mapLayers.cell_towers._layers).toHaveLength(0);
    expect(S.towerCount).toBe(0);
  });
});

// ------------------------------------------------------------------
describe('H16 — external text is escaped', () => {
  it('NWS alert card: "< 1/4 mile" and markup render as text', () => {
    const h = app._nwsAlertCardHtml({ event: '<img src=x onerror=alert(1)>', severity: 'Severe', headline: 'H & <i>',
      description: 'Visibility < 1/4 mile\n\nRoads icy', instruction: 'Stay <home>', senderName: 'NWS <Reno>' }, 'en <route>');
    expect(h).not.toMatch(/<img/);
    expect(h).toMatch(/&lt; 1\/4 mile<br><br>Roads icy/);
    expect(h).toMatch(/Stay &lt;home&gt;/);
    expect(h).toMatch(/en &lt;route&gt;/);
  });

  it('airport markers escape OSM names', () => {
    S.nearbyAirports = [{ icao: '<x>', name: '<img src=x>', type: 'small_airport', lat: A.lat + 0.05, lng: A.lng, elevation_ft: 100, municipality: '<m>' }];
    app.renderAirportMarkers(A.lat, A.lng);
    const m = S.mapLayers.airports._layers[0];
    expect(m.popup).not.toMatch(/<img/);
    expect(m.tooltip).toBe('&lt;x&gt;');
  });
});

// ------------------------------------------------------------------
describe('H18 — buildings layer', () => {
  const bld = { list: [{ id: 5, name: '<b>Barn</b>', type: 'farm_aux', heightM: 6, est: true,
    footprint: [[-121.001, 38.649], [-121.0, 38.649], [-121.0, 38.65], [-121.001, 38.649]] }], bboxKey: 'k', fetchedAt: Date.now() };

  it('can be toggled off, and appears in Map Layers even when it is the only facility', () => {
    S.buildings = bld;
    app.renderBuildingsLayer();
    expect(S.mapLayers.buildings._layers[0].popup).toMatch(/&lt;b&gt;Barn/);
    app.buildLayerControl();
    expect(html('layerList')).toMatch(/data-layer="buildings"/);
    app.setLayerVisible('buildings', false);
    expect(S.map.removeLayer).toHaveBeenCalledWith(S.mapLayers.buildings);
    app.setLayerVisible('buildings', true);
    expect(S.map.addLayer).toHaveBeenCalledWith(S.mapLayers.buildings);
  });

  it('is part of the area data: a new area drops the previous buildings', () => {
    S.buildings = bld;
    app.renderBuildingsLayer();
    app._dropAreaData();
    expect(S.buildings).toBeNull();
    expect(S.mapLayers.buildings._layers).toHaveLength(0);
  });

  it('an in-flight fetch for ANOTHER bbox does not block this one; a superseded answer is dropped', async () => {
    S._buildingsFetching = 'some_other_bbox';
    let releaseOld;
    route({ interpreter: () => new Promise(r => { releaseOld = r; }) });
    const old = app.fetchBuildings(bbox(39.5, -119.8));
    await flush();
    const oldRelease = releaseOld;
    route({ interpreter: resp({ elements: [] }) });
    await app.fetchBuildings(bbox(A.lat, A.lng));
    const keyA = S.buildings && S.buildings.bboxKey;
    expect(keyA).toBeTruthy();
    oldRelease(resp({ elements: [] }));
    await old;
    expect(S.buildings.bboxKey).toBe(keyA);
  });
});

// ------------------------------------------------------------------
describe('H19 / M13.1 — canopy tiles', () => {
  beforeEach(() => {
    globalThis.isOnline = () => true;
    globalThis.getCachedRaster = vi.fn(async () => null);
    globalThis.cacheRaster = vi.fn(async () => {});
  });

  it('CHMv2: a tile with no pixel overlap is not a failure (no retries, no HEAD probe)', async () => {
    const grid = makeGrid(38.7, -120.99, 300, 6);
    const calls = [];
    globalThis.GeoTIFF = { fromUrl: async (url) => { calls.push(url); return {
      getImageCount: async () => 1, getImage: async () => ({ getBoundingBox: () => [0, 0, 10, 10] }) }; } };
    route({});
    S._canopyTileError = 'stale';
    const res = await app._fetchCanopyFromProxy('https://proxy.example', grid);
    const qks = metaQuadkeysForBBox(grid.bounds.west, grid.bounds.south, grid.bounds.east, grid.bounds.north);
    expect(res).toBeNull();
    expect(calls).toHaveLength(qks.length);                 // one read per tile, no retry loop
    expect(globalThis.fetch.mock.calls.some(c => c[1] && c[1].method === 'HEAD')).toBe(false);
    expect(S._canopyTileError).toBeNull();
  });

  it('NAIP-CHM: a partial grid (a quarter-quad missing) is NOT cached as complete', async () => {
    // A grid straddling a 3.75′ quarter-quad edge, with only one of its quads in the index.
    const grid = makeGrid(38.6875, -120.99, 400, 6);
    const b = grid.bounds;
    const quads = naipQuarterQuadsForBBox(b.west, b.south, b.east, b.north, 16);
    expect(quads.length).toBeGreaterThan(1);
    const e = {}; e[quads[0].key] = '2022/10_060_20220721';
    route({ 'data/naipchm/': resp({ v: 1, e }) });
    S._naipIndex = {};
    const nw = latLngToUtm(b.north, b.west, 10);
    const size = 600;
    const img = {
      fileDirectory: { TileWidth: 512, BitsPerSample: 16 },
      getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 26910 }),
      getOrigin: () => [nw.x - 150, nw.y + 150, 0], getResolution: () => [3, -3, 0],
      getWidth: () => size, getHeight: () => size,
      readRasters: async ({ window: [x0, y0, x1, y1] }) => [new Uint16Array((x1 - x0) * (y1 - y0)).fill(1200)],
    };
    globalThis.GeoTIFF = { fromUrl: async () => ({ getImageCount: async () => 1, getImage: async () => img }) };
    const res = await app._fetchNaipChmRaster('https://proxy.example', grid);
    expect(res && res.tilesFailed).toBeGreaterThan(0);
    expect(globalThis.cacheRaster.mock.calls.some(c => c[0] === 'canopy')).toBe(false);
  });
});

// ------------------------------------------------------------------
describe('M20 — fetcher resilience', () => {
  const EDC = { lat: 38.715, lng: -120.80 };
  const edcBounds = () => bbox(EDC.lat, EDC.lng, 0.015);

  it('utility circuits: a capped answer that cannot be completed is INCOMPLETE and not cached', async () => {
    route({
      resultOffset: resp({}, { status: 500 }),
      'mJaJSax0KPHoCNB6': resp(pgeFixture),
      'bWPjFyq029ChCGur': resp(fc([])),
    });
    await app.fetchUtilityWires(edcBounds());
    expect(S.mapLayers.wire_utility_distribution._layers.length).toBeGreaterThan(0);
    expect(globalThis.cacheApiResponse.mock.calls.some(c => c[0] === 'utility_wires' && c[1].includes('pge'))).toBe(false);
    expect(cachedEp('utility_wires')).toBe(true);   // the complete CEC answer is still cached
    expect(S.sectionMeta.obstacles.sources.utility.status).toBe('error');
    expect(S.sectionMeta.obstacles.sources.utility.partial).toBe(true);
    expect(S.dataSourceErrors['Utility Circuits'].message).toMatch(/incomplete/);
  });

  it('utility circuits: a same-area failure keeps this area\'s lines and count', async () => {
    route({ resultOffset: resp(fc([])), 'mJaJSax0KPHoCNB6': resp(pgeFixture), 'bWPjFyq029ChCGur': resp(fc([])) });
    await app.fetchUtilityWires(edcBounds());
    const n = S.mapLayers.wire_utility_distribution._layers.length;
    expect(n).toBeGreaterThan(0);
    cacheStore = {};
    route({ arcgis: resp({}, { status: 503 }) });
    await app.fetchUtilityWires(edcBounds());
    expect(S.mapLayers.wire_utility_distribution._layers.length).toBe(n);
    expect(S.utilityWireCounts.utility_distribution).toBe(n);
    expect(S.utilityWireInfo['pge-grip-feeders'].stale).toBe(true);
    expect(S._activeFetches['Utility Circuits']).toBeUndefined();
  });

  it('airports: the network is asked first even with a fresh stored copy; lat/lng 0 is kept', async () => {
    const b = bbox(A.lat, A.lng);
    cacheStore['airports_' + app._bboxCacheKey(b)] = { data: { elements: [] }, timestamp: Date.now(), status: 'fresh' };
    route({ interpreter: resp({ elements: [
      { type: 'node', id: 1, lat: A.lat + 0.05, lon: A.lng, tags: { aeroway: 'aerodrome', name: 'Field', icao: 'KFLD' } },
      { type: 'node', id: 2, lat: 0, lon: 0, tags: { aeroway: 'aerodrome', name: 'Null Island' } },
    ], osm3s: { timestamp_osm_base: new Date().toISOString() } }) });
    await app.fetchNearbyAirports(A, b);
    expect(globalThis.fetch.mock.calls.some(c => String(c[0]).includes('interpreter'))).toBe(true);
    expect(S.nearbyAirports.map(a => a.name).sort()).toEqual(['Field', 'Null Island']);
    expect(S.sectionMeta.airspace.sources.airports.status).toBe('live');
  });

  it('_fetchGeoJsonLayer: a 200 body without a features array is an error', async () => {
    route({ 'x.test': resp({ type: 'FeatureCollection' }) });
    const r = await app._fetchGeoJsonLayer('ep', 'k', 'https://x.test/q');
    expect(r.features).toBeNull();
    expect(r.error).toMatch(/no features list/);
  });

  it('NWS alerts: a 200 body without a features array is UNVERIFIED, never "no alerts"', async () => {
    route({ 'api.weather.gov': resp({ title: 'oops' }) });
    await app.fetchNWSAlerts(A.lat, A.lng);
    expect(S.nwsAlertsUnverified).toBe(true);
    expect(S.sectionMeta.alerts.status).toBe('error');
  });

  it('FAA airspace: a partial result does not stamp the last-data time', async () => {
    route({ ssFJjBXIUyZDrSYZ: url => Promise.resolve(String(url).includes('Class_Airspace') ? resp(fc([])) : resp({}, { status: 500 })) });
    await app.fetchFAAairspace(bbox(A.lat, A.lng));
    expect(globalThis.setLastDataTimestamp).not.toHaveBeenCalled();
  });

  it('ground access + water: a same-area failure keeps the drawn lines', async () => {
    const line = { type: 'Feature', properties: { NAME: '<b>Rd</b>' }, geometry: { type: 'LineString', coordinates: [[-121.01, 38.64], [-120.99, 38.66]] } };
    route({ MapServer: resp(fc([line])) });
    await app.fetchGroundAccess(bbox(A.lat, A.lng));
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(S.mapLayers.usfs_roads._layers).toHaveLength(1);
    expect(S.mapLayers.nhd_water._layers).toHaveLength(2);
    expect(S.mapLayers.usfs_roads._layers[0]).toBeTruthy();
    cacheStore = {};
    route({ MapServer: resp({}, { status: 500 }) });
    await app.fetchGroundAccess(bbox(A.lat, A.lng));
    await app.fetchWaterFeatures(bbox(A.lat, A.lng));
    expect(S.mapLayers.usfs_roads._layers).toHaveLength(1);
    expect(S.mapLayers.nhd_water._layers).toHaveLength(2);
  });

  it('active-fetch tracking is a counter: one source\'s late finish does not clear another run', () => {
    app.trackFetchStart('X'); app.trackFetchStart('X');
    app.trackFetchEnd('X');
    expect(S._activeFetches.X).toBe(1);
    app.trackFetchEnd('X');
    expect(S._activeFetches.X).toBeUndefined();
  });
});

// ------------------------------------------------------------------
describe('M21 — restoreConfig', () => {
  afterEach(() => {
    if (S.autoRefreshInterval) { clearInterval(S.autoRefreshInterval); S.autoRefreshInterval = null; }
    if (S._refreshCountdownInterval) { clearInterval(S._refreshCountdownInterval); S._refreshCountdownInterval = null; }
    S._adsbEnabled = true;
  });

  it('fresh install starts the displayed default auto-refresh; a saved ADS-B "off" is restored', async () => {
    const saved = { cfgAdsbEnabled: '0' };
    globalThis.getAppState = vi.fn(async k => (k in saved ? saved[k] : null));
    globalThis.saveAppState = vi.fn(async () => {});
    S._adsbEnabled = true;
    const sel = document.getElementById('cfgRefreshInterval');
    expect(parseInt(sel.value, 10)).toBeGreaterThan(0);
    await app.restoreConfig();
    expect(S.autoRefreshInterval).toBeTruthy();
    expect(S._adsbEnabled).toBe(false);
    expect(document.getElementById('cfgAdsbEnabled').value).toBe('0');
    expect(text('adsbAircraftList')).toMatch(/disabled/);
  });
});

// ------------------------------------------------------------------
describe('Low — null values are not shown as 0 / -1 / "null"', () => {
  it('AQI null reads "Not reported" (not a green "null")', () => {
    app._commitAqi({ current: { us_aqi: null, pm2_5: null } }, 'k', { live: true });
    expect(text('wxAQI')).toBe('Not reported');
    expect(document.getElementById('wxAQI').classList.contains('green')).toBe(false);
  });

  it('obstacle with no AGL/AMSL is "Height unknown", not "0 ft AGL"', () => {
    S.faaObstacles = fc([pt({ AGL: null, AMSL: null, Type_Code: 'TOWER', OAS_Number: '06-1' })]);
    app.renderObstacleLayer();
    const p = S.mapLayers.faa_obstacles._layers[0].popup;
    expect(p).not.toMatch(/0 ft AGL/);
    expect(p).toMatch(/Height unknown/);
  });

  it('LAANC cell with no ceiling is "unknown", not "-1 ft AGL"', () => {
    S.faaAirspace = { laanc: fc([{ type: 'Feature', properties: { CEILING: null, APT1_NAME: '<x>' }, geometry: { type: 'Polygon', coordinates: [square(A.lat, A.lng, 0.01)] } }]) };
    app.renderFAAairspaceLayers();
    const p = S.mapLayers.faa_laanc._layers[0].popup;
    expect(p).not.toMatch(/-1 ft/);
    expect(p).toMatch(/unknown/);
    expect(p).toMatch(/&lt;x&gt;/);
  });

  it('clearing imported NOTAMs rewrites the restriction cache', () => {
    S.importedNotams = [{ id: 'N1' }];
    app.clearImportedNotams();
    expect(globalThis.cacheApiResponse.mock.calls.some(c => c[0] === 'tfr_import' && c[2].notams.length === 0)).toBe(true);
  });
});
