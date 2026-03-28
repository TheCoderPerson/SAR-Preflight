const { calcDensityAltitude } = require('../../sar-preflight-core.js');

describe('calcDensityAltitude(tempF, surfacePressureHPa)', () => {
  describe('standard atmosphere at sea level', () => {
    it('59F, 1013.25 hPa -> near 0 density altitude', () => {
      const da = calcDensityAltitude(59, 1013.25);
      // Standard atmosphere: 59F (15C) at sea level should yield DA near 0
      expect(da).toBeGreaterThan(-200);
      expect(da).toBeLessThan(200);
    });
  });

  describe('hot day at altitude', () => {
    it('95F with station pressure for ~5000 ft should produce high DA', () => {
      // Station pressure ~843 hPa is standard for ~5000 ft elevation
      const da = calcDensityAltitude(95, 843);
      // Hot day at elevation: DA should be well above pressure altitude
      expect(da).toBeGreaterThan(5000);
    });

    it('100F with low station pressure increases DA further', () => {
      // ~800 hPa station pressure corresponds to ~6400 ft pressure altitude
      const da = calcDensityAltitude(100, 800);
      expect(da).toBeGreaterThan(7000);
    });
  });

  describe('cold day', () => {
    it('0F at sea level should produce negative DA', () => {
      const da = calcDensityAltitude(0, 1013.25);
      // 0F = -17.8C, ISA = 15C, deviation = -32.8C -> negative DA
      expect(da).toBeLessThan(0);
    });

    it('cold day at altitude still shows decrease relative to ISA', () => {
      // ~843 hPa → pressAlt ~5100 ft, ISA temp ~4.8C, 20F = -6.7C → below ISA
      const da = calcDensityAltitude(20, 843);
      expect(da).toBeLessThan(5100);
    });
  });

  describe('pressure effects', () => {
    it('lower pressure increases DA (same temp)', () => {
      const daStd = calcDensityAltitude(59, 1013.25);
      const daLow = calcDensityAltitude(59, 990);
      expect(daLow).toBeGreaterThan(daStd);
    });

    it('higher pressure decreases DA', () => {
      const daStd = calcDensityAltitude(59, 1013.25);
      const daHigh = calcDensityAltitude(59, 1030);
      expect(daHigh).toBeLessThan(daStd);
    });
  });

  describe('temperature effects', () => {
    it('higher temp increases DA (same pressure)', () => {
      const daCool = calcDensityAltitude(60, 900);
      const daHot = calcDensityAltitude(100, 900);
      expect(daHot).toBeGreaterThan(daCool);
    });
  });

  describe('returns integer (Math.round)', () => {
    it('result is always a whole number', () => {
      const da = calcDensityAltitude(75, 855);
      expect(Number.isInteger(da)).toBe(true);
    });
  });

  describe('realistic SAR scenarios', () => {
    it('Placerville area summer (90F, station pressure ~942 hPa for ~1900 ft)', () => {
      const da = calcDensityAltitude(90, 942);
      // pressAlt ~2138 ft + hot temp → DA should exceed pressure altitude
      expect(da).toBeGreaterThan(2000);
      expect(typeof da).toBe('number');
    });

    it('Sierra Nevada high elevation (50F, station pressure ~750 hPa for ~8000 ft)', () => {
      const da = calcDensityAltitude(50, 750);
      expect(typeof da).toBe('number');
    });

    it('user-reported scenario: 70F, 840.5 hPa (24.82 inHg) at ~5500 ft → DA ~7000 ft', () => {
      const da = calcDensityAltitude(70, 840.5);
      // pressAlt ≈ 5182 ft, temp 21C vs ISA ~4.6C → ~16.4C above → DA ~7150
      expect(da).toBeGreaterThan(6500);
      expect(da).toBeLessThan(8000);
    });
  });
});
