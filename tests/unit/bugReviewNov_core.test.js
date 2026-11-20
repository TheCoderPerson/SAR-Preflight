// Regression tests for the Nov 2026 bug-review findings fixed in core.js
// (C2, C3, M1.5–M1.7, M2–M8, H5.4, H6.1, Low 1–4, 7, 8).
const core = require('../../sar-preflight-core.js');
const {
  metarCeilingFt, flightCategory, calcMoonPhase, calcDensityAltitude, assessRisk, DEFAULT_THRESHOLDS,
  wxAtHour, assessTerrainTurbulence, rollupSources, buildSectionMetaLine, polygonsIntersect,
  sunArrowsKml, windArrowsKml, combineProhibitedAreas, ascentFromElevations, summarizeResponseDest,
  mvumSeasonState, mvumAccessFlags, kmlPointPlacemark, kmlLinePlacemark, geojsonMarkerFeature,
  analyzeGPSMasking, normalizeResponseSettings, toDmsDisplay, parseCoordinateInput, wireHazardName,
  parcelChipState, routeHighwayStretches, matchRouteHazards,
} = core;

describe('C2 — metarCeilingFt: NWS VV and missing bases', () => {
  it('treats vertical visibility (VV) as a ceiling', () => {
    expect(metarCeilingFt([{ cover: 'VV', base: 197 }])).toBe(197);
    expect(metarCeilingFt([{ cover: 'FEW', base: 100 }, { cover: 'VV', base: 300 }])).toBe(300);
  });
  it('never turns a null / empty base into 0 ft', () => {
    expect(metarCeilingFt([{ cover: 'OVC', base: null }])).toBe(null);
    expect(metarCeilingFt([{ cover: 'BKN', base: '' }, { cover: 'OVC', base: 2500 }])).toBe(2500);
  });
});

describe('H6.1 — flightCategory never reports VFR on a missing element', () => {
  it('visibility not reported → no category unless the ceiling alone proves LIFR', () => {
    expect(flightCategory(null, null)).toBe(null);
    expect(flightCategory(5000, null)).toBe(null);
    expect(flightCategory(2000, null)).toBe(null);
    expect(flightCategory(300, null)).toBe('LIFR');
  });
  it('sky condition not reported (ceilingUnknown) → no category unless visibility proves LIFR', () => {
    expect(flightCategory(null, 10, true)).toBe(null);
    expect(flightCategory(null, 0.5, true)).toBe('LIFR');
  });
  it('complete observations are unchanged', () => {
    expect(flightCategory(null, 10)).toBe('VFR');
    expect(flightCategory(197, 0.25)).toBe('LIFR');
  });
});

describe('C3 — calcMoonPhase uses the UTC Julian Day', () => {
  const at = iso => calcMoonPhase(new Date(iso));
  it('new moon 2026-11-09 is dark', () => {
    const m = at('2026-11-09T07:00:00Z');
    expect(m.name).toBe('New Moon');
    expect(m.illumination).toBeLessThan(3);
  });
  it('full moon 2026-11-24 is bright', () => {
    const m = at('2026-11-24T15:00:00Z');
    expect(m.name).toBe('Full Moon');
    expect(m.illumination).toBeGreaterThan(97);
  });
  it('reference new moon 2000-01-06T18:14Z', () => {
    const m = at('2000-01-06T18:14:00Z');
    expect(m.name).toBe('New Moon');
    expect(m.illumination).toBe(0);
  });
  it('dates before the reference epoch still get a name and a phase in [0, 1)', () => {
    const m = at('1999-06-01T00:00:00Z');
    expect(typeof m.name).toBe('string');
    expect(m.phase).toBeGreaterThanOrEqual(0);
    expect(m.phase).toBeLessThan(1);
  });
});

describe('M2 — calcDensityAltitude from station pressure', () => {
  it('ISA conditions give DA ≈ field elevation in the mountains', () => {
    expect(Math.abs(calcDensityAltitude(59, 1013.25))).toBeLessThan(20);
    expect(Math.abs(calcDensityAltitude(16.2, 644.4) - 12000)).toBeLessThan(60); // 12,000 ft ISA
  });
  it('9,000 ft station, 30 °F, 724.3 hPa reads above 9,000 ft (old formula said 8,816)', () => {
    const da = calcDensityAltitude(30, 724.3);
    expect(da).toBeGreaterThan(9100);
    expect(da).toBeLessThan(9350);
  });
});

