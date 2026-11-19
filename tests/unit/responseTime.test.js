// Response Time Estimate — pure helpers (sar-preflight-core.js).
// Fixtures are real answers captured from the live services (Nov 2026):
// Valhalla route / trace_attributes / pedestrian route for Placerville → a
// point north of Wrights Lake, and Caltrans QuickMap KML during a winter storm.
const fs = require('fs');
const path = require('path');
const core = require('../../sar-preflight-core.js');
const {
  DEFAULT_RESPONSE_SETTINGS, normalizeResponseSettings,
  decodePolyline6, polylineCumKm, polylineLengthKm, pointAtKm, samplePolyline, nearestOnPolyline, mergeSamplePoints,
  classifyRoadKind, highwayNumbersFromNames, valhallaError, valhallaRouteLeg, valhallaEdgesToSegments,
  valhallaManeuversToSegments, routeHighwayNumbers, routeHighwayStretches,
  parseRouteWeather, routeConditionsAt, adjustSegmentMph, computeDriveEstimate,
  parseQuickmapKml, matchRouteHazards, summarizeRouteHazards, quickmapNewestUpdateMs, routeTouchesCalifornia,
  mvumSeasonState, mvumAccessFlags, matchMvumRoads,
  ascentFromElevations, hikeTimeMin, chooseHikePlan,
  formatDurationMin, formatMilesKm, summarizeResponseDest, responseBreakdownText, responseRouteKey,
  RESPONSE_KM_PER_MI,
} = core;

const fx = name => path.join(__dirname, '..', 'fixtures', name);
const ROUTE = require('../fixtures/valhalla-route-auto.json');
const TRACE = require('../fixtures/valhalla-trace.json');
const PED = require('../fixtures/valhalla-route-ped.json');
const CC_KML = fs.readFileSync(fx('quickmap-v2_cc.kml'), 'utf8');
const CHIN_KML = fs.readFileSync(fx('quickmap-v2_chin.kml'), 'utf8');

const S0 = normalizeResponseSettings({});
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 18, 20, 0);

// One weather sample holding the same value for every hour.
function wx(alongKm, v) {
  const n = 48;
  const fill = x => Array(n).fill(x);
  return { alongKm, timesMs: Array.from({ length: n }, (_, i) => T0 + i * HOUR),
    rain: fill(v.rain || 0), showers: fill(v.showers || 0), snowfall: fill(v.snowfall || 0),
    snowDepth: fill(v.depth == null ? 0 : v.depth), code: fill(v.code == null ? 0 : v.code) };
}

describe('normalizeResponseSettings', () => {
  it('returns the documented defaults for empty input', () => {
    expect(normalizeResponseSettings(null)).toEqual(DEFAULT_RESPONSE_SETTINGS);
    expect(S0.loadMin).toBe(30);
    expect(S0.rainPct).toBe(25);
    expect(S0.snowMaxMph).toBe(15);
    expect(S0.chainDelayMin).toBe(45);
    expect(S0.forestMph).toBe(15);
  });
  it('clamps out-of-range values and ignores junk', () => {
    const s = normalizeResponseSettings({ loadMin: -5, rainPct: 500, snowMaxMph: 'abc', forestMph: '10', chainDelayMin: '' });
    expect(s.loadMin).toBe(0);
    expect(s.rainPct).toBe(90);
    expect(s.snowMaxMph).toBe(15);
    expect(s.forestMph).toBe(10);
    expect(s.chainDelayMin).toBe(45);
  });
  it('keeps a valid base and drops an invalid one; consent defaults off', () => {
    expect(normalizeResponseSettings({ base: { label: ' Station ', lat: '38.7', lng: -120.8 } }).base).toEqual({ label: 'Station', lat: 38.7, lng: -120.8 });
    expect(normalizeResponseSettings({ base: { lat: 99, lng: 0 } }).base).toBeNull();
    expect(normalizeResponseSettings({ base: { lat: 'x', lng: 0 } }).base).toBeNull();
    expect(S0.consent).toBe(false);
    expect(normalizeResponseSettings({ consent: 1, auto: false })).toMatchObject({ consent: true, auto: false });
  });
});

describe('polyline geometry', () => {
  it('decodes a precision-6 polyline', () => {
    const coords = decodePolyline6(ROUTE.trip.legs[0].shape);
    expect(coords.length).toBe(2385);
    expect(coords[0][0]).toBeCloseTo(38.729567, 5);
    expect(coords[0][1]).toBeCloseTo(-120.79852, 5);
    expect(decodePolyline6(null)).toEqual([]);
    expect(decodePolyline6('')).toEqual([]);
  });
  it('measures length close to the routing engine\'s own figure', () => {
    const coords = decodePolyline6(ROUTE.trip.legs[0].shape);
    expect(polylineLengthKm(coords)).toBeGreaterThan(72.5);
    expect(polylineLengthKm(coords)).toBeLessThan(74);
    expect(polylineLengthKm([])).toBe(0);
    expect(polylineCumKm([[1, 1]])).toEqual([0]);
  });
  const line = [[38, -120], [38, -119.9], [38, -119.8]];
  it('interpolates a point along the line and clamps at the ends', () => {
    const cum = polylineCumKm(line);
    const mid = pointAtKm(line, cum, cum[2] / 2);
    expect(mid[1]).toBeCloseTo(-119.9, 3);
    expect(pointAtKm(line, cum, -5)).toEqual(line[0]);
    expect(pointAtKm(line, cum, 1e6)).toEqual(line[2]);
  });
  it('samples both ends, at the step, capped at maxPts', () => {
    const total = polylineLengthKm(line); // ~17.5 km
    const s = samplePolyline(line, 5, 12);
    expect(s[0].alongKm).toBe(0);
    expect(s[s.length - 1].alongKm).toBeCloseTo(total, 6);
    expect(s.length).toBe(Math.ceil(total / 5) + 1);
    expect(samplePolyline(line, 0.1, 6).length).toBe(6);
    expect(samplePolyline([[38, -120]], 5, 6).length).toBe(1);
    expect(samplePolyline([], 5, 6)).toEqual([]);
  });
  it('finds the nearest point with its distance and position along the line', () => {
    const n = nearestOnPolyline(line, 38.01, -119.95);
    expect(n.distM).toBeGreaterThan(1050);
    expect(n.distM).toBeLessThan(1160);
    expect(n.alongKm).toBeCloseTo(polylineLengthKm(line) / 4, 1);
    expect(nearestOnPolyline(line, 38, -120.1).alongKm).toBe(0); // beyond the start
    expect(nearestOnPolyline([], 1, 1)).toBeNull();
  });
  it('merges sample points that sit close together and stops adding at the cap', () => {
    const a = [{ lat: 38, lng: -120 }, { lat: 38.2, lng: -120 }];
    const b = [{ lat: 38.001, lng: -120 }, { lat: 38.5, lng: -120 }];
    const m = mergeSamplePoints([a, b], 3, 30);
    expect(m.points.length).toBe(3);
    expect(m.maps).toEqual([[0, 1], [0, 2]]);
    const capped = mergeSamplePoints([a, b], 3, 2);
    expect(capped.points.length).toBe(2);
    expect(capped.maps[1]).toEqual([0, 1]); // the far point reuses the nearest existing one
  });
});

