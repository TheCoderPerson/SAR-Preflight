// Follow-up to BUG_REVIEW.md: the remaining area data sources (protected
// areas, FAA obstacles, sun times, elevation, airports, hospitals, trails,
// wires) must (1) never turn a failure into "none found", (2) never let
// another area's values stand in after a failure, (3) drop late answers for
// an area that is no longer selected, and (4) label Service-Worker offline
// copies as cached rather than live.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
Object.assign(globalThis, core);

// Permissive Leaflet mock: unknown calls chain harmlessly; layer groups keep
// real arrays so tests can see what was drawn.
function chain() {
  const fn = function () { return chain(); };
  return new Proxy(fn, { get(t, p) { if (p === 'then') return undefined; if (p in t) return t[p]; return chain(); } });
}
function mockLayerGroup() {
  const g = { _layers: [], addTo() { return g; }, clearLayers() { g._layers.length = 0; }, addLayer(l) { g._layers.push(l); },
    getLayers() { return g._layers; }, eachLayer(cb) { g._layers.forEach(cb); }, hasLayer() { return false; }, removeLayer() {} };
  return g;
}
// A fluent layer: every method returns the same layer, and addTo(group) records it.
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
  };
}
const fc = features => ({ type: 'FeatureCollection', features });
const pt = (props, lng = -121, lat = 38.65) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props });
const bbox = (lat, lng, d = 0.02) => ({
  getSouthWest: () => ({ lat: lat - d, lng: lng - d }), getNorthEast: () => ({ lat: lat + d, lng: lng + d }),
  getCenter: () => ({ lat, lng }),
});
const A = { lat: 38.65, lng: -121.0 }, B = { lat: 39.53, lng: -119.81 };
const text = id => document.getElementById(id).textContent;

let cacheStore;
beforeEach(() => {
  document.body.innerHTML = APP_BODY;
  S.map = new Proxy({ hasLayer: () => false, addLayer() {}, removeLayer() {} }, { get(t, p) { return p in t ? t[p] : chain(); } });
  S.mapLayers = {};
  S.sectionMeta = {}; S.dataSourceErrors = {}; S._dataArea = {};
  S.wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
  S.wind = { maxWind: 5, maxGust: 5 }; S.elev = { center: 2000 };
  S.protectedAreas = null; S.faaObstacles = null; S.nearbyAirports = [];
  S.nwsAlerts = []; S.tfrs = []; S.importedNotams = []; S.activeFires = []; S.adsbAircraft = [];
  S.faaAirspace = null; S.kp = null; S.aqi = null; S.metar = null; S.fireDanger = null; S.autoCheck = null;
  S.landStatus = null; S.cellStatus = null; S.hmsSmoke = null; S.avalanche = null;
  S.areaCenter = A; S.areaBounds = bbox(A.lat, A.lng); S.currentArea = null;
  cacheStore = {};
  globalThis.cacheApiResponse = vi.fn(async (ep, k, data) => { cacheStore[ep + '_' + k] = { data, timestamp: Date.now(), status: 'fresh' }; });
  globalThis.getCachedApiResponse = vi.fn(async (ep, k) => cacheStore[ep + '_' + k] || null);
  globalThis.setLastDataTimestamp = vi.fn();
  globalThis.areaKey = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  globalThis.formatAge = formatAge;
});
afterEach(() => {
  ['cacheApiResponse', 'getCachedApiResponse', 'setLastDataTimestamp', 'areaKey', 'formatAge'].forEach(k => delete globalThis[k]);
  document.body.innerHTML = '';
});

// Route fetch by a substring of the URL.
function route(table) {
  globalThis.fetch = vi.fn((url, opts) => {
    for (const [needle, h] of Object.entries(table)) {
      if (url.includes(needle)) return typeof h === 'function' ? h(url, opts) : Promise.resolve(h);
    }
    return Promise.resolve(resp({}, { status: 404 }));
  });
}
const cached = ep => globalThis.cacheApiResponse.mock.calls.some(c => c[0] === ep);

