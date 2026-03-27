const {
  generateSearchPattern,
} = require('../../sar-preflight-core.js');

// ============================================================
// generateSearchPattern
// ============================================================

const DEFAULT_BOUNDS = { north: 38.7, south: 38.6, east: -120.4, west: -120.5 };
const NARROW_BOUNDS = { north: 38.61, south: 38.60, east: -120.49, west: -120.50 };

describe('generateSearchPattern(bounds, windDirDeg, patternType, trackSpacingM)', () => {
  describe('return structure', () => {
    it('returns waypoints, estimatedDistanceKm, and legs', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      expect(result).toHaveProperty('waypoints');
      expect(result).toHaveProperty('estimatedDistanceKm');
      expect(result).toHaveProperty('legs');
      expect(Array.isArray(result.waypoints)).toBe(true);
      expect(typeof result.estimatedDistanceKm).toBe('number');
      expect(typeof result.legs).toBe('number');
    });

    it('waypoints are [lat, lng] pairs', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      result.waypoints.forEach(wp => {
        expect(wp).toHaveLength(2);
        expect(typeof wp[0]).toBe('number');
        expect(typeof wp[1]).toBe('number');
      });
    });
  });

  // ============================================================
  // Parallel pattern
  // ============================================================

  describe('parallel pattern', () => {
    it('generates waypoints for parallel tracks', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      expect(result.waypoints.length).toBeGreaterThan(0);
      expect(result.legs).toBeGreaterThan(0);
    });

    it('more legs with tighter spacing', () => {
      const wide = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 500);
      const tight = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      expect(tight.legs).toBeGreaterThan(wide.legs);
    });

    it('produces 2 waypoints per leg (back-and-forth)', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 200);
      // Each leg has 2 waypoints (start and end of the track)
      expect(result.waypoints.length).toBe(result.legs * 2);
    });

    it('estimated distance is positive', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      expect(result.estimatedDistanceKm).toBeGreaterThan(0);
    });

    it('longer total distance with tighter spacing', () => {
      const wide = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 500);
      const tight = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      expect(tight.estimatedDistanceKm).toBeGreaterThan(wide.estimatedDistanceKm);
    });

    it('generates pattern for different wind directions', () => {
      const northWind = generateSearchPattern(DEFAULT_BOUNDS, 0, 'parallel', 200);
      const westWind = generateSearchPattern(DEFAULT_BOUNDS, 270, 'parallel', 200);
      expect(northWind.waypoints.length).toBeGreaterThan(0);
      expect(westWind.waypoints.length).toBeGreaterThan(0);
    });

    it('has at least 1 leg for very wide spacing', () => {
      const result = generateSearchPattern(NARROW_BOUNDS, 180, 'parallel', 10000);
      expect(result.legs).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // Expanding square pattern
  // ============================================================

  describe('expanding_square pattern', () => {
    it('generates waypoints starting from center', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'expanding_square', 100);
      expect(result.waypoints.length).toBeGreaterThan(0);
      // First waypoint should be near center
      const centerLat = (DEFAULT_BOUNDS.north + DEFAULT_BOUNDS.south) / 2;
      const centerLng = (DEFAULT_BOUNDS.east + DEFAULT_BOUNDS.west) / 2;
      expect(result.waypoints[0][0]).toBeCloseTo(centerLat, 3);
      expect(result.waypoints[0][1]).toBeCloseTo(centerLng, 3);
    });

    it('legs increase as spiral expands', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'expanding_square', 100);
      expect(result.legs).toBeGreaterThan(4); // at least a few turns
    });

    it('estimated distance is positive', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'expanding_square', 100);
      expect(result.estimatedDistanceKm).toBeGreaterThan(0);
    });

    it('tighter spacing gives more waypoints', () => {
      const wide = generateSearchPattern(DEFAULT_BOUNDS, 180, 'expanding_square', 500);
      const tight = generateSearchPattern(DEFAULT_BOUNDS, 180, 'expanding_square', 100);
      expect(tight.waypoints.length).toBeGreaterThan(wide.waypoints.length);
    });
  });

  // ============================================================
  // Sector pattern
  // ============================================================

  describe('sector pattern', () => {
    it('generates waypoints for sector/pie-slice search', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'sector', 100);
      expect(result.waypoints.length).toBeGreaterThan(0);
    });

    it('returns to center between sectors', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'sector', 100);
      const centerLat = (DEFAULT_BOUNDS.north + DEFAULT_BOUNDS.south) / 2;
      const centerLng = (DEFAULT_BOUNDS.east + DEFAULT_BOUNDS.west) / 2;
      // Every other waypoint should be near center (out-and-back)
      // First waypoint of each sector pair is center
      for (let i = 0; i < result.waypoints.length - 1; i += 2) {
        expect(result.waypoints[i][0]).toBeCloseTo(centerLat, 3);
        expect(result.waypoints[i][1]).toBeCloseTo(centerLng, 3);
      }
    });

    it('has 8 sectors (legs)', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'sector', 100);
      expect(result.legs).toBe(8);
    });

    it('estimated distance is positive', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'sector', 100);
      expect(result.estimatedDistanceKm).toBeGreaterThan(0);
    });

    it('last waypoint returns to center', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'sector', 100);
      const centerLat = (DEFAULT_BOUNDS.north + DEFAULT_BOUNDS.south) / 2;
      const centerLng = (DEFAULT_BOUNDS.east + DEFAULT_BOUNDS.west) / 2;
      const last = result.waypoints[result.waypoints.length - 1];
      expect(last[0]).toBeCloseTo(centerLat, 3);
      expect(last[1]).toBeCloseTo(centerLng, 3);
    });
  });

  // ============================================================
  // Unknown pattern type
  // ============================================================

  describe('unknown pattern type', () => {
    it('returns empty result for unknown pattern', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'unknown_type', 100);
      expect(result.waypoints).toHaveLength(0);
      expect(result.estimatedDistanceKm).toBe(0);
      expect(result.legs).toBe(0);
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================

  describe('edge cases', () => {
    it('handles zero wind direction', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 0, 'parallel', 200);
      expect(result.waypoints.length).toBeGreaterThan(0);
    });

    it('handles 360 degree wind direction', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 360, 'parallel', 200);
      expect(result.waypoints.length).toBeGreaterThan(0);
    });

    it('handles very small bounds', () => {
      const tiny = { north: 38.601, south: 38.600, east: -120.499, west: -120.500 };
      const result = generateSearchPattern(tiny, 180, 'parallel', 50);
      expect(result.waypoints.length).toBeGreaterThan(0);
    });

    it('handles very large track spacing', () => {
      const result = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100000);
      expect(result.legs).toBeGreaterThanOrEqual(1);
    });

    it('all waypoints contain valid numbers', () => {
      const patterns = ['parallel', 'expanding_square', 'sector'];
      patterns.forEach(pat => {
        const result = generateSearchPattern(DEFAULT_BOUNDS, 180, pat, 200);
        result.waypoints.forEach(wp => {
          expect(Number.isFinite(wp[0])).toBe(true);
          expect(Number.isFinite(wp[1])).toBe(true);
        });
      });
    });

    it('estimated distance is non-negative for all patterns', () => {
      const patterns = ['parallel', 'expanding_square', 'sector'];
      patterns.forEach(pat => {
        const result = generateSearchPattern(DEFAULT_BOUNDS, 180, pat, 200);
        expect(result.estimatedDistanceKm).toBeGreaterThanOrEqual(0);
      });
    });

    it('thermal search (50m spacing) has more legs than visual (100m)', () => {
      const thermal = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 50);
      const visual = generateSearchPattern(DEFAULT_BOUNDS, 180, 'parallel', 100);
      expect(thermal.legs).toBeGreaterThan(visual.legs);
    });
  });
});