describe('Valhalla adapters', () => {
  it('classifies road kind from surface and road class', () => {
    expect(classifyRoadKind({ road_class: 'motorway', surface: 'paved_smooth', unpaved: false, use: 'road' })).toBe('highway');
    expect(classifyRoadKind({ road_class: 'secondary', surface: 'paved' })).toBe('highway');
    expect(classifyRoadKind({ road_class: 'tertiary', surface: 'paved_smooth' })).toBe('local');
    expect(classifyRoadKind({ road_class: 'unclassified', surface: 'paved_smooth', unpaved: false })).toBe('local');
    expect(classifyRoadKind({ road_class: 'service_other', surface: 'dirt', unpaved: true, use: 'track' })).toBe('forest');
    expect(classifyRoadKind({ road_class: 'unclassified', surface: 'gravel' })).toBe('forest');
    expect(classifyRoadKind({ road_class: 'trunk', unpaved: true })).toBe('forest');
    expect(classifyRoadKind(null)).toBe('local');
  });
  it('reads numbered-highway numbers and ignores forest / county routes', () => {
    expect(highwayNumbersFromNames(['US 50', 'Route 50'])).toEqual([50]);
    expect(highwayNumbersFromNames(['CA 89', 'I 80', 'SR-49', 'Highway 180'])).toEqual([89, 80, 49, 180]);
    expect(highwayNumbersFromNames(['Forest Route 3', 'US Forest Service Road 3', 'County Road 12', 'Wrights Lake Road'])).toEqual([]);
    expect(highwayNumbersFromNames(null)).toEqual([]);
  });
  it('parses a route leg', () => {
    const leg = valhallaRouteLeg(ROUTE);
    expect(leg.km).toBeCloseTo(73.38, 2);
    expect(leg.sec).toBeCloseTo(4600.457, 2);
    expect(leg.coords.length).toBe(2385);
    expect(leg.maneuvers.length).toBe(5); // the zero-length arrival maneuver is dropped
    expect(leg.maneuvers[4]).toMatchObject({ rough: true, km: 2.168 });
    expect(valhallaRouteLeg({})).toBeNull();
    expect(valhallaRouteLeg({ trip: { status: 1, legs: [] } })).toBeNull();
  });
  it('builds merged segments from trace_attributes with per-edge surface', () => {
    const t = valhallaEdgesToSegments(TRACE);
    expect(t.km).toBeCloseTo(73.376, 2);
    expect(t.segments.length).toBeLessThan(40);
    const kinds = t.segments.reduce((a, s) => { a[s.kind] = (a[s.kind] || 0) + s.km; return a; }, {});
    expect(kinds.forest).toBeCloseTo(2.168, 2);          // the jeep trail only
    expect(kinds.highway).toBeCloseTo(0.061 + 14.605 + 42.393, 2);
    expect(kinds.local).toBeCloseTo(0.078 + 14.071, 2);  // Wrights Lake Road is paved: NOT forest
    const sec = t.segments.reduce((a, s) => a + s.baseSec, 0);
    expect(Math.abs(sec - 4600.457)).toBeLessThan(60);   // free-flow sum ≈ the route's own time
    const last = t.segments[t.segments.length - 1];
    expect(last).toMatchObject({ kind: 'forest', name: 'Barret Lake Jeep Trail (12N77)' });
    expect(last.i1).toBe(2383);
  });
  it('rejects a trace it cannot time', () => {
    expect(valhallaEdgesToSegments(null)).toBeNull();
    expect(valhallaEdgesToSegments({ shape: TRACE.shape, edges: [] })).toBeNull();
    expect(valhallaEdgesToSegments({ shape: TRACE.shape, edges: [{ length: 1, speed: 0 }] })).toBeNull();
  });
  it('falls back to maneuvers: a rough maneuver is forest road in full', () => {
    const segs = valhallaManeuversToSegments(valhallaRouteLeg(ROUTE));
    expect(segs.map(s => s.kind)).toEqual(['local', 'local', 'highway', 'local', 'forest']);
    expect(segs[2].baseSec).toBeCloseTo(2156.178, 2);
  });
  it('lists the highway numbers a route uses', () => {
    expect(routeHighwayNumbers(valhallaEdgesToSegments(TRACE).segments)).toEqual([50]);
  });
  it('keeps a shared highway number on the stretch that carries it', () => {
    // Measured Nov 2026, Placerville → Meyers: 83 km of US 50, the last 1.3 km
    // also signed CA 89. Merging on the first name alone put "CA 89" on all of it.
    const edge = (names, km) => ({ length: km, speed: 80, road_class: 'trunk', names });
    const t = valhallaEdgesToSegments({ shape: TRACE.shape, units: 'kilometers', edges: [
      edge(['US 50', 'Route 50'], 40), edge(['US 50'], 43),
      edge(['US 50', 'CA 89'], 0.8), edge(['CA 89', 'US 50', 'Route 50'], 0.5),
    ] });
    expect(t.segments.length).toBe(3);                      // a different first name still splits
    expect(t.segments[0].km).toBeCloseTo(83, 6);
    expect(t.segments[0].names).toEqual(['US 50', 'Route 50']);
    const st = routeHighwayStretches(t.segments);
    expect(st.map(s => s.num)).toEqual([50, 89]);
    expect(st[0].fromKm).toBe(0);
    expect(st[0].toKm).toBeCloseTo(84.3, 6);
    expect(st[1].fromKm).toBeCloseTo(83, 6);                 // NOT 0
    expect(st[1].toKm).toBeCloseTo(84.3, 6);
  });
  it('still merges edges whose names differ only by an alias', () => {
    const edge = (names, km) => ({ length: km, speed: 80, road_class: 'trunk', names });
    const t = valhallaEdgesToSegments({ shape: TRACE.shape, units: 'kilometers', edges: [
      edge(['US 50'], 10), edge(['US 50', 'Route 50'], 10), edge(['US 50', 'Some Memorial Highway'], 10),
    ] });
    expect(t.segments.length).toBe(1);
    expect(t.segments[0].km).toBeCloseTo(30, 6);
  });
  it('reads Valhalla error bodies', () => {
    expect(valhallaError({ error_code: 171, error: 'No suitable edges near location' }, 400)).toMatchObject({ noRoad: true, noRoute: false });
    expect(valhallaError({ error_code: 442, error: 'No path could be found for input' }, 400).noRoute).toBe(true);
    expect(valhallaError(null, 503).message).toBe('routing HTTP 503');
  });
  it('parses the pedestrian route used for the hike leg', () => {
    const leg = valhallaRouteLeg(PED);
    expect(leg.km).toBeCloseTo(2.344, 3);
    expect(leg.coords.length).toBe(196);
  });
});