describe('M3 — freezing level needs a real launch elevation', () => {
  const wx = { temperature_2m: 50, dew_point_2m: 30, visibility: 16000, freezing_level_height: 1889.76 }; // 6,200 ft
  it('unknown elevation: no sea-level freezing judgement, but announced', () => {
    const r = assessRisk(wx, { maxWind: 5, maxGust: 8 }, null, 27, DEFAULT_THRESHOLDS);
    expect(r.cautions.some(c => /within flight envelope|at\/below launch/.test(c))).toBe(false);
    expect(r.cautions.some(c => /Freezing level 6,200 ft MSL — launch elevation unavailable/.test(c))).toBe(true);
  });
  it('known 7,000 ft launch: 6,200 ft freezing level is at/below launch', () => {
    const r = assessRisk(wx, { maxWind: 5, maxGust: 8 }, { center: 7000 }, 27, DEFAULT_THRESHOLDS);
    expect(r.cautions.some(c => /at\/below launch elevation/.test(c))).toBe(true);
  });
});

describe('M4 — wxAtHour: a null future hour is unavailable, not NOW', () => {
  const hourly = { time: ['a', 'b', 'c'], visibility: [16000, null, 400], wind_speed_10m: [null, null, 5] };
  const cur = { visibility: 16000, wind_speed_10m: 3, temperature_2m: 60 };
  it('future hour with a null value → null', () => {
    const s = wxAtHour(hourly, 1, cur);
    expect(s.visibility).toBe(null);
    expect(s.wind_speed_10m).toBe(null);
    expect(s.temperature_2m).toBe(60); // no hourly array at all → unchanged fallback
  });
  it('NOW keeps the current observation when hour 0 is null', () => {
    expect(wxAtHour(hourly, 0, cur).wind_speed_10m).toBe(3);
  });
  it('null visibility at a future hour is reported unavailable by assessRisk', () => {
    const r = assessRisk(wxAtHour(hourly, 1, cur), { maxWind: 5, maxGust: 8 }, { center: 1000 }, 27, DEFAULT_THRESHOLDS);
    expect(r.unavailable).toContain('visibility');
  });
});

describe('M5 — assessTerrainTurbulence folds the ridge axis', () => {
  // 5×5 N–S ridge (high centre column), west edge lower than east → faces W.
  const cols = [1000, 1600, 2600, 1700, 1400];
  const grid = []; for (let r = 0; r < 5; r++) cols.forEach(v => grid.push(v));
  it('wind from the facing side and wind over the crest score the same', () => {
    const a = assessTerrainTurbulence(grid, 5, 1600, 270, 20);
    const b = assessTerrainTurbulence(grid, 5, 1600, 90, 20);
    expect(a.factors.some(f => /perpendicular/.test(f))).toBe(true);
    expect(b.factors).toEqual(a.factors);
    expect(b.risk).toBe(a.risk);
  });
});

describe('M6 — rollup freshness honesty', () => {
  const T = Date.UTC(2026, 5, 20, 17, 45);
  const MIN = 60000;
  it('a rollup with a sub-source that never reported is not green "Updated"', () => {
    const r = rollupSources({ faa: { status: 'live', updatedAt: T }, airports: { status: 'never' } }, T);
    expect(r.status).toBe('partial');
    const line = buildSectionMetaLine(r, T + MIN, 'America/Los_Angeles');
    expect(line.state).not.toBe('live');
    expect(line.tone).toBe('cached');
    expect(line.text).toMatch(/^Incomplete/);
    expect(line.title).toContain('airports');
  });
  it('an errored sub-source keeps its preserved timestamp', () => {
    const r = rollupSources({ wire: { status: 'error', updatedAt: T - 30 * MIN, errorAt: T } }, T);
    const line = buildSectionMetaLine(r, T + MIN, 'America/Los_Angeles');
    expect(line.text).toContain('showing Jun 20, 10:15 AM data');
  });
});

describe('M7 — polygonsIntersect with boundary-aligned containment', () => {
  const tfr = [[38, -120], [38, -119], [39, -119], [39, -120]];
  it('AOI inside the TFR touching its north/east edges intersects', () => {
    const aoi = [[38.5, -119], [39, -119], [39, -119.5]];
    expect(polygonsIntersect(tfr, aoi)).toBe(true);
    expect(polygonsIntersect(aoi, tfr)).toBe(true);
  });
  it('identical rings intersect', () => { expect(polygonsIntersect(tfr, tfr.slice())).toBe(true); });
  it('a polygon strictly inside intersects', () => {
    expect(polygonsIntersect(tfr, [[38.4, -119.6], [38.4, -119.4], [38.6, -119.5]])).toBe(true);
  });
  it('disjoint polygons do not', () => {
    expect(polygonsIntersect(tfr, [[40, -118], [40, -117], [41, -117]])).toBe(false);
  });
});

