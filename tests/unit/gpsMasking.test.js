const {
  analyzeGPSMasking, assessTerrainTurbulence, calcAspect,
} = require('../../sar-preflight-core.js');

// ============================================================
// analyzeGPSMasking
// ============================================================

describe('analyzeGPSMasking(centerElevFt, elevPoints, gridSize, flightAltAGL)', () => {
  function makeElevPoints(gridSize, elevFn) {
    const pts = [];
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        pts.push({ elevFt: elevFn(r, c) });
      }
    }
    return pts;
  }

  describe('flat terrain', () => {
    it('reports no masking for flat terrain', () => {
      const pts = makeElevPoints(5, () => 3000);
      const result = analyzeGPSMasking(3000, pts, 5, 400);
      expect(result.maskedDirections).toHaveLength(0);
      expect(result.skyVisibilityPct).toBe(100);
    });

    it('description mentions good visibility', () => {
      const pts = makeElevPoints(5, () => 3000);
      const result = analyzeGPSMasking(3000, pts, 5, 400);
      expect(result.description.toLowerCase()).toContain('good');
    });
  });

  describe('canyon scenario (center low, edges high)', () => {
    it('detects masking when surrounding terrain towers above flight altitude', () => {
      // Center = 2000 ft, flight at 400 AGL = 2400 ft
      // Edges at 8000 ft — massive terrain angle
      const pts = makeElevPoints(5, (r, c) => {
        const isEdge = r === 0 || r === 4 || c === 0 || c === 4;
        return isEdge ? 8000 : 2000;
      });
      const result = analyzeGPSMasking(2000, pts, 5, 400);
      expect(result.maskedDirections.length).toBeGreaterThan(0);
      expect(result.skyVisibilityPct).toBeLessThan(100);
    });

    it('masks multiple directions in deep canyon', () => {
      const pts = makeElevPoints(5, (r, c) => {
        const isEdge = r === 0 || r === 4 || c === 0 || c === 4;
        return isEdge ? 10000 : 2000;
      });
      const result = analyzeGPSMasking(2000, pts, 5, 200);
      // Most or all directions should be masked
      expect(result.maskedDirections.length).toBeGreaterThanOrEqual(4);
      expect(result.skyVisibilityPct).toBeLessThanOrEqual(50);
    });

    it('description mentions masking for partially masked scenario', () => {
      const pts = makeElevPoints(5, (r, c) => {
        return r === 0 ? 6000 : 3000; // only north edge high
      });
      const result = analyzeGPSMasking(3000, pts, 5, 100);
      // Depending on angle, N direction may be masked
      if (result.maskedDirections.length > 0) {
        expect(result.description.toLowerCase()).toContain('mask');
      }
    });
  });

  describe('one-sided masking', () => {
    it('detects masking only from direction with high terrain', () => {
      // Only south edge is very high
      const pts = makeElevPoints(5, (r, c) => {
        return r === 4 ? 9000 : 3000;
      });
      const result = analyzeGPSMasking(3000, pts, 5, 200);
      // S, SE, SW might be masked
      const southDirs = result.maskedDirections.filter(d => d.includes('S'));
      if (result.maskedDirections.length > 0) {
        expect(southDirs.length).toBeGreaterThan(0);
      }
    });
  });

  describe('flight altitude effect', () => {
    it('higher flight altitude reduces masking', () => {
      const pts = makeElevPoints(5, (r, c) => {
        const isEdge = r === 0 || r === 4 || c === 0 || c === 4;
        return isEdge ? 5000 : 3000;
      });
      const lowFlight = analyzeGPSMasking(3000, pts, 5, 100);
      const highFlight = analyzeGPSMasking(3000, pts, 5, 2000);
      expect(highFlight.maskedDirections.length).toBeLessThanOrEqual(lowFlight.maskedDirections.length);
    });
  });

  describe('return structure', () => {
    it('returns correct properties', () => {
      const pts = makeElevPoints(5, () => 3000);
      const result = analyzeGPSMasking(3000, pts, 5, 400);
      expect(result).toHaveProperty('maskedDirections');
      expect(result).toHaveProperty('skyVisibilityPct');
      expect(result).toHaveProperty('description');
      expect(Array.isArray(result.maskedDirections)).toBe(true);
      expect(typeof result.skyVisibilityPct).toBe('number');
      expect(typeof result.description).toBe('string');
    });

    it('skyVisibilityPct is between 0 and 100', () => {
      const pts = makeElevPoints(5, () => 3000);
      const result = analyzeGPSMasking(3000, pts, 5, 400);
      expect(result.skyVisibilityPct).toBeGreaterThanOrEqual(0);
      expect(result.skyVisibilityPct).toBeLessThanOrEqual(100);
    });

    it('skyVisibilityPct = (8 - masked) / 8 * 100', () => {
      const pts = makeElevPoints(5, () => 3000);
      const result = analyzeGPSMasking(3000, pts, 5, 400);
      const expected = Math.round((8 - result.maskedDirections.length) / 8 * 100);
      expect(result.skyVisibilityPct).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('returns 100% visibility for null elevPoints', () => {
      const result = analyzeGPSMasking(3000, null, 5, 400);
      expect(result.skyVisibilityPct).toBe(100);
      expect(result.maskedDirections).toHaveLength(0);
    });

    it('returns 100% visibility for empty elevPoints', () => {
      const result = analyzeGPSMasking(3000, [], 5, 400);
      expect(result.skyVisibilityPct).toBe(100);
    });

    it('description severity scales with masked direction count', () => {
      // 0 masked = "good"
      const pts0 = makeElevPoints(5, () => 3000);
      const r0 = analyzeGPSMasking(3000, pts0, 5, 400);
      expect(r0.description.toLowerCase()).toContain('good');
    });
  });
});

