const { assessRisk, DEFAULT_THRESHOLDS, DRONE_PROFILES } = require('../../sar-preflight-core.js');

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

  describe('expanded DEFAULT_THRESHOLDS (aircraft + new gates)', () => {
    it('carries the aircraft-spec keys with sensible defaults', () => {
      expect(DEFAULT_THRESHOLDS).toHaveProperty('maxWindTol', 27);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('gustMargin', 5);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('flightTime', 38);
      expect(DEFAULT_THRESHOLDS).toHaveProperty('serviceCeiling');
      expect(DEFAULT_THRESHOLDS).toHaveProperty('maxSpeed');
    });
    it('carries the new weather/terrain/gnss gate keys', () => {
      ['tempColdNoGo', 'tempHotCaution', 'tempHotNoGo', 'densAltCaution', 'densAltNoGo',
       'ceilingMarginFt', 'maxAltAGL', 'kpCaution', 'aqiCaution', 'aqiNoGo',
       'fireCautionNm', 'fireNoGoNm'].forEach(k => {
        expect(DEFAULT_THRESHOLDS[k]).toBeTypeOf('number');
      });
      expect(DEFAULT_THRESHOLDS.maxAltAGL).toBe(400); // Part 107 §107.51(b)
    });
  });

  describe('new assessRisk gates', () => {
    const baseWx = () => ({ visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 });

    it('gust above maxWindTol + gustMargin = NO-GO; larger margin clears it', () => {
      const wind = { maxWind: 20, maxGust: 35 };
      // default gustMargin 5 -> 35 > 27+5 -> NO-GO
      expect(assessRisk(baseWx(), wind, { center: 2000 }, 27, DEFAULT_THRESHOLDS).level).toBe('NO-GO');
      // gustMargin 10 -> 35 > 37 false -> not a gust NO-GO (20<27 -> CAUTION elevated winds)
      const loose = { ...DEFAULT_THRESHOLDS, gustMargin: 10 };
      expect(assessRisk(baseWx(), wind, { center: 2000 }, 27, loose).level).toBe('CAUTION');
    });

    it('hot temperature: CAUTION above tempHotCaution, NO-GO above tempHotNoGo', () => {
      const caution = assessRisk({ ...baseWx(), temperature_2m: 98 }, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27, DEFAULT_THRESHOLDS);
      expect(caution.level).toBe('CAUTION');
      expect(caution.cautions.some(c => c.includes('Heat'))).toBe(true);
      const nogo = assessRisk({ ...baseWx(), temperature_2m: 110 }, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27, DEFAULT_THRESHOLDS);
      expect(nogo.level).toBe('NO-GO');
      expect(nogo.issues.some(i => i.includes('above aircraft limit'))).toBe(true);
    });

    it('cold below tempColdNoGo = NO-GO (not just the cold caution)', () => {
      const r = assessRisk({ ...baseWx(), temperature_2m: 5 }, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27, DEFAULT_THRESHOLDS);
      expect(r.level).toBe('NO-GO');
      expect(r.issues.some(i => i.includes('below aircraft limit'))).toBe(true);
    });

    it('launch elevation above the aircraft service ceiling = NO-GO', () => {
      const neo = { ...DEFAULT_THRESHOLDS, serviceCeiling: 6562 };
      const r = assessRisk(baseWx(), { maxWind: 5, maxGust: 8 }, { center: 7000 }, 18, neo);
      expect(r.level).toBe('NO-GO');
      expect(r.issues.some(i => i.includes('ceiling'))).toBe(true);
    });

    it('near the service ceiling (within margin) = CAUTION', () => {
      const neo = { ...DEFAULT_THRESHOLDS, serviceCeiling: 6562, ceilingMarginFt: 1500, elevCaution: 9000 };
      const r = assessRisk(baseWx(), { maxWind: 5, maxGust: 8 }, { center: 6000 }, 18, neo);
      expect(r.level).toBe('CAUTION');
      expect(r.cautions.some(c => c.includes('service ceiling'))).toBe(true);
    });

    it('density altitude gate only fires when surface_pressure is present', () => {
      // No pressure -> dormant
      expect(assessRisk(baseWx(), { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27, DEFAULT_THRESHOLDS).level).toBe('GO');
      // Low pressure + warm -> density altitude NO-GO
      const hot = assessRisk({ ...baseWx(), temperature_2m: 86, surface_pressure: 800 }, { maxWind: 5, maxGust: 8 }, { center: 2000 }, 27, DEFAULT_THRESHOLDS);
      expect(hot.level).toBe('NO-GO');
      expect(hot.issues.some(i => i.includes('Density altitude'))).toBe(true);
    });
  });

  describe('DRONE_PROFILES built-ins', () => {
    it('exposes a non-empty array of profiles', () => {
      expect(Array.isArray(DRONE_PROFILES)).toBe(true);
      expect(DRONE_PROFILES.length).toBeGreaterThanOrEqual(14);
    });

    it('every profile is a full threshold object with sane aircraft specs', () => {
      const required = Object.keys(DEFAULT_THRESHOLDS);
      DRONE_PROFILES.forEach(p => {
        expect(typeof p.name).toBe('string');
        expect(typeof p.model).toBe('string');
        // inherits every DEFAULT_THRESHOLDS key (so loading sets all gates)
        required.forEach(k => expect(p[k]).toBeDefined());
        expect(p.maxWindTol).toBeGreaterThanOrEqual(10);
        expect(p.maxWindTol).toBeLessThanOrEqual(40);
        expect(p.windCaution).toBeLessThan(p.maxWindTol);          // caution below NO-GO
        expect(p.windCaution).toBeGreaterThan(p.maxWindTol * 0.5); // ~0.65x rated
        expect(p.flightTime).toBeGreaterThan(10);
        expect(p.flightTime).toBeLessThan(70);
        expect(p.serviceCeiling).toBeGreaterThan(5000);
        expect(p.tempColdNoGo).toBeLessThan(p.tempHotNoGo);
      });
    });

    it('includes the requested airframes with researched specs', () => {
      const byName = Object.fromEntries(DRONE_PROFILES.map(p => [p.name, p]));
      expect(byName['Skydio X10']).toMatchObject({ maxWindTol: 28, windCaution: 18, flightTime: 40 });
      expect(byName['DJI Matrice 300 RTK']).toMatchObject({ maxWindTol: 27, flightTime: 55 });
      expect(byName['DJI Mini 5 Pro']).toBeDefined();
      expect(byName['DJI Neo']).toMatchObject({ maxWindTol: 18, windCaution: 12 });
    });

    it('loading a profile changes the wind verdict (Neo stricter than M300)', () => {
      const wx = { visibility: 16000, temperature_2m: 65, precipitation_probability: 0, weather_code: 0 };
      const wind = { maxWind: 20, maxGust: 22 };
      const neo = DRONE_PROFILES.find(p => p.name === 'DJI Neo');
      const m300 = DRONE_PROFILES.find(p => p.name === 'DJI Matrice 300 RTK');
      // 20 mph > Neo's 18 NO-GO -> NO-GO
      expect(assessRisk(wx, wind, { center: 2000 }, neo.maxWindTol, neo).level).toBe('NO-GO');
      // 20 mph < M300's 27 NO-GO, > 17 caution -> CAUTION
      expect(assessRisk(wx, wind, { center: 2000 }, m300.maxWindTol, m300).level).toBe('CAUTION');
    });
  });
});