describe('route weather', () => {
  it('parses a multi-point answer (array) and a single-point answer (object)', () => {
    const one = { hourly: { time: [1700000000, 1700003600], rain: [0, 1], showers: [0, 0], snowfall: [0, 0], snow_depth: [0, 0.2], weather_code: [0, 61] } };
    const arr = parseRouteWeather([one, one], 2);
    expect(arr.length).toBe(2);
    expect(arr[0].timesMs).toEqual([1700000000000, 1700003600000]);
    expect(arr[1].snowDepth).toEqual([0, 0.2]);
    expect(parseRouteWeather(one, 1).length).toBe(1);
  });
  it('rejects a short, malformed or error answer', () => {
    const one = { hourly: { time: [1700000000] } };
    expect(parseRouteWeather([one], 2)).toBeNull();
    expect(parseRouteWeather({ error: true, reason: 'x' }, 1)).toBeNull();
    expect(parseRouteWeather([{ hourly: { time: [] } }], 1)).toBeNull();
    expect(parseRouteWeather(null, 1)).toBeNull();
  });
  it('reads conditions at the nearest hour', () => {
    expect(routeConditionsAt(wx(0, {}), T0 + 20 * 60000)).toMatchObject({ known: true, rain: false, snowing: false, snowOnGround: false });
    expect(routeConditionsAt(wx(0, { rain: 0.1, showers: 0.15 }), T0).rain).toBe(true);
    expect(routeConditionsAt(wx(0, { rain: 0.1 }), T0).rain).toBe(false);
    expect(routeConditionsAt(wx(0, { snowfall: 0.2 }), T0).snowing).toBe(true);
    expect(routeConditionsAt(wx(0, { code: 66 }), T0).snowing).toBe(true); // freezing rain counts as snow
    expect(routeConditionsAt(wx(0, { depth: 0.3 }), T0)).toMatchObject({ snowing: false, snowOnGround: true });
  });
  it('is UNKNOWN past the forecast window or with no values — never dry', () => {
    expect(routeConditionsAt(wx(0, {}), T0 + 60 * HOUR).known).toBe(false);
    expect(routeConditionsAt(wx(0, {}), T0 - 3 * HOUR).known).toBe(false);
    expect(routeConditionsAt(null, T0).known).toBe(false);
    const empty = { alongKm: 0, timesMs: [T0], rain: [null], showers: [null], snowfall: [null], snowDepth: [null], code: [null] };
    expect(routeConditionsAt(empty, T0).known).toBe(false);
  });
});

describe('adjustSegmentMph', () => {
  const dry = { known: true, rain: false, snowing: false, snowOnGround: false };
  it('leaves a dry or unknown segment alone', () => {
    expect(adjustSegmentMph(60, dry, 'highway', S0)).toBe(60);
    expect(adjustSegmentMph(60, { known: false }, 'highway', S0)).toBe(60);
  });
  it('rain reduces speed by the configured percent', () => {
    expect(adjustSegmentMph(60, Object.assign({}, dry, { rain: true }), 'highway', S0)).toBe(45);
    expect(adjustSegmentMph(60, Object.assign({}, dry, { rain: true }), 'highway', Object.assign({}, S0, { rainPct: 50 }))).toBe(30);
  });
  it('falling snow caps every kind of road', () => {
    const c = Object.assign({}, dry, { snowing: true });
    expect(adjustSegmentMph(60, c, 'highway', S0)).toBe(15);
    expect(adjustSegmentMph(35, c, 'local', S0)).toBe(15);
    expect(adjustSegmentMph(10, c, 'forest', S0)).toBe(10); // already below the cap
  });
  it('snow on the ground caps local and forest roads but not highways', () => {
    const c = Object.assign({}, dry, { snowOnGround: true });
    expect(adjustSegmentMph(60, c, 'highway', S0)).toBe(60);
    expect(adjustSegmentMph(35, c, 'local', S0)).toBe(15);
    expect(adjustSegmentMph(20, c, 'forest', S0)).toBe(15);
  });
  it('applies rain first, then the snow cap', () => {
    const c = { known: true, rain: true, snowing: true, snowOnGround: false };
    expect(adjustSegmentMph(60, c, 'highway', S0)).toBe(15);
    expect(adjustSegmentMph(12, c, 'forest', S0)).toBe(9);
  });
});

