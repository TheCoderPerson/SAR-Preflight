const {
  generateElevationGrid, calcSlopeFromGrid, calcAspect, detectTerrainFeatures,
} = require('../../sar-preflight-core.js');

// ============================================================
// generateElevationGrid
// ============================================================

describe('generateElevationGrid(centerLat, centerLng, boundsNE, boundsSW, gridSize)', () => {
  const boundsNE = { lat: 39.0, lng: -120.0 };
  const boundsSW = { lat: 38.0, lng: -121.0 };
  const center   = { lat: 38.5, lng: -120.5 };

  it('returns gridSize^2 points for a 5x5 grid', () => {
    const pts = generateElevationGrid(center.lat, center.lng, boundsNE, boundsSW, 5);
    expect(pts).toHaveLength(25);
  });

  it('returns 1 point for gridSize=1', () => {
    const pts = generateElevationGrid(center.lat, center.lng, boundsNE, boundsSW, 1);
    expect(pts).toHaveLength(1);
    // Single point should be at center of bounds
    expect(pts[0].latitude).toBeCloseTo(38.5, 1);
    expect(pts[0].longitude).toBeCloseTo(-120.5, 1);
  });

  it('returns 4 points for gridSize=2', () => {
    const pts = generateElevationGrid(center.lat, center.lng, boundsNE, boundsSW, 2);
    expect(pts).toHaveLength(4);
  });

  it('corner points match bounds exactly for gridSize>=2', () => {
    const pts = generateElevationGrid(center.lat, center.lng, boundsNE, boundsSW, 5);
    // First point = SW corner (row 0, col 0)
    expect(pts[0].latitude).toBeCloseTo(boundsSW.lat, 5);
    expect(pts[0].longitude).toBeCloseTo(boundsSW.lng, 5);
    // Last point = NE corner (row 4, col 4)
    expect(pts[24].latitude).toBeCloseTo(boundsNE.lat, 5);
    expect(pts[24].longitude).toBeCloseTo(boundsNE.lng, 5);
  });

  it('points are evenly spaced', () => {
    const pts = generateElevationGrid(center.lat, center.lng, boundsNE, boundsSW, 3);
    // Row spacing: (39.0 - 38.0) / 2 = 0.5 deg
    expect(pts[3].latitude - pts[0].latitude).toBeCloseTo(0.5, 5);
    expect(pts[6].latitude - pts[3].latitude).toBeCloseTo(0.5, 5);
    // Col spacing: (-120.0 - (-121.0)) / 2 = 0.5 deg
    expect(pts[1].longitude - pts[0].longitude).toBeCloseTo(0.5, 5);
  });

  it('all points have latitude and longitude properties', () => {
    const pts = generateElevationGrid(center.lat, center.lng, boundsNE, boundsSW, 3);
    pts.forEach(pt => {
      expect(pt).toHaveProperty('latitude');
      expect(pt).toHaveProperty('longitude');
      expect(typeof pt.latitude).toBe('number');
      expect(typeof pt.longitude).toBe('number');
    });
  });

  it('handles zero-area bounds (SW=NE)', () => {
    const samePt = { lat: 38.5, lng: -120.5 };
    const pts = generateElevationGrid(38.5, -120.5, samePt, samePt, 3);
    expect(pts).toHaveLength(9);
    pts.forEach(pt => {
      expect(pt.latitude).toBeCloseTo(38.5, 5);
      expect(pt.longitude).toBeCloseTo(-120.5, 5);
    });
  });
});

// ============================================================
// calcSlopeFromGrid
// ============================================================

