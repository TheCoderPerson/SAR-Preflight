const {
  calcSwapRecommendation,
} = require('../../sar-preflight-core.js');

// ============================================================
// calcSwapRecommendation
// ============================================================

describe('calcSwapRecommendation(estFlightTimeMin, cruiseSpeedMph, lzs)', () => {
  describe('swap timing', () => {
    it('swapTimeMin = 70% of total flight time', () => {
      const result = calcSwapRecommendation(30, 35, []);
      expect(result.swapTimeMin).toBeCloseTo(21, 1); // 30 * 0.70
    });

    it('swap time scales linearly with endurance', () => {
      const r1 = calcSwapRecommendation(20, 35, []);
      const r2 = calcSwapRecommendation(40, 35, []);
      expect(r2.swapTimeMin).toBeCloseTo(r1.swapTimeMin * 2, 1);
    });
  });

  describe('swap radius', () => {
    it('calculates correct swap radius in km', () => {
      // swapTimeMin = 30 * 0.70 = 21 min
      // swapRadiusKm = (35 * 21 / 60) * 1.609 / 2
      //              = (12.25) * 1.609 / 2
      //              = 9.855...
      const result = calcSwapRecommendation(30, 35, []);
      const expected = (35 * 21 / 60) * 1.609 / 2;
      expect(result.swapRadiusKm).toBeCloseTo(expected, 1);
    });

    it('higher cruise speed gives larger radius', () => {
      const slow = calcSwapRecommendation(30, 20, []);
      const fast = calcSwapRecommendation(30, 50, []);
      expect(fast.swapRadiusKm).toBeGreaterThan(slow.swapRadiusKm);
    });

    it('longer endurance gives larger radius', () => {
      const short = calcSwapRecommendation(15, 35, []);
      const long = calcSwapRecommendation(45, 35, []);
      expect(long.swapRadiusKm).toBeGreaterThan(short.swapRadiusKm);
    });
  });

  describe('LZ selection', () => {
    it('picks highest-scored LZ when available', () => {
      const lzs = [
        { lat: 38.5, lng: -120.5, score: 0.9 },
        { lat: 38.6, lng: -120.4, score: 0.7 },
      ];
      const result = calcSwapRecommendation(30, 35, lzs);
      expect(result.nearestLZ).not.toBeNull();
      expect(result.nearestLZ.score).toBe(0.9);
      expect(result.nearestLZ.lat).toBe(38.5);
    });

    it('returns null nearestLZ when no LZs available', () => {
      const result = calcSwapRecommendation(30, 35, []);
      expect(result.nearestLZ).toBeNull();
    });

    it('returns null nearestLZ when lzs is null', () => {
      const result = calcSwapRecommendation(30, 35, null);
      expect(result.nearestLZ).toBeNull();
    });

    it('returns null nearestLZ when lzs is undefined', () => {
      const result = calcSwapRecommendation(30, 35, undefined);
      expect(result.nearestLZ).toBeNull();
    });
  });

  describe('recommendation text', () => {
    it('includes swap time in recommendation', () => {
      const result = calcSwapRecommendation(30, 35, []);
      expect(result.recommendation).toContain('21');
    });

    it('includes radius in recommendation', () => {
      const result = calcSwapRecommendation(30, 35, []);
      expect(result.recommendation).toContain('km');
    });

    it('mentions LZ when available', () => {
      const lzs = [{ lat: 38.5, lng: -120.5, score: 0.8 }];
      const result = calcSwapRecommendation(30, 35, lzs);
      expect(result.recommendation.toLowerCase()).toContain('lz');
    });

    it('mentions manual recovery when no LZ available', () => {
      const result = calcSwapRecommendation(30, 35, []);
      expect(result.recommendation.toLowerCase()).toContain('manual');
    });

    it('warns about very short endurance', () => {
      // 5 min flight * 0.70 = 3.5 min < 5
      const result = calcSwapRecommendation(5, 35, []);
      expect(result.recommendation.toLowerCase()).toContain('short');
    });
  });

  describe('return structure', () => {
    it('returns all expected properties', () => {
      const result = calcSwapRecommendation(30, 35, []);
      expect(result).toHaveProperty('swapTimeMin');
      expect(result).toHaveProperty('swapRadiusKm');
      expect(result).toHaveProperty('nearestLZ');
      expect(result).toHaveProperty('recommendation');
      expect(typeof result.swapTimeMin).toBe('number');
      expect(typeof result.swapRadiusKm).toBe('number');
      expect(typeof result.recommendation).toBe('string');
    });
  });

  describe('edge cases', () => {
    it('handles zero flight time', () => {
      const result = calcSwapRecommendation(0, 35, []);
      expect(result.swapTimeMin).toBe(0);
      expect(result.swapRadiusKm).toBe(0);
    });

    it('handles zero cruise speed', () => {
      const result = calcSwapRecommendation(30, 0, []);
      expect(result.swapRadiusKm).toBe(0);
    });

    it('handles very large flight time', () => {
      const result = calcSwapRecommendation(120, 50, []);
      expect(result.swapTimeMin).toBeCloseTo(84, 1);
      expect(result.swapRadiusKm).toBeGreaterThan(0);
    });
  });
});
