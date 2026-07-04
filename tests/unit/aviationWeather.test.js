const {
  metarCeilingFt, flightCategory, assessCloudClearance, freezingLevelRisk,
  assessRisk, DEFAULT_THRESHOLDS,
} = require('../../sar-preflight-core.js');

describe('metarCeilingFt(clouds)', () => {
  it('returns null for empty / missing / non-array input', () => {
    expect(metarCeilingFt(null)).toBe(null);
    expect(metarCeilingFt(undefined)).toBe(null);
    expect(metarCeilingFt([])).toBe(null);
  });

  it('returns null when only FEW/SCT/CLR layers (no ceiling)', () => {
    expect(metarCeilingFt([{ cover: 'FEW', base: 2000 }, { cover: 'SCT', base: 5000 }])).toBe(null);
    expect(metarCeilingFt([{ cover: 'CLR' }])).toBe(null);
  });

  it('returns the lowest BKN/OVC base as the ceiling', () => {
    expect(metarCeilingFt([{ cover: 'BKN', base: 1200 }, { cover: 'OVC', base: 3000 }])).toBe(1200);
    expect(metarCeilingFt([{ cover: 'SCT', base: 1000 }, { cover: 'OVC', base: 800 }])).toBe(800);
  });

  it('treats obscured sky (OVX) as a ceiling', () => {
    expect(metarCeilingFt([{ cover: 'OVX', base: 200 }])).toBe(200);
  });
});

describe('flightCategory(ceilingFt, visSm)', () => {
  it('VFR when ceiling > 3000 and vis > 5', () => {
    expect(flightCategory(null, 10)).toBe('VFR');
    expect(flightCategory(5000, 10)).toBe('VFR');
    expect(flightCategory(3001, 6)).toBe('VFR');
  });

  it('MVFR at ceiling 1000-3000 or vis 3-5 (inclusive)', () => {
    expect(flightCategory(3000, 10)).toBe('MVFR');
    expect(flightCategory(1000, 10)).toBe('MVFR');
    expect(flightCategory(null, 5)).toBe('MVFR');
    expect(flightCategory(10000, 4)).toBe('MVFR');
  });

  it('IFR at ceiling 500-<1000 or vis 1-<3', () => {
    expect(flightCategory(900, 10)).toBe('IFR');
    expect(flightCategory(500, 10)).toBe('IFR');
    expect(flightCategory(null, 2)).toBe('IFR');
  });

  it('LIFR at ceiling <500 or vis <1', () => {
    expect(flightCategory(400, 10)).toBe('LIFR');
    expect(flightCategory(null, 0.5)).toBe('LIFR');
  });
});

describe('assessCloudClearance(ceilingFt, visSm, maxAltAGL, thresholds)', () => {
  it('no flags when ceiling unlimited and vis good', () => {
    const r = assessCloudClearance(null, 10, 400);
    expect(r.issues).toEqual([]);
    expect(r.cautions).toEqual([]);
  });

  it('no flags when the usable envelope still covers the planned altitude', () => {
    // ceiling 2000, clearance 500 -> usable 1500 >= 400 planned
    const r = assessCloudClearance(2000, 10, 400);
    expect(r.issues).toEqual([]);
    expect(r.cautions).toEqual([]);
  });

  it('CAUTION when ceiling trims the usable envelope below the planned altitude', () => {
    // ceiling 800, clearance 500 -> usable 300 < 400 planned
    const r = assessCloudClearance(800, 10, 400);
    expect(r.issues).toEqual([]);
    expect(r.cautions.length).toBe(1);
    expect(r.cautions[0]).toContain('Ceiling');
  });

  it('NO-GO (issue) when ceiling leaves no room for the required clearance', () => {
    const r = assessCloudClearance(400, 10, 400);
    expect(r.issues.length).toBe(1);
    expect(r.issues[0]).toContain('cloud clearance');
  });

  it('NO-GO (issue) when visibility below the Part 107 3 sm minimum', () => {
    const r = assessCloudClearance(null, 2, 400);
    expect(r.issues.some(s => s.includes('below Part 107'))).toBe(true);
  });

  it('CAUTION when visibility marginal (3-5 sm)', () => {
    const r = assessCloudClearance(null, 4, 400);
    expect(r.cautions.some(s => s.includes('marginal'))).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('respects a custom cloudClearanceFt threshold', () => {
    // ceiling 900, clearance 1000 -> usable negative -> issue
    const r = assessCloudClearance(900, 10, 400, { ...DEFAULT_THRESHOLDS, cloudClearanceFt: 1000 });
    expect(r.issues.length).toBe(1);
  });
});

describe('freezingLevelRisk(freezingLevelM, launchElevFt, maxAltAGL)', () => {
  it('returns null when no data', () => {
    expect(freezingLevelRisk(null, 2000, 400)).toBe(null);
    expect(freezingLevelRisk(undefined, 2000, 400)).toBe(null);
  });

  it('returns null when the 0C level is above the flight envelope', () => {
    // 3000 m ~ 9843 ft, well above 2000 + 400
    expect(freezingLevelRisk(3000, 2000, 400)).toBe(null);
  });

  it('flags "within flight envelope" when 0C level is between launch and launch+AGL', () => {
    // 610 m ~ 2001 ft, launch 2000, top 2400
    const r = freezingLevelRisk(610, 2000, 400);
    expect(r).not.toBe(null);
    expect(r.reason).toContain('within flight envelope');
  });

  it('flags "at/below launch elevation" when 0C level is below launch', () => {
    // 500 m ~ 1640 ft, launch 2000
    const r = freezingLevelRisk(500, 2000, 400);
    expect(r).not.toBe(null);
    expect(r.reason).toContain('at/below launch elevation');
  });
});

describe('assessRisk freezing-level integration', () => {
  const baseWx = () => ({ visibility: 16000, temperature_2m: 45, precipitation_probability: 0, weather_code: 0 });

  it('stays inert (no freezing caution) when freezing_level_height is absent', () => {
    const r = assessRisk(baseWx(), { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27);
    expect(r.cautions.some(c => c.includes('Freezing level'))).toBe(false);
  });

  it('adds a CAUTION when the freezing level sits within the flight envelope', () => {
    const wx = { ...baseWx(), freezing_level_height: 610 }; // ~2001 ft
    const r = assessRisk(wx, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27);
    expect(r.level).toBe('CAUTION');
    expect(r.cautions.some(c => c.includes('Freezing level'))).toBe(true);
  });

  it('does not flag when freezing level is far above the flight envelope', () => {
    const wx = { ...baseWx(), freezing_level_height: 4000 }; // ~13,000 ft
    const r = assessRisk(wx, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27);
    expect(r.cautions.some(c => c.includes('Freezing level'))).toBe(false);
  });
});
