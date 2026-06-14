const {
  parseNotamSearchItem, classifyNotamForUAS, notamCategory, notamPlainSummary,
  expandNotamText,
} = require('../../sar-preflight-core.js');

// The example NOTAM from the field: aerobatic activity, 3 NM radius, SFC-5000FT.
const AEROBATIC = {
  notamNumber: '01/239', facilityDesignator: 'OAK', keyword: 'AIRSPACE',
  traditionalMessage: '!OAK 01/239 ZOA AIRSPACE AEROBATIC ACFT WI AN AREA DEFINED AS 3NM RADIUS OF 383900N1220148W (7.5NM WSW O41) SFC-5000FT DLY 1600-0400 2601231600-2701010400',
  startDate: '01/23/2026 1600', endDate: '01/01/2027 0400',
  mapPointer: 'POINT(-122.0300 38.6500)',
};

describe('parseNotamSearchItem enrichment from the message body', () => {
  it('recovers the circle geometry and altitude band', () => {
    const n = parseNotamSearchItem(AEROBATIC);
    expect(n.polygons.length).toBe(1);            // 3 NM circle recovered
    expect(n.polygons[0].length).toBeGreaterThan(8);
    expect(String(n.lowerAlt).toUpperCase()).toContain('SFC');
    expect(String(n.upperAlt).toUpperCase()).toContain('5000');
    expect(n.lat).toBeCloseTo(38.65, 2);
    expect(n.lng).toBeCloseTo(-122.03, 2);
  });
});

describe('leading-decimal radius (.25NM must be 0.25 NM, not 25)', () => {
  const MHR = {
    notamNumber: '06/007', facilityDesignator: 'MHR', keyword: 'AIRSPACE',
    traditionalMessage: '!MHR 06/007 MHR AIRSPACE NUMEROUS UAS WI AN AREA DEFINED AS .25NM RADIUS OF 382927N1211649W (4.6NM SE MHR) SFC-400FT AGL DLY 1500-2300 2606131500-2606142300',
    startDate: '06/13/2026 1500', endDate: '06/14/2026 2300', mapPointer: 'POINT(-121.2803 38.4908)',
  };
  it('builds a ~0.25 NM circle, not a 25 NM one', () => {
    const { ringRadiusNm } = require('../../sar-preflight-core.js');
    const n = parseNotamSearchItem(MHR);
    expect(n.polygons.length).toBe(1);
    const r = ringRadiusNm([n.lat, n.lng], n.polygons[0]);
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.35);   // would be ~25 with the bug
  });
  it('summary shows the small radius and keeps the UAS NOTAM', () => {
    const n = parseNotamSearchItem(MHR);
    expect(n._relevance ? n._relevance.category : notamCategory(n)).toBe('UAS');
    expect(notamPlainSummary(n)).toContain('within 0.25 NM');
  });
});

describe('notamCategory (body-signal authoritative)', () => {
  const cat = (body, keyword) => notamCategory({ body, type: keyword || '' });
  it('classifies surface hazards by body even if keyworded otherwise', () => {
    expect(cat('AEROBATIC ACFT SFC-5000FT', 'AIRSPACE')).toBe('HAZARD_ACTIVITY');
    expect(cat('PARACHUTE JUMPING SFC-13000FT', 'O')).toBe('HAZARD_ACTIVITY');
    expect(cat('LASER LGT OPS', 'NAV')).toBe('HAZARD_ACTIVITY');
    expect(cat('CRANE 250FT AGL', 'OBST')).toBe('OBSTACLE');
    expect(cat('ADS-B OUT SVC NOT AVBL', 'COM')).toBe('GPS');      // ADS-B kept as GPS/surveillance
    expect(cat('GPS INTERFERENCE TESTING', 'NAV')).toBe('GPS');
    expect(cat('UAS OPERATING AREA', 'AIRSPACE')).toBe('UAS');
  });
  it('files genuinely-irrelevant types correctly', () => {
    expect(cat('ILS RWY 27 LOC U/S', 'NAV')).toBe('NAVAID');       // body has no surface-hazard signal
    expect(cat('IAP RNAV RWY 27 NA', 'IAP')).toBe('PROCEDURE');
  });
});