describe('M8 — sun/wind arrow labels are not bare UTC', () => {
  const times = ['2026-06-16T17:00:00.000Z'];
  it('mission zone given → local time with zone abbreviation', () => {
    const w = windArrowsKml(times, [270], [10], [15], 38, -120, { timeZone: 'America/Los_Angeles' });
    expect(w).toContain('Wind 10:00 PDT');
    const s = sunArrowsKml(38, -120, times, 38, -120, { timeZone: 'America/Los_Angeles', calcSunPosition: () => ({ elevation: 30, azimuth: 90 }) });
    expect(s).toContain('Sun 10:00 PDT');
  });
  it('no zone → UTC marked with Z', () => {
    expect(windArrowsKml(times, [270], [10], [15], 38, -120, {})).toContain('Wind 17:00Z');
  });
});

describe('H5.4 — combineProhibitedAreas honours _truncated', () => {
  it('flags a truncated contributing layer so empty is not "None"', () => {
    const sua = { features: [], _truncated: true };
    const prohibited = { features: [] };
    const r = combineProhibitedAreas(sua, prohibited);
    expect(r.truncated).toBe(true);
    expect(combineProhibitedAreas({ features: [] }, { features: [] }).truncated).toBe(false);
  });
});

describe('M1.5–M1.7 — response time', () => {
  it('ascentFromElevations skips missing samples instead of using 0 m', () => {
    expect(ascentFromElevations([2000, null, 2000])).toBe(0);
    expect(ascentFromElevations([2000, '', 2100, NaN, 2050, 2200])).toBe(250);
  });
  it('an active chain control is never green, even with a 0-min delay setting', () => {
    const settings = { loadMin: 30, chainDelayMin: 0 };
    const d = { routeStatus: 'ok', est: { roadMin: 50, forestMin: 0, rainMi: 0, snowMi: 0, groundSnowMi: 0, wxKnown: true },
      chain: { status: 'ok', on: 1, may: 0, closedOn: 0, closedMay: 0 }, surfaceDetail: true };
    expect(summarizeResponseDest(d, settings).level).toBe('amber');
    d.chain = { status: 'ok', on: 0, may: 1, closedOn: 0, closedMay: 0 };
    expect(summarizeResponseDest(d, settings).level).toBe('amber');
    d.chain = { status: 'ok', on: 0, may: 0, closedOn: 0, closedMay: 0 };
    expect(summarizeResponseDest(d, settings).level).toBe('green');
  });
  it('mvumSeasonState reads an ISO date-only string as that calendar day', () => {
    expect(mvumSeasonState('04/01-12/31', '2026-04-01')).toBe('open');
    expect(mvumSeasonState('04/01-12/31', '2026-03-31')).toBe('closed');
  });
  it('mvumSeasonState uses the mission zone day for a Date', () => {
    const d = new Date('2026-04-01T03:00:00Z'); // Mar 31 20:00 PDT, Apr 1 in UTC
    expect(mvumSeasonState('04/01-12/31', d, 'America/Los_Angeles')).toBe('closed');
    expect(mvumSeasonState('04/01-12/31', d, 'UTC')).toBe('open');
    const f = mvumAccessFlags({ passengervehicle: 'open', passengervehicle_datesopen: '04/01-12/31' }, d, { timeZone: 'America/Los_Angeles' });
    expect(f.closedNow).toBe(true);
  });
});

describe('Low 1 — null coordinates never become Null Island', () => {
  it('KML / GeoJSON point builders skip null coordinates', () => {
    expect(kmlPointPlacemark({ name: 'x', lat: null, lng: null })).toBe('');
    expect(kmlPointPlacemark({ name: 'x', lat: '', lng: -120 })).toBe('');
    expect(geojsonMarkerFeature('id', 'f', { name: 'x', lat: null, lng: null })).toBe(null);
    expect(kmlPointPlacemark({ name: 'x', lat: 38.5, lng: -120 })).toContain('-120');
  });
  it('line builder drops null vertices', () => {
    const k = kmlLinePlacemark({ name: 'l', coords: [[38, -120], [null, null], [38.1, -120.1]] });
    expect(k).toContain('<coordinates>-120.000000,38.000000,0 -120.100000,38.100000,0</coordinates>');
  });
  it('analyzeGPSMasking ignores null-located samples and a null observer', () => {
    const pts = [{ lat: null, lng: null, elevFt: 9000 }, { lat: 38.5, lng: -120.5, elevFt: 1000 }];
    const r = analyzeGPSMasking(1000, pts, 2, 400, { lat: null, lng: null });
    expect(r.skyVisibilityPct).toBe(100);
  });
  it('normalizeResponseSettings rejects a null base location', () => {
    expect(normalizeResponseSettings({ base: { label: 'Base', lat: null, lng: null } }).base).toBe(null);
    expect(normalizeResponseSettings({ base: { label: 'Base', lat: 38.6, lng: -120.9 } }).base).toMatchObject({ lat: 38.6, lng: -120.9 });
  });
});