// ------------------------------------------------------------------
describe('protected areas', () => {
  const ok = { dams: fc([pt({ DAM_NAME: 'Folsom' })]), wild: fc([]), parks: fc([]) };
  const urls = { dams: 'Dams_in_America', wild: 'S_USA_Wilderness', parks: 'NPS_Land_Resources' };

  it('a failed dam layer is UNAVAILABLE (advisory + UNKNOWN cell), never "no dams"', async () => {
    route({ [urls.dams]: resp({}, { status: 500 }), [urls.wild]: resp(ok.wild), [urls.parks]: resp(ok.parks) });
    await app.fetchProtectedAreas(bbox(A.lat, A.lng));
    expect(S.protectedAreas._unavailable).toEqual(['dams']);
    expect(text('protectedAreasStatus')).toMatch(/PARTIAL/);
    expect(text('terrHwy')).toMatch(/UNKNOWN/);
    expect(S.sectionMeta.obstacles.sources.protected.status).toBe('error');
    expect(cached('protected_areas')).toBe(false);
    computeAssessment();
    expect(S.assessment.advisories).toContain('Protected-area data incomplete — Dams unavailable (unverified)');
  });

  it('an ArcGIS error inside an HTTP 200 body is a failure too', async () => {
    route({ [urls.dams]: resp({ error: { code: 400, message: 'Invalid query' } }), [urls.wild]: resp(ok.wild), [urls.parks]: resp(ok.parks) });
    await app.fetchProtectedAreas(bbox(A.lat, A.lng));
    expect(S.protectedAreas._unavailable).toEqual(['dams']);
    expect(S.dataSourceErrors['Protected Areas'].message).toMatch(/Invalid query/);
  });

  it("a failed layer takes this area's cached copy when there is one", async () => {
    route({ [urls.dams]: resp(ok.dams), [urls.wild]: resp(ok.wild), [urls.parks]: resp(ok.parks) });
    await app.fetchProtectedAreas(bbox(A.lat, A.lng));
    route({ [urls.dams]: resp({}, { status: 503 }), [urls.wild]: resp(ok.wild), [urls.parks]: resp(ok.parks) });
    await app.fetchProtectedAreas(bbox(A.lat, A.lng));
    expect(S.protectedAreas.dams.length).toBe(1);
    expect(S.protectedAreas._unavailable).toBeUndefined();
  });

  it("all layers down on a NEW area: the old area's dams are dropped and the banner says unverified", async () => {
    route({ [urls.dams]: resp(ok.dams), [urls.wild]: resp(ok.wild), [urls.parks]: resp(ok.parks) });
    await app.fetchProtectedAreas(bbox(A.lat, A.lng));
    expect(S.protectedAreas.dams.length).toBe(1);
    route({ ArcGIS: resp({}, { status: 500 }), arcgis: resp({}, { status: 500 }) });
    await app.fetchProtectedAreas(bbox(B.lat, B.lng));
    expect(S.protectedAreas.dams).toEqual([]);
    expect(S.protectedAreas._unavailable).toEqual(['dams', 'wilderness', 'nationalParks']);
    expect(text('protectedAreasStatus')).toBe('ERROR');
  });

  it('SW offline copies are labeled cached and not re-saved', async () => {
    const hdr = { headers: { 'X-SAR-SW-Cache': Date.now() - 86400000 } };
    route({ [urls.dams]: resp(ok.dams, hdr), [urls.wild]: resp(ok.wild, hdr), [urls.parks]: resp(ok.parks, hdr) });
    await app.fetchProtectedAreas(bbox(A.lat, A.lng));
    expect(S.sectionMeta.obstacles.sources.protected.status).toBe('cached');
    expect(text('protectedAreasStatus')).toMatch(/CACHED/);
    expect(cached('protected_areas')).toBe(false);
  });

  it("a late answer for the previous area is dropped", async () => {
    const pending = [];
    route({ arcgis: url => new Promise(r => pending.push({ url, r })) });
    const a = app.fetchProtectedAreas(bbox(A.lat, A.lng));
    route({ [urls.dams]: resp(fc([])), [urls.wild]: resp(ok.wild), [urls.parks]: resp(ok.parks) });
    await app.fetchProtectedAreas(bbox(B.lat, B.lng));
    pending.forEach(p => p.r(resp(p.url.includes(urls.dams) ? ok.dams : fc([]))));
    await a;
    expect(S.protectedAreas.dams).toEqual([]);
  });
});