describe('classifyNotamForUAS', () => {
  const aoiNear = { center: { lat: 38.66, lng: -122.0 }, radiusNm: 5, searchRadiusNm: 25, polygon: null };
  const aoiFar = { center: { lat: 38.70, lng: -120.0 }, radiusNm: 5, searchRadiusNm: 25, polygon: null };

  it('keeps the aerobatic NOTAM when the AOI is adjacent', () => {
    const n = parseNotamSearchItem(AEROBATIC);
    const r = classifyNotamForUAS(n, aoiNear);
    expect(r.category).toBe('HAZARD_ACTIVITY');
    expect(r.relevant).toBe(true);
    expect(r.tooFar).toBe(false);
  });

  it('filters the same NOTAM when it is far from the AOI', () => {
    const n = parseNotamSearchItem(AEROBATIC);
    const r = classifyNotamForUAS(n, aoiFar);
    expect(r.tooFar).toBe(true);
    expect(r.relevant).toBe(false);
    expect(r.distanceNm).toBeGreaterThan(40);
  });

  it('filters instrument-procedure / navaid NOTAMs even inside the AOI', () => {
    const n = parseNotamSearchItem({ notamNumber: '02/100', facilityDesignator: 'SAC', keyword: 'IAP', traditionalMessage: '!SAC 02/100 SAC IAP RNAV RWY 02 NA', mapPointer: 'POINT(-122.0 38.66)' });
    const r = classifyNotamForUAS(n, aoiNear);
    expect(r.category).toBe('PROCEDURE');
    expect(r.relevant).toBe(false);
  });

  it('keeps an obstacle even with a high parsed floor (never hidden by altitude)', () => {
    const n = parseNotamSearchItem({ notamNumber: '03/050', facilityDesignator: 'SAC', keyword: 'OBST', traditionalMessage: '!SAC 03/050 SAC OBST CRANE 1600FT-1700FT MSL', mapPointer: 'POINT(-122.0 38.66)' });
    const r = classifyNotamForUAS(n, aoiNear);
    expect(r.category).toBe('OBSTACLE');
    expect(r.tooHigh).toBe(false);
    expect(r.relevant).toBe(true);
  });

  it('keeps a NOTAM with no usable geometry (safe default)', () => {
    const n = parseNotamSearchItem({ notamNumber: '04/001', facilityDesignator: 'SAC', keyword: 'AIRSPACE', traditionalMessage: '!SAC 04/001 SAC AIRSPACE SEE DETAILS' });
    const r = classifyNotamForUAS(n, aoiNear);
    expect(r.distanceNm).toBe(null);
    expect(r.tooFar).toBe(false);
    expect(r.relevant).toBe(true);
  });

  it('keeps everything when classification cannot decide (no AOI)', () => {
    const n = parseNotamSearchItem(AEROBATIC);
    expect(classifyNotamForUAS(n, null).relevant).toBe(true);
  });
});

describe('notamPlainSummary', () => {
  it('produces a readable sentence for the example NOTAM', () => {
    const n = parseNotamSearchItem(AEROBATIC);
    const s = notamPlainSummary(n);
    expect(s).toMatch(/Aerobatic aircraft/);
    expect(s).toContain('within 3 NM of');
    expect(s).toContain("38°39'00\"N");
    expect(s).toContain('7.5 NM WSW of O41');
    expect(s).toContain('surface to 5,000 ft');
    expect(s).toContain('daily 1600-0400Z');
    expect(s).toContain('Jan 23, 2026');
    expect(s).toContain('Jan 1, 2027');
  });
});

describe('expandNotamText', () => {
  it('expands contractions but preserves coordinates and runway ids', () => {
    const out = expandNotamText('ACFT WI 3NM OF 383900N1220148W RWY 09L/27R CLSD SFC-5000FT');
    expect(out).toContain('aircraft');
    expect(out).toContain('within');
    expect(out).toContain('closed');
    expect(out).toContain('surface');
    expect(out).toContain('383900N1220148W'); // coord preserved
    expect(out).toContain('RWY 09L/27R');     // runway id preserved
  });
});