describe('calcSlopeFromGrid(elevationsFt, gridSize, cellSizeKm)', () => {
  describe('flat terrain', () => {
    it('returns zero slope for completely flat terrain', () => {
      const flat = Array(25).fill(3000);
      const result = calcSlopeFromGrid(flat, 5, 1.0);
      expect(result.avgSlopeDeg).toBeCloseTo(0, 5);
      expect(result.maxSlopeDeg).toBeCloseTo(0, 5);
    });

    it('returns slopeGrid with nulls on edges and values in interior', () => {
      const flat = Array(25).fill(3000);
      const result = calcSlopeFromGrid(flat, 5, 1.0);
      // Edge cells should be null
      expect(result.slopeGrid[0]).toBeNull();     // corner
      expect(result.slopeGrid[4]).toBeNull();     // corner
      expect(result.slopeGrid[20]).toBeNull();    // corner
      // Interior cells should be 0
      expect(result.slopeGrid[6]).toBeCloseTo(0, 5);  // row 1, col 1
      expect(result.slopeGrid[12]).toBeCloseTo(0, 5); // center
    });
  });

  describe('uniform slope', () => {
    it('detects slope on a tilted plane (east-facing)', () => {
      // 5x5 grid, elevation increases from left to right: 1000, 1100, 1200, 1300, 1400
      const tilted = [];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          tilted.push(1000 + c * 100);
        }
      }
      const result = calcSlopeFromGrid(tilted, 5, 0.5);
      expect(result.avgSlopeDeg).toBeGreaterThan(0);
      expect(result.maxSlopeDeg).toBeGreaterThan(0);
      // All interior slopes should be the same
      const interiorSlopes = result.slopeGrid.filter(v => v !== null);
      const firstSlope = interiorSlopes[0];
      interiorSlopes.forEach(s => {
        expect(s).toBeCloseTo(firstSlope, 3);
      });
    });

    it('steeper slope produces larger slope degrees', () => {
      // Gentle: 100 ft rise per cell, Steep: 500 ft rise per cell
      const gentle = [], steep = [];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          gentle.push(1000 + c * 100);
          steep.push(1000 + c * 500);
        }
      }
      const gResult = calcSlopeFromGrid(gentle, 5, 1.0);
      const sResult = calcSlopeFromGrid(steep, 5, 1.0);
      expect(sResult.avgSlopeDeg).toBeGreaterThan(gResult.avgSlopeDeg);
      expect(sResult.maxSlopeDeg).toBeGreaterThan(gResult.maxSlopeDeg);
    });
  });

  describe('mountainous terrain', () => {
    it('returns positive max slope for V-shaped canyon', () => {
      // Canyon: high edges, low center
      const canyon = [
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 4000, 3000, 4000, 5000,
      ];
      const result = calcSlopeFromGrid(canyon, 5, 0.5);
      expect(result.maxSlopeDeg).toBeGreaterThan(5);
    });
  });

  describe('edge cases', () => {
    it('handles gridSize=3 (only 1 interior cell)', () => {
      const grid = [100, 200, 300, 100, 200, 300, 100, 200, 300];
      const result = calcSlopeFromGrid(grid, 3, 1.0);
      const interiorSlopes = result.slopeGrid.filter(v => v !== null);
      expect(interiorSlopes).toHaveLength(1); // only center cell
    });

    it('handles gridSize=2 (no interior cells)', () => {
      const grid = [100, 200, 300, 400];
      const result = calcSlopeFromGrid(grid, 2, 1.0);
      expect(result.avgSlopeDeg).toBe(0);
      expect(result.maxSlopeDeg).toBe(0);
    });

    it('handles gridSize=1 (single point)', () => {
      const result = calcSlopeFromGrid([5000], 1, 1.0);
      expect(result.avgSlopeDeg).toBe(0);
      expect(result.maxSlopeDeg).toBe(0);
    });
  });
});

// ============================================================
// calcAspect
// ============================================================

describe('calcAspect(elevationsFt, gridSize)', () => {
  describe('cardinal direction slopes', () => {
    it('returns S for north-facing slope (higher to the south)', () => {
      // Higher south (bottom), lower north (top) → slope faces north → downhill toward N
      // But our convention: higher south edge → gradient points north → aspect = N
      // Actually: the function computes dx, dy as differences of edges.
      // Higher south = southAvg > northAvg → dy = northAvg - southAvg < 0
      // Slope faces toward lower side = North = 'N'
      const grid = [
        1000, 1000, 1000,
        2000, 2000, 2000,
        3000, 3000, 3000,
      ];
      const result = calcAspect(grid, 3);
      expect(result).toBe('N');
    });

    it('returns S for south-facing slope (higher to the north)', () => {
      const grid = [
        3000, 3000, 3000,
        2000, 2000, 2000,
        1000, 1000, 1000,
      ];
      const result = calcAspect(grid, 3);
      expect(result).toBe('S');
    });

    it('returns E for east-facing slope (higher to the west)', () => {
      const grid = [
        3000, 2000, 1000,
        3000, 2000, 1000,
        3000, 2000, 1000,
      ];
      const result = calcAspect(grid, 3);
      expect(result).toBe('E');
    });

    it('returns W for west-facing slope (higher to the east)', () => {
      const grid = [
        1000, 2000, 3000,
        1000, 2000, 3000,
        1000, 2000, 3000,
      ];
      const result = calcAspect(grid, 3);
      expect(result).toBe('W');
    });
  });

  describe('flat terrain', () => {
    it('returns flat for uniform elevation', () => {
      const grid = Array(9).fill(5000);
      expect(calcAspect(grid, 3)).toBe('flat');
    });

    it('returns flat for near-zero gradient (within threshold)', () => {
      const grid = [
        5000, 5001, 5000,
        5000, 5001, 5000,
        5000, 5001, 5000,
      ];
      expect(calcAspect(grid, 3)).toBe('flat');
    });
  });

  describe('edge cases', () => {
    it('returns flat for gridSize < 2', () => {
      expect(calcAspect([5000], 1)).toBe('flat');
    });

    it('handles gridSize=2', () => {
      // Higher SW, lower NE
      const grid = [1000, 1000, 3000, 1000];
      const result = calcAspect(grid, 2);
      expect(typeof result).toBe('string');
    });
  });
});