// ------------------------------------------------------------------
describe('FAA obstacles', () => {
  const tall = fc([pt({ AGL: 900, AMSL: 3000 })]);

  it('an ArcGIS error inside HTTP 200 is a failure → "unverified" advisory, not "no obstacles"', async () => {
    route({ Digital_Obstacle_File: resp({ error: { code: 500, message: 'Service busy' } }) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.faaObstacles._unavailable).toBe(true);
    expect(text('obstacleStatus')).toBe('ERROR');
    expect(S.sectionMeta.obstacles.sources.dof.status).toBe('error');
    computeAssessment();
    expect(S.assessment.advisories.some(a => /FAA obstacle data unavailable/.test(a))).toBe(true);
  });

  it("failure on a new area drops the previous area's obstacles", async () => {
    route({ Digital_Obstacle_File: resp(tall) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.faaObstacles.features.length).toBe(1);
    route({ Digital_Obstacle_File: resp({}, { status: 500 }) });
    await app.fetchFaaObstacles(bbox(B.lat, B.lng));
    expect(S.faaObstacles.features).toEqual([]);
    expect(S.faaObstacles._unavailable).toBe(true);
  });

  it('a same-area refresh failure keeps this area’s obstacles (flagged stale)', async () => {
    route({ Digital_Obstacle_File: resp(tall) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    delete cacheStore[Object.keys(cacheStore)[0]];
    route({ Digital_Obstacle_File: resp({}, { status: 500 }) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.faaObstacles.features.length).toBe(1);
    expect(text('terrObstacles')).toMatch(/stale/i);
  });

  it('SW offline copy → cached label, not re-saved', async () => {
    route({ Digital_Obstacle_File: resp(tall, { headers: { 'X-SAR-SW-Cache': 'unknown' } }) });
    await app.fetchFaaObstacles(bbox(A.lat, A.lng));
    expect(S.sectionMeta.obstacles.sources.dof.status).toBe('cached');
    expect(text('obstacleStatus')).toMatch(/CACHED \(age unknown\)/);
    expect(cached('faa_obstacles')).toBe(false);
  });

  it('a late answer for the previous area is dropped', async () => {
    let releaseA;
    route({ Digital_Obstacle_File: () => new Promise(r => { releaseA = r; }) });
    const a = app.fetchFaaObstacles(bbox(A.lat, A.lng));
    route({ Digital_Obstacle_File: resp(fc([])) });
    await app.fetchFaaObstacles(bbox(B.lat, B.lng));
    releaseA(resp(tall));
    await a;
    expect(S.faaObstacles.features).toEqual([]);
  });
});

// ------------------------------------------------------------------
describe('sun times', () => {
  it('a refused request is an error, not a panel stuck on "Fetching..."', async () => {
    route({ 'api.sunrise-sunset.org': resp({ status: 'INVALID_REQUEST', results: '' }) });
    await app.fetchSunMoon(A.lat, A.lng);
    expect(text('astroStatus')).toBe('ERROR');
    expect(S.dataSourceErrors['Sun/Moon'].message).toMatch(/INVALID_REQUEST/);
    expect(S.sectionMeta.solar.status).toBe('error');
  });

  it('HTTP 429 is an error', async () => {
    route({ 'api.sunrise-sunset.org': resp({ status: 'OK', results: {} }, { status: 429 }) });
    await app.fetchSunMoon(A.lat, A.lng);
    expect(S.dataSourceErrors['Sun/Moon'].message).toMatch(/429/);
  });

  it('SW offline copy → cached label, not re-saved', async () => {
    const r = { sunrise: '2026-09-22T13:50:00+00:00', sunset: '2026-09-23T01:55:00+00:00', civil_twilight_begin: '2026-09-22T13:24:00+00:00',
      civil_twilight_end: '2026-09-23T02:21:00+00:00', nautical_twilight_begin: '2026-09-22T12:54:00+00:00', nautical_twilight_end: '2026-09-23T02:51:00+00:00', solar_noon: '2026-09-22T19:52:00+00:00' };
    route({ 'api.sunrise-sunset.org': resp({ status: 'OK', results: r }, { headers: { 'X-SAR-SW-Cache': Date.now() - 3600e3 } }) });
    await app.fetchSunMoon(A.lat, A.lng);
    expect(S.sectionMeta.solar.status).toBe('cached');
    expect(text('astroStatus')).toMatch(/CACHED/);
    expect(cached('sunrise')).toBe(false);
  });
});

// ------------------------------------------------------------------
describe('elevation (USGS 3DEP, Open-Meteo fallback)', () => {
  const M = ft => ft / 3.28084;
  // How many grid points a request asked for (3DEP multipoint / Open-Meteo CSV).
  const nPoints = url => {
    const u = new URL(url);
    if (u.pathname.includes('getSamples')) return JSON.parse(u.searchParams.get('geometry')).points.length;
    return u.searchParams.get('latitude').split(',').length;
  };
  // 3DEP answer: string values, REVERSED order (matched by locationId), `skip` ids omitted.
  const dep = (ft, skip = []) => url => Promise.resolve(resp({ samples: Array.from({ length: nPoints(url) }, (_, i) => i)
    .filter(i => !skip.includes(i)).reverse().map(i => ({ locationId: i, value: String(M(i === 0 ? ft : ft + 10 * i)) })) }));
  const meteo = ft => url => Promise.resolve(resp({ elevation: Array.from({ length: nPoints(url) }, () => M(ft)) }));

  it('uses 3DEP, matching out-of-order string samples by locationId', async () => {
    route({ getSamples: dep(2000) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.elev.center).toBe(2000 + 10 * 12); // grid index 12 = the centre (row-major from the SW corner)
    expect(S.elev.max).toBe(2000 + 10 * 24);    // 25-point grid
    expect(text('elevStatus')).toBe('LIVE · 3DEP');
    expect(S.sectionMeta.elevation.status).toBe('live');
    expect(cacheStore['elevation_' + areaKey(A.lat, A.lng)].data.source).toBe('USGS 3DEP');
  });

  it('outside 3DEP coverage (points omitted) the WHOLE grid comes from Open-Meteo', async () => {
    route({ getSamples: dep(2000, [3, 7]), '/v1/elevation': meteo(150) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.elev.center).toBe(150);
    expect(S.elev.max).toBe(150);               // no mixing of the two DEMs
    expect(text('elevStatus')).toBe('LIVE · COPERNICUS');
  });

  it('3DEP HTTP error → Open-Meteo; both down → error naming both', async () => {
    route({ getSamples: resp({}, { status: 503 }), '/v1/elevation': meteo(900) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.elev.center).toBe(900);
    route({ getSamples: resp({ error: { code: 500, message: 'Busy' } }), '/v1/elevation': resp({ elevation: [1, null] }) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.dataSourceErrors.Elevation.message).toMatch(/3DEP: Busy.*Open-Meteo/);
  });

  it("failure on a NEW area drops the old area's elevation → 'Elevation missing, assuming 9,000 ft (worst case)'", async () => {
    route({ getSamples: dep(7000) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.elev.center).toBe(7120);
    route({ getSamples: resp({}, { status: 504 }), '/v1/elevation': resp({}, { status: 502 }) });
    S.areaCenter = B;
    await app.fetchElevation(B, bbox(B.lat, B.lng));
    expect(S.elev.center).toBeUndefined();
    expect(S.dataSourceErrors.Elevation.message).toMatch(/504.*502/);
    computeAssessment();
    expect(S.assessment.advisories.some(a => a.startsWith('Elevation missing, assuming 9,000 ft (worst case)'))).toBe(true);
    expect(S.assessment.advisories).not.toContain('High elevation');
  });

  it('a SW offline copy is labeled cached and not re-saved', async () => {
    route({ getSamples: url => dep(2000)(url).then(r => Object.assign(r, { headers: { get: k => /x-sar-sw-cache/i.test(k) ? String(Date.now() - 3600e3) : null } })) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.sectionMeta.elevation.status).toBe('cached');
    expect(text('elevStatus')).toMatch(/^CACHED .* · 3DEP$/);
    expect(cached('elevation')).toBe(false);
  });

  it('a newer area CANCELS the old request (aborted signal) and its late answer is dropped', async () => {
    let releaseA, signalA;
    route({ getSamples: (url, opts) => { signalA = opts.signal; return new Promise(r => { releaseA = () => r(dep(9000)(url)); }); } });
    const a = app.fetchElevation(A, bbox(A.lat, A.lng));
    route({ getSamples: dep(4000) });
    await app.fetchElevation(B, bbox(B.lat, B.lng));
    expect(signalA.aborted).toBe(true);
    releaseA();
    await a;
    expect(S.elev.center).toBe(4120);
  });
});

// ------------------------------------------------------------------
describe('utility wires (PG&E feeders + CEC transmission)', () => {
  const line = fc([{ type: 'Feature', properties: { FEEDERID: 'X1' },
    geometry: { type: 'LineString', coordinates: [[-121.0, 38.65], [-121.01, 38.66]] } }]);

  it('SW offline copies make the line "cached" and are not re-saved', async () => {
    const hdr = { headers: { 'X-SAR-SW-Cache': Date.now() - 86400000 } };
    route({ DRPComplianceRelProd: resp(line, hdr), Transmission_Line: resp(fc([]), hdr) });
    await app.fetchUtilityWires(bbox(A.lat, A.lng));
    expect(S.sectionMeta.obstacles.sources.utility.status).toBe('cached');
    expect(cached('utility_wires')).toBe(false);
  });

  it('one source cached, the other live → still "cached" (the live one cannot relabel it)', async () => {
    route({ DRPComplianceRelProd: resp(line, { headers: { 'X-SAR-SW-Cache': 'unknown' } }), Transmission_Line: resp(fc([])) });
    await app.fetchUtilityWires(bbox(A.lat, A.lng));
    expect(S.sectionMeta.obstacles.sources.utility.status).toBe('cached');
  });

  it('a late answer for the previous area does not draw into the new layers', async () => {
    const pending = [];
    route({ arcgis: () => new Promise(r => pending.push(r)), ArcGIS: () => new Promise(r => pending.push(r)) });
    const a = app.fetchUtilityWires(bbox(A.lat, A.lng));
    route({ DRPComplianceRelProd: resp(fc([])), Transmission_Line: resp(fc([])) });
    await app.fetchUtilityWires(bbox(A.lat + 0.001, A.lng));
    pending.forEach(r => r(resp(line)));
    await a;
    expect(S.utilityWireCounts.utility_distribution || 0).toBe(0);
  });
});

// ------------------------------------------------------------------
describe('Overpass sources (airports, hospitals, trails, wires)', () => {
  const timeout = { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 30 seconds.' };
  const hospital = { elements: [{ type: 'node', id: 1, lat: 38.66, lon: -121.01, tags: { amenity: 'hospital', name: 'Mercy' } }] };

  it('a "runtime error" remark is a failure that moves on to the next mirror', async () => {
    let n = 0;
    route({ 'overpass-api.de': resp(timeout), 'kumi.systems': () => { n++; return Promise.resolve(resp(hospital)); } });
    const data = await app._overpassFetch('[out:json];node(1);out;');
    expect(n).toBe(1);
    expect(data.elements.length).toBe(1);
  });

  // A mirror that never answers but honours abort, like a real hung request.
  const hang = (seen) => (url, opts) => new Promise((_, rej) => {
    if (seen) seen.push(url);
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  });

  it('time limit: a hung mirror is abandoned and the next one answers', async () => {
    route({ 'overpass-api.de': hang(), 'kumi.systems': resp(hospital) });
    const t0 = Date.now();
    const data = await app._overpassFetch('q', { timeoutMs: 60 });
    expect(data.elements.length).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('time limit: all mirrors hung → rejects within the overall cap (2 × per-mirror)', async () => {
    const seen = [];
    route({ overpass: hang(seen), 'mail.ru': hang(seen) });
    const t0 = Date.now();
    await expect(app._overpassFetch('q', { timeoutMs: 60 })).rejects.toThrow(/no answer within/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('the per-mirror limit follows the query [timeout:N] + 10 s, clamped 15–90 s', () => {
    expect(overpassMirrorTimeoutMs('[out:json][timeout:30];')).toBe(40000);
    expect(overpassMirrorTimeoutMs('[out:json][timeout:60];')).toBe(70000);
    expect(overpassMirrorTimeoutMs('[out:json];')).toBe(40000);
    expect(overpassMirrorTimeoutMs('[timeout:1]')).toBe(15000);
    expect(overpassMirrorTimeoutMs('[timeout:900]')).toBe(90000);
  });

  it('cancellation: a newer area aborts the old Overpass request and no further mirror is tried', async () => {
    const seen = [];
    route({ overpass: hang(seen), 'mail.ru': hang(seen) });
    const a = app.fetchHospitals(bbox(A.lat, A.lng));
    await Promise.resolve();
    route({ overpass: resp({ elements: [] }), 'mail.ru': resp({ elements: [] }) });
    await app.fetchHospitals(bbox(B.lat, B.lng));
    await a;                               // settles promptly: it was cancelled, not timed out
    expect(seen.length).toBe(1);           // A stopped after its first mirror
    expect(text('terrHospitals')).toBe('None found in area');
    expect(S.dataSourceErrors.Hospitals).toBeUndefined();
  });

  it('cancellation: selecting a new area (invalidateAreaRequests) aborts in-flight Overpass work', async () => {
    let sig;
    route({ overpass: (url, opts) => { sig = opts.signal; return hang()(url, opts); } });
    const a = app.fetchTrails(bbox(A.lat, A.lng));
    await Promise.resolve();
    app.invalidateAreaRequests();
    await a;
    expect(sig.aborted).toBe(true);
  });

  it('every mirror timing out rejects instead of returning "nothing here"', async () => {
    route({ 'overpass': resp(timeout), 'mail.ru': resp(timeout) });
    await expect(app._overpassFetch('q')).rejects.toThrow(/timed out/);
  });

  it("hospitals: all mirrors timing out on a new area clears the old area's markers", async () => {
    route({ overpass: resp(hospital), 'mail.ru': resp(hospital) });
    await app.fetchHospitals(bbox(A.lat, A.lng));
    expect(S.mapLayers.hospitals._layers.length).toBeGreaterThan(0);
    route({ overpass: resp(timeout), 'mail.ru': resp(timeout) });
    await app.fetchHospitals(bbox(B.lat, B.lng));
    expect(S.mapLayers.hospitals._layers.length).toBe(0);
    expect(text('terrHospitals')).toMatch(/Unavailable/);
    expect(S.sectionMeta.hospitals.error).toMatch(/timed out/);
  });

  it('hospitals: a late answer for the previous area is dropped', async () => {
    let releaseA;
    route({ overpass: () => new Promise(r => { releaseA = r; }) });
    const a = app.fetchHospitals(bbox(A.lat, A.lng));
    route({ overpass: resp({ elements: [] }), 'mail.ru': resp({ elements: [] }) });
    await app.fetchHospitals(bbox(B.lat, B.lng));
    releaseA(resp(hospital));
    await a;
    expect(S.mapLayers.hospitals._layers.length).toBe(0);
    expect(text('terrHospitals')).toBe('None found in area');
  });

  it("airports: failure on a new area empties the list; a same-area failure keeps it", async () => {
    const apt = { elements: [{ type: 'node', id: 7, lat: 38.7, lon: -121.0, tags: { aeroway: 'aerodrome', name: 'Test Field', icao: 'KTST' } }] };
    route({ overpass: resp(apt), 'mail.ru': resp(apt) });
    await app.fetchNearbyAirports(A, bbox(A.lat, A.lng));
    const n = S.nearbyAirports.length;
    expect(n).toBeGreaterThan(0);
    cacheStore = {};                       // no saved copy to fall back on
    route({ overpass: resp(timeout), 'mail.ru': resp(timeout) });
    await app.fetchNearbyAirports(A, bbox(A.lat, A.lng));
    expect(S.nearbyAirports.length).toBe(n);
    await app.fetchNearbyAirports(B, bbox(B.lat, B.lng));
    expect(S.nearbyAirports).toEqual([]);
  });

  it("trails: all mirrors timing out on a new area clears the old area's trails", async () => {
    const trail = { elements: [
      { type: 'way', id: 9, tags: { highway: 'path', name: 'Rim Trail' }, geometry: [{ lat: 38.65, lon: -121.0 }, { lat: 38.66, lon: -121.01 }] }] };
    route({ overpass: resp(trail), 'mail.ru': resp(trail) });
    await app.fetchTrails(bbox(A.lat, A.lng));
    expect(S.mapLayers.trails._layers.length).toBeGreaterThan(0);
    route({ overpass: resp(timeout), 'mail.ru': resp(timeout) });
    await app.fetchTrails(bbox(B.lat, B.lng));
    expect(S.mapLayers.trails._layers.length).toBe(0);
    expect(text('terrTrails')).toMatch(/Unavailable/);
  });

  it('wires: a late answer for the previous area does not overwrite the counts', async () => {
    const line = { elements: [
      { type: 'node', id: 1, lat: 38.65, lon: -121.0 }, { type: 'node', id: 2, lat: 38.66, lon: -121.0 },
      { type: 'way', id: 3, nodes: [1, 2], tags: { power: 'line' } }] };
    let releaseA;
    route({ overpass: () => new Promise(r => { releaseA = r; }) });
    const a = app.fetchWireHazards(bbox(A.lat, A.lng));
    route({ overpass: resp({ elements: [] }), 'mail.ru': resp({ elements: [] }) });
    await app.fetchWireHazards(bbox(B.lat, B.lng));
    releaseA(resp(line));
    await a;
    expect(Object.values(S.wireHazardCounts).reduce((x, y) => x + y, 0)).toBe(0);
  });
});

// ------------------------------------------------------------------
// Second review round (four findings).
const areaLayer = (lat, lng, d = 0.02) => ({
  getBounds: () => bbox(lat, lng, d),
  getLatLngs: () => [[{ lat: lat - d, lng: lng - d }, { lat: lat - d, lng: lng + d }, { lat: lat + d, lng: lng + d }, { lat: lat + d, lng: lng - d }]],
});

describe('FAA airspace — ownership and total failure', () => {
  const FAA = 'ssFJjBXIUyZDrSYZ';
  const prohibited = fc([{ type: 'Feature', properties: { NAME: 'P-99 TEST', TYPE_CODE: 'P' },
    geometry: { type: 'Polygon', coordinates: [[[-120, 39.5], [-119.7, 39.5], [-119.7, 39.6], [-120, 39.6], [-120, 39.5]]] } }]);

  it("a delayed empty answer for area A cannot erase area B's prohibited airspace", async () => {
    const pendingA = [];
    route({ [FAA]: url => new Promise(r => pendingA.push({ url, r })) });
    const a = app.fetchFAAairspace(bbox(A.lat, A.lng));
    app.invalidateAreaRequests();            // area B selected
    S.areaCenter = B; S.areaBounds = bbox(B.lat, B.lng); S.currentArea = areaLayer(B.lat, B.lng);
    route({ [FAA]: url => Promise.resolve(resp(url.includes('Special_Use_Airspace') ? prohibited : fc([]))) });
    await app.fetchFAAairspace(bbox(B.lat, B.lng));
    computeAssessment();
    expect(S.assessment.limits.some(l => /Prohibited airspace: P-99 TEST/.test(l))).toBe(true);
    pendingA.forEach(p => p.r(resp(fc([]))));      // A answers late: "nothing here"
    await a;
    expect(S.faaAirspace.sua.features.length).toBe(1);
    computeAssessment();
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(S.assessment.limits.some(l => /Prohibited airspace/.test(l))).toBe(true);
  });

  it('all six FAA requests failing with no cache → "airspace unverified" advisory, never NOMINAL', async () => {
    S.currentArea = areaLayer(A.lat, A.lng);
    route({ [FAA]: resp({}, { status: 503 }) });
    await app.fetchFAAairspace(bbox(A.lat, A.lng));
    expect(text('faaAirspaceStatus')).toBe('ERROR');
    computeAssessment();
    expect(S.assessment.label).not.toBe('NOMINAL');
    expect(S.assessment.advisories.some(a => /FAA airspace UNVERIFIED/.test(a))).toBe(true);
  });

  it("total failure on a NEW area drops the old area's airspace instead of judging by it", async () => {
    S.areaCenter = B; S.currentArea = areaLayer(B.lat, B.lng);
    route({ [FAA]: url => Promise.resolve(resp(url.includes('Special_Use_Airspace') ? prohibited : fc([]))) });
    await app.fetchFAAairspace(bbox(B.lat, B.lng));
    S.areaCenter = A; S.currentArea = areaLayer(A.lat, A.lng);
    route({ [FAA]: resp({}, { status: 503 }) });
    await app.fetchFAAairspace(bbox(A.lat, A.lng));
    computeAssessment();
    expect(S.assessment.limits.some(l => /P-99/.test(l))).toBe(false);
    expect(S.assessment.advisories.some(a => /FAA airspace UNVERIFIED/.test(a))).toBe(true);
  });

  it('an area with no airspace data loaded at all is unverified, not clear', () => {
    S.currentArea = areaLayer(A.lat, A.lng);
    S.faaAirspace = null;
    computeAssessment();
    expect(S.assessment.advisories.some(a => /FAA airspace UNVERIFIED/.test(a))).toBe(true);
  });
});

describe('elevation grid — launch elevation is the CENTRE sample', () => {
  // 25-point grid, row-major from the SW corner: index 12 is the centre.
  const samples = url => {
    const n = JSON.parse(new URL(url).searchParams.get('geometry')).points.length;
    return { samples: Array.from({ length: n }, (_, i) => ({ locationId: i, value: String((i === 12 ? 6562 : 328) / 3.28084) })) };
  };

  it('live: the centre is 6,562 ft even though the SW corner is 328 ft', async () => {
    route({ getSamples: url => Promise.resolve(resp(samples(url))) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.elev.center).toBe(6562);
    expect(text('terrLaunch')).toMatch(/6,562/);
  });

  it('cached: the IndexedDB copy also yields the centre sample', async () => {
    route({ getSamples: url => Promise.resolve(resp(samples(url))) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    S.elev = {};
    route({ getSamples: resp({}, { status: 503 }), '/v1/elevation': resp({}, { status: 503 }) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.sectionMeta.elevation.status).toBe('cached');
    expect(S.elev.center).toBe(6562);
  });

  it('cached copies written before the fix (no stored centre index) still resolve the centre', async () => {
    cacheStore['elevation_' + areaKey(A.lat, A.lng)] = {
      timestamp: Date.now() - 3600e3, status: 'stale',
      data: { results: Array.from({ length: 25 }, (_, i) => ({ elevation: (i === 12 ? 6562 : 328) / 3.28084 })) },
    };
    route({ getSamples: resp({}, { status: 503 }), '/v1/elevation': resp({}, { status: 503 }) });
    await app.fetchElevation(A, bbox(A.lat, A.lng));
    expect(S.elev.center).toBe(6562);
  });
});

describe('ADS-B — the assessment follows live traffic', () => {
  const emergency = { ac: [{ hex: 'a1b2c3', flight: 'TEST77', lat: A.lat, lon: A.lng, alt_baro: 2300, gs: 90, track: 90, squawk: '7700' }] };
  beforeEach(() => {
    S.currentArea = areaLayer(A.lat, A.lng);
    S.faaAirspace = { classAirspace: fc([]), sua: fc([]), tfrs: fc([]), laanc: fc([]), nsRestrictions: fc([]), prohibited: fc([]) };
    S.elev = { center: 2000 };
    S.adsbSearchRadiusNm = 10; S.adsbAircraft = []; S._adsbFailStreak = 0; S._adsbApiIndex = 0;
    S._adsbHiresCache = new Map(); S._adsbHiresFetching = false; S.adsbDem = null;
    computeAssessment();
  });

  it('a poll that brings a squawk-7700 aircraft updates the banner without a separate recompute', async () => {
    expect(S.assessment.label).toBe('NOMINAL');
    route({ adsb: resp(emergency), getSamples: resp({ samples: [] }), 'airplanes.live': resp(emergency) });
    await app.fetchAdsb();
    expect(S.adsbAircraft.length).toBe(1);
    expect(S.assessment.advisories.some(a => /Emergency aircraft nearby \(squawk 7700\)/.test(a))).toBe(true);
    expect(S.assessment.advisories.some(a => /below 500ft AGL within 3nm/.test(a))).toBe(true);
  });

  it('a hi-res terrain refinement that changes AGL recomputes the banner', async () => {
    // Coarse ground 2,000 ft → the aircraft at 3,500 ft reads 1,500 AGL (not "low").
    // 3DEP says the ground under it is 3,200 ft → AGL 300.
    route({ adsb: resp({ ac: [{ hex: 'd4e5f6', flight: 'LOW1', lat: A.lat, lon: A.lng, alt_baro: 3499, squawk: '1200' }] }),
            getSamples: resp({ samples: [] }), 'airplanes.live': resp({ ac: [] }) });
    await app.fetchAdsb();
    await Promise.resolve();
    expect(S.assessment.advisories.some(a => /below 500ft/.test(a))).toBe(false);
    S._adsbHiresCache = new Map(); S._adsbHiresFetching = false;
    route({ getSamples: resp({ samples: [{ locationId: 0, value: String(3200 / 3.28084) }] }) });
    await app.refineLowCloseAdsbAgl();
    expect(S.adsbAircraft[0].agl).toBeLessThan(500);
    expect(S.assessment.advisories.some(a => /below 500ft AGL within 3nm/.test(a))).toBe(true);
  });

  it('a poll answer for a previous area is dropped', async () => {
    let release;
    route({ adsb: () => new Promise(r => { release = r; }), 'airplanes.live': () => new Promise(() => {}) });
    const p = app.fetchAdsb();
    await Promise.resolve();
    app.invalidateAreaRequests();           // a new area was drawn meanwhile
    release(resp(emergency));
    await p;
    expect(S.adsbAircraft).toEqual([]);
  });
});
