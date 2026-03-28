const { TRAINING_SCENARIOS, assessRisk, DEFAULT_THRESHOLDS } = require('../../sar-preflight-core.js');

describe('TRAINING_SCENARIOS', () => {
  it('has 4 entries', () => {
    expect(TRAINING_SCENARIOS).toHaveLength(4);
  });

  it.each(TRAINING_SCENARIOS.map((s, i) => [i, s.name, s]))('scenario %i "%s" has required fields', (_i, _name, scenario) => {
    expect(scenario).toHaveProperty('name');
    expect(scenario).toHaveProperty('description');
    expect(scenario).toHaveProperty('center');
    expect(scenario.center).toHaveProperty('lat');
    expect(scenario.center).toHaveProperty('lng');
    expect(scenario).toHaveProperty('wx');
    expect(scenario).toHaveProperty('wind');
    expect(scenario).toHaveProperty('elev');
  });

  it('each scenario has wx fields needed by assessRisk', () => {
    for (const s of TRAINING_SCENARIOS) {
      expect(s.wx).toHaveProperty('visibility');
      expect(s.wx).toHaveProperty('temperature_2m');
      expect(s.wx).toHaveProperty('precipitation_probability');
      expect(s.wx).toHaveProperty('weather_code');
    }
  });

  it('each scenario has wind fields needed by assessRisk', () => {
    for (const s of TRAINING_SCENARIOS) {
      expect(s.wind).toHaveProperty('maxWind');
      expect(s.wind).toHaveProperty('maxGust');
      expect(s.wind).toHaveProperty('profile');
      expect(Array.isArray(s.wind.profile)).toBe(true);
    }
  });

  it('each scenario has elev.center', () => {
    for (const s of TRAINING_SCENARIOS) {
      expect(s.elev).toHaveProperty('center');
      expect(typeof s.elev.center).toBe('number');
    }
  });

  describe('risk assessment with default thresholds', () => {
    const maxWindTol = 27; // standard Part 107 tolerance

    it('High Wind scenario produces CAUTION or NO-GO', () => {
      const s = TRAINING_SCENARIOS[0];
      const result = assessRisk(s.wx, s.wind, s.elev, maxWindTol);
      expect(['CAUTION', 'NO-GO']).toContain(result.level);
    });

    it('Winter Storm scenario produces NO-GO', () => {
      const s = TRAINING_SCENARIOS[1];
      const result = assessRisk(s.wx, s.wind, s.elev, maxWindTol);
      expect(result.level).toBe('NO-GO');
      // Visibility is 800m = ~0.5 mi, below 1 mi NO-GO threshold
      expect(result.issues.some(i => i.includes('Visibility'))).toBe(true);
      // Precipitation is 85%, above 60% NO-GO threshold
      expect(result.issues.some(i => i.includes('Precip'))).toBe(true);
    });

    it('Perfect Conditions scenario produces GO', () => {
      const s = TRAINING_SCENARIOS[2];
      const result = assessRisk(s.wx, s.wind, s.elev, maxWindTol);
      expect(result.level).toBe('GO');
      expect(result.issues).toEqual([]);
      expect(result.cautions).toEqual([]);
    });

    it('Wildfire Smoke scenario produces CAUTION', () => {
      const s = TRAINING_SCENARIOS[3];
      const result = assessRisk(s.wx, s.wind, s.elev, maxWindTol);
      expect(result.level).toBe('CAUTION');
      // Visibility 4800m = ~3 mi, between 1-5 mi = CAUTION
      expect(result.cautions.some(c => c.includes('visibility'))).toBe(true);
    });
  });
});