describe('computeDriveEstimate', () => {
  // 60 mi of highway at 60 mph, then 3 mi of forest road.
  const segs = [
    { kind: 'highway', km: 60 * RESPONSE_KM_PER_MI, baseSec: 3600 },
    { kind: 'forest', km: 3 * RESPONSE_KM_PER_MI, baseSec: 2000 }, // the engine's own (slow) track time is ignored
  ];
  const totalKm = 63 * RESPONSE_KM_PER_MI;
  it('times road at the engine speed and forest road at the setting', () => {
    const e = computeDriveEstimate(segs, [wx(0, {}), wx(totalKm, {})], T0, S0);
    expect(e.roadMin).toBeCloseTo(60, 6);
    expect(e.forestMin).toBeCloseTo(12, 6); // 3 mi at 15 mph
    expect(e.roadMi).toBeCloseTo(60, 6);
    expect(e.forestMi).toBeCloseTo(3, 6);
    expect(e.wxKnown).toBe(true);
    expect(e.endMs).toBeCloseTo(T0 + 72 * 60000, -2);
  });
  it('uses a changed forest-road speed', () => {
    const e = computeDriveEstimate(segs, [wx(0, {})], T0, Object.assign({}, S0, { forestMph: 5 }));
    expect(e.forestMin).toBeCloseTo(36, 6);
  });
  it('applies the drive-time adjustment to road, not to forest road', () => {
    const e = computeDriveEstimate(segs, [wx(0, {})], T0, Object.assign({}, S0, { driveAdjustPct: 20 }));
    expect(e.roadMin).toBeCloseTo(72, 6);
    expect(e.forestMin).toBeCloseTo(12, 6);
  });
  it('with no weather reports every mile unknown and does not adjust', () => {
    const e = computeDriveEstimate(segs, null, T0, S0);
    expect(e.driveMin).toBeCloseTo(72, 6);
    expect(e.unknownMi).toBeCloseTo(63, 6);
    expect(e.wxKnown).toBe(false);
  });
  it('slows only the part of the route under rain', () => {
    // Samples at both ends: the boundary is the midpoint (31.5 mi).
    const e = computeDriveEstimate(segs, [wx(0, {}), wx(totalKm, { rain: 1 })], T0, S0);
    expect(e.rainMi).toBeCloseTo(31.5, 4);          // 28.5 mi of highway + 3 mi of forest road
    expect(e.roadMin).toBeCloseTo(31.5 + 28.5 / 45 * 60, 4);
    expect(e.forestMin).toBeCloseTo(3 / (15 * 0.75) * 60, 4);
    expect(e.baseRoadMin).toBeCloseTo(60, 6);
  });
  it('caps the whole route when snow is falling', () => {
    const e = computeDriveEstimate(segs, [wx(0, { snowfall: 1 })], T0, S0);
    expect(e.roadMin).toBeCloseTo(240, 4);          // 60 mi at 15 mph
    expect(e.forestMin).toBeCloseTo(12, 4);
    expect(e.snowMi).toBeCloseTo(63, 4);
  });
  it('snow on the ground slows forest road only (the highway is plowed)', () => {
    const e = computeDriveEstimate(segs, [wx(0, { depth: 0.4 })], T0, Object.assign({}, S0, { forestMph: 20 }));
    expect(e.roadMin).toBeCloseTo(60, 4);
    expect(e.forestMin).toBeCloseTo(12, 4);         // 20 mph capped to 15
    expect(e.groundSnowMi).toBeCloseTo(3, 4);
    expect(e.snowMi).toBe(0);
  });
  it('evaluates each piece at the hour the vehicle reaches it', () => {
    // Rain starts 30 min after departure, at the far sample only.
    const late = wx(totalKm, {});
    late.rain = late.timesMs.map(t => (t >= T0 + HOUR ? 1 : 0));
    const e = computeDriveEstimate(segs, [wx(0, {}), late], T0, S0);
    // First half (31.5 mi) dry; the second half is reached ~31.5 min in — the
    // nearest forecast hour is T0 + 1 h, which is raining.
    expect(e.rainMi).toBeCloseTo(31.5, 4);
    const early = computeDriveEstimate(segs, [wx(0, {}), late], T0 - 2 * HOUR + 1, S0);
    expect(early.rainMi).toBe(0);
  });
  it('marks miles past the forecast window unknown', () => {
    const e = computeDriveEstimate(segs, [wx(0, { rain: 1 })], T0 + 100 * HOUR, S0);
    expect(e.unknownMi).toBeCloseTo(63, 4);
    expect(e.rainMi).toBe(0);
    expect(e.roadMin).toBeCloseTo(60, 4);
  });
  it('runs on the real trace: forest miles are only the jeep trail', () => {
    const t = valhallaEdgesToSegments(TRACE);
    const e = computeDriveEstimate(t.segments, null, T0, S0);
    expect(e.forestMi).toBeCloseTo(2.168 / RESPONSE_KM_PER_MI, 2);
    expect(e.forestMin).toBeCloseTo(2.168 / RESPONSE_KM_PER_MI / 15 * 60, 1);
    expect(e.roadMin).toBeGreaterThan(55);
    expect(e.roadMin).toBeLessThan(65);
  });
});

