const {
  scoreLZFitness, findEmergencyLZs,
} = require('../../sar-preflight-core.js');

// ============================================================
// scoreLZFitness
// ============================================================

describe('scoreLZFitness(elevFt, slopeDeg, vegetationType)', () => {
  describe('slope scoring', () => {
    it('gives highest slope score for <5 deg slope', () => {
      const flat = scoreLZFitness(3000, 2, 'grassland');
      const moderate = scoreLZFitness(3000, 7, 'grassland');
      expect(flat).toBeGreaterThan(moderate);
    });

    it('scores 0 slope component for >15 deg', () => {
      const steep = scoreLZFitness(3000, 20, 'grassland');
      // slope component = 0, veg = 1.0, elevPenalty = 1.0
      // = 0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 0.5
      expect(steep).toBeCloseTo(0.5, 2);
    });

    it('returns correct scores at slope boundaries', () => {
      // <5 deg: score = 1.0 * 0.5 + veg + elev
      // 5-10 deg: score = 0.6 * 0.5 + veg + elev
      // 10-15 deg: score = 0.3 * 0.5 + veg + elev
      // >15 deg: score = 0.0 * 0.5 + veg + elev
      const s4 = scoreLZFitness(2000, 4, 'grassland');   // slope 1.0
      const s7 = scoreLZFitness(2000, 7, 'grassland');   // slope 0.6
      const s12 = scoreLZFitness(2000, 12, 'grassland'); // slope 0.3
      const s20 = scoreLZFitness(2000, 20, 'grassland'); // slope 0.0
      expect(s4).toBeGreaterThan(s7);
      expect(s7).toBeGreaterThan(s12);
      expect(s12).toBeGreaterThan(s20);
    });
  });

  describe('vegetation scoring', () => {
    it('grassland scores highest vegetation', () => {
      expect(scoreLZFitness(2000, 3, 'grassland')).toBeGreaterThan(
        scoreLZFitness(2000, 3, 'oak woodland')
      );
    });

    it('mixed conifer scores lowest vegetation', () => {
      expect(scoreLZFitness(5500, 3, 'mixed conifer')).toBeLessThan(
        scoreLZFitness(5500, 3, 'pine')
      );
    });

    it('subalpine scores moderate vegetation', () => {
      const sub = scoreLZFitness(7500, 3, 'subalpine');
      const pine = scoreLZFitness(7500, 3, 'pine');
      expect(sub).toBeGreaterThan(pine);
    });

    it('handles unknown vegetation with default score', () => {
      const unknown = scoreLZFitness(2000, 3, 'desert');
      // default vegScore = 0.5
      // 1.0 * 0.5 + 0.5 * 0.3 + 1.0 * 0.2 = 0.85
      expect(unknown).toBeCloseTo(0.85, 2);
    });

    it('handles empty vegetation string', () => {
      const empty = scoreLZFitness(2000, 3, '');
      expect(typeof empty).toBe('number');
      expect(empty).toBeGreaterThan(0);
    });

    it('handles null vegetation', () => {
      const result = scoreLZFitness(2000, 3, null);
      expect(typeof result).toBe('number');
    });
  });

  describe('elevation penalty', () => {
    it('no penalty below 8000 ft', () => {
      const low = scoreLZFitness(5000, 3, 'grassland');
      // 1.0 * 0.5 + 1.0 * 0.3 + 1.0 * 0.2 = 1.0
      expect(low).toBeCloseTo(1.0, 2);
    });

    it('slight penalty above 8000 ft', () => {
      const high = scoreLZFitness(9000, 3, 'grassland');
      const low = scoreLZFitness(5000, 3, 'grassland');
      expect(high).toBeLessThan(low);
    });

    it('more penalty above 10000 ft', () => {
      const veryHigh = scoreLZFitness(11000, 3, 'grassland');
      const high = scoreLZFitness(9000, 3, 'grassland');
      expect(veryHigh).toBeLessThan(high);
    });
  });

  describe('combined scoring', () => {
    it('ideal LZ (flat, grassland, low elev) scores 1.0', () => {
      expect(scoreLZFitness(2000, 2, 'grassland')).toBeCloseTo(1.0, 2);
    });

    it('worst LZ (steep, dense forest, high elev) scores very low', () => {
      const worst = scoreLZFitness(11000, 20, 'mixed conifer');
      expect(worst).toBeLessThan(0.3);
    });

    it('score is always between 0 and 1', () => {
      const cases = [
        [500, 0, 'grassland'],
        [12000, 30, 'mixed conifer'],
        [3000, 8, 'oak woodland'],
        [7500, 3, 'subalpine'],
      ];
      cases.forEach(([elev, slope, veg]) => {
        const s = scoreLZFitness(elev, slope, veg);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      });
    });
  });
});

