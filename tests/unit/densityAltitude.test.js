const { calcDensityAltitude } = require('../../sar-preflight-core.js');

describe('calcDensityAltitude(tempF, surfacePressureHPa, elevFt)', () => {
  describe('standard atmosphere at sea level', () => {
    it('59F, 1013.25 hPa, 0 ft -> near 0 density altitude', () => {
      const da = calcDensityAltitude(59, 1013.25, 0);
      // Standard atmosphere: 59F (15C) at sea level should yield DA near 0
      expect(da).toBeGreaterThan(-200);
      expect(da).toBeLessThan(200);
    });
  });

  describe('hot day at altitude', () => {
    it('95F at 5000 ft with std pressure should produce high DA', () => {
      const da = calcDensityAltitude(95, 1013.25, 5000);
      // Hot day at elevation: DA should be much higher than field elevation
      expect(da).toBeGreaterThan(5000);
    });

    it('100F at 6000 ft with lower pressure increases DA further', () => {
      const da = calcDensityAltitude(100, 1000, 6000);
      // Low pressure + heat + altitude all increase DA
      expect(da).toBeGreaterThan(7000);
    });
  });

  describe('cold day', () => {
    it('0F at sea level should produce negative DA', () => {
      const da = calcDensityAltitude(0, 1013.25, 0);
      // 0F = -17.8C, ISA = 15C, deviation = -32.8C -> negative DA
      expect(da).toBeLessThan(0);
    });

    it('cold day at altitude still shows decrease relative to ISA', () => {
      const da = calcDensityAltitude(20, 1013.25, 5000);
      // 20F = -6.7C, ISA at 5000ft = 15 - 2*5 = 5C, deviation = -11.7C
      // DA should be below field elevation
      expect(da).toBeLessThan(5000);
    });
  });

  describe('pressure effects', () => {
    it('lower pressure increases DA (same temp/elev)', () => {
      const daStd = calcDensityAltitude(59, 1013.25, 0);
      const daLow = calcDensityAltitude(59, 990, 0);
      expect(daLow).toBeGreaterThan(daStd);
    });

    it('higher pressure decreases DA', () => {
      const daStd = calcDensityAltitude(59, 1013.25, 0);
      const daHigh = calcDensityAltitude(59, 1030, 0);
      expect(daHigh).toBeLessThan(daStd);
    });
  });

  describe('temperature effects', () => {
    it('higher temp increases DA (same pressure/elev)', () => {
      const daCool = calcDensityAltitude(60, 1013.25, 3000);
      const daHot = calcDensityAltitude(100, 1013.25, 3000);
      expect(daHot).toBeGreaterThan(daCool);
    });
  });

  describe('returns integer (Math.round)', () => {
    it('result is always a whole number', () => {
      const da = calcDensityAltitude(75, 1010, 3500);
      expect(Number.isInteger(da)).toBe(true);
    });
  });

  describe('realistic SAR scenarios', () => {
    it('Placerville area summer (90F, 1012 hPa, 1900 ft)', () => {
      const da = calcDensityAltitude(90, 1012, 1900);
      expect(da).toBeGreaterThan(1900);
      expect(typeof da).toBe('number');
    });

    it('Sierra Nevada high elevation (50F, 1000 hPa, 8000 ft)', () => {
      const da = calcDensityAltitude(50, 1000, 8000);
      expect(typeof da).toBe('number');
    });
  });
});