describe('parseQuickmapKml', () => {
  const cc = parseQuickmapKml(CC_KML);
  const chin = parseQuickmapKml(CHIN_KML);
  it('returns null for anything that is not a KML document', () => {
    expect(parseQuickmapKml('<html><body>Not found</body></html>')).toBeNull();
    expect(parseQuickmapKml('')).toBeNull();
    expect(parseQuickmapKml(null)).toBeNull();
    expect(parseQuickmapKml('<AccessDenied/>')).toBeNull();
  });
  it('returns an empty list for a KML with no placemarks (none active)', () => {
    expect(parseQuickmapKml('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Caltrans Chain Controls</name></Document></kml>')).toEqual([]);
  });
  it('reads chain controls, truck-only requirements and full closures', () => {
    expect(cc.length).toBe(30);
    const kinds = cc.reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {});
    expect(kinds).toEqual({ chain: 12, truck: 12, closure: 6 });
    const tb = cc.find(r => r.kind === 'chain' && r.location === 'Twin Bridges' && r.direction === 'E');
    expect(tb).toMatchObject({ level: 'R-2', hwyNum: 50, title: 'Eastbound US 50' });
    expect(tb.lat).toBeCloseTo(38.81137, 5);
    expect(tb.lng).toBeCloseTo(-120.12263, 5);
    expect(tb.text).toMatch(/^Chains or traction devices are required/);
    expect(tb.updatedMs).toBeGreaterThan(Date.UTC(2026, 10, 18));
  });
  it('a truck-only code is never a chain control', () => {
    cc.filter(r => /^(MIN|MAX|TTA)$/.test(r.level || '')).forEach(r => expect(r.kind).toBe('truck'));
  });
  it('reads a full closure with its highway and location', () => {
    const c = cc.find(r => r.kind === 'closure' && r.hwyNum === 32);
    expect(c).toMatchObject({ title: 'Westbound Highway 32', location: 'Lomo - TEH/BUT county line', text: 'Closed to traffic.', level: null });
  });
  it('reads highway-information points and flags only real road closures', () => {
    expect(chin.length).toBe(15);
    chin.forEach(r => expect(r.kind).toBe('info'));
    const ebbetts = chin.find(r => /EBBETTS/.test(r.text));
    expect(ebbetts).toMatchObject({ hwyNum: 4, closureLikely: true, direction: 'N' });
    expect(chin.find(r => /HIGH WIND ADVISORY/.test(r.text)).closureLikely).toBe(false);
    expect(chin.find(r => /On and Off Ramps/.test(r.text)).closureLikely).toBe(false);   // ramps, not the road
    expect(chin.find(r => /REST AREAS ARE CLOSED/.test(r.text)).closureLikely).toBe(false);
    expect(chin.find(r => /CLOSED TO ALL TRUCKS/.test(r.text)).closureLikely).toBe(false);
  });
  it('reports the newest update stamp', () => {
    expect(quickmapNewestUpdateMs(cc)).toBeGreaterThan(Date.UTC(2026, 10, 18));
    expect(quickmapNewestUpdateMs([])).toBeNull();
  });
});

