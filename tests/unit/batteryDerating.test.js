const { calcBatteryDerating } = require('../../sar-preflight-core.js');

describe('calcBatteryDerating(tempF, elevFt, maxWindMph)', () => {
  describe('return structure', () => {
    it('returns object with tempFactor, altFactor, windFactor, combined', () => {
      const result = calcBatteryDerating(70, 0, 0);
      expect(result).toHaveProperty('tempFactor');
      expect(result).toHaveProperty('altFactor');
      expect(result).toHaveProperty('windFactor');
      expect(result).toHaveProperty('combined');
    });
  });

  describe('temperature factor', () => {
    it('very cold (< 32F / 0C) -> 0.70', () => {
      // 31F = -0.56C (below 0C)
      const result = calcBatteryDerating(31, 0, 0);
      expect(result.tempFactor).toBe(0.70);
    });

    it('cold (32-41F / 0-5C) -> 0.82', () => {
      // 37F = 2.78C (between 0 and 5C)
      const result = calcBatteryDerating(37, 0, 0);
      expect(result.tempFactor).toBe(0.82);
    });

    it('cool (41-50F / 5-10C) -> 0.90', () => {
      // 45F = 7.22C (between 5 and 10C)
      const result = calcBatteryDerating(45, 0, 0);
      expect(result.tempFactor).toBe(0.90);
    });

    it('normal (70F / 21C) -> 1.0', () => {
      const result = calcBatteryDerating(70, 0, 0);
      expect(result.tempFactor).toBe(1.0);
    });

    it('hot (> 95F / 35C) -> 0.92', () => {
      // 96F = 35.56C (above 35C)
      const result = calcBatteryDerating(96, 0, 0);
      expect(result.tempFactor).toBe(0.92);
    });

    it('extreme cold (-10F) -> 0.70', () => {
      const result = calcBatteryDerating(-10, 0, 0);
      expect(result.tempFactor).toBe(0.70);
    });

    it('boundary: exactly 32F (0C) -> 0.82 (not below 0)', () => {
      const result = calcBatteryDerating(32, 0, 0);
      expect(result.tempFactor).toBe(0.82);
    });

    it('boundary: exactly 50F (10C) -> 1.0 (not below 10)', () => {
      const result = calcBatteryDerating(50, 0, 0);
      expect(result.tempFactor).toBe(1.0);
    });
  });

  describe('altitude factor', () => {
    it('sea level (0 ft) -> 1.0', () => {
      const result = calcBatteryDerating(70, 0, 0);
      expect(result.altFactor).toBe(1.0);
    });

    it('low elevation (1000 ft) -> 1.0', () => {
      const result = calcBatteryDerating(70, 1000, 0);
      expect(result.altFactor).toBe(1.0);
    });

    it('2000-4000 ft -> 0.95', () => {
      const result = calcBatteryDerating(70, 3000, 0);
      expect(result.altFactor).toBe(0.95);
    });

    it('4000-6000 ft -> 0.90', () => {
      const result = calcBatteryDerating(70, 5000, 0);
      expect(result.altFactor).toBe(0.90);
    });

    it('6000-8000 ft -> 0.82', () => {
      const result = calcBatteryDerating(70, 7000, 0);
      expect(result.altFactor).toBe(0.82);
    });

    it('> 8000 ft -> 0.75', () => {
      const result = calcBatteryDerating(70, 9000, 0);
      expect(result.altFactor).toBe(0.75);
    });

    it('boundary: exactly 2000 ft -> 1.0 (not > 2000)', () => {
      const result = calcBatteryDerating(70, 2000, 0);
      expect(result.altFactor).toBe(1.0);
    });

    it('boundary: 2001 ft -> 0.95', () => {
      const result = calcBatteryDerating(70, 2001, 0);
      expect(result.altFactor).toBe(0.95);
    });

    it('boundary: exactly 4000 ft -> 0.95 (not > 4000)', () => {
      const result = calcBatteryDerating(70, 4000, 0);
      expect(result.altFactor).toBe(0.95);
    });

    it('boundary: 4001 ft -> 0.90', () => {
      const result = calcBatteryDerating(70, 4001, 0);
      expect(result.altFactor).toBe(0.90);
    });

    it('boundary: exactly 6000 ft -> 0.90 (not > 6000)', () => {
      const result = calcBatteryDerating(70, 6000, 0);
      expect(result.altFactor).toBe(0.90);
    });

    it('boundary: exactly 8000 ft -> 0.82 (not > 8000)', () => {
      const result = calcBatteryDerating(70, 8000, 0);
      expect(result.altFactor).toBe(0.82);
    });

    it('boundary: 8001 ft -> 0.75', () => {
      const result = calcBatteryDerating(70, 8001, 0);
      expect(result.altFactor).toBe(0.75);
    });
  });

  describe('wind factor', () => {
    it('calm (0 mph) -> 1.0', () => {
      const result = calcBatteryDerating(70, 0, 0);
      expect(result.windFactor).toBe(1.0);
    });

    it('light wind (5 mph) -> 1.0', () => {
      const result = calcBatteryDerating(70, 0, 5);
      expect(result.windFactor).toBe(1.0);
    });

    it('10-15 mph -> 0.88', () => {
      const result = calcBatteryDerating(70, 0, 12);
      expect(result.windFactor).toBe(0.88);
    });

    it('15-20 mph -> 0.80', () => {
      const result = calcBatteryDerating(70, 0, 18);
      expect(result.windFactor).toBe(0.80);
    });

    it('20-25 mph -> 0.72', () => {
      const result = calcBatteryDerating(70, 0, 23);
      expect(result.windFactor).toBe(0.72);
    });

    it('> 25 mph -> 0.65', () => {
      const result = calcBatteryDerating(70, 0, 30);
      expect(result.windFactor).toBe(0.65);
    });

    it('boundary: exactly 10 mph -> 1.0 (not > 10)', () => {
      const result = calcBatteryDerating(70, 0, 10);
      expect(result.windFactor).toBe(1.0);
    });

    it('boundary: 10.1 mph -> 0.88', () => {
      const result = calcBatteryDerating(70, 0, 10.1);
      expect(result.windFactor).toBe(0.88);
    });

    it('boundary: exactly 15 mph -> 0.88 (not > 15)', () => {
      const result = calcBatteryDerating(70, 0, 15);
      expect(result.windFactor).toBe(0.88);
    });

    it('boundary: exactly 20 mph -> 0.80 (not > 20)', () => {
      const result = calcBatteryDerating(70, 0, 20);
      expect(result.windFactor).toBe(0.80);
    });

    it('boundary: exactly 25 mph -> 0.72 (not > 25)', () => {
      const result = calcBatteryDerating(70, 0, 25);
      expect(result.windFactor).toBe(0.72);
    });

    it('boundary: 25.1 mph -> 0.65', () => {
      const result = calcBatteryDerating(70, 0, 25.1);
      expect(result.windFactor).toBe(0.65);
    });
  });

  describe('combined factor', () => {
    it('best case: normal temp, low elev, no wind -> combined = 1.0', () => {
      const result = calcBatteryDerating(70, 0, 0);
      expect(result.combined).toBe(1.0);
    });

    it('worst case: freezing, high alt, high wind -> combined approx 0.34', () => {
      // tempFactor=0.70, altFactor=0.75, windFactor=0.65
      const result = calcBatteryDerating(-10, 9000, 30);
      expect(result.tempFactor).toBe(0.70);
      expect(result.altFactor).toBe(0.75);
      expect(result.windFactor).toBe(0.65);
      const expectedCombined = 0.70 * 0.75 * 0.65;
      expect(result.combined).toBeCloseTo(expectedCombined, 10);
    });

    it('combined equals product of all three factors', () => {
      const result = calcBatteryDerating(45, 5000, 18);
      const expected = result.tempFactor * result.altFactor * result.windFactor;
      expect(result.combined).toBeCloseTo(expected, 10);
    });

    it('moderate conditions: 50F, 3000ft, 12mph', () => {
      const result = calcBatteryDerating(50, 3000, 12);
      // tempFactor=1.0 (10C), altFactor=0.95, windFactor=0.88
      expect(result.combined).toBeCloseTo(1.0 * 0.95 * 0.88, 10);
    });
  });
});
