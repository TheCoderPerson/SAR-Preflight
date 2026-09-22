const { assessRisk } = require('../../sar-preflight-core.js');

describe('assessRisk(wx, wind, elev, maxWindTol)', () => {
  // Helper to build minimal test data
  const defaultWx = () => ({
    visibility: 16000,         // ~10 miles in meters
    temperature_2m: 65,
    precipitation_probability: 0,
    weather_code: 0,
  });

  const defaultWind = () => ({ maxWind: 5, maxGust: 8 });
  const defaultElev = () => ({ center: 2000 });
  const defaultMaxWindTol = 27;

  describe('GO - all conditions nominal', () => {
    it('returns GO with nominal conditions', () => {
      const result = assessRisk(defaultWx(), defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('GO');
      expect(result.text).toBe('All conditions nominal for UAS operations');
      expect(result.issues).toEqual([]);
      expect(result.cautions).toEqual([]);
    });
  });

  describe('NO-GO conditions', () => {
    it('NO-GO when wind exceeds tolerance', () => {
      const wind = { maxWind: 30, maxGust: 35 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.text).toContain('exceeds limits');
    });

    it('NO-GO when gust exceeds tolerance + 5', () => {
      const wind = { maxWind: 20, maxGust: 33 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('NO-GO when thunderstorm (weather_code >= 95)', () => {
      const wx = { ...defaultWx(), weather_code: 95 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.text).toContain('Thunderstorm');
    });

    it('NO-GO when severe thunderstorm (weather_code 99)', () => {
      const wx = { ...defaultWx(), weather_code: 99 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.text).toContain('Thunderstorm');
    });

    it('NO-GO when thunderstorm with hail (weather_code 96)', () => {
      const wx = { ...defaultWx(), weather_code: 96 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
    });

    it('NO-GO when visibility < 1 mile', () => {
      const wx = { ...defaultWx(), visibility: 1000 }; // ~0.62 miles
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.text).toContain('Visibility');
    });

    it('NO-GO when precipitation > 60%', () => {
      const wx = { ...defaultWx(), precipitation_probability: 70 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.text).toContain('Precip');
    });

    it('multiple NO-GO issues joined with bullet', () => {
      const wx = { ...defaultWx(), weather_code: 95, visibility: 500 };
      const wind = { maxWind: 35, maxGust: 40 };
      const result = assessRisk(wx, wind, defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.issues.length).toBeGreaterThan(1);
      expect(result.text).toContain(' \u2022 ');
    });
  });

  describe('CAUTION conditions', () => {
    it('CAUTION when wind 15-27 mph (below tolerance)', () => {
      const wind = { maxWind: 20, maxGust: 25 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions).toContain('Elevated winds');
    });

    it('CAUTION when visibility 1-5 miles', () => {
      const wx = { ...defaultWx(), visibility: 4000 }; // ~2.5 miles
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('visibility'))).toBe(true);
    });

    it('CAUTION when precipitation 31-60%', () => {
      const wx = { ...defaultWx(), precipitation_probability: 40 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('Precip'))).toBe(true);
    });

    it('CAUTION when temperature < 35F', () => {
      const wx = { ...defaultWx(), temperature_2m: 30 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('Cold'))).toBe(true);
    });

    it('CAUTION when elevation > 6000 ft', () => {
      const elev = { center: 7000 };
      const result = assessRisk(defaultWx(), defaultWind(), elev, defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('elevation'))).toBe(true);
    });
  });

  describe('NO-GO takes precedence over CAUTION', () => {
    it('returns NO-GO when both issues and cautions exist', () => {
      const wx = { ...defaultWx(), weather_code: 95, temperature_2m: 30 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      // Cautions are still populated
      expect(result.cautions.length).toBeGreaterThan(0);
    });
  });

  describe('boundary tests at exact thresholds', () => {
    it('wind exactly at tolerance -> not NO-GO (uses >)', () => {
      const wind = { maxWind: 27, maxGust: 30 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), 27);
      // maxWind=27 > 27 is false; maxGust=30 > 32 is false
      // But maxWind=27 > 15 is true -> CAUTION
      expect(result.level).toBe('CAUTION');
    });

    it('wind 1 over tolerance -> NO-GO', () => {
      const wind = { maxWind: 28, maxGust: 30 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), 27);
      expect(result.level).toBe('NO-GO');
    });

    it('gust exactly at tolerance+5 -> not NO-GO (uses >)', () => {
      const wind = { maxWind: 15, maxGust: 32 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), 27);
      // maxWind=15 > 27 false; maxGust=32 > 32 false -> no wind issue
      // maxWind=15 > 15 false -> no wind caution either
      expect(result.level).toBe('GO');
    });

    it('gust 1 over tolerance+5 -> NO-GO', () => {
      const wind = { maxWind: 15, maxGust: 33 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), 27);
      expect(result.level).toBe('NO-GO');
    });

    it('visibility exactly 1 mile boundary', () => {
      // 1 mile = 1609.34 meters. vis = 1609.34 / 1609.34 = 1.0
      // vis < 1 is false -> not NO-GO; vis >= 1 && vis < 5 -> CAUTION
      const wx = { ...defaultWx(), visibility: 1609.34 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
    });

    it('visibility just below 1 mile -> NO-GO', () => {
      const wx = { ...defaultWx(), visibility: 1600 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
    });

    it('visibility exactly 5 miles -> GO (not < 5)', () => {
      const wx = { ...defaultWx(), visibility: 5 * 1609.34 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('GO');
    });

    it('precipitation exactly 30 -> GO (not > 30)', () => {
      const wx = { ...defaultWx(), precipitation_probability: 30 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('GO');
    });

    it('precipitation 31 -> CAUTION', () => {
      const wx = { ...defaultWx(), precipitation_probability: 31 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
    });

    it('precipitation exactly 60 -> CAUTION (not > 60)', () => {
      const wx = { ...defaultWx(), precipitation_probability: 60 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
    });

    it('precipitation 61 -> NO-GO', () => {
      const wx = { ...defaultWx(), precipitation_probability: 61 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
    });

    it('weather_code 94 -> not thunderstorm (< 95)', () => {
      const wx = { ...defaultWx(), weather_code: 94 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.issues.some(i => i.includes('Thunderstorm'))).toBe(false);
    });

    it('temperature exactly 35 -> GO (not < 35)', () => {
      const wx = { ...defaultWx(), temperature_2m: 35 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Cold'))).toBe(false);
    });

    it('temperature 34 -> CAUTION (cold)', () => {
      const wx = { ...defaultWx(), temperature_2m: 34 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Cold'))).toBe(true);
    });

    it('elevation exactly 6000 -> GO (not > 6000)', () => {
      const elev = { center: 6000 };
      const result = assessRisk(defaultWx(), defaultWind(), elev, defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('elevation'))).toBe(false);
    });

    it('elevation 6001 -> CAUTION', () => {
      const elev = { center: 6001 };
      const result = assessRisk(defaultWx(), defaultWind(), elev, defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('elevation'))).toBe(true);
    });
  });

  describe('empty/missing data — never a NO-GO, never a silent GO', () => {
    const UNAVAILABLE_CAUTIONS = [
      'Visibility unavailable — verify 3 SM minimum at launch',
      'Wind unavailable — verify sustained wind at launch is within 27 mph limit',
      'Gust unavailable — verify gusts at launch are within 32 mph limit',
      'Temp missing, assuming 20 °F (worst case) for flight-time estimates — cold/heat battery and prop-icing checks not verified',
      'Elevation missing, assuming 9,000 ft (worst case) for flight-time estimates — verify launch is below the aircraft service ceiling (16,404 ft)',
    ];

    it('empty objects: no NO-GO issues, but CAUTION because visibility, wind, temp and elevation cannot be verified', () => {
      const result = assessRisk({}, {}, {}, 27);
      expect(result.issues).toEqual([]);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions).toEqual(UNAVAILABLE_CAUTIONS);
      expect(result.unavailable).toEqual(['visibility', 'wind', 'gust', 'temperature', 'elevation']);
    });

    it('null/undefined fields: safe defaults for the rest, but missing visibility/wind/temp/elevation are reported unavailable', () => {
      const wx = { visibility: undefined, temperature_2m: null, precipitation_probability: undefined, weather_code: undefined };
      const wind = { maxWind: undefined, maxGust: undefined };
      const elev = { center: undefined };
      const result = assessRisk(wx, wind, elev, 27);
      expect(result.issues).toEqual([]);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions).toEqual(UNAVAILABLE_CAUTIONS);
    });

    it('missing wind is "Wind unavailable", never 0 mph calm', () => {
      for (const w of [{}, { maxWind: null, maxGust: null }, { maxWind: NaN, maxGust: NaN }, undefined]) {
        const result = assessRisk({ visibility: 16000, temperature_2m: 65 }, w, { center: 2000 }, 27);
        expect(result.level).toBe('CAUTION');
        expect(result.unavailable).toEqual(['wind', 'gust']);
        expect(result.cautions.some(c => c.startsWith('Wind unavailable'))).toBe(true);
        expect(result.cautions).not.toContain('Elevated winds');
      }
    });

    it('a real 0 mph wind is calm, not unavailable', () => {
      const result = assessRisk({ visibility: 16000, temperature_2m: 65 }, { maxWind: 0, maxGust: 0 }, { center: 2000 }, 27);
      expect(result.level).toBe('GO');
      expect(result.unavailable).toEqual([]);
    });

    it('known gust over the limit is still a limit when sustained wind is missing', () => {
      const result = assessRisk({ visibility: 16000, temperature_2m: 65 }, { maxWind: null, maxGust: 45 }, { center: 2000 }, 27);
      expect(result.level).toBe('NO-GO');
      expect(result.issues).toEqual(['Wind ?/45g exceeds limits']);
      expect(result.unavailable).toEqual(['wind']);
    });

    it('missing visibility is reported unavailable — not a NO-GO and not "Reduced visibility"', () => {
      const result = assessRisk({ temperature_2m: 65 }, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.issues.some(i => i.includes('Visibility'))).toBe(false);
      expect(result.cautions.some(c => c === 'Reduced visibility')).toBe(false);
      expect(result.unavailable).toEqual(['visibility']);
    });

    it('missing temperature says "Temp missing, assuming 20 °F (worst case)" and runs no cold/heat gate on the guess', () => {
      for (const tmp of [undefined, null, NaN]) {
        const result = assessRisk({ ...defaultWx(), temperature_2m: tmp }, defaultWind(), defaultElev(), defaultMaxWindTol);
        expect(result.level).toBe('CAUTION');
        expect(result.unavailable).toEqual(['temperature']);
        expect(result.cautions).toEqual(['Temp missing, assuming 20 °F (worst case) for flight-time estimates — cold/heat battery and prop-icing checks not verified']);
      }
    });

    it('a real 0 °F reading is judged, not treated as missing', () => {
      const result = assessRisk({ ...defaultWx(), temperature_2m: 0 }, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.unavailable).toEqual([]);
      // judged against the real reading: the default profile's cold LIMIT applies
      expect(result.issues.concat(result.cautions).some(x => /Temp 0°F below|^Cold/.test(x))).toBe(true);
    });

    it('missing elevation says "Elevation missing, assuming 9,000 ft (worst case)" and runs no elevation gate on the guess', () => {
      const result = assessRisk(defaultWx(), defaultWind(), {}, defaultMaxWindTol);
      expect(result.unavailable).toEqual(['elevation']);
      expect(result.cautions).toEqual([expect.stringMatching(/^Elevation missing, assuming 9,000 ft \(worst case\)/)]);  // no 'High elevation' from the guess
    });
  });

  describe('return structure', () => {
    it('always returns level, text, issues array, cautions array', () => {
      const result = assessRisk(defaultWx(), defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(typeof result.level).toBe('string');
      expect(typeof result.text).toBe('string');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(Array.isArray(result.cautions)).toBe(true);
    });

    it('level is one of GO, NO-GO, CAUTION', () => {
      const result = assessRisk(defaultWx(), defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(['GO', 'NO-GO', 'CAUTION']).toContain(result.level);
    });
  });

  describe('wind caution boundary: 15 mph', () => {
    it('wind exactly 15 -> GO (not > 15)', () => {
      const wind = { maxWind: 15, maxGust: 18 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Elevated winds'))).toBe(false);
    });

    it('wind 16 -> CAUTION (> 15)', () => {
      const wind = { maxWind: 16, maxGust: 18 };
      const result = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Elevated winds'))).toBe(true);
    });
  });

  describe('prop icing integration', () => {
    it('warm and dry conditions produce no icing caution or issue', () => {
      const wx = { ...defaultWx(), temperature_2m: 65, dew_point_2m: 45 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Prop icing'))).toBe(false);
      expect(result.issues.some(i => i.includes('Prop icing'))).toBe(false);
      expect(result.level).toBe('GO');
    });

    it('38F / 35F (3F spread) adds Prop icing CAUTION', () => {
      const wx = { ...defaultWx(), temperature_2m: 38, dew_point_2m: 35 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('Prop icing'))).toBe(true);
      expect(result.cautions.some(c => c.includes('3') && c.includes('spread'))).toBe(true);
    });

    it('30F / 28F (freezing + 2F spread) adds Prop icing NO-GO issue', () => {
      const wx = { ...defaultWx(), temperature_2m: 30, dew_point_2m: 28 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.issues.some(i => i.includes('Prop icing'))).toBe(true);
      expect(result.issues.some(i => i.includes('freezing'))).toBe(true);
    });

    it('icing NO-GO combined with wind NO-GO — both issues present', () => {
      const wx = { ...defaultWx(), temperature_2m: 28, dew_point_2m: 26 };
      const wind = { maxWind: 35, maxGust: 40 };
      const result = assessRisk(wx, wind, defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.issues.some(i => i.includes('Prop icing'))).toBe(true);
      expect(result.issues.some(i => i.includes('exceeds limits'))).toBe(true);
    });

    it('icing CAUTION under existing NO-GO — level stays NO-GO', () => {
      const wx = { ...defaultWx(), temperature_2m: 38, dew_point_2m: 35, visibility: 500 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.cautions.some(c => c.includes('Prop icing'))).toBe(true);
      expect(result.issues.some(i => i.includes('Visibility'))).toBe(true);
    });

    it('no dew_point_2m with warm temp — no icing caution', () => {
      const wx = { ...defaultWx(), temperature_2m: 65 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Prop icing'))).toBe(false);
      expect(result.issues.some(i => i.includes('Prop icing'))).toBe(false);
    });

    it('sub-freezing with no dew data — fallback Prop icing CAUTION', () => {
      const wx = { ...defaultWx(), temperature_2m: 25 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('Prop icing') && c.includes('sub-freezing'))).toBe(true);
    });

    it('boundary: exactly 41F / 36F — no icing trigger', () => {
      const wx = { ...defaultWx(), temperature_2m: 41, dew_point_2m: 36 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Prop icing'))).toBe(false);
      expect(result.issues.some(i => i.includes('Prop icing'))).toBe(false);
    });

    it('boundary: 40F / 35F (5F spread inclusive) — Prop icing CAUTION', () => {
      const wx = { ...defaultWx(), temperature_2m: 40, dew_point_2m: 35 };
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.cautions.some(c => c.includes('Prop icing'))).toBe(true);
    });
  });
});

// `wx.visibility ? … : 99` treated a reported ZERO as "missing" and substituted
// 99 mi, so dense fog produced "All conditions nominal". Missing is now its
// own case: a Part 107 minimum that cannot be checked must not feed a GO.
describe('assessRisk visibility — zero vs missing', () => {
  const wind = { maxWind: 5, maxGust: 8 };
  const elev = { center: 2000 };
  const nominal = { temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };

  it('visibility 0 m is NO-GO, not nominal', () => {
    const r = assessRisk(Object.assign({}, nominal, { visibility: 0 }), wind, elev, 27);
    expect(r.level).toBe('NO-GO');
    expect(r.text).toContain('Visibility 0.0 mi');
    expect(r.unavailable).toEqual([]);
  });

  it('missing visibility is CAUTION with an explicit "unavailable" note, never GO', () => {
    for (const wx of [nominal, Object.assign({}, nominal, { visibility: null }), Object.assign({}, nominal, { visibility: NaN }), Object.assign({}, nominal, { visibility: 'n/a' })]) {
      const r = assessRisk(wx, wind, elev, 27);
      expect(r.level).toBe('CAUTION');
      expect(r.issues).toEqual([]);
      expect(r.cautions.some(c => /Visibility unavailable/.test(c))).toBe(true);
      expect(r.cautions.some(c => /Reduced visibility/.test(c))).toBe(false);
      expect(r.unavailable).toEqual(['visibility']);
    }
  });

  it('missing visibility does not mask a real NO-GO', () => {
    const r = assessRisk(nominal, { maxWind: 40, maxGust: 50 }, elev, 27);
    expect(r.level).toBe('NO-GO');
    expect(r.unavailable).toEqual(['visibility']);
  });

  it('a numeric string is accepted as a value', () => {
    const r = assessRisk(Object.assign({}, nominal, { visibility: '16000' }), wind, elev, 27);
    expect(r.level).toBe('GO');
    expect(r.unavailable).toEqual([]);
  });
});