describe('matchRouteHazards', () => {
  const cc = parseQuickmapKml(CC_KML);
  const t = valhallaEdgesToSegments(TRACE);
  const cum = polylineCumKm(t.coords);
  const stretches = routeHighwayStretches(t.segments);
  const matches = matchRouteHazards(cc, t.coords, cum, stretches);
  const sum = summarizeRouteHazards(matches);
  it('finds the stretch of the route that runs on US 50', () => {
    expect(stretches.length).toBe(1);
    expect(stretches[0].num).toBe(50);
    expect(stretches[0].fromKm).toBeCloseTo(0.139, 2);
    expect(stretches[0].toKm - stretches[0].fromKm).toBeCloseTo(57.0, 0);
  });
  it('finds the eastbound US 50 control the route drives through', () => {
    expect(sum.chainOn.map(m => m.location)).toEqual(["Fred's Place"]);
    expect(sum.chainOn[0]).toMatchObject({ direction: 'E', level: 'R-2', rel: 'onRoute' });
    expect(sum.chainOn[0].distM).toBeLessThanOrEqual(300);
    expect(sum.truck.map(m => m.location)).toEqual(["Fred's Place"]); // listed, but never a delay
  });
  it('ignores controls beyond the point where the route leaves the highway', () => {
    // Wright's Lake, Strawberry and Twin Bridges all sit on US 50 EAST of the
    // Wrights Lake Road turn-off: this route never reaches them.
    expect(sum.chainMay).toEqual([]);
    expect(matches.map(m => m.location)).not.toContain('Strawberry');
    expect(matches.map(m => m.location)).not.toContain("Wright's Lake");
  });
  it('ignores controls on highways the route does not use and far-away closures', () => {
    matches.forEach(m => expect(m.hwyNum).toBe(50));
    expect(sum.closedOn.length).toBe(0);
    expect(sum.closedMay.length).toBe(0);
  });
  it('drops an on-route control that faces the other direction of travel', () => {
    const rec = { kind: 'chain', level: 'R-2', direction: 'W', hwyNum: 50, lat: 38.78058, lng: -120.24378 };
    expect(matchRouteHazards([rec], t.coords, cum, stretches)).toEqual([]);
    expect(matchRouteHazards([Object.assign({}, rec, { direction: 'E' })], t.coords, cum, stretches).length).toBe(1);
  });
  it('keeps an on-route closure whatever its direction', () => {
    const rec = { kind: 'closure', direction: 'W', hwyNum: 50, lat: 38.78058, lng: -120.24378 };
    const s = summarizeRouteHazards(matchRouteHazards([rec], t.coords, cum, stretches));
    expect(s.closedOn.length).toBe(1);
  });
  it('returns nothing without a route', () => {
    expect(matchRouteHazards(cc, [], [], stretches)).toEqual([]);
  });

  // A route that JOINS an east-west highway part-way along it: side road north
  // for 5 km, then east on "CA 88" for 20 km.
  const joinCoords = [[38.60, -120.50], [38.645, -120.50], [38.645, -120.27]];
  const joinCum = polylineCumKm(joinCoords);
  const joinSegs = [{ kind: 'local', km: joinCum[1], names: ['Side Road'] }, { kind: 'highway', km: joinCum[2] - joinCum[1], names: ['CA 88'] }];
  const joinStretches = routeHighwayStretches(joinSegs);
  it('a control that starts before the route joins the highway "may apply"', () => {
    // 6 km WEST of the join point, eastbound: the route enters inside the control.
    const rec = { kind: 'chain', level: 'R-1', direction: 'E', hwyNum: 88, lat: 38.645, lng: -120.569 };
    const m = matchRouteHazards([rec], joinCoords, joinCum, joinStretches);
    expect(m.length).toBe(1);
    expect(m[0].rel).toBe('mayApply');
    expect(summarizeRouteHazards(m).chainMay.length).toBe(1);
  });
  it('but not when it faces the other way, is on another highway, or is too far', () => {
    const base = { kind: 'chain', level: 'R-1', direction: 'E', hwyNum: 88, lat: 38.645, lng: -120.569 };
    expect(matchRouteHazards([Object.assign({}, base, { direction: 'W' })], joinCoords, joinCum, joinStretches)).toEqual([]);
    expect(matchRouteHazards([Object.assign({}, base, { hwyNum: 4 })], joinCoords, joinCum, joinStretches)).toEqual([]);
    expect(matchRouteHazards([Object.assign({}, base, { lng: -120.80 })], joinCoords, joinCum, joinStretches)).toEqual([]); // 26 km away
  });
  it('a closure-worded highway-information point before the join is a possible closure', () => {
    const rec = { kind: 'info', closureLikely: true, hwyNum: 88, lat: 38.645, lng: -120.569 };
    expect(summarizeRouteHazards(matchRouteHazards([rec], joinCoords, joinCum, joinStretches)).closedMay.length).toBe(1);
  });
  it('one beyond the far end of the highway stretch does not apply', () => {
    const rec = { kind: 'chain', level: 'R-1', direction: 'E', hwyNum: 88, lat: 38.645, lng: -120.20 };
    expect(matchRouteHazards([rec], joinCoords, joinCum, joinStretches)).toEqual([]);
  });
  it('a highway sharing only the last mile of the road is not the whole drive', () => {
    // East on "US 50", then 1.2 km north-east where the same road is also "CA 89".
    const coords = [[38.73, -120.80], [38.848, -120.027], [38.857, -120.019]];
    const c2 = polylineCumKm(coords);
    const edge = (names, km) => ({ length: km, speed: 80, road_class: 'trunk', names });
    const segs = valhallaEdgesToSegments({ shape: TRACE.shape, units: 'kilometers',
      edges: [edge(['US 50'], c2[1]), edge(['US 50', 'CA 89'], c2[2] - c2[1])] }).segments;
    const st = routeHighwayStretches(segs);
    expect(st.find(s => s.num === 89).fromKm).toBeCloseTo(c2[1], 3);
    // Southbound Highway 89 control 4 km south of the junction. The drive uses
    // 89 only north-eastbound, so it faces the wrong way. With "89" spread over
    // the whole eastbound drive it read as "may apply".
    const south = { kind: 'chain', level: 'R-2', direction: 'S', hwyNum: 89, lat: 38.812, lng: -120.02 };
    expect(matchRouteHazards([south], coords, c2, st)).toEqual([]);
    // The buggy stretch list, for contrast: this is what it used to report.
    expect(matchRouteHazards([south], coords, c2, [{ num: 50, fromKm: 0, toKm: c2[2] }, { num: 89, fromKm: 0, toKm: c2[2] }]).map(m => m.rel)).toEqual(['mayApply']);
  });
});

describe('routeTouchesCalifornia', () => {
  it('is true for a Sierra route and false for one in Nevada or Oregon', () => {
    expect(routeTouchesCalifornia(valhallaEdgesToSegments(TRACE).coords)).toBe(true);
    expect(routeTouchesCalifornia([[39.5, -119.8], [39.6, -119.7]])).toBe(false); // Reno
    expect(routeTouchesCalifornia([[44.0, -121.3], [44.1, -121.3]])).toBe(false); // Bend
    expect(routeTouchesCalifornia([])).toBe(false);
  });
});

