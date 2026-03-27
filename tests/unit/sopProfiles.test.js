const { assessRisk, DEFAULT_THRESHOLDS } = require('../../sar-preflight-core.js');

describe('assessRisk with custom thresholds', () => {
  const defaultWx = () => ({
    visibility: 16000,         // ~10 miles in meters
    temperature_2m: 65,
    precipitation_probability: 0,
    weather_code: 0,
  });
  const defaultWind = () => ({ maxWind: 5, maxGust: 8 });
  const defaultElev = () => ({ center: 2000 });
  const defaultMaxWindTol = 27;

  describe('DEFAULT_THRESHOLDS constant', () => {
    it('has all expected fields', () => {
      expect(DEFAULT_THRESHOLDS).toHaveProperty('visNoGo', 1);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('visCaution', 5);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('precipNoGo', 60);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('precipCaution', 30);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('windCaution', 15);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('tempCaution', 35);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('elevCaution', 6000);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('weatherCodeNoGo', 95);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('name', 'Default');
    });
  });

  describe('backwards compatibility — default thresholds', () => {
    it('returns GO with nominal conditions (no thresholds arg)', () => {
      const result = assessRisk(defaultWx(), defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('GO');
      expect(result.issues).toEqual([]);
      expect(result.cautions).toEqual([]);
    });

    it('returns same result with explicit DEFAULT_THRESHOLDS as with no thresholds', () => {
      const wx = defaultWx();
      const wind = defaultWind();
      const elev = defaultElev();
      const without = assessRisk(wx, wind, elev, defaultMaxWindTol);
      const withDef = assessRisk(wx, wind, elev, defaultMaxWindTol, DEFAULT_THRESHOLDS);
      expect(withDef).toEqual(without);
    });

    it('NO-GO at visibility < 1 mi with defaults', () => {
      const wx = { ...defaultWx(), visibility: 1000 }; // ~0.62 mi
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('NO-GO');
      expect(result.issues.some(i => i.includes('Visibility'))).toBe(true);
    });

    it('CAUTION at visibility 2 mi with defaults', () => {
      const wx = { ...defaultWx(), visibility: 3218 }; // ~2 mi
      const result = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(result.level).toBe('CAUTION');
      expect(result.cautions.some(c => c.includes('visibility'))).toBe(true);
    });
  });

  describe('custom thresholds override defaults', () => {
    it('custom lower visNoGo triggers NO-GO at 2 mi (would be CAUTION with defaults)', () => {
      const customThresholds = {
        ...DEFAULT_THRESHOLDS,
        visNoGo: 3,      // raise NO-GO threshold to 3 mi
        visCaution: 5,
      };
      const wx = { ...defaultWx(), visibility: 3218 }; // ~2 mi
      // With defaults this would be CAUTION
      const defaultResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(defaultResult.level).toBe('CAUTION');
      // With custom thresholds this becomes NO-GO
      const customResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol, customThresholds);
      expect(customResult.level).toBe('NO-GO');
      expect(customResult.issues.some(i => i.includes('Visibility'))).toBe(true);
    });

    it('custom higher windCaution triggers CAUTION at 10 mph (default is 15)', () => {
      const customThresholds = {
        ...DEFAULT_THRESHOLDS,
        windCaution: 8, // lower the caution threshold
      };
      const wind = { maxWind: 10, maxGust: 14 };
      // With defaults, 10 mph wind is below 15 caution threshold = GO
      const defaultResult = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol);
      expect(defaultResult.level).toBe('GO');
      // With custom thresholds, 10 mph > 8 = CAUTION
      const customResult = assessRisk(defaultWx(), wind, defaultElev(), defaultMaxWindTol, customThresholds);
      expect(customResult.level).toBe('CAUTION');
      expect(customResult.cautions.some(c => c.includes('winds'))).toBe(true);
    });

    it('custom precipNoGo raises the NO-GO precip threshold', () => {
      const customThresholds = {
        ...DEFAULT_THRESHOLDS,
        precipNoGo: 80,
        precipCaution: 40,
      };
      const wx = { ...defaultWx(), precipitation_probability: 65 };
      // With defaults, 65% > 60% = NO-GO
      const defaultResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(defaultResult.level).toBe('NO-GO');
      // With custom, 65% is between 40-80 = CAUTION
      const customResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol, customThresholds);
      expect(customResult.level).toBe('CAUTION');
    });

    it('custom tempCaution changes cold threshold', () => {
      const customThresholds = {
        ...DEFAULT_THRESHOLDS,
        tempCaution: 50, // raise cold caution to 50F
      };
      const wx = { ...defaultWx(), temperature_2m: 45 };
      // With defaults, 45F > 35 = GO
      const defaultResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(defaultResult.level).toBe('GO');
      // With custom, 45F < 50 = CAUTION
      const customResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol, customThresholds);
      expect(customResult.level).toBe('CAUTION');
      expect(customResult.cautions.some(c => c.includes('Cold'))).toBe(true);
    });

    it('custom weatherCodeNoGo changes thunderstorm threshold', () => {
      const customThresholds = {
        ...DEFAULT_THRESHOLDS,
        weatherCodeNoGo: 80, // lower threshold to include heavy rain showers
      };
      const wx = { ...defaultWx(), weather_code: 82 }; // heavy rain showers
      // With defaults, code 82 < 95 = GO
      const defaultResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol);
      expect(defaultResult.level).toBe('GO');
      // With custom, code 82 >= 80 = NO-GO
      const customResult = assessRisk(wx, defaultWind(), defaultElev(), defaultMaxWindTol, customThresholds);
      expect(customResult.level).toBe('NO-GO');
      expect(customResult.issues.some(i => i.includes('Thunderstorm'))).toBe(true);
    });
  });
});