// ============================================================
// detectTerrainFeatures
// ============================================================

describe('detectTerrainFeatures(elevationsFt, gridSize, rangeFt)', () => {
  describe('flat terrain', () => {
    it('detects no features in flat terrain', () => {
      const flat = Array(25).fill(3000);
      const result = detectTerrainFeatures(flat, 5, 0);
      expect(result.hasCanyons).toBe(false);
      expect(result.hasRidges).toBe(false);
      expect(result.hasFunneling).toBe(false);
      expect(result.features).toHaveLength(0);
    });
  });

  describe('canyon detection', () => {
    it('detects canyon when center is lower than edges', () => {
      const canyon = [
        5000, 5000, 5000, 5000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 3000, 2000, 3000, 5000,
        5000, 4000, 3000, 4000, 5000,
        5000, 5000, 5000, 5000, 5000,
      ];
      const rangeFt = 5000 - 2000;
      const result = detectTerrainFeatures(canyon, 5, rangeFt);
      expect(result.hasCanyons).toBe(true);
      expect(result.features.some(f => f.toLowerCase().includes('canyon'))).toBe(true);
    });
  });

  describe('ridge detection', () => {
    it('detects ridge when center is higher than edges', () => {
      const ridge = [
        2000, 2000, 2000, 2000, 2000,
        2000, 3000, 4000, 3000, 2000,
        2000, 4000, 5000, 4000, 2000,
        2000, 3000, 4000, 3000, 2000,
        2000, 2000, 2000, 2000, 2000,
      ];
      const rangeFt = 5000 - 2000;
      const result = detectTerrainFeatures(ridge, 5, rangeFt);
      expect(result.hasRidges).toBe(true);
      expect(result.features.some(f => f.toLowerCase().includes('ridge'))).toBe(true);
    });
  });

  describe('funneling detection', () => {
    it('detects funneling with N-S high, E-W low pattern and sufficient range', () => {
      // Top/bottom rows high, left/right columns low, center moderate
      // This makes nsHigh true (topRow > centerRow, bottomRow > centerRow)
      // and ewLow true (leftCol < centerCol)
      const funnel = [
        5000, 5000, 5000, 5000, 5000,
        2000, 3000, 4000, 3000, 2000,
        2000, 3000, 4000, 3000, 2000,
        2000, 3000, 4000, 3000, 2000,
        5000, 5000, 5000, 5000, 5000,
      ];
      // topRowAvg = 5000, bottomRowAvg = 5000, centerRowAvg = (2000+3000+4000+3000+2000)/5 = 2800
      // leftColAvg = (5000+2000+2000+2000+5000)/5 = 3200
      // centerColAvg = (5000+4000+4000+4000+5000)/5 = 4400
      // nsHigh = true (5000 > 2800), ewLow = true (3200 < 4400)
      const rangeFt = 5000 - 2000;
      const result = detectTerrainFeatures(funnel, 5, rangeFt);
      expect(result.hasFunneling).toBe(true);
    });

    it('does not detect funneling when range is too small', () => {
      const mild = [
        3050, 3050, 3050, 3050, 3050,
        3000, 3000, 3000, 3000, 3000,
        3000, 3000, 3000, 3000, 3000,
        3000, 3000, 3000, 3000, 3000,
        3050, 3050, 3050, 3050, 3050,
      ];
      const rangeFt = 50;
      const result = detectTerrainFeatures(mild, 5, rangeFt);
      expect(result.hasFunneling).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns no features for gridSize < 3', () => {
      const result = detectTerrainFeatures([1000, 2000, 3000, 4000], 2, 3000);
      expect(result.hasCanyons).toBe(false);
      expect(result.hasRidges).toBe(false);
      expect(result.hasFunneling).toBe(false);
    });

    it('returns structure with correct shape', () => {
      const result = detectTerrainFeatures(Array(25).fill(3000), 5, 0);
      expect(result).toHaveProperty('hasCanyons');
      expect(result).toHaveProperty('hasRidges');
      expect(result).toHaveProperty('hasFunneling');
      expect(result).toHaveProperty('features');
      expect(Array.isArray(result.features)).toBe(true);
    });
  });
});