describe('MVUM access flags', () => {
  it('reads a seasonal date range', () => {
    expect(mvumSeasonState('04/01-12/31', new Date(2026, 5, 15))).toBe('open');
    expect(mvumSeasonState('04/01-12/31', new Date(2026, 1, 15))).toBe('closed');
    expect(mvumSeasonState('01/01-12/31', new Date(2026, 1, 15))).toBe('open');
  });
  it('handles a range that wraps the new year and several ranges', () => {
    expect(mvumSeasonState('11/15-03/31', new Date(2026, 0, 10))).toBe('open');
    expect(mvumSeasonState('11/15-03/31', new Date(2026, 6, 10))).toBe('closed');
    expect(mvumSeasonState('01/01-03/15, 06/01-12/31', new Date(2026, 3, 10))).toBe('closed');
    expect(mvumSeasonState('01/01-03/15, 06/01-12/31', new Date(2026, 6, 10))).toBe('open');
  });
  it('is unknown for empty or unreadable dates', () => {
    expect(mvumSeasonState('', new Date())).toBe('unknown');
    expect(mvumSeasonState(null, new Date())).toBe('unknown');
    expect(mvumSeasonState('yearlong', new Date())).toBe('unknown');
  });
  const props = { id: '11N26A', name: 'WRIGHTS LEFT', operationalmaintlevel: '2 - HIGH CLEARANCE VEHICLES',
    surfacetype: 'NAT - NATIVE MATERIAL', seasonal: 'seasonal', passengervehicle: 'open',
    passengervehicle_datesopen: '01/01-12/31', highclearancevehicle: 'open', highclearancevehicle_datesopen: '04/01-12/31' };
  it('a road open to passenger cars year-long but seasonal for high clearance is PARTLY restricted, not closed', () => {
    const f = mvumAccessFlags(props, new Date(2026, 1, 15));
    expect(f).toMatchObject({ id: '11N26A', label: '11N26A WRIGHTS LEFT', highClearance: true, seasonal: true,
      closedNow: false, partlyRestricted: true, datesOpen: '04/01-12/31', trail: false });
    expect(mvumAccessFlags(props, new Date(2026, 6, 15))).toMatchObject({ closedNow: false, partlyRestricted: false });
  });
  it('is closed when no designated vehicle class is open on the date', () => {
    const hcOnly = { id: '12N77', operationalmaintlevel: '2 - HIGH CLEARANCE VEHICLES', seasonal: 'seasonal',
      highclearancevehicle: 'open', highclearancevehicle_datesopen: '06/01-10/31' };
    expect(mvumAccessFlags(hcOnly, new Date(2026, 1, 15))).toMatchObject({ closedNow: true, partlyRestricted: false, datesOpen: '06/01-10/31' });
    expect(mvumAccessFlags(hcOnly, new Date(2026, 7, 15)).closedNow).toBe(false);
  });
  it('reads a motorized trail (MVUM trails layer): 4WD dates, no maintenance level', () => {
    const t = { id: '16E21', name: null, seasonal: 'seasonal', fourwd_gt50inches: 'open', fourwd_gt50_datesopen: '06/15-11/01' };
    const f = mvumAccessFlags(t, new Date(2026, 1, 15), { trail: true });
    expect(f).toMatchObject({ label: '16E21', trail: true, highClearance: true, closedNow: true, datesOpen: '06/15-11/01' });
    expect(f.fourwd).toMatchObject({ designated: true, state: 'closed' });
    expect(mvumAccessFlags({}, new Date(), { trail: true }).label).toBe('MVUM trail');
    expect(mvumAccessFlags({}, new Date()).label).toBe('MVUM road');
  });
  it('reads field names in any case and a passenger-car road', () => {
    const f = mvumAccessFlags({ ID: '12N01', NAME: 'ICE HOUSE', OPERATIONALMAINTLEVEL: '4 - MODERATE DEGREE OF USER COMFORT', SEASONAL: 'yearlong', PASSENGERVEHICLE: 'open', PASSENGERVEHICLE_DATESOPEN: '01/01-12/31' }, new Date(2026, 1, 1));
    expect(f).toMatchObject({ highClearance: false, seasonal: false, closedNow: false });
    expect(f.highClear.designated).toBe(false);
  });
  it('matches MVUM roads to the forest part of a route only', () => {
    const coords = [[38.80, -120.30], [38.80, -120.29], [38.80, -120.28], [38.80, -120.27], [38.80, -120.26]];
    const segments = [{ kind: 'local', km: 0.87, i0: 0, i1: 1 }, { kind: 'forest', km: 2.6, i0: 1, i1: 4 }];
    const on = { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [[-120.295, 38.8001], [-120.255, 38.8001]] } };
    const far = { type: 'Feature', properties: { id: 'X' }, geometry: { type: 'MultiLineString', coordinates: [[[-120.295, 38.82], [-120.255, 38.82]]] } };
    const m = matchMvumRoads([on, far], coords, segments, new Date(2026, 1, 15));
    expect(m.sampled).toBe(4);
    expect(m.matched).toBe(4);
    expect(m.roads.length).toBe(1);
    expect(m.roads[0].flags.id).toBe('11N26A');
    const none = matchMvumRoads([far], coords, segments, new Date());
    expect(none).toMatchObject({ matched: 0, roads: [] });
    // a feature from the trails layer is flagged as a trail
    const trail = Object.assign({}, on, { __mvumTrail: true });
    expect(matchMvumRoads([trail], coords, segments, new Date()).roads[0].flags.trail).toBe(true);
  });
  it('ignores a road the route only touches at a junction', () => {
    // 40 forest vertices heading east; an MVUM road crossing at the first two.
    const coords = Array.from({ length: 41 }, (_, i) => [38.80, -120.30 + i * 0.0005]);
    const segments = [{ kind: 'forest', km: 1.7, i0: 0, i1: 40 }];
    const crossing = { type: 'Feature', properties: { id: 'X1' }, geometry: { type: 'LineString', coordinates: [[-120.30, 38.79], [-120.30, 38.81]] } };
    const m = matchMvumRoads([crossing], coords, segments, new Date());
    expect(m.sampled).toBe(41);
    expect(m.roads).toEqual([]);   // 1 vertex of 41 is not "along" the road
    expect(m.matched).toBe(0);
    // only forest segments are sampled
    expect(matchMvumRoads([crossing], coords, [{ kind: 'local', km: 1, i0: 0, i1: 40 }], new Date()).sampled).toBe(0);
  });
});

describe('hike-in', () => {
  it('sums only the climbs of an elevation profile', () => {
    expect(ascentFromElevations([100, 150, 120, 200])).toBe(130);
    expect(ascentFromElevations([200, 100])).toBe(0);
    expect(ascentFromElevations([])).toBe(0);
  });
  it('times trail, off-trail and ascent', () => {
    // 2 mi of trail at 2 mph + 0.5 mi off trail at 1 mph + 1000 ft of climb
    const h = { trailKm: 2 * RESPONSE_KM_PER_MI, offTrailKm: 0.5 * RESPONSE_KM_PER_MI, ascentM: 304.8 };
    expect(hikeTimeMin(h, S0)).toBeCloseTo(60 + 30 + 30, 4);
    expect(hikeTimeMin(Object.assign({}, h, { ascentM: null }), S0)).toBeCloseTo(90, 4); // unknown climb → flat
    expect(hikeTimeMin(null, S0)).toBeNull();
  });
  it('uses a routed trail only when it beats walking straight in', () => {
    expect(chooseHikePlan(1, { trailKm: 1.2, offTrailKm: 0.1 }, S0).mode).toBe('trail');
    expect(chooseHikePlan(0.3, { trailKm: 6, offTrailKm: 0.2 }, S0).mode).toBe('direct'); // long detour
    expect(chooseHikePlan(0.5, null, S0)).toEqual({ mode: 'direct', trailKm: 0, offTrailKm: 0.5 });
  });
});