describe('Low 2 — toDmsDisplay carries rounding into minutes and degrees', () => {
  it('38.9999, -120.9999 → 39°00\'00"N 121°00\'00"W', () => {
    expect(toDmsDisplay(38.9999, -120.9999)).toBe('39°00\'00"N 121°00\'00"W');
  });
  it('ordinary values unchanged', () => {
    expect(toDmsDisplay(38.5, -120.25)).toBe('38°30\'00"N 120°15\'00"W');
  });
});

describe('Low 3 — parseCoordinateInput honours hemisphere letters per axis', () => {
  it('"74.0° W, 40.7° N" → lat 40.7, lng -74', () => {
    const r = parseCoordinateInput('74.0° W, 40.7° N');
    expect(r.lat).toBeCloseTo(40.7, 6);
    expect(r.lng).toBeCloseTo(-74, 6);
  });
  it('lat-first input is unchanged; contradictory letters are rejected', () => {
    const r = parseCoordinateInput('40.7 N, 74.0 W');
    expect(r.lat).toBeCloseTo(40.7, 6);
    expect(r.lng).toBeCloseTo(-74, 6);
    expect(parseCoordinateInput('38.5 N, 120.9 N')).toBe(null);
    expect(parseCoordinateInput('38.5, -120.9')).toMatchObject({ lat: 38.5, lng: -120.9 });
  });
});

describe('Low 4 — wire voltage / TFR altitude text', () => {
  it('non-numeric voltage is shown as written, never "NaNkV"', () => {
    expect(wireHazardName({ voltage: 'high' }, 'power_line')).toBe('high');
    expect(wireHazardName({ voltage: '115000' }, 'power_line')).toBe('115kV');
  });
});

describe('Low 7 — parcelChipState keeps the county-failure warning at 0 parcels', () => {
  it('fallback source with 0 parcels still says the county source is unavailable', () => {
    const r = parcelChipState({ cfg: { tier: 2, label: 'CA statewide (DWR/LightBox)' }, failedTier1: true, count: 0 });
    expect(r.text).toMatch(/County source unavailable/);
    expect(r.text).toMatch(/0 parcels in view/);
    expect(r.tone).toBe('warn');
  });
});

describe('Low 8 — highway stretches bridge short unnumbered pieces', () => {
  it('US 50 / unnamed 120 m bridge / US 50 is one stretch', () => {
    const st = routeHighwayStretches([
      { km: 10, names: ['US 50'] }, { km: 0.12, names: [] }, { km: 8, names: ['US 50'] },
    ]).filter(s => s.num === 50);
    expect(st).toHaveLength(1);
    expect(st[0].fromKm).toBe(0);
    expect(st[0].toKm).toBeCloseTo(18.12, 6);
  });
  it('a long unnumbered detour still splits the stretch', () => {
    const st = routeHighwayStretches([
      { km: 10, names: ['US 50'] }, { km: 3, names: [] }, { km: 8, names: ['US 50'] },
    ]).filter(s => s.num === 50);
    expect(st).toHaveLength(2);
  });
  it('matchRouteHazards keeps a mayApply control just before an unnamed bridge', () => {
    // Straight eastbound route along lat 38.8; bridge at km 10–10.12.
    const coords = []; for (let i = 0; i <= 200; i++) coords.push([38.8, -120.5 + i * 0.0011556]); // ~0.1 km steps
    const segs = [{ km: 10, names: ['US 50'] }, { km: 0.12, names: [] }, { km: 9.9, names: ['US 50'] }];
    const rec = { kind: 'chain', hwyNum: 50, lat: 38.805, lng: -120.5 + 99 * 0.0011556 }; // ~550 m off route at km ~9.9
    const m = matchRouteHazards([rec], coords, null, routeHighwayStretches(segs));
    expect(m).toHaveLength(1);
    expect(m[0].rel).toBe('mayApply');
  });
});