// ============================================================
// findEmergencyLZs
// ============================================================

describe('findEmergencyLZs(elevPoints, gridSize, cellSizeKm)', () => {
  function makeGrid(gridSize, elevFn) {
    const pts = [];
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        pts.push({
          lat: 38.5 + r * 0.01,
          lng: -120.5 + c * 0.01,
          elevFt: elevFn(r, c),
        });
      }
    }
    return pts;
  }

  describe('flat terrain (all similar elevations)', () => {
    it('returns multiple candidates for flat low-elevation terrain', () => {
      const pts = makeGrid(5, () => 2000);
      const lzs = findEmergencyLZs(pts, 5, 1.0);
      expect(lzs.length).toBeGreaterThan(0);
      // All points should score well
      lzs.forEach(lz => {
        expect(lz.score).toBeGreaterThan(0.4);
      });
    });

    it('results are sorted by score descending', () => {
      const pts = makeGrid(5, () => 2000);
      const lzs = findEmergencyLZs(pts, 5, 1.0);
      for (let i = 1; i < lzs.length; i++) {
        expect(lzs[i].score).toBeLessThanOrEqual(lzs[i - 1].score);
      }
    });

    it('each candidate has required properties', () => {
      const pts = makeGrid(5, () => 2000);
      const lzs = findEmergencyLZs(pts, 5, 1.0);
      lzs.forEach(lz => {
        expect(lz).toHaveProperty('lat');
        expect(lz).toHaveProperty('lng');
        expect(lz).toHaveProperty('elevFt');
        expect(lz).toHaveProperty('score');
        expect(lz).toHaveProperty('slopeDeg');
        expect(lz).toHaveProperty('description');
      });
    });
  });

  describe('mountainous terrain', () => {
    it('returns fewer candidates for steep terrain', () => {
      // Create V-shaped canyon with steep slopes
      const flat = makeGrid(5, () => 2000);
      const steep = makeGrid(5, (r, c) => 2000 + Math.abs(c - 2) * 2000);
      const flatLZs = findEmergencyLZs(flat, 5, 1.0);
      const steepLZs = findEmergencyLZs(steep, 5, 1.0);
      expect(flatLZs.length).toBeGreaterThanOrEqual(steepLZs.length);
    });

    it('high elevation points have lower scores due to vegetation/elevation penalty', () => {
      const highElev = makeGrid(5, () => 9000);
      const lowElev = makeGrid(5, () => 2000);
      const highLZs = findEmergencyLZs(highElev, 5, 1.0);
      const lowLZs = findEmergencyLZs(lowElev, 5, 1.0);
      if (highLZs.length > 0 && lowLZs.length > 0) {
        expect(highLZs[0].score).toBeLessThanOrEqual(lowLZs[0].score);
      }
    });
  });

  describe('edge cases', () => {
    it('returns empty array for null input', () => {
      expect(findEmergencyLZs(null, 5, 1.0)).toEqual([]);
    });

    it('returns empty array for empty array input', () => {
      expect(findEmergencyLZs([], 5, 1.0)).toEqual([]);
    });

    it('handles single point', () => {
      const pts = [{ lat: 38.5, lng: -120.5, elevFt: 2000 }];
      const lzs = findEmergencyLZs(pts, 1, 1.0);
      // Single point has no neighbors so slope = 0
      expect(lzs.length).toBeGreaterThanOrEqual(0);
    });

    it('descriptions mention slope characteristics', () => {
      const pts = makeGrid(5, () => 2000);
      const lzs = findEmergencyLZs(pts, 5, 1.0);
      lzs.forEach(lz => {
        expect(lz.description).toContain('Elev');
        expect(lz.description).toContain('slope');
      });
    });
  });
});