describe('readout', () => {
  it('formats durations', () => {
    expect(formatDurationMin(52.4)).toBe('52 min');
    expect(formatDurationMin(112)).toBe('1 h 52 min');
    expect(formatDurationMin(120)).toBe('2 h');
    expect(formatDurationMin(null)).toBe('--');
    expect(formatDurationMin(NaN)).toBe('--');
  });
  it('formats distances in miles', () => {
    expect(formatMilesKm(1.609344 * 3.14)).toBe('3.1 mi');
    expect(formatMilesKm(1.609344 * 38.4)).toBe('38 mi');
    expect(formatMilesKm(null)).toBe('--');
  });
  const est = { roadMin: 52, forestMin: 18, rainMi: 0, snowMi: 0, groundSnowMi: 0, unknownMi: 0, wxKnown: true };
  const clear = { status: 'ok', on: 0, may: 0, closedOn: 0, closedMay: 0 };
  it('totals loading + road + forest + hike with no chain delay when none is on the route', () => {
    const s = summarizeResponseDest({ routeStatus: 'ok', est, hikeMin: 12, chain: clear, surfaceDetail: true }, S0);
    expect(s).toMatchObject({ ok: true, totalMin: 112, chainMin: 0, chainMayMin: 0, closed: false, level: 'green' });
    expect(responseBreakdownText(s)).toBe('load 30 + road 52 + forest road 18 + hike 12 min');
  });
  it('adds the chain-control delay once for a control on the route', () => {
    const s = summarizeResponseDest({ routeStatus: 'ok', est, hikeMin: null, chain: Object.assign({}, clear, { on: 3 }), surfaceDetail: true }, S0);
    expect(s.chainMin).toBe(45);
    expect(s.totalMin).toBe(145);
    expect(s.level).toBe('amber');
    expect(responseBreakdownText(s)).toBe('load 30 + road 52 + forest road 18 + chain control 45 min');
  });
  it('reports a control that only may apply beside the total, not in it', () => {
    const s = summarizeResponseDest({ routeStatus: 'ok', est, hikeMin: null, chain: Object.assign({}, clear, { may: 2 }), surfaceDetail: true }, S0);
    expect(s.chainMin).toBe(0);
    expect(s.chainMayMin).toBe(45);
    expect(s.totalMin).toBe(100);
    expect(s.level).toBe('amber');
  });
  it('a closure on the route adds no time and turns the row red', () => {
    const s = summarizeResponseDest({ routeStatus: 'ok', est, hikeMin: null, chain: Object.assign({}, clear, { closedOn: 1 }), surfaceDetail: true }, S0);
    expect(s).toMatchObject({ closed: true, totalMin: 100, level: 'red' });
  });
  it('is never green when weather or chain controls are unverified', () => {
    const unk = Object.assign({}, est, { wxKnown: false, unknownMi: 40 });
    expect(summarizeResponseDest({ routeStatus: 'ok', est: unk, chain: clear, surfaceDetail: true }, S0).level).toBe('amber');
    expect(summarizeResponseDest({ routeStatus: 'ok', est, chain: Object.assign({}, clear, { status: 'unverified' }), surfaceDetail: true }, S0).level).toBe('amber');
    expect(summarizeResponseDest({ routeStatus: 'cached', est, chain: clear, surfaceDetail: true }, S0).level).toBe('amber');
    expect(summarizeResponseDest({ routeStatus: 'ok', est, chain: clear, surfaceDetail: false }, S0).level).toBe('amber');
  });
  it('outside California a route can be green without Caltrans data', () => {
    expect(summarizeResponseDest({ routeStatus: 'ok', est, chain: Object.assign({}, clear, { status: 'na' }), surfaceDetail: true }, S0).level).toBe('green');
  });
  it('a failed route has no total', () => {
    const s = summarizeResponseDest({ routeStatus: 'error', est: null }, S0);
    expect(s).toMatchObject({ ok: false, totalMin: null, level: 'red' });
    expect(responseBreakdownText(s)).toBe('');
    expect(summarizeResponseDest({ routeStatus: 'noroad', est }, S0).ok).toBe(false);
  });
  it('honours a changed loading time and chain delay', () => {
    const s = summarizeResponseDest({ routeStatus: 'ok', est, chain: Object.assign({}, clear, { on: 1 }), surfaceDetail: true },
      Object.assign({}, S0, { loadMin: 10, chainDelayMin: 20 }));
    expect(s.totalMin).toBe(10 + 52 + 18 + 20);
  });
  it('keys a route by a rounded start and an exact destination', () => {
    const k1 = responseRouteKey('auto', { lat: 38.72961, lng: -120.79851 }, { lat: 38.869, lng: -120.229 });
    const k2 = responseRouteKey('auto', { lat: 38.72999, lng: -120.79882 }, { lat: 38.869, lng: -120.229 });
    expect(k1).toBe(k2);
    expect(responseRouteKey('auto', { lat: 38.74, lng: -120.79851 }, { lat: 38.869, lng: -120.229 })).not.toBe(k1);
    expect(responseRouteKey('pedestrian', { lat: 38.72961, lng: -120.79851 }, { lat: 38.869, lng: -120.229 })).not.toBe(k1);
  });
});