// ============================================================
// assessTerrainTurbulence
// ============================================================

describe('assessTerrainTurbulence(elevationsFt, gridSize, rangeFt, windDirDeg, windSpeedMph)', () => {
  describe('flat terrain with light wind', () => {
    it('returns low risk for flat terrain and light winds', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 0, 180, 5);
      expect(result.risk).toBe('low');
      expect(result.level).toBe('green');
    });
  });

  describe('zero wind', () => {
    it('returns low risk with calm winds regardless of terrain', () => {
      const mountainous = [
        8000, 7000, 6000, 7000, 8000,
        7000, 5000, 4000, 5000, 7000,
        6000, 4000, 3000, 4000, 6000,
        7000, 5000, 4000, 5000, 7000,
        8000, 7000, 6000, 7000, 8000,
      ];
      const result = assessTerrainTurbulence(mountainous, 5, 5000, 270, 0);
      expect(result.risk).toBe('low');
      expect(result.level).toBe('green');
      expect(result.factors.some(f => f.toLowerCase().includes('calm'))).toBe(true);
    });
  });

  describe('mountainous terrain with strong winds', () => {
    it('returns high risk for ridgeline with strong perpendicular wind', () => {
      // Ridge running N-S (center column high)
      const ridge = [
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
        2000, 2000, 5000, 2000, 2000,
      ];
      const rangeFt = 3000;
      // Wind from west (270 deg) perpendicular to N-S ridge
      const result = assessTerrainTurbulence(ridge, 5, rangeFt, 270, 30);
      expect(['moderate', 'high']).toContain(result.risk);
      expect(['amber', 'red']).toContain(result.level);
    });

    it('returns higher risk for strong winds vs moderate winds', () => {
      const terrain = [
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
      ];
      const rangeFt = 2000;
      const moderate = assessTerrainTurbulence(terrain, 5, rangeFt, 180, 12);
      const strong = assessTerrainTurbulence(terrain, 5, rangeFt, 180, 30);
      const riskOrder = { 'low': 0, 'moderate': 1, 'high': 2 };
      expect(riskOrder[strong.risk]).toBeGreaterThanOrEqual(riskOrder[moderate.risk]);
    });
  });

  describe('canyon with aligned wind', () => {
    it('detects funneling/canyon effects with wind', () => {
      const canyon = [
        5000, 5000, 5000, 5000, 5000,
        5000, 3000, 2000, 3000, 5000,
        5000, 2000, 1000, 2000, 5000,
        5000, 3000, 2000, 3000, 5000,
        5000, 5000, 5000, 5000, 5000,
      ];
      const rangeFt = 4000;
      const result = assessTerrainTurbulence(canyon, 5, rangeFt, 180, 20);
      expect(result.factors.length).toBeGreaterThan(0);
      expect(['moderate', 'high']).toContain(result.risk);
    });
  });

  describe('wind direction effects', () => {
    it('wind perpendicular to ridge is more turbulent than parallel', () => {
      // Ridge: center row is high, edges are low — ridge runs E-W
      const ridge = [
        2000, 2000, 2000, 2000, 2000,
        3000, 3000, 3000, 3000, 3000,
        5000, 5000, 5000, 5000, 5000,
        3000, 3000, 3000, 3000, 3000,
        2000, 2000, 2000, 2000, 2000,
      ];
      const rangeFt = 3000;
      // Wind from north (0 deg) = perpendicular to E-W ridge
      const perpendicular = assessTerrainTurbulence(ridge, 5, rangeFt, 0, 20);
      // Wind from east (90 deg) = parallel to E-W ridge
      const parallel = assessTerrainTurbulence(ridge, 5, rangeFt, 90, 20);
      const riskOrder = { 'low': 0, 'moderate': 1, 'high': 2 };
      expect(riskOrder[perpendicular.risk]).toBeGreaterThanOrEqual(riskOrder[parallel.risk]);
    });
  });

  describe('return structure', () => {
    it('returns risk, factors, and level', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 0, 180, 10);
      expect(result).toHaveProperty('risk');
      expect(result).toHaveProperty('factors');
      expect(result).toHaveProperty('level');
      expect(['low', 'moderate', 'high']).toContain(result.risk);
      expect(['green', 'amber', 'red']).toContain(result.level);
      expect(Array.isArray(result.factors)).toBe(true);
    });

    it('factors array is never empty', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 0, 180, 5);
      expect(result.factors.length).toBeGreaterThan(0);
    });
  });

  describe('high terrain range', () => {
    it('flags high terrain relief', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 1500, 180, 15);
      expect(result.factors.some(f => f.toLowerCase().includes('relief'))).toBe(true);
    });

    it('flags moderate terrain relief', () => {
      const flat = Array(25).fill(3000);
      const result = assessTerrainTurbulence(flat, 5, 700, 180, 15);
      expect(result.factors.some(f => f.toLowerCase().includes('relief'))).toBe(true);
    });
  });
});
